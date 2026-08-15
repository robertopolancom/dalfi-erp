import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { hashToken } from "../server/reservapp-auth.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

const CLIENTA_A_TOKEN = "clienta-a-session";
const CLIENTA_B_TOKEN = "clienta-b-session";
const MANICURISTA_TOKEN = "manicurista-session";

const ACCOUNT_A = { id: "acct-a", role: "clienta", client_id: "client-a" };
const ACCOUNT_B = { id: "acct-b", role: "clienta", client_id: "client-b" };

// Simula fielmente el filtro real de NeonBookingStore.agenda(): la fila de
// A nunca debe salir para B y viceversa -- mismo comportamiento que el
// `and a.client_id=$2` de la consulta SQL real (server/store.mjs), aquí
// aplicado en JS porque no hay Postgres disponible en este entorno.
const APPOINTMENTS_BY_CLIENT = {
  "client-a": [{ id: "apt-a", staff_id: "staff-1", client_id: "client-a", start_time: "10:00", end_time: "11:00", client_name: "Clienta A", services: "Manicura", status: "scheduled" }],
  "client-b": [{ id: "apt-b", staff_id: "staff-1", client_id: "client-b", start_time: "12:00", end_time: "13:00", client_name: "Clienta B", services: "Pedicura", status: "scheduled" }],
};

function agendaBookingStore() {
  const agendaCalls = [];
  return {
    agendaCalls,
    async sessionAccount(tokenHash) {
      if (tokenHash === hashToken(CLIENTA_A_TOKEN)) return ACCOUNT_A;
      if (tokenHash === hashToken(CLIENTA_B_TOKEN)) return ACCOUNT_B;
      return null;
    },
    async agenda({ date, account }) {
      agendaCalls.push({ date, accountId: account.id });
      const appointments = account.role === "clienta" ? APPOINTMENTS_BY_CLIENT[account.client_id] || [] : Object.values(APPOINTMENTS_BY_CLIENT).flat();
      return { date, visibility: account.role === "clienta" ? "own" : "team", staff: [], appointments };
    },
  };
}

async function withServer(store, run, { fetchImpl, env = {} } = {}) {
  const app = createApp({
    store: documentStore(), bookingStore: store,
    fetchImpl: fetchImpl || (async () => new Response("{}", { status: 401 })),
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test", ...env },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
}

test("IDOR: la agenda de clienta A nunca incluye citas de clienta B, ni al pasar el id de B por query", async () => {
  const store = agendaBookingStore();
  await withServer(store, async (base) => {
    const asA = await fetch(`${base}/api/reservapp/agenda?date=2026-08-20`, { headers: { Cookie: `reservapp_session=${CLIENTA_A_TOKEN}` } });
    assert.equal(asA.status, 200);
    const bodyA = await asA.json();
    assert.deepEqual(bodyA.appointments.map((a) => a.id), ["apt-a"]);
    assert.equal(bodyA.appointments.some((a) => a.client_id === "client-b"), false);

    // Intento de IDOR: clienta A intenta forzar el id de B por query string.
    // El endpoint no lee ningún identificador del request -- solo usa la
    // cuenta resuelta del cookie de sesión -- así que esto no cambia nada.
    const attempt = await fetch(`${base}/api/reservapp/agenda?date=2026-08-20&clientId=client-b&accountId=acct-b`, {
      headers: { Cookie: `reservapp_session=${CLIENTA_A_TOKEN}` },
    });
    const bodyAttempt = await attempt.json();
    assert.deepEqual(bodyAttempt.appointments.map((a) => a.id), ["apt-a"]);

    const asB = await fetch(`${base}/api/reservapp/agenda?date=2026-08-20`, { headers: { Cookie: `reservapp_session=${CLIENTA_B_TOKEN}` } });
    const bodyB = await asB.json();
    assert.deepEqual(bodyB.appointments.map((a) => a.id), ["apt-b"]);

    // El store nunca recibió un accountId distinto al de la sesión real que hizo el request.
    assert.deepEqual(store.agendaCalls.map((c) => c.accountId), ["acct-a", "acct-a", "acct-b"]);
  });
});

test("IDOR: sin cookie de sesión, la agenda responde 401 y nunca llama al store", async () => {
  const store = agendaBookingStore();
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/agenda?date=2026-08-20&clientId=client-a`);
    assert.equal(response.status, 401);
    assert.equal(store.agendaCalls.length, 0);
  });
});

function concurrencyBookingStore() {
  const takenSlots = new Set();
  const byIdempotencyKey = new Map();
  let createCalls = 0;
  return {
    get createCalls() { return createCalls; },
    async resolveClient() { return { id: "client-1", full_name: "Ana Pérez" }; },
    async availability() {
      return { durationMinutes: 60, slots: [{ staffId: "staff-1", staffName: "Dalfina", time: "10:00" }] };
    },
    async sessionAccount(tokenHash) {
      if (tokenHash === hashToken("customer-session")) return { id: "acct-a", role: "clienta", client_id: "client-1" };
      return null;
    },
    // Simula el constraint de exclusión real de Postgres sobre
    // (staff_id, starts_at) -- ver server/store.mjs createAppointment,
    // que captura el error 23P01 y devuelve { conflict: true }. Aquí un
    // Set en memoria hace de la misma barrera para dos llamadas
    // concurrentes al mismo slot.
    async createAppointment(input) {
      createCalls += 1;
      if (byIdempotencyKey.has(input.idempotencyKey)) {
        return { appointment: byIdempotencyKey.get(input.idempotencyKey), idempotent: true };
      }
      const slotKey = `${input.staffId}|${input.date}|${input.time}`;
      if (takenSlots.has(slotKey)) return { conflict: true };
      takenSlots.add(slotKey);
      const appointment = { id: `apt-${createCalls}`, legacy_id: `RES-${createCalls}` };
      byIdempotencyKey.set(input.idempotencyKey, appointment);
      return { appointment, previousDocument: {}, document: {} };
    },
  };
}

function bookingRequest(base, idempotencyKey) {
  return fetch(`${base}/api/fast-booking/appointments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, Cookie: "reservapp_session=customer-session" },
    body: JSON.stringify({ clientId: "client-1", serviceIds: ["svc-1"], staffId: "staff-1", date: "2026-08-20", time: "10:00" }),
  });
}

test("concurrencia: dos POST simultáneos al mismo slot -- solo uno gana, el otro recibe 409", async () => {
  const store = concurrencyBookingStore();
  await withServer(store, async (base) => {
    const [first, second] = await Promise.all([
      bookingRequest(base, "req-A"),
      bookingRequest(base, "req-B"),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    const bodies = await Promise.all([first.json(), second.json()]);
    const conflictBody = first.status === 409 ? bodies[0] : bodies[1];
    assert.equal(conflictBody.conflict, true);
  });
});

test("idempotencia: reenviar el mismo Idempotency-Key no crea una segunda cita", async () => {
  const store = concurrencyBookingStore();
  await withServer(store, async (base) => {
    const first = await bookingRequest(base, "same-key");
    assert.equal(first.status, 201);
    const firstBody = await first.json();

    const second = await bookingRequest(base, "same-key");
    assert.equal(second.status, 200, "un reintento idempotente no debe responder 201 de nuevo");
    const secondBody = await second.json();

    assert.equal(secondBody.idempotent, true);
    assert.equal(secondBody.appointment.id, firstBody.appointment.id);
    assert.equal(secondBody.appointment.reference, firstBody.appointment.reference);
    assert.equal(store.createCalls, 2, "el store se llama las dos veces, pero la segunda debe resolver al mismo registro, no crear otro");
  });
});

function relayOtpRateLimitStore() {
  return {
    async sessionAccount(tokenHash) {
      return tokenHash === hashToken("manicurista-session") ? { id: "manicurista-1", role: "manicurista" } : null;
    },
    async resolveClient() { return null; },
    async createRelayOtp() { return { otpId: "otp-x", outbox: { id: "outbox-x" } }; },
    async markWhatsApp() {},
  };
}

test("rate limit: relay-otp/request corta en el sexto intento de la misma manicurista dentro de la ventana", async () => {
  const store = relayOtpRateLimitStore();
  await withServer(store, async (base) => {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const response = await fetch(`${base}/api/reservapp/clients/relay-otp/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `reservapp_session=${MANICURISTA_TOKEN}` },
        body: JSON.stringify({ firstName: "Ana", lastName: `Clienta${i}`, phone: `809555${1000 + i}` }),
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [202, 202, 202, 202, 202, 429]);
  }, { env: { ERP_WEBHOOK_SECRET: "shared-secret", CHATBOT_BRIDGE_URL: "https://bridge.test" }, fetchImpl: async () => new Response(JSON.stringify({ status: "SENT" }), { status: 200 }) });
});
