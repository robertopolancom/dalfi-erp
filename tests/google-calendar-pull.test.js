import test from "node:test";
import assert from "node:assert/strict";
import { parseGoogleEvent, reservationIdForEvent } from "../functions/api/calendar/google-pull.js";
import { calculateAvailableSlots } from "../outputs/lib/booking-engine.js";

test("un evento de Google sin manicurista crea un bloqueo global pendiente", () => {
  const reservation = parseGoogleEvent({
    eventId: "google-event-ficticio",
    summary: "Cita de clienta ficticia",
    description: "Nota de agenda",
    start: "2026-08-12T19:00:00.000Z",
    end: "2026-08-12T20:00:00.000Z",
  }, [{ colaboradorID: "COL-1", nombreCompleto: "María" }]);
  assert.equal(reservation.estado, "Pendiente de completar");
  assert.equal(reservation.bloqueoGlobal, true);
  assert.equal(reservation.clienteProvisional, true);
  assert.equal(reservation.googleCalendarEventId, "google-event-ficticio");
});

test("un nombre exacto asigna una sola manicurista y elimina el bloqueo global", () => {
  const reservation = parseGoogleEvent({
    eventId: "google-event-staff",
    summary: "Cita: Clienta Ficticia — María",
    description: "Manicurista: María",
    start: "2026-08-12T19:00:00.000Z",
    end: "2026-08-12T19:30:00.000Z",
  }, [{ colaboradorID: "COL-1", nombreCompleto: "María" }]);
  assert.equal(reservation.colaboradorID, "COL-1");
  assert.equal(reservation.bloqueoGlobal, false);
});


test("el color del evento asigna la manicurista aunque no se escriba su nombre", () => {
  const reservation = parseGoogleEvent({
    eventId: "google-event-color",
    summary: "Cita de calendario",
    description: "Clienta: Elena",
    colorId: "2",
    start: "2026-08-12T19:00:00.000Z",
    end: "2026-08-12T20:00:00.000Z",
  }, [
    { colaboradorID: "COL-1", nombreCompleto: "Ana", estado: "Activo" },
    { colaboradorID: "COL-2", nombreCompleto: "María", estado: "Activo" },
  ]);
  assert.equal(reservation.colaboradorID, "COL-2");
  assert.equal(reservation.colaboradorNombre, "María");
  assert.equal(reservation.bloqueoGlobal, false);
});

test("el identificador derivado es estable y no usa datos de clienta", () => {
  assert.equal(reservationIdForEvent("google/event ficticio"), "GCAL-google_event_ficticio");
  assert.equal(reservationIdForEvent("google/event ficticio"), reservationIdForEvent("google/event ficticio"));
});

test("un bloqueo global ocupa la franja para todas las manicuristas", () => {
  const common = {
    date: "2026-08-12",
    serviceLines: [{ serviceId: "S1", durationMinutes: 60, name: "Manicura" }],
    services: [{ servicioID: "S1", servicio: "Manicura", duracionMin: 60 }],
    appointments: [{ reservaID: "GCAL-1", fecha: "2026-08-12", hora: "15:00", duracionMin: 60, estado: "Pendiente de completar", bloqueoGlobal: true }],
    businessSchedule: { defaultOpeningTime: "09:00", defaultClosingTime: "18:00" },
    weeklySchedules: [], exceptions: [],
  };
  const first = calculateAvailableSlots({ ...common, collaboratorId: "COL-1" });
  assert.ok(!first.slots.some((slot) => slot.time === "15:00"));
});
