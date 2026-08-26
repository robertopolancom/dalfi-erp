// Fase 5 del plan "ReservApp: rebrand + panel de personal + sesión + banner con IA" --
// gestión de usuarios (personal y clientes) desde el panel de administración.

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
const MANICURISTA_TOKEN = "manicurista-session-token";

function bookingStore() {
  const employeeAccounts = [
    { id: "acc-1", role: "manicurista", status: "active", phone_normalized: "18095551111", staff_id: "staff-1", full_name: "Dalfina Guzman", staff_status: "active" },
    { id: "acc-2", role: "superadministrador", status: "active", phone_normalized: "18095552222", staff_id: "staff-2", full_name: "Roberto Polanco", staff_status: "inactive" },
  ];
  const clients = [
    { id: "client-1", full_name: "Ana Pérez", status: "active", client_phone: "8095553333", account_id: "acc-3", account_status: "active" },
  ];
  const patches = [];
  const clientPatches = [];
  return {
    employeeAccounts, clients, patches, clientPatches,
    async sessionAccount(tokenHash) {
      if (tokenHash === hashToken(ADMIN_TOKEN)) return { id: "admin-1", role: "administradora" };
      if (tokenHash === hashToken(SUPERADMIN_TOKEN)) return { id: "super-1", role: "superadministrador" };
      if (tokenHash === hashToken(MANICURISTA_TOKEN)) return { id: "mani-1", role: "manicurista" };
      return null;
    },
    async listEmployeeAccounts() { return employeeAccounts; },
    async updateEmployeeAccount({ id, role, status }) {
      patches.push({ id, role, status });
      const row = employeeAccounts.find((item) => item.id === id);
      if (!row) return null;
      if (role) row.role = role;
      if (status) row.status = status;
      return { id: row.id, role: row.role, status: row.status, staff_id: row.staff_id };
    },
    async listClientsForAdmin({ query }) {
      if (!query) return clients;
      return clients.filter((item) => item.full_name.toLowerCase().includes(query.toLowerCase()));
    },
    async updateClientStatus({ id, status }) {
      clientPatches.push({ id, status });
      const row = clients.find((item) => item.id === id);
      if (!row) return null;
      row.status = status;
      return { id: row.id, status: row.status };
    },
  };
}

async function withServer(run) {
  const store = bookingStore();
  const app = createApp({
    store: documentStore(), bookingStore: store,
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test" },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`, store); }
  finally { server.close(); await once(server, "close"); }
}

function withCookie(token) {
  return { Cookie: `reservapp_session=${token}` };
}

test("GET /admin/accounts: administradora ve la lista de personal", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/accounts`, { headers: withCookie(ADMIN_TOKEN) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.accounts.length, 2);
  });
});

test("GET /admin/accounts: una manicurista no puede ver la lista de personal", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/accounts`, { headers: withCookie(MANICURISTA_TOKEN) });
    assert.equal(response.status, 403);
  });
});

test("GET /admin/accounts: sin sesión responde 403, no 401 (mismo contrato que el resto del panel admin)", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/accounts`);
    assert.equal(response.status, 403);
  });
});

test("PATCH /admin/accounts/:id: administradora puede suspender a una manicurista", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/admin/accounts/acc-1`, {
      method: "PATCH", headers: { ...withCookie(ADMIN_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "suspended" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).account.status, "suspended");
    assert.deepEqual(store.patches[0], { id: "acc-1", role: null, status: "suspended" });
  });
});

test("PATCH /admin/accounts/:id: una administradora (no superadmin) NO puede tocar una cuenta superadministrador", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/accounts/acc-2`, {
      method: "PATCH", headers: { ...withCookie(ADMIN_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "suspended" }),
    });
    assert.equal(response.status, 403);
  });
});

test("PATCH /admin/accounts/:id: un superadministrador SÍ puede tocar otra cuenta superadministrador", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/accounts/acc-2`, {
      method: "PATCH", headers: { ...withCookie(SUPERADMIN_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ role: "administradora" }),
    });
    assert.equal(response.status, 200);
  });
});

test("PATCH /admin/accounts/:id: una administradora NO puede ascender a nadie a superadministrador", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/accounts/acc-1`, {
      method: "PATCH", headers: { ...withCookie(ADMIN_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ role: "superadministrador" }),
    });
    assert.equal(response.status, 403);
  });
});

test("PATCH /admin/accounts/:id: rechaza un estado inválido antes de tocar la base de datos", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/admin/accounts/acc-1`, {
      method: "PATCH", headers: { ...withCookie(ADMIN_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "banned" }),
    });
    assert.equal(response.status, 400);
    assert.equal(store.patches.length, 0);
  });
});

test("GET /admin/clients: administradora ve y puede filtrar clientes", async () => {
  await withServer(async (base) => {
    const all = await fetch(`${base}/api/reservapp/admin/clients`, { headers: withCookie(ADMIN_TOKEN) });
    assert.equal((await all.json()).clients.length, 1);

    const filtered = await fetch(`${base}/api/reservapp/admin/clients?q=nadie`, { headers: withCookie(ADMIN_TOKEN) });
    assert.equal((await filtered.json()).clients.length, 0);
  });
});

test("PATCH /admin/clients/:id: bloquear un cliente actualiza su estado", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/admin/clients/client-1`, {
      method: "PATCH", headers: { ...withCookie(ADMIN_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "blocked" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).client.status, "blocked");
    assert.deepEqual(store.clientPatches[0], { id: "client-1", status: "blocked" });
  });
});

test("PATCH /admin/clients/:id: una manicurista no puede bloquear clientes", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/clients/client-1`, {
      method: "PATCH", headers: { ...withCookie(MANICURISTA_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "blocked" }),
    });
    assert.equal(response.status, 403);
  });
});
