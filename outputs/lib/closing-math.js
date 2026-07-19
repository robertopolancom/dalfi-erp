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
  };
});
