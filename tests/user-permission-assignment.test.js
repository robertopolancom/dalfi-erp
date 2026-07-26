const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const authzPath = path.join(__dirname, "..", "functions", "api", "_lib", "authz.js");
const usersSource = fs.readFileSync(path.join(__dirname, "..", "functions", "api", "users.js"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");
const legacyMigration = fs.readFileSync(
  path.join(__dirname, "..", "supabase", "migrations", "20260725000008_deprecate_legacy_invoice_permission.sql"),
  "utf8",
);
const authzUrl = pathToFileURL(authzPath).href;

test("matriz administrativa: expone exactamente los 13 permisos vigentes y excluye canManageInvoices", async () => {
  const { PROFILE_PERMISSION_MAP } = await import(authzUrl);
  assert.strictEqual(Object.keys(PROFILE_PERMISSION_MAP).length, 13);
  assert.ok(!Object.prototype.hasOwnProperty.call(PROFILE_PERMISSION_MAP, "canManageInvoices"));
  for (const key of Object.keys(PROFILE_PERMISSION_MAP)) {
    assert.match(appSource, new RegExp(`\\["${key}",\\s*"[^"]+"\\]`), `falta control para ${key}`);
  }
});

test("upsertErpProfile: los permisos individuales pueden sumar o retirar permisos sin depender del rol", async () => {
  const { upsertErpProfile } = await import(authzUrl);
  const originalFetch = global.fetch;
  const payloads = [];
  global.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response(null, { status: 201 });
  };
  try {
    await upsertErpProfile(
      { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" },
      {
        userId: "admin-limited",
        email: "limitada@dalfi.test",
        role: "administradora",
        permissionOverrides: { canManageBilling: false, canManageReservations: true },
      },
    );
    await upsertErpProfile(
      { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" },
      {
        userId: "operator-payroll",
        email: "nomina@dalfi.test",
        role: "operador",
        permissionOverrides: { canManagePayroll: true, canManageReservations: false },
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
  assert.strictEqual(payloads[0].can_manage_billing, false);
  assert.strictEqual(payloads[0].can_manage_reservations, true);
  assert.strictEqual(payloads[1].can_manage_payroll, true);
  assert.strictEqual(payloads[1].can_manage_reservations, false);
});

test("sanitizePermissionOverrides rechaza valores no booleanos en vez de convertir strings manipulados", async () => {
  const { sanitizePermissionOverrides } = await import(authzUrl);
  assert.deepStrictEqual(sanitizePermissionOverrides({ canManageBilling: false }), { canManageBilling: false });
  assert.strictEqual(sanitizePermissionOverrides({ canManageBilling: "false" }), null);
  assert.strictEqual(sanitizePermissionOverrides({ canManageBilling: 1 }), null);
});

test("API de usuarios: valida claves, preserva matriz previa, evita auto-bloqueo y audita cambios", () => {
  assert.match(usersSource, /hasUnknownPermission/);
  assert.match(usersSource, /\{ \.\.\.\(priorPermissions \|\| \{\}\), \.\.\.requestedPermissions \}/);
  assert.match(usersSource, /userId === requesterId && \(!isActive \|\| !proposedCanManageUsers\)/);
  assert.match(usersSource, /action: "update_user_permissions"/);
  assert.match(usersSource, /permissionOverrides: permissionOverridesFromProfile\(priorProfile\)/);
});

test("SPA de usuarios: envía la matriz completa desde controles data-permission", () => {
  assert.match(appSource, /class="user-permission-input"/);
  assert.match(appSource, /data-permission="\$\{key\}"/);
  assert.ok(appSource.includes('row.querySelectorAll(".user-permission-input")'));
  assert.match(appSource, /permissions,/);
  assert.doesNotMatch(appSource, /user-review-accounts-input/);
  assert.doesNotMatch(appSource, /user-review-audit-input/);
});

test("retiro gradual: el legado queda documentado pero no aparece en controles ni llamadas de autorización SPA", () => {
  assert.match(legacyMigration, /OBSOLETO/);
  assert.doesNotMatch(appSource, /canManageInvoices\(\)/);
  assert.doesNotMatch(appSource, /\["canManageInvoices",/);
});

test("API de usuarios: el fallback de Pages delega PATCH al handler de permisos", () => {
  assert.match(usersSource, /context\?\.request\?\.method === "PATCH"/);
  assert.match(usersSource, /return onRequestPatch\(context\)/);
});
