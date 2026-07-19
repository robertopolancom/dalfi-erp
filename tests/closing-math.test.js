const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isAutomaticClosingEligible,
  computeExpectedCash,
  computeDifference,
  canConfirmClosing,
  buildClosingDedupeKey,
  hasClosingForDate,
  isClosingPendingConfirmation,
  isClosingOpenForEdits,
  summarizeCollaborators,
  sumCollaboratorTotals,
  isValidIsoDate,
  canConfirmTransfer,
} = require("../outputs/lib/closing-math.js");

test("computeExpectedCash: suma fondo inicial mas entradas menos salidas", () => {
  assert.equal(computeExpectedCash({ montoInicial: 500, entradasEfectivo: 2000, salidasEfectivo: 300 }), 2200);
  assert.equal(computeExpectedCash({}), 0);
  assert.equal(computeExpectedCash({ montoInicial: 0, entradasEfectivo: 1000, salidasEfectivo: 0 }), 1000);
});

test("computeDifference: calcula faltante cuando lo contado es menor", () => {
  const result = computeDifference(800, 1000);
  assert.equal(result.difference, -200);
  assert.equal(result.shortage, 200);
  assert.equal(result.surplus, 0);
});

test("computeDifference: calcula sobrante cuando lo contado es mayor", () => {
  const result = computeDifference(1150, 1000);
  assert.equal(result.difference, 150);
  assert.equal(result.shortage, 0);
  assert.equal(result.surplus, 150);
});

test("computeDifference: cuadre exacto no genera faltante ni sobrante", () => {
  const result = computeDifference(1000, 1000);
  assert.equal(result.difference, 0);
  assert.equal(result.shortage, 0);
  assert.equal(result.surplus, 0);
});

test("canConfirmClosing: bloquea confirmacion mientras haya faltante", () => {
  assert.equal(canConfirmClosing({ shortage: 50 }), false);
  assert.equal(canConfirmClosing({ shortage: 0 }), true);
});

test("isAutomaticClosingEligible: dias pasados siempre son elegibles", () => {
  assert.equal(isAutomaticClosingEligible({ date: "2026-07-10", today: "2026-07-19", hour: 10, minute: 0 }), true);
});

test("isAutomaticClosingEligible: el dia de hoy solo es elegible en su ultimo minuto (hora RD)", () => {
  assert.equal(isAutomaticClosingEligible({ date: "2026-07-19", today: "2026-07-19", hour: 15, minute: 30 }), false);
  assert.equal(isAutomaticClosingEligible({ date: "2026-07-19", today: "2026-07-19", hour: 23, minute: 58 }), false);
  assert.equal(isAutomaticClosingEligible({ date: "2026-07-19", today: "2026-07-19", hour: 23, minute: 59 }), true);
});

test("isAutomaticClosingEligible: dias futuros nunca son elegibles", () => {
  assert.equal(isAutomaticClosingEligible({ date: "2026-07-20", today: "2026-07-19", hour: 23, minute: 59 }), false);
});

test("buildClosingDedupeKey: genera la misma llave para el mismo dia y cuenta, previene duplicados", () => {
  const keyById = buildClosingDedupeKey("2026-07-19", "CTA-1", "Caja Registradora");
  const keyByIdAgain = buildClosingDedupeKey("2026-07-19", "CTA-1", "Otro nombre");
  const keyOtroDia = buildClosingDedupeKey("2026-07-18", "CTA-1", "Caja Registradora");
  assert.equal(keyById, keyByIdAgain);
  assert.notEqual(keyById, keyOtroDia);
});

test("summarizeCollaborators: distribuye totales por colaboradora y arma el desglose", () => {
  const detailRows = [
    { collaboratorId: "COL-1", collaboratorName: "Rosa", invoiceId: "F-1", billing: 1000, commissionable: 900, extra: 100, discount: 0 },
    { collaboratorId: "COL-1", collaboratorName: "Rosa", invoiceId: "F-2", billing: 500, commissionable: 500, extra: 0, discount: 50 },
    { collaboratorId: "COL-2", collaboratorName: "Paola", invoiceId: "F-1", billing: 800, commissionable: 800, extra: 0, discount: 0 },
  ];
  const tipRows = [
    { collaboratorId: "COL-1", collaboratorName: "Rosa", amount: 150 },
    { collaboratorId: "COL-2", collaboratorName: "Paola", amount: 80 },
  ];
  const rows = summarizeCollaborators(detailRows, tipRows);
  const rosa = rows.find((row) => row.id === "COL-1");
  const paola = rows.find((row) => row.id === "COL-2");
  assert.equal(rosa.services, 2);
  assert.deepEqual(rosa.invoiceIds.sort(), ["F-1", "F-2"]);
  assert.equal(rosa.billing, 1500);
  assert.equal(rosa.discounts, 50);
  assert.equal(rosa.extras, 100);
  assert.equal(rosa.tips, 150);
  assert.equal(rosa.total, 1500 - 50 + 100 + 150);
  assert.equal(paola.total, 800 + 80);
});

test("summarizeCollaborators: una factura con dos colaboradoras reparte cada linea a su colaboradora", () => {
  const detailRows = [
    { collaboratorId: "COL-1", collaboratorName: "Rosa", invoiceId: "F-9", billing: 600, commissionable: 600, extra: 0, discount: 0 },
    { collaboratorId: "COL-2", collaboratorName: "Paola", invoiceId: "F-9", billing: 400, commissionable: 400, extra: 0, discount: 0 },
  ];
  const rows = summarizeCollaborators(detailRows, []);
  const total = sumCollaboratorTotals(rows);
  assert.equal(total, 1000);
  assert.equal(rows.length, 2);
});

test("isValidIsoDate: valida formato YYYY-MM-DD", () => {
  assert.equal(isValidIsoDate("2026-07-19"), true);
  assert.equal(isValidIsoDate("19/07/2026"), false);
  assert.equal(isValidIsoDate(""), false);
  assert.equal(isValidIsoDate(undefined), false);
});

test("canConfirmTransfer: evita confirmar dos veces la misma transferencia", () => {
  assert.equal(canConfirmTransfer({ balancePendiente: 500, estado: "Pendiente" }), true);
  assert.equal(canConfirmTransfer({ balancePendiente: 0, estado: "Saldada" }), false);
  assert.equal(canConfirmTransfer({ balancePendiente: 500, estado: "Saldada" }), false);
  assert.equal(canConfirmTransfer(null), false);
});

test("hasClosingForDate: la generacion de cierres es idempotente (no duplica)", () => {
  const existing = [{ date: "2026-07-19", accountId: "CTA-1", accountName: "Caja Registradora" }];
  assert.equal(hasClosingForDate(existing, "2026-07-19", "CTA-1", "Caja Registradora"), true);
  assert.equal(hasClosingForDate(existing, "2026-07-19", "CTA-2", "Banco Popular"), false);
  assert.equal(hasClosingForDate(existing, "2026-07-20", "CTA-1", "Caja Registradora"), false);
});

test("isClosingPendingConfirmation: reconoce cierres provisionales, abiertos y pendientes", () => {
  assert.equal(isClosingPendingConfirmation({ estado: "Pendiente de confirmacion" }), true);
  assert.equal(isClosingPendingConfirmation({ estado: "Abierto para edición" }), true);
  assert.equal(isClosingPendingConfirmation({ requiereConfirmacion: true, estado: "Cerrado" }), true);
  assert.equal(isClosingPendingConfirmation({ estado: "Cerrado" }), false);
});

test("isClosingOpenForEdits: bloquea edicion de facturas de un cierre confirmado", () => {
  assert.equal(isClosingOpenForEdits(null), true, "sin cierre, el dia sigue abierto");
  assert.equal(isClosingOpenForEdits({ estado: "Pendiente de confirmacion" }), true);
  assert.equal(isClosingOpenForEdits({ estado: "Cerrado" }), false, "un cierre confirmado bloquea edicion");
});
