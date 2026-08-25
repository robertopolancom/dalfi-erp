import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

function bookingStore() {
  const whatsappCalls = [];
  return {
    whatsappCalls,
    async availability() {
      return { durationMinutes: 60, slots: [{ staffId: "22222222-2222-4222-8222-222222222222", staffName: "Dalfina", time: "10:00" }] };
    },
    async resolveClient() { return null; },
    async createClient() {
      return { client: { id: "33333333-3333-4333-8333-333333333333", full_name: "Ana Pérez" }, previousDocument: {}, document: {} };
    },
    async accountByPhone() { return null; },
    async ensureClientAccount() { return { id: "55555555-5555-4555-8555-555555555555" }; },
    async prepareSetup() { return { outbox: { id: "outbox-1" } }; },
    async markWhatsApp({ outboxId, status, error }) { whatsappCalls.push({ outboxId, status, error }); },
  };
}

async function withServer(fetchImpl, run) {
  const store = bookingStore();
  const app = createApp({
    store: documentStore(), bookingStore: store, fetchImpl,
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

function requestSetupBody() {
  return { firstName: "Ana", lastName: "Pérez", phone: "8095551234", birthDate: "1995-05-20", serviceIds: ["svc-1"], staffId: "22222222-2222-4222-8222-222222222222", date: "2026-08-20", time: "10:00" };
}

test("request-setup marca el outbox como sent solo cuando el bridge confirma SENT", async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /\/webhook\/reservapp-activation$/);
    return new Response(JSON.stringify({ status: "SENT", deliveryStatus: "SENT_TO_WHATSAPP" }), { status: 200 });
  };
  await withServer(fetchImpl, async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestSetupBody()),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).deliveryStatus, "sent");
    assert.deepEqual(store.whatsappCalls, [{ outboxId: "outbox-1", status: "sent", error: undefined }]);
  });
});

test("request-setup NO marca sent si el bridge responde 200 pero IGNORED/UNKNOWN_EVENT (bug histórico)", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ status: "IGNORED", reason: "UNKNOWN_EVENT" }), { status: 200 });
  await withServer(fetchImpl, async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestSetupBody()),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).deliveryStatus, "failed");
    assert.equal(store.whatsappCalls[0].status, "failed");
    assert.match(store.whatsappCalls[0].error, /IGNORED|UNKNOWN_EVENT/);
  });
});

// TEMPORAL: cubre RESERVAPP_SKIP_PHONE_VERIFICATION (ver comentario junto a su uso en
// server/app.mjs) -- mientras Meta no apruebe la plantilla de activación, este flag permite
// omitir el envío/verificación de WhatsApp y devolver el activationTicket directo.
test("request-setup con RESERVAPP_SKIP_PHONE_VERIFICATION=true devuelve activationTicket sin llamar al bridge de WhatsApp", async () => {
  let bridgeCalled = false;
  const fetchImpl = async () => { bridgeCalled = true; return new Response(JSON.stringify({ status: "SENT" }), { status: 200 }); };
  const store = bookingStore();
  store.verifySetupOtp = async () => ({});
  const app = createApp({
    store: documentStore(), bookingStore: store, fetchImpl,
    env: {
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test",
      ERP_WEBHOOK_SECRET: "shared-secret", CHATBOT_BRIDGE_URL: "https://bridge.test",
      RESERVAPP_SKIP_PHONE_VERIFICATION: "true",
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestSetupBody()),
    });
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.bypassedPhoneVerification, true);
    assert.equal(body.pendingConfirmation, false);
    assert.equal(typeof body.activationTicket, "string");
    assert.ok(body.activationTicket.length > 10);
    assert.equal(bridgeCalled, false, "no debe llamar al bridge de WhatsApp cuando el bypass está activo");
  } finally { server.close(); await once(server, "close"); }
});

test("request-setup marca failed si el bridge responde un HTTP de error", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ status: "UNAUTHORIZED" }), { status: 401 });
  await withServer(fetchImpl, async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestSetupBody()),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).deliveryStatus, "failed");
    assert.equal(store.whatsappCalls[0].status, "failed");
  });
});
