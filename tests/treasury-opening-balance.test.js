// Corrige el hueco documentado en previousTreasurySaldoFor(): caia a 0
// cuando no existia un cierre de tesoreria anterior, en vez de usar el
// balance de apertura configurado de la cuenta. Misma regla que
// resolveRegisterOpeningCash() (monto inicial de caja registradora), ahora
// generalizada a DalfiClosingMath.resolveTreasuryOpeningBalance().
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DalfiClosingMath = require("../outputs/lib/closing-math.js");
const APP_JS_PATH = path.join(__dirname, "..", "outputs", "app.js");
const source = fs.readFileSync(APP_JS_PATH, "utf8");

function extractBraceBlock(fromIndex) {
  const openIdx = source.indexOf("{", fromIndex);
  let depth = 0;
  let end = openIdx;
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  return end;
}

function extractFunction(name) {
  const pattern = new RegExp(`^(async )?function ${name}\\(`, "m");
  const match = pattern.exec(source);
  if (!match) throw new Error(`No se encontro function ${name} en outputs/app.js`);
  let parenDepth = 0;
  let afterParams = source.indexOf("(", match.index);
  for (; afterParams < source.length; afterParams++) {
    if (source[afterParams] === "(") parenDepth++;
    else if (source[afterParams] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        afterParams++;
        break;
      }
    }
  }
  const end = extractBraceBlock(afterParams);
  return source.slice(match.index, end);
}

// ============================================================
// A. Logica pura: DalfiClosingMath.resolveTreasuryOpeningBalance()
// ============================================================

test("resolveTreasuryOpeningBalance: A. con cierre de tesoreria anterior confirmado, usa su saldoReal", () => {
  const result = DalfiClosingMath.resolveTreasuryOpeningBalance({
    previousConfirmedClosing: { saldoReal: 4321.5 },
    accountOpeningBalance: 999, // no debe usarse: hay cierre anterior confirmado
  });
  assert.strictEqual(result, 4321.5);
});

test("resolveTreasuryOpeningBalance: B. sin cierre anterior, usa el balance de apertura configurado de la cuenta", () => {
  const result = DalfiClosingMath.resolveTreasuryOpeningBalance({ previousConfirmedClosing: null, accountOpeningBalance: 7500 });
  assert.strictEqual(result, 7500);
});

test("resolveTreasuryOpeningBalance: balance de apertura EN CERO produce 0 (RD$0.00), no se confunde con 'no hay dato'", () => {
  const result = DalfiClosingMath.resolveTreasuryOpeningBalance({ previousConfirmedClosing: null, accountOpeningBalance: 0 });
  assert.strictEqual(result, 0);
  assert.notStrictEqual(result, undefined);
  assert.notStrictEqual(result, null);
});

test("resolveTreasuryOpeningBalance: C. sin cierre anterior y sin balance de apertura, es 0 (nunca inventa un saldo)", () => {
  assert.strictEqual(DalfiClosingMath.resolveTreasuryOpeningBalance({}), 0);
  assert.strictEqual(DalfiClosingMath.resolveTreasuryOpeningBalance({ previousConfirmedClosing: null }), 0);
});

test("resolveTreasuryOpeningBalance: un saldoReal de 0 en el cierre anterior sigue siendo 0 (no cae al balance de apertura de la cuenta)", () => {
  const result = DalfiClosingMath.resolveTreasuryOpeningBalance({ previousConfirmedClosing: { saldoReal: 0 }, accountOpeningBalance: 5000 });
  assert.strictEqual(result, 0, "que exista un cierre anterior confirmado (aunque haya cerrado en 0) manda sobre el balance de apertura");
});

test("resolveTreasuryOpeningBalance: rechaza NaN e Infinito, nunca los propaga como saldo", () => {
  assert.strictEqual(DalfiClosingMath.resolveTreasuryOpeningBalance({ previousConfirmedClosing: { saldoReal: NaN } }), 0);
  assert.strictEqual(DalfiClosingMath.resolveTreasuryOpeningBalance({ previousConfirmedClosing: { saldoReal: Infinity } }), 0);
  assert.strictEqual(DalfiClosingMath.resolveTreasuryOpeningBalance({ previousConfirmedClosing: { saldoReal: -Infinity } }), 0);
  assert.strictEqual(DalfiClosingMath.resolveTreasuryOpeningBalance({ accountOpeningBalance: Infinity }), 0);
  assert.strictEqual(DalfiClosingMath.resolveTreasuryOpeningBalance({ accountOpeningBalance: "no-es-un-numero" }), 0);
});

test("resolveTreasuryOpeningBalance: acepta strings numericos (normaliza), igual que resolveRegisterOpeningCash", () => {
  assert.strictEqual(DalfiClosingMath.resolveTreasuryOpeningBalance({ previousConfirmedClosing: { saldoReal: "1500.50" } }), 1500.5);
});

test("regresion: resolveRegisterOpeningCash tambien rechaza NaN/Infinito ahora (mismo saneamiento compartido)", () => {
  assert.strictEqual(DalfiClosingMath.resolveRegisterOpeningCash({ previousClosing: { balanceContado: Infinity } }), 0);
  assert.strictEqual(DalfiClosingMath.resolveRegisterOpeningCash({ accountOpeningBalance: NaN }), 0);
  // Comportamiento normal preservado.
  assert.strictEqual(DalfiClosingMath.resolveRegisterOpeningCash({ previousClosing: { balanceContado: 850 } }), 850);
});

// ============================================================
// B. previousTreasurySaldoFor() en outputs/app.js: integra la busqueda del
// cierre de tesoreria anterior (filtrando pendientes/needsReview/otra
// cuenta) con resolveTreasuryOpeningBalance.
// ============================================================

const dependenciesSource = [
  "dateOnly",
  "dbTable",
  "accountKey",
  "recordMatchesAccount",
  "isClosingPendingConfirmation",
  "closingBusinessDate",
  "normalize",
  "previousTreasurySaldoFor",
]
  .map(extractFunction)
  .join("\n\n");

function buildSandbox(cierres) {
  const database = { data: { cierres } };
  const sandbox = { database, today: "2026-07-21", DalfiClosingMath, console, ensureDatabaseShape: () => {} };
  vm.createContext(sandbox);
  vm.runInContext(dependenciesSource, sandbox);
  return sandbox;
}

const BANCO = { cuentaID: "CTA-BANCO-001", nombreCuenta: "Banco Popular", balanceInicial: 0 };
const CAJA_FUERTE = { cuentaID: "CTA-FUERTE-001", nombreCuenta: "Caja Fuerte", balanceInicial: 0 };

function treasuryClosing({ businessDate, estado = "Cerrado", requiereConfirmacion = false, needsReview = false, cuentas }) {
  return {
    cierreID: `CIE-${businessDate}`,
    closingType: "treasury",
    businessDate,
    fechaHoraCierre: `${businessDate}T23:59:00`,
    estado,
    requiereConfirmacion,
    needsReview,
    cuentas,
  };
}

test("previousTreasurySaldoFor: 1. cierre de tesoreria anterior CONFIRMADO determina el saldo inicial", () => {
  const sandbox = buildSandbox([
    treasuryClosing({ businessDate: "2026-07-20", cuentas: [{ cuentaID: "CTA-BANCO-001", nombreCuenta: "Banco Popular", saldoReal: 12000 }] }),
  ]);
  assert.strictEqual(sandbox.previousTreasurySaldoFor(BANCO, "2026-07-21"), 12000);
});

test("previousTreasurySaldoFor: 2. cierre PENDIENTE no determina el saldo inicial (cae al balance de apertura de la cuenta)", () => {
  const sandbox = buildSandbox([
    treasuryClosing({
      businessDate: "2026-07-20",
      estado: "Pendiente de confirmacion",
      requiereConfirmacion: true,
      cuentas: [{ cuentaID: "CTA-BANCO-001", nombreCuenta: "Banco Popular", saldoReal: 12000 }],
    }),
  ]);
  assert.strictEqual(sandbox.previousTreasurySaldoFor({ ...BANCO, balanceInicial: 500 }, "2026-07-21"), 500);
});

test("previousTreasurySaldoFor: 3. cierre marcado needsReview (duplicado historico) no determina el saldo inicial", () => {
  const sandbox = buildSandbox([
    treasuryClosing({ businessDate: "2026-07-20", needsReview: true, cuentas: [{ cuentaID: "CTA-BANCO-001", nombreCuenta: "Banco Popular", saldoReal: 99999 }] }),
  ]);
  assert.strictEqual(sandbox.previousTreasurySaldoFor({ ...BANCO, balanceInicial: 500 }, "2026-07-21"), 500);
});

test("previousTreasurySaldoFor: 4. cierre de OTRA cuenta no determina el saldo inicial (nunca mezcla cuentas)", () => {
  const sandbox = buildSandbox([
    treasuryClosing({ businessDate: "2026-07-20", cuentas: [{ cuentaID: "CTA-FUERTE-001", nombreCuenta: "Caja Fuerte", saldoReal: 99999 }] }),
  ]);
  assert.strictEqual(sandbox.previousTreasurySaldoFor({ ...BANCO, balanceInicial: 500 }, "2026-07-21"), 500);
});

test("previousTreasurySaldoFor: 5. sin ningun cierre anterior, usa el balance de apertura configurado de la cuenta", () => {
  const sandbox = buildSandbox([]);
  assert.strictEqual(sandbox.previousTreasurySaldoFor({ ...BANCO, balanceInicial: 25000 }, "2026-07-21"), 25000);
});

test("previousTreasurySaldoFor: 6. balance de apertura en 0 produce 0 (no undefined/null)", () => {
  const sandbox = buildSandbox([]);
  const result = sandbox.previousTreasurySaldoFor({ ...BANCO, balanceInicial: 0 }, "2026-07-21");
  assert.strictEqual(result, 0);
});

test("previousTreasurySaldoFor: 7. sin cierre anterior NI balance de apertura, usa 0", () => {
  const sandbox = buildSandbox([]);
  const account = { cuentaID: "CTA-NUEVA-001", nombreCuenta: "Cuenta Nueva" }; // sin balanceInicial
  assert.strictEqual(sandbox.previousTreasurySaldoFor(account, "2026-07-21"), 0);
});

test("previousTreasurySaldoFor: 8. es determinístico — llamarlo dos veces con los mismos datos da el mismo resultado (recargar no cambia el saldo)", () => {
  const sandbox = buildSandbox([
    treasuryClosing({ businessDate: "2026-07-20", cuentas: [{ cuentaID: "CTA-BANCO-001", nombreCuenta: "Banco Popular", saldoReal: 12000 }] }),
  ]);
  const first = sandbox.previousTreasurySaldoFor(BANCO, "2026-07-21");
  const second = sandbox.previousTreasurySaldoFor(BANCO, "2026-07-21");
  assert.strictEqual(first, second);
  assert.strictEqual(first, 12000);
});

test("previousTreasurySaldoFor: 11. dos cierres consecutivos de tesoreria enlazan (el saldo final del dia 1 es el inicial del dia 2)", () => {
  const sandbox = buildSandbox([
    treasuryClosing({ businessDate: "2026-07-19", cuentas: [{ cuentaID: "CTA-BANCO-001", nombreCuenta: "Banco Popular", saldoReal: 5000 }] }),
  ]);
  const saldoDia2 = sandbox.previousTreasurySaldoFor(BANCO, "2026-07-20");
  assert.strictEqual(saldoDia2, 5000);
  sandbox.database.data.cierres.push(
    treasuryClosing({ businessDate: "2026-07-20", cuentas: [{ cuentaID: "CTA-BANCO-001", nombreCuenta: "Banco Popular", saldoReal: 7300 }] }),
  );
  const saldoDia3 = sandbox.previousTreasurySaldoFor(BANCO, "2026-07-21");
  assert.strictEqual(saldoDia3, 7300, "debe encadenar con el dia 2, no con el dia 1 ni con la cuenta");
});

test("previousTreasurySaldoFor: 22. no mezcla banco, caja fuerte y caja chica entre si (cada cuenta resuelve su propio saldo)", () => {
  const sandbox = buildSandbox([
    treasuryClosing({
      businessDate: "2026-07-20",
      cuentas: [
        { cuentaID: "CTA-BANCO-001", nombreCuenta: "Banco Popular", saldoReal: 12000 },
        { cuentaID: "CTA-FUERTE-001", nombreCuenta: "Caja Fuerte", saldoReal: 3000 },
      ],
    }),
  ]);
  assert.strictEqual(sandbox.previousTreasurySaldoFor(BANCO, "2026-07-21"), 12000);
  assert.strictEqual(sandbox.previousTreasurySaldoFor(CAJA_FUERTE, "2026-07-21"), 3000);
});

// ============================================================
// C. Pipeline: buildTreasuryAccountDetail nunca produce NaN/undefined y
// nunca resta/suma el saldo inicial dos veces.
// ============================================================

test("21. buildTreasuryAccountDetail: nunca produce NaN/undefined/null, incluso sin cierre anterior ni balance de apertura", () => {
  const fullSource = [
    "dateOnly",
    "dbTable",
    "accountKey",
    "recordMatchesAccount",
    "isClosingPendingConfirmation",
    "closingBusinessDate",
    "normalize",
    "previousTreasurySaldoFor",
    "accountActivityForDate",
    "isBankAccount",
    "buildTreasuryAccountDetail",
  ]
    .map(extractFunction)
    .join("\n\n");
  const database = { data: { cierres: [], egresos: [], ingresos: [], transferencias: [] } };
  const sandbox = { database, today: "2026-07-21", DalfiClosingMath, console, ensureDatabaseShape: () => {} };
  vm.createContext(sandbox);
  vm.runInContext(fullSource, sandbox);
  const account = { cuentaID: "CTA-NUEVA-001", nombreCuenta: "Cuenta Nueva" };
  const detail = sandbox.buildTreasuryAccountDetail("2026-07-21", account);
  for (const key of ["saldoInicial", "saldoEsperado", "saldoReal", "ingresos", "egresos"]) {
    assert.ok(Number.isFinite(detail[key]), `${key} debe ser un numero finito, recibido: ${detail[key]}`);
  }
  assert.strictEqual(detail.saldoInicial, 0);
});
