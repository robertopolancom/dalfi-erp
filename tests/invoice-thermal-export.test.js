const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");

test("Facturación muestra un botón Exportar por factura en la vista operativa y administrativa", () => {
  assert.match(appJs, /class="secondary-btn compact export-invoice"/);
  assert.match(appJs, /class="secondary-btn compact export-invoice-admin"/);
  assert.match(appJs, /event\.target\.closest\("\.export-invoice"\)\) openInvoiceReport\(invoiceId\)/);
  assert.match(appJs, /event\.target\.closest\("\.export-invoice-admin"\)\) openInvoiceReport\(invoiceId\)/);
});

test("el reporte imprimible está preparado para papel térmico de 80 mm", () => {
  assert.match(appJs, /<h1>Dalfi Studio<\/h1>/);
  assert.match(appJs, /<p>Powered By Seben ERP<\/p>/);
  assert.match(appJs, /ctx\.fillText\("Dalfi Studio", 40, 55\)/);
  assert.match(appJs, /ctx\.fillText\("Powered By Seben ERP", 40, 84\)/);
  assert.match(appJs, /@page \{ size: 80mm auto; margin: 3mm; \}/);
  assert.match(appJs, /html, body \{ width: 74mm;/);
  assert.match(appJs, /\.invoice-report \{ width: 74mm; max-width: none;/);
  assert.match(appJs, /@media print[\s\S]*?\.report-actions \{ display: none; \}/);
});

test("el reporte obtiene tanto pagos confirmados como CxC de la factura", () => {
  assert.match(appJs, /const invoicePayments = dbTable\("pagosFactura"\)\.filter/);
  assert.match(appJs, /const receivables = dbTable\("cuentasCobrar"\)\.filter/);
  assert.match(appJs, /function invoicePaymentDisplayRows\(invoiceId\)/);
  assert.match(appJs, /<h3>12\. Detalle de formas de pago<\/h3>/);
});

test("una transferencia pendiente se imprime como pendiente y con la salvedad de crédito", () => {
  assert.match(appJs, /Transferencia pendiente por confirmar/);
  assert.match(appJs, /Pendiente de confirmación/);
  assert.match(appJs, /este monto está sujeto a la confirmación de que la transferencia fue recibida/);
  assert.match(appJs, /Si la transacción no se confirma, el saldo pasa a crédito del cliente/);
});

test("crédito y transferencia pendiente no se presentan como pagos confirmados", () => {
  assert.match(appJs, /status: pendingTransfer \? "Pendiente de confirmación" : "Crédito pendiente"/);
  assert.match(appJs, /status: "Confirmado"/);
});
