import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { resolveBusinessDayWindow, businessMinutesBetween } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { hashToken } from "../server/reservapp-auth.mjs";

test("resolveBusinessDayWindow(): usa defaultOpeningTime/defaultClosingTime cuando no hay overrides", () => {
  const window = resolveBusinessDayWindow("2026-08-31", {}); // lunes
  assert.deepEqual(window, { open: "09:00", close: "18:00" });
});

test("resolveBusinessDayWindow(): weekDays sin ese día de semana cierra el negocio", () => {
  const window = resolveBusinessDayWindow("2026-09-06", { weekDays: [1, 2, 3, 4, 5, 6] }); // domingo
  assert.equal(window, null);
});

test("resolveBusinessDayWindow(): scheduleExceptions con open/close vacíos cierra esa fecha exacta", () => {
  const window = resolveBusinessDayWindow("2026-12-25", { scheduleExceptions: [{ date: "2026-12-25", open: null, close: null }] });
  assert.equal(window, null);
});

test("businessMinutesBetween(): cuenta solo horas dentro del horario laboral (09:00-18:00), saltando la noche", () => {
  // Viernes 18:00 SD a sábado 09:00 SD -- todo fuera de horario (viernes ya cerró, sábado según weekDays por defecto sí labora)
  const fromMs = Date.parse("2026-09-04T22:00:00.000Z"); // 2026-09-04 18:00 SD
  const toMs = Date.parse("2026-09-05T13:00:00.000Z"); // 2026-09-05 09:00 SD
  const minutes = businessMinutesBetween(fromMs, toMs, {});
  assert.equal(minutes, 0);
});

test("businessMinutesBetween(): 2 horas laborales completas dentro del mismo día cuentan como 120 minutos", () => {
  const fromMs = Date.parse("2026-08-31T14:00:00.000Z"); // 2026-08-31 10:00 SD (lunes)
  const toMs = Date.parse("2026-08-31T16:00:00.000Z"); // 2026-08-31 12:00 SD
  assert.equal(businessMinutesBetween(fromMs, toMs, {}), 120);
});

test("businessMinutesBetween(): toMs <= fromMs devuelve 0", () => {
  const ms = Date.now();
  assert.equal(businessMinutesBetween(ms, ms - 1000, {}), 0);
});

// --- Rutas HTTP: motor de recordatorios y confirmación de asistencia ---

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

const ADMIN_TOKEN = "admin-session-token";
const CLIENT_TOKEN = "client-session-token";

function bookingStoreMock({ appointments = [], settings = {} } = {}) {
  const markCalls = [];
  const confirmCalls = [];
  return {
    markCalls, confirmCalls,
    async sessionAccount(tokenHash) {
      if (tokenHash === hashToken(ADMIN_TOKEN)) return { id: "admin-1", role: "administradora" };
      if (tokenHash === hashToken(CLIENT_TOKEN)) return { id: "client-account-1", role: "clienta", client_id: "CLI-1" };
      return null;
    },
    async businessSettings() { return { timezone: "America/Santo_Domingo", settings }; },
    async listAppointmentsForReminderSweep() { return appointments; },
    async markConfirmationReminderSent(input) { markCalls.push(input); return { updated: true }; },
    async confirmAppointmentAttendance(input) {
      confirmCalls.push(input);
      if (input.legacyId === "RES-CONFLICT") return { alreadyReassigned: true };
      if (input.legacyId === "RES-MISSING") return { missing: true };
      return { confirmed: true };
    },
  };
}

async function withServer({ appointments, settings, fetchImpl, env }, run) {
  const store = bookingStoreMock({ appointments, settings });
  const app = createApp({
    store: documentStore(), bookingStore: store,
    fetchImpl: fetchImpl || (async () => new Response("{}", { status: 401 })),
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test", ...env },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`, store); }
  finally { server.close(); await once(server, "close"); }
}

test("POST /api/booking/send-reminders: sin x-cron-secret correcto responde 401", async () => {
  await withServer({ env: { BOOKING_REMINDER_CRON_SECRET: "shh", ERP_WEBHOOK_SECRET: "bridge-secret" } }, async (base, store) => {
    const response = await fetch(`${base}/api/booking/send-reminders`, { method: "POST" });
    assert.equal(response.status, 401);
    assert.equal(store.markCalls.length, 0);
  });
});

test("POST /api/booking/send-reminders: cita 'Programada' a <=4h laborales recibe el primer recordatorio", async () => {
  const soon = new Date(Date.now() + 2 * 3600000).toISOString();
  const appointments = [{
    id: "apt-1", legacy_id: "RES-1", starts_at: soon, confirmation_status: "Programada",
    first_reminder_sent_at: null, client_name: "Ana", client_phone: "8095551234",
    service_name: "Manicura", apt_date: soon.slice(0, 10), apt_time: "10:00",
  }];
  let bridgeCalled = null;
  await withServer({
    appointments, env: { BOOKING_REMINDER_CRON_SECRET: "shh", ERP_WEBHOOK_SECRET: "bridge-secret" },
    fetchImpl: async (url, init) => { bridgeCalled = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ status: "SENT" }), { status: 200 }); },
  }, async (base, store) => {
    const response = await fetch(`${base}/api/booking/send-reminders`, { method: "POST", headers: { "x-cron-secret": "shh" } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.remindersSent, 1);
    assert.equal(body.escalationsSent, 0);
    assert.equal(store.markCalls[0].stage, "first");
    assert.ok(String(bridgeCalled.url).includes("/webhook/overdue-reminders"));
    assert.equal(bridgeCalled.body.event, "booking.confirmation_reminder");
  });
});

test("POST /api/booking/send-reminders: cita 'Programada' con más de 4h laborales no recibe recordatorio todavía", async () => {
  const later = new Date(Date.now() + 3 * 86400000).toISOString(); // 3 días -- de sobra >4h laborales
  const appointments = [{
    id: "apt-2", legacy_id: "RES-2", starts_at: later, confirmation_status: "Programada",
    first_reminder_sent_at: null, client_name: "Ana", client_phone: "8095551234",
    service_name: "Manicura", apt_date: later.slice(0, 10), apt_time: "10:00",
  }];
  await withServer({ appointments, env: { BOOKING_REMINDER_CRON_SECRET: "shh", ERP_WEBHOOK_SECRET: "bridge-secret" } }, async (base, store) => {
    const response = await fetch(`${base}/api/booking/send-reminders`, { method: "POST", headers: { "x-cron-secret": "shh" } });
    const body = await response.json();
    assert.equal(body.remindersSent, 0);
    assert.equal(store.markCalls.length, 0);
  });
});

test("POST /api/booking/send-reminders: 'PendienteConfirmarHora' con >=1h laboral desde el primer recordatorio escala y libera", async () => {
  const soon = new Date(Date.now() + 2 * 3600000).toISOString();
  const firstReminderAt = new Date(Date.now() - 3 * 86400000).toISOString(); // hace 3 días -- de sobra >=1h laboral sin importar la hora real de ejecución de la prueba
  const appointments = [{
    id: "apt-3", legacy_id: "RES-3", starts_at: soon, confirmation_status: "PendienteConfirmarHora",
    first_reminder_sent_at: firstReminderAt, client_name: "Ana", client_phone: "8095551234",
    service_name: "Manicura", apt_date: soon.slice(0, 10), apt_time: "10:00",
  }];
  await withServer({
    appointments, env: { BOOKING_REMINDER_CRON_SECRET: "shh", ERP_WEBHOOK_SECRET: "bridge-secret" },
    fetchImpl: async () => new Response(JSON.stringify({ status: "SENT" }), { status: 200 }),
  }, async (base, store) => {
    const response = await fetch(`${base}/api/booking/send-reminders`, { method: "POST", headers: { "x-cron-secret": "shh" } });
    const body = await response.json();
    assert.equal(body.escalationsSent, 1);
    assert.equal(store.markCalls[0].stage, "second");
  });
});

test("POST /api/reservapp/booking/confirm-attendance: sin auth (ni bridge ni sesión admin) responde 401", async () => {
  await withServer({ env: { ERP_WEBHOOK_SECRET: "bridge-secret" } }, async (base) => {
    const response = await fetch(`${base}/api/reservapp/booking/confirm-attendance`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reservationId: "RES-1" }),
    });
    assert.equal(response.status, 401);
  });
});

test("POST /api/reservapp/booking/confirm-attendance: con x-webhook-secret del bridge confirma", async () => {
  await withServer({ env: { ERP_WEBHOOK_SECRET: "bridge-secret" } }, async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/booking/confirm-attendance`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-webhook-secret": "bridge-secret" },
      body: JSON.stringify({ reservationId: "RES-1" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(store.confirmCalls[0].legacyId, "RES-1");
  });
});

test("POST /api/reservapp/booking/confirm-attendance: una clienta con sesión propia confirma acotada a su client_id", async () => {
  await withServer({ env: {} }, async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/booking/confirm-attendance`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: `reservapp_session=${CLIENT_TOKEN}` },
      body: JSON.stringify({ reservationId: "RES-1" }),
    });
    assert.equal(response.status, 200);
    assert.equal(store.confirmCalls[0].legacyId, "RES-1");
    assert.equal(store.confirmCalls[0].clientId, "CLI-1");
  });
});

test("POST /api/reservapp/booking/confirm-attendance: horario ya reasignado responde 409 con instrucción de elegir otro horario", async () => {
  await withServer({ env: { ERP_WEBHOOK_SECRET: "bridge-secret" } }, async (base) => {
    const response = await fetch(`${base}/api/reservapp/booking/confirm-attendance`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-webhook-secret": "bridge-secret" },
      body: JSON.stringify({ reservationId: "RES-CONFLICT" }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "ALREADY_REASSIGNED");
  });
});
