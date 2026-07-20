const test = require("node:test");
const assert = require("node:assert/strict");
const { computeInvoiceBreakdown } = require("../outputs/lib/closing-math.js");

test("1. precio listado se conserva historicamente: es un input directo, no se recalcula del catalogo actual", () => {
  const breakdown = computeInvoiceBreakdown({ precioListadoServicios: 1200, totalPagado: 1200 });
  assert.strictEqual(breakdown.precioListadoServicios, 1200);
});

test("2. calculo de adicionales: entra completo al subtotal antes de descuentos", () => {
  const breakdown = computeInvoiceBreakdown({ precioListadoServicios: 1000, totalAdicionales: 150 });
  assert.strictEqual(breakdown.totalAdicionales, 150);
  assert.strictEqual(breakdown.subtotalAntesDeDescuentos, 1150);
});

test("3. calculo de descuentos: se resta del subtotal antes de descuentos", () => {
  const breakdown = computeInvoiceBreakdown({ precioListadoServicios: 1000, totalAdicionales: 0, totalDescuentos: 300 });
  assert.strictEqual(breakdown.totalDescuentos, 300);
  assert.strictEqual(breakdown.totalServiciosAjustado, 700);
});

test("4. un descuento mayor al subtotal nunca deja el total de servicios en negativo", () => {
  const breakdown = computeInvoiceBreakdown({ precioListadoServicios: 500, totalAdicionales: 0, totalDescuentos: 900 });
  assert.strictEqual(breakdown.totalServiciosAjustado, 0);
});

test("5. la propina se muestra separada del ajuste de servicios", () => {
  const breakdown = computeInvoiceBreakdown({ precioListadoServicios: 1000, propina: 100 });
  assert.strictEqual(breakdown.totalServiciosAjustado, 1000);
  assert.strictEqual(breakdown.propina, 100);
});

test("6. el total general incluye la propina UNA sola vez", () => {
  const breakdown = computeInvoiceBreakdown({ precioListadoServicios: 1000, totalAdicionales: 100, totalDescuentos: 50, propina: 80 });
  // totalServiciosAjustado = 1000+100-50 = 1050; totalGeneral = 1050+80 (una sola vez)
  assert.strictEqual(breakdown.totalServiciosAjustado, 1050);
  assert.strictEqual(breakdown.totalGeneral, 1130);
});

test("7. monto pagado y pendiente: factura pagada de menos", () => {
  const breakdown = computeInvoiceBreakdown({ precioListadoServicios: 1000, propina: 100, totalPagado: 700 });
  assert.strictEqual(breakdown.totalGeneral, 1100);
  assert.strictEqual(breakdown.totalPagado, 700);
  assert.strictEqual(breakdown.montoPendiente, 400);
  assert.strictEqual(breakdown.estaPagada, false);
});

test("8. factura sin propina: propina = 0 y no afecta el total general", () => {
  const breakdown = computeInvoiceBreakdown({ precioListadoServicios: 1000, totalPagado: 1000 });
  assert.strictEqual(breakdown.propina, 0);
  assert.strictEqual(breakdown.totalGeneral, 1000);
  assert.strictEqual(breakdown.montoPendiente, 0);
  assert.strictEqual(breakdown.estaPagada, true);
});

test("9. factura parcialmente pagada: pendiente > 0 y estaPagada es false", () => {
  const breakdown = computeInvoiceBreakdown({ precioListadoServicios: 2000, totalPagado: 500 });
  assert.strictEqual(breakdown.montoPendiente, 1500);
  assert.strictEqual(breakdown.estaPagada, false);
});

test("10. factura con varios metodos de pago: el desglose de metodos es responsabilidad del llamador (suma total ya viene consolidada); el pendiente usa la suma total pagada", () => {
  // efectivo 300 + tarjeta 400 + transferencia 200 = 900 pagado, factura de 1000
  const totalPagado = 300 + 400 + 200;
  const breakdown = computeInvoiceBreakdown({ precioListadoServicios: 1000, totalPagado });
  assert.strictEqual(breakdown.totalPagado, 900);
  assert.strictEqual(breakdown.montoPendiente, 100);
});

test("11. factura antigua sin listedPrice: el llamador debe pasar un fallback seguro (subtotal) en vez de 0; la formula no lo hace por si sola", () => {
  // Esto documenta el contrato: computeInvoiceBreakdown confia en el numero
  // que le pasan. El fallback seguro para facturas viejas sin precioBase vive
  // en invoiceBreakdownForStoredInvoice (outputs/app.js), no aqui.
  const withFallbackApplied = computeInvoiceBreakdown({ precioListadoServicios: 850 /* ya resuelto via fallback a subtotal */, totalPagado: 850 });
  assert.strictEqual(withFallbackApplied.precioListadoServicios, 850);
  assert.strictEqual(withFallbackApplied.montoPendiente, 0);
});

test("sobrepago: si pagaron de mas, montoPendiente es 0 y se reporta el sobrepago aparte", () => {
  const breakdown = computeInvoiceBreakdown({ precioListadoServicios: 1000, totalPagado: 1200 });
  assert.strictEqual(breakdown.montoPendiente, 0);
  assert.strictEqual(breakdown.sobrepago, 200);
});

test("una propina negativa (dato corrupto) nunca resta del total general", () => {
  const breakdown = computeInvoiceBreakdown({ precioListadoServicios: 1000, propina: -50, totalPagado: 1000 });
  assert.strictEqual(breakdown.propina, 0);
  assert.strictEqual(breakdown.totalGeneral, 1000);
});
