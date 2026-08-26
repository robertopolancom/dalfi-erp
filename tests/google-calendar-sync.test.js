import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGoogleCalendarEvent,
  diffCalendarAppointments,
  getGoogleAccessToken,
  googleCalendarConfig,
  googleEventIdForReservation,
  resolveStaffCalendarColorId,
  syncAppointmentToGoogleCalendar,
  syncChangedAppointmentsToGoogleCalendar,
} from "../functions/api/_lib/google-calendar.js";

const fakeEnv = (overrides = {}) => ({
  GOOGLE_CALENDAR_ENABLED: "true",
  GOOGLE_CALENDAR_ID: "calendar-test@example.com",
  GOOGLE_CALENDAR_TIME_ZONE: "America/Santo_Domingo",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "fake-calendar@example-project.iam.gserviceaccount.com",
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "FAKE_TEST_KEY",
  ...overrides,
});

const fakeAppointment = (overrides = {}) => ({
  reservaID: "RES-TEST-001",
  fecha: "2026-08-14",
  hora: "15:00",
  duracionMin: 75,
  clienteNombre: "Cliente Ficticia",
  colaboradorNombre: "Manicurista Ficticia",
  servicio: "Manicura de prueba",
  estado: "Programada",
  telefono: "000-000-0000",
  correo: "ficticia@example.test",
  ...overrides,
});

const fakeAppsScriptEnv = (overrides = {}) => fakeEnv({
  GOOGLE_CALENDAR_PROVIDER: "apps_script",
  GOOGLE_APPS_SCRIPT_WEBHOOK_URL: "https://script.google.com/macros/s/FAKE_DEPLOYMENT_ID/exec",
  GOOGLE_APPS_SCRIPT_WEBHOOK_SECRET: "fake-webhook-secret",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "",
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "",
  ...overrides,
});

const runtimeWithToken = (fetchImpl) => ({
  fetchImpl,
  getAccessToken: async () => "fake-access-token",
});

test("buildGoogleCalendarEvent incluye cliente, manicurista y horario de inicio a fin", () => {
  const built = buildGoogleCalendarEvent(fakeAppointment());
  assert.ok(built);
  assert.equal(built.event.summary, "Cita: Cliente Ficticia — Manicurista Ficticia");
  assert.equal(built.event.start.dateTime, "2026-08-14T15:00:00");
  assert.equal(built.event.end.dateTime, "2026-08-14T16:15:00");
  assert.match(built.event.description, /Horario: 15:00–16:15/);
  assert.match(built.event.description, /Servicio: Manicura de prueba/);
  assert.equal(built.event.visibility, "private");
});


test("cada manicurista activa recibe un color estable y la cita lo lleva a Google", () => {
  const staff = [
    { colaboradorID: "COL-2", nombreCompleto: "Zoila", estado: "Activo" },
    { colaboradorID: "COL-1", nombreCompleto: "Ana", estado: "Activo" },
  ];
  assert.equal(resolveStaffCalendarColorId({ colaboradorID: "COL-1" }, staff), "1");
  assert.equal(resolveStaffCalendarColorId({ colaboradorID: "COL-2" }, staff), "2");
  const built = buildGoogleCalendarEvent(
    fakeAppointment({ colaboradorID: "COL-2", colaboradorNombre: "Zoila" }),
    { staff },
  );
  assert.equal(built.event.colorId, "2");
});

test("la duración se obtiene del catálogo cuando la cita no tiene horaFin ni duracionMin", () => {
  const appointment = fakeAppointment({ duracionMin: undefined, servicioID: "SRV-90" });
  const built = buildGoogleCalendarEvent(appointment, {
    services: [{ servicioID: "SRV-90", nombre: "Servicio de prueba", duracionMin: 90 }],
  });
  assert.equal(built.event.end.dateTime, "2026-08-14T16:30:00");
});

test("el ID de evento es estable, válido y no expone el ID original", async () => {
  const first = await googleEventIdForReservation("RES-TEST-001");
  const second = await googleEventIdForReservation("RES-TEST-001");
  assert.equal(first, second);
  assert.match(first, /^dalfi[0-9a-f]{48}$/);
  assert.doesNotMatch(first, /RES-TEST/);
});

test("crear una cita inserta exactamente un evento y no envía teléfono ni correo", async () => {
  const calls = [];
  const result = await syncAppointmentToGoogleCalendar(
    fakeEnv(),
    fakeAppointment(),
    {},
    runtimeWithToken(async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ id: "event-test" }), { status: 200 });
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.action, "created");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  const body = calls[0].options.body;
  assert.match(body, /Cliente Ficticia/);
  assert.match(body, /Manicurista Ficticia/);
  assert.doesNotMatch(body, /000-000-0000/);
  assert.doesNotMatch(body, /ficticia@example\.test/);
  assert.match(calls[0].url, /sendUpdates=none/);
});

test("Apps Script recibe una sola solicitud autenticada con los datos mínimos", async () => {
  const calls = [];
  const result = await syncAppointmentToGoogleCalendar(
    fakeAppsScriptEnv(),
    fakeAppointment(),
    {},
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify({ ok: true, action: "created" }), { status: 200 });
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.action, "created");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://script.google.com/macros/s/FAKE_DEPLOYMENT_ID/exec");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.secret, "fake-webhook-secret");
  assert.equal(body.action, "upsert");
  assert.equal(body.appointmentId, "RES-TEST-001");
  assert.match(body.event.description, /Manicurista Ficticia/);
  assert.doesNotMatch(calls[0].options.body, /000-000-0000|ficticia@example\.test/);
});

test("Apps Script elimina una cita sin enviar el detalle del evento", async () => {
  let body;
  const result = await syncAppointmentToGoogleCalendar(
    fakeAppsScriptEnv(),
    fakeAppointment({ estado: "Cancelada" }),
    {},
    {
      fetchImpl: async (url, options) => {
        body = JSON.parse(options.body);
        return new Response(JSON.stringify({ ok: true, action: "deleted" }), { status: 200 });
      },
    },
  );
  assert.equal(result.action, "deleted");
  assert.equal(body.action, "delete");
  assert.equal(body.event, null);
});

test("una cita ya existente se actualiza sin crear un duplicado", async () => {
  const calls = [];
  const result = await syncAppointmentToGoogleCalendar(
    fakeEnv(),
    fakeAppointment({ hora: "16:00" }),
    {},
    runtimeWithToken(async (url, options) => {
      calls.push({ url, options });
      return options.method === "POST"
        ? new Response("", { status: 409 })
        : new Response(JSON.stringify({ id: "event-test" }), { status: 200 });
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.action, "updated");
  assert.deepEqual(calls.map((call) => call.options.method), ["POST", "PATCH"]);
});

test("cancelar elimina el evento y un 404 se considera idempotente", async () => {
  const calls = [];
  const result = await syncAppointmentToGoogleCalendar(
    fakeEnv(),
    fakeAppointment({ estado: "Cancelada" }),
    {},
    runtimeWithToken(async (url, options) => {
      calls.push({ url, options });
      return new Response("", { status: 404 });
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.action, "deleted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "DELETE");
});

test("con la integración desactivada no se llama a Google", async () => {
  let calls = 0;
  const result = await syncAppointmentToGoogleCalendar(
    fakeEnv({ GOOGLE_CALENDAR_ENABLED: "false" }),
    fakeAppointment(),
    {},
    runtimeWithToken(async () => {
      calls += 1;
      return new Response("", { status: 500 });
    }),
  );
  assert.equal(result.skipped, true);
  assert.equal(result.code, "DISABLED");
  assert.equal(calls, 0);
});

test("los errores externos se reducen a códigos seguros", async () => {
  const result = await syncAppointmentToGoogleCalendar(
    fakeEnv(),
    fakeAppointment(),
    {},
    runtimeWithToken(async () => {
      throw new Error("secret-value-that-must-not-leak");
    }),
  );
  assert.deepEqual(result, {
    ok: false,
    skipped: false,
    code: "SYNC_ERROR",
    appointmentId: "RES-TEST-001",
  });
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
});

test("diffCalendarAppointments detecta alta, cambio y eliminación", () => {
  const unchanged = fakeAppointment({ reservaID: "RES-A" });
  const removed = fakeAppointment({ reservaID: "RES-B" });
  const edited = fakeAppointment({ reservaID: "RES-A", hora: "17:00" });
  const added = fakeAppointment({ reservaID: "RES-C" });
  const changes = diffCalendarAppointments([unchanged, removed], [edited, added]);
  assert.deepEqual(changes.map((item) => item.reservaID), ["RES-A", "RES-C", "RES-B"]);
  assert.equal(changes[2].estado, "Cancelada");
});

test("el guardado masivo respeta el límite y reporta reparación pendiente", async () => {
  const after = {
    reservas: [
      fakeAppointment({ reservaID: "RES-1" }),
      fakeAppointment({ reservaID: "RES-2" }),
    ],
    servicios: [],
    colaboradores: [],
  };
  let calls = 0;
  const result = await syncChangedAppointmentsToGoogleCalendar(
    fakeEnv({ GOOGLE_CALENDAR_MAX_SYNC_PER_SAVE: "1" }),
    { reservas: [] },
    after,
    runtimeWithToken(async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: "event-test" }), { status: 200 });
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "BATCH_LIMIT");
  assert.equal(result.total, 2);
  assert.equal(result.attempted, 1);
  assert.equal(calls, 1);
});

test("googleCalendarConfig exige todos los secretos y conserva la zona horaria", () => {
  const incomplete = googleCalendarConfig({ GOOGLE_CALENDAR_ENABLED: "true" });
  assert.equal(incomplete.configured, false);
  const complete = googleCalendarConfig(fakeEnv());
  assert.equal(complete.configured, true);
  assert.equal(complete.timeZone, "America/Santo_Domingo");
  const appsScript = googleCalendarConfig(fakeAppsScriptEnv());
  assert.equal(appsScript.provider, "apps_script");
  assert.equal(appsScript.configured, true);
});

test("la autenticación firma un JWT y solicita un token sin imprimir la clave", async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const binary = Array.from(pkcs8, (byte) => String.fromCharCode(byte)).join("");
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
  let requestBody = "";
  const token = await getGoogleAccessToken(
    fakeEnv({
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "unique-token-test@example-project.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: pem,
    }),
    {
      nowMs: Date.UTC(2026, 7, 8, 12, 0, 0),
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://oauth2.googleapis.com/token");
        requestBody = options.body;
        return new Response(JSON.stringify({ access_token: "token-for-test", expires_in: 3600 }), { status: 200 });
      },
    },
  );
  assert.equal(token, "token-for-test");
  const assertion = new URLSearchParams(requestBody).get("assertion");
  assert.equal(assertion.split(".").length, 3);
  assert.doesNotMatch(requestBody, /BEGIN PRIVATE KEY/);
});
