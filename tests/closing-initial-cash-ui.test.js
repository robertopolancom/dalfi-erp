// Aserciones estaticas sobre la proteccion de "Monto inicial" en la
// interfaz (mismo patron ya usado en tests/roles-ui.test.js,
// tests/forgot-password-flow.test.js, tests/migrations-security.test.js):
// no hay DOM real en este runner (node --test, sin jsdom), asi que la
// proteccion de "no editable" y el "nunca se lee del elemento al guardar"
// se fijan revisando el texto fuente.
//
// Historial: originalmente #cash-initial era un <input type="number"
// readonly>. La tarea "Mejorar flujo visual de cierres y egresos" lo
// convirtio a <output> (igual que #cash-expenses) porque, aunque ya no era
// editable, seguia teniendo apariencia de campo de formulario. Este archivo
// cubre el estado actual; la proteccion original (nunca leido del DOM al
// guardar, recalculo en cada cambio de fecha/cuenta, valores historicos sin
// reescritura) se conserva integra.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");

function cashInitialOutputTag(source) {
  const match = /<output id="cash-initial"[^>]*>[^<]*<\/output>/.exec(source);
  assert.ok(match, "no se encontro el <output> #cash-initial");
  return match[0];
}

test("index.html: #cash-initial es un <output>, no un <input> (no editable con teclado ni pegado porque no es un control de formulario)", () => {
  assert.ok(!/<input[^>]*id="cash-initial"/.test(indexHtml), "no debe existir un <input> con ese id");
  const tag = cashInitialOutputTag(indexHtml);
  assert.match(tag, /class="calculated-value readonly-hint"/);
  assert.match(tag, /aria-live="polite"/);
});

test("outputs/app.js: la plantilla inyectada de respaldo (ensureCashModuleMarkup) tambien usa <output>, no <input>, para #cash-initial", () => {
  assert.ok(!/<input[^>]*id="cash-initial"/.test(appJs), "la copia de respaldo tampoco debe tener un <input> con ese id");
  const tag = cashInitialOutputTag(appJs);
  assert.match(tag, /class="calculated-value readonly-hint"/);
});

test("#cash-initial: no existe ninguna ruta de codigo que lo convierta de vuelta en un <input> editable (ni por rol, ni por 'canManageInvoices/administradora')", () => {
  assert.ok(!/cash-initial["'`]\)?\.readOnly\s*=\s*false/.test(appJs), "no debe existir codigo que ponga .readOnly = false en cash-initial");
  assert.ok(!/byId\("cash-initial"\)\.disabled\s*=/.test(appJs), "un <output> no tiene .disabled: no debe tratarse como si fuera un input");
  // setCashFormReadOnly() ya no incluye "cash-initial" en su lista de campos (ver cashFormFieldIds()): un <output> no tiene .disabled que alternar.
  // Se filtran las lineas de comentario: la funcion menciona "cash-initial"
  // en un comentario explicativo, no como entrada real del array.
  const fieldIdsMatch = /function cashFormFieldIds\(\) \{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(fieldIdsMatch, "no se encontro cashFormFieldIds");
  const codeLines = fieldIdsMatch[0].split("\n").filter((line) => !line.trim().startsWith("//"));
  assert.ok(!codeLines.some((line) => line.includes('"cash-initial"')), "cash-initial ya no debe estar en la lista de campos con .disabled");
});

test("#cash-initial: ya no requiere bloqueadores defensivos de teclado/pegado/rueda (un <output> no puede recibir foco, teclado, pegado ni rueda)", () => {
  assert.ok(!/const cashInitialInput = byId\("cash-initial"\);/.test(appJs), "ya no debe existir la variable que instalaba los listeners defensivos (innecesarios sobre un <output>)");
});

test("el submit del cierre de caja NUNCA lee byId(\"cash-initial\") como fuente del monto a guardar (siempre defaultInitialCashFor)", () => {
  const submitBlock = /byId\("cash-form"\)\?\.addEventListener\("submit"[\s\S]*?\n  \}\);/.exec(appJs);
  assert.ok(submitBlock, "no se encontro el handler de submit de cash-form");
  // El patron exacto del bug original: leer y parsear el valor del elemento
  // como numero para usarlo como monto a guardar. Los comentarios que
  // EXPLICAN por que ya no se hace esto no cuentan (no tienen "Number(" al
  // inicio del patron).
  assert.ok(!/Number\(byId\("cash-initial"\)/.test(submitBlock[0]), "el submit no debe leer/parsear el valor de #cash-initial como fuente del monto a guardar");
  assert.match(submitBlock[0], /const montoInicial = defaultInitialCashFor\(account, date\);/);
});

test("el submit detecta si el cuadre esperado (fuente confiable: monto inicial + ingresos - egresos) cambio desde que se genero en pantalla, y bloquea el guardado/confirmacion", () => {
  const submitBlock = /byId\("cash-form"\)\?\.addEventListener\("submit"[\s\S]*?\n  \}\);/.exec(appJs);
  // La comparacion es sobre "expected" (no solo montoInicial): asi tambien
  // detecta que cambiaron los egresos del dia (p. ej. por el boton "Agregar
  // egreso"), no solo un cierre anterior nuevo.
  assert.match(submitBlock[0], /cashBalanceDraft\.expected !== expected/);
  assert.match(submitBlock[0], /return;/);
});

test("loadClosingIntoCashForm: para un cierre editable (no readOnly) recalcula el monto inicial desde la fuente confiable, nunca prioriza closing.balanceInicial ya guardado", () => {
  const fnMatch = /function loadClosingIntoCashForm\([\s\S]*?\n\}/.exec(appJs);
  assert.ok(fnMatch, "no se encontro loadClosingIntoCashForm");
  assert.match(
    fnMatch[0],
    /const montoInicialForForm = readOnly \? Number\(closing\.balanceInicial\) \|\| 0 : defaultInitialCashFor\(account, date\);/,
    "solo en modo readOnly (cierre confirmado, solo lectura) se debe mostrar el valor historico guardado; en cualquier otro caso debe recalcularse"
  );
  assert.match(fnMatch[0], /byId\("cash-initial"\)\.textContent = money\.format\(montoInicialForForm\);/);
});

test("cambiar la fecha del cierre recalcula 'Monto inicial' y 'Egresos del día' para la nueva fecha (no se quedan con el valor de la fecha anterior)", () => {
  const listenerBlock = /\["cash-counted", "cash-date", "cash-account"\]\.forEach[\s\S]*?\n  \}\);/.exec(appJs);
  assert.ok(listenerBlock, "no se encontro el listener de cash-date/cash-counted/cash-account");
  assert.match(listenerBlock[0], /byId\("cash-initial"\)\.textContent = money\.format\(defaultInitialCashFor\(account, newDate\)\);/);
  assert.match(listenerBlock[0], /byId\("cash-expenses"\)\.textContent = money\.format\(activity\.expenses \+ activity\.transferOut\);/);
});

test("functions/api/run-closing-catchup.js: el cron tambien usa el balance de apertura de la cuenta como respaldo (misma regla que el frontend)", () => {
  const cronSource = fs.readFileSync(path.join(__dirname, "..", "functions", "api", "run-closing-catchup.js"), "utf8");
  const fnMatch = /function defaultInitialCashFor\(data, account, beforeDate\) \{[\s\S]*?\n\}/.exec(cronSource);
  assert.ok(fnMatch, "no se encontro defaultInitialCashFor en run-closing-catchup.js");
  assert.match(fnMatch[0], /account\?\.balanceInicial/);
});

test("cierres de TESORERÍA: no existe ningun input editable para su 'saldo inicial' (nunca tuvieron este defecto; siguen siendo solo texto calculado)", () => {
  assert.ok(!/<input[^>]*saldo-?[Ii]nicial/i.test(indexHtml), "no debe existir un input editable de saldo inicial para tesoreria en index.html");
  assert.ok(!/<input[^>]*saldo-?[Ii]nicial/i.test(appJs), "no debe existir un input editable de saldo inicial para tesoreria en app.js");
  // El renderizado de saldoInicial de tesoreria sigue siendo texto plano (td/strong), no un input.
  assert.match(appJs, /<td>\$\{money\.format\(Number\(row\.saldoInicial\) \|\| 0\)\}<\/td>/);
});

test("cierres historicos ya confirmados: verla en modo readOnly nunca reescribe balanceInicial (solo lo muestra)", () => {
  const fnMatch = /function loadClosingIntoCashForm\([\s\S]*?\n\}/.exec(appJs);
  const bodyBeforeInitial = fnMatch[0].slice(0, fnMatch[0].indexOf("montoInicialForForm"));
  assert.ok(!/existingClosing\.balanceInicial\s*=/.test(bodyBeforeInitial) && !/closing\.balanceInicial\s*=/.test(fnMatch[0]), "cargar un cierre en el formulario no debe escribir sobre closing.balanceInicial");
});
