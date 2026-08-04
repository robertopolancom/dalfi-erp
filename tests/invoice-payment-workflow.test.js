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
