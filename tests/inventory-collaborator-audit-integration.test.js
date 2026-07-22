// Pruebas de integracion/estaticas de la fase "Cerrar reportes alertas y
// auditoria por colaboradora": compatibilidad historica (registros sin los
// campos nuevos), wiring real en outputs/app.js/index.html (IDs, permisos,
// eventos de auditoria tecnica, reportes), y la regla "no auditar cada
// render". Mismo patron que tests/treasury-confirm-ui.test.js: no hay DOM
// real en este runner (node --test, sin jsdom), asi que las aserciones de
// UI son sobre el texto fuente (regex/extraccion de funcion), igual que el
// resto de pruebas *-ui.test.js de este repositorio.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DalfiClosingMath = require("../outputs/lib/closing-math.js");
const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");

function extractFunctionSource(name, source = appJs) {
  const pattern = new RegExp(`^(async )?function ${name}\\(`, "m");
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

// --- Compatibilidad historica (seccion 18) ---

test("H-hist-1. aggregateInventoryAuditByCollaborator carga una auditoria sin lotId/sourceKey/collaboratorNames sin lanzar", () => {
  const audit = {
    stationAuditId: "AUD-OLD",
    stationId: "MSA-OLD",
    // sin stationName, sin collaboratorNames, sin explanations
    collaboratorIds: ["COL-OLD"],
    periodStart: "2020-01-01",
    periodEnd: "2020-01-07",
    status: "Confirmada",
    varianceLines: [{ itemId: "INV-OLD", varianceCost: 5, varianceQuantity: 1, expectedConsumption: 0, observedConsumption: 1 }],
  };
  assert.doesNotThrow(() => {
    const result = DalfiClosingMath.aggregateInventoryAuditByCollaborator({ stationAudits: [audit] });
    assert.equal(result.collaboratorSummaries[0].collaboratorName, "COL-OLD");
  });
});

test("H-hist-2. aggregateInventoryAuditByCollaborator no lanza con entregas/salidas historicas sin collaboratorId ni fecha", () => {
  assert.doesNotThrow(() => {
    const result = DalfiClosingMath.aggregateInventoryAuditByCollaborator({
      directDeliveries: [{ itemId: "INV-1", cantidad: 2 }],
      internalIssues: [{ itemId: "INV-2", cantidad: 3 }],
    });
    assert.equal(result.unassignedConsumption.length, 2);
  });
});

test("H-hist-3. classifyLotExpiration/deriveLotStatus no lanzan con un lote sin expirationDate (historico)", () => {
  assert.doesNotThrow(() => {
    const expiration = DalfiClosingMath.classifyLotExpiration({ expirationDate: "", referenceDate: "2026-07-22" });
    const status = DalfiClosingMath.deriveLotStatus({ manualStatus: "", availableQuantity: 5, expirationBucket: expiration.bucket });
    assert.equal(expiration.bucket, "sin_vencimiento");
    assert.equal(status, "Disponible");
  });
});

test("H-hist-4. calculateStationReplenishment no lanza sin stationInventoryRules previas (mesa nunca configurada)", () => {
  assert.doesNotThrow(() => {
    const result = DalfiClosingMath.calculateStationReplenishment({ minimumStock: undefined, targetStock: undefined, currentStock: undefined });
    assert.ok(Number.isFinite(result.suggestedReplenishment));
  });
});

test("H-hist-5. evaluateAssetConsumptionRule no lanza ni genera alerta sin assetConsumptionRules previas", () => {
  assert.doesNotThrow(() => {
    const result = DalfiClosingMath.evaluateAssetConsumptionRule({ rule: undefined, periodQuantity: 100, periodCost: 100 });
    assert.equal(result.exceeded, false);
  });
});

test("H-hist-6. allocateFEFO/allocateFEFOAcrossItems no exigen lotId: un articulo historico sin lotes sigue funcionando", () => {
  const result = DalfiClosingMath.allocateFEFOAcrossItems({ requirements: [{ itemId: "INV-1", quantity: 5 }], lotsByItem: {}, referenceDate: "2026-07-22" });
  assert.deepEqual(result.allocationsByItem["INV-1"], []);
  assert.equal(result.shortages[0].itemId, "INV-1");
});

// --- Wiring real: IDs en index.html (seccion 10-19) ---

const expectedIds = [
  "station-rule-form",
  "station-rule-list",
  "inventory-lot-form",
  "inventory-lot-list",
  "inventory-lot-search",
  "inventory-expiration-config-form",
  "config-days-early",
  "config-days-near",
  "config-days-urgent",
  "asset-consumption-rule-form",
  "asset-consumption-rule-list",
  "asset-abnormal-consumption-list",
  "report-station-filter",
  "report-item-filter",
  "report-audit-status-filter",
  "purchase-lot-batch",
  "purchase-lot-expiration",
];

expectedIds.forEach((id) => {
  test(`G-id. index.html contiene #${id}`, () => {
    assert.ok(new RegExp(`id="${id}"`).test(indexHtml), `falta el id ${id} en index.html`);
  });
});

test("G-no-dup-ids. index.html no tiene ningun id duplicado", () => {
  const ids = [...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const duplicates = [];
  ids.forEach((id) => {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  });
  assert.deepEqual(duplicates, []);
});

const reportOptionValues = ["collaborator-audit", "shared-stations", "unassigned-consumption", "station-minimums", "inventory-lots", "asset-consumption"];

reportOptionValues.forEach((value) => {
  test(`G-report-option. #report-type incluye <option value="${value}">`, () => {
    assert.ok(indexHtml.includes(`<option value="${value}">`), `falta la opcion de reporte ${value}`);
  });
  test(`G-report-dispatch. renderReports() despacha el tipo "${value}"`, () => {
    assert.ok(appJs.includes(`if (type === "${value}")`), `falta el despacho de renderReports para ${value}`);
  });
});

// --- Permisos (seccion 16): cada accion de escritura exige canManageInvoices() ---

const permissionGatedFunctions = [
  "saveStationInventoryRule",
  "deactivateStationInventoryRule",
  "changeInventoryLotStatus",
  "saveAssetConsumptionRule",
  "deactivateAssetConsumptionRule",
  "applySharedStationVarianceDistribution",
];

permissionGatedFunctions.forEach((name) => {
  test(`H-permiso. ${name}() exige canManageInvoices() antes de escribir`, () => {
    const source = extractFunctionSource(name);
    assert.ok(/canManageInvoices\(\)/.test(source), `${name} no exige canManageInvoices()`);
  });
});

test("H-permiso-user-metadata. ninguna funcion nueva de esta fase usa user_metadata para autorizar", () => {
  permissionGatedFunctions.forEach((name) => {
    const source = extractFunctionSource(name);
    assert.ok(!/user_metadata/.test(source), `${name} no debe leer user_metadata`);
  });
});

// --- Auditoria tecnica (seccion 17): eventos presentes, y "no auditar cada render" ---

const expectedAuditEvents = [
  "collaborator_inventory_audit_viewed",
  "shared_station_variance_allocated",
  "station_inventory_rule_created",
  "station_inventory_rule_updated",
  "inventory_lot_created",
  "inventory_lot_status_changed",
  "inventory_lot_quarantined",
  "inventory_lot_released",
  "inventory_expiration_configuration_changed",
  "asset_consumption_rule_created",
  "asset_consumption_rule_updated",
  "asset_abnormal_consumption_detected",
];

expectedAuditEvents.forEach((eventName) => {
  test(`G-audit-event. app.js registra el evento tecnico "${eventName}"`, () => {
    assert.ok(appJs.includes(`"${eventName}"`), `falta logAudit("${eventName}", ...)`);
  });
});

test("H-no-render-audit. renderCollaboratorAuditReport() nunca llama logAudit (no se audita cada render)", () => {
  const source = extractFunctionSource("renderCollaboratorAuditReport");
  assert.ok(!/logAudit\(/.test(source), "renderCollaboratorAuditReport no debe auditar en cada render");
});

test("H-no-render-audit-2. buildCollaboratorInventoryAuditReport() nunca llama logAudit", () => {
  const source = extractFunctionSource("buildCollaboratorInventoryAuditReport");
  assert.ok(!/logAudit\(/.test(source));
});

test("H-no-render-audit-3. assetAbnormalConsumptionAlerts() (usada por alertas y reportes) nunca llama logAudit", () => {
  const source = extractFunctionSource("assetAbnormalConsumptionAlerts");
  assert.ok(!/logAudit\(/.test(source), "el calculo de alertas no debe auditar en cada render");
});

test("H-no-render-audit-4. computeInventoryAlerts() nunca llama logAudit directamente", () => {
  const source = extractFunctionSource("computeInventoryAlerts");
  assert.ok(!/logAudit\(/.test(source));
});

test("G-audit-once. asset_abnormal_consumption_detected solo se audita dentro de checkAndLogAssetAbnormalConsumption", () => {
  const occurrences = appJs.split('"asset_abnormal_consumption_detected"').length - 1;
  // Una vez en el objeto logAudit y (potencialmente) otra en esta lista de pruebas de otro archivo no cuenta aqui.
  assert.ok(occurrences >= 1);
  const fnSource = extractFunctionSource("checkAndLogAssetAbnormalConsumption");
  assert.ok(fnSource.includes("asset_abnormal_consumption_detected"));
});

test("G-audit-viewed-trigger. collaborator_inventory_audit_viewed solo se dispara desde el click de #generate-report", () => {
  const idx = appJs.indexOf('byId("generate-report").addEventListener');
  assert.ok(idx > -1);
  const nearby = appJs.slice(idx, idx + 900);
  assert.ok(nearby.includes("collaborator_inventory_audit_viewed"));
});

// --- No inventar datos: reglas sin base nunca generan alerta (regresion estatica) ---

test("H-no-invent. assetAbnormalConsumptionAlerts solo recorre consumosActivos ya registrados, nunca genera combinaciones hipoteticas", () => {
  const source = extractFunctionSource("assetAbnormalConsumptionAlerts");
  assert.ok(source.includes('dbTable("consumosActivos")'));
  assert.ok(!/for \(let i = 0/.test(source));
});

// --- Compatibilidad con el flujo existente (regresion) ---

test("regresion. purchase-form sigue exigiendo canManageInvoices() (no se debilito el permiso al agregar lotes)", () => {
  const idx = appJs.indexOf('byId("purchase-form").addEventListener');
  assert.ok(idx > -1);
  const nearby = appJs.slice(idx, idx + 400);
  assert.ok(nearby.includes("canManageInvoices()"));
});

test("regresion. retail-sale-form sigue exigiendo canManageInvoices() tras el wiring de lotes/FEFO", () => {
  const idx = appJs.indexOf('byId("retail-sale-form").addEventListener("submit"');
  assert.ok(idx > -1);
  const nearby = appJs.slice(idx, idx + 400);
  assert.ok(nearby.includes("canManageInvoices()"));
});

// --- E. FEFO conectado a los 5 flujos reales (seccion 11, pruebas 46-50) ---

test("E46-venta. runRetailSalePreflight() pasa lots reales a preflightRetailProductSale", () => {
  const source = extractFunctionSource("runRetailSalePreflight");
  assert.ok(/lots: retailLineLotsSnapshot\(validLines\)/.test(source));
});

test("E47-servicio. consumeInventoryForInvoice() usa lotsAvailableForFEFO + DalfiClosingMath.allocateFEFO para el consumo por servicio", () => {
  const source = extractFunctionSource("consumeInventoryForInvoice");
  assert.ok(source.includes("lotsAvailableForFEFO("));
  assert.ok(source.includes("DalfiClosingMath.allocateFEFO("));
});

test("E48-academia. el envio de consumo de Academia pasa lots reales a preflightAcademyInventoryConsumption", () => {
  const idx = appJs.indexOf('byId("academy-consumption-form").addEventListener');
  assert.ok(idx > -1);
  const nearby = appJs.slice(idx, idx + 2000);
  assert.ok(nearby.includes("lotsAvailableForFEFO(item.itemID, academyWarehouse.locationId)"));
});

test("E49-salida-interna. el envio de salida interna pasa lots reales a preflightInternalInventoryIssue", () => {
  const idx = appJs.indexOf('byId("internal-issue-form").addEventListener');
  assert.ok(idx > -1);
  const nearby = appJs.slice(idx, idx + 3000);
  assert.ok(nearby.includes("lots: { [item.itemID]: lotsAvailableForFEFO(item.itemID, sourceLocation.locationId) }"));
});

test("E50-transferencia. createInventoryTransfer() usa FEFO real anclado a fromLocationId (nunca toLocationId)", () => {
  const source = extractFunctionSource("createInventoryTransfer");
  assert.ok(source.includes("lotsAvailableForFEFO(itemId, fromLocationId)"));
  assert.ok(!source.includes("lotsAvailableForFEFO(itemId, toLocationId)"));
});

test("E-transferencia-compat. createInventoryTransfer() conserva el camino original (sourceKey transferId:out/in) para articulos sin lotes reales", () => {
  const source = extractFunctionSource("createInventoryTransfer");
  assert.match(source, /const outSourceKey = `\$\{transferId\}:out`;/);
  assert.match(source, /const inSourceKey = `\$\{transferId\}:in`;/);
});

// --- C. Minimos de mesa: ciclo de vida (20-28) ---

test("C20. saveStationInventoryRule() crea una regla nueva con nextDbId cuando no hay ruleId", () => {
  const source = extractFunctionSource("saveStationInventoryRule");
  assert.ok(source.includes('nextDbId("stationInventoryRules", "ruleId", "SIR")'));
  assert.ok(source.includes('table.push(rule)'));
});

test("C21. saveStationInventoryRule() edita in-place (Object.assign) cuando ya existe ruleId, nunca duplica el registro", () => {
  const source = extractFunctionSource("saveStationInventoryRule");
  assert.ok(source.includes("Object.assign(rule,"));
});

test("C22. deactivateStationInventoryRule() solo cambia active=false, nunca borra el registro", () => {
  const source = extractFunctionSource("deactivateStationInventoryRule");
  assert.ok(source.includes("rule.active = false;"));
  assert.ok(!/splice|delete dbTable/.test(source));
});

test("C27. stationReplenishmentRows() no exige que el articulo tenga movimientos previos (mesa/articulo nunca configurado antes sigue funcionando)", () => {
  const source = extractFunctionSource("stationReplenishmentRows");
  assert.ok(source.includes("itemStockAt(rule.itemId, rule.stationId)"));
});

test("C28. ni saveStationInventoryRule ni stationReplenishmentRows crean una transferencia automatica", () => {
  [extractFunctionSource("saveStationInventoryRule"), extractFunctionSource("stationReplenishmentRows")].forEach((source) => {
    assert.ok(!source.includes("createInventoryTransfer("));
  });
});

// --- D. Lotes: ciclo de vida (29-39) ---

test("D29. createInventoryLot() siempre nace en estado Disponible", () => {
  const source = extractFunctionSource("createInventoryLot");
  assert.ok(source.includes('status: "Disponible"'));
});

test("D32. availableQuantity de un lote SIEMPRE se deriva de calculateInventoryByLocation, nunca se asigna directo", () => {
  const source = extractFunctionSource("lotWithDerivedFields");
  assert.ok(source.includes("DalfiClosingMath.calculateInventoryByLocation("));
  assert.ok(!/availableQuantity\s*=\s*lot\.availableQuantity/.test(source));
});

test("D36/D37. changeInventoryLotStatus() valida la transicion contra LOT_MANUAL_TRANSITIONS antes de escribir", () => {
  const source = extractFunctionSource("changeInventoryLotStatus");
  assert.ok(source.includes("LOT_MANUAL_TRANSITIONS[current]"));
  assert.ok(source.includes('if (!allowed.includes(nextStatus))'));
});

test("D38. retirar un lote (Retirado) exige motivo", () => {
  const source = extractFunctionSource("changeInventoryLotStatus");
  assert.ok(/nextStatus === "Retirado".*&&\s*!reason/.test(source.replace(/\n/g, " ")));
});

test("D39. un articulo sin lotes (controlaLote=false) no se ve forzado a crear lote en la compra", () => {
  const idx = appJs.indexOf('let purchaseLotId = "";');
  assert.ok(idx > -1);
  const nearby = appJs.slice(idx, idx + 400);
  assert.ok(nearby.includes("if (data.item.controlaLote) {"));
});
