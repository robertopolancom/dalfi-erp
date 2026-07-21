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

test("insertAuditLog: redacta claves/tokens/contrasenas dentro de old_data y new_data antes de guardarlos", async () => {
  const { insertAuditLog } = await import(auditModuleUrl);
  await withFakeFetch(
    async () => new Response(null, { status: 201 }),
    async (calls) => {
      await insertAuditLog(
        { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fake-service-key" },
        {
          tableName: "usuarios",
          entityId: "user-123",
          action: "reset_password",
          oldData: { email: "a@b.com", password: "super-secreta" },
          newData: { temporaryPassword: "otra-secreta", accessToken: "abc.def.ghi", contrasena: "clave-1234", nested: { apiKey: "sk-123" } },
          userId: "admin-1",
          userEmail: "admin@dalfi.test",
          userRole: "propietaria",
          success: true,
        }
      );
      const body = JSON.parse(calls[0].options.body);
      assert.strictEqual(body.old_data.password, "[REDACTADO]");
      assert.strictEqual(body.old_data.email, "a@b.com", "los campos no sensibles se conservan");
      assert.strictEqual(body.new_data.temporaryPassword, "[REDACTADO]");
      assert.strictEqual(body.new_data.accessToken, "[REDACTADO]");
      assert.strictEqual(body.new_data.contrasena, "[REDACTADO]");
      assert.strictEqual(body.new_data.nested.apiKey, "[REDACTADO]", "la redaccion es recursiva, no solo del primer nivel");
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

test("resolveRequester: revalida el JWT contra Supabase Auth y toma el rol de erp_user_profiles (NUNCA de user_metadata)", async () => {
  const { resolveRequester } = await import(auditModuleUrl);
  await withFakeFetch(
    async (url) => {
      if (url.includes("/auth/v1/user")) {
        // user_metadata.role dice "operador" a proposito: si resolveRequester
        // todavia confiara en user_metadata, este test lo detectaria.
        return new Response(JSON.stringify({ id: "user-1", email: "Duena@Dalfi.Test", user_metadata: { role: "operador" } }), { status: 200 });
      }
      if (url.includes("/rest/v1/erp_user_profiles")) {
        return new Response(JSON.stringify([{ role: "propietaria", is_active: true }]), { status: 200 });
      }
      throw new Error(`URL inesperada: ${url}`);
    },
    async () => {
      const request = new Request("https://fake.supabase.co/api/audit-log", {
        method: "POST",
        headers: { Authorization: "Bearer fake-jwt" },
      });
      const requester = await resolveRequester(request, {
        SUPABASE_URL: "https://fake.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "pub",
        SUPABASE_SERVICE_ROLE_KEY: "fake-service-key",
      });
      assert.deepStrictEqual(requester, { id: "user-1", email: "duena@dalfi.test", role: "propietaria" });
    }
  );
});

test("resolveRequester: si el usuario no tiene perfil seguro todavia, el rol queda vacio (no cae a user_metadata)", async () => {
  const { resolveRequester } = await import(auditModuleUrl);
  await withFakeFetch(
    async (url) => {
      if (url.includes("/auth/v1/user")) {
        return new Response(JSON.stringify({ id: "user-2", email: "nueva@dalfi.test", user_metadata: { role: "administradora" } }), { status: 200 });
      }
      if (url.includes("/rest/v1/erp_user_profiles")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`URL inesperada: ${url}`);
    },
    async () => {
      const request = new Request("https://fake.supabase.co/api/audit-log", {
        method: "POST",
        headers: { Authorization: "Bearer fake-jwt" },
      });
      const requester = await resolveRequester(request, {
        SUPABASE_URL: "https://fake.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "pub",
        SUPABASE_SERVICE_ROLE_KEY: "fake-service-key",
      });
      assert.deepStrictEqual(requester, { id: "user-2", email: "nueva@dalfi.test", role: "" });
    }
  );
});
