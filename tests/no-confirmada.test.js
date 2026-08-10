// Pruebas para estadoConfirmacion "EspacioLiberado": una cita "Preaprobada"
// del chatbot que llega al segundo recordatorio sin confirmarse libera su
// horario (en vez de bloquear la agenda indefinidamente), puede ser
// reclamada de vuelta si nadie más lo toma, o el estado general (estado)
// queda "Reemplazada" automáticamente si otra reserva confirmada ocupa ese
// mismo horario primero. Ver también:
// - functions/api/booking/send-reminders.js (quien marca "EspacioLiberado")
// - functions/api/booking/confirm.js (guarda ALREADY_REASSIGNED + bump)
// - outputs/lib/booking-engine.js calculateAvailableSlots (libera el horario)
//
// Además cubre needsReview: clientas y reservas nuevas creadas por el
// chatbot quedan marcadas para revisión en el Dashboard.

import test from "node:test";
import assert from "node:assert/strict";

import { onRequestGet as availabilityGet } from "../functions/api/booking/availability.js";
import { onRequestPost as confirmPost } from "../functions/api/booking/confirm.js";
import { onRequestPost as sendRemindersPost } from "../functions/api/booking/send-reminders.js";

function createNestedMockEnv(innerData, extraEnv = {}) {
  let doc = { schema: "v1", meta: {}, data: JSON.parse(JSON.stringify(innerData)) };
  let updatedAt = "2026-08-03T12:00:00.000Z";

  return {
    SUPABASE_URL: "https://mock.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "mock_service_key",
    ...extraEnv,
    fetch: async (url, options = {}) => {
      const urlStr = String(url);
      if (urlStr.includes("save_erp_record_if_current")) {
        const body = JSON.parse(options.body || "{}");
        if (body.p_expected_updated_at !== null && body.p_expected_updated_at !== updatedAt) {
          return new Response(JSON.stringify([{ saved: false, new_updated_at: updatedAt }]), { status: 200 });
        }
        doc = body.p_data;
        updatedAt = new Date().toISOString();
        return new Response(JSON.stringify([{ saved: true, new_updated_at: updatedAt }]), { status: 200 });
      }
      return new Response(JSON.stringify([{ data: doc, updated_at: updatedAt }]), { status: 200 });
    },
    getDoc: () => doc,
  };
}

function withFakeGlobalFetch(handler, fn) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls);
  };
  return fn(calls).finally(() => {
    global.fetch = originalFetch;
  });
}

const BASE_DOC = {
  servicios: [{ servicioID: "SRV-1", servicio: "Manicura Rusa", duracionMin: 60 }],
  colaboradores: [{ colaboradorID: "COL-1", nombreCompleto: "Ana Pérez", estado: "Activo" }],
  reservas: [],
};

test("EspacioLiberado: no bloquea la disponibilidad (GET /availability la trata igual que Cancelada)", async () => {
  const doc = {
    ...BASE_DOC,
    reservas: [
      { reservaID: "RES-NC-1", fecha: "2026-08-11", hora: "10:00", horaFin: "11:00", duracionMin: 60, colaboradorID: "COL-1", estado: "Preaprobada", estadoConfirmacion: "EspacioLiberado" },
    ],
  };
  const env = createNestedMockEnv(doc);
  const req = new Request("https://localhost/api/booking/availability?serviceId=SRV-1&date=2026-08-11&collaboratorId=COL-1");
  const res = await availabilityGet({ request: req, env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.ok(data.slots.some((s) => s.time === "10:00"), "10:00 debe seguir disponible pese a la cita con espacio liberado");
});

test("confirm.js: reservar el mismo horario de una cita con EspacioLiberado la deja Reemplazada automáticamente (bump)", async () => {
  const doc = {
    ...BASE_DOC,
    reservas: [
      {
        reservaID: "RES-NC-2", fecha: "2026-08-11", hora: "10:00", horaFin: "11:00", duracionMin: 60,
        colaboradorID: "COL-1", colaboradorNombre: "Ana Pérez", estado: "Preaprobada", estadoConfirmacion: "EspacioLiberado",
        clienteNombre: "Clienta Original", telefono: "8095550000",
      },
    ],
  };
  const env = createNestedMockEnv(doc);
  const req = new Request("https://localhost/api/booking/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "IDEM-BUMP-1",
      client: { name: "Clienta Nueva", phone: "8095551111" },
      serviceLines: [{ serviceId: "SRV-1", quantity: 1 }],
      requestedStartAt: "2026-08-11T10:00:00",
      collaboratorPreference: { mode: "specific", collaboratorId: "COL-1" },
    }),
  });
  const res = await confirmPost({ request: req, env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.success, true);

  const reservas = env.getDoc().data.reservas;
  const bumped = reservas.find((r) => r.reservaID === "RES-NC-2");
  const created = reservas.find((r) => r.reservaID !== "RES-NC-2");
  assert.equal(bumped.estado, "Reemplazada");
  assert.match(bumped.observaciones, /tomado por otra reserva/i);
  assert.ok(created, "la nueva reserva debe haberse creado");
  assert.equal(created.hora, "10:00");
});

test("confirm.js: confirmar una reserva ya Reemplazada (ALREADY_REASSIGNED) se rechaza en vez de resucitarla", async () => {
  const doc = {
    ...BASE_DOC,
    reservas: [
      { reservaID: "RES-REPROG-1", fecha: "2026-08-11", hora: "10:00", colaboradorID: "COL-1", estado: "Reemplazada", estadoConfirmacion: "EspacioLiberado" },
    ],
  };
  const env = createNestedMockEnv(doc);
  const req = new Request("https://localhost/api/booking/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "IDEM-REASSIGNED-1", reservationId: "RES-REPROG-1", status: "Confirmada" }),
  });
  const res = await confirmPost({ request: req, env });
  const data = await res.json();
  assert.equal(res.status, 409);
  assert.equal(data.success, false);
  assert.equal(data.code, "ALREADY_REASSIGNED");
  assert.equal(env.getDoc().data.reservas[0].estado, "Reemplazada", "el estado no debe haber cambiado");
});

test("confirm.js: confirmar una reserva todavía con EspacioLiberado (nadie más tomó el horario) sí funciona y confirma la asistencia", async () => {
  const doc = {
    ...BASE_DOC,
    reservas: [
      { reservaID: "RES-NC-3", fecha: "2026-08-11", hora: "10:00", colaboradorID: "COL-1", estado: "Preaprobada", estadoConfirmacion: "EspacioLiberado" },
    ],
  };
  const env = createNestedMockEnv(doc);
  const req = new Request("https://localhost/api/booking/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "IDEM-NC3-1", reservationId: "RES-NC-3", status: "Confirmada" }),
  });
  const res = await confirmPost({ request: req, env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  assert.equal(env.getDoc().data.reservas[0].estado, "Confirmada");
  assert.equal(env.getDoc().data.reservas[0].estadoConfirmacion, "HoraConfirmada");
});

test("needsReview: una reserva nueva del chatbot queda marcada para revisión en el Dashboard", async () => {
  const env = createNestedMockEnv(BASE_DOC);
  const req = new Request("https://localhost/api/booking/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "IDEM-REVIEW-1",
      client: { name: "Clienta Review", phone: "8095552222" },
      serviceLines: [{ serviceId: "SRV-1", quantity: 1 }],
      requestedStartAt: "2026-08-11T09:00:00",
      collaboratorPreference: { mode: "specific", collaboratorId: "COL-1" },
    }),
  });
  const res = await confirmPost({ request: req, env });
  assert.equal(res.status, 200);
  const saved = env.getDoc().data.reservas[0];
  assert.equal(saved.needsReview, true);
  assert.equal(saved.estadoDeposito, "Pendiente");
  const client = env.getDoc().data.clientes.find((c) => c.telefono === "8095552222" || c.telefono === "+8095552222");
  assert.equal(client.needsReview, true);
});

test("send-reminders.js: primer recordatorio marca PendienteConfirmarHora y estampa la hora de envío", async () => {
  const doc = {
    ...BASE_DOC,
    reservas: [
      {
        reservaID: "RES-FIRST-1", fecha: "2020-01-01", hora: "08:00", colaboradorID: "COL-1",
        estado: "Preaprobada", estadoConfirmacion: "Programada", canalOrigen: "chatbot_whatsapp", telefono: "8095553333",
        clienteNombre: "Clienta Tarde",
      },
    ],
  };
  const env = createNestedMockEnv(doc, {
    BOOKING_REMINDER_CRON_SECRET: "cron-secret",
    ERP_WEBHOOK_SECRET: "webhook-secret",
    CHATBOT_BRIDGE_URL: "https://bridge.fake",
  });

  await withFakeGlobalFetch(
    async (url, options) => {
      if (url.includes("erp_records")) return env.fetch(url, options);
      if (url.includes("save_erp_record_if_current")) return env.fetch(url, options);
      if (url.includes("bridge.fake/webhook/overdue-reminders")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 }); // audit log u otros, no relevantes aquí
    },
    async () => {
      const req = new Request("https://localhost/api/booking/send-reminders", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      });
      const res = await sendRemindersPost({ request: req, env });
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.remindersSent, 1);
      assert.equal(env.getDoc().data.reservas[0].estadoConfirmacion, "PendienteConfirmarHora");
      assert.ok(env.getDoc().data.reservas[0].primerRecordatorioEnviadoEn);
    },
  );
});

test("send-reminders.js: segundo recordatorio (1h laboral después del primero, sin respuesta) libera el horario", async () => {
  const doc = {
    ...BASE_DOC,
    reservas: [
      {
        reservaID: "RES-SECOND-1", fecha: "2020-01-01", hora: "08:00", colaboradorID: "COL-1",
        estado: "Preaprobada", estadoConfirmacion: "PendienteConfirmarHora", canalOrigen: "chatbot_whatsapp", telefono: "8095553333",
        clienteNombre: "Clienta Tarde", primerRecordatorioEnviadoEn: "2019-12-31T18:00:00.000Z", // muy en el pasado, ya pasó de sobra 1h laboral
      },
    ],
  };
  const env = createNestedMockEnv(doc, {
    BOOKING_REMINDER_CRON_SECRET: "cron-secret",
    ERP_WEBHOOK_SECRET: "webhook-secret",
    CHATBOT_BRIDGE_URL: "https://bridge.fake",
  });

  await withFakeGlobalFetch(
    async (url, options) => {
      if (url.includes("erp_records")) return env.fetch(url, options);
      if (url.includes("save_erp_record_if_current")) return env.fetch(url, options);
      if (url.includes("bridge.fake/webhook/overdue-reminders")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    },
    async () => {
      const req = new Request("https://localhost/api/booking/send-reminders", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      });
      const res = await sendRemindersPost({ request: req, env });
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.escalationsSent, 1);
      assert.equal(env.getDoc().data.reservas[0].estadoConfirmacion, "EspacioLiberado");
    },
  );
});
