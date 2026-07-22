// Pruebas de las funciones puras nuevas de la fase "Cerrar reportes alertas
// y auditoria por colaboradora": aggregateInventoryAuditByCollaborator,
// allocateSharedStationVariance, calculateStationReplenishment,
// classifyLotExpiration, deriveLotStatus, allocateFEFOAcrossItems,
// evaluateAssetConsumptionRule. Ninguna de estas funciones toca el DOM ni
// persiste nada: son motores puros, iguales en espiritu a los ya probados
// en tests/inventory-consumption-audit-engine.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const DalfiClosingMath = require("../outputs/lib/closing-math.js");

const {
  aggregateInventoryAuditByCollaborator,
  allocateSharedStationVariance,
  calculateStationReplenishment,
  classifyLotExpiration,
  deriveLotStatus,
  allocateFEFOAcrossItems,
  evaluateAssetConsumptionRule,
} = DalfiClosingMath;

function varianceLine({ itemId = "INV-1", itemNombre = "Item", expectedConsumption = 0, observedConsumption = 0, declaredActual = 0, varianceQuantity = 0, varianceCost = 0, classification = "within_tolerance" } = {}) {
  return { itemId, itemNombre, expectedConsumption, observedConsumption, declaredActual, varianceQuantity, varianceCost, classification };
}

function stationAudit(overrides = {}) {
  return {
    stationAuditId: "AUD-0001",
    stationId: "MSA-0001",
    stationName: "Mesa 1",
    collaboratorIds: ["COL-1"],
    collaboratorNames: ["Ana"],
    periodStart: "2026-07-01",
    periodEnd: "2026-07-07",
    status: "Confirmada",
    varianceLines: [varianceLine()],
    explanations: {},
    ...overrides,
  };
}

// --- A. Auditoria por colaboradora (1-10) ---

test("A1. una mesa individual: toda la variacion se atribuye a la unica colaboradora", () => {
  const result = aggregateInventoryAuditByCollaborator({
    stationAudits: [stationAudit({ varianceLines: [varianceLine({ expectedConsumption: 10, observedConsumption: 12, varianceQuantity: 2, varianceCost: 20 })] })],
    serviceLines: [],
    directDeliveries: [],
    internalIssues: [],
    periodStart: "2026-07-01",
    periodEnd: "2026-07-07",
  });
  assert.equal(result.collaboratorSummaries.length, 1);
  const ana = result.collaboratorSummaries[0];
  assert.equal(ana.collaboratorId, "COL-1");
  assert.equal(ana.individualStations.length, 1);
  assert.equal(ana.individualConsumption.varianceQuantity, 2);
  assert.equal(ana.individualConsumption.varianceCost, 20);
  assert.equal(result.sharedStationSummaries.length, 0);
});

test("A2. varias mesas de la misma colaboradora se suman", () => {
  const result = aggregateInventoryAuditByCollaborator({
    stationAudits: [
      stationAudit({ stationAuditId: "AUD-A", varianceLines: [varianceLine({ varianceCost: 10 })] }),
      stationAudit({ stationAuditId: "AUD-B", stationId: "MSA-0002", varianceLines: [varianceLine({ varianceCost: 15 })] }),
    ],
  });
  const ana = result.collaboratorSummaries[0];
  assert.equal(ana.individualStations.length, 2);
  assert.equal(ana.individualConsumption.varianceCost, 25);
});

test("A3. mesa compartida: NO se atribuye variacion a una colaboradora individual", () => {
  const result = aggregateInventoryAuditByCollaborator({
    stationAudits: [stationAudit({ collaboratorIds: ["COL-1", "COL-2"], collaboratorNames: ["Ana", "Beatriz"], varianceLines: [varianceLine({ varianceCost: 50, varianceQuantity: 5 })] })],
  });
  assert.equal(result.sharedStationSummaries.length, 1);
  assert.equal(result.sharedStationSummaries[0].sharedVarianceCost, 50);
  assert.equal(result.sharedStationSummaries[0].participants.length, 2);
  result.collaboratorSummaries.forEach((c) => {
    assert.equal(c.individualStations.length, 0);
    assert.equal(c.individualConsumption.varianceCost, 0);
    assert.equal(c.sharedStations.length, 1);
  });
});

test("A4. entrega directa se atribuye a la colaboradora destino", () => {
  const result = aggregateInventoryAuditByCollaborator({
    stationAudits: [],
    directDeliveries: [{ deliveryId: "DLV-1", itemId: "INV-9", itemNombre: "Guantes", collaboratorId: "COL-1", collaboratorName: "Ana", cantidad: 3, totalCost: 30, fecha: "2026-07-02" }],
    periodStart: "2026-07-01",
    periodEnd: "2026-07-07",
  });
  const ana = result.collaboratorSummaries.find((c) => c.collaboratorId === "COL-1");
  assert.equal(ana.directDeliveries.length, 1);
  assert.equal(ana.directDeliveriesTotalQuantity, 3);
  assert.equal(ana.directDeliveriesTotalCost, 30);
});

test("A5. salida a area general nunca se atribuye a una colaboradora (queda en unassignedConsumption)", () => {
  const result = aggregateInventoryAuditByCollaborator({
    internalIssues: [{ internalConsumptionId: "GEN-1", itemId: "INV-9", cantidad: 4, totalCost: 40, destinationType: "maintenance", fecha: "2026-07-02" }],
    periodStart: "2026-07-01",
    periodEnd: "2026-07-07",
  });
  assert.equal(result.collaboratorSummaries.length, 0);
  assert.equal(result.unassignedConsumption.length, 1);
  assert.equal(result.unassignedConsumption[0].source, "internal_issue_area_general");
  assert.equal(result.totals.totalUnassignedCost, 40);
});

test("A6. consumo sin asignacion suficiente: servicio sin mesa y entrega sin colaboradora quedan en unassignedConsumption", () => {
  const result = aggregateInventoryAuditByCollaborator({
    serviceLines: [{ detalleID: "DET-1", colaboradorID: "COL-1", colaboradorNombre: "Ana", servicio: "Manicure", stationId: "", fecha: "2026-07-02" }],
    directDeliveries: [{ deliveryId: "DLV-2", itemId: "INV-9", collaboratorId: "", cantidad: 1, totalCost: 5, fecha: "2026-07-02" }],
    periodStart: "2026-07-01",
    periodEnd: "2026-07-07",
  });
  const sources = result.unassignedConsumption.map((u) => u.source);
  assert.ok(sources.includes("service_without_station"));
  assert.ok(sources.includes("direct_delivery_without_collaborator"));
});

test("A7. sin duplicacion: la misma auditoria pasada dos veces solo cuenta una vez", () => {
  const audit = stationAudit({ varianceLines: [varianceLine({ varianceCost: 10 })] });
  const result = aggregateInventoryAuditByCollaborator({ stationAudits: [audit, { ...audit }] });
  assert.equal(result.collaboratorSummaries[0].individualStations.length, 1);
  assert.equal(result.totals.individualStationsCount, 1);
});

test("A8. costos: individualConsumption.varianceCost coincide con la suma de las varianceLines de la auditoria", () => {
  const result = aggregateInventoryAuditByCollaborator({
    stationAudits: [stationAudit({ varianceLines: [varianceLine({ itemId: "A", varianceCost: 12.5 }), varianceLine({ itemId: "B", varianceCost: 7.25 })] })],
  });
  assert.equal(result.collaboratorSummaries[0].individualConsumption.varianceCost, 19.75);
});

test("A9. periodo: una auditoria fuera del rango solicitado se excluye", () => {
  const result = aggregateInventoryAuditByCollaborator({
    stationAudits: [stationAudit({ periodStart: "2026-06-01", periodEnd: "2026-06-07" })],
    periodStart: "2026-07-01",
    periodEnd: "2026-07-07",
  });
  assert.equal(result.collaboratorSummaries.length, 0);
});

test("A10. historico sin mesa: auditoria sin collaboratorIds no rompe y queda como sin asignar", () => {
  const result = aggregateInventoryAuditByCollaborator({
    stationAudits: [stationAudit({ collaboratorIds: [], collaboratorNames: [], varianceLines: [varianceLine({ varianceCost: 8 })] })],
  });
  assert.equal(result.collaboratorSummaries.length, 0);
  assert.equal(result.unassignedConsumption.length, 1);
  assert.equal(result.unassignedConsumption[0].source, "audit_without_collaborator");
  assert.equal(result.validationErrors.length, 0);
});

// --- B. Distribucion compartida (11-19) ---

test("B11. sin distribucion por defecto: aggregateInventoryAuditByCollaborator nunca reparte", () => {
  const result = aggregateInventoryAuditByCollaborator({
    stationAudits: [stationAudit({ collaboratorIds: ["COL-1", "COL-2"], collaboratorNames: ["Ana", "Beatriz"], varianceLines: [varianceLine({ varianceCost: 100 })] })],
  });
  assert.equal(result.sharedStationSummaries[0].sharedVarianceCost, 100);
  assert.ok(!("allocations" in result.sharedStationSummaries[0]));
});

test("B12. distribucion por porcentaje calcula cantidad y costo proporcional", () => {
  const result = allocateSharedStationVariance({
    varianceQuantity: 10,
    varianceCost: 100,
    mode: "percent",
    allocations: [{ collaboratorId: "COL-1", percent: 60 }, { collaboratorId: "COL-2", percent: 40 }],
    reason: "Turno mas largo de Ana",
    allocatedBy: "admin@dalfi.local",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.allocations[0].quantity, 6);
  assert.equal(result.allocations[0].cost, 60);
  assert.equal(result.allocations[1].quantity, 4);
});

test("B13. distribucion por cantidad calcula el porcentaje correspondiente", () => {
  const result = allocateSharedStationVariance({
    varianceQuantity: 10,
    varianceCost: 100,
    mode: "quantity",
    allocations: [{ collaboratorId: "COL-1", quantity: 7 }, { collaboratorId: "COL-2", quantity: 3 }],
    reason: "Conteo verificado",
    allocatedBy: "admin@dalfi.local",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.allocations[0].percent, 70);
});

test("B14. suma exacta (100% o cantidad total) se acepta", () => {
  const result = allocateSharedStationVariance({
    varianceQuantity: 5,
    mode: "quantity",
    allocations: [{ collaboratorId: "COL-1", quantity: 5 }],
    reason: "Unica responsable identificada",
    allocatedBy: "admin",
  });
  assert.equal(result.allowed, true);
});

test("B15. suma invalida se bloquea (no genera allocations)", () => {
  const result = allocateSharedStationVariance({
    varianceQuantity: 10,
    mode: "quantity",
    allocations: [{ collaboratorId: "COL-1", quantity: 7 }],
    reason: "Motivo",
    allocatedBy: "admin",
  });
  assert.equal(result.allowed, false);
  assert.equal(result.allocations.length, 0);
  assert.ok(result.blockingErrors.some((e) => e.includes("igual a la variación")));
});

test("B16. motivo obligatorio: sin reason se bloquea", () => {
  const result = allocateSharedStationVariance({
    varianceQuantity: 10,
    mode: "percent",
    allocations: [{ collaboratorId: "COL-1", percent: 100 }],
    reason: "",
    allocatedBy: "admin",
  });
  assert.equal(result.allowed, false);
  assert.ok(result.blockingErrors.some((e) => e.includes("motivo")));
});

test("B17. auditoria: la funcion siempre conserva el valor original compartido y quien distribuyo", () => {
  const result = allocateSharedStationVariance({
    varianceQuantity: 10,
    varianceCost: 90,
    mode: "percent",
    allocations: [{ collaboratorId: "COL-1", percent: 100 }],
    reason: "Justificacion",
    allocatedBy: "supervisor@dalfi.local",
  });
  assert.equal(result.originalVarianceQuantity, 10);
  assert.equal(result.originalVarianceCost, 90);
  assert.equal(result.allocatedBy, "supervisor@dalfi.local");
});

test("B18. la distribucion nunca crea CxC (createsReceivable siempre false)", () => {
  const result = allocateSharedStationVariance({ varianceQuantity: 1, mode: "percent", allocations: [{ collaboratorId: "COL-1", percent: 100 }], reason: "x", allocatedBy: "a" });
  assert.equal(result.createsReceivable, false);
});

test("B19. la distribucion nunca crea sancion (createsPenalty siempre false)", () => {
  const result = allocateSharedStationVariance({ varianceQuantity: 1, mode: "percent", allocations: [{ collaboratorId: "COL-1", percent: 100 }], reason: "x", allocatedBy: "a" });
  assert.equal(result.createsPenalty, false);
});

// --- C. Minimos de mesa (20, 23-26 cubiertos aqui a nivel de motor puro) ---

test("C-min. calculateStationReplenishment: bajo minimo sugiere reposicion hasta el objetivo", () => {
  const result = calculateStationReplenishment({ minimumStock: 5, targetStock: 10, currentStock: 2 });
  assert.equal(result.belowMinimum, true);
  assert.equal(result.suggestedReplenishment, 8);
});

test("C-agotado. calculateStationReplenishment: existencia 0 se marca stockedOut", () => {
  const result = calculateStationReplenishment({ minimumStock: 5, targetStock: 10, currentStock: 0 });
  assert.equal(result.stockedOut, true);
  assert.equal(result.suggestedReplenishment, 10);
});

test("C-suficiente. calculateStationReplenishment: stock >= objetivo no sugiere reposicion", () => {
  const result = calculateStationReplenishment({ minimumStock: 5, targetStock: 10, currentStock: 12 });
  assert.equal(result.belowMinimum, false);
  assert.equal(result.suggestedReplenishment, 0);
});

test("C-negativo. calculateStationReplenishment nunca produce NaN con entradas invalidas", () => {
  const result = calculateStationReplenishment({ minimumStock: "x", targetStock: null, currentStock: undefined });
  assert.ok(Number.isFinite(result.suggestedReplenishment));
  assert.ok(Number.isFinite(result.minimumStock));
});

// --- D/E. Lotes y vencimientos (clasificacion + FEFO multi-articulo) ---

test("D-sinvencimiento. classifyLotExpiration: articulo sin fecha es sin_vencimiento", () => {
  const result = classifyLotExpiration({ expirationDate: "", referenceDate: "2026-07-22" });
  assert.equal(result.bucket, "sin_vencimiento");
});

test("D-vigente. classifyLotExpiration: mas alla de todos los plazos es vigente", () => {
  const result = classifyLotExpiration({ expirationDate: "2026-12-01", referenceDate: "2026-07-22", earlyAlertDays: 60, nearAlertDays: 30, urgentAlertDays: 7 });
  assert.equal(result.bucket, "vigente");
});

test("D-proximo. classifyLotExpiration: dentro del plazo temprano/proximo es proximo", () => {
  const result = classifyLotExpiration({ expirationDate: "2026-08-10", referenceDate: "2026-07-22", earlyAlertDays: 60, nearAlertDays: 30, urgentAlertDays: 7 });
  assert.equal(result.bucket, "proximo");
});

test("D-urgente. classifyLotExpiration: dentro del plazo urgente es urgente", () => {
  const result = classifyLotExpiration({ expirationDate: "2026-07-25", referenceDate: "2026-07-22", urgentAlertDays: 7 });
  assert.equal(result.bucket, "urgente");
});

test("D-vencido. classifyLotExpiration: fecha pasada es vencido", () => {
  const result = classifyLotExpiration({ expirationDate: "2026-07-01", referenceDate: "2026-07-22" });
  assert.equal(result.bucket, "vencido");
  assert.ok(result.daysToExpire < 0);
});

test("D-plazos-no-hardcodeados. classifyLotExpiration respeta plazos configurados distintos de 7/30/60", () => {
  const result = classifyLotExpiration({ expirationDate: "2026-07-27", referenceDate: "2026-07-22", urgentAlertDays: 2, nearAlertDays: 4, earlyAlertDays: 10 });
  assert.equal(result.bucket, "proximo");
  const urgentResult = classifyLotExpiration({ expirationDate: "2026-07-24", referenceDate: "2026-07-22", urgentAlertDays: 2, nearAlertDays: 4, earlyAlertDays: 10 });
  assert.equal(urgentResult.bucket, "urgente");
});

test("D-manual-gana. deriveLotStatus: Cuarentena manual gana sobre vencido/agotado", () => {
  assert.equal(deriveLotStatus({ manualStatus: "Cuarentena", availableQuantity: 0, expirationBucket: "vencido" }), "Cuarentena");
});

test("D-agotado. deriveLotStatus: sin estado manual y sin existencia es Agotado", () => {
  assert.equal(deriveLotStatus({ manualStatus: "", availableQuantity: 0, expirationBucket: "vigente" }), "Agotado");
});

test("D-vencido-status. deriveLotStatus: bucket vencido gana sobre agotado", () => {
  assert.equal(deriveLotStatus({ manualStatus: "", availableQuantity: 0, expirationBucket: "vencido" }), "Vencido");
});

test("D-proximo-status. deriveLotStatus: bucket proximo con existencia es 'Próximo a vencer'", () => {
  assert.equal(deriveLotStatus({ manualStatus: "", availableQuantity: 5, expirationBucket: "proximo" }), "Próximo a vencer");
});

test("D-disponible. deriveLotStatus: vigente con existencia es Disponible", () => {
  assert.equal(deriveLotStatus({ manualStatus: "", availableQuantity: 5, expirationBucket: "vigente" }), "Disponible");
});

test("E-multi-item. allocateFEFOAcrossItems reparte cada articulo por su propio FEFO", () => {
  const result = allocateFEFOAcrossItems({
    requirements: [{ itemId: "A", quantity: 5 }, { itemId: "B", quantity: 3 }],
    lotsByItem: {
      A: [{ lotId: "A1", quantity: 5, fechaVencimiento: "2026-08-01", fechaEntrada: "2026-07-01" }],
      B: [{ lotId: "B1", quantity: 2, fechaVencimiento: "2026-08-01", fechaEntrada: "2026-07-01" }, { lotId: "B2", quantity: 5, fechaVencimiento: "2026-09-01", fechaEntrada: "2026-07-05" }],
    },
    referenceDate: "2026-07-22",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.allocationsByItem.A.length, 1);
  assert.equal(result.allocationsByItem.B.length, 2);
  assert.equal(result.allocationsByItem.B[0].lotId, "B1");
});

test("E-shortage. allocateFEFOAcrossItems reporta faltante sin bloquear otros articulos", () => {
  const result = allocateFEFOAcrossItems({
    requirements: [{ itemId: "A", quantity: 10 }],
    lotsByItem: { A: [{ lotId: "A1", quantity: 3, fechaVencimiento: "", fechaEntrada: "" }] },
    referenceDate: "2026-07-22",
  });
  assert.equal(result.allowed, false);
  assert.equal(result.shortages[0].shortfall, 7);
});

// --- F. Consumo anormal de activos (51-60) ---

test("F51. evaluateAssetConsumptionRule: crear regla y evaluar cantidad bajo umbral no genera alerta", () => {
  const rule = { ruleId: "AR-1", assetId: "ACT-1", maximumQuantity: 10, active: true };
  const result = evaluateAssetConsumptionRule({ rule, periodQuantity: 5, periodCost: 0 });
  assert.equal(result.hasRule, true);
  assert.equal(result.exceeded, false);
});

test("F53. evaluateAssetConsumptionRule: cantidad sobre el umbral genera alerta con excedente", () => {
  const rule = { ruleId: "AR-1", assetId: "ACT-1", maximumQuantity: 10, active: true };
  const result = evaluateAssetConsumptionRule({ rule, periodQuantity: 15, periodCost: 0 });
  assert.equal(result.exceeded, true);
  assert.equal(result.quantityExceeded, true);
  assert.equal(result.excessQuantity, 5);
});

test("F54. evaluateAssetConsumptionRule: costo sobre el umbral genera alerta con excedente", () => {
  const rule = { ruleId: "AR-1", assetCategory: "Herramientas", maximumCost: 100, active: true };
  const result = evaluateAssetConsumptionRule({ rule, periodQuantity: 1, periodCost: 150 });
  assert.equal(result.exceeded, true);
  assert.equal(result.costExceeded, true);
  assert.equal(result.excessCost, 50);
});

test("F55. evaluateAssetConsumptionRule: sin regla nunca genera alerta ni inventa una media", () => {
  const result = evaluateAssetConsumptionRule({ rule: null, periodQuantity: 999, periodCost: 999 });
  assert.equal(result.hasRule, false);
  assert.equal(result.exceeded, false);
});

test("F58. evaluateAssetConsumptionRule: regla por categoria funciona igual que por activo especifico", () => {
  const rule = { ruleId: "AR-2", assetCategory: "Secadoras", itemId: "INV-1", maximumQuantity: 2, active: true };
  const result = evaluateAssetConsumptionRule({ rule, periodQuantity: 3, periodCost: 0 });
  assert.equal(result.quantityExceeded, true);
});

test("F59/F60. evaluateAssetConsumptionRule nunca incluye un campo de sancion o movimiento financiero", () => {
  const rule = { ruleId: "AR-1", maximumQuantity: 1, active: true };
  const result = evaluateAssetConsumptionRule({ rule, periodQuantity: 5, periodCost: 0 });
  assert.ok(!("penalty" in result));
  assert.ok(!("movementId" in result));
  assert.ok(!("cxcId" in result));
});

// --- H. Seguridad y robustez numerica ---

test("H76/H77. aggregateInventoryAuditByCollaborator nunca produce NaN/Infinity con datos invalidos", () => {
  const result = aggregateInventoryAuditByCollaborator({
    stationAudits: [stationAudit({ varianceLines: [varianceLine({ expectedConsumption: NaN, varianceCost: Infinity })] })],
  });
  const ana = result.collaboratorSummaries[0];
  assert.ok(Number.isFinite(ana.individualConsumption.expected));
  assert.ok(Number.isFinite(ana.individualConsumption.varianceCost));
});

test("periodo invalido produce validationErrors y no lanza", () => {
  const result = aggregateInventoryAuditByCollaborator({ periodStart: "2026-07-10", periodEnd: "2026-07-01" });
  assert.ok(result.validationErrors.length > 0);
  assert.deepEqual(result.collaboratorSummaries, []);
});
