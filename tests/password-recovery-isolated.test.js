// TEST_RUN_ID: E2E-SECURITY-20260721-password-recovery
//
// Ciclo completo de "administrador fuerza un reset" (flujo C de la seccion
// 4/11 de la revision de seguridad), ejecutado en aislamiento total via
// mocks de fetch (nunca toca Supabase real, nunca crea un usuario Auth
// real): confirma que el reset (a) invalida sesiones previas llamando al
// endpoint /logout de Supabase Auth, y (b) nunca deja la contrasena
// temporal en texto plano dentro de la auditoria (old_data/new_data).
// No se genera ningun registro persistente: todo el estado vive en los
// arrays `calls`/`auditInserts` de esta prueba y se descarta al terminar.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const moduleUrl = pathToFileURL(path.join(__dirname, "..", "functions", "api", "users.js")).href;

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

const TARGET_ID = "target-user-reset-1";

function patchRequest(body) {
  return new Request("https://fake.supabase.co/api/users", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: "Bearer jwt" },
    body: JSON.stringify(body),
  });
}

function adminIdentity(url) {
  if (url.includes("/auth/v1/user")) {
    return new Response(JSON.stringify({ id: "admin-1", email: "admin@dalfi.test" }), { status: 200 });
  }
  if (url.includes("/rest/v1/erp_user_profiles") && url.includes("user_id=eq.admin-1")) {
    return new Response(
      JSON.stringify([{ role: "administradora", is_active: true, can_manage_users: true, can_manage_invoices: true, can_review_accounts: true, can_review_audit: true, can_submit_register_count: true, can_confirm_register_closings: true, can_confirm_treasury_closings: true, can_reopen_closings: true }]),
      { status: 200 }
    );
  }
  return null;
}

test("reset de contrasena por administrador: invalida sesiones previas (llama a /auth/v1/admin/users/<id>/logout)", async () => {
  const { onRequestPatch } = await import(moduleUrl);
  let logoutCalled = false;
  await withFakeFetch(
    (url, options) => {
      const identity = adminIdentity(url);
      if (identity) return identity;
      if (url === `https://fake.supabase.co/auth/v1/admin/users/${TARGET_ID}` && !options.method) {
        return new Response(JSON.stringify({ id: TARGET_ID, email: "objetivo@dalfi.test", user_metadata: {} }), { status: 200 });
      }
      if (url === `https://fake.supabase.co/auth/v1/admin/users/${TARGET_ID}` && options.method === "PATCH") {
        return new Response(JSON.stringify({ id: TARGET_ID, email: "objetivo@dalfi.test" }), { status: 200 });
      }
      if (url === `https://fake.supabase.co/auth/v1/admin/users/${TARGET_ID}/logout` && options.method === "POST") {
        logoutCalled = true;
        return new Response(null, { status: 204 });
      }
      if (url.includes("/rest/v1/erp_user_profiles") && url.includes(`user_id=eq.${TARGET_ID}`) && !options?.method) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/rest/v1/erp_user_profiles") && url.includes("on_conflict")) {
        return new Response(null, { status: 201 });
      }
      if (url.includes("/rest/v1/erp_audit_log")) {
        return new Response(null, { status: 201 });
      }
      throw new Error(`URL inesperada: ${url} (${options?.method || "GET"})`);
    },
    async () => {
      const response = await onRequestPatch({ request: patchRequest({ id: TARGET_ID, resetPassword: true }), env: BASE_ENV });
      assert.strictEqual(response.status, 200);
      const body = await response.json();
      assert.ok(body.temporaryPassword, "debe devolver una contrasena temporal para entregar fuera de banda");
      assert.strictEqual(logoutCalled, true, "debe invalidar la sesion previa del usuario reseteado");
    }
  );
});

test("reset de contrasena por administrador: la contrasena temporal NUNCA aparece en texto plano en la auditoria (old_data/new_data/note)", async () => {
  const { onRequestPatch } = await import(moduleUrl);
  const auditInserts = [];
  let issuedTemporaryPassword = null;
  await withFakeFetch(
    (url, options) => {
      const identity = adminIdentity(url);
      if (identity) return identity;
      if (url === `https://fake.supabase.co/auth/v1/admin/users/${TARGET_ID}` && !options.method) {
        return new Response(JSON.stringify({ id: TARGET_ID, email: "objetivo@dalfi.test", user_metadata: {} }), { status: 200 });
      }
      if (url === `https://fake.supabase.co/auth/v1/admin/users/${TARGET_ID}` && options.method === "PATCH") {
        return new Response(JSON.stringify({ id: TARGET_ID, email: "objetivo@dalfi.test" }), { status: 200 });
      }
      if (url.includes("/logout")) return new Response(null, { status: 204 });
      if (url.includes("/rest/v1/erp_user_profiles") && url.includes(`user_id=eq.${TARGET_ID}`) && !options?.method) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/rest/v1/erp_user_profiles") && url.includes("on_conflict")) {
        return new Response(null, { status: 201 });
      }
      if (url.includes("/rest/v1/erp_audit_log")) {
        auditInserts.push(JSON.parse(options.body));
        return new Response(null, { status: 201 });
      }
      throw new Error(`URL inesperada: ${url} (${options?.method || "GET"})`);
    },
    async () => {
      const response = await onRequestPatch({ request: patchRequest({ id: TARGET_ID, resetPassword: true }), env: BASE_ENV });
      const body = await response.json();
      issuedTemporaryPassword = body.temporaryPassword;
      assert.ok(issuedTemporaryPassword && issuedTemporaryPassword.length >= 6);

      const serializedAudit = JSON.stringify(auditInserts);
      assert.ok(!serializedAudit.includes(issuedTemporaryPassword), "la contrasena temporal generada no debe aparecer en ninguna entrada de auditoria");
      const resetEntry = auditInserts.find((entry) => entry.action === "reset_password");
      assert.ok(resetEntry, "debe existir una entrada de auditoria para el reset");
      assert.strictEqual(resetEntry.success, true);
    }
  );
});
