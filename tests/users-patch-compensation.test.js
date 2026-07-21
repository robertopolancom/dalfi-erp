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

const TARGET_ID = "target-user-1";

function targetAuthUser() {
  return new Response(
    JSON.stringify({ id: TARGET_ID, email: "objetivo@dalfi.test", user_metadata: { full_name: "Objetivo", role: "operador" } }),
    { status: 200 }
  );
}

test("users PATCH: si falla sincronizar el perfil, se aborta ANTES de tocar Auth (nunca hay un PATCH real a /auth/v1/admin/users/<id>)", async () => {
  const { onRequestPatch } = await import(moduleUrl);
  const authPatchCalls = [];
  await withFakeFetch(
    (url, options) => {
      const identity = adminIdentity(url);
      if (identity) return identity;
      if (url === `https://fake.supabase.co/auth/v1/admin/users/${TARGET_ID}` && options.method === undefined) {
        return targetAuthUser();
      }
      if (url === `https://fake.supabase.co/auth/v1/admin/users/${TARGET_ID}` && options.method === "PATCH") {
        authPatchCalls.push(options);
        return new Response(JSON.stringify({ id: TARGET_ID }), { status: 200 });
      }
      if (url.includes("/rest/v1/erp_user_profiles") && url.includes(`user_id=eq.${TARGET_ID}`) && !options?.method) {
        return new Response(JSON.stringify([]), { status: 200 }); // sin perfil previo
      }
      if (url.includes("/rest/v1/erp_user_profiles") && url.includes("on_conflict")) {
        return new Response(JSON.stringify({ message: "boom" }), { status: 500 }); // upsert falla
      }
      if (url.includes("/rest/v1/erp_audit_log")) {
        return new Response(null, { status: 201 });
      }
      throw new Error(`URL inesperada: ${url} (${options?.method || "GET"})`);
    },
    async () => {
      const response = await onRequestPatch({
        request: patchRequest({ id: TARGET_ID, fullName: "Objetivo Nuevo", role: "administradora" }),
        env: BASE_ENV,
      });
      assert.notStrictEqual(response.status, 200, "nunca debe responder exito si el perfil no se pudo sincronizar");
      assert.strictEqual(authPatchCalls.length, 0, "Auth no debe tocarse en absoluto si el perfil fallo antes");
    }
  );
});

test("users PATCH: si el perfil se sincroniza pero Auth rechaza el cambio, el perfil se revierte a lo que tenia antes (compensacion)", async () => {
  const { onRequestPatch } = await import(moduleUrl);
  const profileUpserts = [];
  await withFakeFetch(
    (url, options) => {
      const identity = adminIdentity(url);
      if (identity) return identity;
      if (url === `https://fake.supabase.co/auth/v1/admin/users/${TARGET_ID}` && options.method === undefined) {
        return targetAuthUser();
      }
      if (url === `https://fake.supabase.co/auth/v1/admin/users/${TARGET_ID}` && options.method === "PATCH") {
        return new Response(JSON.stringify({ message: "email ya esta en uso" }), { status: 400 });
      }
      if (url.includes("/rest/v1/erp_user_profiles") && url.includes(`user_id=eq.${TARGET_ID}`) && !options?.method) {
        // Perfil previo: operador, sin permisos.
        return new Response(
          JSON.stringify([
            {
              role: "operador",
              is_active: true,
              can_review_accounts: false,
              can_review_audit: false,
              can_manage_users: false,
              can_manage_invoices: false,
              can_confirm_register_closings: false,
              can_confirm_treasury_closings: false,
              can_reopen_closings: false,
              can_submit_register_count: true,
              email: "objetivo@dalfi.test",
            },
          ]),
          { status: 200 }
        );
      }
      if (url.includes("/rest/v1/erp_user_profiles") && url.includes("on_conflict")) {
        profileUpserts.push(JSON.parse(options.body));
        return new Response(null, { status: 201 }); // el upsert (tanto el cambio como la reversion) tiene exito
      }
      if (url.includes("/rest/v1/erp_audit_log")) {
        return new Response(null, { status: 201 });
      }
      throw new Error(`URL inesperada: ${url} (${options?.method || "GET"})`);
    },
    async () => {
      const response = await onRequestPatch({
        request: patchRequest({ id: TARGET_ID, fullName: "Objetivo Nuevo", role: "administradora", email: "duplicado@dalfi.test" }),
        env: BASE_ENV,
      });
      assert.notStrictEqual(response.status, 200);
      // Dos upserts: 1) el cambio a administradora (antes de tocar Auth), 2) la
      // reversion a operador (despues de que Auth rechazo el cambio).
      assert.strictEqual(profileUpserts.length, 2);
      assert.strictEqual(profileUpserts[0].role, "administradora", "primero se aplica el cambio propuesto");
      assert.strictEqual(profileUpserts[1].role, "operador", "luego se revierte exactamente al rol que tenia antes");
      assert.strictEqual(profileUpserts[1].can_manage_users, false, "la reversion tambien restaura los permisos previos, no los nuevos");
    }
  );
});

test("users PATCH: si el perfil no existia antes y Auth rechaza el cambio, el perfil recien creado se borra (no queda huerfano)", async () => {
  const { onRequestPatch } = await import(moduleUrl);
  let deleteCalled = false;
  await withFakeFetch(
    (url, options) => {
      const identity = adminIdentity(url);
      if (identity) return identity;
      if (url === `https://fake.supabase.co/auth/v1/admin/users/${TARGET_ID}` && options.method === undefined) {
        return targetAuthUser();
      }
      if (url === `https://fake.supabase.co/auth/v1/admin/users/${TARGET_ID}` && options.method === "PATCH") {
        return new Response(JSON.stringify({ message: "rechazado" }), { status: 400 });
      }
      if (url.includes("/rest/v1/erp_user_profiles") && url.includes(`user_id=eq.${TARGET_ID}`) && options.method === "DELETE") {
        deleteCalled = true;
        return new Response(null, { status: 200 });
      }
      if (url.includes("/rest/v1/erp_user_profiles") && url.includes(`user_id=eq.${TARGET_ID}`) && !options?.method) {
        return new Response(JSON.stringify([]), { status: 200 }); // sin perfil previo
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
      await onRequestPatch({ request: patchRequest({ id: TARGET_ID, role: "administradora" }), env: BASE_ENV });
      assert.strictEqual(deleteCalled, true, "el perfil recien creado (sin version previa) se borra al revertir");
    }
  );
});

test("users PATCH: exito normal cuando perfil y Auth se actualizan sin errores (sin compensacion)", async () => {
  const { onRequestPatch } = await import(moduleUrl);
  await withFakeFetch(
    (url, options) => {
      const identity = adminIdentity(url);
      if (identity) return identity;
      if (url === `https://fake.supabase.co/auth/v1/admin/users/${TARGET_ID}` && options.method === undefined) {
        return targetAuthUser();
      }
      if (url === `https://fake.supabase.co/auth/v1/admin/users/${TARGET_ID}` && options.method === "PATCH") {
        return new Response(JSON.stringify({ id: TARGET_ID, email: "objetivo@dalfi.test" }), { status: 200 });
      }
      if (url.includes("/rest/v1/erp_user_profiles") && url.includes(`user_id=eq.${TARGET_ID}`) && !options?.method) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/rest/v1/erp_user_profiles") && url.includes("on_conflict")) {
        return new Response(null, { status: 201 });
      }
      throw new Error(`URL inesperada: ${url} (${options?.method || "GET"})`);
    },
    async () => {
      const response = await onRequestPatch({ request: patchRequest({ id: TARGET_ID, role: "operador" }), env: BASE_ENV });
      assert.strictEqual(response.status, 200);
    }
  );
});
