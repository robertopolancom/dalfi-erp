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

test("request-setup: teléfono con cuenta activa devuelve accountExists, nunca el nombre (auditoría de seguridad -- ver /auth/verify-name)", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "Ana", lastName: "Pérez", phone: "8095551234", birthDate: "1995-05-20" }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.accountExists, true);
    assert.equal(body.firstName, undefined);
    assert.equal(store.prepareSetupCalls.length, 0, "no debe generar un código nuevo para una cuenta ya activa");
  }, {
    existingClient: { id: "33333333-3333-4333-8333-333333333333", full_name: "Ana Gómez" },
    existingAccount: { status: "active", full_name: "Ana Gómez", password_hash: "hash" },
  });
});

test("check-phone: cuenta con contraseña ya creada devuelve exists:true, nunca el nombre (auditoría de seguridad 2026-08-25)", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/check-phone`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { exists: true });
  }, { existingAccount: { status: "active", full_name: "Ana Gómez", password_hash: "hash" } });
});

test("check-phone: sin ninguna cuenta ni ficha, devuelve exists:false (sigue el registro normal)", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/check-phone`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.deepEqual(await response.json(), { exists: false });
  });
});

// password_hash (no status) es la señal real de "ya tiene contraseña" -- una cuenta de PERSONAL
// invitada que nunca completó su activación (status "pending") es el mismo caso que un cliente
// sin credenciales todavía: debe saltar a crear su contraseña, no desaparecer como si no existiera.
test("check-phone: cuenta de personal pendiente de activar (sin contraseña) devuelve needsPasswordOnly:true, no exists:false", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/check-phone`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { exists: true, needsPasswordOnly: true });
  }, { existingAccount: { status: "pending", full_name: "Dalfina Guzmán", password_hash: null } });
});

test("check-phone: sin cuenta de ReservApp pero con ficha ya existente en el ERP devuelve needsPasswordOnly:true, nunca el nombre", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/check-phone`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { exists: true, needsPasswordOnly: true });
  }, { existingClient: { id: "33333333-3333-4333-8333-333333333333", full_name: "Ana Gómez" } });
});

// ---------- /auth/verify-name (confirmar identidad sin que el servidor revele el nombre) ----------

test("verify-name: cuenta de ReservApp existente -- coincidencia exacta se verifica", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/verify-name`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", firstName: "Ana" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { verified: true });
  }, { existingAccount: { status: "active", full_name: "Ana Gómez", password_hash: "hash" } });
});

test("verify-name: tolera un error de tipografía razonable (acento, una letra de más)", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/verify-name`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", firstName: "Dalfyna" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { verified: true });
  }, { existingAccount: { status: "pending", full_name: "Dalfina Guzmán", password_hash: null } });
});

test("verify-name: ficha del ERP sin cuenta de ReservApp también se puede verificar", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/verify-name`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", firstName: "Ana" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { verified: true });
  }, { existingClient: { id: "33333333-3333-4333-8333-333333333333", full_name: "Ana Gómez" } });
});

test("verify-name: nombre equivocado no verifica -- y la respuesta no distingue de 'el teléfono no existe' (anti-enumeración)", async () => {
  await withServer(async (base) => {
    const wrongName = await fetch(`${base}/api/reservapp/auth/verify-name`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", firstName: "Roberto" }),
    });
    const noAccount = await fetch(`${base}/api/reservapp/auth/verify-name`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095550000", firstName: "Roberto" }),
    });
    assert.deepEqual(await wrongName.json(), { verified: false });
    assert.deepEqual(await noAccount.json(), { verified: false }, "misma forma de respuesta exista o no el teléfono -- no debe servir de oráculo");
  }, { existingAccount: { status: "active", full_name: "Ana Gómez", password_hash: "hash" } });
});

test("verify-name: sin nombre responde 400", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/verify-name`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234", firstName: "" }),
    });
    assert.equal(response.status, 400);
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

test("request-setup: sin ficha existente y sin nombre/apellido/fecha de nacimiento sigue exigiéndolos (cliente realmente nuevo)", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.equal(response.status, 400);
    assert.equal(store.createClientCalls.length, 0);
  });
});

test("check-phone: teléfono inválido, 400 sin llegar a consultar la cuenta", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/check-phone`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "123" }),
    });
    assert.equal(response.status, 400);
  });
});
