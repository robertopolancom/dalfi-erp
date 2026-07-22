// Motor puro de consumo de servicios, reversion de inventario, auditoria de
// mesas, costos/margenes directos y factura mixta (julio 2026). Todo esto
// vive en DalfiClosingMath (outputs/lib/closing-math.js): no depende del DOM
// ni de erp_records, se puede probar con datos en memoria. Mismo patron que
// el resto del proyecto: funciones puras + pruebas reales con node:test.
const test = require("node:test");
const assert = require("node:assert/strict");
const DalfiClosingMath = require("../outputs/lib/closing-math.js");

// ===========================================================================
// B. Consumo (prevalidacion pura)
// ===========================================================================

const recipeCorte = [{ servicioNombre: "Manicure", itemId: "ITM-1", cantidadEstimada: 10 }];

test("8. modo required: sin faltantes, permite y arma el plan de movimiento", () => {
  const result = DalfiClosingMath.preflightServiceInventoryConsumption({
    invoiceLines: [{ servicio: "Manicure", cantidad: 1, detalleID: "DET-1" }],
    serviceRecipes: recipeCorte,
    warehouseInventory: { "ITM-1": { quantity: 100, unitCost: 5 } },
    mode: "required",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.blockingErrors.length, 0);
  assert.equal(result.movementPlan.length, 1);
  assert.equal(result.movementPlan[0].quantityBase, 10);
  assert.equal(result.estimatedCost, 50);
});

test("9. modo required: faltante de material bloquea (allowed=false) y no arma plan para ese articulo", () => {
  const result = DalfiClosingMath.preflightServiceInventoryConsumption({
    invoiceLines: [{ servicio: "Manicure", cantidad: 5, detalleID: "DET-1" }],
    serviceRecipes: recipeCorte,
    warehouseInventory: { "ITM-1": { quantity: 3, unitCost: 5 } },
    mode: "required",
  });
  assert.equal(result.allowed, false);
  assert.equal(result.shortages.length, 1);
  assert.match(result.blockingErrors[0], /Existencia insuficiente/);
  assert.equal(result.movementPlan.length, 0);
});

test("10. required no arma un plan parcial cuando hay una ficha tecnica invalida (item reutilizable)", () => {
  const result = DalfiClosingMath.preflightServiceInventoryConsumption({
    invoiceLines: [{ servicio: "Manicure", cantidad: 1, detalleID: "DET-1" }],
    serviceRecipes: [{ servicioNombre: "Manicure", itemId: "ITM-2", cantidadEstimada: 1, reutilizable: true }],
    warehouseInventory: {},
    mode: "required",
  });
  assert.equal(result.allowed, false);
  assert.equal(result.invalidRecipes.length, 1);
});

test("11-12. modo audit_only: nunca bloquea (allowed=true) aunque falte material; el faltante queda como warning, no oculto", () => {
  const result = DalfiClosingMath.preflightServiceInventoryConsumption({
    invoiceLines: [{ servicio: "Manicure", cantidad: 5, detalleID: "DET-1" }],
    serviceRecipes: recipeCorte,
    warehouseInventory: { "ITM-1": { quantity: 3, unitCost: 5 } },
    mode: "audit_only",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.blockingErrors.length, 0);
  assert.ok(result.warnings.length > 0);
});

test("13-14. modo disabled: no calcula nada y nunca crea un plan de movimiento", () => {
  const result = DalfiClosingMath.preflightServiceInventoryConsumption({
    invoiceLines: [{ servicio: "Manicure", cantidad: 5, detalleID: "DET-1" }],
    serviceRecipes: recipeCorte,
    warehouseInventory: { "ITM-1": { quantity: 3, unitCost: 5 } },
    mode: "disabled",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.movementPlan.length, 0);
  assert.equal(result.requiredItems.length, 0);
});

test("negativeStockPolicy explicito permite consumo aunque quede negativo, solo cuando el llamador lo autoriza por articulo", () => {
  const result = DalfiClosingMath.preflightServiceInventoryConsumption({
    invoiceLines: [{ servicio: "Manicure", cantidad: 5, detalleID: "DET-1" }],
    serviceRecipes: recipeCorte,
    warehouseInventory: { "ITM-1": { quantity: 3, unitCost: 5 } },
    mode: "required",
    allowNegativeStockFor: (itemId) => itemId === "ITM-1",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.shortages.length, 0);
  assert.equal(result.movementPlan.length, 1);
});

test("preflightServiceInventoryConsumption no lee DOM ni persiste (solo devuelve datos)", () => {
  const result = DalfiClosingMath.preflightServiceInventoryConsumption({ invoiceLines: [], serviceRecipes: [], mode: "required" });
  assert.deepEqual(Object.keys(result).sort(), [
    "allowed", "availableItems", "blockingErrors", "estimatedCost", "invalidRecipes",
    "mode", "movementPlan", "requiredItems", "shortages", "warnings",
  ].sort());
});

// ===========================================================================
// F. Motor de reversion de inventario
// ===========================================================================

test("62-63. reversion crea un movimiento compensatorio por cada movimiento de producto/servicio de la factura", () => {
  const movements = [
    { movementId: "MOV-1", sourceId: "FAC-1", itemId: "ITM-1", tipo: "consumo_servicio", cantidadBase: 10, costoUnitario: 5, locationId: "ALM-1", sourceKey: "consumo:FAC-1:DET-1:ITM-1" },
    { movementId: "MOV-2", sourceId: "FAC-1", itemId: "ITM-2", tipo: "venta", cantidadBase: 2, costoUnitario: 20, locationId: "EST-1", sourceKey: "venta:FAC-1" },
  ];
  const result = DalfiClosingMath.reverseInvoiceInventoryEffects({ invoiceId: "FAC-1", inventoryMovements: movements, reason: "Anulación de prueba", actor: "admin" });
  assert.equal(result.allowed, true);
  assert.equal(result.reversalMovements.length, 2);
  assert.ok(result.reversalMovements.every((m) => m.tipo === "reversion"));
  assert.equal(result.reversalMovements.find((m) => m.itemId === "ITM-1").auditEvent, "service_inventory_reversed");
  assert.equal(result.reversalMovements.find((m) => m.itemId === "ITM-2").auditEvent, "retail_product_sale_reversed");
});

test("64-65. la reversion conserva el lote y el costo historico del movimiento original", () => {
  const movements = [{ movementId: "MOV-1", sourceId: "FAC-1", itemId: "ITM-1", tipo: "venta", cantidadBase: 3, costoUnitario: 12.5, locationId: "EST-1", lotId: "LOT-9", sourceKey: "venta:FAC-1" }];
  const result = DalfiClosingMath.reverseInvoiceInventoryEffects({ invoiceId: "FAC-1", inventoryMovements: movements, reason: "Devolución", actor: "admin" });
  assert.equal(result.reversalMovements[0].lotId, "LOT-9");
  assert.equal(result.reversalMovements[0].costoUnitario, 12.5);
});

test("66. el movimiento original nunca se borra (la funcion es pura, solo devuelve el plan de reversos, no muta la lista recibida)", () => {
  const movements = [{ movementId: "MOV-1", sourceId: "FAC-1", itemId: "ITM-1", tipo: "venta", cantidadBase: 3, costoUnitario: 12.5, locationId: "EST-1", sourceKey: "venta:FAC-1" }];
  const before = JSON.stringify(movements);
  DalfiClosingMath.reverseInvoiceInventoryEffects({ invoiceId: "FAC-1", inventoryMovements: movements, reason: "x", actor: "admin" });
  assert.equal(JSON.stringify(movements), before);
});

test("67. doble reversion bloqueada: si ya existe el movimiento reversion:<sourceKey>, no se vuelve a generar", () => {
  const movements = [
    { movementId: "MOV-1", sourceId: "FAC-1", itemId: "ITM-1", tipo: "venta", cantidadBase: 3, costoUnitario: 12.5, locationId: "EST-1", sourceKey: "venta:FAC-1" },
    { movementId: "MOV-2", sourceId: "FAC-1", itemId: "ITM-1", tipo: "reversion", cantidadBase: 3, costoUnitario: 12.5, locationId: "EST-1", sourceKey: "reversion:venta:FAC-1" },
  ];
  const result = DalfiClosingMath.reverseInvoiceInventoryEffects({ invoiceId: "FAC-1", inventoryMovements: movements, reason: "x", actor: "admin" });
  assert.equal(result.reversalMovements.length, 0);
  assert.equal(result.alreadyReversed.length, 1);
});

test("68-71. la reversion de inventario nunca produce cambios de pagos, CxC, propina o nomina (el resultado solo trae movimientos de inventario)", () => {
  const movements = [{ movementId: "MOV-1", sourceId: "FAC-1", itemId: "ITM-1", tipo: "venta", cantidadBase: 3, costoUnitario: 12.5, locationId: "EST-1", sourceKey: "venta:FAC-1" }];
  const result = DalfiClosingMath.reverseInvoiceInventoryEffects({ invoiceId: "FAC-1", inventoryMovements: movements, reason: "x", actor: "admin" });
  assert.deepEqual(Object.keys(result).sort(), ["alreadyReversed", "allowed", "blockingErrors", "reversalMovements"].sort());
  assert.ok(!("pagos" in result) && !("cxc" in result) && !("propina" in result) && !("nomina" in result));
});

test("reversion exige invoiceId y motivo (bloquea sin ellos, sin generar nada)", () => {
  const result = DalfiClosingMath.reverseInvoiceInventoryEffects({ invoiceId: "", inventoryMovements: [], reason: "", actor: "admin" });
  assert.equal(result.allowed, false);
  assert.ok(result.blockingErrors.length >= 1);
});

// ===========================================================================
// E. Edicion de factura (delta de inventario)
// ===========================================================================

test("53-54. agregar/retirar producto: solo aparece en additional/returns el que realmente cambio", () => {
  const previousSnapshot = { productLines: [{ detalleID: "L1", itemId: "ITM-1", quantity: 2, locationId: "EST-1", sourceKey: "venta:F1:L1" }] };
  const nextSnapshot = { productLines: [{ detalleID: "L1", itemId: "ITM-1", quantity: 2, locationId: "EST-1", sourceKey: "venta:F1:L1" }, { detalleID: "L2", itemId: "ITM-2", quantity: 1, locationId: "EST-1" }] };
  const result = DalfiClosingMath.calculateInvoiceInventoryDelta({ previousSnapshot, nextSnapshot, existingInventoryMovements: [{ sourceKey: "venta:F1:L1" }] });
  assert.equal(result.allowed, true);
  assert.equal(result.productAdditionalOutputs.length, 1);
  assert.equal(result.productAdditionalOutputs[0].itemId, "ITM-2");
  assert.equal(result.productReturns.length, 0);
});

test("55-56. aumentar/disminuir cantidad de producto genera solo la diferencia, no la linea completa de nuevo", () => {
  const previousSnapshot = { productLines: [{ detalleID: "L1", itemId: "ITM-1", quantity: 5, locationId: "EST-1", sourceKey: "venta:F1:L1" }] };
  const increasedNext = { productLines: [{ detalleID: "L1", itemId: "ITM-1", quantity: 8, locationId: "EST-1", sourceKey: "venta:F1:L1" }] };
  const decreasedNext = { productLines: [{ detalleID: "L1", itemId: "ITM-1", quantity: 2, locationId: "EST-1", sourceKey: "venta:F1:L1" }] };
  const movements = [{ sourceKey: "venta:F1:L1" }];
  const up = DalfiClosingMath.calculateInvoiceInventoryDelta({ previousSnapshot, nextSnapshot: increasedNext, existingInventoryMovements: movements });
  const down = DalfiClosingMath.calculateInvoiceInventoryDelta({ previousSnapshot, nextSnapshot: decreasedNext, existingInventoryMovements: movements });
  assert.equal(up.productAdditionalOutputs[0].quantity, 3);
  assert.equal(down.productReturns[0].quantity, 3);
});

test("57-58. agregar/retirar servicio: mismo patron de diferencia en serviceLines", () => {
  const previousSnapshot = { serviceLines: [{ detalleID: "S1", servicio: "Manicure", cantidad: 1 }] };
  const nextSnapshot = { serviceLines: [{ detalleID: "S1", servicio: "Manicure", cantidad: 1 }, { detalleID: "S2", servicio: "Pedicure", cantidad: 1 }] };
  const added = DalfiClosingMath.calculateInvoiceInventoryDelta({ previousSnapshot, nextSnapshot, existingInventoryMovements: [] });
  assert.equal(added.serviceAdditionalConsumption.length, 1);
  const removed = DalfiClosingMath.calculateInvoiceInventoryDelta({ previousSnapshot: nextSnapshot, nextSnapshot: previousSnapshot, existingInventoryMovements: [] });
  assert.equal(removed.serviceConsumptionReturns.length, 1);
});

test("59-60. solo la diferencia se aplica: el total de la linea sin cambios no genera ni retorno ni consumo adicional", () => {
  const snapshot = { productLines: [{ detalleID: "L1", itemId: "ITM-1", quantity: 4 }], serviceLines: [{ detalleID: "S1", servicio: "Manicure", cantidad: 2 }] };
  const result = DalfiClosingMath.calculateInvoiceInventoryDelta({ previousSnapshot: snapshot, nextSnapshot: snapshot, existingInventoryMovements: [] });
  assert.equal(result.productReturns.length, 0);
  assert.equal(result.productAdditionalOutputs.length, 0);
  assert.equal(result.serviceConsumptionReturns.length, 0);
  assert.equal(result.serviceAdditionalConsumption.length, 0);
});

test("61. dependencia insegura bloqueada: disminuir un producto cuyo movimiento original no existe no genera un retorno, bloquea la edicion", () => {
  const previousSnapshot = { productLines: [{ detalleID: "L1", itemId: "ITM-1", quantity: 5, sourceKey: "venta:F1:L1" }] };
  const nextSnapshot = { productLines: [{ detalleID: "L1", itemId: "ITM-1", quantity: 1, sourceKey: "venta:F1:L1" }] };
  const result = DalfiClosingMath.calculateInvoiceInventoryDelta({ previousSnapshot, nextSnapshot, existingInventoryMovements: [] });
  assert.equal(result.allowed, false);
  assert.ok(result.validationErrors.length > 0);
  assert.equal(result.productReturns.length, 0);
});

// ===========================================================================
// C. Auditoria de mesas (calculo puro por articulo)
// ===========================================================================

test("19-24. saldo inicial + entregas - devoluciones - saldo fisico = consumo observado, comparado contra lo esperado", () => {
  const line = DalfiClosingMath.calculateStationInventoryAuditLine({ openingBalance: 10, deliveries: 20, returns: 5, physicalCount: 5, expectedConsumption: 18 });
  assert.equal(line.observedConsumption, 20);
  assert.equal(line.varianceQuantity, 2);
});

test("26-28. variacion positiva y negativa con su costo", () => {
  const over = DalfiClosingMath.calculateStationInventoryAuditLine({ openingBalance: 0, deliveries: 10, returns: 0, physicalCount: 0, expectedConsumption: 8, unitCost: 3 });
  const under = DalfiClosingMath.calculateStationInventoryAuditLine({ openingBalance: 0, deliveries: 10, returns: 0, physicalCount: 4, expectedConsumption: 8, unitCost: 3 });
  assert.equal(over.varianceQuantity, 2);
  assert.equal(over.varianceCost, 6);
  assert.equal(under.varianceQuantity, -2);
  assert.equal(under.varianceCost, -6);
});

test("sin consumo esperado (0) y sin variacion real, el porcentaje de variacion es 0 (no división por cero/NaN)", () => {
  const line = DalfiClosingMath.calculateStationInventoryAuditLine({ openingBalance: 5, deliveries: 0, returns: 0, physicalCount: 5, expectedConsumption: 0 });
  assert.equal(line.variancePercent, 0);
  assert.equal(Number.isNaN(line.variancePercent), false);
});

test("34. mesa compartida: varias lineas de distintas colaboradoras en la misma mesa acumulan en el mismo bucket", () => {
  const result = DalfiClosingMath.aggregateExpectedServiceConsumptionByStation({
    serviceLines: [
      { detalleID: "D1", servicio: "Manicure", cantidad: 1, stationId: "MSA-1" },
      { detalleID: "D2", servicio: "Manicure", cantidad: 1, stationId: "MSA-1" },
    ],
    recipesByService: { Manicure: [{ itemId: "ITM-1", cantidadEstimada: 10 }] },
  });
  assert.equal(result.stations.length, 1);
  assert.equal(result.stations[0].items[0].quantity, 20);
});

test("35. servicio sin mesa asignada se reporta aparte, nunca se asigna silenciosamente a otra mesa", () => {
  const result = DalfiClosingMath.aggregateExpectedServiceConsumptionByStation({
    serviceLines: [{ detalleID: "D1", servicio: "Manicure", cantidad: 1, stationId: "" }],
    recipesByService: { Manicure: [{ itemId: "ITM-1", cantidadEstimada: 10 }] },
  });
  assert.equal(result.stations.length, 0);
  assert.equal(result.withoutStation.length, 1);
  assert.equal(result.withoutStation[0].detalleID, "D1");
});

// ===========================================================================
// G. Costos y margenes
// ===========================================================================

test("72-74. costo directo esperado excluye activos/reutilizables, y la variacion se calcula contra el costo real", () => {
  const recipeLines = [
    { itemId: "ITM-1", cantidadEstimada: 10 },
    { itemId: "ITM-2", cantidadEstimada: 1, reutilizable: true },
    { itemId: "ITM-3", cantidadEstimada: 1, activoFijo: true },
  ];
  const expected = DalfiClosingMath.calculateServiceDirectCost({ recipeLines, unitCostByItemId: { "ITM-1": 5, "ITM-2": 1000, "ITM-3": 5000 } });
  assert.equal(expected, 50);
  const real = DalfiClosingMath.calculateServiceDirectCost({ recipeLines, unitCostByItemId: { "ITM-1": 6 } });
  assert.equal(real, 60);
  assert.equal(real - expected, 10);
});

test("75-77. margen directo esperado/real y su porcentaje, sin mezclar impuestos", () => {
  const expected = DalfiClosingMath.calculateDirectMargin({ netPrice: 1000, directCost: 300 });
  assert.equal(expected.marginAmount, 700);
  assert.equal(expected.marginPercent, 70);
});

test("78-79. margen de producto usa el costo historico congelado, nunca el costo promedio actual; impuesto excluido del margen", () => {
  const margin = DalfiClosingMath.calculateProductMargin({ netUnitPrice: 100, historicalUnitCost: 40, quantity: 3 });
  assert.equal(margin.marginAmount, 180);
  assert.equal(margin.marginPercent, 60);
});

test("80. activo fijo excluido del costo directo aunque tenga cantidadEstimada", () => {
  const cost = DalfiClosingMath.calculateServiceDirectCost({ recipeLines: [{ itemId: "ITM-3", cantidadEstimada: 1, activoFijo: true }], unitCostByItemId: { "ITM-3": 9999 } });
  assert.equal(cost, 0);
});

test("81. historico congelado: cambiar el costo actual de un articulo no altera un margen ya calculado con el costo historico", () => {
  const marginNow = DalfiClosingMath.calculateProductMargin({ netUnitPrice: 100, historicalUnitCost: 40, quantity: 1 });
  const currentCostChangedElsewhere = 90; // el costo promedio actual del articulo pudo subir despues
  assert.equal(marginNow.marginAmount, 60);
  assert.notEqual(marginNow.marginAmount, 100 - currentCostChangedElsewhere);
});

// ===========================================================================
// D. Factura mixta (resumen fiscal por linea)
// ===========================================================================

test("36-38. solo servicio, solo producto, servicio y producto: cada categoria se acumula por separado", () => {
  const summary = DalfiClosingMath.summarizeMixedInvoiceLines({
    lines: [
      { lineType: "servicio", subtotal: 1000, taxable: false },
      { lineType: "producto", subtotal: 500, taxable: true, taxRate: 18 },
    ],
  });
  assert.equal(summary.servicesExempt, 1000);
  assert.equal(summary.productsTaxed, 590);
});

test("39-40. producto gravado calcula impuesto; producto exento no", () => {
  const taxed = DalfiClosingMath.summarizeMixedInvoiceLines({ lines: [{ lineType: "producto", subtotal: 100, taxable: true, taxRate: 18 }] });
  const exempt = DalfiClosingMath.summarizeMixedInvoiceLines({ lines: [{ lineType: "producto", subtotal: 100, taxable: false }] });
  assert.equal(taxed.taxAmount, 18);
  assert.equal(exempt.taxAmount, 0);
});

test("41. varias tasas configuradas: cada linea aplica SU propia tasa, nunca una global", () => {
  const summary = DalfiClosingMath.summarizeMixedInvoiceLines({
    lines: [
      { lineType: "producto", subtotal: 100, taxable: true, taxRate: 18 },
      { lineType: "producto", subtotal: 100, taxable: true, taxRate: 16 },
    ],
  });
  assert.equal(summary.taxAmount, 34);
});

test("42-43. precio con impuesto incluido vs sin incluir dan bases distintas para el mismo total", () => {
  const included = DalfiClosingMath.splitInvoiceLineTax({ amount: 118, taxable: true, taxRate: 18, priceIncludesTax: true });
  const notIncluded = DalfiClosingMath.splitInvoiceLineTax({ amount: 118, taxable: true, taxRate: 18, priceIncludesTax: false });
  assert.equal(included.baseAmount, 100);
  assert.equal(notIncluded.baseAmount, 118);
});

test("44. el impuesto solo aparece en la linea gravada", () => {
  const summary = DalfiClosingMath.summarizeMixedInvoiceLines({
    lines: [
      { lineType: "servicio", subtotal: 500, taxable: false },
      { lineType: "producto", subtotal: 200, taxable: true, taxRate: 18 },
    ],
  });
  assert.equal(summary.taxAmount, 36);
});

test("45-46. propina fuera de la base imponible y nunca calculada sobre productos", () => {
  const withTip = DalfiClosingMath.summarizeMixedInvoiceLines({ lines: [{ lineType: "producto", subtotal: 100, taxable: true, taxRate: 18 }], tip: 50 });
  assert.equal(withTip.taxableBase, 100);
  assert.equal(withTip.tip, 50);
  assert.equal(withTip.invoiceTotal, 118 + 50);
});

test("47. la deuda anterior es informativa: no altera el total legal de la factura, solo el total general a pagar hoy", () => {
  const summary = DalfiClosingMath.summarizeMixedInvoiceLines({ lines: [{ lineType: "servicio", subtotal: 1000, taxable: false }], priorDebt: 300 });
  assert.equal(summary.invoiceTotal, 1000);
  assert.equal(summary.grandTotalDueToday, 1300);
});

test("compatibilidad historica: una factura sin lineas de producto sigue sumando bien y nunca produce NaN", () => {
  const summary = DalfiClosingMath.summarizeMixedInvoiceLines({ lines: [{ lineType: "servicio", subtotal: 500, taxable: false }] });
  assert.equal(Number.isNaN(summary.invoiceTotal), false);
  assert.equal(summary.productsTaxed, 0);
  assert.equal(summary.productsExempt, 0);
});
