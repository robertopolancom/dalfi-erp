import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { hashToken } from "../server/reservapp-auth.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

const MANICURISTA_TOKEN = "manicurista-session-token";
const ASISTENTE_TOKEN = "asistente-session-token";

function bookingStore({ existingClient = null, otpRow = null } = {}) {
  const relayOtps = [];
  const createdClients = [];
  const markedClients = [];
  return {
    relayOtps,
    createdClients,
    markedClients,
    async sessionAccount(tokenHash) {
      if (tokenHash === hashToken(MANICURISTA_TOKEN)) return { id: "manicurista-1", role: "manicurista" };
      if (tokenHash === hashToken(ASISTENTE_TOKEN)) return { id: "asistente-1", role: "asistente" };
      return null;
    },
    async resolveClient() { return existingClient; },
    async createRelayOtp(input) {
      relayOtps.push(input);
      return { otpId: "otp-1", outbox: { id: "outbox-1" } };
    },
    async markWhatsApp() {},
    async verifyRelayOtp({ codeHash }) {
      if (!otpRow) return { notFound: true };
      if (otpRow.locked) return { locked: true };
      if (otpRow.code_hash !== codeHash) return { invalid: true, attemptsRemaining: 2 };
      return { ok: true, row: otpRow };
    },
    async markRelayOtpClient(otpId, clientId) {
      markedClients.push({ otpId, clientId });
    },
    async createClient(input) {
      createdClients.push(input);
      return { client: { id: "new-client-1", full_name: input.fullName }, previousDocument: {}, document: {} };
    },
  };
}

async function withServer(store, run, { fetchImpl, env = {} } = {}) {
  const app = createApp({
    store: documentStore(), bookingStore: store,
    fetchImpl: fetchImpl || (async () => new Response(JSON.stringify({ status: "SENT" }), { status: 200 })),
    env: {
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test",
      ERP_WEBHOOK_SECRET: "shared-secret", CHATBOT_BRIDGE_URL: "https://bridge.test",
      ...env,
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
}

function withCookie(token) {
  return token ? { Cookie: `reservapp_session=${token}` } : {};
}

test("relay-otp/request: manicurista puede solicitar código para cliente nuevo", async () => {
  const store = bookingStore();
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/clients/relay-otp/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withCookie(MANICURISTA_TOKEN) },
      body: JSON.stringify({ phone: "8095551234", firstName: "Ana", lastName: "Pérez" }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.deliveryStatus, "sent");
    assert.equal(body.code, undefined, "el código nunca debe viajar en la respuesta por defecto");
    assert.equal(store.relayOtps[0].requestedByAccountId, "manicurista-1");
  });
});

test("relay-otp/request: expone el código solo si RESERVAPP_EXPOSE_OTP_CODE=true (para tests/staging)", async () => {
  const store = bookingStore();
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/clients/relay-otp/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withCookie(MANICURISTA_TOKEN) },
      body: JSON.stringify({ phone: "8095551234", firstName: "Ana", lastName: "Pérez" }),
    });
    const body = await response.json();
    assert.match(body.code, /^\d{6}$/);
  }, { env: { RESERVAPP_EXPOSE_OTP_CODE: "true" } });
});

test("relay-otp/request: si el cliente ya existe, no crea código ni manda WhatsApp -- pero responde IGUAL que si sí lo hiciera (anti-enumeración)", async () => {
  const store = bookingStore({ existingClient: { id: "existing-1", full_name: "Ana Pérez" } });
  const notFoundStore = bookingStore();
  let existingResponseBody;
  let notFoundResponseBody;
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/clients/relay-otp/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withCookie(MANICURISTA_TOKEN) },
      body: JSON.stringify({ phone: "8095551234", firstName: "Ana", lastName: "Pérez" }),
    });
    assert.equal(response.status, 202);
    existingResponseBody = await response.json();
    assert.equal(store.relayOtps.length, 0, "no debe crear un código para un teléfono ya registrado");
  });
  await withServer(notFoundStore, async (base) => {
    const response = await fetch(`${base}/api/reservapp/clients/relay-otp/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withCookie(MANICURISTA_TOKEN) },
      body: JSON.stringify({ phone: "8095559999", firstName: "Bea", lastName: "Gómez" }),
    });
    assert.equal(response.status, 202);
    notFoundResponseBody = await response.json();
    assert.equal(notFoundStore.relayOtps.length, 1);
  });
  // Misma forma, mismo status, mismo mensaje -- un atacante no puede
  // distinguir "el teléfono ya era cliente" de "se mandó un código nuevo".
  assert.deepEqual(Object.keys(existingResponseBody).sort(), Object.keys(notFoundResponseBody).sort());
  assert.equal(existingResponseBody.message, notFoundResponseBody.message);
  assert.equal(existingResponseBody.deliveryStatus, notFoundResponseBody.deliveryStatus);
  assert.equal(existingResponseBody.pendingConfirmation, notFoundResponseBody.pendingConfirmation);
});

test("relay-otp/request: sin sesión válida de staff se rechaza", async () => {
  const store = bookingStore();
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/clients/relay-otp/request`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", firstName: "Ana", lastName: "Pérez" }),
    });
    assert.equal(response.status, 403);
    assert.equal(store.relayOtps.length, 0);
  });
});

test("relay-otp/confirm: código correcto crea el cliente y la marca verificada", async () => {
  const otpRow = { id: "otp-1", code_hash: hashToken("123456"), first_name: "Ana", last_name: "Pérez", email: "", requested_by_account_id: "manicurista-1" };
  const store = bookingStore({ otpRow });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/clients/relay-otp/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withCookie(MANICURISTA_TOKEN) },
      body: JSON.stringify({ phone: "8095551234", code: "123456" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.verified, true);
    assert.equal(body.client.id, "new-client-1");
    assert.equal(store.createdClients[0].source, "RESERVAPP_MANICURISTA_OTP");
    assert.deepEqual(store.markedClients[0], { otpId: "otp-1", clientId: "new-client-1" });
  });
});

test("relay-otp/confirm: código incorrecto no crea el cliente", async () => {
  const otpRow = { id: "otp-1", code_hash: hashToken("123456"), first_name: "Ana", requested_by_account_id: "manicurista-1" };
  const store = bookingStore({ otpRow });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/clients/relay-otp/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withCookie(MANICURISTA_TOKEN) },
      body: JSON.stringify({ phone: "8095551234", code: "000000" }),
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, "OTP_INVALID");
    assert.equal(body.attemptsRemaining, 2);
    assert.equal(store.createdClients.length, 0);
  });
});

test("relay-otp/confirm: código vencido/no solicitado responde 410 sin crear cliente", async () => {
  const store = bookingStore({ otpRow: null });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/clients/relay-otp/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withCookie(MANICURISTA_TOKEN) },
      body: JSON.stringify({ phone: "8095551234", code: "123456" }),
    });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).code, "OTP_NOT_FOUND");
    assert.equal(store.createdClients.length, 0);
  });
});

test("relay-otp/confirm: intentos agotados responde 429 (OTP_LOCKED)", async () => {
  const store = bookingStore({ otpRow: { locked: true } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/clients/relay-otp/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withCookie(MANICURISTA_TOKEN) },
      body: JSON.stringify({ phone: "8095551234", code: "123456" }),
    });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).code, "OTP_LOCKED");
  });
});

test("POST /api/fast-booking/clients: manicurista SÍ puede crear cliente directamente, sin OTP", async () => {
  const store = bookingStore();
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/fast-booking/clients`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withCookie(MANICURISTA_TOKEN) },
      body: JSON.stringify({ firstName: "Ana", lastName: "Pérez", phone: "8095551234" }),
    });
    assert.equal(response.status, 201);
    assert.equal(store.createdClients.length, 1);
  });
});

test("POST /api/fast-booking/clients: asistente SÍ puede crear cliente directamente, sin OTP", async () => {
  const store = bookingStore();
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/fast-booking/clients`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withCookie(ASISTENTE_TOKEN) },
      body: JSON.stringify({ firstName: "Ana", lastName: "Pérez", phone: "8095551234", actorType: "employee" }),
    });
    assert.equal(response.status, 201);
    assert.equal(store.createdClients[0].source, "PWA_EMPLEADO");
  });
});
