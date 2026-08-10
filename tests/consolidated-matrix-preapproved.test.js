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

test("checkPreapprovedConfirmationReminder: primer y segundo recordatorio según estadoConfirmacion (modelo de dos disparos exactos, no ciclo horario)", () => {
  // "Programada" cuya cita cae dentro de las 4h laborales siguientes -> primer recordatorio.
  const dueForFirst = {
    reservaID: "RES-CHAT-01",
    estado: "Preaprobada",
    estadoConfirmacion: "Programada",
    canalOrigen: "chatbot_whatsapp",
    fecha: "2026-08-04",
    hora: "10:00",
  };
  const firstCheck = checkPreapprovedConfirmationReminder(dueForFirst, "2026-08-04T13:00:00Z"); // 09:00 SD, cita a las 10:00 SD misma mañana
  assert.equal(firstCheck.requiresFirstReminder, true);
  assert.equal(firstCheck.requiresSecondReminder, false);

  // "PendienteConfirmarHora" (primer recordatorio ya enviado hace más de 1h laboral) -> segundo recordatorio + liberación.
  const dueForSecond = {
    ...dueForFirst,
    estadoConfirmacion: "PendienteConfirmarHora",
    primerRecordatorioEnviadoEn: "2026-08-04T13:00:00Z", // 09:00 SD
  };
  const secondCheck = checkPreapprovedConfirmationReminder(dueForSecond, "2026-08-04T14:30:00Z"); // 10:30 SD, 1.5h laboral después del primero
  assert.equal(secondCheck.requiresFirstReminder, false);
  assert.equal(secondCheck.requiresSecondReminder, true);
  assert.equal(secondCheck.shouldRelease, true);

  // Una reserva ya confirmada por el ERP (estadoConfirmacion "NoRequerida") nunca necesita recordatorio.
  const freshApt = { reservaID: "RES-ERP-01", estado: "Confirmada", estadoConfirmacion: "NoRequerida", canalOrigen: "ERP" };
  const reminderFresh = checkPreapprovedConfirmationReminder(freshApt);
  assert.equal(reminderFresh.requiresFirstReminder, false);
  assert.equal(reminderFresh.requiresSecondReminder, false);
});

test("determineInitialBookingStatus confirma citas de chatbot solicitadas con 4h laborales o menos de anticipación a la cita", () => {
  const refTime = new Date("2026-08-03T10:00:00Z");

  // 1. Cita del chatbot solicitada dentro de la ventana de 4h laborales -> Queda "Confirmada"/"NoRequerida" automáticamente
  const resultUrgent = determineInitialBookingStatus({
    source: "chatbot_whatsapp",
    requestedStartAt: "2026-08-03T12:00:00Z",
    referenceTime: refTime,
  });
  assert.equal(resultUrgent.estado, "Confirmada");
  assert.equal(resultUrgent.estadoConfirmacion, "NoRequerida");

  // 2. Cita del chatbot solicitada con más de 4h laborales de anticipación -> Queda "Preaprobada"/"Programada"
  const resultFar = determineInitialBookingStatus({
    source: "chatbot_whatsapp",
    requestedStartAt: "2026-08-04T10:00:00Z",
    referenceTime: refTime,
  });
  assert.equal(resultFar.estado, "Preaprobada");
  assert.equal(resultFar.estadoConfirmacion, "Programada");

  // 3. Cita del ERP -> Queda "Confirmada"/"NoRequerida" independientemente del tiempo
  const resultErp = determineInitialBookingStatus({
    source: "ERP",
    requestedStartAt: "2026-08-04T10:00:00Z",
    referenceTime: refTime,
  });
  assert.equal(resultErp.estado, "Confirmada");
  assert.equal(resultErp.estadoConfirmacion, "NoRequerida");
});
