import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInvoiceView,
  invoiceToken,
  invoiceUrl,
  renderInvoiceHtml,
  renderInvoiceNotFound,
  verifyInvoiceToken,
} from "../server/invoice-link.mjs";

const ENV = { INVOICE_LINK_SECRET: "secreto-de-prueba", APP_BASE_URL: "https://ssc.dalfistudio.com" };

const DOC = {
  facturas: [{
    facturaID: "FAC-001", fechaOperacion: "2026-09-04", clienteID: "CLI-9",
    clienteNombre: "María Pérez", colaboradorNombre: "Dalfina",
    totalFacturado: 2350, totalCxC: 350, propinaCobrada: 100,
  }],
  facturaDetalle: [
    { facturaID: "FAC-001", servicio: "Manicura en gel", colaboradorNombre: "Dalfina", cantidad: 1, precioBase: 1500, subtotal: 1500 },
    { facturaID: "FAC-001", servicio: "Pedicura spa", colaboradorNombre: "Ana", cantidad: 1, precioBase: 900, deduccionMonto: 150, subtotal: 750 },
    { facturaID: "FAC-OTRA", servicio: "De otra factura", cantidad: 1, precioBase: 1, subtotal: 1 },
  ],
  clientes: [{ clienteID: "CLI-9", telefono: "8095551234", email: "maria@example.com" }],
};

test("invoiceToken/verifyInvoiceToken: ida y vuelta del facturaID", () => {
  const token = invoiceToken(ENV, "FAC-001");
  assert.equal(verifyInvoiceToken(ENV, token), "FAC-001");
});

test("verifyInvoiceToken: rechaza firma alterada, secreto distinto y basura", () => {
  const token = invoiceToken(ENV, "FAC-001");
  assert.equal(verifyInvoiceToken(ENV, `${token.slice(0, -1)}X`), null, "firma alterada");
  assert.equal(verifyInvoiceToken({ INVOICE_LINK_SECRET: "otro" }, token), null, "otro secreto");
  assert.equal(verifyInvoiceToken(ENV, "sin-punto"), null);
  assert.equal(verifyInvoiceToken(ENV, ""), null);
  // Un token válido para OTRA factura no debe servir para esta: la firma va sobre el id.
  const otro = invoiceToken(ENV, "FAC-002");
  assert.notEqual(otro, token);
  assert.equal(verifyInvoiceToken(ENV, otro), "FAC-002");
});

test("sin secreto configurado no se emiten ni se aceptan enlaces", () => {
  assert.equal(invoiceToken({}, "FAC-001"), null);
  assert.equal(invoiceUrl({}, "FAC-001"), null);
  assert.equal(verifyInvoiceToken({}, "loquesea.loquesea"), null);
});

test("invoiceUrl: cuelga de APP_BASE_URL sin barra doble", () => {
  const url = invoiceUrl({ ...ENV, APP_BASE_URL: "https://ssc.dalfistudio.com/" }, "FAC-001");
  assert.match(url, /^https:\/\/ssc\.dalfistudio\.com\/factura\/[\w-]+\.[\w-]+$/);
});

test("buildInvoiceView: arma la factura desde el documento vivo y solo con sus líneas", () => {
  const view = buildInvoiceView(DOC, "FAC-001");
  assert.equal(view.id, "FAC-001");
  assert.equal(view.clienteNombre, "María Pérez");
  assert.equal(view.clienteTelefono, "8095551234");
  assert.equal(view.clienteEmail, "maria@example.com");
  assert.equal(view.lines.length, 2, "no arrastra líneas de otra factura");
  assert.equal(view.lines[1].descuento, 150);
  assert.equal(view.total, 2350);
  assert.equal(view.pendiente, 350);
});

test("buildInvoiceView: factura eliminada devuelve null (el enlace deja de servir solo)", () => {
  assert.equal(buildInvoiceView(DOC, "FAC-404"), null);
  assert.equal(buildInvoiceView({}, "FAC-001"), null);
  assert.equal(buildInvoiceView(null, "FAC-001"), null);
});

test("renderInvoiceHtml: muestra los importes y escapa el contenido del ERP", () => {
  const html = renderInvoiceHtml(buildInvoiceView(DOC, "FAC-001"));
  assert.match(html, /RD\$ 2,350\.00/);
  assert.match(html, /Manicura en gel/);
  assert.match(html, /Pendiente por pagar/);
  const hostil = renderInvoiceHtml({
    ...buildInvoiceView(DOC, "FAC-001"),
    clienteNombre: "<script>alert(1)</script>",
  });
  assert.ok(!hostil.includes("<script>alert(1)</script>"), "el nombre no puede inyectar HTML");
  assert.match(hostil, /&lt;script&gt;/);
});

test("renderInvoiceHtml: sin pendiente no muestra el aviso de deuda", () => {
  const html = renderInvoiceHtml({ ...buildInvoiceView(DOC, "FAC-001"), pendiente: 0 });
  assert.ok(!html.includes("Pendiente por pagar"));
});

test("renderInvoiceNotFound: no revela nada de la factura", () => {
  const html = renderInvoiceNotFound();
  assert.match(html, /ya no está disponible/);
  assert.ok(!html.includes("FAC-"));
});
