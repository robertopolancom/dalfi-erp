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
    pendingCalls: [],
    async createPendingRegistration(input) { this.pendingCalls.push(input); return { id: "pending-1", outbox: { id: "outbox-2" } }; },
    async availability() { return { durationMinutes: 60, slots: [] }; },
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

// ---------- Anti-enumeración (auditoría de seguridad 2026-09-18) ----------
// Pedir el código responde exactamente lo mismo para cualquier teléfono. Antes, según el caso,
// salía 200 needsNameConfirmation, 202, 409 accountExists o 400 "faltan tus datos", y con eso
// se sabía quién es cliente del salón.

const ESCENARIOS = {
  "sin cuenta ni ficha": {},
  "ficha del ERP sin cuenta": { existingClient: { id: "client-1", full_name: "Ana Gómez" } },
  "cuenta pendiente sin contraseña": { account: { id: "account-1", status: "pending", full_name: "Ana" } },
  "cuenta activa con contraseña": { account: { id: "account-1", status: "active", full_name: "Ana Pérez", password_hash: "hash" } },
  "cuenta suspendida": { account: { id: "suspended-account", status: "suspended", full_name: "Ana", password_hash: "hash" } },
};

async function pedirCodigo(storeOptions, { ruta = "request-code", env } = {}) {
  const store = bookingStore(storeOptions);
  let envios = 0;
  let respuesta;
  await withServer(store, async (base) => {
    const r = await fetch(`${base}/api/reservapp/auth/${ruta}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
    });
    respuesta = { status: r.status, body: await r.json() };
  }, {
    env,
    fetchImpl: async () => { envios += 1; return new Response(JSON.stringify({ status: "SENT" }), { status: 200 }); },
  });
  return { ...respuesta, envios, store };
}

test("RC01 — pedir el código responde idéntico exista o no el teléfono, y en cada caso real sale un WhatsApp", async () => {
  const resultados = {};
  for (const [nombre, opciones] of Object.entries(ESCENARIOS)) resultados[nombre] = await pedirCodigo(opciones);
  const referencia = JSON.stringify({ status: resultados["sin cuenta ni ficha"].status, body: resultados["sin cuenta ni ficha"].body });
  for (const [nombre, r] of Object.entries(resultados)) {
    assert.equal(JSON.stringify({ status: r.status, body: r.body }), referencia, `"${nombre}" se distingue de un teléfono desconocido`);
  }
  assert.equal(resultados["sin cuenta ni ficha"].status, 202);
  for (const nombre of ["sin cuenta ni ficha", "ficha del ERP sin cuenta", "cuenta pendiente sin contraseña", "cuenta activa con contraseña"]) {
    assert.equal(resultados[nombre].envios, 1, `"${nombre}" tiene que recibir su código`);
  }
});

test("RC02 — request-code, request-setup y request-password-reset son la misma puerta", async () => {
  const opciones = ESCENARIOS["cuenta activa con contraseña"];
  const a = await pedirCodigo(opciones, { ruta: "request-code" });
  const b = await pedirCodigo(opciones, { ruta: "request-setup" });
  const c = await pedirCodigo(opciones, { ruta: "request-password-reset" });
  assert.deepEqual(b.body, a.body);
  assert.deepEqual(c.body, a.body);
});

test("RC03 — cuenta con contraseña: código para restablecer, sin borrador de cita", async () => {
  const r = await pedirCodigo(ESCENARIOS["cuenta activa con contraseña"]);
  assert.equal(r.store.prepareSetupCalls.length, 1);
  assert.equal(r.store.prepareSetupCalls[0].accountId, "account-1");
  assert.equal(r.store.prepareSetupCalls[0].draft, null);
});

test("RC04 — cuenta suspendida por administración: misma respuesta, pero no se manda código (no se reactiva sola)", async () => {
  const r = await pedirCodigo(ESCENARIOS["cuenta suspendida"]);
  assert.equal(r.status, 202);
  assert.equal(r.envios, 0);
  assert.equal(r.store.prepareSetupCalls.length, 0);
});

test("RC05 — ficha del ERP sin cuenta: registro pendiente enlazado a la ficha, sin pedir datos de nuevo", async () => {
  const r = await pedirCodigo(ESCENARIOS["ficha del ERP sin cuenta"]);
  assert.equal(r.store.pendingCalls.length, 1);
  assert.equal(r.store.pendingCalls[0].existingClientId, "client-1");
  assert.equal(r.store.pendingCalls[0].registration, null);
});

test("RC06 — más de 3 códigos al mismo teléfono en 15 minutos: misma respuesta, sin más WhatsApp", async () => {
  const store = bookingStore(ESCENARIOS["cuenta activa con contraseña"]);
  let envios = 0;
  const cuerpos = [];
  await withServer(store, async (base) => {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/api/reservapp/auth/request-code`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
      });
      cuerpos.push({ status: r.status, body: await r.json() });
    }
  }, { fetchImpl: async () => { envios += 1; return new Response(JSON.stringify({ status: "SENT" }), { status: 200 }); } });
  assert.equal(envios, 3, "no puede servir para bombardear de WhatsApp a un número");
  assert.deepEqual(cuerpos[4], cuerpos[0]);
});

test("RC07 — el atajo sin WhatsApp (RESERVAPP_SKIP_PHONE_VERIFICATION) ya no existe", async () => {
  const r = await pedirCodigo(ESCENARIOS["cuenta activa con contraseña"], { env: { RESERVAPP_SKIP_PHONE_VERIFICATION: "true" } });
  assert.equal(r.body.activationTicket, undefined);
  assert.equal(r.body.needsNameConfirmation, undefined);
  assert.equal(r.envios, 1);
});

test("RC08 — las rutas que delataban o saltaban el código ya no existen; check-phone solo queda como respuesta fija", async () => {
  const store = bookingStore(ESCENARIOS["cuenta activa con contraseña"]);
  await withServer(store, async (base) => {
    // check-phone responde lo mismo para cualquier teléfono (compatibilidad con copias viejas de la app).
    for (const opciones of [ESCENARIOS["cuenta activa con contraseña"], {}]) {
      const r = await pedirCodigo(opciones, { ruta: "check-phone" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { exists: false });
      assert.equal(r.envios, 0, "check-phone no manda nada");
    }
    for (const ruta of ["verify-name", "set-password-after-verification"]) {
      const r = await fetch(`${base}/api/reservapp/auth/${ruta}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "8095551234", firstName: "Ana", password: "clave1234" }),
      });
      assert.equal(r.status, 404, `${ruta} sigue respondiendo`);
    }
  });
  assert.equal(store.setOwnPasswordCalls.length, 0);
});

test("RC09 — el estado de la cuenta se dice solo DESPUÉS de acertar el código", async () => {
  const conCuenta = bookingStore(ESCENARIOS["cuenta activa con contraseña"]);
  conCuenta.verifySetupOtp = async () => ({ ok: true });
  await withServer(conCuenta, async (base) => {
    const r = await fetch(`${base}/api/reservapp/setup/verify-code`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234", code: "123456" }),
    });
    const body = await r.json();
    assert.equal(body.resetting, true);
    assert.equal(body.needsProfile, false);
  });
  const nueva = bookingStore({});
  nueva.verifyPendingRegistrationOtp = async () => ({ ok: true, needsProfile: true });
  await withServer(nueva, async (base) => {
    const r = await fetch(`${base}/api/reservapp/setup/verify-code`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234", code: "123456" }),
    });
    const body = await r.json();
    assert.equal(body.needsProfile, true);
    assert.equal(body.resetting, false);
  });
});

test("RC10 — persona nueva: sus datos llegan con la contraseña; sin ellos, 400 needsProfile", async () => {
  const store = bookingStore({});
  const recibidos = [];
  store.activateWithToken = async () => null;
  store.completePendingRegistration = async (input) => {
    recibidos.push(input.registration);
    if (!input.registration) throw Object.assign(new Error("Completa tus datos para crear tu cuenta."), { code: "PENDING_REGISTRATION_NEEDS_PROFILE" });
    return { id: "acc-9", account_id: "acc-9", role: "cliente", client_id: "c-9", full_name: "Ana Pérez", draft: null };
  };
  await withServer(store, async (base) => {
    const sinDatos = await fetch(`${base}/api/reservapp/auth/complete-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "ticket-largo", password: "clave1234" }),
    });
    assert.equal(sinDatos.status, 400);
    assert.equal((await sinDatos.json()).needsProfile, true);
    const conDatos = await fetch(`${base}/api/reservapp/auth/complete-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "ticket-largo", password: "clave1234", profile: { firstName: "Ana", lastName: "Pérez", birthDate: "1995-05-20", sex: "<x>" } }),
    });
    assert.equal(conDatos.status, 200);
  });
  assert.equal(recibidos[0], null);
  assert.equal(recibidos[1].firstName, "Ana");
  assert.equal(recibidos[1].sex, "", "un valor fuera de la lista se guarda vacío");
});

test("RC11 — el WhatsApp habla de restablecer si ya había contraseña, y de crear si no", async () => {
  const textos = {};
  for (const nombre of ["cuenta activa con contraseña", "cuenta pendiente sin contraseña"]) {
    const store = bookingStore(ESCENARIOS[nombre]);
    await withServer(store, async (base) => {
      await fetch(`${base}/api/reservapp/auth/request-code`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8095551234" }),
      });
    }, {
      fetchImpl: async (_url, options) => {
        textos[nombre] = JSON.parse(options.body).whatsappFormattedText;
        return new Response(JSON.stringify({ status: "SENT" }), { status: 200 });
      },
    });
  }
  assert.match(textos["cuenta activa con contraseña"], /restablecer tu contraseña/i);
  assert.match(textos["cuenta pendiente sin contraseña"], /crear tu contraseña/i);
});

test("RC12 — un teléfono nuevo pide el código sin datos: la base no puede exigirlos en ese momento", async () => {
  // Regresión del 2026-09-19: la 0017 tenía un check que exigía datos o ficha al crear el registro
  // pendiente, y todo cliente nuevo recibía 500 al pedir el código. Las pruebas usaban una base
  // simulada sin esa regla; esta fija que la migración que la quita exista.
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../neon/migrations/0033_registro_sin_datos_hasta_el_codigo.sql", import.meta.url), "utf8");
  assert.match(sql, /drop constraint if exists reservapp_pending_registrations_check/);
  const r = await pedirCodigo({});
  assert.equal(r.status, 202);
  assert.equal(r.store.pendingCalls[0].registration, null, "se guarda sin datos: se piden después del código");
});
