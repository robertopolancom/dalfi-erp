/*
 * Funciones puras compartidas por app.js (navegador) y por las pruebas en tests/.
 * No dependen del DOM ni de variables globales de la aplicacion para que sean
 * faciles de probar con node:test y reutilizar desde functions/api/ si hace falta.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.DalfiClosingMath = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function localDateStringInZone(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  }

  function nowPartsInZone(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return { hour: Number(value.hour), minute: Number(value.minute) };
  }

  // Un dia queda elegible para cierre automatico cuando ya termino segun el
  // calendario de America/Santo_Domingo: cualquier dia anterior a "today", o el
  // propio "today" solo en su ultimo minuto (23:59) en esa zona horaria.
  function isAutomaticClosingEligible({ date, today, hour, minute }) {
    if (!date || !today || date > today) return false;
    if (date < today) return true;
    return hour === 23 && minute >= 59;
  }

  // monto esperado = monto inicial (fondo de caja) + entradas efectivas de
  // efectivo - salidas efectivas de efectivo. Nunca se cuentan aqui montos de
  // tarjeta o transferencia: esos flujos deben excluirse antes de llamar esto.
  function computeExpectedCash({ montoInicial = 0, entradasEfectivo = 0, salidasEfectivo = 0 } = {}) {
    return (Number(montoInicial) || 0) + (Number(entradasEfectivo) || 0) - (Number(salidasEfectivo) || 0);
  }

  // Normaliza un monto a un numero valido: acepta 0 como valor legitimo,
  // nunca deja pasar NaN ni +-Infinity (se convierten a 0 en vez de
  // propagarse a un saldo inicial sin sentido). Compartido por
  // resolveRegisterOpeningCash() y resolveTreasuryOpeningBalance() para no
  // duplicar esta regla.
  function sanitizeAmount(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }

  // Fuente confiable del "monto inicial" (fondo de caja) de un cierre de caja
  // registradora. NUNCA debe venir de un input editable por el usuario:
  //   A. Si existe un cierre anterior CONFIRMADO de la misma caja, el monto
  //      inicial es el saldo final confirmado (balanceContado) de ese cierre.
  //      Un cierre pendiente/provisional/reabierto NO cuenta como anterior
  //      (el llamador ya debe excluirlos antes de pasar previousClosing).
  //   B. Si no existe ningun cierre anterior confirmado, se usa el balance de
  //      apertura configurado en la cuenta (cuentas.balanceInicial).
  //   C. Si tampoco hay balance de apertura configurado, el resultado es 0 —
  //      es la misma regla seria hoy (no se inventa un saldo), simplemente
  //      documentada aqui explicitamente.
  function resolveRegisterOpeningCash({ previousClosing, accountOpeningBalance = 0 } = {}) {
    if (previousClosing) return sanitizeAmount(previousClosing.balanceContado);
    return sanitizeAmount(accountOpeningBalance);
  }

  // Mismo patron que resolveRegisterOpeningCash(), para el saldo inicial de
  // una cuenta dentro de un cierre de TESORERIA (banco, caja fuerte, caja
  // chica, etc. — nunca la caja registradora, esa usa
  // resolveRegisterOpeningCash()):
  //   A. Si existe un cierre de tesoreria anterior CONFIRMADO que incluya
  //      esta cuenta, el saldo inicial es su saldo final confirmado
  //      (saldoReal). El llamador es responsable de que
  //      previousConfirmedClosing ya este filtrado por la MISMA cuenta y
  //      excluya cierres pendientes/needsReview (nunca se decide aqui cual
  //      es "el anterior": esta funcion solo resuelve el valor una vez que
  //      el llamador ya lo encontro).
  //   B. Si no existe cierre anterior confirmado para esa cuenta, se usa el
  //      balance de apertura configurado de la cuenta (cuentas.balanceInicial).
  //   C. Si tampoco hay un balance de apertura valido, el resultado es 0.
  function resolveTreasuryOpeningBalance({ previousConfirmedClosing, accountOpeningBalance = 0 } = {}) {
    if (previousConfirmedClosing) return sanitizeAmount(previousConfirmedClosing.saldoReal);
    return sanitizeAmount(accountOpeningBalance);
  }

  function computeDifference(counted, expected) {
    const countedNum = Number(counted) || 0;
    const expectedNum = Number(expected) || 0;
    const difference = countedNum - expectedNum;
    return {
      difference,
      shortage: Math.max(0, -difference),
      surplus: Math.max(0, difference),
    };
  }

  function canConfirmClosing({ shortage } = {}) {
    return (Number(shortage) || 0) <= 0;
  }

  function closingIdentityKey(accountId, accountName) {
    return accountId ? `id:${accountId}` : `name:${String(accountName || "").trim().toLowerCase()}`;
  }

  function buildClosingDedupeKey(date, accountId, accountName) {
    return `${date}::${closingIdentityKey(accountId, accountName)}`;
  }

  // La generacion automatica de cierres debe ser idempotente: llamarla varias
  // veces sobre el mismo set de cierres existentes no debe crear duplicados
  // para el mismo dia + cuenta.
  function hasClosingForDate(existingClosings, date, accountId, accountName) {
    const key = buildClosingDedupeKey(date, accountId, accountName);
    return (existingClosings || []).some((closing) => buildClosingDedupeKey(closing.date, closing.accountId, closing.accountName) === key);
  }

  function isClosingPendingConfirmation(closing) {
    const status = String(closing?.estado || "").toLowerCase();
    return Boolean(closing?.requiereConfirmacion) || status.includes("abierto") || status.includes("provisional") || status.includes("pendiente");
  }

  // Una factura solo puede editarse si el cierre de su dia no existe todavia
  // o sigue sin confirmar. Un cierre confirmado ("Cerrado") congela ese dia.
  function isClosingOpenForEdits(closing) {
    if (!closing) return true;
    return isClosingPendingConfirmation(closing);
  }

  // detailRows: [{ collaboratorId, collaboratorName, invoiceId, billing, commissionable, extra, discount }]
  // tipRows: [{ collaboratorId, collaboratorName, amount }]
  function summarizeCollaborators(detailRows, tipRows) {
    const grouped = new Map();
    const ensureRow = (id, name) => {
      const key = id || name || "sin-colaboradora";
      if (!grouped.has(key)) {
        grouped.set(key, {
          id: key,
          name: name || "Sin colaboradora",
          services: 0,
          billing: 0,
          commissionable: 0,
          extras: 0,
          discounts: 0,
          tips: 0,
          invoiceIds: [],
        });
      }
      return grouped.get(key);
    };
    (detailRows || []).forEach((row) => {
      const entry = ensureRow(row.collaboratorId, row.collaboratorName);
      entry.services += 1;
      entry.billing += Number(row.billing) || 0;
      entry.commissionable += Number(row.commissionable) || 0;
      entry.extras += Number(row.extra) || 0;
      entry.discounts += Number(row.discount) || 0;
      if (row.invoiceId && !entry.invoiceIds.includes(row.invoiceId)) entry.invoiceIds.push(row.invoiceId);
    });
    (tipRows || []).forEach((row) => {
      const entry = ensureRow(row.collaboratorId, row.collaboratorName);
      entry.tips += Number(row.amount) || 0;
    });
    const rows = Array.from(grouped.values()).map((row) => ({
      ...row,
      total: row.billing - row.discounts + row.extras + row.tips,
    }));
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return rows;
  }

  function sumCollaboratorTotals(rows) {
    return (rows || []).reduce((sum, row) => sum + (Number(row.total) || 0), 0);
  }

  function isValidIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  }

  function canConfirmTransfer(cxc) {
    if (!cxc) return false;
    const balance = Number(cxc.balancePendiente) || 0;
    const status = String(cxc.estado || "").trim().toLowerCase();
    return balance > 0 && status !== "saldada";
  }

  // A partir de aqui: modelo de "exactamente dos cierres por dia" (register =
  // caja registradora, treasury = consolidado de valores y tesoreria).

  const CLOSING_TYPES = ["register", "treasury"];

  function closingTypeDedupeKey(businessDate, closingType) {
    return `${businessDate}::${closingType}`;
  }

  // Dado el listado de cierres YA filtrados a una fecha, dice cuales de los
  // dos tipos (register/treasury) todavia faltan por crear ese dia. Llamarla
  // varias veces sobre el mismo listado nunca pide crear un tipo que ya
  // existe: es la base de la generacion idempotente.
  function missingClosingTypesForDate(existingClosingsForDate) {
    const present = new Set((existingClosingsForDate || []).map((c) => c.closingType).filter(Boolean));
    return CLOSING_TYPES.filter((type) => !present.has(type));
  }

  // Determina el tipo de un cierre antiguo (anterior a este modelo) que no
  // tiene closingType, sin borrar ni fusionar nada. Si al inferir el tipo
  // resulta que esa fecha ya tiene otro cierre de ese mismo tipo, se marca
  // needsReview en vez de perder el registro o sobreescribir el existente.
  function normalizeLegacyClosingType(closing, { isRegisterAccountName, occupiedTypesForDate } = {}) {
    if (closing.closingType) return { closingType: closing.closingType, needsReview: Boolean(closing.needsReview) };
    const inferred = isRegisterAccountName && isRegisterAccountName(closing.cuentaCaja) ? "register" : "treasury";
    const occupied = typeof occupiedTypesForDate === "function" ? occupiedTypesForDate(inferred) : false;
    return { closingType: inferred, needsReview: Boolean(occupied) };
  }

  function addDaysToIsoDate(dateStr, days) {
    const date = new Date(`${dateStr}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  // Rango de cierres consolidados de tesoreria pendientes de confirmar entre
  // el dia siguiente al ultimo confirmado (si existe) y la fecha objetivo.
  // closings: [{ businessDate, pending }]. Nunca incluye fechas ya
  // confirmadas: por eso la confirmacion en rango es idempotente (correrla
  // dos veces la segunda vez encuentra un rango vacio).
  function pendingTreasuryRange(closings, targetDate) {
    const sorted = (closings || []).slice().sort((a, b) => String(a.businessDate).localeCompare(String(b.businessDate)));
    const lastConfirmed = sorted
      .filter((c) => !c.pending && c.businessDate <= targetDate)
      .sort((a, b) => String(b.businessDate).localeCompare(String(a.businessDate)))[0];
    const startDate = lastConfirmed ? addDaysToIsoDate(lastConfirmed.businessDate, 1) : null;
    return sorted
      .filter((c) => c.pending && c.businessDate <= targetDate && (!startDate || c.businessDate >= startDate))
      .map((c) => c.businessDate);
  }

  // Antes de confirmar un rango de cierres consolidados, cada fecha del
  // rango debe tener su cierre de caja registradora ya confirmado.
  // registerStatusByDate(date) debe devolver "confirmed" | "pending" | "missing".
  function missingRegisterDatesForRange(dates, registerStatusByDate) {
    return (dates || []).filter((date) => registerStatusByDate(date) !== "confirmed");
  }

  // Suma el detalle de las cuentas de un cierre consolidado de tesoreria en
  // sus totales generales, sin duplicar nada (cada cuenta aporta una sola vez).
  function buildTreasuryTotals(cuentas) {
    return (cuentas || []).reduce(
      (totals, row) => ({
        saldoInicial: totals.saldoInicial + (Number(row.saldoInicial) || 0),
        ingresos: totals.ingresos + (Number(row.ingresos) || 0),
        egresos: totals.egresos + (Number(row.egresos) || 0),
        transferenciasRecibidas: totals.transferenciasRecibidas + (Number(row.transferenciasRecibidas) || 0),
        transferenciasEnviadas: totals.transferenciasEnviadas + (Number(row.transferenciasEnviadas) || 0),
        saldoEsperado: totals.saldoEsperado + (Number(row.saldoEsperado) || 0),
        saldoReal: totals.saldoReal + (Number(row.saldoReal) || 0),
        diferencia: totals.diferencia + (Number(row.diferencia) || 0),
      }),
      { saldoInicial: 0, ingresos: 0, egresos: 0, transferenciasRecibidas: 0, transferenciasEnviadas: 0, saldoEsperado: 0, saldoReal: 0, diferencia: 0 },
    );
  }

  // Roles reconocidos actualmente por el sistema con privilegios para
  // gestionar cierres (los dos tipos), usuarios y facturas confirmadas.
  const PRIVILEGED_ROLES = new Set(["administradora", "administrador", "propietaria", "propietario"]);

  function isPrivilegedRole(role) {
    return PRIVILEGED_ROLES.has(String(role || "").trim().toLowerCase());
  }

  // Roles que pueden REVISAR (solo lectura) el modulo de Cuentas sin ser
  // privilegiados: no pueden borrar movimientos, alterar balances, reabrir
  // cierres, modificar usuarios ni confirmar tesoreria (eso sigue exigiendo
  // isPrivilegedRole en cada funcion de negocio, no solo ocultar el menu).
  const ACCOUNT_REVIEW_ROLES = new Set(["contador", "contadora"]);

  function canReviewAccounts(role, explicitPermissionFlag = false) {
    if (isPrivilegedRole(role)) return true;
    if (ACCOUNT_REVIEW_ROLES.has(String(role || "").trim().toLowerCase())) return true;
    return Boolean(explicitPermissionFlag);
  }

  // Formula centralizada de "presentacion clara" de una factura. Los
  // descuentos nunca dejan el total de servicios en negativo (se recorta en
  // 0), y la propina se suma UNA sola vez, aparte del ajuste de servicios.
  // precioListadoServicios/totalAdicionales/totalDescuentos/propina/
  // totalPagado son montos ya sumados (el llamador decide de donde salen:
  // lineas en vivo del formulario, o campos guardados de una factura vieja).
  function computeInvoiceBreakdown({
    precioListadoServicios = 0,
    totalAdicionales = 0,
    totalDescuentos = 0,
    propina = 0,
    totalPagado = 0,
  } = {}) {
    const listado = Number(precioListadoServicios) || 0;
    const adicionales = Number(totalAdicionales) || 0;
    const descuentos = Number(totalDescuentos) || 0;
    const subtotalAntesDeDescuentos = listado + adicionales;
    const totalServiciosAjustado = Math.max(0, subtotalAntesDeDescuentos - descuentos);
    const propinaNum = Math.max(0, Number(propina) || 0);
    const totalGeneral = totalServiciosAjustado + propinaNum;
    const pagado = Number(totalPagado) || 0;
    const montoPendiente = Math.max(0, totalGeneral - pagado);
    const sobrepago = Math.max(0, pagado - totalGeneral);
    return {
      precioListadoServicios: listado,
      totalAdicionales: adicionales,
      totalDescuentos: descuentos,
      subtotalAntesDeDescuentos,
      totalServiciosAjustado,
      propina: propinaNum,
      totalGeneral,
      totalPagado: pagado,
      montoPendiente,
      sobrepago,
      estaPagada: montoPendiente <= 0,
    };
  }

  // Orden en el que se consumen las lineas de pago CONFIRMADAS al cubrir
  // CxC anteriores / base de la factura / propina. Efectivo y transferencia
  // ya confirmada primero; tarjeta al final (para que la tarjeta financie la
  // propina solo cuando los demas medios de contado no alcanzaron).
  const DEFAULT_CONFIRMED_PAYMENT_METHOD_PRIORITY = ["efectivo", "transferencia_confirmada", "balance", "tarjeta"];

  // La UNICA politica de negocio valida (desde julio 2026): la propina se
  // cobra y se registra DE ULTIMO. El dinero confirmado que llega de un
  // cliente (nunca credito, nunca transferencia pendiente sin confirmar,
  // nunca tarjeta rechazada/pendiente) se aplica en este orden estricto:
  //   1. Cuentas por cobrar ANTERIORES del cliente (deuda de facturas viejas).
  //   2. Base de la factura actual (servicios + adicionales - descuentos).
  //   3. Propina pendiente de la factura actual.
  // Mientras quede pendiente 1 o 2, NUNCA se reconoce propina cobrada, sin
  // importar cuanto se haya pagado en total. Funcion pura: no lee el DOM, no
  // persiste nada, no crea ningun registro — solo calcula el reparto para
  // que el llamador decida que hacer con el resultado.
  function allocateConfirmedPayment({
    paymentLines = [],
    olderReceivablesOutstanding = 0,
    olderReceivablesList = null,
    currentInvoiceBaseOutstanding = 0,
    invoiceTipTotal = 0,
    invoiceTipAlreadyCollected = 0,
    methodPriority = DEFAULT_CONFIRMED_PAYMENT_METHOD_PRIORITY,
  } = {}) {
    const sanitizePositive = (value) => Math.max(0, sanitizeAmount(value));
    const confirmedMethods = new Set(methodPriority);

    // Solo lineas de pago CONFIRMADAS cuentan como dinero disponible: nunca
    // credito, nunca transferencia pendiente, nunca un metodo desconocido o
    // no confirmado (p. ej. tarjeta rechazada/pendiente de aprobar).
    const pool = (Array.isArray(paymentLines) ? paymentLines : [])
      .filter((line) => line && confirmedMethods.has(line.method))
      .map((line, index) => ({
        method: line.method,
        amount: sanitizePositive(line.amount),
        index,
        remaining: 0,
        olderReceivables: 0,
        currentBase: 0,
        tip: 0,
      }));
    pool.forEach((line) => {
      line.remaining = line.amount;
    });
    const priorityRank = new Map(methodPriority.map((method, rank) => [method, rank]));
    pool.sort((a, b) => {
      const rankDiff = (priorityRank.get(a.method) ?? methodPriority.length) - (priorityRank.get(b.method) ?? methodPriority.length);
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    });

    const totalConfirmed = pool.reduce((sum, line) => sum + line.amount, 0);
    const allocationByPaymentMethod = {};
    methodPriority.forEach((method) => {
      allocationByPaymentMethod[method] = 0;
    });
    const allocationDetails = [];

    const lineBucketKeys = { olderReceivables: "olderReceivables", currentInvoiceBase: "currentBase", invoiceTip: "tip" };
    function consume(bucket, needed) {
      let stillNeeded = sanitizePositive(needed);
      let applied = 0;
      const lineKey = lineBucketKeys[bucket];
      for (const line of pool) {
        if (stillNeeded <= 0) break;
        if (line.remaining <= 0) continue;
        const take = Math.min(line.remaining, stillNeeded);
        if (take <= 0) continue;
        line.remaining -= take;
        line[lineKey] += take;
        stillNeeded -= take;
        applied += take;
        allocationByPaymentMethod[line.method] = (allocationByPaymentMethod[line.method] || 0) + take;
        allocationDetails.push({ bucket, method: line.method, amount: take });
      }
      return applied;
    }

    const amountAppliedToOlderReceivables = consume("olderReceivables", sanitizePositive(olderReceivablesOutstanding));
    const amountAppliedToCurrentBase = consume("currentInvoiceBase", sanitizePositive(currentInvoiceBaseOutstanding));
    const tipTotal = sanitizePositive(invoiceTipTotal);
    const tipAlreadyCollected = Math.min(tipTotal, sanitizePositive(invoiceTipAlreadyCollected));
    const tipPendingBefore = Math.max(0, tipTotal - tipAlreadyCollected);
    const tipCollectedNow = consume("invoiceTip", tipPendingBefore);
    const tipRemaining = Math.max(0, tipPendingBefore - tipCollectedNow);

    const unappliedAmount = pool.reduce((sum, line) => sum + line.remaining, 0);

    // Reparto FIFO informativo por cada CxC anterior individual, cuando el
    // llamador pasa la lista real (mismo orden que applyClientReceivablesFirst:
    // la mas antigua primero). No muta la lista recibida.
    let allocationByReceivable = [];
    if (Array.isArray(olderReceivablesList) && olderReceivablesList.length) {
      let remainingForReceivables = amountAppliedToOlderReceivables;
      allocationByReceivable = olderReceivablesList
        .slice()
        .sort((a, b) => String(a.fechaOrigen || "").localeCompare(String(b.fechaOrigen || "")))
        .map((cxc) => {
          const pending = sanitizePositive(cxc.balancePendiente);
          const applied = Math.min(pending, remainingForReceivables);
          remainingForReceivables = Math.max(0, remainingForReceivables - applied);
          return { cxCID: cxc.cxCID || cxc.id || "", amount: applied };
        })
        .filter((row) => row.amount > 0);
    } else if (amountAppliedToOlderReceivables > 0) {
      allocationByReceivable = [{ cxCID: "", amount: amountAppliedToOlderReceivables }];
    }

    // Desglose POR LINEA de pago original (mismo orden/indice que el array
    // paymentLines recibido, no el orden de prioridad interno): permite al
    // llamador reconstruir, para cada linea (que conserva su propio
    // procesador/cuenta/referencia), cuanto de ELLA se destino a CxC
    // anteriores, a la base de esta factura, y a la propina — sin lo cual no
    // se podria ejecutar la mutacion real (addConfirmedPayment por linea)
    // respetando el desglose de esta funcion pura.
    const lineAllocations = pool
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((line) => ({
        index: line.index,
        method: line.method,
        amount: line.amount,
        olderReceivables: line.olderReceivables,
        currentBase: line.currentBase,
        tip: line.tip,
        unapplied: line.remaining,
      }));

    return {
      amountAppliedToOlderReceivables,
      amountAppliedToCurrentBase,
      tipCollectedNow,
      tipRemaining,
      allocationByPaymentMethod,
      allocationByReceivable,
      allocationByInvoice: { base: amountAppliedToCurrentBase, tip: tipCollectedNow },
      unappliedAmount,
      allocationDetails,
      lineAllocations,
      totalConfirmed,
    };
  }

  // Compara dos "receivables" (CxC reales del cliente O el par virtual
  // base/propina de la factura que se esta creando) para el orden FIFO
  // GLOBAL: fecha de origen -> factura -> base antes de propina DENTRO de
  // esa misma factura -> id estable como ultimo desempate. Exportada junto
  // a allocateClientPaymentFIFO para que el llamador pueda presentar la
  // misma previsualizacion FIFO sin reimplementar el orden.
  function compareReceivablesFIFO(a, b) {
    const dateCompare = String(a?.fechaOrigen || "").localeCompare(String(b?.fechaOrigen || ""));
    if (dateCompare !== 0) return dateCompare;
    const invoiceCompare = String(a?.invoiceId || "").localeCompare(String(b?.invoiceId || ""));
    if (invoiceCompare !== 0) return invoiceCompare;
    const kindRank = (kind) => (kind === "tip" ? 1 : 0);
    const kindCompare = kindRank(a?.kind) - kindRank(b?.kind);
    if (kindCompare !== 0) return kindCompare;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  }

  // "El pago se aplica desde la deuda mas antigua hasta la mas nueva", tanto
  // para un recibo GENERAL de cliente (sin factura "actual") como para el
  // guardado de una factura NUEVA con deuda anterior: es la MISMA funcion en
  // ambos casos (nunca dos algoritmos distintos). priorClientReceivables es
  // la lista REAL de CxC pendientes del cliente (cada una con
  // {id, invoiceId, kind: "base"|"tip", amount, fechaOrigen}); currentInvoiceBase/
  // currentInvoiceTip representan la factura que se esta creando AHORA
  // MISMO, si aplica (0 cuando es un recibo general sin factura nueva) — se
  // tratan como los items MAS RECIENTES de la cola FIFO (nunca se cobran
  // antes que cualquier CxC anterior real), con base siempre antes que
  // propina dentro de esa factura. Internamente reutiliza EXACTAMENTE la
  // misma matematica ya probada de allocateConfirmedPayment (nunca duplica
  // el algoritmo): solo reordena priorClientReceivables con
  // compareReceivablesFIFO() antes de delegarle el calculo, y traduce su
  // resultado a la forma mas rica que este flujo necesita (desglose por
  // factura afectada, saldo anterior/posterior por item).
  function allocateClientPaymentFIFO({
    confirmedPaymentLines = [],
    priorClientReceivables = [],
    currentInvoiceBase = 0,
    currentInvoiceTip = 0,
    currentInvoiceTipCollected = 0,
    methodPriority = DEFAULT_CONFIRMED_PAYMENT_METHOD_PRIORITY,
  } = {}) {
    const sanitizePositive = (value) => Math.max(0, sanitizeAmount(value));
    const normalizedReceivables = (Array.isArray(priorClientReceivables) ? priorClientReceivables : [])
      .map((row) => ({
        id: row?.id || row?.cxCID || "",
        invoiceId: row?.invoiceId || row?.facturaID || "",
        kind: row?.kind === "tip" ? "tip" : "base",
        amount: sanitizePositive(row?.amount ?? row?.balancePendiente),
        fechaOrigen: row?.fechaOrigen || "",
      }))
      .filter((row) => row.amount > 0)
      .sort(compareReceivablesFIFO);
    const priorTotal = normalizedReceivables.reduce((sum, row) => sum + row.amount, 0);

    const base = allocateConfirmedPayment({
      paymentLines: confirmedPaymentLines,
      olderReceivablesOutstanding: priorTotal,
      olderReceivablesList: normalizedReceivables.map((row) => ({ cxCID: row.id, balancePendiente: row.amount, fechaOrigen: row.fechaOrigen })),
      currentInvoiceBaseOutstanding: currentInvoiceBase,
      invoiceTipTotal: currentInvoiceTip,
      invoiceTipAlreadyCollected: currentInvoiceTipCollected,
      methodPriority,
    });

    // allocateConfirmedPayment() ya devuelve allocationByReceivable en orden
    // FIFO (reordena internamente con el mismo criterio de fecha, y como el
    // sort es estable, respeta el orden fino -factura, base antes de
    // propina- que ya trae normalizedReceivables): aqui solo se enriquece
    // cada fila con la metadata real (invoiceId, kind, saldo anterior).
    const byId = new Map(normalizedReceivables.map((row) => [row.id, row]));
    const appliedById = new Map(base.allocationByReceivable.map((row) => [row.cxCID, row.amount]));
    const resultingBalances = normalizedReceivables.map((row) => {
      const amountApplied = appliedById.get(row.id) || 0;
      return {
        id: row.id,
        invoiceId: row.invoiceId,
        kind: row.kind,
        previousBalance: row.amount,
        amountApplied,
        remainingBalance: Math.max(0, row.amount - amountApplied),
      };
    });
    const allocationsToPriorReceivables = resultingBalances.filter((row) => row.amountApplied > 0);
    const affectedInvoiceIds = [...new Set(allocationsToPriorReceivables.map((row) => row.invoiceId).filter(Boolean))];

    return {
      allocationsToPriorReceivables,
      amountAppliedToPriorReceivables: base.amountAppliedToOlderReceivables,
      amountAppliedToCurrentBase: base.amountAppliedToCurrentBase,
      amountAppliedToCurrentTip: base.tipCollectedNow,
      currentBaseRemaining: Math.max(0, sanitizePositive(currentInvoiceBase) - base.amountAppliedToCurrentBase),
      currentTipRemaining: base.tipRemaining,
      totalApplied: base.amountAppliedToOlderReceivables + base.amountAppliedToCurrentBase + base.tipCollectedNow,
      unappliedAmount: base.unappliedAmount,
      allocationByPaymentMethod: base.allocationByPaymentMethod,
      affectedInvoiceIds,
      resultingBalances,
      lineAllocations: base.lineAllocations,
    };
  }

  // Balance final calculado de una cuenta en un dia:
  // balanceInicial + ingresos + transferenciasEntrantes - egresos -
  // transferenciasSalientes + ajustesNetos. Las transferencias internas ya
  // deben venir separadas de ingresos/egresos generales por el llamador,
  // para no contarlas dos veces.
  function computeAccountDailyBalance({
    balanceInicial = 0,
    ingresos = 0,
    egresos = 0,
    transferenciasEntrantes = 0,
    transferenciasSalientes = 0,
    ajustesNetos = 0,
  } = {}) {
    const inicial = Number(balanceInicial) || 0;
    const ing = Number(ingresos) || 0;
    const eg = Number(egresos) || 0;
    const transIn = Number(transferenciasEntrantes) || 0;
    const transOut = Number(transferenciasSalientes) || 0;
    const ajustes = Number(ajustesNetos) || 0;
    const balanceFinalCalculado = inicial + ing + transIn - eg - transOut + ajustes;
    return {
      balanceInicial: inicial,
      ingresos: ing,
      egresos: eg,
      transferenciasEntrantes: transIn,
      transferenciasSalientes: transOut,
      ajustesNetos: ajustes,
      balanceFinalCalculado,
    };
  }

  // Saldo acumulado deterministico de una lista de movimientos: ordena por
  // fecha, luego por createdAt, luego por un id estable, y va sumando
  // ingreso-egreso en ese orden. No muta la lista de entrada.
  function sortMovementsDeterministically(movements) {
    return (movements || [])
      .slice()
      .sort((a, b) => {
        const dateDiff = String(a.date || "").localeCompare(String(b.date || ""));
        if (dateDiff) return dateDiff;
        const createdDiff = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
        if (createdDiff) return createdDiff;
        return String(a.id || "").localeCompare(String(b.id || ""));
      });
  }

  function buildRunningBalance(movements, openingBalance = 0) {
    let running = Number(openingBalance) || 0;
    return sortMovementsDeterministically(movements).map((movement) => {
      running += (Number(movement.income) || 0) - (Number(movement.expense) || 0);
      return { ...movement, runningBalance: running };
    });
  }

  // ===========================================================================
  // Nomina quincenal, comisiones, propinas, vacaciones, TSS y CxC de
  // colaboradores (julio 2026). Funciones puras: no leen el DOM, no
  // persisten, no crean movimientos. app.js las usa para calcular/previsualizar
  // y para validar antes de escribir; la escritura real (dbTable/stampRecord)
  // siempre ocurre en app.js, nunca aqui.
  // ===========================================================================

  function roundMoney(value) {
    const num = sanitizeAmount(value);
    return Math.round(num * 100) / 100;
  }

  // Reparte el salario mensual en las dos cuotas quincenales EXACTAS (nunca
  // una tercera cuota): la primera es la mitad redondeada a centavos, la
  // segunda es el resto (mensual - primera), de forma que primera+segunda
  // sume el mensual centavo a centavo sin importar el redondeo.
  function computeBiweeklySalaryInstallment({ monthlySalary = 0, cut = "month" } = {}) {
    const monthly = Math.max(0, roundMoney(monthlySalary));
    if (cut === "month") return { first: monthly, second: 0, monthlyTotal: monthly, installment: monthly };
    const first = Math.round((monthly / 2) * 100) / 100;
    const second = Math.round((monthly - first) * 100) / 100;
    const installment = cut === "second" ? second : first;
    return { first, second, monthlyTotal: monthly, installment };
  }

  // Ultimo dia calendario de un mes (para "dia 30" en meses de 28/29/30/31 dias,
  // incluyendo febrero). month es 1-12.
  function lastCalendarDayOfMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  // Fecha ordinaria de pago de una quincena: dia 15 (primera) o el ULTIMO dia
  // calendario del mes (segunda; dia 30 salvo febrero/meses cortos, nunca un
  // dia inexistente). period = "YYYY-MM".
  function payrollOrdinaryPaymentDate({ period, cut } = {}) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(period || ""));
    if (!match) return "";
    const year = Number(match[1]);
    const monthNum = Number(match[2]);
    if (cut === "first") return `${period}-15`;
    if (cut === "second") return `${period}-${String(lastCalendarDayOfMonth(year, monthNum)).padStart(2, "0")}`;
    return "";
  }

  // Periodo especial de propinas/comisiones: desde el dia 21 del mes ANTERIOR
  // hasta el dia 20 del mes de "period" (el mes de la nomina del dia 30),
  // ambos inclusive, sin duplicar ni saltar el dia 20/21. Fechas-calendario
  // puras (mismo criterio que el resto del modulo: "hoy" ya es la fecha
  // operativa en America/Santo_Domingo cuando app.js la genera, asi que esta
  // funcion no vuelve a convertir zona horaria, solo hace aritmetica de
  // calendario sobre las fechas-YYYY-MM-DD que ya recibe).
  function computeTipCommissionPeriod({ period } = {}) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(period || ""));
    if (!match) return { start: "", end: "", valid: false };
    const year = Number(match[1]);
    const monthNum = Number(match[2]);
    const prevMonthDate = new Date(Date.UTC(year, monthNum - 1, 1));
    prevMonthDate.setUTCMonth(prevMonthDate.getUTCMonth() - 1);
    const prevYear = prevMonthDate.getUTCFullYear();
    const prevMonth = String(prevMonthDate.getUTCMonth() + 1).padStart(2, "0");
    return { start: `${prevYear}-${prevMonth}-21`, end: `${period}-20`, valid: true };
  }

  // Produccion elegible -> comision. mode "total_por_umbral" (default,
  // preserva la semantica ya implementada en app.js: el umbral con el
  // "desde" mas alto que la produccion total alcanza se aplica a TODA la
  // produccion, sin acumular por tramos). "progresivo_por_tramos" queda
  // disponible para cuando la administradora lo configure explicitamente,
  // nunca se aplica por defecto.
  function selectCommissionThreshold({ eligibleSales = 0, thresholds = [], mode = "total_por_umbral" } = {}) {
    const sales = Math.max(0, roundMoney(eligibleSales));
    const active = (Array.isArray(thresholds) ? thresholds : []).filter(
      (rule) => rule && String(rule.estado || "Activo").trim().toLowerCase() !== "inactivo",
    );
    if (mode === "progresivo_por_tramos") {
      const sorted = active.slice().sort((a, b) => sanitizeAmount(a.desde) - sanitizeAmount(b.desde));
      let remaining = sales;
      let commissionAmount = 0;
      const tramosAplicados = [];
      sorted.forEach((rule) => {
        const from = Math.max(0, sanitizeAmount(rule.desde));
        const to = sanitizeAmount(rule.hasta);
        const tramoTop = to > 0 ? to : Infinity;
        const tramoSize = Math.max(0, Math.min(sales, tramoTop) - from);
        if (tramoSize <= 0 || sales <= from || remaining <= 0) return;
        const taken = Math.min(remaining, tramoSize);
        const rate = sanitizeAmount(rule.porcentajeComision);
        commissionAmount += taken * rate;
        remaining -= taken;
        tramosAplicados.push({ escalaID: rule.escalaID || rule.id || "", rate, base: taken });
      });
      return {
        mode: "progresivo_por_tramos",
        thresholdId: tramosAplicados.map((t) => t.escalaID).join(","),
        rate: sales > 0 ? commissionAmount / sales : 0,
        commissionAmount: roundMoney(commissionAmount),
        eligibleSales: sales,
        tramosAplicados,
      };
    }
    const applicable = active
      .filter((rule) => sales >= sanitizeAmount(rule.desde) && (sanitizeAmount(rule.hasta) <= 0 || sales <= sanitizeAmount(rule.hasta)))
      .sort((a, b) => sanitizeAmount(b.desde) - sanitizeAmount(a.desde));
    const winner = applicable[0] || null;
    const rate = winner ? sanitizeAmount(winner.porcentajeComision) : 0;
    return {
      mode: "total_por_umbral",
      thresholdId: winner?.escalaID || winner?.id || "",
      rate,
      commissionAmount: roundMoney(sales * rate),
      eligibleSales: sales,
    };
  }

  // Valida una regla de umbral ANTES de guardarla (la UI actual no validaba
  // nada: minimo/maximo/porcentaje podian quedar en 0 silenciosamente y dos
  // rangos podian solaparse sin aviso). No muta rule ni existingRules.
  function validateCommissionThresholdRule(rule, existingRules = []) {
    const errors = [];
    const min = sanitizeAmount(rule?.desde);
    const rawMax = rule?.hasta;
    const hasMax = rawMax !== undefined && rawMax !== null && rawMax !== "" && sanitizeAmount(rawMax) > 0;
    const max = hasMax ? sanitizeAmount(rawMax) : null;
    const rawRate = Number(rule?.porcentajeComision);
    if (!Number.isFinite(min) || min < 0) errors.push("El monto minimo debe ser un numero finito mayor o igual a 0.");
    if (hasMax && (!Number.isFinite(max) || max <= min)) errors.push("El monto maximo debe ser mayor que el minimo.");
    if (rule?.porcentajeComision === undefined || rule?.porcentajeComision === null || rule?.porcentajeComision === "" || !Number.isFinite(rawRate)) {
      errors.push("El porcentaje de comision debe ser un numero finito.");
    } else {
      const percent = rawRate > 1 ? rawRate : rawRate * 100;
      if (percent < 0 || percent > 100) errors.push("El porcentaje de comision debe estar entre 0 y 100.");
    }
    const overlaps = (Array.isArray(existingRules) ? existingRules : []).some((other) => {
      if (!other || (rule?.escalaID && other.escalaID === rule.escalaID)) return false;
      if (String(other.estado || "Activo").trim().toLowerCase() === "inactivo") return false;
      if ((other.aplicaA || "") !== (rule?.aplicaA || "")) return false;
      const otherMin = sanitizeAmount(other.desde);
      const otherMax = sanitizeAmount(other.hasta) > 0 ? sanitizeAmount(other.hasta) : Infinity;
      const ruleMax = max === null ? Infinity : max;
      return min < otherMax && ruleMax > otherMin;
    });
    if (overlaps) errors.push("Este rango se solapa con otro umbral activo ya configurado para el mismo colaborador/grupo.");
    return { valid: errors.length === 0, errors };
  }

  // Cuantos dias de unas vacaciones prepagadas (vacationStart, vacationDays
  // dias corridos) caen dentro de un corte de nomina especifico [cutStart,
  // cutEnd], y a cuanto equivale eso en dinero ya adelantado (dailyValue por
  // dia). Se usa para RESTAR de la cuota salarial ordinaria de ese corte,
  // nunca para restarlo dos veces si se llama una vez por cada corte.
  function computeVacationSalaryOffset({ vacationStart, vacationDays = 0, cutStart, cutEnd, dailyValue = 0 } = {}) {
    const days = Math.max(0, Math.floor(sanitizeAmount(vacationDays)));
    const rate = Math.max(0, roundMoney(dailyValue));
    if (!isValidIsoDate(vacationStart) || !isValidIsoDate(cutStart) || !isValidIsoDate(cutEnd) || days <= 0) {
      return { daysInCut: 0, offsetAmount: 0 };
    }
    const vacationEnd = addDaysToIsoDate(vacationStart, days - 1);
    const overlapStart = vacationStart > cutStart ? vacationStart : cutStart;
    const overlapEnd = vacationEnd < cutEnd ? vacationEnd : cutEnd;
    if (overlapStart > overlapEnd) return { daysInCut: 0, offsetAmount: 0 };
    let daysInCut = 0;
    let cursor = overlapStart;
    while (cursor <= overlapEnd && daysInCut <= 400) {
      daysInCut++;
      cursor = addDaysToIsoDate(cursor, 1);
    }
    return { daysInCut, offsetAmount: roundMoney(daysInCut * rate) };
  }

  // Compara dos CxC de colaborador para el orden FIFO de descuento en nomina:
  // fecha de origen -> vencimiento -> id estable. Mismo principio que
  // compareReceivablesFIFO (clientes), aplicado a CxC de colaboradores.
  function compareCollaboratorReceivablesFIFO(a, b) {
    const dateCompare = String(a?.fechaOrigen || "").localeCompare(String(b?.fechaOrigen || ""));
    if (dateCompare !== 0) return dateCompare;
    const dueCompare = String(a?.fechaVencimiento || "").localeCompare(String(b?.fechaVencimiento || ""));
    if (dueCompare !== 0) return dueCompare;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  }

  // Aplica un monto total elegido por la administradora contra las CxC
  // pendientes del colaborador, de la mas antigua a la mas reciente, sin
  // superar ni el saldo pendiente de cada una ni el monto solicitado.
  function applyCollaboratorReceivablesFIFO({ receivables = [], amountToApply = 0 } = {}) {
    const sanitizePositive = (value) => Math.max(0, sanitizeAmount(value));
    const normalized = (Array.isArray(receivables) ? receivables : [])
      .map((row) => ({
        id: row?.id || row?.cxCID || "",
        balance: sanitizePositive(row?.balance ?? row?.balancePendiente),
        fechaOrigen: row?.fechaOrigen || "",
        fechaVencimiento: row?.fechaVencimiento || "",
      }))
      .filter((row) => row.balance > 0)
      .sort(compareCollaboratorReceivablesFIFO);
    const totalPending = normalized.reduce((sum, row) => sum + row.balance, 0);
    const totalRequested = sanitizePositive(amountToApply);
    let remaining = Math.min(totalRequested, totalPending);
    const allocations = normalized
      .map((row) => {
        const applied = Math.min(remaining, row.balance);
        remaining = Math.max(0, remaining - applied);
        return { id: row.id, previousBalance: row.balance, amountApplied: roundMoney(applied), remainingBalance: roundMoney(Math.max(0, row.balance - applied)) };
      })
      .filter((row) => row.amountApplied > 0);
    const totalApplied = roundMoney(allocations.reduce((sum, row) => sum + row.amountApplied, 0));
    return { allocations, totalApplied, unappliedAmount: roundMoney(Math.max(0, totalRequested - totalApplied)) };
  }

  // Liquidacion de nomina de UN colaborador para UNA quincena: funcion pura
  // que combina salario/comisiones/propinas/bonos/otros ingresos menos
  // TSS/CxC descontada/otros descuentos. No lee el DOM, no persiste, no crea
  // movimientos: app.js la usa para calcular el borrador Y para recalcular
  // exactamente lo mismo en el momento de pagar (una sola formula, nunca dos).
  function calculatePayrollSettlement({
    monthlySalary = 0,
    payrollType = "quincena",
    salaryInstallment = null,
    salaryProration = 0,
    vacationAdvancePaid = 0,
    vacationSalaryOffset = 0,
    commissions = 0,
    collectedTipsPayable = 0,
    bonuses = 0,
    otherIncome = 0,
    employeeTssDeduction = 0,
    employeeReceivableDeduction = 0,
    otherDeductions = 0,
    employerTssContribution = 0,
    allowNegativeNet = false,
  } = {}) {
    const errors = [];
    const numericInputs = {
      monthlySalary,
      salaryProration,
      vacationAdvancePaid,
      vacationSalaryOffset,
      commissions,
      collectedTipsPayable,
      bonuses,
      otherIncome,
      employeeTssDeduction,
      employeeReceivableDeduction,
      otherDeductions,
      employerTssContribution,
    };
    Object.entries(numericInputs).forEach(([key, value]) => {
      if (value === null || value === undefined) return;
      const num = Number(value);
      if (!Number.isFinite(num)) errors.push(`${key} debe ser un numero finito.`);
      else if (num < 0) errors.push(`${key} no puede ser negativo.`);
    });
    if (salaryInstallment !== null && salaryInstallment !== undefined) {
      const num = Number(salaryInstallment);
      if (!Number.isFinite(num)) errors.push("salaryInstallment debe ser un numero finito.");
      else if (num < 0) errors.push("salaryInstallment no puede ser negativo.");
    }

    const monthlySalaryAmount = roundMoney(monthlySalary);
    const installmentBase = Math.max(0, salaryInstallment === null || salaryInstallment === undefined ? monthlySalaryAmount : roundMoney(salaryInstallment));
    const salaryProrationAmount = roundMoney(salaryProration);
    const vacationOffsetAmount = Math.min(installmentBase, roundMoney(vacationSalaryOffset));
    // El ajuste por vacaciones prepagadas NUNCA es una sancion: solo evita
    // pagar dos veces los mismos dias, restando de la cuota ordinaria
    // exactamente lo que ya se adelanto para esos dias de ese corte.
    const salaryPayable = Math.max(0, roundMoney(installmentBase - vacationOffsetAmount - salaryProrationAmount));

    const commissionAmount = Math.max(0, roundMoney(commissions));
    const tipsPayableAmount = Math.max(0, roundMoney(collectedTipsPayable));
    const bonusAmount = Math.max(0, roundMoney(bonuses));
    const otherIncomeAmount = Math.max(0, roundMoney(otherIncome));
    const grossAmount = roundMoney(salaryPayable + commissionAmount + tipsPayableAmount + bonusAmount + otherIncomeAmount);

    const tssEmployeeDeduction = Math.max(0, roundMoney(employeeTssDeduction));
    const employeeReceivableDeductionAmount = Math.max(0, roundMoney(employeeReceivableDeduction));
    const otherDeductionsAmount = Math.max(0, roundMoney(otherDeductions));
    const totalDeductions = roundMoney(tssEmployeeDeduction + employeeReceivableDeductionAmount + otherDeductionsAmount);

    const rawNet = roundMoney(grossAmount - totalDeductions);
    if (rawNet < 0 && !allowNegativeNet) {
      errors.push("El neto a pagar no puede ser negativo. Reduce los descuentos o registra el excedente como CxC del colaborador.");
    }
    const netPayable = allowNegativeNet ? rawNet : Math.max(0, rawNet);

    const breakdown = [
      { key: "salaryPayable", label: "Salario pagable", amount: salaryPayable },
      { key: "commissionAmount", label: "Comision", amount: commissionAmount },
      { key: "tipsPayableAmount", label: "Propinas cobradas pendientes", amount: tipsPayableAmount },
      { key: "bonusAmount", label: "Bonos", amount: bonusAmount },
      { key: "otherIncomeAmount", label: "Otros ingresos", amount: otherIncomeAmount },
      { key: "tssEmployeeDeduction", label: "TSS del colaborador", amount: -tssEmployeeDeduction },
      { key: "employeeReceivableDeduction", label: "CxC descontada al colaborador", amount: -employeeReceivableDeductionAmount },
      { key: "otherDeductionsAmount", label: "Otros descuentos", amount: -otherDeductionsAmount },
    ];

    return {
      monthlySalary: monthlySalaryAmount,
      payrollType,
      salaryInstallment: installmentBase,
      salaryProration: salaryProrationAmount,
      vacationAdvancePaid: Math.max(0, roundMoney(vacationAdvancePaid)),
      vacationSalaryOffset: vacationOffsetAmount,
      salaryPayable,
      commissionAmount,
      tipsPayableAmount,
      bonusAmount,
      otherIncomeAmount,
      grossAmount,
      tssEmployeeDeduction,
      employeeReceivableDeduction: employeeReceivableDeductionAmount,
      otherDeductionsAmount,
      totalDeductions,
      netPayable,
      employerTssContribution: Math.max(0, roundMoney(employerTssContribution)),
      validationErrors: errors,
      breakdown,
    };
  }

  // ===========================================================================
  // Inventario: articulos, almacenes/ubicaciones, movimientos, costo
  // promedio, lotes/FEFO e impuestos por linea (julio 2026). Funciones
  // puras: no leen el DOM, no persisten, no crean auditoria. app.js las usa
  // para calcular/validar antes de escribir; la escritura real
  // (dbTable/stampRecord) siempre ocurre en app.js, nunca aqui.
  // ===========================================================================

  // Conversion segura unidad de compra -> unidad base. Nunca acepta un
  // factor <= 0 (dividir/multiplicar por eso rompe la existencia).
  function convertToBaseQuantity({ quantity = 0, factor = 1 } = {}) {
    const rawQuantity = Number(quantity);
    const rawFactor = Number(factor);
    const errors = [];
    if (!Number.isFinite(rawQuantity)) errors.push("La cantidad debe ser un numero finito.");
    if (!Number.isFinite(rawFactor) || rawFactor <= 0) errors.push("El factor de conversion debe ser un numero finito mayor que cero.");
    if (errors.length) return { baseQuantity: 0, validationErrors: errors };
    return { baseQuantity: roundMoney(rawQuantity * rawFactor), validationErrors: [] };
  }

  // Existencia de un articulo (global, por ubicacion, y/o por lote) a partir
  // de la lista de movimientos: NUNCA de un campo "stock" editable a mano.
  // Una transferencia se modela como DOS movimientos vinculados por
  // transferId (uno "out" en el origen, uno "in" en el destino), asi que
  // sumar TODAS las ubicaciones de un articulo siempre da su existencia
  // global real, sin necesitar logica especial para transferencias.
  function calculateInventoryByLocation({ movements = [], itemId = "", locationId = "", lotId = "" } = {}) {
    const filtered = (Array.isArray(movements) ? movements : []).filter((movement) => {
      if (!movement) return false;
      if (itemId && movement.itemId !== itemId) return false;
      if (locationId && movement.locationId !== locationId) return false;
      if (lotId && movement.lotId !== lotId) return false;
      if (String(movement.estado || "Confirmado").toLowerCase() === "revertido") return false;
      return true;
    });
    const quantity = filtered.reduce((sum, movement) => {
      const qty = Math.abs(sanitizeAmount(movement.cantidadBase ?? movement.quantity));
      return sum + (movement.direction === "out" ? -qty : qty);
    }, 0);
    return { itemId, locationId, lotId, quantity: roundMoney(quantity), movementCount: filtered.length };
  }

  const INVENTORY_OUTBOUND_TYPES = new Set([
    "salida",
    "consumo_servicio",
    "venta",
    "perdida",
    "dano",
    "vencimiento",
    "ajuste_negativo",
    "transferencia_salida",
    "entrega_mesa",
    "entrega_custodia",
    "devolucion_suplidor",
    "consumo_academia",
    "consumo_interno",
  ]);
  const INVENTORY_INBOUND_TYPES = new Set([
    "entrada",
    "compra",
    "ajuste_positivo",
    "transferencia_entrada",
    "devolucion_cliente",
    "devolucion_mesa",
    "retorno_custodia",
    "reversion",
    "devolucion_academia",
  ]);

  // Valida y calcula el efecto de UN movimiento de inventario, sin aplicarlo
  // (app.js decide si persistirlo). Nunca permite existencia negativa salvo
  // allowNegativeStock explicito; nunca aplica un sourceKey ya usado.
  function applyInventoryMovement({
    currentStock = 0,
    movementType = "",
    quantity = 0,
    allowNegativeStock = false,
    existingSourceKeys = [],
    sourceKey = "",
  } = {}) {
    const errors = [];
    const stockBefore = sanitizeAmount(currentStock);
    const rawQuantity = Number(quantity);
    if (!Number.isFinite(rawQuantity)) errors.push("La cantidad debe ser un numero finito.");
    else if (rawQuantity === 0) errors.push("La cantidad debe ser distinta de cero.");
    const normalizedQuantity = Number.isFinite(rawQuantity) ? Math.abs(sanitizeAmount(rawQuantity)) : 0;
    const direction = INVENTORY_OUTBOUND_TYPES.has(movementType) ? "out" : INVENTORY_INBOUND_TYPES.has(movementType) ? "in" : null;
    if (!direction) errors.push(`Tipo de movimiento desconocido: ${movementType || "(vacio)"}.`);
    const duplicate = Boolean(sourceKey) && (Array.isArray(existingSourceKeys) ? existingSourceKeys : []).includes(sourceKey);
    if (duplicate) errors.push("Este movimiento ya fue aplicado antes (sourceKey duplicado).");
    let stockAfter = stockBefore;
    let movementAllowed = errors.length === 0;
    if (movementAllowed) {
      stockAfter = direction === "out" ? stockBefore - normalizedQuantity : stockBefore + normalizedQuantity;
      if (stockAfter < 0 && !allowNegativeStock) {
        errors.push("La salida dejaria existencia negativa y no esta autorizada para este articulo/ubicacion.");
        movementAllowed = false;
        stockAfter = stockBefore;
      }
    }
    return {
      normalizedQuantity,
      stockBefore: roundMoney(stockBefore),
      stockAfter: roundMoney(stockAfter),
      direction: direction || "unknown",
      validationErrors: errors,
      duplicate,
      movementAllowed,
    };
  }

  // Costo promedio ponderado: nunca cambia movimientos anteriores, solo
  // calcula el nuevo promedio para la PROXIMA entrada. Existencia <= 0
  // reinicia el promedio al costo de la entrada actual (nunca divide por
  // cero).
  function calculateWeightedAverageCost({ previousStock = 0, previousAverageCost = 0, incomingQuantity = 0, incomingCost = 0 } = {}) {
    const stock = Math.max(0, sanitizeAmount(previousStock));
    const avgCost = Math.max(0, sanitizeAmount(previousAverageCost));
    const qty = Math.max(0, sanitizeAmount(incomingQuantity));
    const cost = Math.max(0, sanitizeAmount(incomingCost));
    const newStock = roundMoney(stock + qty);
    if (newStock <= 0) return { newAverageCost: 0, newStock: 0 };
    const newAverageCost = (stock * avgCost + qty * cost) / newStock;
    return { newAverageCost: roundMoney(newAverageCost), newStock };
  }

  // FEFO ("first expired, first out"): lotes sin fecha de vencimiento van al
  // final (nunca se priorizan sobre un lote con fecha real). Desempate por
  // fecha de entrada y luego por lotId estable.
  function compareLotsFEFO(a, b) {
    const expA = a?.fechaVencimiento || "9999-12-31";
    const expB = b?.fechaVencimiento || "9999-12-31";
    const expCompare = String(expA).localeCompare(String(expB));
    if (expCompare !== 0) return expCompare;
    const entryCompare = String(a?.fechaEntrada || "").localeCompare(String(b?.fechaEntrada || ""));
    if (entryCompare !== 0) return entryCompare;
    return String(a?.lotId || "").localeCompare(String(b?.lotId || ""));
  }

  // Reparte una cantidad necesaria entre lotes disponibles en orden FEFO,
  // EXCLUYENDO lotes ya vencidos a la fecha de referencia (nunca mezcla
  // vencidos con disponibles). No muta la lista recibida.
  function allocateFEFO({ lots = [], quantityNeeded = 0, referenceDate = "" } = {}) {
    const needed = Math.max(0, sanitizeAmount(quantityNeeded));
    const available = (Array.isArray(lots) ? lots : [])
      .map((lot) => ({
        lotId: lot?.lotId || "",
        quantity: Math.max(0, sanitizeAmount(lot?.quantity)),
        fechaVencimiento: lot?.fechaVencimiento || "",
        fechaEntrada: lot?.fechaEntrada || "",
      }))
      .filter((lot) => lot.quantity > 0)
      .filter((lot) => !referenceDate || !lot.fechaVencimiento || lot.fechaVencimiento >= referenceDate)
      .sort(compareLotsFEFO);
    let remaining = needed;
    const allocations = [];
    available.forEach((lot) => {
      if (remaining <= 0) return;
      const take = Math.min(remaining, lot.quantity);
      if (take <= 0) return;
      allocations.push({ lotId: lot.lotId, quantityTaken: roundMoney(take) });
      remaining = Math.max(0, remaining - take);
    });
    return { allocations, totalAllocated: roundMoney(needed - remaining), unallocated: roundMoney(remaining) };
  }

  // Divide un monto en base + impuesto para UNA linea (servicio o
  // articulo). Nunca hardcodea una tasa: siempre recibe taxRate desde la
  // configuracion vigente del articulo/servicio. No exenta ni grava nada
  // por si misma.
  function splitInvoiceLineTax({ amount = 0, taxable = false, taxRate = 0, priceIncludesTax = false } = {}) {
    const total = Math.max(0, sanitizeAmount(amount));
    const rate = Math.max(0, sanitizeAmount(taxRate));
    if (!taxable || rate <= 0) return { baseAmount: roundMoney(total), taxAmount: 0, totalAmount: roundMoney(total) };
    if (priceIncludesTax) {
      const baseAmount = total / (1 + rate / 100);
      const taxAmount = total - baseAmount;
      return { baseAmount: roundMoney(baseAmount), taxAmount: roundMoney(taxAmount), totalAmount: roundMoney(total) };
    }
    const taxAmount = total * (rate / 100);
    return { baseAmount: roundMoney(total), taxAmount: roundMoney(taxAmount), totalAmount: roundMoney(total + taxAmount) };
  }

  // ===========================================================================
  // Auditoria de mesas, factura mixta y costos de inventario (julio 2026).
  // Todo lo de abajo son funciones puras: no leen DOM, no persisten, no
  // crean auditoria ni movimientos reales. app.js decide que hacer con el
  // resultado (bloquear, avisar o aplicar).
  // ===========================================================================

  // Prevalida el consumo de inventario por servicio de una factura ANTES de
  // guardar nada. Nunca lee el DOM ni escribe: solo dice que se necesita,
  // que hay disponible, que falta y si la operacion queda permitida segun
  // el modo. En "required" un faltante bloquea (allowed=false); en
  // "audit_only" nunca bloquea (los faltantes quedan como warnings, para
  // conciliar despues); en "disabled" no se calcula nada.
  function preflightServiceInventoryConsumption({
    invoiceLines = [],
    serviceRecipes = [],
    warehouseInventory = {},
    mode = "disabled",
    allowNegativeStockFor = () => false,
  } = {}) {
    if (mode === "disabled") {
      return {
        requiredItems: [],
        availableItems: [],
        shortages: [],
        invalidRecipes: [],
        estimatedCost: 0,
        movementPlan: [],
        blockingErrors: [],
        warnings: [],
        allowed: true,
        mode,
      };
    }

    const invalidRecipes = [];
    const needByItem = new Map();
    (Array.isArray(invoiceLines) ? invoiceLines : []).forEach((line) => {
      const serviceName = String(line?.servicio ?? line?.service ?? "").trim();
      const qty = Math.max(0, sanitizeAmount(line?.cantidad ?? line?.qty ?? 1));
      if (!serviceName || qty <= 0) return;
      const recipeLines = (Array.isArray(serviceRecipes) ? serviceRecipes : []).filter(
        (recipe) => String(recipe?.servicioNombre ?? "").trim().toLowerCase() === serviceName.toLowerCase(),
      );
      recipeLines.forEach((recipe) => {
        if (!recipe?.itemId || recipe.reutilizable || recipe.activoFijo || recipe.puedeConsumirse === false) {
          invalidRecipes.push({ servicio: serviceName, itemId: recipe?.itemId || "", reason: !recipe?.itemId ? "sin_articulo" : "no_consumible" });
          return;
        }
        const perUnit = Math.max(0, sanitizeAmount(recipe.cantidadEstimada));
        if (perUnit <= 0) return;
        const neededQty = roundMoney(perUnit * qty);
        const existing = needByItem.get(recipe.itemId) || { itemId: recipe.itemId, quantity: 0, detalleIDs: [] };
        existing.quantity = roundMoney(existing.quantity + neededQty);
        existing.detalleIDs.push(line.detalleID || "");
        needByItem.set(recipe.itemId, existing);
      });
    });

    const requiredItems = [];
    const availableItems = [];
    const shortages = [];
    const movementPlan = [];
    let estimatedCost = 0;

    needByItem.forEach((need) => {
      requiredItems.push({ itemId: need.itemId, quantity: need.quantity, detalleIDs: need.detalleIDs });
      const inv = warehouseInventory[need.itemId] || { quantity: 0, unitCost: 0 };
      const available = Math.max(0, sanitizeAmount(inv.quantity));
      const unitCost = Math.max(0, sanitizeAmount(inv.unitCost));
      availableItems.push({ itemId: need.itemId, quantity: available });
      estimatedCost = roundMoney(estimatedCost + need.quantity * unitCost);
      const negativeAllowed = Boolean(allowNegativeStockFor(need.itemId));
      const wouldGoNegative = roundMoney(available - need.quantity) < 0;
      if (wouldGoNegative && !negativeAllowed) {
        shortages.push({ itemId: need.itemId, needed: need.quantity, available, shortfall: roundMoney(need.quantity - available) });
      } else {
        movementPlan.push({ itemId: need.itemId, quantityBase: need.quantity, unitCost, allowNegativeStock: negativeAllowed, detalleIDs: need.detalleIDs });
      }
    });

    const blockingErrors = [];
    const warnings = [];
    const shortageMessage = (s) => `Existencia insuficiente de ${s.itemId}: faltan ${s.shortfall} unidad(es) base.`;
    const invalidMessage = (r) => `Ficha técnica inválida para "${r.servicio}" (${r.reason === "sin_articulo" ? "artículo no encontrado" : "artículo no consumible"}).`;
    if (mode === "required") {
      shortages.forEach((s) => blockingErrors.push(shortageMessage(s)));
      invalidRecipes.forEach((r) => blockingErrors.push(invalidMessage(r)));
    } else {
      shortages.forEach((s) => warnings.push(shortageMessage(s)));
      invalidRecipes.forEach((r) => warnings.push(invalidMessage(r)));
    }

    const allowed = mode === "required" ? blockingErrors.length === 0 : true;
    return {
      requiredItems,
      availableItems,
      shortages,
      invalidRecipes,
      estimatedCost: roundMoney(estimatedCost),
      movementPlan,
      blockingErrors,
      warnings,
      allowed,
      mode,
    };
  }

  // Reversion idempotente de los efectos de inventario de una factura
  // (consumo de servicio o venta directa). Nunca borra el movimiento
  // original ni toca pagos/CxC/propina/nomina: solo calcula los
  // movimientos compensatorios pendientes de persistir (createInventoryMovement
  // en app.js aplica cada uno). Bloquea una segunda reversion del mismo
  // movimiento original via el sourceKey `reversion:<original>`.
  function reverseInvoiceInventoryEffects({ invoiceId = "", inventoryMovements = [], reason = "", actor = "" } = {}) {
    const blockingErrors = [];
    if (!invoiceId) blockingErrors.push("Falta invoiceId.");
    if (!reason) blockingErrors.push("Falta el motivo de la reversión.");
    if (blockingErrors.length) return { reversalMovements: [], alreadyReversed: [], blockingErrors, allowed: false };

    const allMovements = Array.isArray(inventoryMovements) ? inventoryMovements : [];
    const existingSourceKeys = new Set(allMovements.map((m) => m.sourceKey).filter(Boolean));
    const originals = allMovements.filter(
      (m) => m.sourceId === invoiceId
        && String(m.estado || "Confirmado").toLowerCase() !== "revertido"
        && (m.tipo === "consumo_servicio" || m.tipo === "venta"),
    );

    const reversalMovements = [];
    const alreadyReversed = [];
    originals.forEach((original) => {
      const originalKey = original.sourceKey || `${invoiceId}:${original.movementId}`;
      const reversalKey = `reversion:${originalKey}`;
      if (existingSourceKeys.has(reversalKey)) {
        alreadyReversed.push({ movementId: original.movementId, itemId: original.itemId });
        return;
      }
      reversalMovements.push({
        itemId: original.itemId,
        tipo: "reversion",
        cantidadBase: original.cantidadBase,
        costoUnitario: original.costoUnitario,
        locationId: original.locationId,
        lotId: original.lotId || "",
        origen: `Reversión de ${original.tipo === "venta" ? "venta directa" : "consumo por servicio"}`,
        sourceId: invoiceId,
        sourceKey: reversalKey,
        motivo: reason,
        usuario: actor,
        originalMovementId: original.movementId,
        auditEvent: original.tipo === "venta" ? "retail_product_sale_reversed" : "service_inventory_reversed",
      });
    });

    return { reversalMovements, alreadyReversed, blockingErrors: [], allowed: true };
  }

  // Diferencial de inventario entre dos snapshots de una factura (antes y
  // despues de editarla). Identifica solo lo que cambio: nunca repite todos
  // los consumos/salidas ni recalcula costos historicos ya aplicados.
  // Bloquea la edicion (allowed=false) cuando una linea disminuye pero no
  // se puede ubicar el movimiento original que habria que revertir.
  function calculateInvoiceInventoryDelta({ previousSnapshot = {}, nextSnapshot = {}, existingInventoryMovements = [] } = {}) {
    const validationErrors = [];
    const productReturns = [];
    const productAdditionalOutputs = [];
    const serviceConsumptionReturns = [];
    const serviceAdditionalConsumption = [];
    const movements = Array.isArray(existingInventoryMovements) ? existingInventoryMovements : [];

    const prevProducts = new Map((previousSnapshot.productLines || []).map((l) => [l.detalleID || l.itemId, l]));
    const nextProducts = new Map((nextSnapshot.productLines || []).map((l) => [l.detalleID || l.itemId, l]));
    const productKeys = new Set([...prevProducts.keys(), ...nextProducts.keys()]);
    productKeys.forEach((key) => {
      const prev = prevProducts.get(key);
      const next = nextProducts.get(key);
      const prevQty = Math.max(0, sanitizeAmount(prev?.quantity));
      const nextQty = Math.max(0, sanitizeAmount(next?.quantity));
      if (nextQty < prevQty) {
        const decrease = roundMoney(prevQty - nextQty);
        const hasMovement = !prev?.sourceKey || movements.some((m) => m.sourceKey === prev.sourceKey);
        if (prev?.sourceKey && !hasMovement) {
          validationErrors.push(`No se encontró el movimiento original de ${prev.itemId} para revertir la disminución.`);
          return;
        }
        productReturns.push({ itemId: prev.itemId, quantity: decrease, locationId: prev.locationId, lotId: prev.lotId, sourceKey: prev.sourceKey });
      } else if (nextQty > prevQty) {
        productAdditionalOutputs.push({ itemId: (next || prev).itemId, quantity: roundMoney(nextQty - prevQty), locationId: next?.locationId || prev?.locationId });
      }
    });

    const prevServices = new Map((previousSnapshot.serviceLines || []).map((l) => [l.detalleID, l]));
    const nextServices = new Map((nextSnapshot.serviceLines || []).map((l) => [l.detalleID, l]));
    const serviceKeys = new Set([...prevServices.keys(), ...nextServices.keys()]);
    serviceKeys.forEach((key) => {
      const prev = prevServices.get(key);
      const next = nextServices.get(key);
      const prevQty = Math.max(0, sanitizeAmount(prev?.cantidad));
      const nextQty = Math.max(0, sanitizeAmount(next?.cantidad));
      if (prev && !next) {
        serviceConsumptionReturns.push({ detalleID: key, servicio: prev.servicio, quantity: prevQty });
      } else if (prev && next && nextQty < prevQty) {
        serviceConsumptionReturns.push({ detalleID: key, servicio: prev.servicio, quantity: roundMoney(prevQty - nextQty) });
      } else if (!prev && next) {
        serviceAdditionalConsumption.push({ detalleID: key, servicio: next.servicio, quantity: nextQty });
      } else if (prev && next && nextQty > prevQty) {
        serviceAdditionalConsumption.push({ detalleID: key, servicio: next.servicio, quantity: roundMoney(nextQty - prevQty) });
      }
    });

    return {
      productReturns,
      productAdditionalOutputs,
      serviceConsumptionReturns,
      serviceAdditionalConsumption,
      validationErrors,
      allowed: validationErrors.length === 0,
    };
  }

  // Concilia UN articulo en UNA mesa/periodo: saldo inicial + entregas -
  // devoluciones - saldo fisico = consumo observado. Compara contra el
  // consumo esperado (fichas tecnicas de los servicios realizados) y
  // devuelve la variacion en cantidad, porcentaje y costo. Funcion pura:
  // no decide el estado de la auditoria (eso es responsabilidad de
  // app.js/la interfaz), solo calcula.
  function calculateStationInventoryAuditLine({
    openingBalance = 0,
    deliveries = 0,
    returns = 0,
    physicalCount = 0,
    expectedConsumption = 0,
    unitCost = 0,
  } = {}) {
    const opening = sanitizeAmount(openingBalance);
    const delivered = sanitizeAmount(deliveries);
    const returned = sanitizeAmount(returns);
    const physical = sanitizeAmount(physicalCount);
    const expected = sanitizeAmount(expectedConsumption);
    const observedConsumption = roundMoney(opening + delivered - returned - physical);
    const varianceQuantity = roundMoney(observedConsumption - expected);
    const variancePercent = expected !== 0 ? roundMoney((varianceQuantity / Math.abs(expected)) * 100) : (varianceQuantity !== 0 ? 100 : 0);
    const varianceCost = roundMoney(varianceQuantity * Math.max(0, sanitizeAmount(unitCost)));
    return {
      openingBalance: opening,
      deliveries: delivered,
      returns: returned,
      physicalCount: physical,
      observedConsumption,
      expectedConsumption: expected,
      varianceQuantity,
      variancePercent,
      varianceCost,
    };
  }

  // Agrega el consumo esperado por mesa a partir de las lineas de servicio
  // de facturas del periodo (usa la ficha tecnica vigente de cada
  // servicio). Una linea sin mesa asignada NUNCA se asigna silenciosamente
  // a otra mesa: se reporta aparte para conciliacion administrativa. Una
  // mesa compartida por varias colaboradoras simplemente acumula todas sus
  // lineas en el mismo bucket (la variacion se explica despues por
  // colaboradora usando las lineas originales, no aqui).
  function aggregateExpectedServiceConsumptionByStation({ serviceLines = [], recipesByService = {} } = {}) {
    const byStation = new Map();
    const withoutStation = [];
    (Array.isArray(serviceLines) ? serviceLines : []).forEach((line) => {
      const stationId = line?.stationId || line?.mesaId || "";
      const recipeLines = recipesByService[line?.servicio] || [];
      const qty = Math.max(0, sanitizeAmount(line?.cantidad));
      if (!stationId) {
        withoutStation.push({ detalleID: line?.detalleID, servicio: line?.servicio, cantidad: qty });
        return;
      }
      const bucket = byStation.get(stationId) || { stationId, items: new Map() };
      recipeLines.forEach((recipe) => {
        if (recipe.reutilizable || recipe.activoFijo || recipe.puedeConsumirse === false || !recipe.itemId) return;
        const needed = roundMoney(Math.max(0, sanitizeAmount(recipe.cantidadEstimada)) * qty);
        const current = bucket.items.get(recipe.itemId) || 0;
        bucket.items.set(recipe.itemId, roundMoney(current + needed));
      });
      byStation.set(stationId, bucket);
    });
    const stations = [...byStation.values()].map((bucket) => ({
      stationId: bucket.stationId,
      items: [...bucket.items.entries()].map(([itemId, quantity]) => ({ itemId, quantity })),
    }));
    return { stations, withoutStation };
  }

  // Costo directo esperado de UN servicio segun su ficha tecnica: solo
  // materiales consumibles (el llamador ya excluye activos/herramientas
  // reutilizables al construir recipeLines; esta funcion tambien los
  // filtra por seguridad).
  function calculateServiceDirectCost({ recipeLines = [], unitCostByItemId = {} } = {}) {
    const cost = (Array.isArray(recipeLines) ? recipeLines : []).reduce((sum, line) => {
      if (line.reutilizable || line.activoFijo || line.puedeConsumirse === false) return sum;
      const qty = Math.max(0, sanitizeAmount(line.cantidadEstimada));
      const unitCost = Math.max(0, sanitizeAmount(unitCostByItemId[line.itemId]));
      return sum + qty * unitCost;
    }, 0);
    return roundMoney(cost);
  }

  // Margen directo = precio neto del servicio - costo directo de
  // materiales consumibles. Nunca incluye mano de obra, comision, propina,
  // TSS, alquiler, electricidad, depreciacion ni gastos generales.
  function calculateDirectMargin({ netPrice = 0, directCost = 0 } = {}) {
    const price = sanitizeAmount(netPrice);
    const cost = sanitizeAmount(directCost);
    const marginAmount = roundMoney(price - cost);
    const marginPercent = price > 0 ? roundMoney((marginAmount / price) * 100) : 0;
    return { marginAmount, marginPercent };
  }

  // Margen bruto de UN producto vendido: precio neto de impuesto - costo
  // historico congelado al momento de la venta (nunca el costo promedio
  // actual, para no reescribir ventas pasadas).
  function calculateProductMargin({ netUnitPrice = 0, historicalUnitCost = 0, quantity = 1 } = {}) {
    const price = sanitizeAmount(netUnitPrice);
    const cost = sanitizeAmount(historicalUnitCost);
    const qty = Math.max(0, sanitizeAmount(quantity));
    const marginAmount = roundMoney((price - cost) * qty);
    const marginPercent = price > 0 ? roundMoney(((price - cost) / price) * 100) : 0;
    return { marginAmount, marginPercent };
  }

  // Resumen fiscal GENERICO de las lineas de un documento (factura de
  // servicios O venta de productos, nunca ambos combinados en el mismo
  // documento: esa decision de "sin factura mixta" es de app.js/la interfaz,
  // esta funcion solo suma linea por linea via splitInvoiceLineTax, nunca
  // una tasa global hardcodeada). La propina y la deuda anterior son
  // informativas: se suman DESPUES de la base+impuesto y nunca alteran la
  // base imponible ni el total legal del documento. Antes se llamaba
  // summarizeMixedInvoiceLines; se renombro cuando se descarto la factura
  // mixta, pero el calculo linea por linea (line.lineType "servicio"/
  // "producto") sigue siendo util para ambos documentos por separado.
  function summarizeTaxableDocumentLines({ lines = [], tip = 0, priorDebt = 0 } = {}) {
    const summary = {
      servicesExempt: 0,
      servicesTaxed: 0,
      productsExempt: 0,
      productsTaxed: 0,
      taxableBase: 0,
      taxAmount: 0,
      discountTotal: 0,
      tip: roundMoney(sanitizeAmount(tip)),
      invoiceTotal: 0,
      priorDebt: roundMoney(sanitizeAmount(priorDebt)),
      grandTotalDueToday: 0,
    };
    (Array.isArray(lines) ? lines : []).forEach((line) => {
      const amount = Math.max(0, sanitizeAmount(line.subtotal) - sanitizeAmount(line.discount));
      const split = splitInvoiceLineTax({
        amount,
        taxable: Boolean(line.taxable),
        taxRate: Number(line.taxRate) || 0,
        priceIncludesTax: Boolean(line.priceIncludesTax),
      });
      summary.discountTotal = roundMoney(summary.discountTotal + sanitizeAmount(line.discount));
      summary.taxableBase = roundMoney(summary.taxableBase + split.baseAmount);
      summary.taxAmount = roundMoney(summary.taxAmount + split.taxAmount);
      summary.invoiceTotal = roundMoney(summary.invoiceTotal + split.totalAmount);
      const isProduct = line.lineType === "producto";
      if (isProduct && line.taxable) summary.productsTaxed = roundMoney(summary.productsTaxed + split.totalAmount);
      else if (isProduct) summary.productsExempt = roundMoney(summary.productsExempt + split.totalAmount);
      else if (line.taxable) summary.servicesTaxed = roundMoney(summary.servicesTaxed + split.totalAmount);
      else summary.servicesExempt = roundMoney(summary.servicesExempt + split.totalAmount);
    });
    summary.invoiceTotal = roundMoney(summary.invoiceTotal + summary.tip);
    summary.grandTotalDueToday = roundMoney(summary.invoiceTotal + summary.priorDebt);
    return summary;
  }

  // Prevalidacion COMPLETA de una venta de productos (Ventas de productos,
  // modulo separado de Facturacion de servicios) ANTES de persistir nada:
  // nunca lee el DOM, nunca escribe inventario/CxC/ingreso/auditoria. Solo
  // dice que se necesita, que hay disponible, que falta y si la operacion
  // queda permitida. Selecciona lote FEFO cuando el articulo tiene lotes
  // registrados (items[].lots); un articulo sin lotes se trata como un
  // unico lote sin vencimiento (compatibilidad con el inventario actual,
  // que todavia no tiene lotes reales) para no inventar bloqueos donde
  // nunca existieron.
  // locationId por linea (julio 2026): una venta ya NO esta atada a una
  // unica estanteria global. Cuando una linea trae locationId, la
  // existencia se lee EXCLUSIVAMENTE de inventoryByLocation[`${itemId}:${locationId}`]
  // y la ubicacion debe existir, estar activa y tener permiteVenta=true (sin
  // respaldo automatico a otra ubicacion). Una linea SIN locationId conserva
  // el comportamiento historico (shelfInventory[itemId]), para no romper
  // llamadores/pruebas existentes que todavia no seleccionan ubicacion.
  function preflightRetailProductSale({
    lines = [],
    items = [],
    shelfInventory = {},
    inventoryByLocation = {},
    locations = [],
    lots = {},
    existingSourceKeys = [],
    sourceKey = "",
    referenceDate = "",
  } = {}) {
    const itemById = new Map((Array.isArray(items) ? items : []).map((item) => [item.itemId, item]));
    const locationById = new Map((Array.isArray(locations) ? locations : []).map((location) => [location.locationId, location]));
    const blockingErrors = [];
    const warnings = [];
    const shortages = [];
    const invalidTaxConfigurations = [];
    const normalizedLines = [];
    const stockPlan = [];
    const selectedLots = [];

    const duplicate = Boolean(sourceKey) && (Array.isArray(existingSourceKeys) ? existingSourceKeys : []).includes(sourceKey);
    if (duplicate) blockingErrors.push("Esta venta ya fue registrada antes (sourceKey duplicado).");

    let subtotalExempt = 0;
    let subtotalTaxable = 0;
    let taxableBase = 0;
    let taxAmount = 0;
    let discounts = 0;
    let total = 0;
    let historicalCost = 0;

    (Array.isArray(lines) ? lines : []).forEach((line, index) => {
      const item = itemById.get(line.itemId);
      const quantity = Math.max(0, sanitizeAmount(line.quantity));
      const unitPrice = Math.max(0, sanitizeAmount(line.unitPrice));
      const discount = Math.max(0, sanitizeAmount(line.discount));
      if (!item) {
        blockingErrors.push(`Artículo no encontrado (línea ${index + 1}).`);
        return;
      }
      if (item.puedeVenderse === false) {
        blockingErrors.push(`"${item.nombre || item.itemId}" no está disponible para venta.`);
        return;
      }
      if (quantity <= 0) {
        blockingErrors.push(`Cantidad inválida para "${item.nombre || item.itemId}".`);
        return;
      }
      const taxable = Boolean(item.taxable);
      const taxRate = Math.max(0, sanitizeAmount(item.taxRate));
      if (taxable && taxRate <= 0) {
        invalidTaxConfigurations.push({ itemId: item.itemId, reason: "sin_tasa" });
      }

      const grossAmount = Math.max(0, roundMoney(quantity * unitPrice - discount));
      const split = splitInvoiceLineTax({ amount: grossAmount, taxable, taxRate, priceIncludesTax: Boolean(item.priceIncludesTax) });

      // Ubicacion de salida: explicita por linea (nunca respaldo automatico)
      // o, por compatibilidad historica, la estanteria global implicita en
      // shelfInventory cuando la linea no trae locationId.
      const requestedLocationId = line.locationId || "";
      let selectedLocationName = "";
      let available = 0;
      if (requestedLocationId) {
        const location = locationById.get(requestedLocationId);
        if (!location) {
          blockingErrors.push(`Ubicación no encontrada para "${item.nombre || item.itemId}".`);
          return;
        }
        if (location.activa === false) {
          blockingErrors.push(`La ubicación "${location.nombre || requestedLocationId}" está inactiva.`);
          return;
        }
        if (location.permiteVenta !== true) {
          blockingErrors.push(`La ubicación "${location.nombre || requestedLocationId}" no está habilitada para venta.`);
          return;
        }
        selectedLocationName = location.nombre || "";
        available = Math.max(0, sanitizeAmount(inventoryByLocation[`${item.itemId}:${requestedLocationId}`]));
      } else {
        available = Math.max(0, sanitizeAmount(shelfInventory[item.itemId]));
      }
      const itemLots = Array.isArray(lots[item.itemId]) && lots[item.itemId].length
        ? lots[item.itemId]
        : [{ lotId: "", quantity: available, fechaVencimiento: "", fechaEntrada: "" }];
      const fefo = allocateFEFO({ lots: itemLots, quantityNeeded: quantity, referenceDate });
      if (fefo.unallocated > 0) {
        shortages.push({ itemId: item.itemId, locationId: requestedLocationId, needed: quantity, available: roundMoney(quantity - fefo.unallocated), shortfall: fefo.unallocated });
        blockingErrors.push(`Existencia insuficiente de "${item.nombre || item.itemId}"${selectedLocationName ? ` en ${selectedLocationName}` : " en estantería"}: faltan ${fefo.unallocated}.`);
      }
      fefo.allocations.forEach((allocation) => {
        selectedLots.push({ itemId: item.itemId, lotId: allocation.lotId, quantity: allocation.quantityTaken });
      });

      const unitCost = Math.max(0, sanitizeAmount(item.historicalUnitCost ?? item.costoPromedio ?? item.costo));
      const totalHistoricalCost = roundMoney(unitCost * quantity);
      const margin = calculateProductMargin({ netUnitPrice: split.baseAmount > 0 ? split.baseAmount / Math.max(quantity, 1) : 0, historicalUnitCost: unitCost, quantity });

      normalizedLines.push({
        itemId: item.itemId,
        sku: item.sku || "",
        descripcion: item.nombre || item.itemId,
        cantidad: quantity,
        unidad: item.unidad || item.unidadBase || "",
        precioUnitario: unitPrice,
        descuento: discount,
        subtotal: grossAmount,
        taxCategory: item.taxCategory || (taxable ? "Gravado" : "Exento"),
        taxRateId: item.taxRateId || "",
        taxRate,
        priceIncludesTax: Boolean(item.priceIncludesTax),
        taxableBase: split.baseAmount,
        taxAmount: split.taxAmount,
        total: split.totalAmount,
        shelfLocationId: item.shelfLocationId || "",
        selectedLocationId: requestedLocationId,
        selectedLocationName,
        availableStock: available,
        lotAllocations: fefo.allocations,
        historicalUnitCost: unitCost,
        totalHistoricalCost,
        grossMargin: margin.marginAmount,
        grossMarginPercentage: margin.marginPercent,
      });
      stockPlan.push({ itemId: item.itemId, locationId: requestedLocationId, quantity, lotAllocations: fefo.allocations });

      discounts = roundMoney(discounts + discount);
      taxableBase = roundMoney(taxableBase + split.baseAmount);
      taxAmount = roundMoney(taxAmount + split.taxAmount);
      total = roundMoney(total + split.totalAmount);
      historicalCost = roundMoney(historicalCost + totalHistoricalCost);
      if (taxable) subtotalTaxable = roundMoney(subtotalTaxable + split.totalAmount);
      else subtotalExempt = roundMoney(subtotalExempt + split.totalAmount);
    });

    const grossMargin = roundMoney(taxableBase - historicalCost);
    const allowed = blockingErrors.length === 0 && normalizedLines.length > 0;

    return {
      normalizedLines,
      stockPlan,
      selectedLots,
      subtotalExempt,
      subtotalTaxable,
      taxableBase,
      taxAmount,
      discounts,
      total,
      historicalCost,
      grossMargin,
      shortages,
      invalidTaxConfigurations,
      duplicate,
      blockingErrors,
      warnings,
      allowed,
    };
  }

  // ===========================================================================
  // Almacen de Academia, salidas internas y auditoria de mesas/Academia
  // (julio 2026). Funciones puras: no leen DOM, no persisten, no crean
  // egreso/CxC/auditoria por si mismas. app.js decide que hacer con el
  // resultado.
  // ===========================================================================

  // Todo destino interno normalizado (seccion 16): nunca se permite una
  // salida interna sin destino conocido.
  const INTERNAL_ISSUE_DESTINATION_TYPES = new Set([
    "station",
    "collaborator",
    "general_area",
    "asset",
    "academy",
    "maintenance",
    "loss",
    "damage",
    "expiration",
    "quarantine",
    "supplier_return",
    "other",
  ]);

  // Prevalidacion COMPLETA de una salida interna de inventario (entrega a
  // colaboradora, consumo general del centro, consumo de activo,
  // mantenimiento, perdida/dano/vencimiento/cuarentena/devolucion a
  // suplidor/otro). Nunca vende, nunca genera egreso ni CxC: solo dice que
  // se necesita, que hay disponible y si la operacion queda permitida.
  // Bloquea sin destino y sin responsable (seccion 16: "no permitir salida
  // interna sin destino").
  function preflightInternalInventoryIssue({
    lines = [],
    sourceLocation = null,
    destinationType = "",
    destinationId = "",
    destinationName = "",
    responsiblePersonId = "",
    responsiblePersonName = "",
    inventory = {},
    lots = {},
    negativeStockPolicy = () => false,
    existingSourceKeys = [],
    sourceKey = "",
    referenceDate = "",
  } = {}) {
    const blockingErrors = [];
    const warnings = [];
    const shortages = [];
    const normalizedLines = [];
    const selectedLots = [];
    const movementPlan = [];
    let historicalCost = 0;

    if (!sourceLocation || !sourceLocation.locationId) {
      blockingErrors.push("Selecciona la ubicación de origen de la salida interna.");
    } else if (sourceLocation.activa === false) {
      blockingErrors.push(`La ubicación "${sourceLocation.nombre || sourceLocation.locationId}" está inactiva.`);
    }

    if (!INTERNAL_ISSUE_DESTINATION_TYPES.has(destinationType)) {
      blockingErrors.push(`Destino de salida interna inválido o no especificado: "${destinationType || "(vacío)"}".`);
    }
    if (!destinationId && !destinationName) {
      blockingErrors.push("Toda salida interna debe identificar un destino.");
    }
    if (!responsiblePersonId) {
      blockingErrors.push("Toda salida interna debe identificar un responsable.");
    }

    const duplicate = Boolean(sourceKey) && (Array.isArray(existingSourceKeys) ? existingSourceKeys : []).includes(sourceKey);
    if (duplicate) blockingErrors.push("Esta salida interna ya fue registrada antes (sourceKey duplicado).");

    (Array.isArray(lines) ? lines : []).forEach((line, index) => {
      const itemId = line?.itemId || "";
      const quantity = Math.max(0, sanitizeAmount(line?.quantity));
      if (!itemId) {
        blockingErrors.push(`Artículo no especificado (línea ${index + 1}).`);
        return;
      }
      if (quantity <= 0) {
        blockingErrors.push(`Cantidad inválida para "${itemId}".`);
        return;
      }
      const available = Math.max(0, sanitizeAmount(inventory[itemId]));
      const itemLots = Array.isArray(lots[itemId]) && lots[itemId].length
        ? lots[itemId]
        : [{ lotId: "", quantity: available, fechaVencimiento: "", fechaEntrada: "" }];
      const fefo = allocateFEFO({ lots: itemLots, quantityNeeded: quantity, referenceDate });
      const negativeAllowed = Boolean(negativeStockPolicy(itemId));
      if (fefo.unallocated > 0 && !negativeAllowed) {
        shortages.push({ itemId, needed: quantity, available: roundMoney(quantity - fefo.unallocated), shortfall: fefo.unallocated });
        blockingErrors.push(`Existencia insuficiente de "${itemId}": faltan ${fefo.unallocated}.`);
      }
      fefo.allocations.forEach((allocation) => selectedLots.push({ itemId, lotId: allocation.lotId, quantity: allocation.quantityTaken }));
      const unitCost = Math.max(0, sanitizeAmount(line?.historicalUnitCost));
      const totalCost = roundMoney(unitCost * quantity);
      historicalCost = roundMoney(historicalCost + totalCost);
      normalizedLines.push({ itemId, quantity, unitCost, totalCost, lotAllocations: fefo.allocations });
      movementPlan.push({ itemId, quantity, unitCost, lotAllocations: fefo.allocations, allowNegativeStock: negativeAllowed });
    });

    const allowed = blockingErrors.length === 0 && normalizedLines.length > 0;
    return {
      normalizedLines,
      destination: { destinationType, destinationId, destinationName, responsiblePersonId, responsiblePersonName },
      movementPlan,
      selectedLots,
      historicalCost,
      shortages,
      duplicate,
      blockingErrors,
      warnings,
      allowed,
    };
  }

  // Prevalidacion COMPLETA de un consumo del Almacen de la Academia (clase,
  // practica, taller, demostracion, evaluacion, uso administrativo, otro).
  // Nunca mezcla con el consumo del salon: usa exclusivamente el inventario
  // de esta ubicacion (academyInventory), pasado por el llamador.
  function preflightAcademyInventoryConsumption({
    lines = [],
    academyInventory = {},
    lots = {},
    existingSourceKeys = [],
    sourceKey = "",
    referenceDate = "",
  } = {}) {
    const blockingErrors = [];
    const warnings = [];
    const shortages = [];
    const normalizedLines = [];
    const selectedLots = [];
    const stockPlan = [];
    let totalHistoricalCost = 0;

    const duplicate = Boolean(sourceKey) && (Array.isArray(existingSourceKeys) ? existingSourceKeys : []).includes(sourceKey);
    if (duplicate) blockingErrors.push("Este consumo de Academia ya fue registrado antes (sourceKey duplicado).");

    (Array.isArray(lines) ? lines : []).forEach((line, index) => {
      const itemId = line?.itemId || "";
      const quantity = Math.max(0, sanitizeAmount(line?.quantity));
      if (!itemId) {
        blockingErrors.push(`Artículo no especificado (línea ${index + 1}).`);
        return;
      }
      if (quantity <= 0) {
        blockingErrors.push(`Cantidad inválida para "${itemId}".`);
        return;
      }
      const available = Math.max(0, sanitizeAmount(academyInventory[itemId]));
      const itemLots = Array.isArray(lots[itemId]) && lots[itemId].length
        ? lots[itemId]
        : [{ lotId: "", quantity: available, fechaVencimiento: "", fechaEntrada: "" }];
      const fefo = allocateFEFO({ lots: itemLots, quantityNeeded: quantity, referenceDate });
      if (fefo.unallocated > 0) {
        shortages.push({ itemId, needed: quantity, available: roundMoney(quantity - fefo.unallocated), shortfall: fefo.unallocated });
        blockingErrors.push(`Existencia insuficiente de "${itemId}" en Almacén de la Academia: faltan ${fefo.unallocated}.`);
      }
      fefo.allocations.forEach((allocation) => selectedLots.push({ itemId, lotId: allocation.lotId, quantity: allocation.quantityTaken }));
      const unitCost = Math.max(0, sanitizeAmount(line?.historicalUnitCost));
      const totalCost = roundMoney(unitCost * quantity);
      totalHistoricalCost = roundMoney(totalHistoricalCost + totalCost);
      normalizedLines.push({
        itemId,
        quantity,
        unitCost,
        totalCost,
        activityType: line?.activityType || "",
        courseId: line?.courseId || "",
        classId: line?.classId || "",
        courseName: line?.courseName || line?.className || "",
        instructorId: line?.instructorId || "",
        instructorName: line?.instructorName || "",
        groupReference: line?.groupReference || "",
        participantCount: Math.max(0, sanitizeAmount(line?.participantCount)),
        lotAllocations: fefo.allocations,
      });
      stockPlan.push({ itemId, quantity, lotAllocations: fefo.allocations });
    });

    const allowed = blockingErrors.length === 0 && normalizedLines.length > 0;
    return { normalizedLines, stockPlan, selectedLots, totalHistoricalCost, shortages, duplicate, blockingErrors, warnings, allowed };
  }

  // Clasifica UNA variacion de auditoria (mesa o Academia) ya calculada por
  // calculateStationInventoryAuditLine. Nunca decide sanciones ni ajustes:
  // solo etiqueta para justificacion/reporte. expectedConsumption=0 nunca
  // produce division por cero (variancePercent ya viene resuelto por el
  // llamador con esa misma regla).
  function classifyInventoryVarianceLine({
    varianceQuantity = 0,
    variancePercent = 0,
    expectedConsumption = 0,
    tolerancePercent = 0,
    expectedKnown = true,
  } = {}) {
    const variance = sanitizeAmount(varianceQuantity);
    const expected = sanitizeAmount(expectedConsumption);
    const tolerance = Math.max(0, sanitizeAmount(tolerancePercent));
    if (!expectedKnown) return "missing_information";
    if (!Number.isFinite(variancePercent)) return "requires_review";
    if (expected === 0 && variance !== 0) return "no_expected_consumption";
    if (Math.abs(variancePercent) <= tolerance) return "within_tolerance";
    if (variance > 0) return "higher_consumption";
    if (variance < 0) return "lower_consumption";
    return "within_tolerance";
  }

  // Maquina de estados de una auditoria de mesa/Academia (seccion 18):
  // Abierta -> En revision -> Justificada -> Confirmada -> Revertida. Nunca
  // permite saltar pasos ni retroceder salvo Confirmada -> Revertida.
  const INVENTORY_AUDIT_TRANSITIONS = {
    Abierta: ["En revisión"],
    "En revisión": ["Justificada"],
    Justificada: ["Confirmada"],
    Confirmada: ["Revertida"],
    Revertida: [],
  };
  function canTransitionInventoryAuditStatus(currentStatus, nextStatus) {
    const allowed = INVENTORY_AUDIT_TRANSITIONS[currentStatus] || [];
    return allowed.includes(nextStatus);
  }

  // Arma el plan de ajustes de UNA auditoria Justificada al confirmarla.
  // Nunca genera un ajuste para variacion cero; nunca duplica un ajuste ya
  // aplicado (sourceKey estable ajuste:<auditId>:<itemId>, idempotente por
  // construccion). observedConsumption > expectedConsumption implica que el
  // sistema debe reconocer una salida adicional (ajuste_negativo); lo
  // contrario implica una entrada de ajuste (ajuste_positivo).
  function buildInventoryAuditAdjustmentPlan({ auditId = "", varianceLines = [], existingSourceKeys = [] } = {}) {
    const blockingErrors = [];
    if (!auditId) blockingErrors.push("Falta el identificador de la auditoría para generar ajustes.");
    const movementPlan = [];
    (Array.isArray(varianceLines) ? varianceLines : []).forEach((line) => {
      const quantity = sanitizeAmount(line?.varianceQuantity);
      if (!line?.itemId || quantity === 0) return;
      const lineSourceKey = `ajuste:${auditId}:${line.itemId}`;
      const duplicate = (Array.isArray(existingSourceKeys) ? existingSourceKeys : []).includes(lineSourceKey);
      if (duplicate) return;
      movementPlan.push({
        itemId: line.itemId,
        locationId: line.locationId || "",
        quantity: roundMoney(Math.abs(quantity)),
        tipo: quantity > 0 ? "ajuste_negativo" : "ajuste_positivo",
        unitCost: Math.max(0, sanitizeAmount(line.unitCost)),
        sourceKey: lineSourceKey,
      });
    });
    return { movementPlan, allowed: blockingErrors.length === 0, blockingErrors };
  }

  // Arma el plan de reversion de los ajustes de UNA auditoria Confirmada.
  // Nunca revierte dos veces el mismo ajuste (sourceKey estable
  // reversion:ajuste:<auditId>:<itemId>) y nunca genera negativos nuevos:
  // simplemente invierte la direccion de cada ajuste ya aplicado.
  function buildInventoryAuditReversalPlan({ auditId = "", appliedAdjustments = [], existingSourceKeys = [] } = {}) {
    const blockingErrors = [];
    if (!auditId) blockingErrors.push("Falta el identificador de la auditoría para revertir sus ajustes.");
    const movementPlan = [];
    (Array.isArray(appliedAdjustments) ? appliedAdjustments : []).forEach((adjustment) => {
      if (!adjustment?.itemId || !adjustment?.sourceKey) return;
      const reversalKey = `reversion:${adjustment.sourceKey}`;
      const duplicate = (Array.isArray(existingSourceKeys) ? existingSourceKeys : []).includes(reversalKey);
      if (duplicate) return;
      movementPlan.push({
        itemId: adjustment.itemId,
        locationId: adjustment.locationId || "",
        quantity: roundMoney(Math.abs(sanitizeAmount(adjustment.quantity))),
        tipo: adjustment.tipo === "ajuste_negativo" ? "ajuste_positivo" : "ajuste_negativo",
        unitCost: Math.max(0, sanitizeAmount(adjustment.unitCost)),
        sourceKey: reversalKey,
        originalSourceKey: adjustment.sourceKey,
      });
    });
    return { movementPlan, allowed: blockingErrors.length === 0, blockingErrors };
  }

  // ===========================================================================
  // Fase "Cerrar reportes alertas y auditoria por colaboradora" (julio 2026).
  // Funciones puras nuevas: consolidacion de auditoria de inventario por
  // colaboradora, distribucion administrativa OPCIONAL de variacion
  // compartida, minimos/reposicion por mesa, clasificacion de vencimiento de
  // lotes, FEFO multi-articulo, y evaluacion de reglas de consumo anormal de
  // activos. Ninguna de estas funciones lee DOM ni persiste nada.
  // ===========================================================================

  // true si [aStart,aEnd] y [bStart,bEnd] se solapan; un rango vacio de
  // cualquiera de los dos lados se trata como "sin filtro" (coincide con
  // todo), nunca como "no hay match".
  function periodsOverlap(aStart, aEnd, bStart, bEnd) {
    if (!aStart || !aEnd) return true;
    if (!bStart || !bEnd) return true;
    return aStart <= bEnd && aEnd >= bStart;
  }

  // Consolida auditoriasMesa + lineas de servicio + entregas directas +
  // salidas de area general por colaboradora, SIN atribuir jamas de forma
  // automatica el consumo de una mesa compartida (collaboratorIds.length>1)
  // a una sola persona: esas mesas quedan en sharedStationSummaries con su
  // variacion como valor UNICO compartido. "Consumo esperado/observado/
  // declarado/variacion" por colaboradora solo se suma de sus mesas
  // INDIVIDUALES (una sola colaboradora en collaboratorIds), tomando los
  // numeros ya calculados por calculateStationInventoryAuditLine (no se
  // recalculan aqui con fichas tecnicas, para no duplicar
  // aggregateExpectedServiceConsumptionByStation). serviceLines solo aporta
  // conteo de servicios realizados y deteccion de consumo sin asignar
  // (linea sin mesa o sin colaboradora); nunca se usa para inventar un
  // consumo esperado por colaboradora en mesa compartida.
  function aggregateInventoryAuditByCollaborator({
    stationAudits = [],
    serviceLines = [],
    directDeliveries = [],
    internalIssues = [],
    periodStart = "",
    periodEnd = "",
  } = {}) {
    const validationErrors = [];
    const warnings = [];
    if (periodStart && periodEnd && periodStart > periodEnd) {
      validationErrors.push("El período inicial no puede ser posterior al período final.");
      return { collaboratorSummaries: [], sharedStationSummaries: [], unassignedConsumption: [], totals: {}, warnings, validationErrors };
    }

    const collaborators = new Map();
    function touchCollaborator(id, name) {
      if (!id) return;
      const existing = collaborators.get(id);
      if (!existing) collaborators.set(id, { collaboratorId: id, collaboratorName: name || "" });
      else if (!existing.collaboratorName && name) existing.collaboratorName = name;
    }

    const individualStationsByCollaborator = new Map();
    const sharedStationsByCollaborator = new Map();
    const sharedStationSummaries = [];
    const unassignedConsumption = [];
    const seenAuditIds = new Set();

    (Array.isArray(stationAudits) ? stationAudits : []).forEach((audit) => {
      if (!audit || !audit.stationAuditId || seenAuditIds.has(audit.stationAuditId)) return;
      seenAuditIds.add(audit.stationAuditId);
      if (!periodsOverlap(periodStart, periodEnd, audit.periodStart, audit.periodEnd)) return;

      const ids = Array.isArray(audit.collaboratorIds) ? audit.collaboratorIds.filter(Boolean) : [];
      const names = Array.isArray(audit.collaboratorNames) ? audit.collaboratorNames : [];
      const lines = Array.isArray(audit.varianceLines) ? audit.varianceLines : [];
      const expected = roundMoney(lines.reduce((sum, l) => sum + sanitizeAmount(l.expectedConsumption), 0));
      const observed = roundMoney(lines.reduce((sum, l) => sum + sanitizeAmount(l.observedConsumption), 0));
      const declared = roundMoney(lines.reduce((sum, l) => sum + sanitizeAmount(l.declaredActual), 0));
      const varianceQuantity = roundMoney(lines.reduce((sum, l) => sum + sanitizeAmount(l.varianceQuantity), 0));
      const varianceCost = roundMoney(lines.reduce((sum, l) => sum + sanitizeAmount(l.varianceCost), 0));
      const unexplainedCount = lines.filter((l) => l.classification !== "within_tolerance" && !(audit.explanations || {})[l.itemId]).length;

      if (ids.length === 0) {
        unassignedConsumption.push({
          source: "audit_without_collaborator",
          stationAuditId: audit.stationAuditId,
          stationId: audit.stationId || "",
          stationName: audit.stationName || "",
          varianceCost,
        });
        return;
      }

      if (ids.length === 1) {
        const collaboratorId = ids[0];
        touchCollaborator(collaboratorId, names[0]);
        const list = individualStationsByCollaborator.get(collaboratorId) || [];
        list.push({
          stationAuditId: audit.stationAuditId,
          stationId: audit.stationId || "",
          stationName: audit.stationName || "",
          status: audit.status || "",
          periodStart: audit.periodStart || "",
          periodEnd: audit.periodEnd || "",
          expectedConsumption: expected,
          observedConsumption: observed,
          declaredConsumption: declared,
          varianceQuantity,
          varianceCost,
          unexplainedCount,
        });
        individualStationsByCollaborator.set(collaboratorId, list);
        return;
      }

      const participants = ids.map((id, idx) => ({ collaboratorId: id, collaboratorName: names[idx] || "" }));
      participants.forEach((participant) => {
        touchCollaborator(participant.collaboratorId, participant.collaboratorName);
        const list = sharedStationsByCollaborator.get(participant.collaboratorId) || [];
        list.push({
          stationAuditId: audit.stationAuditId,
          stationId: audit.stationId || "",
          stationName: audit.stationName || "",
          status: audit.status || "",
          participantCount: ids.length,
        });
        sharedStationsByCollaborator.set(participant.collaboratorId, list);
      });
      sharedStationSummaries.push({
        stationAuditId: audit.stationAuditId,
        stationId: audit.stationId || "",
        stationName: audit.stationName || "",
        status: audit.status || "",
        periodStart: audit.periodStart || "",
        periodEnd: audit.periodEnd || "",
        participants,
        sharedExpectedConsumption: expected,
        sharedObservedConsumption: observed,
        sharedDeclaredConsumption: declared,
        sharedVarianceQuantity: varianceQuantity,
        sharedVarianceCost: varianceCost,
        unexplainedCount,
        varianceLines: lines,
      });
    });

    const servicesCountByCollaborator = new Map();
    const seenServiceKeys = new Set();
    (Array.isArray(serviceLines) ? serviceLines : []).forEach((line) => {
      if (!line) return;
      const key = line.detalleID || `${line.stationId || ""}:${line.colaboradorID || ""}:${line.servicio || ""}:${line.fecha || ""}`;
      if (seenServiceKeys.has(key)) return;
      seenServiceKeys.add(key);
      if (line.fecha && !periodsOverlap(periodStart, periodEnd, line.fecha, line.fecha)) return;
      const collaboratorId = line.colaboradorID || "";
      const collaboratorName = line.colaboradorNombre || "";
      if (!collaboratorId) {
        unassignedConsumption.push({ source: "service_without_collaborator", detalleID: line.detalleID || "", servicio: line.servicio || "", stationId: line.stationId || "" });
        return;
      }
      touchCollaborator(collaboratorId, collaboratorName);
      if (!line.stationId) {
        unassignedConsumption.push({ source: "service_without_station", detalleID: line.detalleID || "", servicio: line.servicio || "", collaboratorId, collaboratorName });
      }
      servicesCountByCollaborator.set(collaboratorId, (servicesCountByCollaborator.get(collaboratorId) || 0) + 1);
    });

    const deliveriesByCollaborator = new Map();
    const seenDeliveryIds = new Set();
    (Array.isArray(directDeliveries) ? directDeliveries : []).forEach((row) => {
      if (!row) return;
      const key = row.deliveryId || `${row.itemId || ""}:${row.collaboratorId || ""}:${row.fecha || ""}`;
      if (seenDeliveryIds.has(key)) return;
      seenDeliveryIds.add(key);
      if (row.fecha && !periodsOverlap(periodStart, periodEnd, row.fecha, row.fecha)) return;
      const collaboratorId = row.collaboratorId || "";
      const quantity = sanitizeAmount(row.cantidad);
      const cost = sanitizeAmount(row.totalCost ?? sanitizeAmount(row.historicalUnitCost) * quantity);
      if (!collaboratorId) {
        unassignedConsumption.push({ source: "direct_delivery_without_collaborator", deliveryId: row.deliveryId || "", itemId: row.itemId || "", quantity, cost });
        return;
      }
      touchCollaborator(collaboratorId, row.collaboratorName);
      const list = deliveriesByCollaborator.get(collaboratorId) || [];
      list.push({ deliveryId: row.deliveryId || "", itemId: row.itemId || "", itemNombre: row.itemNombre || row.itemId || "", quantity, cost, fecha: row.fecha || "" });
      deliveriesByCollaborator.set(collaboratorId, list);
    });

    const seenInternalIds = new Set();
    (Array.isArray(internalIssues) ? internalIssues : []).forEach((row) => {
      if (!row) return;
      const key = row.internalConsumptionId || `${row.itemId || ""}:${row.fecha || ""}`;
      if (seenInternalIds.has(key)) return;
      seenInternalIds.add(key);
      if (row.fecha && !periodsOverlap(periodStart, periodEnd, row.fecha, row.fecha)) return;
      const quantity = sanitizeAmount(row.cantidad);
      const cost = sanitizeAmount(row.totalCost ?? sanitizeAmount(row.historicalUnitCost) * quantity);
      unassignedConsumption.push({ source: "internal_issue_area_general", internalConsumptionId: row.internalConsumptionId || "", itemId: row.itemId || "", destinationType: row.destinationType || "", quantity, cost });
    });

    const collaboratorSummaries = [...collaborators.values()]
      .map((c) => {
        const individualStations = individualStationsByCollaborator.get(c.collaboratorId) || [];
        const sharedStations = sharedStationsByCollaborator.get(c.collaboratorId) || [];
        const deliveries = deliveriesByCollaborator.get(c.collaboratorId) || [];
        const individualConsumption = individualStations.reduce(
          (acc, s) => ({
            expected: roundMoney(acc.expected + s.expectedConsumption),
            observed: roundMoney(acc.observed + s.observedConsumption),
            declared: roundMoney(acc.declared + s.declaredConsumption),
            varianceQuantity: roundMoney(acc.varianceQuantity + s.varianceQuantity),
            varianceCost: roundMoney(acc.varianceCost + s.varianceCost),
          }),
          { expected: 0, observed: 0, declared: 0, varianceQuantity: 0, varianceCost: 0 },
        );
        return {
          collaboratorId: c.collaboratorId,
          collaboratorName: c.collaboratorName || c.collaboratorId,
          individualStations,
          sharedStations,
          directDeliveries: deliveries,
          directDeliveriesTotalQuantity: roundMoney(deliveries.reduce((s, d) => s + d.quantity, 0)),
          directDeliveriesTotalCost: roundMoney(deliveries.reduce((s, d) => s + d.cost, 0)),
          servicesCount: servicesCountByCollaborator.get(c.collaboratorId) || 0,
          individualConsumption,
          relatedAuditIds: [...individualStations.map((s) => s.stationAuditId), ...sharedStations.map((s) => s.stationAuditId)],
        };
      })
      .sort((a, b) => a.collaboratorName.localeCompare(b.collaboratorName));

    const totals = {
      collaboratorsCount: collaboratorSummaries.length,
      individualStationsCount: [...individualStationsByCollaborator.values()].reduce((s, l) => s + l.length, 0),
      sharedStationsCount: sharedStationSummaries.length,
      totalDirectDeliveryCost: roundMoney(collaboratorSummaries.reduce((s, c) => s + c.directDeliveriesTotalCost, 0)),
      totalIndividualVarianceCost: roundMoney(collaboratorSummaries.reduce((s, c) => s + c.individualConsumption.varianceCost, 0)),
      totalSharedVarianceCost: roundMoney(sharedStationSummaries.reduce((s, r) => s + r.sharedVarianceCost, 0)),
      totalUnassignedCost: roundMoney(unassignedConsumption.reduce((s, u) => s + sanitizeAmount(u.cost ?? u.varianceCost), 0)),
    };

    if (unassignedConsumption.length) {
      warnings.push(`${unassignedConsumption.length} registro(s) de consumo sin colaboradora o mesa asignada en el período.`);
    }

    return { collaboratorSummaries, sharedStationSummaries, unassignedConsumption, totals, warnings, validationErrors };
  }

  // Distribucion administrativa OPCIONAL de la variacion de una mesa
  // COMPARTIDA (seccion 4): nunca es automatica, exige motivo + quien la
  // realiza, exige que la suma (porcentajes=100 o cantidades=variacion
  // original) sea EXACTA, y jamas crea CxC ni sancion (createsReceivable y
  // createsPenalty siempre false: no existe ningun camino de codigo que
  // genere eso a partir de esto). El valor original compartido se conserva
  // siempre en originalVarianceQuantity/originalVarianceCost.
  function allocateSharedStationVariance({
    varianceQuantity = 0,
    varianceCost = 0,
    allocations = [],
    mode = "percent",
    reason = "",
    allocatedBy = "",
  } = {}) {
    const blockingErrors = [];
    const totalVariance = sanitizeAmount(varianceQuantity);
    const totalCost = sanitizeAmount(varianceCost);
    if (!String(reason || "").trim()) blockingErrors.push("La distribución administrativa requiere un motivo/justificación.");
    if (!allocatedBy) blockingErrors.push("La distribución requiere identificar quién la realizó.");
    const list = Array.isArray(allocations) ? allocations : [];
    if (!list.length) blockingErrors.push("Debe indicar al menos una colaboradora para distribuir.");
    list.forEach((a) => {
      if (!a?.collaboratorId) blockingErrors.push("Cada distribución requiere identificar la colaboradora.");
    });

    let normalized = [];
    if (mode === "percent") {
      const totalPercent = roundMoney(list.reduce((sum, a) => sum + sanitizeAmount(a.percent), 0));
      if (Math.abs(totalPercent - 100) > 0.01) {
        blockingErrors.push(`La suma de porcentajes debe ser exactamente 100% (actual: ${totalPercent}%).`);
      }
      normalized = list.map((a) => ({
        collaboratorId: a.collaboratorId || "",
        collaboratorName: a.collaboratorName || "",
        percent: sanitizeAmount(a.percent),
        quantity: roundMoney((sanitizeAmount(a.percent) / 100) * totalVariance),
        cost: roundMoney((sanitizeAmount(a.percent) / 100) * totalCost),
      }));
    } else if (mode === "quantity") {
      const totalQuantity = roundMoney(list.reduce((sum, a) => sum + sanitizeAmount(a.quantity), 0));
      if (Math.abs(totalQuantity - totalVariance) > 0.01) {
        blockingErrors.push(`La suma de cantidades (${totalQuantity}) debe ser exactamente igual a la variación compartida (${totalVariance}).`);
      }
      normalized = list.map((a) => ({
        collaboratorId: a.collaboratorId || "",
        collaboratorName: a.collaboratorName || "",
        quantity: sanitizeAmount(a.quantity),
        percent: totalVariance !== 0 ? roundMoney((sanitizeAmount(a.quantity) / totalVariance) * 100) : 0,
        cost: totalVariance !== 0 ? roundMoney((sanitizeAmount(a.quantity) / totalVariance) * totalCost) : 0,
      }));
    } else {
      blockingErrors.push(`Modo de distribución inválido: "${mode}".`);
    }

    const allowed = blockingErrors.length === 0;
    return {
      allowed,
      blockingErrors,
      originalVarianceQuantity: totalVariance,
      originalVarianceCost: totalCost,
      allocations: allowed ? normalized : [],
      mode,
      reason: String(reason || "").trim(),
      allocatedBy,
      createsReceivable: false,
      createsPenalty: false,
    };
  }

  // Reposicion sugerida de UNA regla de minimo por mesa (seccion 6):
  // maximo entre 0 y (stock objetivo - existencia actual). Nunca sobrescribe
  // existencias ni movimientos: es un calculo de solo lectura.
  function calculateStationReplenishment({ minimumStock = 0, targetStock = 0, currentStock = 0 } = {}) {
    const minimum = Math.max(0, sanitizeAmount(minimumStock));
    const target = Math.max(0, sanitizeAmount(targetStock));
    const current = sanitizeAmount(currentStock);
    return {
      minimumStock: minimum,
      targetStock: target,
      currentStock: roundMoney(current),
      suggestedReplenishment: roundMoney(Math.max(0, target - current)),
      belowMinimum: current < minimum,
      stockedOut: current <= 0,
    };
  }

  // Clasifica el vencimiento de UN lote en 5 categorias segun 3 plazos
  // configurables (seccion 10): sin_vencimiento (articulo sin fecha),
  // vencido (dias<0), urgente (dias<=urgentAlertDays), proximo
  // (dias<=nearAlertDays O dias<=earlyAlertDays: las dos alertas "temprana"
  // y "proxima" caen en el mismo bucket de estado; la severidad fina para
  // la ALERTA se puede derivar por separado comparando daysToExpire contra
  // cada plazo), vigente (mas alla de todos los plazos). Nunca hardcodea
  // 7/30/60: los 3 plazos SIEMPRE vienen de la configuracion del llamador.
  function daysBetweenIsoDates(fromDate, toDate) {
    const from = new Date(`${fromDate}T00:00:00Z`);
    const to = new Date(`${toDate}T00:00:00Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
    return Math.round((to.getTime() - from.getTime()) / 86400000);
  }

  function classifyLotExpiration({ expirationDate = "", referenceDate = "", earlyAlertDays = 60, nearAlertDays = 30, urgentAlertDays = 7 } = {}) {
    if (!expirationDate) return { bucket: "sin_vencimiento", daysToExpire: null };
    const days = daysBetweenIsoDates(referenceDate, expirationDate);
    if (days === null) return { bucket: "sin_vencimiento", daysToExpire: null };
    const urgent = Math.max(0, sanitizeAmount(urgentAlertDays));
    const near = Math.max(urgent, sanitizeAmount(nearAlertDays));
    const early = Math.max(near, sanitizeAmount(earlyAlertDays));
    let bucket = "vigente";
    if (days < 0) bucket = "vencido";
    else if (days <= urgent) bucket = "urgente";
    else if (days <= near) bucket = "proximo";
    else if (days <= early) bucket = "proximo";
    return { bucket, daysToExpire: days };
  }

  // Estado derivado de UN lote (seccion 8): un estado manual (Cuarentena,
  // Retirado, Revertido) SIEMPRE gana sobre lo derivado (accion humana
  // explicita). Si no hay estado manual: vencido > agotado > proximo a
  // vencer > disponible. availableQuantity NUNCA se recibe como campo
  // editable aqui: el llamador la deriva de inventarioMovimientos
  // (calculateInventoryByLocation) antes de invocar esto.
  const MANUAL_LOT_STATUSES = new Set(["Cuarentena", "Retirado", "Revertido"]);
  function deriveLotStatus({ manualStatus = "", availableQuantity = 0, expirationBucket = "vigente" } = {}) {
    if (MANUAL_LOT_STATUSES.has(manualStatus)) return manualStatus;
    if (expirationBucket === "vencido") return "Vencido";
    if (sanitizeAmount(availableQuantity) <= 0) return "Agotado";
    if (expirationBucket === "urgente" || expirationBucket === "proximo") return "Próximo a vencer";
    return "Disponible";
  }

  // Un lote es apto para FEFO (seccion 9) si no esta bloqueado: SOLO
  // Vencido, Agotado y los estados manuales (Cuarentena/Retirado/Revertido)
  // bloquean venta/consumo/transferencia. "Proximo a vencer" es unicamente
  // una alerta (secciones 8/9/31): FEFO debe poder asignar esos lotes -de
  // hecho son los que FEFO deberia preferir primero por vencer antes-, nunca
  // excluirlos como si ya hubieran vencido.
  const BLOCKED_LOT_STATUSES_FOR_FEFO = new Set(["Vencido", "Agotado", "Cuarentena", "Retirado", "Revertido"]);
  function isLotAvailableForFEFO(status) {
    return !BLOCKED_LOT_STATUSES_FOR_FEFO.has(status);
  }

  // FEFO para VARIOS articulos a la vez (seccion 11): envoltorio delgado de
  // allocateFEFO reutilizado por consumo de servicio, transferencias y
  // salidas internas cuando necesitan resolver el plan de lotes de mas de
  // un articulo en una sola llamada.
  function allocateFEFOAcrossItems({ requirements = [], lotsByItem = {}, referenceDate = "" } = {}) {
    const allocationsByItem = {};
    const shortages = [];
    (Array.isArray(requirements) ? requirements : []).forEach((req) => {
      const itemId = req?.itemId || "";
      const quantityNeeded = Math.max(0, sanitizeAmount(req?.quantity));
      if (!itemId || quantityNeeded <= 0) return;
      const lots = Array.isArray(lotsByItem[itemId]) ? lotsByItem[itemId] : [];
      const fefo = allocateFEFO({ lots, quantityNeeded, referenceDate });
      allocationsByItem[itemId] = fefo.allocations;
      if (fefo.unallocated > 0) shortages.push({ itemId, needed: quantityNeeded, shortfall: fefo.unallocated });
    });
    return { allocationsByItem, shortages, allowed: shortages.length === 0 };
  }

  // Evalua UNA regla de consumo anormal de activo (seccion 12): sin regla
  // (o inactiva) NUNCA genera alerta (no se inventa una media ni se
  // bloquea el consumo). Cuando hay regla, compara cantidad y/o costo del
  // periodo contra los maximos configurados; cualquiera de los dos que se
  // supere marca exceeded=true.
  function evaluateAssetConsumptionRule({ rule = null, periodQuantity = 0, periodCost = 0 } = {}) {
    if (!rule || rule.active === false) {
      return { hasRule: false, exceeded: false, quantityExceeded: false, costExceeded: false, excessQuantity: 0, excessCost: 0 };
    }
    const hasMaxQty = rule.maximumQuantity !== "" && rule.maximumQuantity !== null && rule.maximumQuantity !== undefined;
    const hasMaxCost = rule.maximumCost !== "" && rule.maximumCost !== null && rule.maximumCost !== undefined;
    const maxQty = hasMaxQty ? Math.max(0, sanitizeAmount(rule.maximumQuantity)) : null;
    const maxCost = hasMaxCost ? Math.max(0, sanitizeAmount(rule.maximumCost)) : null;
    const qty = Math.max(0, sanitizeAmount(periodQuantity));
    const cost = Math.max(0, sanitizeAmount(periodCost));
    const quantityExceeded = maxQty !== null && qty > maxQty;
    const costExceeded = maxCost !== null && cost > maxCost;
    return {
      hasRule: true,
      exceeded: quantityExceeded || costExceeded,
      quantityExceeded,
      costExceeded,
      excessQuantity: quantityExceeded ? roundMoney(qty - maxQty) : 0,
      excessCost: costExceeded ? roundMoney(cost - maxCost) : 0,
    };
  }

  return {
    localDateStringInZone,
    nowPartsInZone,
    isAutomaticClosingEligible,
    computeExpectedCash,
    resolveRegisterOpeningCash,
    resolveTreasuryOpeningBalance,
    computeDifference,
    canConfirmClosing,
    closingIdentityKey,
    buildClosingDedupeKey,
    hasClosingForDate,
    isClosingPendingConfirmation,
    isClosingOpenForEdits,
    summarizeCollaborators,
    sumCollaboratorTotals,
    isValidIsoDate,
    canConfirmTransfer,
    closingTypeDedupeKey,
    missingClosingTypesForDate,
    normalizeLegacyClosingType,
    addDaysToIsoDate,
    pendingTreasuryRange,
    missingRegisterDatesForRange,
    buildTreasuryTotals,
    isPrivilegedRole,
    canReviewAccounts,
    computeInvoiceBreakdown,
    allocateConfirmedPayment,
    allocateClientPaymentFIFO,
    compareReceivablesFIFO,
    DEFAULT_CONFIRMED_PAYMENT_METHOD_PRIORITY,
    computeAccountDailyBalance,
    sortMovementsDeterministically,
    buildRunningBalance,
    roundMoney,
    computeBiweeklySalaryInstallment,
    payrollOrdinaryPaymentDate,
    computeTipCommissionPeriod,
    selectCommissionThreshold,
    validateCommissionThresholdRule,
    computeVacationSalaryOffset,
    compareCollaboratorReceivablesFIFO,
    applyCollaboratorReceivablesFIFO,
    calculatePayrollSettlement,
    convertToBaseQuantity,
    calculateInventoryByLocation,
    applyInventoryMovement,
    calculateWeightedAverageCost,
    compareLotsFEFO,
    allocateFEFO,
    splitInvoiceLineTax,
    preflightServiceInventoryConsumption,
    reverseInvoiceInventoryEffects,
    calculateInvoiceInventoryDelta,
    calculateStationInventoryAuditLine,
    aggregateExpectedServiceConsumptionByStation,
    calculateServiceDirectCost,
    calculateDirectMargin,
    calculateProductMargin,
    summarizeTaxableDocumentLines,
    preflightRetailProductSale,
    preflightInternalInventoryIssue,
    preflightAcademyInventoryConsumption,
    classifyInventoryVarianceLine,
    canTransitionInventoryAuditStatus,
    buildInventoryAuditAdjustmentPlan,
    buildInventoryAuditReversalPlan,
    periodsOverlap,
    aggregateInventoryAuditByCollaborator,
    allocateSharedStationVariance,
    calculateStationReplenishment,
    daysBetweenIsoDates,
    classifyLotExpiration,
    deriveLotStatus,
    isLotAvailableForFEFO,
    allocateFEFOAcrossItems,
    evaluateAssetConsumptionRule,
  };
});
