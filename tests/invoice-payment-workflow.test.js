const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");

function extractFunction(name) {
  const match = new RegExp(`^\\s*(async )?function ${name}\\(`, "m").exec(appJs);
  assert.ok(match, `no se encontro function ${name}`);
  let depth = 0;
  let end = appJs.indexOf("{", match.index);
  for (; end < appJs.length; end += 1) {
    if (appJs[end] === "{") depth += 1;
    if (appJs[end] === "}") {
      depth -= 1;
      if (depth === 0) return appJs.slice(match.index, end + 1);
    }
  }
  throw new Error(`function ${name} incompleta`);
}

// ===========================================================================
// Regresion critica (agosto 2026): Ventas de productos reutiliza la clase
// "invoice-line" para estilos (retail-sale-line, retail-payment-line,
// income-payment-line) y esas lineas EXISTEN en el DOM desde que arranca la
// app (init() las crea una vez, aunque su vista este oculta). Antes de este
// fix, getInvoiceLines()/currentDefaultInvoiceStaff()/
// applyGeneralDiscountPercent() y varios listeners usaban
// document.querySelectorAll(".invoice-line...") SIN acotar a
// #invoice-line-list: la primera linea ajena sin .line-price/.line-service
// hacia lanzar un TypeError (".value" de null) que abortaba el calculo en
// vivo Y el guardado de la factura, en silencio, en TODA factura nueva.
// ===========================================================================

test("getInvoiceLines()/currentDefaultInvoiceStaff()/applyGeneralDiscountPercent() SIEMPRE escopeados a #invoice-line-list, nunca document.querySelectorAll(\".invoice-line\" a secas (evita la colision con retail-sale-line/retail-payment-line/income-payment-line)", () => {
  assert.match(extractFunction("getInvoiceLines"), /byId\("invoice-line-list"\)\.querySelectorAll\(".invoice-line:not\(.payment-line\)"\)/);
  assert.match(extractFunction("currentDefaultInvoiceStaff"), /byId\("invoice-line-list"\)\.querySelector\(".line-staff"\)/);
  assert.match(extractFunction("applyGeneralDiscountPercent"), /byId\("invoice-line-list"\)\.querySelectorAll\(".invoice-line:not\(.payment-line\)"\)/);
  assert.doesNotMatch(appJs, /document\.querySelectorAll\("\.invoice-line:not\(\.payment-line\)"\)/);
  assert.doesNotMatch(appJs, /document\.querySelector\("\.invoice-line:not\(\.payment-line\)"\)/);
  assert.doesNotMatch(appJs, /if \(!document\.querySelector\("\.invoice-line"\)\) addInvoiceLine/);
});

test("init() nunca cuenta lineas ajenas al decidir si agregar la primera linea de servicio o de pago", () => {
  assert.match(appJs, /if \(!byId\("invoice-line-list"\)\.querySelector\("\.invoice-line"\)\) addInvoiceLine\(\);/);
  assert.match(appJs, /if \(!byId\("payment-line-list"\)\.querySelector\("\.payment-line"\)\) addPaymentLine\(\);/);
});

test("el Precio de cada linea de servicio se muestra en formato moneda con signo de pesos (money.format), guardando el numero real aparte en data-raw-value", () => {
  assert.match(extractFunction("addInvoiceLine"), /<input class="line-price" type="text" data-raw-value="0" readonly required \/>/);
  const source = extractFunction("setLinePrice");
  assert.match(source, /input\.dataset\.rawValue = String\(price\)/);
  assert.match(source, /input\.value = money\.format\(price\)/);
  assert.match(extractFunction("getInvoiceLines"), /line\.querySelector\("\.line-price"\)\.dataset\.rawValue/);
});

test("Facturacion separa visualmente los servicios del paso Cobro de esta factura", () => {
  assert.match(indexHtml, /id="continue-to-payment"[^>]*>Continuar al cobro</);
  assert.match(indexHtml, /id="invoice-payment-section"/);
  assert.match(indexHtml, /<h4>Cobro de esta factura<\/h4>/);
  assert.match(indexHtml, /Guardar factura y registrar cobro/);
});

test("la forma de pago debe elegirse explicitamente y no presupone efectivo", () => {
  const source = extractFunction("addPaymentLine");
  assert.match(source, /<select class="payment-method" required>/);
  assert.match(source, /<option value="">Seleccionar forma de pago<\/option>/);
});

test("al elegir la forma de pago se propone exactamente el saldo restante", () => {
  const source = extractFunction("fillRemainingInvoicePayment");
  assert.match(source, /totals\.grandTotal \+ tip - otherPayments/);
  assert.match(appJs, /updatePaymentLineState\(line\);\s*\n\s*fillRemainingInvoicePayment\(line\);\s*\n\s*updateInvoiceTotals\(\);/);
});

test("guardar exige cliente, servicio y forma de pago con mensajes visibles", () => {
  assert.match(appJs, /Selecciona o escribe el cliente antes de continuar al cobro\./);
  assert.match(appJs, /Agrega por lo menos un servicio con su colaboradora antes de continuar al cobro\./);
  assert.match(appJs, /Selecciona la forma de pago antes de guardar la factura\./);
});

test("el cobro confirmado crea el pago y el saldo no confirmado crea CxC", () => {
  assert.match(appJs, /addConfirmedPayment\(invoiceId, clientRecord, client, invoicePortion/);
  assert.match(appJs, /addReceivable\(invoiceId, clientRecord, client, amountForThisLine/);
  assert.match(appJs, /Factura \$\{invoiceId\} guardada y contabilizada/);
});

test("la mesa queda fuera del formulario normal y, si falta, abre la seleccion puntual antes del cobro", () => {
  const invoiceLineSource = extractFunction("addInvoiceLine");
  const stationSource = extractFunction("resolveLineStation");
  assert.doesNotMatch(invoiceLineSource, /line-station|Mesa \/ ubicación/);
  assert.match(appJs, /requestInvoiceStationSelection\(lines\)/);
  assert.match(stationSource, /if \(!assignment\) return \{ stationId: "", stationName: "" \}/);
});

test("una factura con varias manicuristas resuelve una por una todas las asignaciones faltantes", () => {
  const selectionSource = extractFunction("requestInvoiceStationSelection");
  assert.match(selectionSource, /lines\.find\(\(line\) => \{/);
  assert.match(selectionSource, /!activeAssignmentForCollaborator\(staff\.colaboradorID\)/);
  assert.match(selectionSource, /después se comprobarán las demás manicuristas/);
  assert.match(appJs, /window\.setTimeout\(\(\) => byId\("invoice-form"\)\.requestSubmit\(\), 0\);/);
  const stationCheck = appJs.indexOf("requestInvoiceStationSelection(lines)");
  const preflight = appJs.indexOf("buildServiceConsumptionPreflight(lines, consumptionMode)", stationCheck);
  const invoiceMutation = appJs.indexOf('dbTable("facturas").push(invoiceRecord)', preflight);
  assert.ok(stationCheck > -1 && preflight > stationCheck && invoiceMutation > preflight);
});

test("cada linea congela la mesa de su propia manicurista para conservar el historial", () => {
  assert.match(appJs, /const stationRecord = resolveLineStation\(line\.staff\);/);
  assert.match(appJs, /stationId: stationRecord\.stationId \|\| "",\s*\n\s*stationName: stationRecord\.stationName \|\| "",/);
  assert.match(indexHtml, /Las facturas y consumos ya registrados permanecen en la mesa donde se realizaron\./);
});

test("el cambio directo de mesa solo vive en Mesas Turno y libera la asignacion anterior sin reescribir facturas", () => {
  const assignmentStart = appJs.indexOf('byId("turno-assignment-list")?.addEventListener("change"');
  const assignmentEnd = appJs.indexOf('byId("invoice-station-form")?.addEventListener', assignmentStart);
  const assignmentHandler = appJs.slice(assignmentStart, assignmentEnd);
  assert.match(indexHtml, /data-view="turno"[^>]*>Mesas \/ Turno</);
  assert.match(assignmentHandler, /previousCollaboratorAssignment\.estado = "Liberada"/);
  assert.match(assignmentHandler, /logAudit\("mesa_reasignada_turno"/);
  assert.doesNotMatch(assignmentHandler, /facturaDetalle/);
  assert.doesNotMatch(appJs, /Libérala ahí primero/);
});
