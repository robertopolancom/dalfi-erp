const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");
const policy = fs.readFileSync(path.join(__dirname, "..", "functions", "api", "_lib", "database-authz.js"), "utf8");
const configurationMigration = fs.readFileSync(
  path.join(__dirname, "..", "supabase", "migrations", "20260725000007_add_configuration_permission.sql"),
  "utf8",
);

const DOMAIN_PERMISSIONS = [
  ["reservas", "canManageReservations"],
  ["facturacion", "canManageBilling"],
  ["inventario", "canManageInventory"],
  ["nomina", "canManagePayroll"],
  ["cuentas", "canManageAccounts"],
  ["configuracion", "canManageConfiguration"],
];

test("revisión integral: cada dominio mutable tiene un permiso específico en el servidor", () => {
  for (const [domain, permission] of DOMAIN_PERMISSIONS) {
    assert.match(policy, new RegExp(`changes\\.domains\\.includes\\("${domain}"\\)[\\s\\S]{0,180}${permission}`));
  }
});

test("revisión integral: canManageInvoices ya no es una llave maestra en /api/database", () => {
  assert.doesNotMatch(policy, /if \(permissions\.canManageInvoices\) return \{ allowed: true \}/);
});

test("revisión integral: la SPA resuelve todos los permisos por el perfil seguro y nunca por user_metadata", () => {
  for (const [, permission] of DOMAIN_PERMISSIONS) {
    const functionName = permission;
    const start = app.indexOf(`function ${functionName}()`);
    assert.ok(start >= 0, `falta ${functionName}()`);
    const end = app.indexOf("\n}", start);
    const source = app.slice(start, end + 2);
    assert.match(source, new RegExp(`erpProfile\\.permissions\\?\\.${permission}`));
    assert.doesNotMatch(source, /user_metadata/);
  }
});

test("revisión integral: lectura de cuentas no concede escritura de cuentas", () => {
  const start = app.indexOf("function canManageAccounts()");
  const end = app.indexOf("\n}", start);
  const source = app.slice(start, end + 2);
  assert.match(source, /canManageAccounts/);
  assert.doesNotMatch(source, /canReviewAccounts/);
});

test("revisión integral: los cambios de estado en Base de datos usan el permiso del dominio de la tabla", () => {
  assert.match(app, /function canManageSettingsTable\(table\)/);
  assert.match(app, /if \(table === "clientes"\) return canManageBilling\(\)/);
  assert.match(app, /return canManageConfiguration\(\)/);
  assert.match(app, /if \(!canManageSettingsTable\(statusButton\.dataset\.table\)\)/);
});

test("revisión integral: clientes y servicios tienen guardas explícitas en sus formularios", () => {
  const clientStart = app.indexOf("const saveClientCatalog = (event) => {");
  const serviceStart = app.indexOf('byId("service-form").addEventListener("submit"');
  assert.match(app.slice(clientStart, clientStart + 500), /if \(!canManageBilling\(\)\)/);
  assert.match(app.slice(serviceStart, serviceStart + 500), /if \(!canManageConfiguration\(\)\)/);
});

test("revisión integral: current_erp_profile expone también los seis permisos por dominio", () => {
  for (const [, permission] of DOMAIN_PERMISSIONS) {
    const sqlName = permission.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    assert.match(configurationMigration, new RegExp(`\\b${sqlName}\\s+boolean\\b`));
  }
});
