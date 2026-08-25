import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

function bookingStore({ existingClient = null, existingAccount = null } = {}) {
  const prepareSetupCalls = [];
  const availabilityCalls = [];
  const createClientCalls = [];
  return {
    prepareSetupCalls,
    availabilityCalls,
    createClientCalls,
    async availability(input) {
      availabilityCalls.push(input);
      return { durationMinutes: 60, slots: [{ staffId: "22222222-2222-4222-8222-222222222222", staffName: "Dalfina", time: "10:00" }] };
    },
    async resolveClient() { return existingClient; },
    async createClient(input) {
      createClientCalls.push(input);
      return { client: { id: "33333333-3333-4333-8333-333333333333", full_name: "Ana Pérez" }, previousDocument: {}, document: {} };
    },
    async accountByPhone() { return existingAccount; },
    async ensureClientAccount() { return { id: "55555555-5555-4555-8555-555555555555" }; },
    async prepareSetup(input) { prepareSetupCalls.push(input); return { outbox: { id: "outbox-1" } }; },
    async markWhatsApp() {},
  };
}

async function withServer(run, storeOptions) {
  const store = bookingStore(storeOptions);
  const app = createApp({
    store: documentStore(), bookingStore: store,
    fetchImpl: async () => new Response(JSON.stringify({ status: "SENT" }), { status: 200 }),
    env: {
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test",
      ERP_WEBHOOK_SECRET: "shared-secret", CHATBOT_BRIDGE_URL: "https://bridge.test",
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`, store); }
  finally { server.close(); await once(server, "close"); }
}

test("request-setup: permite crear cuenta sin borrador de reserva (registro puro)", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "Ana", lastName: "Pérez", phone: "8095551234", birthDate: "1995-05-20" }),
    });
    assert.equal(response.status, 202);
    assert.equal(store.availabilityCalls.length, 0, "no debe consultar disponibilidad sin borrador");
    assert.equal(store.prepareSetupCalls[0].draft, null);
  });
});

test("request-setup: sin fecha de nacimiento responde 400 (dato requerido para la ficha en el ERP)", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "Ana", lastName: "Pérez", phone: "8095551234" }),
    });
    assert.equal(response.status, 400);
    assert.equal(store.createClientCalls.length, 0);
  });
});

test("request-setup: pasa fecha de nacimiento, sexo, dirección y servicio preferido a createClient", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: "Ana", lastName: "Pérez", phone: "8095551234", birthDate: "1995-05-20",
        sex: "Femenino", address: "Calle 3 #12, Santo Domingo", preferredService: "Pedicura",
      }),
    });
    assert.equal(response.status, 202);
    assert.equal(store.createClientCalls.length, 1);
    assert.equal(store.createClientCalls[0].birthDate, "1995-05-20");
    assert.equal(store.createClientCalls[0].sex, "Femenino");
    assert.equal(store.createClientCalls[0].address, "Calle 3 #12, Santo Domingo");
    assert.equal(store.createClientCalls[0].preferredService, "Pedicura");
  });
});

test("request-setup: un sexo fuera de la lista permitida se guarda vacío en vez de basura", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "Ana", lastName: "Pérez", phone: "8095551234", birthDate: "1995-05-20", sex: "<script>" }),
    });
    assert.equal(response.status, 202);
    assert.equal(store.createClientCalls[0].sex, "");
  });
});

test("request-setup: un borrador parcial (falta hora) se rechaza en vez de ignorarse silenciosamente", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: "Ana", lastName: "Pérez", phone: "8095551234", birthDate: "1995-05-20",
        serviceIds: ["svc-1"], staffId: "22222222-2222-4222-8222-222222222222", date: "2026-08-20",
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(store.prepareSetupCalls.length, 0);
  });
});

test("request-setup: un borrador completo sigue validando disponibilidad como antes", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: "Ana", lastName: "Pérez", phone: "8095551234", birthDate: "1995-05-20",
        serviceIds: ["svc-1"], staffId: "22222222-2222-4222-8222-222222222222", date: "2026-08-20", time: "10:00",
      }),
    });
    assert.equal(response.status, 202);
    assert.equal(store.availabilityCalls.length, 1);
    assert.ok(store.prepareSetupCalls[0].draft);
  });
});

test("request-setup: teléfono con cuenta activa devuelve accountExists + solo el primer nombre (para que confirme que es ella)", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "Ana", lastName: "Pérez", phone: "8095551234", birthDate: "1995-05-20" }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.accountExists, true);
    assert.equal(body.firstName, "Ana");
    assert.equal(store.prepareSetupCalls.length, 0, "no debe generar un código nuevo para una cuenta ya activa");
  }, {
    existingClient: { id: "33333333-3333-4333-8333-333333333333", full_name: "Ana Gómez" },
    existingAccount: { status: "active", full_name: "Ana Gómez" },
  });
});

test("check-phone: cuenta activa devuelve exists:true y solo el primer nombre", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/check-phone`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { exists: true, firstName: "Ana" });
  }, { existingAccount: { status: "active", full_name: "Ana Gómez" } });
});

test("check-phone: sin cuenta, o cuenta pendiente de activar, devuelve exists:false (sigue el registro normal)", async () => {
  await withServer(async (base) => {
    const withoutAccount = await fetch(`${base}/api/reservapp/auth/check-phone`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.deepEqual(await withoutAccount.json(), { exists: false });
  });
  await withServer(async (base) => {
    const pending = await fetch(`${base}/api/reservapp/auth/check-phone`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.deepEqual(await pending.json(), { exists: false });
  }, { existingAccount: { status: "pending", full_name: "Ana Gómez" } });
});

test("check-phone: teléfono inválido, 400 sin llegar a consultar la cuenta", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/check-phone`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "123" }),
    });
    assert.equal(response.status, 400);
  });
});
