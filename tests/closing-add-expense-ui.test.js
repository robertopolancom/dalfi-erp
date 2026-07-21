// Aserciones estaticas (mismo patron que tests/closing-initial-cash-ui.test.js
// y tests/roles-ui.test.js: sin DOM real en este runner) sobre:
//   - "Gastos del dia" -> "Egresos del dia", ya no editable;
//   - el boton "Agregar egreso" y su flujo de precarga/cancelar/volver;
//   - que reutiliza el formulario NORMAL de egresos (no uno nuevo);
//   - permisos y bloqueo en cierres confirmados.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");

function extractFunctionSource(name) {
  const pattern = new RegExp(`^(async )?function ${name}\\(`, "m");
  const match = pattern.exec(appJs);
  assert.ok(match, `no se encontro function ${name}`);
  let parenDepth = 0;
  let afterParams = appJs.indexOf("(", match.index);
  for (; afterParams < appJs.length; afterParams++) {
    if (appJs[afterParams] === "(") parenDepth++;
    else if (appJs[afterParams] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        afterParams++;
        break;
      }
    }
  }
  let depth = 0;
  let end = appJs.indexOf("{", afterParams);
  for (; end < appJs.length; end++) {
    if (appJs[end] === "{") depth++;
    else if (appJs[end] === "}") {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  return appJs.slice(match.index, end);
}

// --- 1-2: "Egresos del dia" reemplaza a "Gastos del dia" en toda la UI visible ---

test("index.html: ya NO aparece 'Gastos del día' en ningun lado", () => {
  assert.ok(!/Gastos del día/.test(indexHtml));
});

test("outputs/app.js (markup inyectado de respaldo): ya NO aparece 'Gastos del día'", () => {
  assert.ok(!/Gastos del día/.test(appJs));
});

test("index.html: aparece 'Egresos del día' como etiqueta del campo calculado", () => {
  assert.match(indexHtml, /Egresos del día — calculado, no editable/);
});

// --- 3-4: sin input editable; se renderiza como elemento no editable ---

test("index.html: NO existe ningun <input type=\"number\"> para Egresos del dia (cash-expenses)", () => {
  assert.ok(!/<input id="cash-expenses"/.test(indexHtml), "no debe existir un <input> con ese id");
  assert.match(indexHtml, /<output id="cash-expenses" aria-live="polite">RD\$0\.00<\/output>/);
});

test("outputs/app.js (markup inyectado de respaldo): tambien usa <output>, no <input>, para cash-expenses", () => {
  assert.ok(!/<input id="cash-expenses"/.test(appJs));
  assert.match(appJs, /<output id="cash-expenses" aria-live="polite">RD\$0\.00<\/output>/);
});

test("no queda ningun input editable oculto por CSS: cash-expenses no aparece nunca como <input>, ni siquiera con clase hidden", () => {
  assert.ok(!/<input[^>]*id="cash-expenses"/.test(indexHtml + appJs));
});

// --- 5: sin egresos, RD$0.00 ---

test("el valor inicial estatico de #cash-expenses es 'RD$0.00' (antes de cualquier calculo)", () => {
  assert.match(indexHtml, /<output id="cash-expenses"[^>]*>RD\$0\.00<\/output>/);
});

// --- 17-19: el submit/preview nunca leen el DOM, y manipular el DOM no cambia lo guardado ---

test("updateCashBalancePreview(): calcula Egresos del dia con accountActivityForDate, nunca lee byId(\"cash-expenses\")", () => {
  const fnSource = extractFunctionSource("updateCashBalancePreview");
  assert.ok(!/Number\(byId\("cash-expenses"\)/.test(fnSource), "no debe leer/parsear el valor de cash-expenses");
  assert.match(fnSource, /const salidasEfectivo = activity\.expenses \+ activity\.transferOut;/);
  assert.match(fnSource, /byId\("cash-expenses"\)\.textContent = money\.format\(salidasEfectivo\);/);
});

test("submit de cash-form: closingPayload.egresos SIEMPRE es salidasEfectivo (calculado), nunca leido del DOM", () => {
  const submitBlock = /byId\("cash-form"\)\?\.addEventListener\("submit"[\s\S]*?\n  \}\);/.exec(appJs)[0];
  assert.ok(!/Number\(byId\("cash-expenses"\)/.test(submitBlock), "el submit no debe leer cash-expenses del DOM");
  assert.match(submitBlock, /egresos: salidasEfectivo,/);
});

test("manipular el DOM de #cash-expenses no puede cambiar lo que se guarda: el elemento ni siquiera tiene .value (es <output>, no <input>)", () => {
  // Prueba de diseño: como #cash-expenses ahora es <output>, un script que
  // le asignara .value no afectaria ninguna lectura del submit (que usa
  // exclusivamente accountActivityForDate(), nunca el DOM).
  assert.ok(!/byId\("cash-expenses"\)\.value/.test(appJs), "ningun codigo debe leer o escribir .value en el output de egresos");
});

// --- 7: boton "Agregar egreso" existe dentro del formulario de cierre ---

test("index.html: el boton 'Agregar egreso' esta dentro del formulario de cierre (#cash-form)", () => {
  const formMatch = /<form class="panel form-panel hidden" id="cash-form">[\s\S]*?<\/form>/.exec(indexHtml);
  assert.ok(formMatch, "no se encontro #cash-form");
  assert.match(formMatch[0], /<button class="secondary-btn" id="cash-add-expense" type="button">Agregar egreso<\/button>/);
});

// --- 11 (reutiliza el formulario normal, misma logica de guardado) ---

test("openAddExpenseFromClosing(): abre el MISMO #expense-form existente (no crea un formulario nuevo), y reutiliza switchToView", () => {
  const fnSource = extractFunctionSource("openAddExpenseFromClosing");
  assert.match(fnSource, /byId\("expense-form"\)\.reset\(\);/);
  assert.match(fnSource, /switchToView\("expenses"\);/);
  assert.ok(!/expense-form-2|expense-form-clone|new Form/.test(fnSource), "no debe crear un formulario paralelo");
});

test("el submit real de #expense-form (guardado/validaciones/auditoria) es el UNICO usado: openAddExpenseFromClosing no define su propio submit handler", () => {
  const fnSource = extractFunctionSource("openAddExpenseFromClosing");
  assert.ok(!/addEventListener\("submit"/.test(fnSource), "no debe registrar un submit handler propio: reutiliza el existente de #expense-form");
});

// --- 12: precarga fecha y cuenta ---

test("openAddExpenseFromClosing(): precarga fecha y cuenta de origen desde el cierre en curso", () => {
  const fnSource = extractFunctionSource("openAddExpenseFromClosing");
  assert.match(fnSource, /byId\("expense-date"\)\.value = cashPendingExpenseReturn\.date \|\| today;/);
  assert.match(fnSource, /byId\("expense-source"\)\.value = cashPendingExpenseReturn\.account \|\| "";/);
});

test("openAddExpenseFromClosing(): el resto de los campos del egreso quedan en blanco (reset), no arrastra datos de una edicion anterior", () => {
  const fnSource = extractFunctionSource("openAddExpenseFromClosing");
  assert.match(fnSource, /byId\("expense-form"\)\.reset\(\);/);
  assert.match(fnSource, /byId\("expense-edit-id"\)\.value = "";/);
});

// --- 8, 13: conserva monto real contado / no guarda el cierre solo por abrir el formulario ---

test("openAddExpenseFromClosing(): guarda un snapshot del formulario de cierre (fecha, cuenta, monto real contado, notas) SIN llamar a saveState/guardar el cierre", () => {
  const fnSource = extractFunctionSource("openAddExpenseFromClosing");
  assert.match(fnSource, /counted: byId\("cash-counted"\)\.value,/);
  assert.ok(!/saveState\(\)/.test(fnSource), "abrir el formulario de egreso nunca debe guardar el cierre");
  assert.ok(!/dbTable\("cierres"\)\.push/.test(fnSource), "abrir el formulario de egreso nunca debe crear un cierre");
});

// --- 13-14, 27-28: cancelar vuelve sin crear nada ---

test("index.html: existe el boton 'Cancelar y volver al cierre' dentro de #expense-form", () => {
  const formMatch = /<form class="panel form-panel" id="expense-form">[\s\S]*?<\/form>/.exec(indexHtml);
  assert.ok(formMatch);
  assert.match(formMatch[0], /id="cash-add-expense-cancel"/);
  assert.match(formMatch[0], /Cancelar y volver al cierre/);
});

test("el boton Cancelar llama a returnToClosingAfterExpense() directamente (nunca al submit del formulario, nunca guarda nada)", () => {
  const wireMatch = /byId\("cash-add-expense-cancel"\)\?\.addEventListener\("click", \(event\) => \{[\s\S]*?\}\);/.exec(appJs);
  assert.ok(wireMatch, "no se encontro el listener de cancelar");
  assert.match(wireMatch[0], /event\.preventDefault\(\);/);
  assert.match(wireMatch[0], /returnToClosingAfterExpense\(\);/);
});

test("returnToClosingAfterExpense(): restaura fecha, cuenta, monto contado y notas exactamente como estaban (snapshot), no valores en blanco", () => {
  const fnSource = extractFunctionSource("returnToClosingAfterExpense");
  assert.match(fnSource, /byId\("cash-date"\)\.value = snapshot\.date;/);
  assert.match(fnSource, /byId\("cash-account"\)\.value = snapshot\.account;/);
  assert.match(fnSource, /byId\("cash-counted"\)\.value = snapshot\.counted;/);
});

// --- 5/9: guardar recalcula el cierre automaticamente ---

test("el submit de #expense-form (ambos caminos de exito, crear y editar) llama a returnToClosingAfterExpense() cuando se llego desde el cierre", () => {
  const submitBlock = /byId\("expense-form"\)\.addEventListener\("submit"[\s\S]*?\n  \}\);/.exec(appJs)[0];
  const occurrences = submitBlock.match(/if \(cashPendingExpenseReturn\) returnToClosingAfterExpense\(\);/g) || [];
  assert.strictEqual(occurrences.length, 2, "debe engancharse en el camino de creacion Y en el de edicion");
});

test("returnToClosingAfterExpense(): recalcula Monto inicial y regenera el cuadre (updateCashBalancePreview) al volver, reflejando el egreso recien agregado", () => {
  const fnSource = extractFunctionSource("returnToClosingAfterExpense");
  assert.match(fnSource, /byId\("cash-initial"\)\.value = defaultInitialCashFor\(account, snapshot\.date\);/);
  assert.match(fnSource, /updateCashBalancePreview\(\);/);
});

// --- 22-24: permisos y bloqueo en cierre confirmado ---

test("updateAddExpenseButtonState(): reutiliza canManageInvoices() (el permiso operativo mas cercano ya existente), no inventa uno nuevo", () => {
  const fnSource = extractFunctionSource("updateAddExpenseButtonState");
  assert.match(fnSource, /const hasPermission = canManageInvoices\(\);/);
});

test("updateAddExpenseButtonState(): oculta y deshabilita el boton cuando el cierre YA esta confirmado, sin importar el permiso", () => {
  const fnSource = extractFunctionSource("updateAddExpenseButtonState");
  assert.match(fnSource, /const confirmed = Boolean\(closing\) && !isClosingPendingConfirmation\(closing\);/);
  assert.match(fnSource, /const canAdd = hasPermission && !confirmed;/);
  assert.match(fnSource, /button\.classList\.toggle\("hidden", !canAdd\);/);
  assert.match(fnSource, /button\.disabled = !canAdd;/);
});

test("index.html: existe la nota explicativa para cuando el cierre esta confirmado", () => {
  assert.match(indexHtml, /id="cash-add-expense-closed-note"/);
  assert.match(indexHtml, /Este cierre ya está confirmado/);
});

test("openAddExpenseFromClosing(): rechaza abrir el formulario si el cierre en curso ya esta confirmado (no pendiente)", () => {
  const fnSource = extractFunctionSource("openAddExpenseFromClosing");
  assert.match(fnSource, /if \(closing && !isClosingPendingConfirmation\(closing\)\) return;/);
});

test("loadClosingIntoCashForm(): llama a updateAddExpenseButtonState(closing) para reflejar permiso + estado del cierre que se esta cargando", () => {
  const fnSource = extractFunctionSource("loadClosingIntoCashForm");
  assert.match(fnSource, /updateAddExpenseButtonState\(closing\);/);
});

test("showNewCashClosing()/hideCashClosingForm(): tambien actualizan el estado del boton (cierre nuevo o formulario cerrado)", () => {
  const showSource = extractFunctionSource("showNewCashClosing");
  assert.match(showSource, /updateAddExpenseButtonState\(null\);/);
  const hideSource = extractFunctionSource("hideCashClosingForm");
  assert.match(hideSource, /updateAddExpenseButtonState\(null\);/);
});

// --- 39: Monto inicial sigue calculado y no editable (regresion de la tarea anterior) ---

test("regresion: #cash-initial sigue siendo readonly (no se toco por accidente en esta tarea)", () => {
  assert.match(indexHtml, /<input id="cash-initial" type="number" min="0" step="0\.01" value="0" readonly aria-readonly="true" tabindex="-1" \/>/);
});

// --- Monto real contado sigue siendo el unico campo manual ---

test("regresion: #cash-counted sigue siendo un input editable normal (el unico valor manual del cierre)", () => {
  assert.match(indexHtml, /<input id="cash-counted" type="number" min="0" step="0\.01" required \/>/);
  assert.ok(!/<input id="cash-counted"[^>]*readonly/.test(indexHtml), "cash-counted NUNCA debe ser readonly");
});

// --- 38: cierre de tesoreria no se rompe (no comparte esta logica, sigue igual) ---

test("cierre de tesoreria: no se agrego ningun boton 'Agregar egreso' ahi (esta funcion es especifica del cierre de caja registradora)", () => {
  assert.ok(!/treasuryClosingRowHtml[\s\S]{0,2000}cash-add-expense/.test(appJs));
});
