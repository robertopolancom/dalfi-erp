// Egresos del dia (cierre de caja registradora): valor SIEMPRE calculado
// desde accountActivityForDate() en outputs/app.js, nunca desde un input.
// Estas pruebas cubren el calculo puro (sin DOM): que suma, que excluye, y
// que nunca cuenta el mismo movimiento dos veces (bug real encontrado y
// corregido en esta misma tarea: un egreso tipo "transferencia" creaba una
// fila en "egresos" Y otra en "transferencias" para el mismo dinero).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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

const dependenciesSource = ["dateOnly", "dbTable", "accountKey", "recordMatchesAccount", "normalize", "accountActivityForDate", "accountActivityDetailForDate"]
  .map(extractFunction)
  .join("\n\n");

function buildSandbox({ egresos = [], ingresos = [], transferencias = [] } = {}) {
  const database = { data: { egresos, ingresos, transferencias } };
  const sandbox = { database, today: "2026-07-21", console, ensureDatabaseShape: () => {} };
  vm.createContext(sandbox);
  vm.runInContext(dependenciesSource, sandbox);
  return sandbox;
}

const CAJA = { cuentaID: "CTA-CAJA-001", nombreCuenta: "Caja Registradora" };
const BANCO = { cuentaID: "CTA-BANCO-001", nombreCuenta: "Banco Popular" };

function egreso(overrides = {}) {
  return {
    egresoID: `EGR-${Math.random()}`,
    fechaHora: "2026-07-21T10:00:00",
    tipoEgreso: "gasto",
    cuentaOrigen: "Caja Registradora",
    cuentaOrigenID: "CTA-CAJA-001",
    concepto: "Compra",
    monto: 100,
    estado: "Registrado",
    ...overrides,
  };
}

test("sin egresos, 'Egresos del dia' es 0", () => {
  const { sandbox } = { sandbox: buildSandbox() };
  const activity = sandbox.accountActivityForDate("2026-07-21", CAJA);
  assert.strictEqual(activity.expenses, 0);
});

test("suma correctamente varios egresos de la misma fecha y caja", () => {
  const sandbox = buildSandbox({ egresos: [egreso({ monto: 100 }), egreso({ monto: 250 }), egreso({ monto: 50 })] });
  const activity = sandbox.accountActivityForDate("2026-07-21", CAJA);
  assert.strictEqual(activity.expenses, 400);
});

test("excluye egresos de otra fecha", () => {
  const sandbox = buildSandbox({ egresos: [egreso({ monto: 100, fechaHora: "2026-07-20T10:00:00" }), egreso({ monto: 300 })] });
  const activity = sandbox.accountActivityForDate("2026-07-21", CAJA);
  assert.strictEqual(activity.expenses, 300);
});

test("excluye egresos de otra cuenta (pagos bancarios no cuentan en el cierre de caja registradora, y viceversa)", () => {
  const sandbox = buildSandbox({
    egresos: [egreso({ monto: 500, cuentaOrigen: "Banco Popular", cuentaOrigenID: "CTA-BANCO-001" }), egreso({ monto: 300 })],
  });
  const activityCaja = sandbox.accountActivityForDate("2026-07-21", CAJA);
  assert.strictEqual(activityCaja.expenses, 300, "el cierre de caja registradora no debe incluir el pago hecho desde banco");
  const activityBanco = sandbox.accountActivityForDate("2026-07-21", BANCO);
  assert.strictEqual(activityBanco.expenses, 500);
});

test("excluye egresos anulados (misma regla que ingresos/transferencias, aunque hoy no exista flujo de anulacion)", () => {
  const sandbox = buildSandbox({ egresos: [egreso({ monto: 100, estado: "Anulado" }), egreso({ monto: 300 })] });
  const activity = sandbox.accountActivityForDate("2026-07-21", CAJA);
  assert.strictEqual(activity.expenses, 300);
});

test("registros incompletos (sin monto valido) no rompen la suma ni aparecen como NaN", () => {
  const sandbox = buildSandbox({ egresos: [egreso({ monto: undefined }), egreso({ monto: "" }), egreso({ monto: 200 })] });
  const activity = sandbox.accountActivityForDate("2026-07-21", CAJA);
  assert.strictEqual(activity.expenses, 200);
  assert.ok(Number.isFinite(activity.expenses), "nunca NaN");
});

test("un egreso tipo 'transferencia' NO se cuenta como egreso (ya se cuenta via transferOut, evita duplicar la misma salida de efectivo)", () => {
  const sandbox = buildSandbox({
    egresos: [egreso({ monto: 1000, tipoEgreso: "transferencia" })],
    transferencias: [
      { transferenciaID: "TRF-1", fechaHora: "2026-07-21T10:00:00", cuentaOrigen: "Caja Registradora", cuentaOrigenID: "CTA-CAJA-001", cuentaDestino: "Banco Popular", cuentaDestinoID: "CTA-BANCO-001", monto: 1000, estado: "Confirmada" },
    ],
  });
  const activity = sandbox.accountActivityForDate("2026-07-21", CAJA);
  assert.strictEqual(activity.expenses, 0, "el egreso tipo transferencia no debe sumar en 'expenses'");
  assert.strictEqual(activity.transferOut, 1000, "el movimiento SI debe contarse, pero solo una vez, via transferOut");
  assert.strictEqual(activity.expenses + activity.transferOut, 1000, "el monto esperado nunca debe restar el mismo movimiento dos veces");
});

test("un egreso normal (no transferencia) SI se cuenta como egreso, junto con una transferencia real e independiente", () => {
  const sandbox = buildSandbox({
    egresos: [egreso({ monto: 300, tipoEgreso: "gasto" }), egreso({ monto: 1000, tipoEgreso: "transferencia" })],
    transferencias: [
      { transferenciaID: "TRF-1", fechaHora: "2026-07-21T10:00:00", cuentaOrigen: "Caja Registradora", cuentaOrigenID: "CTA-CAJA-001", cuentaDestino: "Banco Popular", cuentaDestinoID: "CTA-BANCO-001", monto: 1000, estado: "Confirmada" },
    ],
  });
  const activity = sandbox.accountActivityForDate("2026-07-21", CAJA);
  assert.strictEqual(activity.expenses, 300);
  assert.strictEqual(activity.transferOut, 1000);
  assert.strictEqual(activity.expenses + activity.transferOut, 1300);
});

test("pagos parciales (varios egresos pequeños) se contabilizan correctamente, sumados uno a uno", () => {
  const sandbox = buildSandbox({ egresos: [egreso({ monto: 33.33 }), egreso({ monto: 33.33 }), egreso({ monto: 33.34 })] });
  const activity = sandbox.accountActivityForDate("2026-07-21", CAJA);
  assert.strictEqual(Math.round(activity.expenses * 100) / 100, 100);
});

test("el monto esperado (DalfiClosingMath.computeExpectedCash) resta 'Egresos del dia' una sola vez", () => {
  const DalfiClosingMath = require("../outputs/lib/closing-math.js");
  const sandbox = buildSandbox({ egresos: [egreso({ monto: 400 })] });
  const activity = sandbox.accountActivityForDate("2026-07-21", CAJA);
  const expected = DalfiClosingMath.computeExpectedCash({ montoInicial: 1000, entradasEfectivo: activity.income + activity.transferIn, salidasEfectivo: activity.expenses + activity.transferOut });
  assert.strictEqual(expected, 600, "1000 + 0 - 400, el egreso resta exactamente una vez");
});

test("accountActivityDetailForDate: el detalle tampoco duplica un egreso tipo transferencia (ni lo lista dos veces)", () => {
  const sandbox = buildSandbox({
    egresos: [egreso({ monto: 1000, tipoEgreso: "transferencia", concepto: "Deposito a banco" })],
    transferencias: [
      { transferenciaID: "TRF-1", fechaHora: "2026-07-21T10:00:00", cuentaOrigen: "Caja Registradora", cuentaOrigenID: "CTA-CAJA-001", cuentaDestino: "Banco Popular", cuentaDestinoID: "CTA-BANCO-001", monto: 1000, estado: "Confirmada" },
    ],
  });
  const detail = sandbox.accountActivityDetailForDate("2026-07-21", CAJA);
  assert.strictEqual(detail.expenseRows.length, 1, "solo debe aparecer una fila (la de la transferencia), no dos");
  assert.match(detail.expenseRows[0].label, /Transferencia enviada/);
});

test("dos egresos distintos generan dos filas en el detalle, sin fusionarse ni perderse", () => {
  const sandbox = buildSandbox({ egresos: [egreso({ monto: 100, concepto: "Luz" }), egreso({ monto: 200, concepto: "Agua" })] });
  const detail = sandbox.accountActivityDetailForDate("2026-07-21", CAJA);
  assert.strictEqual(detail.expenseRows.length, 2);
});
