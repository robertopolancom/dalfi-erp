import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { hashToken } from "../server/reservapp-auth.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

const ADMIN_TOKEN = "admin-session-token";
const ADMIN_WITH_STAFF_TOKEN = "admin-with-staff-session-token";
const MANICURISTA_TOKEN = "manicurista-session-token";

function bookingStore() {
  const updateBusinessSettingsCalls = [];
  const setStaffWeeklyScheduleCalls = [];
  const deleteStaffWeeklyScheduleCalls = [];
  const setStaffScheduleExceptionCalls = [];
  const deleteStaffScheduleExceptionCalls = [];
  let recentChanges = [];
  return {
    updateBusinessSettingsCalls, setStaffWeeklyScheduleCalls, deleteStaffWeeklyScheduleCalls,
    setStaffScheduleExceptionCalls, deleteStaffScheduleExceptionCalls,
    setRecentChanges(rows) { recentChanges = rows; },
    async sessionAccount(tokenHash) {
      if (tokenHash === hashToken(ADMIN_TOKEN)) return { id: "admin-1", role: "administradora" };
      if (tokenHash === hashToken(ADMIN_WITH_STAFF_TOKEN)) return { id: "admin-3", role: "administradora", staff_id: "COL-1" };
      if (tokenHash === hashToken(MANICURISTA_TOKEN)) return { id: "manicurista-1", role: "manicurista", staff_id: "COL-1" };
      return null;
    },
    async businessSettings() { return { timezone: "America/Santo_Domingo", settings: { defaultOpeningTime: "09:00" } }; },
    async updateBusinessSettings(patch) { updateBusinessSettingsCalls.push(patch); return { timezone: "America/Santo_Domingo", settings: patch }; },
    async listStaffWeeklySchedules() { return []; },
    async setStaffWeeklySchedule(input) { setStaffWeeklyScheduleCalls.push(input); return { id: "sched-1", ...input }; },
    async deleteStaffWeeklySchedule(input) { deleteStaffWeeklyScheduleCalls.push(input); },
    async listStaffScheduleExceptions() { return []; },
    async setStaffScheduleException(input) { setStaffScheduleExceptionCalls.push(input); return { id: "exc-1", ...input }; },
    async deleteStaffScheduleException(input) { deleteStaffScheduleExceptionCalls.push(input); },
    async listRecentStaffCreatedExceptions() { return recentChanges; },
  };
}

async function withServer(run) {
  const store = bookingStore();
  const app = createApp({
    store: documentStore(), bookingStore: store,
    fetchImpl: async () => new Response("{}", { status: 401 }),
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test" },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`, store); }
  finally { server.close(); await once(server, "close"); }
}

function authHeaders(cookie) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = `reservapp_session=${cookie}`;
  return headers;
}

test("PATCH /admin/business-settings: sin sesión de administración se rechaza", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/admin/business-settings`, {
      method: "PATCH", headers: authHeaders(), body: JSON.stringify({ defaultOpeningTime: "10:00" }),
    });
    assert.equal(response.status, 403);
    assert.equal(store.updateBusinessSettingsCalls.length, 0);
  });
});

test("PATCH /admin/business-settings: hora inválida responde 400 sin llegar a guardar", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/admin/business-settings`, {
      method: "PATCH", headers: authHeaders(ADMIN_TOKEN), body: JSON.stringify({ defaultOpeningTime: "10am" }),
    });
    assert.equal(response.status, 400);
    assert.equal(store.updateBusinessSettingsCalls.length, 0);
  });
});

test("PATCH /admin/business-settings: weeklyHours con cierre antes que apertura responde 400", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/admin/business-settings`, {
      method: "PATCH", headers: authHeaders(ADMIN_TOKEN), body: JSON.stringify({ weeklyHours: { "1": { open: "18:00", close: "09:00" } } }),
    });
    assert.equal(response.status, 400);
    assert.equal(store.updateBusinessSettingsCalls.length, 0);
  });
});

test("PATCH /admin/business-settings: administradora guarda weekDays/weeklyHours/holidayClosures", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/admin/business-settings`, {
      method: "PATCH", headers: authHeaders(ADMIN_TOKEN),
      body: JSON.stringify({
        weekDays: [1, 2, 3, 4, 5],
        weeklyHours: { "1": { open: "13:00", close: "18:00" }, "5": null },
        holidayClosures: ["2026-12-25", "2026-12-25"],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(store.updateBusinessSettingsCalls.length, 1);
    assert.deepEqual(store.updateBusinessSettingsCalls[0].weekDays, [1, 2, 3, 4, 5]);
    assert.deepEqual(store.updateBusinessSettingsCalls[0].weeklyHours, { "1": { open: "13:00", close: "18:00" }, "5": null });
    assert.deepEqual(store.updateBusinessSettingsCalls[0].holidayClosures, ["2026-12-25"], "fechas duplicadas se deduplican");
  });
});

test("POST /admin/staff-schedules: hora de fin antes que la de inicio responde 400", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/admin/staff-schedules`, {
      method: "POST", headers: authHeaders(ADMIN_TOKEN),
      body: JSON.stringify({ staffId: "COL-1", weekday: 1, startTime: "18:00", endTime: "09:00" }),
    });
    assert.equal(response.status, 400);
    assert.equal(store.setStaffWeeklyScheduleCalls.length, 0);
  });
});

test("POST /admin/staff-schedules: administradora guarda el horario semanal de una colaboradora", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/admin/staff-schedules`, {
      method: "POST", headers: authHeaders(ADMIN_TOKEN),
      body: JSON.stringify({ staffId: "COL-1", weekday: 1, startTime: "14:00", endTime: "18:00" }),
    });
    assert.equal(response.status, 200);
    assert.equal(store.setStaffWeeklyScheduleCalls.length, 1);
    assert.equal(store.setStaffWeeklyScheduleCalls[0].active, true);
  });
});

test("DELETE /admin/staff-schedules/:staffId/:weekday: sin sesión de administración se rechaza", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/admin/staff-schedules/COL-1/1`, { method: "DELETE" });
    assert.equal(response.status, 403);
    assert.equal(store.deleteStaffWeeklyScheduleCalls.length, 0);
  });
});

test("POST /admin/staff-schedule-exceptions: día libre (available:false) no exige horas", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/admin/staff-schedule-exceptions`, {
      method: "POST", headers: authHeaders(ADMIN_TOKEN),
      body: JSON.stringify({ staffId: "COL-1", date: "2026-09-01", available: false, reason: "Vacaciones" }),
    });
    assert.equal(response.status, 200);
    assert.equal(store.setStaffScheduleExceptionCalls[0].available, false);
    assert.equal(store.setStaffScheduleExceptionCalls[0].startTime, null);
  });
});

test("POST /admin/staff-schedule-exceptions: medio día con hora de fin antes que la de inicio responde 400", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/admin/staff-schedule-exceptions`, {
      method: "POST", headers: authHeaders(ADMIN_TOKEN),
      body: JSON.stringify({ staffId: "COL-1", date: "2026-09-01", available: true, startTime: "12:00", endTime: "09:00" }),
    });
    assert.equal(response.status, 400);
    assert.equal(store.setStaffScheduleExceptionCalls.length, 0);
  });
});

test("DELETE /admin/staff-schedule-exceptions/:staffId/:date: fecha inválida responde 400", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/admin/staff-schedule-exceptions/COL-1/not-a-date`, {
      method: "DELETE", headers: authHeaders(ADMIN_TOKEN),
    });
    assert.equal(response.status, 400);
    assert.equal(store.deleteStaffScheduleExceptionCalls.length, 0);
  });
});

// ---------- "Mi disponibilidad" (autoservicio de cada colaboradora) ----------

test("GET /admin/staff-schedule-changes: sin sesión de administración se rechaza", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/staff-schedule-changes`);
    assert.equal(response.status, 403);
  });
});

test("GET /admin/staff-schedule-changes: administradora ve los cambios que hizo el personal por su cuenta", async () => {
  await withServer(async (base, store) => {
    store.setRecentChanges([{ id: "exc-1", staff_id: "COL-1", staff_name: "Ana Pérez", exception_date: "2026-09-01", start_time: null, end_time: null, available: false, reason: "Cita médica", updated_at: "2026-08-25T10:00:00.000Z" }]);
    const response = await fetch(`${base}/api/reservapp/admin/staff-schedule-changes`, { headers: authHeaders(ADMIN_TOKEN) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.changes.length, 1);
    assert.equal(body.changes[0].staff_name, "Ana Pérez");
  });
});

test("POST /my-schedule-exceptions: sin sesión de personal se rechaza", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/my-schedule-exceptions`, {
      method: "POST", headers: authHeaders(), body: JSON.stringify({ date: "2026-09-01", available: false }),
    });
    assert.equal(response.status, 403);
    assert.equal(store.setStaffScheduleExceptionCalls.length, 0);
  });
});

test("POST /my-schedule-exceptions: cuenta sin colaboradora vinculada se rechaza", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/my-schedule-exceptions`, {
      method: "POST", headers: authHeaders(ADMIN_TOKEN), body: JSON.stringify({ date: "2026-09-01", available: false }),
    });
    assert.equal(response.status, 403);
    assert.equal(store.setStaffScheduleExceptionCalls.length, 0);
  });
});

// Cambio de permisos a pedido explícito del dueño del negocio: manicurista/asistente ya NO
// pueden bloquear su propio horario -- solo administración (ver requireAdministradoraSession).
test("POST /my-schedule-exceptions: una manicurista ya no puede usar 'Mi disponibilidad' (403 por rol)", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/my-schedule-exceptions`, {
      method: "POST", headers: authHeaders(MANICURISTA_TOKEN),
      body: JSON.stringify({ date: "2026-09-01", available: false, reason: "Cita médica" }),
    });
    assert.equal(response.status, 403);
    assert.equal(store.setStaffScheduleExceptionCalls.length, 0);
  });
});

test("POST /my-schedule-exceptions: una administradora con colaboradora propia marca su staffId (nunca uno ajeno) con createdBy:'staff'", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/my-schedule-exceptions`, {
      method: "POST", headers: authHeaders(ADMIN_WITH_STAFF_TOKEN),
      body: JSON.stringify({ date: "2026-09-01", available: false, reason: "Cita médica", staffId: "COL-OTHER" }),
    });
    assert.equal(response.status, 200);
    assert.equal(store.setStaffScheduleExceptionCalls.length, 1);
    assert.equal(store.setStaffScheduleExceptionCalls[0].staffId, "COL-1", "debe usar el staff_id de su propia sesión, ignorando cualquier staffId del body");
    assert.equal(store.setStaffScheduleExceptionCalls[0].createdBy, "staff");
  });
});

test("POST /my-schedule-exceptions: medio día con hora de fin antes que la de inicio responde 400", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/my-schedule-exceptions`, {
      method: "POST", headers: authHeaders(ADMIN_WITH_STAFF_TOKEN),
      body: JSON.stringify({ date: "2026-09-01", available: true, startTime: "12:00", endTime: "09:00" }),
    });
    assert.equal(response.status, 400);
    assert.equal(store.setStaffScheduleExceptionCalls.length, 0);
  });
});

test("DELETE /my-schedule-exceptions/:date: manicurista se rechaza (403 por rol)", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/my-schedule-exceptions/2026-09-01`, {
      method: "DELETE", headers: authHeaders(MANICURISTA_TOKEN),
    });
    assert.equal(response.status, 403);
    assert.equal(store.deleteStaffScheduleExceptionCalls.length, 0);
  });
});

test("DELETE /my-schedule-exceptions/:date: administradora solo puede borrar de su propio staffId", async () => {
  await withServer(async (base, store) => {
    const response = await fetch(`${base}/api/reservapp/my-schedule-exceptions/2026-09-01`, {
      method: "DELETE", headers: authHeaders(ADMIN_WITH_STAFF_TOKEN),
    });
    assert.equal(response.status, 204);
    assert.equal(store.deleteStaffScheduleExceptionCalls.length, 1);
    assert.equal(store.deleteStaffScheduleExceptionCalls[0].staffId, "COL-1");
  });
});

test("GET /my-schedule-exceptions: una administradora sin colaboradora propia también se rechaza (sin staff_id)", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/reservapp/my-schedule-exceptions`, { headers: authHeaders(ADMIN_TOKEN) });
    // La cuenta administradora del mock no trae staff_id -- confirma que sin vínculo a
    // colaboradora se rechaza igual, no solo por rol.
    assert.equal(response.status, 403);
  });
});
