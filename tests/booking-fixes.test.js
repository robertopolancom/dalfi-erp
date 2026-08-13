// Pruebas para las correcciones aplicadas al motor de reservas y a los endpoints de booking:
// - cancel.js / reschedule.js: bug de anidación (currentDoc.data.reservas vs currentDoc.reservas)
// - booking-engine.js: ReferenceError (sId) en calculateAppointmentDuration
// - Elegibilidad servicio<->colaboradora en la ruta de "profesional específica"
// - GET /availability con múltiples serviceId (bloque continuo de varios servicios)
// - Persistencia de todas las líneas de servicio en la reserva (no solo la primera)
// - Anticipación mínima/máxima y rechazo de fechas pasadas

import test from "node:test";
import assert from "node:assert/strict";

import { onRequestPost as cancelPost } from "../functions/api/booking/cancel.js";
import { onRequestPost as reschedulePost } from "../functions/api/booking/reschedule.js";
import { onRequestGet as availabilityGet } from "../functions/api/booking/availability.js";
import { onRequestPost as confirmPost } from "../functions/api/booking/confirm.js";
import {
  calculateAppointmentDuration,
  isCollaboratorEligibleForServiceLines,
} from "../outputs/lib/booking-engine.js";

// El documento real de producción está doblemente anidado: erp_records.data.data.reservas
function createNestedMockEnv(innerData) {
  let doc = { schema: "v1", meta: {}, data: JSON.parse(JSON.stringify(innerData)) };
  let updatedAt = "2026-08-03T12:00:00.000Z";

  return {
    SUPABASE_URL: "https://mock.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "mock_service_key",
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

const BASE_DOC = {
  servicios: [
    { servicioID: "SRV-1", servicio: "Manicura Rusa", duracionMin: 60 },
    { servicioID: "SRV-2", servicio: "Pedicura Clínica", duracionMin: 45, eligibleCollaboratorIds: ["COL-2"] },
  ],
  colaboradores: [
    { colaboradorID: "COL-1", nombreCompleto: "Ana Pérez", estado: "Activo" },
    { colaboradorID: "COL-2", nombreCompleto: "Jaimely Peña", estado: "Activo" },
  ],
  reservas: [],
};

function futureBusinessDate(minimumDays = 3) {
  for (let offset = minimumDays; offset < minimumDays + 7; offset += 1) {
    const date = new Date(Date.now() + offset * 86400000);
    if (date.getUTCDay() !== 0) return date.toISOString().slice(0, 10);
  }
  throw new Error("No se pudo resolver una fecha laborable futura.");
}

test("Bug de anidación: cancel.js encuentra y cancela una cita real (documento doblemente anidado)", async () => {
  const doc = {
    ...BASE_DOC,
    reservas: [
      { reservaID: "RES-1", fecha: "2026-08-10", hora: "10:00", estado: "Confirmada", colaboradorID: "COL-1" },
    ],
  };
  const env = createNestedMockEnv(doc);

  const req = new Request("https://localhost/api/booking/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appointmentId: "RES-1", reason: "Cliente no puede asistir" }),
  });

  const res = await cancelPost({ request: req, env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  assert.equal(data.status, "Cancelada");
  assert.equal(env.getDoc().data.reservas[0].estado, "Cancelada");
});

test("cancel.js responde 404 (no falso-negativo silencioso) cuando la cita realmente no existe", async () => {
  const env = createNestedMockEnv(BASE_DOC);
  const req = new Request("https://localhost/api/booking/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appointmentId: "RES-NO-EXISTE" }),
  });
  const res = await cancelPost({ request: req, env });
  assert.equal(res.status, 404);
});

test("Bug de anidación: reschedule.js encuentra y reprograma una cita real (documento doblemente anidado)", async () => {
  const targetDate = futureBusinessDate();
  const doc = {
    ...BASE_DOC,
    reservas: [
      {
        reservaID: "RES-2",
        fecha: "2026-08-10",
        hora: "10:00",
        horaFin: "11:00",
        duracionMin: 60,
        servicioID: "SRV-1",
        colaboradorID: "COL-1",
        colaboradorNombre: "Ana Pérez",
        estado: "Confirmada",
      },
    ],
  };
  const env = createNestedMockEnv(doc);

  const req = new Request("https://localhost/api/booking/reschedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appointmentId: "RES-2", date: targetDate, time: "11:00" }),
  });

  const res = await reschedulePost({ request: req, env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  assert.equal(data.appointment.status, "Reprogramada");
  assert.equal(env.getDoc().data.reservas[0].fecha, targetDate);
});

test("reschedule.js: nunca cobra un depósito nuevo (estadoDeposito se conserva tal cual, sea Pendiente o Verificado)", async () => {
  const doc = {
    ...BASE_DOC,
    reservas: [
      {
        reservaID: "RES-DEP-1", fecha: "2026-08-10", hora: "10:00", horaFin: "11:00", duracionMin: 60,
        servicioID: "SRV-1", colaboradorID: "COL-1", colaboradorNombre: "Ana Pérez",
        estado: "No asistió", estadoConfirmacion: "EspacioLiberado", estadoDeposito: "Verificado",
        canalOrigen: "chatbot_whatsapp",
      },
    ],
  };
  const env = createNestedMockEnv(doc);
  const futureDate = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10); // +5 días, de sobra >4h laborales
  const req = new Request("https://localhost/api/booking/reschedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appointmentId: "RES-DEP-1", date: futureDate, time: "11:00", reason: "No asistió, reagenda" }),
  });
  const res = await reschedulePost({ request: req, env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  assert.equal(env.getDoc().data.reservas[0].estadoDeposito, "Verificado", "el depósito ya verificado no debe resetearse a Pendiente");
});

test("reschedule.js: recalcula estadoConfirmacion para el NUEVO horario (una cita con EspacioLiberado deja de estar EspacioLiberado tras reagendar)", async () => {
  const doc = {
    ...BASE_DOC,
    reservas: [
      {
        reservaID: "RES-RESET-1", fecha: "2026-08-10", hora: "10:00", horaFin: "11:00", duracionMin: 60,
        servicioID: "SRV-1", colaboradorID: "COL-1", colaboradorNombre: "Ana Pérez",
        estado: "Preaprobada", estadoConfirmacion: "EspacioLiberado", estadoDeposito: "Pendiente",
        canalOrigen: "chatbot_whatsapp", primerRecordatorioEnviadoEn: "2026-08-09T13:00:00.000Z",
        segundoRecordatorioEnviadoEn: "2026-08-09T14:00:00.000Z",
      },
    ],
  };
  const env = createNestedMockEnv(doc);
  const futureDate = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const req = new Request("https://localhost/api/booking/reschedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appointmentId: "RES-RESET-1", date: futureDate, time: "11:00" }),
  });
  const res = await reschedulePost({ request: req, env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.appointment.estadoConfirmacion, "Programada");
  const saved = env.getDoc().data.reservas[0];
  assert.equal(saved.estadoConfirmacion, "Programada");
  assert.equal(saved.estado, "Reprogramada");
  assert.equal(saved.primerRecordatorioEnviadoEn, null);
  assert.equal(saved.segundoRecordatorioEnviadoEn, null);

  // Y la nueva franja horaria SÍ bloquea la disponibilidad (a diferencia de EspacioLiberado)
  const availReq = new Request(`https://localhost/api/booking/availability?serviceId=SRV-1&date=${futureDate}&collaboratorId=COL-1`);
  const availRes = await availabilityGet({ request: availReq, env });
  const availData = await availRes.json();
  assert.ok(!availData.slots.some((s) => s.time === "11:00"), "el horario nuevo debe quedar ocupado por la cita reagendada");
});

test("Elegibilidad: GET /availability rechaza una colaboradora no capacitada para el servicio pedido", async () => {
  const env = createNestedMockEnv(BASE_DOC);
  // SRV-2 (Pedicura Clínica) solo lo puede hacer COL-2, pedimos COL-1
  const req = new Request(
    "https://localhost/api/booking/availability?serviceId=SRV-2&date=2026-08-10&collaboratorId=COL-1"
  );
  const res = await availabilityGet({ request: req, env });
  const data = await res.json();
  assert.equal(res.status, 409);
  assert.equal(data.code, "SPECIALIST_NOT_ELIGIBLE");
});

test("Elegibilidad: POST /confirm rechaza reservar con una colaboradora no capacitada para el servicio", async () => {
  const env = createNestedMockEnv(BASE_DOC);
  const req = new Request("https://localhost/api/booking/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "IDEM-ELIG-1",
      client: { name: "Cliente Prueba", phone: "8095551234" },
      serviceLines: [{ serviceId: "SRV-2", quantity: 1 }],
      requestedStartAt: "2026-08-10T10:00:00",
      collaboratorPreference: { mode: "specific", collaboratorId: "COL-1" },
    }),
  });
  const res = await confirmPost({ request: req, env });
  const data = await res.json();
  assert.equal(res.status, 409);
  assert.equal(data.code, "SPECIALIST_NOT_ELIGIBLE");
});

test("Elegibilidad: la selección automática nunca asigna una colaboradora no capacitada", () => {
  const service = BASE_DOC.servicios[1]; // SRV-2, solo COL-2
  const col1 = BASE_DOC.colaboradores[0];
  const col2 = BASE_DOC.colaboradores[1];
  assert.equal(isCollaboratorEligibleForServiceLines(col1, [{ serviceId: "SRV-2" }], BASE_DOC.servicios), false);
  assert.equal(isCollaboratorEligibleForServiceLines(col2, [{ serviceId: "SRV-2" }], BASE_DOC.servicios), true);
});

test("ReferenceError corregido: un serviceId inexistente entre varios produce advertencia limpia, no una excepción", () => {
  const result = calculateAppointmentDuration({
    serviceLines: [{ serviceId: "SRV-1" }, { serviceId: "SRV-NO-EXISTE" }],
    services: BASE_DOC.servicios,
  });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /srv-no-existe/i);
});

test("ReferenceError corregido: GET /availability con un servicio inexistente en una solicitud multi-servicio responde 404 limpio, no 500", async () => {
  const env = createNestedMockEnv(BASE_DOC);
  const req = new Request(
    "https://localhost/api/booking/availability?serviceId=SRV-1&serviceId=SRV-NO-EXISTE&date=2026-08-10"
  );
  const res = await availabilityGet({ request: req, env });
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.success, false);
});

test("Bloque continuo: GET /availability con múltiples serviceId devuelve horarios que cubren la duración combinada", async () => {
  const env = createNestedMockEnv(BASE_DOC);
  // COL-1 no es elegible para SRV-2 (Pedicura), así que probamos con ambos servicios elegibles para COL-2 vía automático:
  // ampliamos SRV-1 para que también sea elegible solo por COL-2 en este caso de prueba puntual.
  const doc2 = {
    ...BASE_DOC,
    servicios: [
      { servicioID: "SRV-1", servicio: "Manicura Rusa", duracionMin: 60 },
      { servicioID: "SRV-3", servicio: "Esmaltado Simple", duracionMin: 30 },
    ],
  };
  const env2 = createNestedMockEnv(doc2);
  const targetDate = futureBusinessDate();
  const req = new Request(
    `https://localhost/api/booking/availability?serviceId=SRV-1&serviceId=SRV-3&date=${targetDate}&collaboratorId=COL-1`
  );
  const res = await availabilityGet({ request: req, env: env2 });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  assert.equal(data.service.durationMinutes, 90); // 60 + 30, bloque continuo
  assert.ok(data.slots.length > 0);
  // Sin la extensión, cada slot solo habría reflejado 60 min (un solo servicio)
});

test("Bloque continuo: confirmar una cita con varios servicios persiste TODAS las líneas, no solo la primera", async () => {
  const doc = {
    ...BASE_DOC,
    servicios: [
      { servicioID: "SRV-1", servicio: "Manicura Rusa", duracionMin: 60 },
      { servicioID: "SRV-3", servicio: "Esmaltado Simple", duracionMin: 30 },
    ],
  };
  const env = createNestedMockEnv(doc);
  // Fecha relativa (no fija) para que esta prueba no empiece a fallar por sí sola cuando
  // el reloj real cruce la fecha/hora antes escrita a mano — mismo criterio ya usado en las
  // pruebas de reschedule.js más abajo en este archivo.
  const futureStartAt = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) + "T09:00:00";
  const req = new Request("https://localhost/api/booking/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "IDEM-MULTI-1",
      client: { name: "Cliente Multi", phone: "8095550001" },
      serviceLines: [
        { serviceId: "SRV-1", quantity: 1 },
        { serviceId: "SRV-3", quantity: 1 },
      ],
      requestedStartAt: futureStartAt,
      collaboratorPreference: { mode: "specific", collaboratorId: "COL-1" },
    }),
  });
  const res = await confirmPost({ request: req, env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  const saved = env.getDoc().data.reservas[0];
  assert.equal(saved.duracionMin, 90);
  assert.equal(saved.servicios.length, 2);
  assert.deepEqual(
    saved.servicios.map((s) => s.servicioID),
    ["SRV-1", "SRV-3"]
  );
  assert.match(saved.servicio, /Manicura Rusa/);
  assert.match(saved.servicio, /Esmaltado Simple/);
});

test("Anticipación: no se permite reservar una fecha pasada", async () => {
  const env = createNestedMockEnv(BASE_DOC);
  const req = new Request("https://localhost/api/booking/availability?serviceId=SRV-1&date=2020-01-01");
  const res = await availabilityGet({ request: req, env });
  const data = await res.json();
  assert.equal(data.success, false);
});

test("Anticipación: se rechaza una fecha más allá de la anticipación máxima permitida (60 días por defecto)", async () => {
  const env = createNestedMockEnv(BASE_DOC);
  const farDate = new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const req = new Request(`https://localhost/api/booking/availability?serviceId=SRV-1&date=${farDate}`);
  const res = await availabilityGet({ request: req, env });
  const data = await res.json();
  assert.equal(data.success, false);
});
