import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

function bookingStore({ account = null, otpResult = null, pendingOtpResult = { notFound: true } } = {}) {
  const verifyCalls = [];
  const pendingVerifyCalls = [];
  return {
    verifyCalls,
    pendingVerifyCalls,
    async accountByPhone() { return account; },
    async verifySetupOtp(input) {
      verifyCalls.push(input);
      return otpResult;
    },
    // Sin cuenta (accountByPhone devuelve null), el código puede venir de un autorregistro
    // nuevo -- ese vive en reservapp_pending_registrations, no en reservapp_setup_tokens.
    async verifyPendingRegistrationOtp(input) {
      pendingVerifyCalls.push(input);
      return pendingOtpResult;
    },
  };
}

async function withServer(store, run) {
  const app = createApp({
    store: documentStore(), bookingStore: store,
    fetchImpl: async () => new Response(JSON.stringify({ status: "SENT" }), { status: 200 }),
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test" },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
}

test("POST /api/reservapp/setup/verify-code: teléfono o código con formato inválido responde 400", async () => {
  const store = bookingStore();
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/setup/verify-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "123", code: "12" }),
    });
    assert.equal(response.status, 400);
    assert.equal(store.verifyCalls.length, 0);
  });
});

test("POST /api/reservapp/setup/verify-code: teléfono sin cuenta y sin registro pendiente responde 410 OTP_NOT_FOUND", async () => {
  const store = bookingStore({ account: null });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/setup/verify-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", code: "482913" }),
    });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).code, "OTP_NOT_FOUND");
    assert.equal(store.verifyCalls.length, 0, "sin cuenta, nunca debe consultar reservapp_setup_tokens");
    assert.equal(store.pendingVerifyCalls.length, 1, "en su lugar debe intentar el registro pendiente");
  });
});

test("POST /api/reservapp/setup/verify-code: sin cuenta pero con registro pendiente válido, rota el token igual que el camino de cuenta existente", async () => {
  const store = bookingStore({ account: null, pendingOtpResult: { ok: true } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/setup/verify-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", code: "482913" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.verified, true);
    assert.equal(typeof body.activationTicket, "string");
    assert.equal(store.pendingVerifyCalls.length, 1);
    assert.equal(store.pendingVerifyCalls[0].phone, "8095551234");
  });
});

test("POST /api/reservapp/setup/verify-code: código vencido/no solicitado responde 410 OTP_NOT_FOUND", async () => {
  const store = bookingStore({ account: { id: "account-1" }, otpResult: { notFound: true } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/setup/verify-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", code: "482913" }),
    });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).code, "OTP_NOT_FOUND");
  });
});

test("POST /api/reservapp/setup/verify-code: intentos agotados responde 429 OTP_LOCKED", async () => {
  const store = bookingStore({ account: { id: "account-1" }, otpResult: { locked: true } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/setup/verify-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", code: "482913" }),
    });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).code, "OTP_LOCKED");
  });
});

test("POST /api/reservapp/setup/verify-code: código incorrecto responde 401 OTP_INVALID con intentos restantes", async () => {
  const store = bookingStore({ account: { id: "account-1" }, otpResult: { invalid: true, attemptsRemaining: 3 } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/setup/verify-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", code: "000000" }),
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, "OTP_INVALID");
    assert.equal(body.attemptsRemaining, 3);
  });
});

test("POST /api/reservapp/setup/verify-code: código correcto rota el token y devuelve un activationTicket", async () => {
  const store = bookingStore({ account: { id: "account-1" }, otpResult: { ok: true } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/setup/verify-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", code: "482913" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.verified, true);
    assert.equal(typeof body.activationTicket, "string");
    assert.ok(body.activationTicket.length >= 32, "el activationTicket debe ser un secreto largo, no el código de 6 dígitos");
    assert.equal(store.verifyCalls.length, 1);
    assert.equal(store.verifyCalls[0].accountId, "account-1");
  });
});
