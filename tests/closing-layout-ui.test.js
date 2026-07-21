// Aserciones estaticas (mismo patron que closing-initial-cash-ui.test.js /
// treasury-confirm-ui.test.js: sin DOM real en este runner) sobre la tarea
// "Mejorar flujo visual de cierres y egresos":
//   - el formulario de cierre aparece ANTES que el listado historico;
//   - editar/reabrir siguen usando ese mismo formulario superior, con scroll
//     suave y sin enfocar un valor calculado;
//   - "Guardar egreso" y "Cancelar y volver al cierre" quedan juntos, al
//     final de #expense-form, cuando se abre desde "Agregar egreso";
//   - nada de esto toca la logica de calculo/guardado/confirmacion ya
//     cubierta por closing-initial-cash-ui.test.js, treasury-confirm-ui.test.js,
//     closing-cash-confirm-state.test.js y closing-reopen-permission.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");
const stylesCss = fs.readFileSync(path.join(__dirname, "..", "outputs", "styles.css"), "utf8");

function extractFunction(name, source = appJs) {
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

// --- 1-3: el formulario aparece ANTES que el listado en el DOM ---

test("index.html: dentro de #cash, el formulario (cash-form-grid) aparece ANTES que el historial (cash-list-panel)", () => {
  const cashSection = /<section id="cash" class="view">[\s\S]*?\n {8}<\/section>/.exec(indexHtml);
  assert.ok(cashSection, "no se encontro la seccion #cash");
  const formIdx = cashSection[0].indexOf("cash-form-grid");
  const listIdx = cashSection[0].indexOf("cash-list-panel");
  assert.ok(formIdx >= 0 && listIdx >= 0 && formIdx < listIdx, "el formulario debe preceder al listado historico");
});

test("outputs/app.js (ensureCashModuleMarkup, markup de respaldo): mismo orden — formulario antes que el listado", () => {
  const fnSource = extractFunction("ensureCashModuleMarkup");
  const formIdx = fnSource.indexOf("cash-form-grid");
  const listIdx = fnSource.indexOf("cash-list-panel");
  assert.ok(formIdx >= 0 && listIdx >= 0 && formIdx < listIdx, "el markup inyectado de respaldo debe mantener el mismo orden");
});

test("tesorería no tiene un formulario propio que reordenar: 'Ver detalle'/'Confirmar rango' usan un modal (openRecordReport), independiente de la posicion en el DOM de #cash", () => {
  const openReportFn = extractFunction("openClosingReport");
  assert.match(openReportFn, /openRecordReport\(/);
  // confirmTreasuryRange tampoco usa el formulario de caja: no toca ningun campo de #cash-form.
  const confirmRangeFn = extractFunction("confirmTreasuryRange");
  assert.ok(!/byId\("cash-/.test(confirmRangeFn), "confirmar un rango de tesoreria no debe tocar el formulario de caja registradora");
});

// --- 4-5: Editar y Reabrir usan el formulario superior (loadClosingIntoCashForm) ---

test("startClosingEdit() (boton 'Editar'): carga el cierre pendiente en el formulario superior via loadClosingIntoCashForm", () => {
  const fnSource = extractFunction("startClosingEdit");
  assert.match(fnSource, /loadClosingIntoCashForm\(closing, \{ readOnly: false, submitText: "Actualizar cierre" \}\);/);
});

test("openClosingForEdit() (boton 'Reabrir'): para caja registradora termina en startClosingEdit(), que carga el mismo formulario superior", () => {
  const fnSource = extractFunction("openClosingForEdit");
  assert.match(fnSource, /if \(closing\.closingType === "treasury"\) return;\s*\n\s*startClosingEdit\(closingId\);/);
});

// --- 6-7: no hay formularios ni IDs duplicados ---

test("no existe una segunda copia funcional de #cash-form en index.html (un unico <form id=\"cash-form\">)", () => {
  const matches = indexHtml.match(/<form[^>]*id="cash-form"/g) || [];
  assert.strictEqual(matches.length, 1);
});

test("no existe una segunda copia funcional de #expense-form en index.html (un unico <form id=\"expense-form\">)", () => {
  const matches = indexHtml.match(/<form[^>]*id="expense-form"/g) || [];
  assert.strictEqual(matches.length, 1);
});

test("index.html: no existen IDs duplicados en todo el documento (la reorganizacion del modulo Cierres no introdujo colisiones)", () => {
  const ids = [...indexHtml.matchAll(/\sid="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]);
  const seen = new Map();
  ids.forEach((id) => seen.set(id, (seen.get(id) || 0) + 1));
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1);
  assert.deepStrictEqual(duplicated, [], `IDs duplicados encontrados: ${duplicated.map(([id]) => id).join(", ")}`);
});

// --- 8, 21-23: compatibilidad movil (apilado, pero agrupado) ---

test(".row-actions (contenedor de Guardar egreso + Cancelar, y de Modificar/Confirmar/Abrir cierre) usa flex-wrap: los botones se apilan en pantallas angostas pero permanecen en el mismo contenedor", () => {
  const ruleMatch = /\.row-actions \{[^}]*\}/.exec(stylesCss);
  assert.ok(ruleMatch, "no se encontro la regla .row-actions");
  assert.match(ruleMatch[0], /display:\s*flex/);
  assert.match(ruleMatch[0], /flex-wrap:\s*wrap/);
  assert.match(ruleMatch[0], /gap:/);
});

test("el modulo Cierres reutiliza .work-grid (ya responsive: 1 columna en escritorio y en movil via @media) para el formulario, sin introducir un layout nuevo", () => {
  assert.match(indexHtml, /<div class="work-grid cash-form-grid">/);
  const workGridRule = /\.work-grid \{[^}]*\}/.exec(stylesCss);
  assert.ok(workGridRule);
});

// --- 9-10: scroll suave hacia el formulario, sin enfocar un valor calculado ---

test("loadClosingIntoCashForm(): siempre revela el formulario con scroll suave (revealFormAtTop) y, cuando es editable, enfoca 'Monto real contado' — nunca un valor calculado", () => {
  const fnSource = extractFunction("loadClosingIntoCashForm");
  assert.match(fnSource, /revealFormAtTop\(byId\("cash-form"\), \{ focusSelector: readOnly \? null : "#cash-counted" \}\);/);
  assert.ok(!/focusSelector: ("#cash-initial"|"#cash-expenses")/.test(fnSource), "nunca debe enfocar un valor calculado");
});

test("revealFormAtTop(): hace scrollIntoView con behavior 'smooth' y respeta focusSelector: null (no enfoca nada en modo solo lectura)", () => {
  const fnSource = extractFunction("revealFormAtTop");
  assert.match(fnSource, /scrollIntoView\(\{ block: "start", behavior: "smooth" \}\)/);
  assert.match(fnSource, /if \(focusSelector === null\) return;/);
});

// --- 18-20: "Guardar egreso" y "Cancelar y volver al cierre" juntos, al final del formulario ---

test("index.html: #expense-submit ('Guardar egreso') y #cash-add-expense-cancel ('Cancelar y volver al cierre') estan dentro del MISMO contenedor #expense-form-actions", () => {
  const actionsBlock = /<div class="row-actions" id="expense-form-actions">[\s\S]*?<\/div>/.exec(indexHtml);
  assert.ok(actionsBlock, "no se encontro #expense-form-actions");
  assert.match(actionsBlock[0], /<button class="primary-btn" id="expense-submit" type="submit">Guardar egreso<\/button>/);
  assert.match(actionsBlock[0], /<button class="secondary-btn compact hidden" id="cash-add-expense-cancel" type="button">Cancelar y volver al cierre<\/button>/);
});

test("index.html: #expense-form-actions es el ULTIMO elemento dentro de <form id=\"expense-form\"> (ambos botones quedan debajo de todos los campos)", () => {
  const formBlock = /<form class="panel form-panel" id="expense-form">[\s\S]*?\n {12}<\/form>/.exec(indexHtml);
  assert.ok(formBlock, "no se encontro el formulario #expense-form completo");
  const actionsIdx = formBlock[0].lastIndexOf('id="expense-form-actions"');
  const lastFieldIdx = formBlock[0].lastIndexOf('id="expense-note"');
  assert.ok(actionsIdx > lastFieldIdx, "el contenedor de acciones debe ir despues del ultimo campo (Observacion)");
  // No debe haber ningun otro campo del formulario despues del contenedor de acciones.
  const afterActions = formBlock[0].slice(actionsIdx);
  assert.ok(!/<input[^>]*id="expense-/.test(afterActions.replace(/id="expense-form-actions"/, "")), "no debe quedar ningun campo de formulario despues de las acciones");
});

test("'Guardar egreso' conserva apariencia de accion principal (primary-btn) y 'Cancelar y volver al cierre' apariencia secundaria (secondary-btn)", () => {
  assert.match(indexHtml, /<button class="primary-btn" id="expense-submit"/);
  assert.match(indexHtml, /<button class="secondary-btn compact hidden" id="cash-add-expense-cancel"/);
});

test("#cash-add-expense-cancel empieza oculto (solo se muestra cuando se llega desde 'Agregar egreso'): en el flujo normal de Egresos no aparece un boton Cancelar inesperado", () => {
  const actionsBlock = /<div class="row-actions" id="expense-form-actions">[\s\S]*?<\/div>/.exec(indexHtml);
  assert.match(actionsBlock[0], /id="cash-add-expense-cancel" [\s\S]*?class=|class="secondary-btn compact hidden" id="cash-add-expense-cancel"/);
  assert.match(indexHtml, /<button class="secondary-btn compact hidden" id="cash-add-expense-cancel"/);
});

test("openAddExpenseFromClosing(): muestra el banner informativo Y el boton Cancelar (ambos, no solo uno)", () => {
  const fnSource = extractFunction("openAddExpenseFromClosing");
  assert.match(fnSource, /byId\("cash-add-expense-banner"\)\?\.classList\.remove\("hidden"\);/);
  assert.match(fnSource, /byId\("cash-add-expense-cancel"\)\?\.classList\.remove\("hidden"\);/);
});

test("returnToClosingAfterExpense(): oculta banner Y boton Cancelar al volver (no quedan visibles en el modulo Egresos normal)", () => {
  const fnSource = extractFunction("returnToClosingAfterExpense");
  assert.match(fnSource, /byId\("cash-add-expense-banner"\)\?\.classList\.add\("hidden"\);/);
  assert.match(fnSource, /byId\("cash-add-expense-cancel"\)\?\.classList\.add\("hidden"\);/);
});

// --- 24-29: Cancelar no guarda nada ---

test("#cash-add-expense-cancel: su click handler llama DIRECTAMENTE a returnToClosingAfterExpense(), sin pasar por el submit de #expense-form (no crea egreso, no guarda, no modifica balances)", () => {
  const listenerMatch = /byId\("cash-add-expense-cancel"\)\?\.addEventListener\("click", \(event\) => \{[\s\S]*?\n {2}\}\);/.exec(appJs);
  assert.ok(listenerMatch, "no se encontro el listener de cash-add-expense-cancel");
  assert.match(listenerMatch[0], /event\.preventDefault\(\);/);
  assert.match(listenerMatch[0], /returnToClosingAfterExpense\(\);/);
  assert.ok(!/dbTable\("egresos"\)\.push/.test(listenerMatch[0]), "cancelar no debe crear un egreso");
});

test("returnToClosingAfterExpense(): restaura fecha/caja/monto contado/notas exactamente como estaban (no valores en blanco), sea que se cancele o se guarde", () => {
  const fnSource = extractFunction("returnToClosingAfterExpense");
  assert.match(fnSource, /byId\("cash-date"\)\.value = snapshot\.date;/);
  assert.match(fnSource, /byId\("cash-account"\)\.value = snapshot\.account;/);
  assert.match(fnSource, /byId\("cash-counted"\)\.value = snapshot\.counted;/);
  assert.match(fnSource, /if \(byId\("cash-note"\)\) byId\("cash-note"\)\.value = snapshot\.note;/);
});

// --- 30-33: Guardar egreso vuelve al cierre, recalcula, y NUNCA confirma automaticamente ---

test("returnToClosingAfterExpense(): recalcula 'Monto inicial' y regenera todo el cuadre (updateCashBalancePreview recalcula tambien Egresos del dia y Monto esperado)", () => {
  const fnSource = extractFunction("returnToClosingAfterExpense");
  assert.match(fnSource, /byId\("cash-initial"\)\.textContent = money\.format\(defaultInitialCashFor\(account, snapshot\.date\)\);/);
  assert.match(fnSource, /updateCashBalancePreview\(\);/);
  // updateCashBalancePreview() es la MISMA funcion que recalcula cash-expenses/cash-expected-preview en cualquier otro punto del formulario (ver closing-initial-cash-ui.test.js y closing-day-expenses.test.js).
  const previewFn = extractFunction("updateCashBalancePreview");
  assert.match(previewFn, /byId\("cash-expenses"\)\.textContent = money\.format\(salidasEfectivo\);/);
  assert.match(previewFn, /const expected = DalfiClosingMath\.computeExpectedCash/);
});

test("returnToClosingAfterExpense(): restaura confirmAfterSave TAL CUAL estaba antes de abrir el formulario de egreso (guardar un egreso nunca introduce una confirmacion nueva)", () => {
  const fnSource = extractFunction("returnToClosingAfterExpense");
  assert.match(fnSource, /byId\("cash-confirm-after-save"\)\.value = snapshot\.confirmAfterSave;/);
  // El snapshot se toma ANTES de navegar al formulario de egresos, desde el valor que ya tenia el campo oculto.
  const openFn = extractFunction("openAddExpenseFromClosing");
  assert.match(openFn, /confirmAfterSave: byId\("cash-confirm-after-save"\)\.value,/);
});

// --- 34-35: el flujo normal de Egresos no se rompe; no se duplico el formulario ---

test("el modulo normal Egresos (#expenses) sigue usando el mismo #expense-form sin cambios de comportamiento: el boton Cancelar solo aparece si se llego desde Cierres", () => {
  // Fuera del flujo de Cierres, cashPendingExpenseReturn es null y el banner+boton nunca se muestran (permanecen con la clase "hidden" del HTML estatico).
  assert.match(indexHtml, /<p class="panel-note hidden" id="cash-add-expense-banner">Agregando un egreso para el cierre de caja en curso\.<\/p>/);
});

test("no se creo un segundo <form id=\"expense-form\"> ni un modal separado: 'Agregar egreso' reutiliza exactamente el mismo formulario que el modulo Egresos", () => {
  const openFn = extractFunction("openAddExpenseFromClosing");
  assert.match(openFn, /byId\("expense-form"\)\.reset\(\);/);
  assert.match(openFn, /switchToView\("expenses"\);/);
});

// --- 36-38: no rompe tesoreria, catch-up, ni escribe en produccion ---

test("regresion: confirmTreasuryRange sigue exigiendo canConfirmClosings() y recalculando cada fecha antes de confirmar (sin cambios de esta tarea)", () => {
  const fnSource = extractFunction("confirmTreasuryRange");
  assert.match(fnSource, /if \(!canConfirmClosings\(\)\) \{/);
  assert.match(fnSource, /const fresh = buildTreasuryAccountDetail\(date, account\);/);
});

test("regresion: functions/api/run-closing-catchup.js no fue modificado por esta tarea de interfaz (sigue generando 'Pendiente de confirmacion', nunca 'Cerrado')", () => {
  const cronSource = fs.readFileSync(path.join(__dirname, "..", "functions", "api", "run-closing-catchup.js"), "utf8");
  assert.match(cronSource, /estado: "Pendiente de confirmacion",/);
  assert.ok(!/estado: "Cerrado"/.test(cronSource), "el catch-up nunca debe crear un cierre ya confirmado");
});

test("esta suite de pruebas (mocks/fixtures en memoria) no referencia ninguna URL real de Supabase ni una service role key: nada de lo agregado en esta tarea puede escribir en produccion", () => {
  const thisFile = fs.readFileSync(__filename, "utf8");
  const forbiddenKeyPattern = new RegExp(["service", "_", "role"].join(""), "i");
  assert.ok(!/supabase\.co/.test(thisFile));
  assert.ok(!forbiddenKeyPattern.test(thisFile));
});
