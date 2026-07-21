const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const moduleUrl = pathToFileURL(path.join(__dirname, "..", "functions", "api", "password-reset-status.js")).href;

function withFakeFetch(handler, fn) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => handler(String(url), options);
  return fn().finally(() => {
    global.fetch = originalFetch;
  });
}

const BASE_ENV = {
  SUPABASE_URL: "https://fake.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "pub",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
};

function postRequest(body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("https://fake.supabase.co/api/password-reset-status", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

test("password-reset-status: sin JWT, devuelve 401 (ya no es un endpoint publico)", async () => {
  const { onRequestPost } = await import(moduleUrl);
  await withFakeFetch(
    () => {
      throw new Error("no deberia llamarse a fetch sin token");
    },
    async () => {
      const response = await onRequestPost({ request: postRequest({ email: "cualquiera@dalfi.test" }, null), env: BASE_ENV });
      assert.strictEqual(response.status, 401);
    }
  );
});

test("password-reset-status: un usuario autenticado SIN permiso can_manage_users recibe 403", async () => {
  const { onRequestPost } = await import(moduleUrl);
  await withFakeFetch(
    (url) =>
      url.includes("/auth/v1/user")
        ? new Response(JSON.stringify({ id: "u1", email: "operadora@dalfi.test" }), { status: 200 })
        : new Response(
            JSON.stringify([
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
            { status: 200 }
          ),
    async () => {
      const response = await onRequestPost({ request: postRequest({ email: "cualquiera@dalfi.test" }, "jwt"), env: BASE_ENV });
      assert.strictEqual(response.status, 403);
    }
  );
});

test("password-reset-status: sin importar si el correo existe o no, un no-autorizado nunca recibe esa informacion (no hay enumeracion)", async () => {
  const { onRequestPost } = await import(moduleUrl);
  await withFakeFetch(
    () => {
      throw new Error("no deberia llamarse a fetch: la peticion se rechaza antes por falta de sesion");
    },
    async () => {
      const responseExisting = await onRequestPost({ request: postRequest({ email: "existe@dalfi.test" }, null), env: BASE_ENV });
      const responseMissing = await onRequestPost({ request: postRequest({ email: "no-existe@dalfi.test" }, null), env: BASE_ENV });
      assert.strictEqual(responseExisting.status, responseMissing.status, "misma respuesta (401) sin importar el correo");
      const bodyExisting = await responseExisting.json();
      const bodyMissing = await responseMissing.json();
      assert.deepStrictEqual(bodyExisting, bodyMissing, "el cuerpo no debe diferenciar correos existentes de inexistentes");
    }
  );
});

test("password-reset-status: un administrador autorizado SI puede consultar, filtrando por correo especifico (no pagina 200 usuarios sin filtro)", async () => {
  const { onRequestPost } = await import(moduleUrl);
  let sawEmailFilterInUrl = false;
  await withFakeFetch(
    (url) => {
      if (url.includes("/auth/v1/user")) {
        return new Response(JSON.stringify({ id: "admin-1", email: "admin@dalfi.test" }), { status: 200 });
      }
      if (url.includes("/rest/v1/erp_user_profiles")) {
        return new Response(
          JSON.stringify([
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
          { status: 200 }
        );
      }
      if (url.includes("/auth/v1/admin/users")) {
        sawEmailFilterInUrl = url.includes("email=objetivo%40dalfi.test");
        return new Response(
          JSON.stringify({ users: [{ email: "objetivo@dalfi.test", user_metadata: { password_reset_required: true } }] }),
          { status: 200 }
        );
      }
      throw new Error(`URL inesperada: ${url}`);
    },
    async () => {
      const response = await onRequestPost({ request: postRequest({ email: "objetivo@dalfi.test" }, "jwt"), env: BASE_ENV });
      assert.strictEqual(response.status, 200);
      const body = await response.json();
      assert.strictEqual(body.canReset, true);
      assert.ok(sawEmailFilterInUrl, "debe pedir el correo especifico en vez de listar 200 usuarios sin filtro");
    }
  );
});
