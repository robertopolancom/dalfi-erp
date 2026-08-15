import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { hashToken } from "../server/reservapp-auth.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

const ADMIN_TOKEN = "admin-session-token";
const SUPERADMIN_TOKEN = "superadmin-session-token";

function bookingStore() {
  const created = [];
  return {
    created,
    async sessionAccount(tokenHash) {
      if (tokenHash === hashToken(ADMIN_TOKEN)) return { id: "admin-1", role: "administradora" };
      if (tokenHash === hashToken(SUPERADMIN_TOKEN)) return { id: "super-1", role: "superadministrador" };
      return null;
    },
    async createEmployeeAccount({ staffId, phone, role, createdByAccountId }) {
      created.push({ staffId, phone, role, createdByAccountId });
      return { id: `acc-${created.length}`, role, staff_id: staffId, phone_normalized: phone, status: "pending" };
    },
    async prepareSetup() { return { outbox: { id: "outbox-1" } }; },
  };
}

function erpAdminFetch(url) {
  if (String(url).includes("/auth/v1/user")) return Promise.resolve(new Response(JSON.stringify({ id: "erp-user-1", email: "admin@ejemplo.test" }), { status: 200 }));
  if (String(url).includes("erp_user_profiles")) return Promise.resolve(new Response(JSON.stringify([{ user_id: "erp-user-1", role: "administradora", is_active: true, can_manage_users: true }]), { status: 200 }));
  return Promise.resolve(new Response("{}", { status: 401 }));
}

async function withServer(fetchImpl, run) {
  const store = bookingStore();
  const app = createApp({
    store: documentStore(), bookingStore: store, fetchImpl,
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test" },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`, store); }
  finally { server.close(); await once(server, "close"); }
}

function createAccountRequest(base, { role, cookie, bearer }) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = `reservapp_session=${cookie}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return fetch(`${base}/api/reservapp/admin/accounts`, {
    method: "POST", headers,
    body: JSON.stringify({ role, staffId: "staff-1", phone: "8095551234" }),
  });
}

test("personal del ERP legado (can_manage_users) puede crear manicurista pero NUNCA superadministrador", async () => {
  await withServer(erpAdminFetch, async (base, store) => {
    const staffResponse = await createAccountRequest(base, { role: "manicurista", bearer: "erp-jwt" });
    assert.equal(staffResponse.status, 201);
    assert.equal(store.created[0].role, "manicurista");

    const superResponse = await createAccountRequest(base, { role: "superadministrador", bearer: "erp-jwt" });
    assert.equal(superResponse.status, 403);
    assert.equal(store.created.length, 1, "no debe haberse creado la cuenta superadministrador");
  });
});

test("sesión ReservApp administradora puede crear administradora pero NO superadministrador", async () => {
  await withServer(async () => new Response("{}", { status: 401 }), async (base, store) => {
    const adminResponse = await createAccountRequest(base, { role: "administradora", cookie: ADMIN_TOKEN });
    assert.equal(adminResponse.status, 201);

    const superResponse = await createAccountRequest(base, { role: "superadministrador", cookie: ADMIN_TOKEN });
    assert.equal(superResponse.status, 403);
    assert.equal(store.created.filter((item) => item.role === "superadministrador").length, 0);
  });
});

test("solo una sesión ReservApp superadministrador puede crear otra cuenta superadministrador", async () => {
  await withServer(async () => new Response("{}", { status: 401 }), async (base, store) => {
    const response = await createAccountRequest(base, { role: "superadministrador", cookie: SUPERADMIN_TOKEN });
    assert.equal(response.status, 201);
    assert.equal(store.created[0].role, "superadministrador");
  });
});

test("sin sesión ni identidad ERP válida, cualquier creación de cuenta se rechaza", async () => {
  await withServer(async () => new Response("{}", { status: 401 }), async (base, store) => {
    const response = await createAccountRequest(base, { role: "manicurista" });
    assert.equal(response.status, 403);
    assert.equal(store.created.length, 0);
  });
});
