const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const auditModuleUrl = pathToFileURL(path.join(__dirname, "..", "functions", "api", "_lib", "audit.js")).href;

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

test("insertAuditLog: manda exactamente las columnas base + las nuevas (user_email, user_role, success, note) a erp_audit_log", async () => {
  const { insertAuditLog } = await import(auditModuleUrl);
  await withFakeFetch(
    async () => new Response(null, { status: 201 }),
    async (calls) => {
      const result = await insertAuditLog(
        { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fake-service-key" },
        {
          tableName: "usuarios",
          entityId: "user-123",
          action: "reset_password",
          oldData: { email: "a@b.com" },
          newData: null,
          userId: "admin-1",
          userEmail: "admin@dalfi.test",
          userRole: "propietaria",
          success: true,
          note: "reset manual",
        }
      );
      assert.strictEqual(result.ok, true);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].url, "https://fake.supabase.co/rest/v1/erp_audit_log");
      const body = JSON.parse(calls[0].options.body);
      // Estas son EXACTAMENTE las columnas que la migracion
      // 20260719000000_audit_log_columns.sql agrega: si esa migracion no esta
      // aplicada remotamente, Supabase (PostgREST) rechaza este insert entero
      // porque el payload trae columnas que no existen todavia.
      assert.deepStrictEqual(Object.keys(body).sort(), [
        "action",
        "new_data",
        "note",
        "old_data",
        "record_key",
        "success",
        "table_name",
        "user_email",
        "user_id",
        "user_role",
      ]);
      assert.strictEqual(body.user_email, "admin@dalfi.test");
      assert.strictEqual(body.user_role, "propietaria");
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.note, "reset manual");
    }
  );
});

test("insertAuditLog: si Supabase rechaza el insert (por ejemplo, columna inexistente), devuelve {ok:false} y NUNCA lanza una excepcion", async () => {
  const { insertAuditLog } = await import(auditModuleUrl);
  await withFakeFetch(
    async () =>
      new Response(JSON.stringify({ message: 'column "user_email" does not exist' }), { status: 400 }),
    async () => {
      const result = await insertAuditLog(
        { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fake-service-key" },
        { tableName: "usuarios", entityId: "u1", action: "reset_password", success: true }
      );
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /user_email/);
    }
  );
});

test("insertAuditLog: sin SUPABASE_SERVICE_ROLE_KEY configurada, falla de forma controlada sin llamar a fetch", async () => {
  const { insertAuditLog } = await import(auditModuleUrl);
  await withFakeFetch(
    async () => {
      throw new Error("no deberia llamarse a fetch sin credenciales");
    },
    async (calls) => {
      const result = await insertAuditLog({ SUPABASE_URL: "https://fake.supabase.co" }, { action: "reset_password" });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(calls.length, 0);
    }
  );
});

test("resolveRequester: sin header Authorization, devuelve null sin llamar a fetch", async () => {
  const { resolveRequester } = await import(auditModuleUrl);
  await withFakeFetch(
    async () => {
      throw new Error("no deberia llamarse a fetch sin token");
    },
    async () => {
      const request = new Request("https://fake.supabase.co/api/audit-log", { method: "POST" });
      const requester = await resolveRequester(request, { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_PUBLISHABLE_KEY: "pub" });
      assert.strictEqual(requester, null);
    }
  );
});

test("resolveRequester: revalida el JWT contra Supabase Auth y normaliza email/rol", async () => {
  const { resolveRequester } = await import(auditModuleUrl);
  await withFakeFetch(
    async () =>
      new Response(JSON.stringify({ id: "user-1", email: "Duena@Dalfi.Test", user_metadata: { role: "Propietaria" } }), { status: 200 }),
    async () => {
      const request = new Request("https://fake.supabase.co/api/audit-log", {
        method: "POST",
        headers: { Authorization: "Bearer fake-jwt" },
      });
      const requester = await resolveRequester(request, { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_PUBLISHABLE_KEY: "pub" });
      assert.deepStrictEqual(requester, { id: "user-1", email: "duena@dalfi.test", role: "propietaria" });
    }
  );
});
