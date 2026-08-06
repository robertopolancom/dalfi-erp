import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConsolidatedDailyMatrix,
  checkPreapprovedConfirmationReminder,
  determineInitialBookingStatus,
} from "../outputs/lib/booking-engine.js";

test("buildConsolidatedDailyMatrix consolida disponibilidad y citas por hora para todas las manicuristas", () => {
  const date = "2026-08-03"; // Lunes
  const staffList = [
    { colaboradorID: "COL-1", nombreCompleto: "Ana Pérez", estado: "Activo" },
    { colaboradorID: "COL-2", nombreCompleto: "Brenda López", estado: "Activo" },
  ];
  const services = [
    { servicioID: "SRV-1", servicio: "Manicura Rusa", duracionMin: 60 },
  ];
  const appointments = [
    {
      reservaID: "RES-101",
      fecha: "2026-08-03",
      hora: "09:00",
      horaFin: "10:00",
      duracionMin: 60,
      colaboradorID: "COL-1",
      colaboradorNombre: "Ana Pérez",
      clienteNombre: "María Gomez",
      servicio: "Manicura Rusa",
      estado: "Confirmada",
      canalOrigen: "ERP",
    },
    {
      reservaID: "RES-102",
      fecha: "2026-08-03",
      hora: "10:00",
      horaFin: "11:00",
      duracionMin: 60,
      colaboradorID: "COL-2",
      colaboradorNombre: "Brenda López",
      clienteNombre: "Laura Torres",
      servicio: "Manicura Rusa",
      estado: "Preaprobada",
      canalOrigen: "chatbot_whatsapp",
    },
  ];

  const result = buildConsolidatedDailyMatrix({
    date,
    staffList,
    appointments,
    services,
    slotIntervalMinutes: 30,
  });

  assert.equal(result.date, "2026-08-03");
  assert.equal(result.staffColumns.length, 2);
  assert.ok(result.timeSlots.length > 0);

  // Slot 09:00 - Ana Pérez reservada hasta las 10:00, Brenda libre
  const slot0900 = result.matrix.find((row) => row.time === "09:00");
  assert.ok(slot0900);
  assert.equal(slot0900.staffSlots["COL-1"].status, "booked");
  assert.equal(slot0900.staffSlots["COL-1"].busyUntil, "10:00");
  assert.equal(slot0900.staffSlots["COL-1"].clientName, "María Gomez");
  assert.equal(slot0900.staffSlots["COL-2"].status, "available");

  // Slot 10:00 - Brenda Preaprobada chatbot, Ana libre
  const slot1000 = result.matrix.find((row) => row.time === "10:00");
  assert.ok(slot1000);
  assert.equal(slot1000.staffSlots["COL-2"].status, "booked");
  assert.equal(slot1000.staffSlots["COL-2"].appointmentStatus, "Preaprobada");
  assert.equal(slot1000.staffSlots["COL-2"].busyUntil, "11:00");

  // Slot 12:00 - Almuerzo para ambas
  const slot1200 = result.matrix.find((row) => row.time === "12:00");
  assert.ok(slot1200);
  assert.equal(slot1200.staffSlots["COL-1"].status, "lunch");
  assert.equal(slot1200.staffSlots["COL-2"].status, "lunch");
});

test("checkPreapprovedConfirmationReminder detecta citas del chatbot pendientes que requieren confirmación tras 1 hora laboral", () => {
  const oldDate = new Date(Date.now() - 2 * 3600 * 1000).toISOString(); // Hace 2 horas
  const recentDate = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // Hace 10 minutos

  const overdueApt = {
    reservaID: "RES-CHAT-01",
    estado: "Preaprobada",
    canalOrigen: "chatbot_whatsapp",
    created_at: oldDate,
  };

  const freshApt = {
    reservaID: "RES-ERP-01",
    estado: "Confirmada",
    canalOrigen: "ERP",
    created_at: recentDate,
  };

  const reminderOverdue = checkPreapprovedConfirmationReminder(overdueApt);
  assert.equal(reminderOverdue.requiresConfirmationAlert, true);
  assert.ok(reminderOverdue.alertReason.includes("Reserva preaprobada del chatbot"));

  const reminderFresh = checkPreapprovedConfirmationReminder(freshApt);
  assert.equal(reminderFresh.requiresConfirmationAlert, false);
});

test("determineInitialBookingStatus confirma citas de chatbot solicitadas con 1h o menos de anticipación y deja preaprobadas las lejanas", () => {
  const refTime = new Date("2026-08-03T10:00:00Z");

  // 1. Cita del chatbot solicitada para dentro de 30 minutos (10:30) -> Queda "Confirmada"
  const statusUrgent = determineInitialBookingStatus({
    source: "chatbot_whatsapp",
    requestedStartAt: "2026-08-03T10:30:00Z",
    referenceTime: refTime,
  });
  assert.equal(statusUrgent, "Confirmada");

  // 2. Cita del chatbot solicitada para dentro de 24 horas (mañana 10:00) -> Queda "Preaprobada"
  const statusFar = determineInitialBookingStatus({
    source: "chatbot_whatsapp",
    requestedStartAt: "2026-08-04T10:00:00Z",
    referenceTime: refTime,
  });
  assert.equal(statusFar, "Preaprobada");

  // 3. Cita del ERP -> Queda "Confirmada" independientemente del tiempo
  const statusErp = determineInitialBookingStatus({
    source: "ERP",
    requestedStartAt: "2026-08-04T10:00:00Z",
    referenceTime: refTime,
  });
  assert.equal(statusErp, "Confirmada");
});
