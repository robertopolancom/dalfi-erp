import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { hashToken } from "../server/reservapp-auth.mjs";

// GET /api/reservapp/my-appointments -- "Citas activas"/"Historial" de un cliente en ReservApp
// (reemplaza la vista de Agenda de equipo que veía antes por error).

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

const CLIENT_TOKEN = "client-session-token";
const STAFF_TOKEN = "staff-session-token";

function bookingStoreMock() {
  const listCalls = [];
  return {
    listCalls,
    async sessionAccount(tokenHash) {
      if (tokenHash === hashToken(CLIENT_TOKEN)) return { id: "client-account-1", role: "cliente", client_id: "CLI-1" };
      if (tokenHash === hashToken(STAFF_TOKEN)) return { id: "staff-account-1", role: "manicurista", staff_id: "COL-1" };
      return null;
    },
    async listClientAppointments(input) { listCalls.push(input); return [{ id: "apt-1", legacy_id: "RES-1", services: "Manicura" }]; },
  };
}

async function withServer(run) {
  const store = bookingStoreMock();
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

test("GET /my-appointments: sin sesión responde 401", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/my-appointments`);
    assert.equal(response.status, 401);
  });
});

test("GET /my-appointments: una cuenta de personal (no cliente) no puede usar esta ruta", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/my-appointments`, { headers: { Cookie: `reservapp_session=${STAFF_TOKEN}` } });
    assert.equal(response.status, 403);
  });
});

test("GET /my-appointments: cliente obtiene sus propias citas activas por defecto (scope=active), acotado a su client_id de sesión", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/my-appointments`, { headers: { Cookie: `reservapp_session=${CLIENT_TOKEN}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.appointments.length, 1);
    assert.equal(store.listCalls[0].clientId, "CLI-1");
    assert.equal(store.listCalls[0].scope, "active");
  });
});

test("GET /my-appointments?scope=history: pasa scope=history al store", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/my-appointments?scope=history`, { headers: { Cookie: `reservapp_session=${CLIENT_TOKEN}` } });
    assert.equal(response.status, 200);
    assert.equal(store.listCalls[0].scope, "history");
  });
});

test("GET /my-appointments: un scope desconocido cae a 'active' (nunca pasa un valor arbitrario al store)", async () => {
  await withServer(async (base, store) => {
    await fetch(`${base}/api/reservapp/my-appointments?scope=algo-raro`, { headers: { Cookie: `reservapp_session=${CLIENT_TOKEN}` } });
    assert.equal(store.listCalls[0].scope, "active");
  });
});
