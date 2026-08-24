import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { hashToken } from "../server/reservapp-auth.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

const ADMIN_TOKEN = "admin-session-token";

function bookingStore() {
  const resetCalls = [];
  return {
    resetCalls,
    async sessionAccount(tokenHash) {
      if (tokenHash === hashToken(ADMIN_TOKEN)) return { id: "admin-1", role: "administradora" };
      return null;
    },
    async resetAccountPassword({ id, passwordHash }) {
      resetCalls.push({ id, passwordHash });
      if (id === "missing-account") return null;
      return true;
    },
  };
}

async function withServer(run) {
  const store = bookingStore();
  const app = createApp({
    store: documentStore(), bookingStore: store,
    fetchImpl: async () => new Response("{}", { status: 401 }),
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test" },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`, store); }
  finally { server.close(); await once(server, "close"); }
}

function resetRequest(base, { accountId = "account-1", password = "Nueva1234", cookie } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = `reservapp_session=${cookie}`;
  return fetch(`${base}/api/reservapp/admin/accounts/${accountId}/reset-password`, {
    method: "POST", headers, body: JSON.stringify({ password }),
  });
}

test("POST /api/reservapp/admin/accounts/:id/reset-password: sin sesión de administración se rechaza", async () => {
  await withServer(async (base, store) => {
    const response = await resetRequest(base, {});
    assert.equal(response.status, 403);
    assert.equal(store.resetCalls.length, 0);
  });
});

test("POST /api/reservapp/admin/accounts/:id/reset-password: contraseña débil responde 400", async () => {
  await withServer(async (base, store) => {
    const response = await resetRequest(base, { cookie: ADMIN_TOKEN, password: "corta" });
    assert.equal(response.status, 400);
    assert.equal(store.resetCalls.length, 0);
  });
});

test("POST /api/reservapp/admin/accounts/:id/reset-password: administradora fija la contraseña y la cuenta se actualiza", async () => {
  await withServer(async (base, store) => {
    const response = await resetRequest(base, { cookie: ADMIN_TOKEN, accountId: "account-42" });
    assert.equal(response.status, 200);
    assert.equal(store.resetCalls.length, 1);
    assert.equal(store.resetCalls[0].id, "account-42");
    assert.equal(typeof store.resetCalls[0].passwordHash, "string");
  });
});

test("POST /api/reservapp/admin/accounts/:id/reset-password: cuenta inexistente responde 404", async () => {
  await withServer(async (base) => {
    const response = await resetRequest(base, { cookie: ADMIN_TOKEN, accountId: "missing-account" });
    assert.equal(response.status, 404);
  });
});
