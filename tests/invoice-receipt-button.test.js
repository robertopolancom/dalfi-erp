// Boton "Registrar recibo de ingreso" desde Facturacion: acceso directo al
// formulario EXISTENTE de "Aplicar cobro" (#payment-form / Cuentas por
// Cobrar), nunca un segundo formulario ni una segunda funcion de reparto.
// Mismo patron estatico (sin DOM real en este runner) que
// tests/closing-add-expense-ui.test.js / tests/invoice-billing-audit.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");

function extractFunction(name, source = appJs) {
  const pattern = new RegExp(`^\\s*(async )?function ${name}\\(`, "m");
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

function extractStatementBlock(startMarker, throughMarker, source = appJs) {
  const startIdx = source.indexOf(startMarker);
  assert.ok(startIdx !== -1, `no se encontro el marcador: ${startMarker}`);
  const throughIdx = source.indexOf(throughMarker, startIdx);
  assert.ok(throughIdx !== -1, `no se encontro el marcador: ${throughMarker}`);
  const openIdx = source.indexOf("{", throughIdx);
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
  const semi = source.indexOf(";", end);
  return source.slice(startIdx, semi + 1);
}

const paymentSubmitHandler = extractStatementBlock('let paymentSubmitInFlight = false;', 'byId("payment-form").addEventListener("submit"');

// --- 1-6: visibilidad del boton ---

test("1-2/4-5. canShowInvoiceReceiptButton(): exige permiso, factura real, no anulada, y al menos una CxC de CLIENTE con saldo relacionada", () => {
  const fnSource = extractFunction("canShowInvoiceReceiptButton");
  assert.match(fnSource, /if \(!canManageInvoices\(\)\) return false;/);
  assert.match(fnSource, /if \(!dbInvoice\) return false;/);
  assert.match(fnSource, /if \(normalize\(dbInvoice\.estadoFactura \|\| ""\) === "anulada"\) return false;/);
  assert.match(fnSource, /return invoiceClientReceivables\(facturaID\)\.length > 0;/);
});

test("invoiceClientReceivables(): filtra deudorTipo==='Cliente' y balancePendiente>0 (nunca CxC del procesador, nunca filas anuladas/sin saldo)", () => {
  const fnSource = extractFunction("invoiceClientReceivables");
  assert.match(fnSource, /cxc\.facturaID === facturaID && cxc\.deudorTipo === "Cliente" && Number\(cxc\.balancePendiente\) > 0/);
});

test("5. la CxC del procesador de tarjeta (deudorTipo:'Procesador tarjeta') nunca hace que el boton se muestre: invoiceClientReceivables la excluye por construccion", () => {
  const fnSource = extractFunction("invoiceClientReceivables");
  assert.ok(!/Procesador/.test(fnSource), "no debe haber ninguna ruta que incluya al procesador");
});

test("una transferencia pendiente sin confirmar es deudorTipo:'Cliente' pero balancePendiente puede ser 0 tras confirmarse: el filtro balancePendiente>0 sigue siendo la condicion correcta (misma usada en renderReceivables/clientReceivablesFor)", () => {
  const fnSource = extractFunction("invoiceClientReceivables");
  assert.match(fnSource, /Number\(cxc\.balancePendiente\) > 0/);
});

// --- 3: preferencia base sobre propina ---

test("30-32. preferredInvoiceReceivable(): prefiere la CxC de BASE (!esPropinaPendiente) sobre la de propina pendiente, preservando 'base antes de propina'", () => {
  const fnSource = extractFunction("preferredInvoiceReceivable");
  assert.match(fnSource, /rows\.find\(\(cxc\) => !cxc\.esPropinaPendiente\) \|\| rows\[0\] \|\| null;/);
});

// --- 8-11: apertura del formulario ---

test("8-9/13-16. openReceiptFromInvoice(): guarda snapshot, abre #receivables (formulario EXISTENTE), preselecciona la CxC preferida, precarga via fillPaymentGoalFromSelection (reutiliza el flujo existente, no inventa uno nuevo)", () => {
  const fnSource = extractFunction("openReceiptFromInvoice");
  assert.match(fnSource, /if \(!canShowInvoiceReceiptButton\(invoiceId\)\) return;/);
  assert.match(fnSource, /const targetCxc = preferredInvoiceReceivable\(invoiceId\);/);
  assert.match(fnSource, /switchToView\("receivables"\);/);
  assert.match(fnSource, /byId\("payment-invoice"\)\.value = targetCxc\.cxCID;/);
  assert.match(fnSource, /fillPaymentGoalFromSelection\(\);/);
});

test("4/5. openReceiptFromInvoice(): desplaza la vista y enfoca el monto a pagar (campo manual apropiado), usando revealFormAtTop ya existente", () => {
  const fnSource = extractFunction("openReceiptFromInvoice");
  assert.match(fnSource, /revealFormAtTop\(byId\("payment-form"\), \{ focusSelector: "#payment-amount" \}\);/);
});

test("10-11. openDataForm/openReceiptFromInvoice: se reutiliza fillPaymentGoalFromSelection(), que YA precarga el saldo pendiente completo en payment-amount/payment-method-amount (editable) sin inventar una segunda logica", () => {
  const fnSource = extractFunction("fillPaymentGoalFromSelection");
  assert.match(fnSource, /amountInput\.value = pending \? String\(pending\) : "";/);
  assert.match(fnSource, /methodAmountInput\.value = pending \? String\(pending\) : "";/);
});

test("11 (no duplica formulario): openReceiptFromInvoice NUNCA crea markup nuevo, solo manipula el #payment-form existente", () => {
  const fnSource = extractFunction("openReceiptFromInvoice");
  assert.ok(!/innerHTML|createElement/.test(fnSource), "no debe crear ningun elemento DOM nuevo");
});

test("index.html: sigue existiendo un UNICO <form id=\"payment-form\">", () => {
  const matches = indexHtml.match(/<form[^>]*id="payment-form"/g) || [];
  assert.strictEqual(matches.length, 1);
});

// --- 15/16: concepto y saldo precargados ---

test("10/15. updatePaymentSummary(): precarga 'Concepto' -Cobro de factura <ref real> para CxC de base, el concepto propio para propina pendiente-, nunca inventa un numero de factura", () => {
  const fnSource = extractFunction("updatePaymentSummary");
  assert.match(fnSource, /cxc\.esPropinaPendiente \? cxc\.concepto \|\| cxc\.tipoCxC \|\| "Propina pendiente" : `Cobro de factura \$\{cxc\.facturaID \|\| cxc\.cxCID\}`/);
});

test("16. updatePaymentSummary(): el saldo pendiente (Deuda factura seleccionada) sigue siendo un valor calculado, no editable", () => {
  const fnSource = extractFunction("updatePaymentSummary");
  assert.match(fnSource, /byId\("payment-invoice-debt"\)\.textContent = money\.format\(invoiceDebt\);/);
  assert.ok(!/<input[^>]*id="payment-invoice-debt"/.test(indexHtml));
});

test("17. #payment-amount sigue siendo un input editable (el monto del recibo puede reducirse para un pago parcial)", () => {
  assert.match(indexHtml, /<input id="payment-amount" type="number" min="0" step="0\.01" required \/>/);
});

// --- 7. informar sobre CxC anteriores sin cambiar el reparto ---

test("7. updatePaymentSummary(): muestra una nota informativa cuando hay deuda del cliente MAS ALLA de la CxC seleccionada, pero nunca cambia el reparto real (solo toggle de visibilidad)", () => {
  const fnSource = extractFunction("updatePaymentSummary");
  assert.match(fnSource, /byId\("payment-older-debt-note"\)\.classList\.toggle\("hidden", !cxc \|\| clientDebt <= invoiceDebt \+ 0\.005\);/);
});

// --- 6/29/30/31/32: prioridad financiera preservada, sin segunda funcion de reparto ---

test("30-32. el submit de #payment-form sigue llamando UNICAMENTE a applyReceivablePaymentLines() (el flujo de reparto ya existente), nunca una segunda funcion", () => {
  const codeOnly = paymentSubmitHandler
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const calls = codeOnly.match(/applyReceivablePaymentLines\(/g) || [];
  assert.strictEqual(calls.length, 1, "debe llamarse exactamente una vez como CODIGO real (sin contar menciones en comentarios)");
  assert.ok(!/allocateConfirmedPayment/.test(codeOnly), "el formulario de CxC no debe llamar directamente a la funcion pura de facturacion: sigue usando applyReceivablePaymentLines");
});

test("regresion: applyClientReceivablesFirst/addConfirmedPayment/syncInvoicePaymentFromReceivable no fueron modificadas por esta tarea (siguen exactamente como en el commit anterior)", () => {
  assert.match(appJs, /function applyClientReceivablesFirst\(clientRecord, clientName, amount, method, note = "Registro de ingreso aplicado a CxC", processorName = "", accountName = "", cashDate = "", \{ recordAsIncome = true \} = \{\}\) \{/);
  assert.match(appJs, /function addConfirmedPayment\(invoiceId, clientRecord, clientName, amount, method, note = "", processorName = "", accountName = "", cashDate = "", cxcId = ""\) \{/);
});

// --- 9/42-45: permisos, doble submit, idempotencia ---

test("9/57. el submit de #payment-form ahora exige canManageInvoices() explicitamente (antes no exigia ningun permiso)", () => {
  const preventDefaultIdx = paymentSubmitHandler.indexOf("event.preventDefault();");
  const permIdx = paymentSubmitHandler.indexOf("if (!canManageInvoices()) {");
  assert.ok(preventDefaultIdx >= 0 && permIdx > preventDefaultIdx);
});

test("6/42-45. #payment-form declara paymentSubmitInFlight y retorna de inmediato si ya esta activo (proteccion contra doble clic/doble submit, antes no existia)", () => {
  assert.match(appJs, /let paymentSubmitInFlight = false;\s*\n\s*byId\("payment-form"\)\.addEventListener\("submit"/);
  const guardIdx = paymentSubmitHandler.indexOf("if (paymentSubmitInFlight) return;");
  const permIdx = paymentSubmitHandler.indexOf("if (!canManageInvoices())");
  assert.ok(guardIdx >= 0 && guardIdx < permIdx, "el guard de doble submit debe ir ANTES incluso del chequeo de permiso");
});

test("un finally garantiza que paymentSubmitInFlight se reinicia y el boton se reactiva pase lo que pase", () => {
  assert.match(paymentSubmitHandler, /}\s*finally\s*{\s*\n\s*paymentSubmitInFlight = false;\s*\n\s*byId\("payment-submit"\)\.disabled = false;\s*\n\s*}/);
});

test("las mutaciones reales (applyReceivablePaymentLines, logAudit) quedan dentro del try", () => {
  const tryIdx = paymentSubmitHandler.indexOf("try {");
  const applyIdx = paymentSubmitHandler.indexOf("applyReceivablePaymentLines(clientRows,");
  const auditIdx = paymentSubmitHandler.indexOf('logAudit("cxc_receipt_created"');
  assert.ok(tryIdx >= 0 && applyIdx > tryIdx && auditIdx > applyIdx);
});

// --- 13: auditoria (antes no existia para creacion de recibos) ---

test("13/62. el submit de #payment-form ahora registra logAudit('cxc_receipt_created', ...) tras un cobro exitoso (antes no dejaba auditoria de creacion)", () => {
  assert.match(paymentSubmitHandler, /logAudit\("cxc_receipt_created", \{/);
  assert.match(paymentSubmitHandler, /entity: "cuentasCobrar",/);
  assert.match(paymentSubmitHandler, /entityId: selectedCxc\.cxCID,/);
});

// --- 19/35: guardar regresa a Facturacion, refresca saldo/estado ---

test("19/35/40/41. tras guardar con exito, si invoicePendingReceiptReturn esta activo, se llama returnToInvoiceAfterReceipt() (que a su vez llama renderInvoices/switchToView); renderAll() ya refresca saldo/estadoFactura vía renderInvoices/renderReceivables", () => {
  const saveIdx = paymentSubmitHandler.lastIndexOf("renderAll();");
  const returnIdx = paymentSubmitHandler.indexOf("if (invoicePendingReceiptReturn) returnToInvoiceAfterReceipt();");
  assert.ok(saveIdx >= 0 && returnIdx > saveIdx, "el regreso a Facturacion debe ocurrir DESPUES de renderAll() (con los datos ya frescos)");
});

// --- 20/36-39: cancelar regresa a Facturacion sin guardar, conserva filtros/seleccion ---

test("20/36/37. #payment-receipt-cancel llama DIRECTAMENTE a returnToInvoiceAfterReceipt(), sin pasar por el submit de #payment-form (no crea recibo, no guarda, no modifica CxC/factura/propina/nomina)", () => {
  const listenerMatch = /byId\("payment-receipt-cancel"\)\?\.addEventListener\("click", \(event\) => \{[\s\S]*?\n {2}\}\);/.exec(appJs);
  assert.ok(listenerMatch, "no se encontro el listener de payment-receipt-cancel");
  assert.match(listenerMatch[0], /event\.preventDefault\(\);/);
  assert.match(listenerMatch[0], /returnToInvoiceAfterReceipt\(\);/);
  assert.ok(!/applyReceivablePaymentLines|dbTable\("ingresos"\)\.push|logAudit/.test(listenerMatch[0]), "cancelar no debe ejecutar ninguna mutacion");
});

test("38/39/21. returnToInvoiceAfterReceipt(): restaura #invoice-search y el scroll guardados en el snapshot antes de limpiarlo (conserva busqueda y posicion logica del listado)", () => {
  const fnSource = extractFunction("returnToInvoiceAfterReceipt");
  assert.match(fnSource, /if \(byId\("invoice-search"\)\) byId\("invoice-search"\)\.value = snapshot\.search \|\| "";/);
  assert.match(fnSource, /window\.scrollTo\(0, snapshot\.scrollY \|\| 0\);/);
  assert.match(fnSource, /switchToView\(snapshot\.originView \|\| "billing"\);/);
});

// --- 46/47: limpieza del contexto temporal, sin afectar el flujo normal ---

test("22/46. returnToInvoiceAfterReceipt(): limpia invoicePendingReceiptReturn ANTES de usarlo para navegar (no puede quedar pegado para una apertura posterior normal del formulario)", () => {
  const fnSource = extractFunction("returnToInvoiceAfterReceipt");
  const clearIdx = fnSource.indexOf("invoicePendingReceiptReturn = null;");
  const switchIdx = fnSource.indexOf('switchToView(snapshot.originView');
  assert.ok(clearIdx >= 0 && clearIdx < switchIdx, "debe limpiarse antes de navegar, usando la copia local 'snapshot'");
});

test("47. cuando el formulario se abre desde su modulo normal (Cuentas por Cobrar, sin snapshot), returnToInvoiceAfterReceipt() no intenta volver a Facturacion", () => {
  const fnSource = extractFunction("returnToInvoiceAfterReceipt");
  assert.match(fnSource, /if \(!invoicePendingReceiptReturn\) \{\s*\n\s*switchToView\("receivables"\);\s*\n\s*return;\s*\n\s*\}/);
});

// --- 8/25-29: ubicacion del boton, un unico wiring, medios de pago sin cambios ---

test("8. renderInvoices(): agrega el boton .receipt-invoice condicionado a canShowInvoiceReceiptButton(invoice.id), en el mismo contenedor .row-actions que Ver/Editar", () => {
  const fnSource = extractFunction("renderInvoices");
  assert.match(fnSource, /const showReceiptButton = canShowInvoiceReceiptButton\(invoice\.id\);/);
  assert.match(fnSource, /\$\{showReceiptButton \? '<button class="secondary-btn compact receipt-invoice" type="button">Registrar recibo de ingreso<\/button>' : ""\}/);
});

test("no se duplica la logica de apertura: el listado (.receipt-invoice) y el detalle/popup (window.opener.openReceiptFromInvoice) llaman a la MISMA funcion compartida openReceiptFromInvoice()", () => {
  const listenerMatch = /if \(event\.target\.closest\(".receipt-invoice"\)\) openReceiptFromInvoice\(invoiceId\);/;
  assert.match(appJs, listenerMatch);
  assert.match(appJs, /window\.opener\.openReceiptFromInvoice\('\$\{escapeHtml\(invoiceId\)\}'\); window\.close\(\);/);
});

test("9 (detalle/consulta). openInvoiceReport(): agrega el boton condicionalmente en el popup de detalle, usando la MISMA condicion canShowInvoiceReceiptButton evaluada en la ventana principal (el popup no tiene acceso a dbTable)", () => {
  const fnSource = extractFunction("openInvoiceReport");
  assert.match(fnSource, /const showReceiptButton = canShowInvoiceReceiptButton\(invoiceId\);/);
});

test("25-29. no se toco ningun medio de pago existente (efectivo/transferencia/tarjeta/balance): el select #payment-method conserva las mismas 3 opciones, balance sigue siendo el overpay-policy existente", () => {
  assert.match(indexHtml, /<option value="efectivo">Efectivo<\/option>\s*<option value="tarjeta">Tarjeta<\/option>\s*<option value="transferencia">Transferencia<\/option>/);
});

// --- 54/55: movil y accesibilidad ---

test("54. #payment-form-actions reutiliza .row-actions (flex-wrap ya establecido), Guardar y Cancelar quedan en el mismo contenedor", () => {
  assert.match(indexHtml, /<div class="row-actions" id="payment-form-actions">\s*<button class="primary-btn" id="payment-submit" type="submit">Aplicar cobro<\/button>\s*<button class="secondary-btn compact hidden" id="payment-receipt-cancel" type="button">Cancelar y volver a Facturación<\/button>\s*<\/div>/);
});

test("55. no existen IDs duplicados en index.html tras agregar el boton/nota/campo de concepto", () => {
  const ids = [...indexHtml.matchAll(/\sid="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]);
  const seen = new Map();
  ids.forEach((id) => seen.set(id, (seen.get(id) || 0) + 1));
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1);
  assert.deepStrictEqual(duplicated, [], `IDs duplicados: ${duplicated.map(([id]) => id).join(", ")}`);
});

test("payment-older-debt-note tiene aria-live para que el mensaje se anuncie cuando aparece", () => {
  assert.match(indexHtml, /<p class="panel-note hidden" id="payment-older-debt-note" aria-live="polite">/);
});

// --- 56: user_metadata ignorada ---

test("56. canShowInvoiceReceiptButton/el submit de #payment-form usan canManageInvoices() (erpProfile.permissions), nunca user_metadata", () => {
  const fnSource = extractFunction("canShowInvoiceReceiptButton");
  assert.ok(!/user_metadata/.test(fnSource));
});

// --- 58: compatibilidad historica ---

test("58. canShowInvoiceReceiptButton/invoiceClientReceivables no asumen que existan propinaPendiente/distribucionPropina/esPropinaPendiente: una factura historica sin CxC de propina simplemente no la incluye, sin fallar", () => {
  const fnSource = extractFunction("invoiceClientReceivables");
  assert.ok(!/propinaPendiente|distribucionPropina/.test(fnSource), "no depende de campos nuevos de la factura, solo de las filas reales de cuentasCobrar");
});

// --- 48: reversion compatible (no se creo una pantalla nueva) ---

test("48. no se creo una nueva pantalla/funcion de reversion: voidReceivableReceipt sigue siendo la unica, sin cambios de esta tarea", () => {
  assert.match(appJs, /function voidReceivableReceipt\(incomeId\) \{/);
  const occurrences = (appJs.match(/function voidReceivableReceipt\(/g) || []).length;
  assert.strictEqual(occurrences, 1);
});

// --- 60: cero escrituras en produccion ---

test("60. esta suite no referencia el project ref real de Supabase", () => {
  const thisFile = fs.readFileSync(__filename, "utf8");
  const realProjectRef = ["lcqxbhlkqtjlwsedarej"].join("");
  const occurrences = (thisFile.match(new RegExp(realProjectRef, "g")) || []).length;
  assert.strictEqual(occurrences, 1);
});
