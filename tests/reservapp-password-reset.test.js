import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

function bookingStore({ account = null, existingClient = null } = {}) {
  const prepareSetupCalls = [];
  const setOwnPasswordCalls = [];
  const ensureClientAccountCalls = [];
  const createSessionCalls = [];
  return {
    prepareSetupCalls, setOwnPasswordCalls, ensureClientAccountCalls, createSessionCalls,
    async accountByPhone() { return account; },
    async resolveClient() { return existingClient; },
    async prepareSetup(input) {
      prepareSetupCalls.push(input);
      return { outbox: { id: "outbox-1" } };
    },
    async markWhatsApp() {},
    async ensureClientAccount(input) {
      ensureClientAccountCalls.push(input);
      return { id: "new-account-1", client_id: input.clientId, role: "cliente", full_name: existingClient?.full_name };
    },
    async setOwnPasswordAndActivate(input) {
      setOwnPasswordCalls.push(input);
      if (input.id === "suspended-account") return null;
      return true;
    },
    async createSession(input) { createSessionCalls.push(input); },
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

// password_hash (no status) es la señal real de "ya tiene contraseña" -- una cuenta con status
// "pending" (invitada, nunca completó su activación, sin importar si es personal o cliente)
// nunca tuvo contraseña que restablecer, así que debe pedir confirmar el nombre para definir una
// nueva (ver /auth/set-password-after-verification), no fingir un reset por WhatsApp.
test("POST /api/reservapp/auth/request-password-reset: cuenta con status pendiente (sin contraseña) pide confirmar nombre, no manda código de reset", async () => {
  const store = bookingStore({ account: { id: "account-1", status: "pending", full_name: "Ana" } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-password-reset`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.needsNameConfirmation, true);
    assert.equal(body.firstName, undefined, "no debe revelar el nombre -- ver /auth/verify-name (auditoría de seguridad 2026-08-25)");
    assert.equal(store.prepareSetupCalls.length, 0);
  });
});

test("POST /api/reservapp/auth/request-password-reset: sin cuenta pero con ficha ya existente en el ERP pide confirmar nombre en vez de fingir un reset", async () => {
  const store = bookingStore({ account: null, existingClient: { id: "client-1", full_name: "Ana Gómez" } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-password-reset`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.needsNameConfirmation, true);
    assert.equal(body.firstName, undefined, "no debe revelar el nombre -- ver /auth/verify-name (auditoría de seguridad 2026-08-25)");
    assert.equal(store.prepareSetupCalls.length, 0, "no debe mandar un código de reset -- nunca hubo una contraseña que restablecer");
  });
});

test("POST /api/reservapp/auth/request-password-reset: cuenta activa dispara prepareSetup y devuelve 202 idéntico al caso sin cuenta", async () => {
  const store = bookingStore({ account: { id: "account-1", status: "active", full_name: "Ana Pérez", password_hash: "hash" } });
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
  const store = bookingStore({ account: { id: "account-1", status: "active", full_name: "Ana Pérez", password_hash: "hash" } });
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

// TEMPORAL A PROPÓSITO (pedido explícito del dueño del negocio, 2026-08-25 -- ver comentario
// junto a /auth/request-password-reset en server/app.mjs): mientras se espera la verificación
// de Meta, RESERVAPP_SKIP_PHONE_VERIFICATION se queda en "true" y ni siquiera intenta mandar un
// código real -- en su lugar pide confirmar el nombre (needsNameConfirmation), igual que la
// cuenta que nunca tuvo contraseña, para que pueda definir una nueva sin hablar con un asesor.
test("POST /api/reservapp/auth/request-password-reset: con RESERVAPP_SKIP_PHONE_VERIFICATION=true pide confirmar nombre, no manda WhatsApp", async () => {
  const store = bookingStore({ account: { id: "account-1", status: "active", full_name: "Ana Pérez", password_hash: "hash" } });
  let bridgeCalled = false;
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/request-password-reset`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.needsNameConfirmation, true);
    assert.equal(body.pendingConfirmation, false);
    assert.equal(body.firstName, undefined);
    assert.equal(store.prepareSetupCalls.length, 0);
    assert.equal(bridgeCalled, false);
  }, {
    env: { RESERVAPP_SKIP_PHONE_VERIFICATION: "true" },
    fetchImpl: async () => { bridgeCalled = true; return new Response(JSON.stringify({ status: "SENT" }), { status: 200 }); },
  });
});

// ---------- /auth/set-password-after-verification ----------

test("set-password-after-verification: nombre coincide en una cuenta ya existente -- define la contraseña, activa la cuenta y crea sesión", async () => {
  const store = bookingStore({ account: { id: "account-1", status: "pending", full_name: "Ana Pérez" } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/set-password-after-verification`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", firstName: "Ana", password: "Nueva1234" }),
    });
    assert.equal(response.status, 200);
    assert.equal(store.setOwnPasswordCalls.length, 1);
    assert.equal(store.setOwnPasswordCalls[0].id, "account-1");
    assert.equal(store.createSessionCalls.length, 1);
    assert.equal(store.createSessionCalls[0].accountId, "account-1");
    assert.equal(store.ensureClientAccountCalls.length, 0, "la cuenta ya existía, no debe crear una nueva");
    assert.ok(response.headers.get("set-cookie")?.includes("reservapp_session="));
  });
});

test("set-password-after-verification: sin cuenta pero con ficha del ERP -- crea la cuenta primero", async () => {
  const store = bookingStore({ account: null, existingClient: { id: "client-1", full_name: "Ana Gómez" } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/set-password-after-verification`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", firstName: "Ana", password: "Nueva1234" }),
    });
    assert.equal(response.status, 200);
    assert.equal(store.ensureClientAccountCalls.length, 1);
    assert.equal(store.ensureClientAccountCalls[0].clientId, "client-1");
    assert.equal(store.setOwnPasswordCalls[0].id, "new-account-1");
  });
});

test("set-password-after-verification: nombre equivocado responde 401 y nunca toca la contraseña", async () => {
  const store = bookingStore({ account: { id: "account-1", status: "active", full_name: "Ana Pérez" } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/set-password-after-verification`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", firstName: "Roberto", password: "Nueva1234" }),
    });
    assert.equal(response.status, 401);
    assert.equal(store.setOwnPasswordCalls.length, 0);
  });
});

test("set-password-after-verification: contraseña débil responde 400 sin verificar nada", async () => {
  const store = bookingStore({ account: { id: "account-1", status: "active", full_name: "Ana Pérez" } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/set-password-after-verification`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", firstName: "Ana", password: "corta" }),
    });
    assert.equal(response.status, 400);
    assert.equal(store.setOwnPasswordCalls.length, 0);
  });
});

// Alguien a quien administración suspendió/bloqueó a propósito no debe poder "recuperar" su
// acceso solo sabiendo su propio nombre -- setOwnPasswordAndActivate() ya lo bloquea a nivel de
// base de datos (where status in pending/active), esta prueba confirma que la ruta responde con
// un error claro en vez de un 200 falso.
test("set-password-after-verification: cuenta suspendida/bloqueada no se reactiva por autoservicio", async () => {
  const store = bookingStore({ account: { id: "suspended-account", status: "suspended", full_name: "Ana Pérez" } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/set-password-after-verification`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "8095551234", firstName: "Ana", password: "Nueva1234" }),
    });
    assert.equal(response.status, 403);
    assert.equal(store.createSessionCalls.length, 0);
  });
});
