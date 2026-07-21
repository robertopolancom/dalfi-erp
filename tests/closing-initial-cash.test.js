// Corrige el defecto confirmado manualmente en produccion: el campo "Monto
// inicial" del cierre de caja registradora se podia editar a mano y ese
// valor terminaba guardado en balanceInicial. La fuente confiable ahora es
// DalfiClosingMath.resolveRegisterOpeningCash(), usada por
// defaultInitialCashFor() en outputs/app.js. Estas pruebas cubren la logica
// pura (sin DOM) de esa fuente confiable.
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
// A. Logica pura: DalfiClosingMath.resolveRegisterOpeningCash()
// ============================================================

test("resolveRegisterOpeningCash: A. con cierre anterior confirmado, usa su balanceContado (nunca un valor manual)", () => {
  const result = DalfiClosingMath.resolveRegisterOpeningCash({
    previousClosing: { balanceContado: 1234.5 },
    accountOpeningBalance: 999, // no debe usarse: hay cierre anterior
  });
  assert.strictEqual(result, 1234.5);
});

test("resolveRegisterOpeningCash: B. sin cierre anterior, usa el balance de apertura configurado de la cuenta", () => {
  const result = DalfiClosingMath.resolveRegisterOpeningCash({
    previousClosing: null,
    accountOpeningBalance: 5000,
  });
  assert.strictEqual(result, 5000);
});

test("resolveRegisterOpeningCash: C. sin cierre anterior y sin balance de apertura configurado, es 0 (regla existente, documentada, no inventa un saldo)", () => {
  assert.strictEqual(DalfiClosingMath.resolveRegisterOpeningCash({ previousClosing: null, accountOpeningBalance: 0 }), 0);
  assert.strictEqual(DalfiClosingMath.resolveRegisterOpeningCash({ previousClosing: null }), 0);
  assert.strictEqual(DalfiClosingMath.resolveRegisterOpeningCash({}), 0);
});

test("resolveRegisterOpeningCash: un balanceContado de 0 en el cierre anterior sigue siendo 0 (no cae al balance de apertura de la cuenta)", () => {
  const result = DalfiClosingMath.resolveRegisterOpeningCash({ previousClosing: { balanceContado: 0 }, accountOpeningBalance: 5000 });
  assert.strictEqual(result, 0, "que exista un cierre anterior (aunque haya cerrado en 0) manda sobre el balance de apertura de la cuenta");
});

// ============================================================
// B. defaultInitialCashFor() en outputs/app.js: integra la busqueda del
// cierre anterior (filtrando pendientes) con resolveRegisterOpeningCash.
// ============================================================

const dependenciesSource = ["dateOnly", "dbTable", "accountKey", "recordMatchesAccount", "isClosingPendingConfirmation", "normalize", "defaultInitialCashFor"]
  .map(extractFunction)
  .join("\n\n");

function buildSandbox(cierres, cuentaOverrides = {}) {
  const database = { data: { cierres } };
  const sandbox = {
    database,
    today: "2026-07-21",
    DalfiClosingMath,
    console,
    ensureDatabaseShape: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(dependenciesSource, sandbox);
  const account = { cuentaID: "CTA-CAJA-001", nombreCuenta: "Caja Registradora", balanceInicial: 0, ...cuentaOverrides };
  return { sandbox, account };
}

test("defaultInitialCashFor: un cierre anterior CONFIRMADO de la misma caja determina el monto inicial", () => {
  const { sandbox, account } = buildSandbox([
    { cierreID: "CIE-1", cuentaCaja: "Caja Registradora", cuentaID: "CTA-CAJA-001", fechaHoraCierre: "2026-07-20T23:59:00", balanceContado: 850, estado: "Cerrado" },
  ]);
  assert.strictEqual(sandbox.defaultInitialCashFor(account, "2026-07-21"), 850);
});

test("defaultInitialCashFor: un cierre PENDIENTE (sin confirmar) de la misma caja NO determina el monto inicial del siguiente", () => {
  const { sandbox, account } = buildSandbox([
    {
      cierreID: "CIE-1",
      cuentaCaja: "Caja Registradora",
      cuentaID: "CTA-CAJA-001",
      fechaHoraCierre: "2026-07-20T23:59:00",
      balanceContado: 850,
      estado: "Pendiente de confirmacion",
      requiereConfirmacion: true,
    },
  ]);
  assert.strictEqual(
    sandbox.defaultInitialCashFor(account, "2026-07-21"),
    0,
    "sin ningun cierre CONFIRMADO anterior, debe caer al balance de apertura de la cuenta (0 en este fixture)"
  );
});

test("defaultInitialCashFor: sin ningun cierre anterior, usa el balance de apertura configurado de la cuenta", () => {
  const { sandbox, account } = buildSandbox([], { balanceInicial: 2500 });
  assert.strictEqual(sandbox.defaultInitialCashFor(account, "2026-07-21"), 2500);
});

test("defaultInitialCashFor: dos cierres consecutivos enlazan correctamente (el saldo final del dia 1 es el monto inicial del dia 2)", () => {
  const { sandbox, account } = buildSandbox([
    { cierreID: "CIE-1", cuentaCaja: "Caja Registradora", cuentaID: "CTA-CAJA-001", fechaHoraCierre: "2026-07-19T23:59:00", balanceContado: 500, estado: "Cerrado" },
  ]);
  const montoInicialDia2 = sandbox.defaultInitialCashFor(account, "2026-07-20");
  assert.strictEqual(montoInicialDia2, 500);
  // Simula que el dia 2 se cierra en 730 y se agrega a la coleccion.
  sandbox.database.data.cierres.push({
    cierreID: "CIE-2",
    cuentaCaja: "Caja Registradora",
    cuentaID: "CTA-CAJA-001",
    fechaHoraCierre: "2026-07-20T23:59:00",
    balanceContado: 730,
    estado: "Cerrado",
  });
  const montoInicialDia3 = sandbox.defaultInitialCashFor(account, "2026-07-21");
  assert.strictEqual(montoInicialDia3, 730, "el dia 3 debe encadenar con el saldo final confirmado del dia 2, no con el del dia 1 ni con la cuenta");
});

test("defaultInitialCashFor: es determinístico — llamarlo dos veces con los mismos datos da el mismo resultado (recargar la app no cambia el monto inicial)", () => {
  const { sandbox, account } = buildSandbox([
    { cierreID: "CIE-1", cuentaCaja: "Caja Registradora", cuentaID: "CTA-CAJA-001", fechaHoraCierre: "2026-07-20T23:59:00", balanceContado: 850, estado: "Cerrado" },
  ]);
  const first = sandbox.defaultInitialCashFor(account, "2026-07-21");
  const second = sandbox.defaultInitialCashFor(account, "2026-07-21");
  assert.strictEqual(first, second);
  assert.strictEqual(first, 850);
});

test("defaultInitialCashFor: un cierre de OTRA cuenta no interfiere (usa cuentaID/nombreCuenta para filtrar)", () => {
  const { sandbox, account } = buildSandbox(
    [{ cierreID: "CIE-1", cuentaCaja: "Banco Popular", cuentaID: "CTA-BANCO-001", fechaHoraCierre: "2026-07-20T23:59:00", balanceContado: 99999, estado: "Cerrado" }],
    { balanceInicial: 300 }
  );
  assert.strictEqual(sandbox.defaultInitialCashFor(account, "2026-07-21"), 300, "no debe mezclar el balanceContado de otra cuenta");
});

// ============================================================
// C. Pipeline completo (pura): resolveRegisterOpeningCash -> computeExpectedCash
// -> computeDifference/canConfirmClosing conservan faltante/cuadre/sobrante.
// ============================================================

test("pipeline: faltante sigue sin poder confirmarse aunque el monto inicial ahora venga de la fuente confiable", () => {
  const montoInicial = DalfiClosingMath.resolveRegisterOpeningCash({ previousClosing: { balanceContado: 500 } });
  const expected = DalfiClosingMath.computeExpectedCash({ montoInicial, entradasEfectivo: 1000, salidasEfectivo: 200 });
  assert.strictEqual(expected, 1300);
  const { shortage } = DalfiClosingMath.computeDifference(1000, expected); // contaron menos de lo esperado
  assert.strictEqual(shortage, 300);
  assert.strictEqual(DalfiClosingMath.canConfirmClosing({ shortage }), false);
});

test("pipeline: cuadre exacto sigue confirmandose", () => {
  const montoInicial = DalfiClosingMath.resolveRegisterOpeningCash({ previousClosing: { balanceContado: 500 } });
  const expected = DalfiClosingMath.computeExpectedCash({ montoInicial, entradasEfectivo: 1000, salidasEfectivo: 200 });
  const { shortage, surplus } = DalfiClosingMath.computeDifference(expected, expected);
  assert.strictEqual(shortage, 0);
  assert.strictEqual(surplus, 0);
  assert.strictEqual(DalfiClosingMath.canConfirmClosing({ shortage }), true);
});

test("pipeline: sobrante sigue calculandose y permite confirmar", () => {
  const montoInicial = DalfiClosingMath.resolveRegisterOpeningCash({ previousClosing: null, accountOpeningBalance: 500 });
  const expected = DalfiClosingMath.computeExpectedCash({ montoInicial, entradasEfectivo: 1000, salidasEfectivo: 200 });
  const { shortage, surplus } = DalfiClosingMath.computeDifference(expected + 50, expected);
  assert.strictEqual(surplus, 50);
  assert.strictEqual(shortage, 0);
  assert.strictEqual(DalfiClosingMath.canConfirmClosing({ shortage }), true);
});
