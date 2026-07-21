const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const authzModuleUrl = pathToFileURL(path.join(__dirname, "..", "functions", "api", "_lib", "authz.js")).href;

function withFakeFetch(handler, fn) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length);
  };
  return fn(calls).finally(() => {
    global.fetch = originalFetch;
  });
}

function fakeRequest(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return new Request("https://fake.supabase.co/api/whatever", { method: "POST", headers });
}

const BASE_ENV = {
  SUPABASE_URL: "https://fake.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "pub",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
};

function authUserResponse(overrides = {}) {
  return new Response(JSON.stringify({ id: "user-1", email: "duena@dalfi.test", user_metadata: {}, ...overrides }), { status: 200 });
}

function profileResponse(rows) {
  return new Response(JSON.stringify(rows), { status: 200 });
}

test("defaultPermissionsForRole: operador no recibe NINGUN permiso administrativo por defecto", async () => {
  const { defaultPermissionsForRole } = await import(authzModuleUrl);
  const permissions = defaultPermissionsForRole("operador");
  assert.strictEqual(permissions.can_manage_users, false);
  assert.strictEqual(permissions.can_manage_invoices, false);
  assert.strictEqual(permissions.can_confirm_register_closings, false);
  assert.strictEqual(permissions.can_confirm_treasury_closings, false);
  assert.strictEqual(permissions.can_reopen_closings, false);
  assert.strictEqual(permissions.can_review_accounts, false);
  assert.strictEqual(permissions.can_review_audit, false);
  // Cualquier usuario activo puede someter un conteo de caja: no es un
  // permiso administrativo, es la accion operativa basica de una cajera.
  assert.strictEqual(permissions.can_submit_register_count, true);
});

test("defaultPermissionsForRole: administradora/propietario reciben todos los permisos administrativos", async () => {
  const { defaultPermissionsForRole } = await import(authzModuleUrl);
  for (const role of ["administradora", "administrador", "propietaria", "propietario"]) {
    const permissions = defaultPermissionsForRole(role);
    assert.strictEqual(permissions.can_manage_users, true, role);
    assert.strictEqual(permissions.can_manage_invoices, true, role);
    assert.strictEqual(permissions.can_confirm_register_closings, true, role);
    assert.strictEqual(permissions.can_confirm_treasury_closings, true, role);
    assert.strictEqual(permissions.can_reopen_closings, true, role);
    assert.strictEqual(permissions.can_review_accounts, true, role);
    assert.strictEqual(permissions.can_review_audit, true, role);
  }
});

test("defaultPermissionsForRole: contador/contadora revisan cuentas y auditoria pero NUNCA permisos administrativos", async () => {
  const { defaultPermissionsForRole } = await import(authzModuleUrl);
  for (const role of ["contador", "contadora"]) {
    const permissions = defaultPermissionsForRole(role);
    assert.strictEqual(permissions.can_review_accounts, true, role);
    assert.strictEqual(permissions.can_review_audit, true, role);
    assert.strictEqual(permissions.can_manage_users, false, role);
    assert.strictEqual(permissions.can_manage_invoices, false, role);
    assert.strictEqual(permissions.can_confirm_register_closings, false, role);
    assert.strictEqual(permissions.can_confirm_treasury_closings, false, role);
    assert.strictEqual(permissions.can_reopen_closings, false, role);
  }
});

test("defaultPermissionsForRole: asistente_contable/asistenta_contable NO revisan auditoria por defecto (solo con flag explicito via upsertErpProfile)", async () => {
  const { defaultPermissionsForRole } = await import(authzModuleUrl);
  for (const role of ["asistente_contable", "asistenta_contable"]) {
    const permissions = defaultPermissionsForRole(role);
    assert.strictEqual(permissions.can_review_audit, false, role);
    assert.strictEqual(permissions.can_review_accounts, false, role);
    assert.strictEqual(permissions.can_manage_users, false, role);
  }
});

test("upsertErpProfile: canReviewAuditOverride SI activa can_review_audit para un asistente_contable (flag explicito)", async () => {
  const { upsertErpProfile } = await import(authzModuleUrl);
  await withFakeFetch(
    async () => new Response(null, { status: 201 }),
    async (calls) => {
      await upsertErpProfile(
        { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" },
        { userId: "u1", email: "asistente@dalfi.test", role: "asistente_contable", isActive: true, canReviewAuditOverride: true }
      );
      const body = JSON.parse(calls[0].options.body);
      assert.strictEqual(body.can_review_audit, true);
      assert.strictEqual(body.can_manage_users, false, "el override de auditoria nunca debe otorgar permisos administrativos");
    }
  );
});

test("upsertErpProfile: sin canReviewAuditOverride, un asistente_contable NO recibe can_review_audit (comportamiento por defecto)", async () => {
  const { upsertErpProfile } = await import(authzModuleUrl);
  await withFakeFetch(
    async () => new Response(null, { status: 201 }),
    async (calls) => {
      await upsertErpProfile(
        { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" },
        { userId: "u2", email: "asistente2@dalfi.test", role: "asistente_contable", isActive: true }
      );
      const body = JSON.parse(calls[0].options.body);
      assert.strictEqual(body.can_review_audit, false);
    }
  );
});

test("normalizeRole: rol desconocido o con espacios/mayusculas cae a 'operador'", async () => {
  const { normalizeRole } = await import(authzModuleUrl);
  assert.strictEqual(normalizeRole("  Administradora  "), "administradora");
  assert.strictEqual(normalizeRole("PROPIETARIO"), "propietario");
  assert.strictEqual(normalizeRole("rol-inventado"), "operador");
  assert.strictEqual(normalizeRole(""), "operador");
  assert.strictEqual(normalizeRole(undefined), "operador");
});

test("resolveErpIdentity: sin Authorization header, devuelve error 'unauthenticated'", async () => {
  const { resolveErpIdentity } = await import(authzModuleUrl);
  await withFakeFetch(
    async () => {
      throw new Error("no deberia llamarse a fetch sin token");
    },
    async () => {
      const identity = await resolveErpIdentity(fakeRequest(null), BASE_ENV);
      assert.strictEqual(identity.error, "unauthenticated");
    }
  );
});

test("resolveErpIdentity: JWT invalido (Supabase Auth responde error), devuelve 'unauthenticated'", async () => {
  const { resolveErpIdentity } = await import(authzModuleUrl);
  await withFakeFetch(
    async () => new Response(JSON.stringify({ error: "invalid token" }), { status: 401 }),
    async () => {
      const identity = await resolveErpIdentity(fakeRequest("bad-jwt"), BASE_ENV);
      assert.strictEqual(identity.error, "unauthenticated");
    }
  );
});

test("resolveErpIdentity: JWT valido pero sin fila en erp_user_profiles y sin ADMIN_EMAILS, devuelve 'no_profile'", async () => {
  const { resolveErpIdentity } = await import(authzModuleUrl);
  await withFakeFetch(
    async (url) => (url.includes("/auth/v1/user") ? authUserResponse() : profileResponse([])),
    async () => {
      const identity = await resolveErpIdentity(fakeRequest("jwt"), BASE_ENV);
      assert.strictEqual(identity.error, "no_profile");
    }
  );
});

test("resolveErpIdentity: perfil inactivo devuelve 'inactive' aunque el rol sea administrativo", async () => {
  const { resolveErpIdentity } = await import(authzModuleUrl);
  await withFakeFetch(
    async (url) =>
      url.includes("/auth/v1/user")
        ? authUserResponse()
        : profileResponse([
            {
              role: "administradora",
              is_active: false,
              can_manage_users: true,
              can_manage_invoices: true,
              can_review_accounts: true,
              can_review_audit: true,
              can_submit_register_count: true,
              can_confirm_register_closings: true,
              can_confirm_treasury_closings: true,
              can_reopen_closings: true,
            },
          ]),
    async () => {
      const identity = await resolveErpIdentity(fakeRequest("jwt"), BASE_ENV);
      assert.strictEqual(identity.error, "inactive");
    }
  );
});

test("resolveErpIdentity: user_metadata.role NO concede privilegios — solo cuenta lo que diga erp_user_profiles", async () => {
  const { resolveErpIdentity } = await import(authzModuleUrl);
  await withFakeFetch(
    async (url) =>
      url.includes("/auth/v1/user")
        ? authUserResponse({ user_metadata: { role: "administradora" } }) // el navegador "dice" ser admin...
        : profileResponse([
            {
              role: "operador", // ...pero el perfil seguro dice operador.
              is_active: true,
              can_manage_users: false,
              can_manage_invoices: false,
              can_review_accounts: false,
              can_review_audit: false,
              can_submit_register_count: true,
              can_confirm_register_closings: false,
              can_confirm_treasury_closings: false,
              can_reopen_closings: false,
            },
          ]),
    async () => {
      const identity = await resolveErpIdentity(fakeRequest("jwt"), BASE_ENV);
      assert.strictEqual(identity.role, "operador");
      assert.strictEqual(identity.permissions.canManageUsers, false);
    }
  );
});

test("resolveErpIdentity: sin perfil pero con correo en ADMIN_EMAILS, concede acceso de emergencia marcado como tal", async () => {
  const { resolveErpIdentity } = await import(authzModuleUrl);
  await withFakeFetch(
    async (url) => (url.includes("/auth/v1/user") ? authUserResponse({ email: "emergencia@dalfi.test" }) : profileResponse([])),
    async () => {
      const identity = await resolveErpIdentity(fakeRequest("jwt"), { ...BASE_ENV, ADMIN_EMAILS: "emergencia@dalfi.test" });
      assert.strictEqual(identity.error, undefined);
      assert.strictEqual(identity.viaEmergencyFallback, true);
      assert.strictEqual(identity.permissions.canManageUsers, true);
    }
  );
});

test("requireErpPermission: un operador (sin permiso) recibe 403 al intentar administrar usuarios", async () => {
  const { requireErpPermission } = await import(authzModuleUrl);
  await withFakeFetch(
    async (url) =>
      url.includes("/auth/v1/user")
        ? authUserResponse()
        : profileResponse([
            {
              role: "operador",
              is_active: true,
              can_manage_users: false,
              can_manage_invoices: false,
              can_review_accounts: false,
              can_review_audit: false,
              can_submit_register_count: true,
              can_confirm_register_closings: false,
              can_confirm_treasury_closings: false,
              can_reopen_closings: false,
            },
          ]),
    async () => {
      const result = await requireErpPermission(fakeRequest("jwt"), BASE_ENV, "canManageUsers", "administrar usuarios");
      assert.ok(result.error, "debe rechazar con un Response de error");
      assert.strictEqual(result.error.status, 403);
    }
  );
});

test("requireErpPermission: una administradora con el permiso SI puede pasar", async () => {
  const { requireErpPermission } = await import(authzModuleUrl);
  await withFakeFetch(
    async (url) =>
      url.includes("/auth/v1/user")
        ? authUserResponse()
        : profileResponse([
            {
              role: "administradora",
              is_active: true,
              can_manage_users: true,
              can_manage_invoices: true,
              can_review_accounts: true,
              can_review_audit: true,
              can_submit_register_count: true,
              can_confirm_register_closings: true,
              can_confirm_treasury_closings: true,
              can_reopen_closings: true,
            },
          ]),
    async () => {
      const result = await requireErpPermission(fakeRequest("jwt"), BASE_ENV, "canManageUsers", "administrar usuarios");
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(result.identity.role, "administradora");
    }
  );
});
