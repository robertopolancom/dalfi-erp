// Matriz explicita columna SQL <-> propiedad API/frontend. Si alguno de los
// 8 permisos se pierde o se escribe mal en cualquiera de las tres capas
// (migracion SQL, functions/api/_lib/authz.js, o outputs/app.js), estas
// pruebas deben fallar.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MATRIX = [
  ["can_review_accounts", "canReviewAccounts"],
  ["can_review_audit", "canReviewAudit"],
  ["can_submit_register_count", "canSubmitRegisterCount"],
  ["can_confirm_register_closings", "canConfirmRegisterClosings"],
  ["can_confirm_treasury_closings", "canConfirmTreasuryClosings"],
  ["can_manage_users", "canManageUsers"],
  ["can_manage_invoices", "canManageInvoices"],
  ["can_reopen_closings", "canReopenClosings"],
];

const authzModuleUrl = pathToFileURL(path.join(__dirname, "..", "functions", "api", "_lib", "authz.js")).href;
const profilesSql = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20260721000000_create_erp_user_profiles.sql"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");

test("migracion SQL: la tabla erp_user_profiles tiene EXACTAMENTE las 8 columnas can_* de la matriz (ni de mas ni de menos)", () => {
  const columnMatches = [...profilesSql.matchAll(/^\s*(can_[a-z_]+)\s+boolean/gm)].map((m) => m[1]);
  const uniqueColumns = [...new Set(columnMatches)];
  const expected = MATRIX.map(([sqlColumn]) => sqlColumn).sort();
  assert.deepStrictEqual(uniqueColumns.sort(), expected);
});

test("authz.js defaultPermissionsForRole(): devuelve EXACTAMENTE las 8 claves snake_case de la matriz", async () => {
  const { defaultPermissionsForRole } = await import(authzModuleUrl);
  const keys = Object.keys(defaultPermissionsForRole("administradora")).sort();
  assert.deepStrictEqual(keys, MATRIX.map(([sqlColumn]) => sqlColumn).sort());
});

test("authz.js permissionsFromProfileRow() (via resolveErpIdentity): cada columna snake_case se mapea a la propiedad camelCase exacta de la matriz, sin perder ninguna", async () => {
  const { resolveErpIdentity } = await import(authzModuleUrl);
  const originalFetch = global.fetch;
  const profileRow = Object.fromEntries(MATRIX.map(([sqlColumn], index) => [sqlColumn, index % 2 === 0]));
  global.fetch = async (url) => {
    if (String(url).includes("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "user-1", email: "x@dalfi.test" }), { status: 200 });
    }
    return new Response(JSON.stringify([{ role: "administradora", is_active: true, ...profileRow }]), { status: 200 });
  };
  try {
    const request = new Request("https://fake.supabase.co/whatever", { headers: { Authorization: "Bearer jwt" } });
    const identity = await resolveErpIdentity(request, {
      SUPABASE_URL: "https://fake.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "pub",
      SUPABASE_SERVICE_ROLE_KEY: "service-key",
    });
    for (const [sqlColumn, camelKey] of MATRIX) {
      assert.strictEqual(
        identity.permissions[camelKey],
        Boolean(profileRow[sqlColumn]),
        `${sqlColumn} -> ${camelKey} no se mapeo correctamente (valor undefined o distinto al esperado)`
      );
    }
    assert.strictEqual(Object.keys(identity.permissions).length, MATRIX.length, "no debe haber propiedades de mas ni de menos en identity.permissions");
  } finally {
    global.fetch = originalFetch;
  }
});

test("authz.js upsertErpProfile(): el payload que se envia a Postgres incluye las 8 columnas snake_case de la matriz", async () => {
  const { upsertErpProfile } = await import(authzModuleUrl);
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(null, { status: 201 });
  };
  try {
    await upsertErpProfile(
      { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" },
      { userId: "u1", email: "x@dalfi.test", role: "propietaria", isActive: true }
    );
    for (const [sqlColumn] of MATRIX) {
      assert.ok(Object.prototype.hasOwnProperty.call(capturedBody, sqlColumn), `upsertErpProfile no envio la columna ${sqlColumn}`);
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("outputs/app.js: erpProfile.permissions.* se lee con las MISMAS claves camelCase de la matriz (sin typos ni pluralizacion distinta)", () => {
  for (const [, camelKey] of MATRIX) {
    // No todas las 8 se usan directamente en app.js hoy (algunas quedan
    // reservadas para fases futuras, p.ej. canSubmitRegisterCount todavia
    // no gatea ninguna accion de UI), pero si alguna SI aparece, debe
    // aparecer con el nombre exacto de la matriz, nunca una variante.
    const usedWithTypo = new RegExp(`erpProfile\\.permissions\\?\\.${camelKey}[a-zA-Z]`).test(appJs);
    assert.ok(!usedWithTypo, `posible typo: se encontro erpProfile.permissions?.${camelKey} seguido de mas caracteres`);
  }
  // Los tres permisos que si gatean UI hoy deben usar el nombre exacto.
  assert.match(appJs, /erpProfile\.permissions\?\.canManageInvoices/);
  assert.match(appJs, /erpProfile\.permissions\?\.canConfirmRegisterClosings/);
  assert.match(appJs, /erpProfile\.permissions\?\.canConfirmTreasuryClosings/);
  assert.match(appJs, /erpProfile\.permissions\?\.canReviewAccounts/);
});
