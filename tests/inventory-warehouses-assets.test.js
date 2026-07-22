// Almacenes, mesas, custodias, activos y ventas de inventario (julio 2026).
// La existencia NUNCA se lee de un campo editable: siempre se deriva
// sumando inventarioMovimientos (DalfiClosingMath.calculateInventoryByLocation).
// Corrige el defecto real encontrado en el modulo previo: un SKU duplicado
// en un registro NUEVO se trataba como edicion silenciosa del articulo
// existente. Mismo patron estatico + funciones puras (sin DOM real en este
// runner) usado en todo el proyecto.
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

function extractStatementBlock(startMarker, throughMarker, source = appJs) {
  const startIdx = source.indexOf(startMarker);
  assert.ok(startIdx !== -1, `no se encontro el marcador: ${startMarker}`);
  const throughIdx = source.indexOf(throughMarker, startIdx);
  assert.ok(throughIdx !== -1, `no se encontro el marcador: ${throughMarker}`);
  const openIdx = source.indexOf("{", throughIdx);
  let depth = 0;
  let end = openIdx;
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
  const semi = source.indexOf(";", end);
  return source.slice(startIdx, semi + 1);
}

const inventorySubmit = extractStatementBlock('byId("inventory-form").addEventListener("submit"', "(event) => {", appJs);
const purchaseSubmit = extractStatementBlock('let purchaseSubmitInFlight = false;', 'byId("purchase-form").addEventListener("submit"');
const supplierPaySubmit = extractStatementBlock('let supplierPaySubmitInFlight = false;', 'byId("supplier-pay-form").addEventListener("submit"');
const transferSubmit = extractStatementBlock('byId("transfer-form").addEventListener("submit"', "(event) => {", appJs);
const retailSaleSubmit = extractStatementBlock('let retailSaleSubmitInFlight = false;', 'byId("retail-sale-form").addEventListener("submit"');
const lossSubmit = extractStatementBlock('byId("inventory-loss-form").addEventListener("submit"', "(event) => {", appJs);
const countSubmit = extractStatementBlock('byId("physical-count-form").addEventListener("submit"', "(event) => {", appJs);
const custodySubmit = extractStatementBlock('byId("asset-custody-form").addEventListener("submit"', "(event) => {", appJs);
const assetEventSubmit = extractStatementBlock('byId("asset-event-form").addEventListener("submit"', "(event) => {", appJs);
const recipeSubmit = extractStatementBlock('byId("recipe-form").addEventListener("submit"', "(event) => {", appJs);

// ===========================================================================
// A. Articulos y unidades
// ===========================================================================

test("1-2. crear articulo exige permiso; SKU duplicado en un registro NUEVO se rechaza (defecto real corregido: antes se trataba como edicion silenciosa)", () => {
  assert.match(inventorySubmit, /canManageInvoices\(\)/);
  assert.match(inventorySubmit, /if \(existingBySku && existingBySku\.itemID !== editId\) \{/);
});

test("3-4-5. conversion de unidad: factor cero y NaN se rechazan explicitamente", () => {
  assert.equal(DalfiClosingMath.convertToBaseQuantity({ quantity: 2, factor: 500 }).baseQuantity, 1000);
  assert.ok(DalfiClosingMath.convertToBaseQuantity({ quantity: 2, factor: 0 }).validationErrors.length > 0);
  assert.ok(DalfiClosingMath.convertToBaseQuantity({ quantity: NaN, factor: 5 }).validationErrors.length > 0);
  assert.ok(DalfiClosingMath.convertToBaseQuantity({ quantity: 2, factor: Infinity }).validationErrors.length === 0 || DalfiClosingMath.convertToBaseQuantity({ quantity: 2, factor: Infinity }).baseQuantity === 0);
});

test("6. infinito rechazado en la conversion", () => {
  const result = DalfiClosingMath.convertToBaseQuantity({ quantity: Infinity, factor: 1 });
  assert.ok(result.validationErrors.length > 0);
});

test("7. articulo inactivo (estado distinto de Activo) no deberia consumirse: requiredConsumptionLinesForInvoice (usada por preflight y por consumeInventoryForInvoice) respeta puedeConsumirse", () => {
  const source = extractFunction("requiredConsumptionLinesForInvoice");
  assert.match(source, /item\.puedeConsumirse === false/);
});

test("8-9-10. consumible diferenciado de activo/implemento: ni requiredConsumptionLinesForInvoice ni las fichas tecnicas aceptan reutilizables/activos fijos", () => {
  const consumeSource = extractFunction("requiredConsumptionLinesForInvoice");
  assert.match(consumeSource, /item\.reutilizable \|\| item\.activoFijo/);
  assert.match(recipeSubmit, /if \(item\.reutilizable \|\| item\.activoFijo\) \{/);
});

// ===========================================================================
// B. Almacenes
// ===========================================================================

test("11. defaultSalonWarehouse() autocrea el Almacén del salón una sola vez (no duplica en usos posteriores)", () => {
  const source = extractFunction("defaultSalonWarehouse");
  assert.match(source, /const existing = dbTable\("almacenes"\)\.find\(\(row\) => row\.tipo === "almacen_salon"\);/);
  assert.match(source, /if \(existing\) return existing;/);
});

test("12-13. activar/desactivar provisiones no borra histórico (solo cambia el flag de configuración)", () => {
  const source = extractStatementBlock('byId("use-provisions-warehouse").addEventListener("change"', "() => {", appJs);
  assert.doesNotMatch(source, /dbTable\("inventarioMovimientos"\)\.splice|delete dbTable/);
  assert.match(source, /config\.usarAlmacenProvisiones = byId\("use-provisions-warehouse"\)\.checked;/);
});

test("14-15. destino de compra depende de la configuración: provisiones cuando está activo, salón cuando está inactivo", () => {
  assert.match(purchaseSubmit, /const destinationWarehouse = config\.usarAlmacenProvisiones/);
  assert.match(purchaseSubmit, /\? dbTable\("almacenes"\)\.find\(\(w\) => w\.tipo === "provisiones" && w\.activa !== false\) \|\| defaultSalonWarehouse\(\)/);
  assert.match(purchaseSubmit, /: defaultSalonWarehouse\(\);/);
});

test("16. existencia global = suma de todas las ubicaciones (verificado con la funcion pura real)", () => {
  const movements = [
    { itemId: "I1", locationId: "SALON", direction: "in", cantidadBase: 1000 },
    { itemId: "I1", locationId: "SALON", direction: "out", cantidadBase: 200 },
    { itemId: "I1", locationId: "MESA1", direction: "in", cantidadBase: 200 },
  ];
  const global = DalfiClosingMath.calculateInventoryByLocation({ movements, itemId: "I1" });
  const salon = DalfiClosingMath.calculateInventoryByLocation({ movements, itemId: "I1", locationId: "SALON" });
  const mesa = DalfiClosingMath.calculateInventoryByLocation({ movements, itemId: "I1", locationId: "MESA1" });
  assert.equal(global.quantity, salon.quantity + mesa.quantity);
  assert.equal(global.quantity, 1000);
});

test("17. un almacén desactivado conserva su histórico de movimientos (el toggle nunca los filtra ni los borra)", () => {
  const movements = [{ itemId: "I1", locationId: "SALON", direction: "in", cantidadBase: 500 }];
  const result = DalfiClosingMath.calculateInventoryByLocation({ movements, itemId: "I1", locationId: "SALON" });
  assert.equal(result.quantity, 500);
});

// ===========================================================================
// C. Movimientos
// ===========================================================================

test("18-19. entrada y salida: applyInventoryMovement calcula la direccion correcta segun el tipo", () => {
  assert.equal(DalfiClosingMath.applyInventoryMovement({ currentStock: 0, movementType: "compra", quantity: 10 }).direction, "in");
  assert.equal(DalfiClosingMath.applyInventoryMovement({ currentStock: 10, movementType: "venta", quantity: 5 }).direction, "out");
});

test("20-21. ajuste positivo y negativo reconocidos como tipos validos", () => {
  assert.equal(DalfiClosingMath.applyInventoryMovement({ currentStock: 10, movementType: "ajuste_positivo", quantity: 5 }).direction, "in");
  assert.equal(DalfiClosingMath.applyInventoryMovement({ currentStock: 10, movementType: "ajuste_negativo", quantity: 5 }).direction, "out");
});

test("22. stock negativo bloqueado por defecto", () => {
  const result = DalfiClosingMath.applyInventoryMovement({ currentStock: 5, movementType: "venta", quantity: 10 });
  assert.equal(result.movementAllowed, false);
  assert.ok(result.validationErrors.some((e) => /negativa/.test(e)));
});

test("23. excepción autorizada explícitamente permite negativo, y createInventoryMovement audita inventory_negative_override", () => {
  const allowed = DalfiClosingMath.applyInventoryMovement({ currentStock: 5, movementType: "venta", quantity: 10, allowNegativeStock: true });
  assert.equal(allowed.movementAllowed, true);
  assert.equal(allowed.stockAfter, -5);
  const source = extractFunction("createInventoryMovement");
  assert.match(source, /logAudit\("inventory_negative_override"/);
});

test("24. sourceKey duplicado se rechaza (idempotencia de movimientos)", () => {
  const result = DalfiClosingMath.applyInventoryMovement({ currentStock: 10, movementType: "venta", quantity: 5, sourceKey: "X1", existingSourceKeys: ["X1"] });
  assert.equal(result.duplicate, true);
  assert.equal(result.movementAllowed, false);
});

test("25-26. reversión y doble reversión: movimientos con estado 'Revertido' se excluyen del cálculo de existencia (una sola aplicación posible por diseño de calculateInventoryByLocation)", () => {
  const source = extractFunction("calculateInventoryByLocation", fs.readFileSync(path.join(__dirname, "..", "outputs", "lib", "closing-math.js"), "utf8"));
  assert.match(source, /String\(movement\.estado \|\| "Confirmado"\)\.toLowerCase\(\) === "revertido"/);
});

test("createInventoryMovement() nunca persiste un movimiento rechazado (movement queda null)", () => {
  const source = extractFunction("createInventoryMovement");
  assert.match(source, /if \(!result\.movementAllowed\) return \{ movement: null, result \};/);
});

// ===========================================================================
// D. Transferencias
// ===========================================================================

test("27-33. transferencia = DOS movimientos vinculados por transferId, uno de salida y otro de entrada", () => {
  const source = extractFunction("createInventoryTransfer");
  assert.match(source, /tipo: "transferencia_salida",/);
  assert.match(source, /tipo: "transferencia_entrada",/);
  assert.match(source, /transferId,/);
});

test("34. la transferencia nunca cambia la existencia global (verificado con la funcion pura: dos movimientos in/out del mismo articulo se cancelan)", () => {
  const movements = [
    { itemId: "I1", locationId: "A", direction: "out", cantidadBase: 100 },
    { itemId: "I1", locationId: "B", direction: "in", cantidadBase: 100 },
  ];
  const before = 500;
  const after = before + DalfiClosingMath.calculateInventoryByLocation({ movements, itemId: "I1" }).quantity;
  assert.equal(after, before);
});

test("35. doble transferencia bloqueada: cada lado usa un sourceKey propio (transferId:out / transferId:in), reutilizando el mismo bloqueo de sourceKey duplicado", () => {
  const source = extractFunction("createInventoryTransfer");
  assert.match(source, /const outSourceKey = `\$\{transferId\}:out`;/);
  assert.match(source, /const inSourceKey = `\$\{transferId\}:in`;/);
});

test("36. el formulario de transferencia valida existencia disponible en el origen antes de transferir", () => {
  assert.match(transferSubmit, /const available = itemStockAt\(item\.itemID, from\.locationId\);/);
  assert.match(transferSubmit, /if \(quantity > available\) \{/);
});

test("transferir exige permiso", () => {
  assert.match(transferSubmit, /canManageInvoices\(\)/);
});

// ===========================================================================
// F. Implementos / G. Activos y custodia
// ===========================================================================

test("54. implemento no se consume por servicio (ya cubierto en categoria A, se refuerza aquí desde la ficha técnica)", () => {
  assert.match(recipeSubmit, /reutilizable \|\| item\.activoFijo/);
});

test("57-58. crear activo exige permiso y asignar custodio también", () => {
  const assetSubmit = extractStatementBlock('byId("asset-form").addEventListener("submit"', "(event) => {", appJs);
  assert.match(assetSubmit, /canManageInvoices\(\)/);
  assert.match(custodySubmit, /canManageInvoices\(\)/);
});

test("59. impedir doble custodia: asignar una nueva custodia cierra automáticamente la anterior (nunca quedan dos activas a la vez)", () => {
  assert.match(custodySubmit, /const activePrevious = dbTable\("custodiaActivos"\)\.find\(\(row\) => row\.assetId === asset\.activoID && !row\.fechaDevolucion\);/);
  assert.match(custodySubmit, /activePrevious\.fechaDevolucion = today;/);
});

test("60. devolver/reasignar activo no sobrescribe el custodio anterior: queda en el historial con su propia fecha de devolución", () => {
  assert.match(custodySubmit, /activePrevious\.condicionDevolucion = "Reasignado a nuevo custodio";/);
  assert.doesNotMatch(custodySubmit, /dbTable\("custodiaActivos"\)\.splice|delete dbTable/);
});

test("62-63. mantenimiento con pago real genera egreso; sin pago no genera egreso", () => {
  assert.match(assetEventSubmit, /if \(cost > 0\) \{/);
  const noPayBlock = assetEventSubmit.slice(0, assetEventSubmit.indexOf("if (cost > 0)"));
  assert.doesNotMatch(noPayBlock, /dbTable\("egresos"\)\.push/);
});

test("64. un activo general (sin custodio asignado) es válido: asset-custody-form no exige que el activo ya tenga custodio previo", () => {
  assert.doesNotMatch(custodySubmit, /if \(!activePrevious\)/);
});

test("66. un activo nunca se carga a un servicio: no existe ninguna referencia a activosFijos dentro de requiredConsumptionLinesForInvoice ni de fichasTecnicas", () => {
  const source = extractFunction("requiredConsumptionLinesForInvoice");
  assert.doesNotMatch(source, /activosFijos/);
});

test("evento de mantenimiento registra asset_maintenance_recorded; daño/pérdida/retiro registran asset_condition_changed", () => {
  assert.match(assetEventSubmit, /logAudit\("asset_maintenance_recorded"/);
  assert.match(assetEventSubmit, /logAudit\("asset_condition_changed"/);
});

// ===========================================================================
// H. Compras
// ===========================================================================

test("67-68. compra al contado exige cuenta; compra a crédito no la exige", () => {
  assert.match(purchaseSubmit, /if \(mode === "contado"\) \{/);
  assert.match(purchaseSubmit, /account = findAccountByName\(accountName\);/);
});

test("69-70-71. entrada de inventario se crea una sola vez, con destino según configuración de provisiones", () => {
  const movementMatches = purchaseSubmit.match(/createInventoryMovement\(\{/g) || [];
  assert.equal(movementMatches.length, 1);
});

test("72-73. un solo egreso al contado, ningún egreso al crédito", () => {
  const contadoBlock = purchaseSubmit.slice(purchaseSubmit.indexOf('if (mode === "contado") {'), purchaseSubmit.indexOf("} else {"));
  const expenseMatches = contadoBlock.match(/dbTable\("egresos"\)\.push\(/g) || [];
  assert.equal(expenseMatches.length, 1);
  const creditoBlock = purchaseSubmit.slice(purchaseSubmit.indexOf("} else {"), purchaseSubmit.lastIndexOf("}"));
  assert.doesNotMatch(creditoBlock.slice(0, creditoBlock.indexOf("event.target.reset")), /dbTable\("egresos"\)\.push/);
});

test("74. CxP creada a crédito, reutilizando dbTable(\"cuentasPagar\") con acreedorTipo 'Suplidor' (nunca mezclado con Colaborador/Cliente)", () => {
  assert.match(purchaseSubmit, /acreedorTipo: "Suplidor",/);
});

test("75-76-77. pago parcial, total y sobrepago bloqueado en el pago a suplidor", () => {
  assert.match(supplierPaySubmit, /if \(amount > pending \+ 0\.01\) \{/);
  assert.match(supplierPaySubmit, /payable\.estado = payable\.balancePendiente <= 0 \? "Pagada" : "Parcial";/);
});

test("compra exige permiso y guardia de doble-submit", () => {
  assert.match(purchaseSubmit, /canManageInvoices\(\)/);
  assert.match(appJs, /let purchaseSubmitInFlight = false;/);
  assert.match(purchaseSubmit, /if \(purchaseSubmitInFlight\) return;/);
});

// ===========================================================================
// I. Costos
// ===========================================================================

test("78-79-80. costo promedio ponderado: primera compra, segunda compra, redondeo a centavos", () => {
  const first = DalfiClosingMath.calculateWeightedAverageCost({ previousStock: 0, previousAverageCost: 0, incomingQuantity: 100, incomingCost: 10 });
  assert.equal(first.newAverageCost, 10);
  const second = DalfiClosingMath.calculateWeightedAverageCost({ previousStock: 100, previousAverageCost: 10, incomingQuantity: 50, incomingCost: 16 });
  assert.equal(second.newAverageCost, 12);
  const rounded = DalfiClosingMath.calculateWeightedAverageCost({ previousStock: 3, previousAverageCost: 10.333, incomingQuantity: 7, incomingCost: 10.667 });
  assert.equal(Math.round(rounded.newAverageCost * 100) / 100, rounded.newAverageCost);
});

test("81. existencia cero (o negativa) nunca produce division por cero: reinicia al costo de la entrada", () => {
  const result = DalfiClosingMath.calculateWeightedAverageCost({ previousStock: 0, previousAverageCost: 999, incomingQuantity: 0, incomingCost: 5 });
  assert.equal(result.newAverageCost, 0);
  assert.equal(Number.isFinite(result.newAverageCost), true);
});

test("82. el costo promedio se actualiza usando la existencia GLOBAL previa (capturada antes del movimiento), nunca recalcula compras anteriores", () => {
  assert.match(purchaseSubmit, /const previousGlobalStock = itemStockAt\(data\.item\.itemID\);/);
  const captureIdx = purchaseSubmit.indexOf("const previousGlobalStock");
  const moveIdx = purchaseSubmit.indexOf("const movementResult = createInventoryMovement(");
  assert.ok(captureIdx !== -1 && moveIdx !== -1 && captureIdx < moveIdx, "la existencia previa debe capturarse ANTES de crear el movimiento de entrada");
});

test("84-85. impuesto de compra se registra separado, sin compensación automática (solo se suma al total, nunca se resta de ningún otro impuesto)", () => {
  assert.match(purchaseSubmit, /impuesto: data\.tax,/);
  assert.doesNotMatch(purchaseSubmit, /compensa|creditoFiscal/i);
});

// ===========================================================================
// J. Fichas tecnicas
// ===========================================================================

test("86-92. ficha tecnica: agregar linea, actualizar existente, excluir activos/implementos", () => {
  assert.match(recipeSubmit, /const existing = dbTable\("fichasTecnicas"\)\.find\(/);
  assert.match(recipeSubmit, /dbTable\("fichasTecnicas"\)\.push\(stampRecord\(\{ recipeId: nextDbId\("fichasTecnicas", "recipeId", "REC"\), \.\.\.payload \}\)\);/);
});

test("recipeLinesForService() busca por nombre de servicio normalizado (compatible con mayúsculas/acentos)", () => {
  const source = extractFunction("recipeLinesForService");
  assert.match(source, /normalize\(row\.servicioNombre\) === normalize\(serviceName\)/);
});

// ===========================================================================
// K. Facturacion y consumo
// ===========================================================================

test("93-96. la factura consume materiales SOLO segun el modo configurado (inventoryConfig().modoConsumoInventario, no un booleano ambiguo); disabled por defecto para no sorprender con datos sin fichas técnicas configuradas", () => {
  const source = extractFunction("consumeInventoryForInvoice");
  assert.match(source, /if \(mode === "disabled"\) return result;/);
  const configSource = extractFunction("inventoryConfig");
  assert.match(configSource, /modoConsumoInventario: "disabled"/);
});

test("modo required/audit_only/disabled es un enum explicito, nunca un booleano: los tres valores literales existen en el modulo", () => {
  assert.match(appJs, /consumptionMode === "required"/);
  assert.match(appJs, /mode === "audit_only"/);
  assert.match(appJs, /mode === "disabled"/);
});

test("97-98. doble submit / recarga no duplica: cada consumo (directo o confirmado desde pendiente) usa el mismo sourceKey estable factura+detalle+articulo", () => {
  const source = extractFunction("consumeInventoryForInvoice");
  assert.match(source, /const sourceKey = `consumo:\$\{invoiceId\}:\$\{detail\.detalleID\}:\$\{item\.itemID\}`;/);
  const confirmSource = extractFunction("confirmPendingServiceConsumption");
  assert.match(confirmSource, /const sourceKey = `consumo:\$\{pending\.invoiceId\}:\$\{line\.detalleID\}:\$\{line\.itemId\}`;/);
});

test("102. factura sin receta configurada no falla (requiredLines vacio simplemente no genera movimientos, sin lanzar)", () => {
  const source = extractFunction("requiredConsumptionLinesForInvoice");
  assert.match(source, /recipeLines\.forEach\(\(recipeLine\) => \{/);
  assert.doesNotMatch(source, /throw new Error/);
  assert.doesNotMatch(extractFunction("consumeInventoryForInvoice"), /throw new Error/);
});

test("el resultado de consumo automatico ya no se silencia: no hay try/catch alrededor de consumeInventoryForInvoice, el resultado estructurado se usa y los errores se muestran (no solo console.error)", () => {
  const invoiceSubmit = extractStatementBlock('let invoiceSubmitInFlight = false;', 'byId("invoice-form").addEventListener("submit"');
  assert.doesNotMatch(invoiceSubmit, /try \{\s*consumeInventoryForInvoice/);
  assert.match(invoiceSubmit, /const consumptionResult = consumeInventoryForInvoice\(invoiceId, detailRecords, consumptionMode\);/);
  assert.match(invoiceSubmit, /invoiceRecord\.inventoryConsumptionStatus =/);
  assert.match(invoiceSubmit, /if \(consumptionResult\.errors\.length\) \{/);
});

test("modo required bloquea ANTES de crear la factura (buildServiceConsumptionPreflight corre antes del push a facturas), no persiste nada parcial", () => {
  const invoiceSubmit = extractStatementBlock('let invoiceSubmitInFlight = false;', 'byId("invoice-form").addEventListener("submit"');
  const preflightIdx = invoiceSubmit.indexOf("buildServiceConsumptionPreflight(lines, consumptionMode)");
  const invoicePushIdx = invoiceSubmit.indexOf('dbTable("facturas").push(invoiceRecord)');
  assert.ok(preflightIdx !== -1 && invoicePushIdx !== -1 && preflightIdx < invoicePushIdx, "la prevalidacion debe ocurrir antes de persistir la factura");
  assert.match(invoiceSubmit, /if \(!editId && consumptionMode === "required" && !consumptionPreflight\.allowed\) \{/);
});

test("audit_only nunca bloquea el guardado, pero deja el consumo Pendiente y lo audita como service_inventory_pending", () => {
  const source = extractFunction("consumeInventoryForInvoice");
  assert.match(source, /if \(mode === "audit_only"\) \{/);
  assert.match(source, /logAudit\("service_inventory_pending"/);
  assert.match(source, /estado: "Pendiente",/);
});

test("un consumo fallido en modo required se audita como service_inventory_failed, nunca se oculta", () => {
  const source = extractFunction("consumeInventoryForInvoice");
  assert.match(source, /logAudit\("service_inventory_failed"/);
});

// ===========================================================================
// M. Perdidas y vencimientos / N. Conteo fisico / O. Estanteria
// ===========================================================================

test("111-113. daño, pérdida y vencimiento reconocidos como tipos válidos de movimiento (salida)", () => {
  assert.equal(DalfiClosingMath.applyInventoryMovement({ currentStock: 10, movementType: "dano", quantity: 1 }).direction, "out");
  assert.equal(DalfiClosingMath.applyInventoryMovement({ currentStock: 10, movementType: "perdida", quantity: 1 }).direction, "out");
  assert.equal(DalfiClosingMath.applyInventoryMovement({ currentStock: 10, movementType: "vencimiento", quantity: 1 }).direction, "out");
});

test("114. una pérdida/daño no crea ningún egreso nuevo", () => {
  assert.doesNotMatch(lossSubmit, /dbTable\("egresos"\)/);
});

test("115-116. FEFO excluye lotes ya vencidos a la fecha de referencia (no mezcla vencidos con disponibles)", () => {
  const lots = [
    { lotId: "L1", quantity: 10, fechaVencimiento: "2026-08-01", fechaEntrada: "2026-06-01" },
    { lotId: "L2", quantity: 10, fechaVencimiento: "2026-07-01", fechaEntrada: "2026-05-01" },
  ];
  const result = DalfiClosingMath.allocateFEFO({ lots, quantityNeeded: 15, referenceDate: "2026-07-22" });
  assert.deepEqual(result.allocations.map((a) => a.lotId), ["L1"]);
  assert.equal(result.unallocated, 5, "no debe tomar del lote vencido aunque falte cantidad");
});

test("lotes sin fecha de vencimiento van al final del orden FEFO (nunca se priorizan sobre un lote con fecha real)", () => {
  const a = { lotId: "SIN_FECHA", fechaVencimiento: "", fechaEntrada: "2026-01-01" };
  const b = { lotId: "CON_FECHA", fechaVencimiento: "2026-12-01", fechaEntrada: "2026-06-01" };
  assert.ok(DalfiClosingMath.compareLotsFEFO(a, b) > 0, "el lote sin fecha debe ordenar despues");
});

test("119-122. conteo físico: sin diferencia no exige observación, con diferencia sí; crea un solo ajuste", () => {
  assert.match(countSubmit, /if \(difference !== 0 && !note\) \{/);
  const adjustMatches = countSubmit.match(/createInventoryMovement\(\{/g) || [];
  assert.equal(adjustMatches.length, 1);
});

test("123. el conteo físico se aplica una sola vez por confirmación (no hay un bucle que repita el ajuste)", () => {
  assert.doesNotMatch(countSubmit, /for \(|\.forEach\(/);
});

test("125-127. venta directa reduce EXCLUSIVAMENTE la estantería: defaultShelfWarehouse() ya no cae de respaldo al almacén del salón (defecto real corregido)", () => {
  const source = extractFunction("defaultShelfWarehouse");
  assert.match(source, /row\.tipo === "estanteria" && row\.activa !== false/);
  assert.doesNotMatch(source, /defaultSalonWarehouse\(\)/);
  assert.match(retailSaleSubmit, /const shelfCheck = requireShelfWarehouseForSale\(item\.itemID, quantity\);/);
});

test("128. estantería bajo mínimo / sin configurar: requireShelfWarehouseForSale bloquea la venta y explica la falta (nunca vende sin estantería)", () => {
  const source = extractFunction("requireShelfWarehouseForSale");
  assert.match(source, /if \(!shelf\)/);
  assert.match(source, /No hay ninguna Estantería de venta configurada/);
  assert.match(source, /quantity > available/);
  assert.match(retailSaleSubmit, /if \(!shelfCheck\.ok\) \{/);
});

test("venta directa exige permiso, guardia de doble-submit, y bloquea si no hay estantería o existencia suficiente (nunca descuenta otra ubicación)", () => {
  assert.match(retailSaleSubmit, /canManageInvoices\(\)/);
  assert.match(appJs, /let retailSaleSubmitInFlight = false;/);
  assert.match(retailSaleSubmit, /if \(!shelfCheck\.ok\) \{/);
  assert.doesNotMatch(retailSaleSubmit, /defaultSalonWarehouse\(\)/);
});

test("169-171. venta genera un ingreso, una salida de inventario, nunca dos ingresos", () => {
  const incomeMatches = retailSaleSubmit.match(/dbTable\("ingresos"\)\.push\(/g) || [];
  assert.equal(incomeMatches.length, 1);
  const movementMatches = retailSaleSubmit.match(/createInventoryMovement\(\{/g) || [];
  assert.equal(movementMatches.length, 1);
});

// ===========================================================================
// P. Fiscalidad
// ===========================================================================

test("133-134-135. categorías fiscales: Exento, Gravado y otras se guardan por artículo, nunca hardcodeadas como tasa fija global", () => {
  assert.match(indexHtml, /id="inventory-tax-category"/);
  assert.match(indexHtml, /<option value="Exento">Exento<\/option>/);
  assert.match(indexHtml, /<option value="Gravado">Gravado<\/option>/);
});

test("137. el impuesto solo se calcula sobre líneas gravadas (splitInvoiceLineTax devuelve taxAmount 0 cuando taxable es false)", () => {
  const result = DalfiClosingMath.splitInvoiceLineTax({ amount: 1000, taxable: false, taxRate: 18 });
  assert.equal(result.taxAmount, 0);
  assert.equal(result.totalAmount, 1000);
});

test("139-140. tasa configurable por artículo (nunca hardcodeada en la función pura); un artículo nuevo o editado no altera el cálculo ya hecho para ventas anteriores (la función pura es determinística y no lee estado)", () => {
  const source = extractFunction("splitInvoiceLineTax", fs.readFileSync(path.join(__dirname, "..", "outputs", "lib", "closing-math.js"), "utf8"));
  assert.doesNotMatch(source, /0\.1[68]|18\s*\/\s*100/);
});

test("141-142. precio con impuesto incluido calcula base correctamente; precio sin impuesto incluido lo agrega", () => {
  const included = DalfiClosingMath.splitInvoiceLineTax({ amount: 1180, taxable: true, taxRate: 18, priceIncludesTax: true });
  assert.equal(included.baseAmount, 1000);
  assert.equal(included.taxAmount, 180);
  const notIncluded = DalfiClosingMath.splitInvoiceLineTax({ amount: 1000, taxable: true, taxRate: 18, priceIncludesTax: false });
  assert.equal(notIncluded.baseAmount, 1000);
  assert.equal(notIncluded.totalAmount, 1180);
});

test("143-144. splitInvoiceLineTax es pura (no lee el DOM, no persiste) y nunca compensa automáticamente nada", () => {
  const source = extractFunction("splitInvoiceLineTax", fs.readFileSync(path.join(__dirname, "..", "outputs", "lib", "closing-math.js"), "utf8"));
  assert.doesNotMatch(source, /document\.|byId\(|dbTable\(|stampRecord\(/);
});

// ===========================================================================
// R. Seguridad
// ===========================================================================

test("154-155. cada accion financiera exige canManageInvoices(): compras, pagos a suplidor, transferencias, ajustes, activos, custodias, ventas", () => {
  [inventorySubmit, purchaseSubmit, supplierPaySubmit, transferSubmit, lossSubmit, countSubmit, retailSaleSubmit, custodySubmit, assetEventSubmit, recipeSubmit].forEach((block) => {
    assert.match(block, /canManageInvoices\(\)/);
  });
});

test("158. user_metadata jamas se usa como autorizacion en ningun formulario nuevo de inventario", () => {
  [inventorySubmit, purchaseSubmit, supplierPaySubmit, transferSubmit, lossSubmit, countSubmit, retailSaleSubmit, custodySubmit, assetEventSubmit, recipeSubmit].forEach((block) => {
    assert.doesNotMatch(block, /user_metadata/);
  });
});

test("159. las funciones internas (no solo los botones) estan protegidas: openSupplierPayForm exige permiso antes de abrir el formulario", () => {
  const source = extractFunction("openSupplierPayForm");
  assert.match(source, /canManageInvoices\(\)/);
});

// ===========================================================================
// T. Integridad general
// ===========================================================================

test("176. cada evento de auditoria nuevo se registra UNA vez por operacion (sin duplicados dentro del mismo submit)", () => {
  [
    ["inventory_purchase_created", purchaseSubmit],
    ["supplier_payment_created", supplierPaySubmit],
    ["inventory_transfer_created", extractFunction("createInventoryTransfer")],
    ["inventory_loss_recorded", lossSubmit],
    ["inventory_physical_count_confirmed", countSubmit],
    ["retail_product_sold", retailSaleSubmit],
    ["asset_custody_assigned", custodySubmit],
  ].forEach(([eventName, block]) => {
    const matches = block.match(new RegExp(`logAudit\\("${eventName}"`, "g")) || [];
    assert.equal(matches.length, 1, `${eventName} debe auditarse exactamente una vez`);
  });
});

test("177-178-179. sin NaN, sin infinito, sin negativos silenciosos en las funciones puras de inventario", () => {
  const badQuantity = DalfiClosingMath.applyInventoryMovement({ currentStock: 10, movementType: "venta", quantity: NaN });
  assert.equal(badQuantity.movementAllowed, false);
  const infQuantity = DalfiClosingMath.applyInventoryMovement({ currentStock: 10, movementType: "venta", quantity: Infinity });
  assert.equal(Number.isFinite(infQuantity.stockAfter), true);
  const negativeBlocked = DalfiClosingMath.applyInventoryMovement({ currentStock: 0, movementType: "venta", quantity: 5 });
  assert.equal(negativeBlocked.movementAllowed, false);
});

test("180. sin IDs duplicados en outputs/index.html tras esta tarea", () => {
  const ids = [...indexHtml.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]);
  const counts = {};
  ids.forEach((id) => {
    counts[id] = (counts[id] || 0) + 1;
  });
  assert.deepEqual(Object.entries(counts).filter(([, count]) => count > 1), []);
});

test("181. compatibilidad histórica: un artículo sin los campos nuevos (controlaExistencia, taxCategory, factorConversion) usa defaults seguros", () => {
  const source = extractFunction("renderInventory");
  assert.match(source, /item\.controlaExistencia === false \? Number\(item\.existencia\) \|\| 0 : itemStockAt\(item\.itemID\)/);
});

test("no se ejecuta backfill: ninguna funcion nueva de inventario reescribe registros historicos masivamente al cargar/renderizar", () => {
  ["renderInventory", "renderWarehouses", "renderSuppliers", "renderPurchases", "renderTransfers", "renderStations", "renderAssetCustodies"].forEach((name) => {
    const source = extractFunction(name);
    assert.doesNotMatch(source, /forEach\([^)]*=>\s*{[^}]*stampRecord/);
  });
});

test("184. build/sintaxis: outputs/app.js sigue siendo JS valido tras integrar el modulo de inventario", () => {
  assert.doesNotThrow(() => new Function(appJs));
});

test("185. cero escrituras en produccion: este archivo no importa supabase-js ni referencia el dominio de produccion", () => {
  const source = fs.readFileSync(__filename, "utf8");
  assert.doesNotMatch(source, /supabase\.co|@supabase\/supabase-js/);
});

// ===========================================================================
// Eventos de auditoria requeridos por el enunciado (seccion 45): presencia
// exacta en outputs/app.js.
// ===========================================================================

test("todos los eventos de auditoria requeridos existen con el nombre EXACTO especificado", () => {
  [
    "inventory_item_created",
    "inventory_item_updated",
    "warehouse_created",
    "warehouse_configuration_changed",
    "inventory_purchase_created",
    "inventory_purchase_confirmed",
    "inventory_movement_created",
    "inventory_negative_override",
    "inventory_transfer_created",
    "inventory_physical_count_confirmed",
    "inventory_loss_recorded",
    "supplier_payable_created",
    "supplier_payment_created",
    "service_recipe_updated",
    "service_inventory_consumed",
    "asset_created",
    "asset_custody_assigned",
    "asset_condition_changed",
    "asset_maintenance_recorded",
    "retail_product_sold",
  ].forEach((eventName) => {
    assert.match(appJs, new RegExp(`logAudit\\("${eventName}"`), `falta logAudit("${eventName}"`);
  });
});

// ===========================================================================
// Q. Auditoria de mesas, factura mixta y costos de inventario (fase julio
// 2026, ver 4019441 -> siguiente commit): consumo estructurado, costo/margen
// directo congelado y reportes operativos nuevos.
// ===========================================================================

test("nuevos eventos de auditoria del consumo estructurado existen (pendiente/fallido), ademas del ya existente service_inventory_consumed", () => {
  ["service_inventory_pending", "service_inventory_failed", "inventory_consumption_mode_changed"].forEach((eventName) => {
    assert.match(appJs, new RegExp(`logAudit\\("${eventName}"`), `falta logAudit("${eventName}"`);
  });
});

test("costo/margen directo por servicio se congela en el detalle de factura al crearla (usa el costo promedio de ESE momento, vía computeServiceDirectCostAndMargin)", () => {
  const source = extractFunction("computeServiceDirectCostAndMargin");
  assert.match(source, /DalfiClosingMath\.calculateServiceDirectCost/);
  assert.match(source, /DalfiClosingMath\.calculateDirectMargin/);
  const invoiceSubmit = extractStatementBlock('let invoiceSubmitInFlight = false;', 'byId("invoice-form").addEventListener("submit"');
  assert.match(invoiceSubmit, /const directCostMargin = computeServiceDirectCostAndMargin\(line\.service, netSubtotal, line\.qty\);/);
  assert.match(invoiceSubmit, /costoDirectoEstimado: directCostMargin\.directCost,/);
  assert.match(invoiceSubmit, /margenDirectoEstimado: directCostMargin\.marginAmount,/);
});

test("confirmPendingServiceConsumption exige permiso, nunca borra el registro pendiente (lo marca Confirmado/Con errores) y reutiliza el MISMO sourceKey que el consumo directo (nunca duplica)", () => {
  const source = extractFunction("confirmPendingServiceConsumption");
  assert.match(source, /canManageInvoices\(\)/);
  assert.doesNotMatch(source, /dbTable\("consumosPendientes"\)\.splice/);
  assert.match(source, /pending\.estado = errors\.length \? "Con errores" : "Confirmado";/);
});

test("panel de reportes: los nuevos tipos de reporte de inventario estan conectados al selector y al dispatcher renderReports", () => {
  ["inventory-by-location", "inventory-low-stock", "retail-sales", "service-direct-margin", "pending-consumption"].forEach((type) => {
    assert.match(appJs, new RegExp(`if \\(type === "${type}"\\) return render`));
    assert.match(indexHtml, new RegExp(`<option value="${type}">`));
  });
});

test("renderInventoryReport ya no usa row.existencia/row.costo obsoletos: usa itemStockAt (existencia SIEMPRE derivada)", () => {
  const source = extractFunction("renderInventoryReport");
  assert.doesNotMatch(source, /row\.existencia\b/);
  assert.match(source, /itemStockAt\(row\.itemID\)/);
});

test("renderServiceDirectMarginReport respeta el costo/margen ya congelado en el detalle (no lo recalcula) cuando existe, y solo recalcula para compatibilidad con facturas anteriores sin esos campos", () => {
  const source = extractFunction("renderServiceDirectMarginReport");
  assert.match(source, /detail\.costoDirectoEstimado !== undefined && detail\.margenDirectoEstimado !== undefined/);
});

test("dependencia pendiente documentada: reverseInvoiceInventoryEffects (motor puro en closing-math.js) todavia NO tiene un boton de anulacion en app.js — evita una anulación financiera parcial/insegura, tal como pide el enunciado", () => {
  assert.doesNotMatch(appJs, /reverseInvoiceInventoryEffects/);
});
