const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const moduleUrl = pathToFileURL(path.join(__dirname, "..", "functions", "api", "create-user.js")).href;

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

function postRequest(body) {
  return new Request("https://fake.supabase.co/api/create-user", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer jwt" },
    body: JSON.stringify(body),
  });
}

function adminIdentityResponses(url) {
  if (url.includes("/auth/v1/user")) {
    return new Response(JSON.stringify({ id: "admin-1", email: "admin@dalfi.test" }), { status: 200 });
  }
  if (url.includes("/rest/v1/erp_user_profiles") && !url.includes("on_conflict")) {
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
  return null;
}

test("create-user: si Auth crea el usuario pero upsertErpProfile falla, NO responde exito, borra el usuario Auth huerfano y audita el fallo", async () => {
  const { onRequestPost } = await import(moduleUrl);
  const deleteCalls = [];
  const auditInserts = [];
  await withFakeFetch(
    (url, options) => {
      const identity = adminIdentityResponses(url);
      if (identity) return identity;
      if (url.includes("/auth/v1/admin/users") && options.method === "POST") {
        return new Response(JSON.stringify({ id: "new-user-1", email: "nuevo@dalfi.test" }), { status: 200 });
      }
      if (url.includes("/rest/v1/erp_user_profiles") && url.includes("on_conflict")) {
        // Fallo simulado del alta del perfil seguro (p.ej. la migracion
        // todavia no esta aplicada, o un error transitorio de Postgres).
        return new Response(JSON.stringify({ message: "relation erp_user_profiles does not exist" }), { status: 404 });
      }
      if (url.includes(`/auth/v1/admin/users/${encodeURIComponent("new-user-1")}`) && options.method === "DELETE") {
        deleteCalls.push(url);
        return new Response(null, { status: 200 });
      }
      if (url.includes("/rest/v1/erp_audit_log")) {
        auditInserts.push(JSON.parse(options.body));
        return new Response(null, { status: 201 });
      }
      throw new Error(`URL inesperada: ${url} (${options?.method || "GET"})`);
    },
    async () => {
      const response = await onRequestPost({
        request: postRequest({ email: "nuevo@dalfi.test", fullName: "Nuevo", role: "operador" }),
        env: BASE_ENV,
      });
      assert.notStrictEqual(response.status, 200, "nunca debe responder 200/exito si el perfil seguro no se pudo crear");
      assert.strictEqual(deleteCalls.length, 1, "debe borrar el usuario Auth huerfano exactamente una vez");
      assert.strictEqual(auditInserts.length, 1);
      assert.strictEqual(auditInserts[0].success, false, "la auditoria debe registrar el intento como fallido");
      assert.ok(!/does not exist/i.test((await response.clone().json()).error || ""), "el detalle interno de Postgres no debe llegar al cliente");
    }
  );
});

test("create-user: si tambien falla borrar el usuario Auth huerfano, igual responde error (nunca exito) y deja constancia en auditoria", async () => {
  const { onRequestPost } = await import(moduleUrl);
  const auditInserts = [];
  await withFakeFetch(
    (url, options) => {
      const identity = adminIdentityResponses(url);
      if (identity) return identity;
      if (url.includes("/auth/v1/admin/users") && options.method === "POST") {
        return new Response(JSON.stringify({ id: "new-user-2", email: "nuevo2@dalfi.test" }), { status: 200 });
      }
      if (url.includes("/rest/v1/erp_user_profiles") && url.includes("on_conflict")) {
        return new Response(JSON.stringify({ message: "network error" }), { status: 500 });
      }
      if (url.includes(`/auth/v1/admin/users/${encodeURIComponent("new-user-2")}`) && options.method === "DELETE") {
        return new Response(JSON.stringify({ error: "no se pudo borrar" }), { status: 500 });
      }
      if (url.includes("/rest/v1/erp_audit_log")) {
        auditInserts.push(JSON.parse(options.body));
        return new Response(null, { status: 201 });
      }
      throw new Error(`URL inesperada: ${url} (${options?.method || "GET"})`);
    },
    async () => {
      const response = await onRequestPost({
        request: postRequest({ email: "nuevo2@dalfi.test", fullName: "Nuevo", role: "operador" }),
        env: BASE_ENV,
      });
      assert.notStrictEqual(response.status, 200);
      assert.strictEqual(auditInserts.length, 1);
      assert.match(auditInserts[0].note, /ALERTA/i, "debe marcar claramente que requiere revision manual");
    }
  );
});

test("create-user: cuando upsertErpProfile SI tiene exito, responde exito normalmente (no compensa nada)", async () => {
  const { onRequestPost } = await import(moduleUrl);
  let deleteCalled = false;
  await withFakeFetch(
    (url, options) => {
      const identity = adminIdentityResponses(url);
      if (identity) return identity;
      if (url.includes("/auth/v1/admin/users") && options.method === "POST") {
        return new Response(JSON.stringify({ id: "new-user-3", email: "nuevo3@dalfi.test" }), { status: 200 });
      }
      if (url.includes("/rest/v1/erp_user_profiles") && url.includes("on_conflict")) {
        return new Response(null, { status: 201 });
      }
      if (options.method === "DELETE") {
        deleteCalled = true;
        return new Response(null, { status: 200 });
      }
      if (url.includes("/rest/v1/erp_audit_log")) {
        return new Response(null, { status: 201 });
      }
      throw new Error(`URL inesperada: ${url} (${options?.method || "GET"})`);
    },
    async () => {
      const response = await onRequestPost({
        request: postRequest({ email: "nuevo3@dalfi.test", fullName: "Nuevo", role: "operador" }),
        env: BASE_ENV,
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(deleteCalled, false);
    }
  );
});
