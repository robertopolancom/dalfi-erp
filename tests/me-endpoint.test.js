const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const meModuleUrl = pathToFileURL(path.join(__dirname, "..", "functions", "api", "me.js")).href;

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

const BASE_ENV = {
  SUPABASE_URL: "https://fake.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "pub",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
};

function fakeRequest(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return new Request("https://fake.supabase.co/api/me", { headers });
}

test("GET /api/me: sin JWT devuelve 401 sin llamar a fetch", async () => {
  const { onRequestGet } = await import(meModuleUrl);
  await withFakeFetch(
    async () => {
      throw new Error("no deberia llamarse a fetch sin token");
    },
    async () => {
      const response = await onRequestGet({ request: fakeRequest(null), env: BASE_ENV });
      assert.strictEqual(response.status, 401);
    }
  );
});

test("GET /api/me: JWT invalido (Supabase Auth lo rechaza) devuelve 401", async () => {
  const { onRequestGet } = await import(meModuleUrl);
  await withFakeFetch(
    async () => new Response(JSON.stringify({ error: "invalid" }), { status: 401 }),
    async () => {
      const response = await onRequestGet({ request: fakeRequest("bad-jwt"), env: BASE_ENV });
      assert.strictEqual(response.status, 401);
    }
  );
});

test("GET /api/me: usuario autenticado sin perfil en erp_user_profiles recibe 403 (mensaje generico, sin detalles internos)", async () => {
  const { onRequestGet } = await import(meModuleUrl);
  await withFakeFetch(
    async (url) =>
      url.includes("/auth/v1/user")
        ? new Response(JSON.stringify({ id: "user-1", email: "nuevo@dalfi.test" }), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 }),
    async () => {
      const response = await onRequestGet({ request: fakeRequest("jwt"), env: BASE_ENV });
      assert.strictEqual(response.status, 403);
      const body = await response.json();
      assert.ok(!/erp_user_profiles/i.test(body.error), "el error no debe mencionar el nombre interno de la tabla");
    }
  );
});

test("GET /api/me: usuario inactivo recibe 403", async () => {
  const { onRequestGet } = await import(meModuleUrl);
  await withFakeFetch(
    async (url) =>
      url.includes("/auth/v1/user")
        ? new Response(JSON.stringify({ id: "user-1", email: "inactivo@dalfi.test" }), { status: 200 })
        : new Response(
            JSON.stringify([
              {
                role: "operador",
                is_active: false,
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
            { status: 200 }
          ),
    async () => {
      const response = await onRequestGet({ request: fakeRequest("jwt"), env: BASE_ENV });
      assert.strictEqual(response.status, 403);
    }
  );
});

test("GET /api/me: perfil activo devuelve exactamente userId/email/role/isActive/permissions, sin metadata ni claves", async () => {
  const { onRequestGet } = await import(meModuleUrl);
  await withFakeFetch(
    async (url) =>
      url.includes("/auth/v1/user")
        ? new Response(
            JSON.stringify({
              id: "user-1",
              email: "duena@dalfi.test",
              user_metadata: { role: "operador", secret_field: "no-deberia-salir" },
              app_metadata: { should: "not-leak" },
            }),
            { status: 200 }
          )
        : new Response(
            JSON.stringify([
              {
                role: "propietaria",
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
            { status: 200 }
          ),
    async () => {
      const response = await onRequestGet({ request: fakeRequest("jwt"), env: BASE_ENV });
      assert.strictEqual(response.status, 200);
      const body = await response.json();
      assert.deepStrictEqual(Object.keys(body).sort(), ["email", "isActive", "permissions", "role", "userId"]);
      assert.strictEqual(body.role, "propietaria", "el rol debe venir de erp_user_profiles, NUNCA de user_metadata (que decia 'operador')");
      assert.strictEqual(body.isActive, true);
      assert.strictEqual(body.userId, "user-1");
      assert.strictEqual(body.email, "duena@dalfi.test");
      assert.strictEqual(body.permissions.canManageUsers, true);
      const serialized = JSON.stringify(body);
      assert.ok(!serialized.includes("secret_field"), "no debe filtrar campos de user_metadata");
      assert.ok(!serialized.includes("should"), "no debe filtrar app_metadata");
      assert.ok(!serialized.includes("service-key"), "no debe filtrar la llave de servicio");
      assert.ok(!serialized.includes("jwt"), "no debe filtrar el token recibido");
    }
  );
});

test("GET /api/me: nunca devuelve datos de otro usuario (solo consulta user_id=eq.<el del JWT>)", async () => {
  const { onRequestGet } = await import(meModuleUrl);
  await withFakeFetch(
    async (url) => {
      if (url.includes("/auth/v1/user")) {
        return new Response(JSON.stringify({ id: "user-1", email: "duena@dalfi.test" }), { status: 200 });
      }
      assert.match(url, /user_id=eq\.user-1/, "el filtro debe usar el id del JWT validado, no un id arbitrario");
      return new Response(JSON.stringify([]), { status: 200 });
    },
    async () => {
      await onRequestGet({ request: fakeRequest("jwt"), env: BASE_ENV });
    }
  );
});
