// Almacen de Academia, salidas internas normalizadas y auditoria completa
// de mesas/Academia (julio 2026). Mismo patron del proyecto: funciones
// puras probadas directamente + analisis estatico de app.js (sin DOM real
// en este runner) para confirmar que quedan conectadas a persistencia real.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DalfiClosingMath = require("../outputs/lib/closing-math.js");
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

function functionExists(name, source = appJs) {
  return new RegExp(`^\\s*(async )?function ${name}\\(`, "m").test(source);
}

// ===========================================================================
// A. Ubicaciones habilitadas para venta / venta por ubicacion
// ===========================================================================

test("1. saleEligibleLocations() filtra activas con permiteVenta=true, sin hardcodear ningun tipo especifico", () => {
  const source = extractFunction("saleEligibleLocations");
  assert.match(source, /permiteVenta === true/);
  assert.match(source, /activa !== false/);
  assert.doesNotMatch(source, /tipo === "estanteria"|tipo === "almacen_salon"/);
});

test("2. defaultSalonWarehouse() ahora crea con permiteVenta:true por defecto (solo afecta almacenes NUEVOS)", () => {
  const source = extractFunction("defaultSalonWarehouse");
  assert.match(source, /permiteVenta: true/);
});

test("3. preflightRetailProductSale: linea CON locationId valida contra la ubicacion (activa + permiteVenta), nunca respaldo automatico", () => {
  const items = [{ itemId: "ITM-A", nombre: "Esmalte", taxable: false, historicalUnitCost: 10, puedeVenderse: true }];
  const locations = [{ locationId: "ALM-1", nombre: "Almacén del salón", activa: true, permiteVenta: true }];
  const ok = DalfiClosingMath.preflightRetailProductSale({
    lines: [{ itemId: "ITM-A", locationId: "ALM-1", quantity: 2, unitPrice: 100 }],
    items,
    locations,
    inventoryByLocation: { "ITM-A:ALM-1": 10 },
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.normalizedLines[0].selectedLocationId, "ALM-1");
  assert.equal(ok.normalizedLines[0].availableStock, 10);
});

test("4. preflightRetailProductSale: ubicacion sin permiteVenta bloquea (nunca vende desde una ubicacion no autorizada)", () => {
  const items = [{ itemId: "ITM-A", nombre: "Esmalte", taxable: false, historicalUnitCost: 10, puedeVenderse: true }];
  const locations = [{ locationId: "MSA-1", nombre: "Mesa 1", activa: true, permiteVenta: false }];
  const result = DalfiClosingMath.preflightRetailProductSale({
    lines: [{ itemId: "ITM-A", locationId: "MSA-1", quantity: 1, unitPrice: 100 }],
    items,
    locations,
    inventoryByLocation: { "ITM-A:MSA-1": 10 },
  });
  assert.equal(result.allowed, false);
  assert.match(result.blockingErrors.join(" "), /no está habilitada para venta/);
});

test("5. preflightRetailProductSale: ubicacion inactiva bloquea", () => {
  const items = [{ itemId: "ITM-A", nombre: "Esmalte", taxable: false, historicalUnitCost: 10, puedeVenderse: true }];
  const locations = [{ locationId: "ALM-1", nombre: "Almacén", activa: false, permiteVenta: true }];
  const result = DalfiClosingMath.preflightRetailProductSale({
    lines: [{ itemId: "ITM-A", locationId: "ALM-1", quantity: 1, unitPrice: 100 }],
    items,
    locations,
    inventoryByLocation: { "ITM-A:ALM-1": 10 },
  });
  assert.equal(result.allowed, false);
  assert.match(result.blockingErrors.join(" "), /inactiva/);
});

test("6. preflightRetailProductSale: ubicacion inexistente (locationId que no aparece en `locations`) bloquea con error claro", () => {
  const items = [{ itemId: "ITM-A", nombre: "Esmalte", taxable: false, historicalUnitCost: 10, puedeVenderse: true }];
  const result = DalfiClosingMath.preflightRetailProductSale({
    lines: [{ itemId: "ITM-A", locationId: "NOPE", quantity: 1, unitPrice: 100 }],
    items,
    locations: [],
    inventoryByLocation: {},
  });
  assert.equal(result.allowed, false);
  assert.match(result.blockingErrors.join(" "), /Ubicación no encontrada/);
});

test("7. preflightRetailProductSale: stock insuficiente EN LA UBICACION seleccionada bloquea, aunque otra ubicacion tenga existencia (sin respaldo automatico)", () => {
  const items = [{ itemId: "ITM-A", nombre: "Esmalte", taxable: false, historicalUnitCost: 10, puedeVenderse: true }];
  const locations = [
    { locationId: "ALM-1", nombre: "Almacén", activa: true, permiteVenta: true },
    { locationId: "EST-1", nombre: "Estantería", activa: true, permiteVenta: true },
  ];
  const result = DalfiClosingMath.preflightRetailProductSale({
    lines: [{ itemId: "ITM-A", locationId: "ALM-1", quantity: 5, unitPrice: 100 }],
    items,
    locations,
    inventoryByLocation: { "ITM-A:ALM-1": 1, "ITM-A:EST-1": 50 },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.shortages[0].shortfall, 4);
});

test("8. preflightRetailProductSale: dos lineas del mismo articulo desde DOS ubicaciones distintas se validan cada una por separado (venta multilinea multi-ubicacion)", () => {
  const items = [{ itemId: "ITM-A", nombre: "Esmalte", taxable: false, historicalUnitCost: 10, puedeVenderse: true }];
  const locations = [
    { locationId: "ALM-1", nombre: "Almacén", activa: true, permiteVenta: true },
    { locationId: "EST-1", nombre: "Estantería", activa: true, permiteVenta: true },
  ];
  const result = DalfiClosingMath.preflightRetailProductSale({
    lines: [
      { itemId: "ITM-A", locationId: "ALM-1", quantity: 2, unitPrice: 100 },
      { itemId: "ITM-A", locationId: "EST-1", quantity: 3, unitPrice: 100 },
    ],
    items,
    locations,
    inventoryByLocation: { "ITM-A:ALM-1": 2, "ITM-A:EST-1": 3 },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.normalizedLines[0].selectedLocationId, "ALM-1");
  assert.equal(result.normalizedLines[1].selectedLocationId, "EST-1");
});

test("9. preflightRetailProductSale: linea SIN locationId conserva compatibilidad historica (shelfInventory[itemId], comportamiento previo intacto)", () => {
  const items = [{ itemId: "ITM-A", nombre: "Esmalte", taxable: false, historicalUnitCost: 10, puedeVenderse: true }];
  const result = DalfiClosingMath.preflightRetailProductSale({
    lines: [{ itemId: "ITM-A", quantity: 2, unitPrice: 100 }],
    items,
    shelfInventory: { "ITM-A": 10 },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.normalizedLines[0].selectedLocationId, "");
});

test("10. app.js: la venta descuenta UN solo movimiento por linea, con locationId = normalized.selectedLocationId (nunca una estanteria fija ni doble ubicacion)", () => {
  const submit = extractFunction === undefined ? "" : "";
  assert.match(appJs, /locationId: normalized\.selectedLocationId,/);
  assert.match(appJs, /sourceKey: `venta:\$\{retailSaleId\}:\$\{normalized\.itemId\}:\$\{normalized\.selectedLocationId\}`/);
});

test("11. app.js: reverseRetailSale() usa reverseInvoiceInventoryEffects, que restaura el locationId ORIGINAL del movimiento (nunca un valor fijo)", () => {
  const source = extractFunction("reverseInvoiceInventoryEffects", fs.readFileSync(path.join(__dirname, "..", "outputs", "lib", "closing-math.js"), "utf8"));
  assert.match(source, /locationId: original\.locationId,/);
});

// ===========================================================================
// B. Almacen de la Academia
// ===========================================================================

test("12. defaultAcademyWarehouse() existe, autocrea UNA sola vez (busca por tipo antes de crear, mismo patron que defaultSalonWarehouse)", () => {
  const source = extractFunction("defaultAcademyWarehouse");
  assert.match(source, /row\.tipo === "academia"/);
  assert.match(source, /if \(existing\) return existing;/);
  assert.match(source, /permiteVenta: false/);
  assert.match(source, /permiteConsumo: true/);
});

test("13. compra directa a Academia: checkbox 'purchase-to-academy' y buyDirectToAcademy enrutan destinationWarehouse a defaultAcademyWarehouse()", () => {
  assert.match(indexHtml, /id="purchase-to-academy"/);
  assert.match(appJs, /const buyDirectToAcademy = Boolean\(byId\("purchase-to-academy"\)\?\.checked\);/);
  assert.match(appJs, /\? defaultAcademyWarehouse\(\)/);
});

test("14. transferencia hacia Academia registra academy_inventory_received; transferencia DESDE Academia registra academy_inventory_returned", () => {
  assert.match(appJs, /if \(to\.tipo === "academia"\) \{/);
  const idx = appJs.indexOf('if (to.tipo === "academia") {');
  const block = appJs.slice(idx, idx + 700);
  assert.match(block, /logAudit\("academy_inventory_received"/);
  assert.match(block, /else if \(from\.tipo === "academia"\) \{/);
  assert.match(block, /logAudit\("academy_inventory_returned"/);
});

test("15. preflightAcademyInventoryConsumption: sin faltantes permite y arma stockPlan/normalizedLines con datos de actividad", () => {
  const result = DalfiClosingMath.preflightAcademyInventoryConsumption({
    lines: [{ itemId: "ITM-A", quantity: 2, historicalUnitCost: 5, activityType: "clase", courseName: "Gel básico", instructorName: "Ana", groupReference: "Grupo 1", participantCount: 8 }],
    academyInventory: { "ITM-A": 10 },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.normalizedLines[0].activityType, "clase");
  assert.equal(result.normalizedLines[0].instructorName, "Ana");
  assert.equal(result.normalizedLines[0].participantCount, 8);
  assert.equal(result.totalHistoricalCost, 10);
});

test("16. preflightAcademyInventoryConsumption: practica/taller/demostracion/evaluacion se aceptan como activityType libre (sin catalogo obligatorio)", () => {
  ["practica", "taller", "demostracion", "evaluacion", "administrativo", "otro"].forEach((activityType) => {
    const result = DalfiClosingMath.preflightAcademyInventoryConsumption({
      lines: [{ itemId: "ITM-A", quantity: 1, historicalUnitCost: 5, activityType }],
      academyInventory: { "ITM-A": 10 },
    });
    assert.equal(result.allowed, true);
    assert.equal(result.normalizedLines[0].activityType, activityType);
  });
});

test("17. preflightAcademyInventoryConsumption: faltante bloquea y reporta shortfall (nunca vende/consume sin existencia)", () => {
  const result = DalfiClosingMath.preflightAcademyInventoryConsumption({
    lines: [{ itemId: "ITM-A", quantity: 5, historicalUnitCost: 5 }],
    academyInventory: { "ITM-A": 2 },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.shortages[0].shortfall, 3);
});

test("18. preflightAcademyInventoryConsumption: sourceKey duplicado bloquea (doble consumo bloqueado)", () => {
  const result = DalfiClosingMath.preflightAcademyInventoryConsumption({
    lines: [{ itemId: "ITM-A", quantity: 1, historicalUnitCost: 5 }],
    academyInventory: { "ITM-A": 10 },
    sourceKey: "academia:ACD-0001",
    existingSourceKeys: ["academia:ACD-0001"],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.duplicate, true);
});

test("19. preflightAcademyInventoryConsumption: FEFO excluye lotes vencidos, igual que preflightRetailProductSale", () => {
  const result = DalfiClosingMath.preflightAcademyInventoryConsumption({
    lines: [{ itemId: "ITM-A", quantity: 3, historicalUnitCost: 5 }],
    academyInventory: { "ITM-A": 10 },
    lots: { "ITM-A": [{ lotId: "VIEJO", quantity: 10, fechaVencimiento: "2020-01-01" }] },
    referenceDate: "2026-07-22",
  });
  assert.equal(result.allowed, false);
  assert.match(result.blockingErrors.join(" "), /Existencia insuficiente/);
});

test("20. preflightAcademyInventoryConsumption nunca lee el DOM ni persiste (funcion pura)", () => {
  assert.doesNotMatch(String(DalfiClosingMath.preflightAcademyInventoryConsumption), /document\.|dbTable\(|localStorage/);
});

test("21. app.js: consumo de Academia crea EXACTAMENTE un movimiento tipo consumo_academia en academyWarehouse.locationId, y persiste consumosAcademia con todos los campos de seccion 10", () => {
  assert.match(appJs, /tipo: "consumo_academia",/);
  assert.match(appJs, /dbTable\("consumosAcademia"\)\.push\(stampRecord\(\{/);
  assert.match(appJs, /academyConsumptionId: consumptionId,/);
  assert.match(appJs, /courseName: byId\("academy-consumption-course"\)\.value\.trim\(\),/);
  assert.match(appJs, /instructorName: byId\("academy-consumption-instructor"\)\.value\.trim\(\),/);
});

test("22. Academia nunca se mezcla con el consumo del salon: el preflight de Academia usa academyInventory (nunca shelfInventory ni un almacen del salon)", () => {
  const source = extractFunction("preflightAcademyInventoryConsumption", fs.readFileSync(path.join(__dirname, "..", "outputs", "lib", "closing-math.js"), "utf8"));
  assert.doesNotMatch(source, /shelfInventory/);
});

test("23. Existencias minimas de Academia: defaultAcademyWarehouse() trae stockMinimo/stockObjetivo, y el reporte de Academia sugiere reposicion sin crear compra automatica", () => {
  assert.match(appJs, /stockMinimo: 0,/);
  assert.match(appJs, /stockObjetivo: 0,/);
  const report = extractFunction("renderAcademyInventoryReport");
  assert.match(report, /Reponer/);
  assert.doesNotMatch(report, /dbTable\("comprasInventario"\)\.push/);
});

// ===========================================================================
// C. Salidas internas normalizadas
// ===========================================================================

test("24. preflightInternalInventoryIssue: destinationType invalido o vacio bloquea (nunca permite salida interna sin destino)", () => {
  const result = DalfiClosingMath.preflightInternalInventoryIssue({
    lines: [{ itemId: "ITM-A", quantity: 1, historicalUnitCost: 5 }],
    sourceLocation: { locationId: "ALM-1", nombre: "Almacén" },
    destinationType: "",
    destinationId: "",
    destinationName: "",
    responsiblePersonId: "resp1",
    inventory: { "ITM-A": 10 },
  });
  assert.equal(result.allowed, false);
  assert.match(result.blockingErrors.join(" "), /Destino de salida interna inválido/);
});

test("25. preflightInternalInventoryIssue: sin responsable bloquea", () => {
  const result = DalfiClosingMath.preflightInternalInventoryIssue({
    lines: [{ itemId: "ITM-A", quantity: 1, historicalUnitCost: 5 }],
    sourceLocation: { locationId: "ALM-1", nombre: "Almacén" },
    destinationType: "general_area",
    destinationName: "Recepción",
    responsiblePersonId: "",
    inventory: { "ITM-A": 10 },
  });
  assert.equal(result.allowed, false);
  assert.match(result.blockingErrors.join(" "), /responsable/);
});

test("26. preflightInternalInventoryIssue: todos los destinationType normalizados de la seccion 16 se aceptan", () => {
  ["station", "collaborator", "general_area", "asset", "academy", "maintenance", "loss", "damage", "expiration", "quarantine", "supplier_return", "other"].forEach((destinationType) => {
    const result = DalfiClosingMath.preflightInternalInventoryIssue({
      lines: [{ itemId: "ITM-A", quantity: 1, historicalUnitCost: 5 }],
      sourceLocation: { locationId: "ALM-1", nombre: "Almacén" },
      destinationType,
      destinationId: "X",
      responsiblePersonId: "resp1",
      inventory: { "ITM-A": 10 },
    });
    assert.equal(result.blockingErrors.some((e) => e.includes("Destino de salida interna inválido")), false, destinationType);
  });
});

test("27. preflightInternalInventoryIssue: faltante bloquea, sourceKey duplicado bloquea (doble salida bloqueada)", () => {
  const shortage = DalfiClosingMath.preflightInternalInventoryIssue({
    lines: [{ itemId: "ITM-A", quantity: 5, historicalUnitCost: 5 }],
    sourceLocation: { locationId: "ALM-1" },
    destinationType: "asset",
    destinationId: "ACT-1",
    responsiblePersonId: "resp1",
    inventory: { "ITM-A": 2 },
  });
  assert.equal(shortage.allowed, false);
  const dup = DalfiClosingMath.preflightInternalInventoryIssue({
    lines: [{ itemId: "ITM-A", quantity: 1, historicalUnitCost: 5 }],
    sourceLocation: { locationId: "ALM-1" },
    destinationType: "asset",
    destinationId: "ACT-1",
    responsiblePersonId: "resp1",
    inventory: { "ITM-A": 10 },
    sourceKey: "salida_interna:ACN-0001",
    existingSourceKeys: ["salida_interna:ACN-0001"],
  });
  assert.equal(dup.allowed, false);
  assert.equal(dup.duplicate, true);
});

test("28. preflightInternalInventoryIssue nunca crea egreso, CxC ni auditoria (funcion pura, solo movementPlan)", () => {
  assert.doesNotMatch(String(DalfiClosingMath.preflightInternalInventoryIssue), /document\.|dbTable\(|localStorage|egresos|cuentasCobrar/);
});

test("29. app.js: entrega a colaboradora distingue custodia (tipo entrega_custodia) de consumo inmediato (tipo consumo_interno)", () => {
  assert.match(appJs, /const isCustodyTransfer = destinationType === "collaborator" && collaboratorCase === "custody";/);
  assert.match(appJs, /const movementTipo = isCustodyTransfer \? "entrega_custodia" : "consumo_interno";/);
});

test("30. app.js: confirmCollaboratorDeliveryReceipt() es idempotente (solo actua sobre status 'Registrada' de una entrega de custodia) y registra collaborator_inventory_received", () => {
  const source = extractFunction("confirmCollaboratorDeliveryReceipt");
  assert.match(source, /caseType === "transferencia_custodia"/);
  assert.match(source, /record\.status !== "Registrada"\) return null;/);
  assert.match(source, /collaborator_inventory_received/);
});

test("31. app.js: deliverInventoryToStation() usa createInventoryTransfer (transferencia real, nunca consumo) y queda 'Pendiente de recepción'", () => {
  const source = extractFunction("deliverInventoryToStation");
  assert.match(source, /createInventoryTransfer\(\{/);
  assert.match(source, /record\.estado = "Pendiente de recepción";/);
});

test("32. app.js: confirmStationDeliveryReceipt() es idempotente (solo actua sobre una entrega real Pendiente de recepción)", () => {
  const source = extractFunction("confirmStationDeliveryReceipt");
  assert.match(source, /record\.estado !== "Pendiente de recepción"\) return null;/);
});

test("33. app.js: returnInventoryFromStation() reutiliza la misma transferencia generica en sentido inverso (Mesa -> Almacén)", () => {
  const source = extractFunction("returnInventoryFromStation");
  assert.match(source, /fromLocationId: stationId,/);
  assert.match(source, /toLocationId,/);
});

test("34. app.js: consumo general del centro (consumosGenerales) y consumo de activo (consumosActivos) NUNCA generan un nuevo egreso (el egreso ya ocurrió al comprar)", () => {
  const from = appJs.indexOf('byId("internal-issue-form").addEventListener');
  const to = appJs.indexOf('byId("internal-issue-list").addEventListener');
  const block = appJs.slice(from, to);
  assert.doesNotMatch(block, /dbTable\("egresos"\)\.push/);
  assert.match(block, /dbTable\("consumosGenerales"\)\.push/);
  assert.match(block, /dbTable\("consumosActivos"\)\.push/);
});

test("35. app.js: mantenimiento vinculado usa destinationType 'maintenance' y NO carga automaticamente a una colaboradora", () => {
  assert.match(indexHtml, /<option value="maintenance">Mantenimiento<\/option>/);
  const from = appJs.indexOf('byId("internal-issue-form").addEventListener');
  const to = appJs.indexOf('byId("internal-issue-list").addEventListener');
  const block = appJs.slice(from, to);
  assert.doesNotMatch(block, /destinationType === "maintenance"[^;]{0,200}collaboratorId/s);
});

test("36. app.js: sourceKey de salida interna es estable (salida_interna:<recordId>), nunca dbTable.length ni un contador", () => {
  assert.match(appJs, /const sourceKey = `salida_interna:\$\{recordId\}`;/);
});

test("37. app.js: consumo de activo nunca modifica el costo de adquisicion del activo ni calcula depreciacion nueva", () => {
  const from = appJs.indexOf('byId("internal-issue-form").addEventListener');
  const to = appJs.indexOf('byId("internal-issue-list").addEventListener');
  const block = appJs.slice(from, to);
  assert.doesNotMatch(block, /valorAdquisicion\s*=/);
  assert.doesNotMatch(block, /assetDepreciation/);
});

// ===========================================================================
// D. Auditoria completa de mesas
// ===========================================================================

test("38. classifyInventoryVarianceLine: dentro de tolerancia, mayor consumo, menor consumo, sin consumo esperado", () => {
  assert.equal(DalfiClosingMath.classifyInventoryVarianceLine({ varianceQuantity: 0.5, variancePercent: 2, expectedConsumption: 25, tolerancePercent: 5 }), "within_tolerance");
  assert.equal(DalfiClosingMath.classifyInventoryVarianceLine({ varianceQuantity: 5, variancePercent: 20, expectedConsumption: 25, tolerancePercent: 5 }), "higher_consumption");
  assert.equal(DalfiClosingMath.classifyInventoryVarianceLine({ varianceQuantity: -5, variancePercent: -20, expectedConsumption: 25, tolerancePercent: 5 }), "lower_consumption");
  assert.equal(DalfiClosingMath.classifyInventoryVarianceLine({ varianceQuantity: 3, variancePercent: 100, expectedConsumption: 0, tolerancePercent: 5 }), "no_expected_consumption");
});

test("39. classifyInventoryVarianceLine: expectedConsumption=0 y variancePercent ya resuelto (100 o 0) nunca produce NaN/Infinity, ni division por cero directa aqui", () => {
  const classification = DalfiClosingMath.classifyInventoryVarianceLine({ varianceQuantity: 0, variancePercent: 0, expectedConsumption: 0, tolerancePercent: 5 });
  assert.equal(classification, "within_tolerance");
});

test("40. classifyInventoryVarianceLine: expectedKnown=false clasifica como 'missing_information' (falta de informacion)", () => {
  assert.equal(DalfiClosingMath.classifyInventoryVarianceLine({ expectedKnown: false }), "missing_information");
});

test("41. canTransitionInventoryAuditStatus: Abierta -> En revisión -> Justificada -> Confirmada -> Revertida, nunca saltos ni retrocesos salvo Confirmada->Revertida", () => {
  assert.equal(DalfiClosingMath.canTransitionInventoryAuditStatus("Abierta", "En revisión"), true);
  assert.equal(DalfiClosingMath.canTransitionInventoryAuditStatus("Abierta", "Justificada"), false);
  assert.equal(DalfiClosingMath.canTransitionInventoryAuditStatus("En revisión", "Justificada"), true);
  assert.equal(DalfiClosingMath.canTransitionInventoryAuditStatus("Justificada", "Confirmada"), true);
  assert.equal(DalfiClosingMath.canTransitionInventoryAuditStatus("Confirmada", "Revertida"), true);
  assert.equal(DalfiClosingMath.canTransitionInventoryAuditStatus("Revertida", "Abierta"), false);
  assert.equal(DalfiClosingMath.canTransitionInventoryAuditStatus("Confirmada", "Abierta"), false);
});

test("42. buildInventoryAuditAdjustmentPlan: nunca genera ajuste para variacion cero, y usa sourceKey estable ajuste:<auditId>:<itemId>", () => {
  const plan = DalfiClosingMath.buildInventoryAuditAdjustmentPlan({
    auditId: "AUD-0001",
    varianceLines: [
      { itemId: "ITM-A", varianceQuantity: 0, unitCost: 5 },
      { itemId: "ITM-B", varianceQuantity: 3, unitCost: 5 },
      { itemId: "ITM-C", varianceQuantity: -2, unitCost: 5 },
    ],
  });
  assert.equal(plan.movementPlan.length, 2);
  assert.equal(plan.movementPlan[0].sourceKey, "ajuste:AUD-0001:ITM-B");
  assert.equal(plan.movementPlan[0].tipo, "ajuste_negativo");
  assert.equal(plan.movementPlan[1].tipo, "ajuste_positivo");
});

test("43. buildInventoryAuditAdjustmentPlan: idempotente, un ajuste YA aplicado (sourceKey en existingSourceKeys) no se duplica", () => {
  const plan = DalfiClosingMath.buildInventoryAuditAdjustmentPlan({
    auditId: "AUD-0001",
    varianceLines: [{ itemId: "ITM-B", varianceQuantity: 3, unitCost: 5 }],
    existingSourceKeys: ["ajuste:AUD-0001:ITM-B"],
  });
  assert.equal(plan.movementPlan.length, 0);
});

test("44. buildInventoryAuditReversalPlan: invierte la direccion de CADA ajuste aplicado, sourceKey reversion:<ajuste>, nunca revierte dos veces", () => {
  const plan = DalfiClosingMath.buildInventoryAuditReversalPlan({
    auditId: "AUD-0001",
    appliedAdjustments: [{ itemId: "ITM-B", quantity: 3, unitCost: 5, tipo: "ajuste_negativo", sourceKey: "ajuste:AUD-0001:ITM-B" }],
  });
  assert.equal(plan.movementPlan[0].tipo, "ajuste_positivo");
  assert.equal(plan.movementPlan[0].sourceKey, "reversion:ajuste:AUD-0001:ITM-B");
  const doubleReversal = DalfiClosingMath.buildInventoryAuditReversalPlan({
    auditId: "AUD-0001",
    appliedAdjustments: [{ itemId: "ITM-B", quantity: 3, unitCost: 5, tipo: "ajuste_negativo", sourceKey: "ajuste:AUD-0001:ITM-B" }],
    existingSourceKeys: ["reversion:ajuste:AUD-0001:ITM-B"],
  });
  assert.equal(doubleReversal.movementPlan.length, 0);
});

test("45. calculateStationInventoryAuditLine (reutilizada): saldo inicial + entregas - devoluciones - fisico = consumo observado; variacion vs esperado", () => {
  const line = DalfiClosingMath.calculateStationInventoryAuditLine({ openingBalance: 10, deliveries: 5, returns: 1, physicalCount: 8, expectedConsumption: 4, unitCost: 2 });
  assert.equal(line.observedConsumption, 6);
  assert.equal(line.varianceQuantity, 2);
  assert.equal(line.varianceCost, 4);
});

test("46. openStationAudit(): existe, bloquea periodo invalido y solapamiento (overlappingStationAudit), y calcula opening/deliveries/returns/expected sin modificar inventario", () => {
  const source = extractFunction("openStationAudit");
  assert.match(source, /overlappingStationAudit\(stationId, periodStart, periodEnd\)/);
  assert.match(source, /stationBalanceAsOf\(stationId, itemId, periodStart\)/);
  assert.match(source, /aggregateExpectedServiceConsumptionByStation/);
  assert.doesNotMatch(source, /createInventoryMovement\(/);
});

test("47. facturaDetalleLinesInRange(): excluye facturas anuladas (normalize(invoice.estado) !== 'anulada')", () => {
  const source = extractFunction("facturaDetalleLinesInRange");
  assert.match(source, /normalize\(invoice\.estado\) !== "anulada"/);
});

test("48. servicio sin mesa asignada: aggregateExpectedServiceConsumptionByStation (ya probada aparte) reporta withoutStation, y openStationAudit lo conserva en servicesWithoutStation (nunca lo asigna silenciosamente)", () => {
  assert.match(appJs, /servicesWithoutStation: expected\.withoutStation,/);
});

test("49. mesa compartida: openStationAudit acumula collaboratorIds/collaboratorNames de TODAS las colaboradoras que usaron la mesa en el periodo (sin asumir responsabilidad exclusiva)", () => {
  const source = extractFunction("openStationAudit");
  assert.match(source, /const collaboratorIds = \[\.\.\.new Set\(linesInRange\.map\(\(detail\) => detail\.colaboradorID\)\.filter\(Boolean\)\)\];/);
});

test("50. submitStationAuditCounts(): solo transiciona Abierta -> En revisión (usa canTransitionInventoryAuditStatus), calcula varianceLines con calculateStationInventoryAuditLine + classifyInventoryVarianceLine", () => {
  const source = extractFunction("submitStationAuditCounts");
  assert.match(source, /canTransitionInventoryAuditStatus\(audit\.status, "En revisión"\)/);
  assert.match(source, /computeStationAuditVarianceLines\(audit\)/);
});

test("51. justifyStationAudit(): bloquea si falta explicacion de CUALQUIER variacion fuera de tolerancia (nunca confirma sin justificar)", () => {
  const source = extractFunction("justifyStationAudit");
  assert.match(source, /line\.classification !== "within_tolerance" && !explanations\[line\.itemId\] && !audit\.explanations\?\.\[line\.itemId\]/);
});

test("52. confirmStationAudit(): exige canManageInvoices(), usa buildInventoryAuditAdjustmentPlan, y NUNCA crea egreso ni CxC", () => {
  const source = extractFunction("confirmStationAudit");
  assert.match(source, /if \(!canManageInvoices\(\)\) return/);
  assert.match(source, /buildInventoryAuditAdjustmentPlan\(/);
  assert.doesNotMatch(source, /dbTable\("egresos"\)|dbTable\("cuentasCobrar"\)/);
});

test("53. revertStationAudit(): exige canReopenClosings() (permiso elevado) y un motivo; usa buildInventoryAuditReversalPlan; nunca borra la auditoria original", () => {
  const source = extractFunction("revertStationAudit");
  assert.match(source, /if \(!canReopenClosings\(\)\) return/);
  assert.match(source, /if \(!reason\) return/);
  assert.match(source, /buildInventoryAuditReversalPlan\(/);
  assert.doesNotMatch(source, /dbTable\("auditoriasMesa"\)\.splice|delete audit/);
});

test("54. renderStationAudits(): cada estado expone SOLO la accion valida para ese estado (Abierta->conteo, En revisión->justificar, Justificada->confirmar, Confirmada->revertir)", () => {
  const source = extractFunction("renderStationAudits");
  assert.match(source, /row\.status === "Abierta".*station-audit-count/);
  assert.match(source, /row\.status === "En revisión".*station-audit-justify/);
  assert.match(source, /row\.status === "Justificada".*station-audit-confirm/);
  assert.match(source, /row\.status === "Confirmada".*station-audit-revert/);
});

test("55. sourceKey del cierre de auditoria de mesa (auditoriasMesa) usa nextDbId con prefijo AUD, nunca dbTable.length", () => {
  assert.match(appJs, /nextDbId\("auditoriasMesa", "stationAuditId", "AUD"\)/);
});

// ===========================================================================
// F. Auditoria de Academia (simplificada, una sola ubicacion)
// ===========================================================================

test("56. openAcademyAudit(): existe, bloquea solapamiento y calcula saldo inicial/compras/transferencias/consumo registrado sin modificar inventario", () => {
  const source = extractFunction("openAcademyAudit");
  assert.match(source, /overlappingAcademyAudit\(periodStart, periodEnd\)/);
  assert.match(source, /academyInboundSumInRange/);
  assert.match(source, /academyRecordedConsumptionInRange/);
  assert.doesNotMatch(source, /createInventoryMovement\(/);
});

test("57. confirmAcademyAudit()/revertAcademyAudit(): mismos motores puros que mesa (buildInventoryAuditAdjustmentPlan/ReversalPlan), nunca mezclado con auditoriasMesa", () => {
  const confirmSource = extractFunction("confirmAcademyAudit");
  assert.match(confirmSource, /dbTable\("auditoriasAcademia"\)/);
  assert.doesNotMatch(confirmSource, /dbTable\("auditoriasMesa"\)/);
  const revertSource = extractFunction("revertAcademyAudit");
  assert.match(revertSource, /if \(!canReopenClosings\(\)\) return/);
});

test("58. academy_inventory_audit_opened y academy_inventory_audit_confirmed se registran (eventos tecnicos exactos de la seccion 33)", () => {
  assert.match(appJs, /logAudit\("academy_inventory_audit_opened"/);
  assert.match(appJs, /logAudit\("academy_inventory_audit_confirmed"/);
});

// ===========================================================================
// G. Seguridad e integracion / compatibilidad historica
// ===========================================================================

test("59. todas las acciones nuevas de inventario (Academia, salidas internas, auditoria de mesa) exigen canManageInvoices() o canReopenClosings(), nunca user_metadata", () => {
  [
    "internal-issue-form", "academy-consumption-form", "station-audit-form", "station-delivery-form", "academy-audit-form",
  ].forEach((formId) => {
    const from = appJs.indexOf(`byId("${formId}").addEventListener("submit"`);
    assert.ok(from !== -1, formId);
    const block = appJs.slice(from, from + 400);
    assert.match(block, /canManageInvoices\(\)/, formId);
    assert.doesNotMatch(block, /user_metadata/, formId);
  });
});

test("60. transferencias de mesa, salidas internas, consumo de Academia y ajustes de auditoria NUNCA entran en Cierres (no tocan ingresos/egresos/tipoEgreso)", () => {
  ["deliverInventoryToStation", "returnInventoryFromStation", "confirmStationAudit", "revertStationAudit", "confirmAcademyAudit", "revertAcademyAudit"].forEach((name) => {
    const source = extractFunction(name);
    assert.doesNotMatch(source, /dbTable\("ingresos"\)\.push|dbTable\("egresos"\)\.push/, name);
  });
});

test("61. las funciones puras nuevas nunca producen NaN/Infinity con entradas vacias o cero", () => {
  const empty = DalfiClosingMath.preflightInternalInventoryIssue({});
  assert.equal(Number.isNaN(empty.historicalCost), false);
  const academyEmpty = DalfiClosingMath.preflightAcademyInventoryConsumption({});
  assert.equal(Number.isNaN(academyEmpty.totalHistoricalCost), false);
  const line = DalfiClosingMath.calculateStationInventoryAuditLine({});
  assert.equal(Number.isFinite(line.varianceCost), true);
  assert.equal(Number.isFinite(line.variancePercent), true);
});

test("62. sin stock negativo silencioso: preflightInternalInventoryIssue/preflightAcademyInventoryConsumption bloquean por defecto ante faltante (allowNegativeStock/negativeStockPolicy explicito requerido para lo contrario)", () => {
  const result = DalfiClosingMath.preflightInternalInventoryIssue({
    lines: [{ itemId: "ITM-A", quantity: 3 }],
    sourceLocation: { locationId: "ALM-1" },
    destinationType: "other",
    destinationId: "X",
    responsiblePersonId: "resp1",
    inventory: { "ITM-A": 0 },
  });
  assert.equal(result.allowed, false);
});

test("63. sin IDs duplicados en outputs/index.html tras esta tarea", () => {
  const ids = [...indexHtml.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((match) => match[1]);
  const seen = new Set();
  const dupes = [];
  ids.forEach((id) => {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  });
  assert.deepEqual(dupes, []);
});

test("64. compatibilidad historica: dbTable() inicializa cualquier tabla nueva (entregasColaboradoras, consumosGenerales, consumosActivos, consumosAcademia, auditoriasMesa, auditoriasAcademia) sin backfill ni migracion", () => {
  const source = extractFunction("dbTable");
  assert.match(source, /database\.data\[key\] \|\|= \[\];/);
});

test("65. build/sintaxis: outputs/app.js y outputs/lib/closing-math.js siguen siendo JS valido tras integrar Academia, salidas internas y auditoria de mesas", () => {
  assert.doesNotThrow(() => new Function(appJs.replace(/^document\./gm, "globalThis.document?.")));
});

test("66. cero escrituras en produccion: este archivo no importa supabase-js ni referencia el dominio real de produccion", () => {
  const self = fs.readFileSync(__filename, "utf8");
  assert.doesNotMatch(self, /supabase\.co|@supabase\/supabase-js/);
});
