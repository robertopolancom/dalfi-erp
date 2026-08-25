import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

function bookingStore({ account = null, existingClient = null } = {}) {
  const prepareSetupCalls = [];
  return {
    prepareSetupCalls,
    async accountByPhone() { return account; },
    async resolveClient() { return existingClient; },
    async prepareSetup(input) {
      prepareSetupCalls.push(input);
      return { outbox: { id: "outbox-1" } };
    },
    async markWhatsApp() {},
  };
}

async function withServer(store, run, { fetchImpl, env: extraEnv } = {}) {
  const app = createApp({
    store: documentStore(), bookingStore: store,
    fetchImpl: fetchImpl || (async () => new Response(JSON.stringify({ status: "SENT" }), { status: 200 })),
    env: {
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test",
      ERP_WEBHOOK_SECRET: "test-secret",
      ...extraEnv,
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
}

test("POST /api/reservapp/auth/request-password-reset: teléfono con formato inválido responde 400", async () => {
  const store = bookingStore();
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-password-reset`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "123" }),
    });
    assert.equal(response.status, 400);
    assert.equal(store.prepareSetupCalls.length, 0);
  });
});

test("POST /api/reservapp/auth/request-password-reset: sin cuenta activa responde igual (anti-enumeración) sin mandar nada", async () => {
  const store = bookingStore({ account: null });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-password-reset`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.pendingConfirmation, true);
    assert.equal(store.prepareSetupCalls.length, 0);
  });
});

test("POST /api/reservapp/auth/request-password-reset: cuenta con status pendiente (nunca activada) tampoco manda código", async () => {
  const store = bookingStore({ account: { id: "account-1", status: "pending", full_name: "Ana" } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-password-reset`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.equal(response.status, 202);
    assert.equal(store.prepareSetupCalls.length, 0);
  });
});

test("POST /api/reservapp/auth/request-password-reset: sin cuenta pero con ficha ya existente en el ERP dice neverHadPassword en vez de fingir un reset", async () => {
  const store = bookingStore({ account: null, existingClient: { id: "client-1", full_name: "Ana Gómez" } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-password-reset`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.neverHadPassword, true);
    assert.equal(body.firstName, "Ana");
    assert.equal(store.prepareSetupCalls.length, 0, "no debe mandar un código de reset -- nunca hubo una contraseña que restablecer");
  });
});

test("POST /api/reservapp/auth/request-password-reset: cuenta activa dispara prepareSetup y devuelve 202 idéntico al caso sin cuenta", async () => {
  const store = bookingStore({ account: { id: "account-1", status: "active", full_name: "Ana Pérez" } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-password-reset`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.pendingConfirmation, true);
    assert.equal(store.prepareSetupCalls.length, 1);
    assert.equal(store.prepareSetupCalls[0].accountId, "account-1");
    // Sin draft de reserva -- esto es solo un reset de contraseña, no debe crear ni tocar citas.
    assert.equal(store.prepareSetupCalls[0].draft, undefined);
  });
});

test("POST /api/reservapp/auth/request-password-reset: el mensaje de WhatsApp habla de restablecer, no de crear por primera vez", async () => {
  const store = bookingStore({ account: { id: "account-1", status: "active", full_name: "Ana Pérez" } });
  let sentBody = null;
  await withServer(store, async (base) => {
    await fetch(`${base}/api/reservapp/auth/request-password-reset`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
    });
  }, {
    fetchImpl: async (_url, options) => {
      sentBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ status: "SENT" }), { status: 200 });
    },
  });
  assert.match(sentBody.whatsappFormattedText, /restablecer tu contraseña/i);
  assert.doesNotMatch(sentBody.whatsappFormattedText, /crear tu contraseña/i);
});

// TEMPORAL: mientras RESERVAPP_SKIP_PHONE_VERIFICATION esté activo (ver comentario junto a
// /auth/request-password-reset en server/app.mjs), restablecer una contraseña sin poder mandar
// un código real por WhatsApp dejaría que cualquiera que supiera el teléfono de otra clienta le
// robara la cuenta -- así que el autoservicio queda apagado y solo administración puede
// restablecer contraseñas (POST /admin/accounts/:id/reset-password).
test("POST /api/reservapp/auth/request-password-reset: con RESERVAPP_SKIP_PHONE_VERIFICATION=true no manda WhatsApp ni prepara OTP", async () => {
  const store = bookingStore({ account: { id: "account-1", status: "active", full_name: "Ana Pérez" } });
  let bridgeCalled = false;
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-password-reset`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.selfServiceDisabled, true);
    assert.equal(body.pendingConfirmation, false);
    // El frontend arma un enlace real de wa.me con este número (ver forgot-password-form en
    // outputs/reservar/app.js) en vez de solo mostrar texto sin acción -- debe venir del backend,
    // nunca hardcodeado en el frontend, para poder cambiarlo sin desplegar el sitio estático.
    assert.equal(body.whatsappNumber, "18093463030");
    assert.equal(store.prepareSetupCalls.length, 0);
    assert.equal(bridgeCalled, false);
  }, {
    env: { RESERVAPP_SKIP_PHONE_VERIFICATION: "true" },
    fetchImpl: async () => { bridgeCalled = true; return new Response(JSON.stringify({ status: "SENT" }), { status: 200 }); },
  });
});
