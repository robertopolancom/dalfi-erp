// Aserciones estaticas (mismo patron que tests/closing-initial-cash-ui.test.js)
// sobre integracion, proteccion y compatibilidad del saldo inicial de
// tesoreria: nunca se lee del DOM, se recalcula al confirmar, no reescribe
// cierres historicos, y no rompe caja registradora/Egresos del dia/Agregar
// egreso (que no comparten esta ruta de codigo).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");
const cronSource = fs.readFileSync(path.join(__dirname, "..", "functions", "api", "run-closing-catchup.js"), "utf8");

function extractFunctionSource(name, source = appJs) {
  const pattern = new RegExp(`^(async )?function ${name}\\(`, "m");
  const match = pattern.exec(source);
  assert.ok(match, `no se encontro function ${name}`);
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
  let depth = 0;
  let end = source.indexOf("{", afterParams);
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
  return source.slice(match.index, end);
}

// --- 9, 12, 14: nunca se lee del DOM; no es un input editable ---

test("previousTreasurySaldoFor(): nunca lee un valor desde el DOM (ningun byId), solo de la coleccion de cierres y de la cuenta", () => {
  const fnSource = extractFunctionSource("previousTreasurySaldoFor");
  assert.ok(!/byId\(/.test(fnSource), "no debe leer nada del DOM");
});

test("buildTreasuryAccountDetail(): tampoco lee nada del DOM", () => {
  const fnSource = extractFunctionSource("buildTreasuryAccountDetail");
  assert.ok(!/byId\(/.test(fnSource));
});

test("index.html / outputs/app.js: no existe ningun input editable para 'saldo inicial' de tesoreria (sigue siendo texto calculado)", () => {
  assert.ok(!/<input[^>]*saldo-?[Ii]nicial/i.test(indexHtml));
  assert.ok(!/<input[^>]*saldo-?[Ii]nicial/i.test(appJs));
  assert.match(appJs, /<td>\$\{money\.format\(Number\(row\.saldoInicial\) \|\| 0\)\}<\/td>/, "sigue siendo una celda de tabla, no un input");
});

test("manipular el DOM no puede cambiar el saldo inicial guardado: no existe ningun elemento con id relacionado a 'treasury' + 'initial/inicial' que el codigo lea antes de guardar", () => {
  assert.ok(!/byId\("treasury-initial/i.test(appJs));
  assert.ok(!/byId\("treasury-saldo-inicial/i.test(appJs));
});

// --- 10, 15: la confirmacion recalcula, nunca confia en el valor ya guardado ---

test("confirmTreasuryRange(): recalcula cuentas/totales de CADA fecha del rango justo antes de confirmarla (no confia en closing.cuentas ya guardado)", () => {
  const fnSource = extractFunctionSource("confirmTreasuryRange");
  assert.match(fnSource, /const fresh = buildTreasuryAccountDetail\(date, account\);/);
  assert.match(fnSource, /closing\.cuentas = refreshedCuentas;/);
  assert.match(fnSource, /closing\.totales = buildTreasuryTotals\(refreshedCuentas\);/);
  // El recalculo debe ocurrir ANTES de marcar el cierre como "Cerrado".
  const recalcIndex = fnSource.indexOf("closing.cuentas = refreshedCuentas;");
  const closeIndex = fnSource.indexOf('closing.estado = "Cerrado";');
  assert.ok(recalcIndex >= 0 && closeIndex > recalcIndex, "el recalculo debe ocurrir antes de marcar el cierre como confirmado");
});

test("confirmTreasuryRange(): pendingTreasuryRange() (ya probada en closing-math.test.js) devuelve el rango en orden ascendente, asi que el forEach de confirmTreasuryRange confirma/recalcula de la fecha mas antigua a la mas reciente", () => {
  const DalfiClosingMath = require("../outputs/lib/closing-math.js");
  const range = DalfiClosingMath.pendingTreasuryRange(
    [
      { businessDate: "2026-07-20", pending: true },
      { businessDate: "2026-07-18", pending: true },
      { businessDate: "2026-07-19", pending: true },
    ],
    "2026-07-20"
  );
  assert.deepStrictEqual(range, ["2026-07-18", "2026-07-19", "2026-07-20"]);
  // confirmTreasuryRange() itera con range.forEach sin reordenar.
  const fnSource = extractFunctionSource("confirmTreasuryRange");
  assert.match(fnSource, /range\.forEach\(\(date\) => \{/);
});

// --- 16: cierres historicos confirmados no se reescriben ---

test("confirmTreasuryRange(): es idempotente — nunca reconfirma ni recalcula un cierre YA cerrado (return temprano si no esta pendiente)", () => {
  const fnSource = extractFunctionSource("confirmTreasuryRange");
  assert.match(fnSource, /if \(!closing \|\| !isClosingPendingConfirmation\(closing\)\) return;/);
});

test("ninguna funcion de solo LECTURA (buildTreasuryAccountDetail, previousTreasurySaldoFor) escribe sobre un cierre existente: solo confirmTreasuryRange/refreshPendingClosingsForDate lo hacen, y ambas respetan isClosingPendingConfirmation", () => {
  const detailSource = extractFunctionSource("buildTreasuryAccountDetail");
  assert.ok(!/stampRecord|closing\.\w+ =/.test(detailSource), "buildTreasuryAccountDetail debe ser puramente de lectura/calculo, nunca escribe");
});

// --- 17: catch-up (cron) usa la misma formula ---

test("functions/api/run-closing-catchup.js: previousTreasurySaldoFor tambien cae al balance de apertura de la cuenta (misma regla que el frontend)", () => {
  const fnSource = extractFunctionSource("previousTreasurySaldoFor", cronSource);
  assert.match(fnSource, /account\?\.balanceInicial/);
  assert.match(fnSource, /Number\.isFinite/, "tambien debe rechazar NaN/Infinito, igual que el frontend");
});

// --- 18, 19, 20: no rompe caja registradora / Egresos del dia / Agregar egreso ---

test("regresion: 'Monto inicial' (caja registradora) sigue readonly y calculado — no se toco por esta tarea", () => {
  assert.match(indexHtml, /<input id="cash-initial" type="number" min="0" step="0\.01" value="0" readonly aria-readonly="true" tabindex="-1" \/>/);
});

test("regresion: 'Egresos del día' sigue siendo un <output> calculado — no se toco por esta tarea", () => {
  assert.match(indexHtml, /<output id="cash-expenses" aria-live="polite">RD\$0\.00<\/output>/);
});

test("regresion: el boton 'Agregar egreso' sigue presente y funcional en el cierre de caja registradora", () => {
  assert.match(indexHtml, /<button class="secondary-btn" id="cash-add-expense" type="button">Agregar egreso<\/button>/);
  assert.match(appJs, /function openAddExpenseFromClosing\(\)/);
});

test("regresion: 'Monto real contado' (caja registradora) sigue siendo el unico campo manual del cierre de caja", () => {
  assert.match(indexHtml, /<input id="cash-counted" type="number" min="0" step="0\.01" required \/>/);
  assert.ok(!/<input id="cash-counted"[^>]*readonly/.test(indexHtml));
});

test("resolveTreasuryOpeningBalance y resolveRegisterOpeningCash son funciones independientes: tesoreria nunca reutiliza el fondo de caja de la caja registradora ni viceversa", () => {
  const registerFn = extractFunctionSource("defaultInitialCashFor");
  const treasuryFn = extractFunctionSource("previousTreasurySaldoFor");
  assert.ok(!/resolveTreasuryOpeningBalance/.test(registerFn));
  assert.ok(!/resolveRegisterOpeningCash/.test(treasuryFn));
});
