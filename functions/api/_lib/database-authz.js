// Matriz de autorizacion para cambios al documento principal del ERP.
//
// Esta capa es deliberadamente independiente de la interfaz: recibe el
// documento remoto vigente y el documento propuesto, detecta que tablas
// cambiaron y decide usando exclusivamente la identidad segura resuelta por
// functions/api/_lib/authz.js.

const DOMAIN_TABLES = {
  facturacion: new Set([
    "clientes",
    "facturas",
    "facturaDetalle",
    "pagosFactura",
    "cuentasCobrar",
    "ingresos",
    "ingresoAplicaciones",
    "propinas",
    "auditLogLocal",
  ]),
  reservas: new Set(["reservas"]),
  cierres: new Set(["cierres", "cierreIntentos"]),
  nomina: new Set([
    "colaboradores",
    "nomina",
    "vacaciones",
    "historialSalarial",
    "conceptosDescuentoNomina",
    "configuracionTSS",
    "umbralesComision",
  ]),
  inventario: new Set([
    "inventario",
    "inventarioMovimientos",
    "almacenes",
    "comprasInventario",
    "transferenciasInventario",
    "mesas",
    "entregasColaboradoras",
    "consumosGenerales",
    "consumosActivos",
    "consumosAcademia",
    "consumosPendientes",
    "auditoriasMesa",
    "auditoriasAcademia",
    "conteosFisicos",
    "ventasDirectas",
    "activosFijos",
    "custodiaActivos",
    "assetEvents",
    "fichasTecnicas",
    "stationInventoryRules",
    "distribucionesVariacionMesa",
    "lotesInventario",
    "configuracionInventario",
    "assetConsumptionRules",
  ]),
  cuentas: new Set([
    "cuentas",
    "egresos",
    "transferencias",
    "procesadores",
    "conceptosEgresos",
    "suplidores",
    "cuentasPagar",
  ]),
  configuracion: new Set(["servicios", "usuarios", "menu", "diccionario", "reportes"]),
};

const TABLE_DOMAIN = new Map(
  Object.entries(DOMAIN_TABLES).flatMap(([domain, tables]) => [...tables].map((table) => [table, domain])),
);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function valuesEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function isAppendOnly(currentValue, proposedValue) {
  if (!Array.isArray(currentValue) || !Array.isArray(proposedValue) || proposedValue.length < currentValue.length) return false;
  return currentValue.every((row, index) => valuesEqual(row, proposedValue[index]));
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function isPendingClosing(closing) {
  const status = normalize(closing?.estado || closing?.status);
  return closing?.requiereConfirmacion === true || status.includes("pendiente") || status.includes("confirmar");
}

function closingId(closing, index) {
  return closing?.cierreID || closing?.id || `index:${index}`;
}

function detectClosingRequirements(currentRows, proposedRows) {
  const current = Array.isArray(currentRows) ? currentRows : [];
  const proposed = Array.isArray(proposedRows) ? proposedRows : [];
  const currentById = new Map(current.map((row, index) => [closingId(row, index), row]));
  const proposedById = new Map(proposed.map((row, index) => [closingId(row, index), row]));
  const requirements = new Set();

  for (const [id, oldClosing] of currentById) {
    const nextClosing = proposedById.get(id);
    if (!nextClosing) {
      requirements.add("canReopenClosings");
      continue;
    }
    if (valuesEqual(oldClosing, nextClosing)) continue;
    if (!isPendingClosing(oldClosing)) {
      requirements.add("canReopenClosings");
    } else if (!isPendingClosing(nextClosing)) {
      requirements.add(normalize(nextClosing.closingType) === "treasury" ? "canConfirmTreasuryClosings" : "canConfirmRegisterClosings");
    } else {
      requirements.add("canSubmitRegisterCount");
    }
  }
  for (const [id, nextClosing] of proposedById) {
    if (currentById.has(id)) continue;
    if (isPendingClosing(nextClosing)) requirements.add("canSubmitRegisterCount");
    else requirements.add(normalize(nextClosing.closingType) === "treasury" ? "canConfirmTreasuryClosings" : "canConfirmRegisterClosings");
  }
  return [...requirements].sort();
}

export function detectDatabaseChanges(currentDocument, proposedDocument) {
  const current = currentDocument && typeof currentDocument === "object" ? currentDocument : {};
  const proposed = proposedDocument && typeof proposedDocument === "object" ? proposedDocument : {};
  const currentData = current.data && typeof current.data === "object" ? current.data : {};
  const proposedData = proposed.data && typeof proposed.data === "object" ? proposed.data : {};
  const changedTables = [...new Set([...Object.keys(currentData), ...Object.keys(proposedData)])]
    .filter((key) => !valuesEqual(currentData[key], proposedData[key]))
    .sort();
  const changedEnvelope = [...new Set([...Object.keys(current), ...Object.keys(proposed)])]
    .filter((key) => key !== "data" && !valuesEqual(current[key], proposed[key]))
    .sort();
  const unknownTables = changedTables.filter((table) => !TABLE_DOMAIN.has(table));
  const appendOnlyTables = changedTables.filter((table) => isAppendOnly(currentData[table] || [], proposedData[table]));
  const closingRequirements = changedTables.includes("cierres")
    ? detectClosingRequirements(currentData.cierres, proposedData.cierres)
    : [];
  const domains = [...new Set(changedTables.map((table) => TABLE_DOMAIN.get(table)).filter(Boolean))].sort();
  if (changedEnvelope.length) domains.push("configuracion");
  return {
    changedTables,
    changedEnvelope,
    unknownTables,
    appendOnlyTables,
    closingRequirements,
    domains: [...new Set(domains)].sort(),
  };
}

export function authorizeDatabaseChanges(identity, changes) {
  if (!identity?.isActive) return { allowed: false, reason: "inactive" };
  if (changes.unknownTables.length) {
    return { allowed: false, reason: "unknown_tables", tables: changes.unknownTables };
  }
  if (!changes.changedTables.length && !changes.changedEnvelope.length) {
    return { allowed: true, noChanges: true };
  }

  const permissions = identity.permissions || {};
  const operationalInventorySideEffects = new Set(["inventarioMovimientos", "consumosPendientes"]);
  const inventoryTablesChanged = changes.changedTables.filter((table) => TABLE_DOMAIN.get(table) === "inventario");
  const inventoryIsInvoiceSideEffect =
    changes.changedTables.includes("facturas") &&
    inventoryTablesChanged.length > 0 &&
    inventoryTablesChanged.every(
      (table) => operationalInventorySideEffects.has(table) && changes.appendOnlyTables.includes(table),
    );
  if (changes.domains.includes("reservas") && !permissions.canManageReservations) {
    return { allowed: false, reason: "missing_reservation_permission", permissions: ["canManageReservations"] };
  }
  if (changes.domains.includes("facturacion") && !permissions.canManageBilling) {
    return { allowed: false, reason: "missing_billing_permission", permissions: ["canManageBilling"] };
  }
  if (changes.domains.includes("inventario") && !inventoryIsInvoiceSideEffect && !permissions.canManageInventory) {
    return { allowed: false, reason: "missing_inventory_permission", permissions: ["canManageInventory"] };
  }
  if (changes.domains.includes("nomina") && !permissions.canManagePayroll) {
    return { allowed: false, reason: "missing_payroll_permission", permissions: ["canManagePayroll"] };
  }
  if (changes.domains.includes("cuentas") && !permissions.canManageAccounts) {
    return { allowed: false, reason: "missing_accounts_permission", permissions: ["canManageAccounts"] };
  }
  if (changes.domains.includes("configuracion") && !permissions.canManageConfiguration) {
    return { allowed: false, reason: "missing_configuration_permission", permissions: ["canManageConfiguration"] };
  }
  const appendOnlyBillingTables = new Set([
    "facturas",
    "facturaDetalle",
    "pagosFactura",
    "cuentasCobrar",
    "ingresos",
    "ingresoAplicaciones",
    "propinas",
  ]);
  const forbiddenBillingMutation = changes.changedTables.find(
    (table) => appendOnlyBillingTables.has(table) && !changes.appendOnlyTables.includes(table),
  );
  if (forbiddenBillingMutation) {
    return { allowed: false, reason: "historical_billing_mutation", tables: [forbiddenBillingMutation] };
  }

  const missingClosingPermissions = changes.closingRequirements.filter((permission) => !permissions[permission]);
  if (missingClosingPermissions.length) {
    return { allowed: false, reason: "missing_closing_permissions", permissions: missingClosingPermissions };
  }

  const deniedDomains = changes.domains.filter((domain) => {
    if (domain === "facturacion" || domain === "reservas") return false;
    if (domain === "inventario" && (inventoryIsInvoiceSideEffect || permissions.canManageInventory)) return false;
    if (domain === "nomina" && permissions.canManagePayroll) return false;
    if (domain === "cuentas" && permissions.canManageAccounts) return false;
    if (domain === "configuracion" && permissions.canManageConfiguration) return false;
    if (domain === "cierres") return false;
    return true;
  });
  if (deniedDomains.length) return { allowed: false, reason: "forbidden_domains", domains: deniedDomains };
  return { allowed: true };
}

export const DATABASE_DOMAIN_TABLES = DOMAIN_TABLES;
