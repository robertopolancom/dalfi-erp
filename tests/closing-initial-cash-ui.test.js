// Aserciones estaticas sobre la proteccion de "Monto inicial" en la
// interfaz (mismo patron ya usado en tests/roles-ui.test.js,
// tests/forgot-password-flow.test.js, tests/migrations-security.test.js):
// no hay DOM real en este runner (node --test, sin jsdom), asi que la
// proteccion de teclado/rueda/pegado y el "nunca se lee del input al
// guardar" se fijan revisando el texto fuente.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");

function cashInitialInputTag(source) {
  const match = /<input id="cash-initial"[^>]*\/>/.exec(source);
  assert.ok(match, "no se encontro el input #cash-initial");
  return match[0];
}

test("index.html: #cash-initial es readonly (no editable con teclado ni pegado)", () => {
  const tag = cashInitialInputTag(indexHtml);
  assert.match(tag, /\breadonly\b/, "debe tener el atributo readonly");
  assert.match(tag, /aria-readonly="true"/);
  assert.match(tag, /tabindex="-1"/);
});

test("outputs/app.js: la plantilla inyectada de respaldo (ensureCashModuleMarkup) tambien marca #cash-initial como readonly", () => {
  const tag = cashInitialInputTag(appJs);
  assert.match(tag, /\breadonly\b/, "la copia de respaldo del formulario tambien debe ser readonly, si alguna vez se inyecta");
});

test("#cash-initial: no existe ninguna ruta de codigo que le quite 'readonly' o lo habilite condicionalmente (ni por rol, ni por 'canManageInvoices/administradora')", () => {
  assert.ok(!/removeAttribute\(\s*["']readonly["']\s*\)/.test(appJs), "no debe existir codigo que remueva 'readonly' de ningun input");
  assert.ok(!/cash-initial["'`]\)?\.readOnly\s*=\s*false/.test(appJs), "no debe existir codigo que ponga .readOnly = false en cash-initial");
  // setCashFormReadOnly() solo alterna .disabled (readonly ya esta fijo en el HTML de forma incondicional para TODOS los roles, incluida administradora).
  const setReadOnlyMatch = /function setCashFormReadOnly\(readOnly\) \{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(setReadOnlyMatch, "no se encontro setCashFormReadOnly");
  assert.ok(!/readOnly\s*=\s*readOnly/.test(setReadOnlyMatch[0]) || setReadOnlyMatch[0].includes(".disabled"), "setCashFormReadOnly solo debe tocar .disabled, no el atributo readonly");
});

test("#cash-initial: tiene bloqueadores defensivos de teclado, pegado y rueda del mouse (defensa en profundidad ademas de readonly)", () => {
  const wireBlock = /const cashInitialInput = byId\("cash-initial"\);[\s\S]{0,600}/.exec(appJs);
  assert.ok(wireBlock, "no se encontro el bloque que instala los listeners defensivos de cash-initial");
  assert.match(wireBlock[0], /"keydown"/);
  assert.match(wireBlock[0], /"paste"/);
  assert.match(wireBlock[0], /"wheel"/);
  assert.match(wireBlock[0], /event\.preventDefault\(\)/);
});

test("el submit del cierre de caja NUNCA lee byId(\"cash-initial\").value como fuente del monto a guardar (siempre defaultInitialCashFor)", () => {
  const submitBlock = /byId\("cash-form"\)\?\.addEventListener\("submit"[\s\S]*?\n  \}\);/.exec(appJs);
  assert.ok(submitBlock, "no se encontro el handler de submit de cash-form");
  // El patron exacto del bug original: leer y parsear el valor del input
  // como numero para usarlo como monto a guardar. Los comentarios que
  // EXPLICAN por que ya no se hace esto no cuentan (no tienen "Number(" al
  // inicio del patron).
  assert.ok(!/Number\(byId\("cash-initial"\)/.test(submitBlock[0]), "el submit no debe leer/parsear el valor del input de monto inicial como fuente del monto a guardar");
  assert.match(submitBlock[0], /const montoInicial = defaultInitialCashFor\(account, date\);/);
});

test("el submit detecta si el monto inicial confiable cambio desde que se genero el cuadre en pantalla, y bloquea el guardado/confirmacion (no usa un monto esperado desactualizado)", () => {
  const submitBlock = /byId\("cash-form"\)\?\.addEventListener\("submit"[\s\S]*?\n  \}\);/.exec(appJs);
  assert.match(submitBlock[0], /cashBalanceDraft\.montoInicial !== montoInicial/);
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
});

test("cambiar la fecha del cierre recalcula 'Monto inicial' para la nueva fecha (no se queda con el valor de la fecha anterior)", () => {
  const listenerBlock = /\["cash-counted", "cash-expenses", "cash-date", "cash-account"\]\.forEach[\s\S]*?\n  \}\);/.exec(appJs);
  assert.ok(listenerBlock);
  assert.match(listenerBlock[0], /byId\("cash-initial"\)\.value = defaultInitialCashFor\(registerAccount\(\), byId\("cash-date"\)\.value \|\| today\);/);
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
