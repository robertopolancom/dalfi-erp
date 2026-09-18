import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

function bookingStore({ existingClient = null, existingAccount = null } = {}) {
  const prepareSetupCalls = [];
  const createPendingRegistrationCalls = [];
  const availabilityCalls = [];
  const createClientCalls = [];
  return {
    prepareSetupCalls,
    createPendingRegistrationCalls,
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
    // request-setup ya no crea ni la ficha en la ERP ni la cuenta de ReservApp de inmediato --
    // eso queda diferido a completePendingRegistration (ver server/store.mjs), que se prueba en
    // tests/reservapp-pending-registration.test.js. Aquí solo importa QUÉ se guardó pendiente.
    async createPendingRegistration(input) { createPendingRegistrationCalls.push(input); return { id: "pending-1" }; },
    async verifyPendingRegistrationOtp() { return { notFound: true }; },
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
    assert.equal(store.createPendingRegistrationCalls[0].draft, null);
    assert.equal(store.createClientCalls.length, 0, "todavía no debe crear nada en la ERP");
  });
});

// Hasta el 2026-09-18 faltar la fecha de nacimiento daba 400 solo si el teléfono NO era cliente
// -- con eso se sabía quién lo era. Ahora los datos incompletos no se rechazan aquí: se piden
// después del código (verify-code responde needsProfile).
test("request-setup: sin fecha de nacimiento no rechaza -- guarda el registro sin datos y los pide después del código", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "Ana", lastName: "Pérez", phone: "8095551234" }),
    });
    assert.equal(response.status, 202);
    assert.equal(store.createPendingRegistrationCalls[0].registration, null);
    assert.equal(store.createClientCalls.length, 0);
  });
});
test("request-setup: guarda fecha de nacimiento, sexo, dirección y servicio preferido en el registro pendiente (createClient todavía no se llama)", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: "Ana", lastName: "Pérez", phone: "8095551234", birthDate: "1995-05-20",
        sex: "Femenino", address: "Calle 3 #12, Santo Domingo", preferredService: "Pedicura",
      }),
    });
    assert.equal(response.status, 202);
    assert.equal(store.createClientCalls.length, 0, "todavía no debe crear nada en la ERP");
    assert.equal(store.createPendingRegistrationCalls.length, 1);
    const { registration } = store.createPendingRegistrationCalls[0];
    assert.equal(registration.birthDate, "1995-05-20");
    assert.equal(registration.sex, "Femenino");
    assert.equal(registration.address, "Calle 3 #12, Santo Domingo");
    assert.equal(registration.preferredService, "Pedicura");
  });
});

test("request-setup: un sexo fuera de la lista permitida se guarda vacío en vez de basura", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "Ana", lastName: "Pérez", phone: "8095551234", birthDate: "1995-05-20", sex: "<script>" }),
    });
    assert.equal(response.status, 202);
    assert.equal(store.createPendingRegistrationCalls[0].registration.sex, "");
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
    assert.ok(store.createPendingRegistrationCalls[0].draft);
  });
});

test("request-setup: teléfono con cuenta y contraseña responde igual que cualquier otro y manda un código para cambiarla", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "Ana", lastName: "Pérez", phone: "8095551234", birthDate: "1995-05-20" }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accountExists, undefined, "decir que la cuenta existe es justo la fuga que se cerró");
    assert.equal(body.firstName, undefined);
    assert.equal(store.prepareSetupCalls.length, 1);
  }, {
    existingClient: { id: "33333333-3333-4333-8333-333333333333", full_name: "Ana Gómez" },
    existingAccount: { id: "account-ana", status: "active", full_name: "Ana Gómez", password_hash: "hash" },
  });
});
test("request-setup: teléfono con ficha ya existente en el ERP no exige nombre/apellido/fecha de nacimiento", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.equal(response.status, 202);
    assert.equal(store.createClientCalls.length, 0, "no debe crear una ficha duplicada, ya existía");
    assert.equal(store.createPendingRegistrationCalls.length, 1);
    assert.equal(store.createPendingRegistrationCalls[0].existingClientId, "33333333-3333-4333-8333-333333333333");
    assert.equal(store.createPendingRegistrationCalls[0].registration, null, "ya hay ficha -- no hace falta guardar datos nuevos");
  }, { existingClient: { id: "33333333-3333-4333-8333-333333333333", full_name: "Ana Gómez" } });
});

test("request-setup: cuenta de personal existente sin contraseña reutiliza esa cuenta -- nunca crea ni busca una ficha de cliente", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8296679289" }),
    });
    assert.equal(response.status, 202);
    assert.equal(store.createClientCalls.length, 0);
    assert.equal(store.prepareSetupCalls.length, 1);
    assert.equal(store.prepareSetupCalls[0].accountId, "account-dalfina");
  }, { existingAccount: { id: "account-dalfina", status: "pending", full_name: "Dalfina Guzmán", password_hash: null } });
});

test("request-setup: persona nueva sin nombre ni fecha de nacimiento recibe su código igual -- los datos se piden después", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.equal(response.status, 202);
    assert.equal(store.createPendingRegistrationCalls.length, 1);
    assert.equal(store.createPendingRegistrationCalls[0].registration, null);
    assert.equal(store.createPendingRegistrationCalls[0].existingClientId, null);
    assert.equal(store.createClientCalls.length, 0);
  });
});
