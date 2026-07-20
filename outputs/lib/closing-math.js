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

  return {
    localDateStringInZone,
    nowPartsInZone,
    isAutomaticClosingEligible,
    computeExpectedCash,
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
    computeAccountDailyBalance,
    sortMovementsDeterministically,
    buildRunningBalance,
  };
});
