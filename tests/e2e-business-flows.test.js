// E2E determinista de los cuatro flujos operativos principales.
//
// Este runner no escribe Supabase ni crea datos TEST: encadena las mismas
// funciones puras que usa la SPA para verificar invariantes de extremo a
// extremo antes de conectar un navegador real a un entorno de staging.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MathEngine = require("../outputs/lib/closing-math.js");
const appSource = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");

test("E2E ventas→pago: la factura y sus cobros conservan el invariante monetario", () => {
  const invoice = MathEngine.computeInvoiceBreakdown({
    precioListadoServicios: 1200,
    totalAdicionales: 200,
    totalDescuentos: 100,
    propina: 150,
    totalPagado: 0,
  });
  assert.equal(invoice.totalGeneral, 1450);
  assert.equal(invoice.montoPendiente, 1450);

  const allocation = MathEngine.allocateClientPaymentFIFO({
    confirmedPaymentLines: [
      { method: "efectivo", amount: 1000 },
      { method: "tarjeta", amount: 300 },
      { method: "transferencia_pendiente", amount: 150 },
    ],
    currentInvoiceBase: invoice.totalServiciosAjustado,
    currentInvoiceTip: invoice.propina,
  });
  assert.equal(allocation.totalApplied, 1300);
  assert.equal(allocation.amountAppliedToCurrentBase, 1300);
  assert.equal(allocation.amountAppliedToCurrentTip, 0);
  assert.equal(allocation.unappliedAmount, 0);
  assert.equal(invoice.totalGeneral - allocation.totalApplied, 150);
});

test("E2E transferencia: una transferencia pendiente no es ingreso confirmado hasta validarse", () => {
  const pending = { balancePendiente: 150, estado: "Pendiente" };
  assert.equal(MathEngine.canConfirmTransfer(pending), true);
  assert.equal(MathEngine.canConfirmTransfer({ ...pending, estado: "Saldada" }), false);

  const afterConfirmation = MathEngine.allocateClientPaymentFIFO({
    confirmedPaymentLines: [{ method: "transferencia_confirmada", amount: 150 }],
    currentInvoiceBase: 0,
    currentInvoiceTip: 150,
  });
  assert.equal(afterConfirmation.amountAppliedToCurrentTip, 150);
  assert.equal(afterConfirmation.currentTipRemaining, 0);
});

test("E2E cuentas→cierre: el saldo y la caja separan transferencias de efectivo", () => {
  const account = MathEngine.computeAccountDailyBalance({
    balanceInicial: 500,
    ingresos: 1300,
    egresos: 200,
    transferenciasEntrantes: 150,
    transferenciasSalientes: 100,
  });
  assert.equal(account.balanceFinalCalculado, 1650);

  const expectedCash = MathEngine.computeExpectedCash({
    montoInicial: 500,
    entradasEfectivo: 1000,
    salidasEfectivo: 200,
  });
  assert.equal(expectedCash, 1300);
  assert.deepEqual(MathEngine.computeDifference(1300, expectedCash), {
    difference: 0,
    shortage: 0,
    surplus: 0,
  });
  assert.equal(MathEngine.canConfirmClosing({ shortage: 0 }), true);
  assert.equal(MathEngine.canConfirmClosing({ shortage: 1 }), false);
});

test("E2E cierres: repetir la generación no duplica el mismo día y cuenta", () => {
  const existing = [{ date: "2026-07-26", accountId: "register-1", accountName: "Caja" }];
  assert.equal(MathEngine.hasClosingForDate(existing, "2026-07-26", "register-1", "Caja"), true);
  assert.equal(MathEngine.hasClosingForDate(existing, "2026-07-26", "register-2", "Caja 2"), false);
  assert.equal(MathEngine.buildClosingDedupeKey("2026-07-26", "register-1", "Caja"), "2026-07-26::id:register-1");
});

test("E2E de persistencia: la SPA usa la API de base de datos y no escribe directo en Supabase", () => {
  assert.match(appSource, /fetch\(["'`]\/api\/database/);
  assert.doesNotMatch(appSource, /supabaseClient\.from\(/);
});

