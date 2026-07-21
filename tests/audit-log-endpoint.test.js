const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const moduleUrl = pathToFileURL(path.join(__dirname, "..", "functions", "api", "audit-log.js")).href;

function withFakeFetch(handler, fn) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls);
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

function postRequest(body, token = "jwt") {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("https://fake.supabase.co/api/audit-log", { method: "POST", headers, body: JSON.stringify(body) });
}

function respondIdentity(url) {
  if (url.includes("/auth/v1/user")) {
    return new Response(JSON.stringify({ id: "real-user-id", email: "real@dalfi.test" }), { status: 200 });
  }
  if (url.includes("/rest/v1/erp_user_profiles")) {
    return new Response(JSON.stringify([{ role: "administradora", is_active: true }]), { status: 200 });
  }
  return null;
}

test("audit-log: sin JWT devuelve 401", async () => {
  const { onRequestPost } = await import(moduleUrl);
  await withFakeFetch(
    () => {
      throw new Error("no deberia llamarse a fetch sin token");
    },
    async () => {
      const response = await onRequestPost({ request: postRequest({ action: "expense_create" }, null), env: BASE_ENV });
      assert.strictEqual(response.status, 401);
    }
  );
});

test("audit-log: accion fuera de la allowlist se rechaza con 400", async () => {
  const { onRequestPost } = await import(moduleUrl);
  await withFakeFetch(
    (url) => respondIdentity(url) || new Response("{}", { status: 200 }),
    async () => {
      const response = await onRequestPost({ request: postRequest({ action: "borrar_toda_la_base" }), env: BASE_ENV });
      assert.strictEqual(response.status, 400);
    }
  );
});

test("audit-log: ignora userId/userEmail/userRole que mande el navegador en el payload — usa SIEMPRE la identidad del JWT validado", async () => {
  const { onRequestPost } = await import(moduleUrl);
  let insertedBody = null;
  await withFakeFetch(
    (url, options) => {
      const identity = respondIdentity(url);
      if (identity) return identity;
      if (url.includes("/rest/v1/erp_audit_log")) {
        insertedBody = JSON.parse(options.body);
        return new Response(null, { status: 201 });
      }
      throw new Error(`URL inesperada: ${url}`);
    },
    async () => {
      const response = await onRequestPost({
        request: postRequest({
          action: "expense_create",
          entity: "egresos",
          entityId: "EGR-1",
          // Un navegador comprometido o modificado podria intentar mandar
          // esto para suplantar a otro usuario en la bitacora:
          userId: "usuario-suplantado",
          userEmail: "no-soy-yo@atacante.test",
          userRole: "propietaria",
        }),
        env: BASE_ENV,
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(insertedBody.user_id, "real-user-id");
      assert.strictEqual(insertedBody.user_email, "real@dalfi.test");
      assert.strictEqual(insertedBody.user_role, "administradora");
    }
  );
});

test("audit-log: si insertAuditLog falla, el mensaje al cliente es generico (no filtra el error interno de Postgres)", async () => {
  const { onRequestPost } = await import(moduleUrl);
  await withFakeFetch(
    (url) => {
      const identity = respondIdentity(url);
      if (identity) return identity;
      if (url.includes("/rest/v1/erp_audit_log")) {
        return new Response(JSON.stringify({ message: 'column "user_email" does not exist' }), { status: 400 });
      }
      throw new Error(`URL inesperada: ${url}`);
    },
    async () => {
      const response = await onRequestPost({ request: postRequest({ action: "expense_create" }), env: BASE_ENV });
      assert.strictEqual(response.status, 500);
      const body = await response.json();
      assert.ok(!/user_email/i.test(body.error), "no debe repetir el texto crudo del error de Postgres al cliente");
    }
  );
});
