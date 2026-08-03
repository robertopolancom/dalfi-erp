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
