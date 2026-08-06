import test from "node:test";
import assert from "node:assert/strict";

import {
  TIMEZONE,
  DEFAULT_BUSINESS_SCHEDULE,
  parseTimeToMinutes,
  formatMinutesToTime,
  getDayOfWeekFromDateString,
  normalizeBusinessSchedule,
  normalizeStaffWeeklySchedule,
  resolveEffectiveStaffSchedule,
  calculateAppointmentDuration,
  intervalsOverlap,
  appointmentOverlaps,
  calculateAvailableSlots,
  scoreEligibleCollaborator,
  selectBestAvailableCollaborator,
  buildAvailabilityResponseForChatbot,
} from "../outputs/lib/booking-engine.js";

test("TIMEZONE debe ser America/Santo_Domingo", () => {
  assert.equal(TIMEZONE, "America/Santo_Domingo");
});

test("parseTimeToMinutes y formatMinutesToTime conversiones bidireccionales", () => {
  assert.equal(parseTimeToMinutes("09:00"), 540);
  assert.equal(parseTimeToMinutes("18:00"), 1080);
  assert.equal(parseTimeToMinutes("12:30"), 750);
  assert.equal(parseTimeToMinutes("invalid"), null);
  assert.equal(parseTimeToMinutes(null), null);

  assert.equal(formatMinutesToTime(540), "09:00");
  assert.equal(formatMinutesToTime(1080), "18:00");
  assert.equal(formatMinutesToTime(750), "12:30");
  assert.equal(formatMinutesToTime(NaN), "00:00");
});

test("getDayOfWeekFromDateString mapea correctamente las fechas", () => {
  // 2026-08-03 es Lunes (1), 2026-08-08 es Sábado (6), 2026-08-09 es Domingo (0)
  assert.equal(getDayOfWeekFromDateString("2026-08-03"), 1);
  assert.equal(getDayOfWeekFromDateString("2026-08-08"), 6);
  assert.equal(getDayOfWeekFromDateString("2026-08-09"), 0);
  assert.equal(getDayOfWeekFromDateString("invalid"), null);
});

test("normalizeBusinessSchedule aplica defaults y sanitiza valores", () => {
  const norm = normalizeBusinessSchedule({});
  assert.equal(norm.timezone, "America/Santo_Domingo");
  assert.equal(norm.defaultOpeningTime, "09:00");
  assert.equal(norm.defaultClosingTime, "18:00");
  assert.deepEqual(norm.closedDays, [0]);
  assert.equal(norm.minimumBookingNoticeMinutes, 30);
});

test("normalizeStaffWeeklySchedule normaliza almuerzo de 120 minutos", () => {
  const norm = normalizeStaffWeeklySchedule({
    collaboratorId: "STAFF-1",
    dayOfWeek: 1,
    entryTime: "09:00",
    exitTime: "18:00",
    lunchStartTime: "12:00",
    lunchEndTime: "14:00",
  });
  assert.equal(norm.collaboratorId, "STAFF-1");
  assert.equal(norm.working, true);
  assert.equal(norm.lunchDurationMinutes, 120);
});

test("resolveEffectiveStaffSchedule detecta domingo cerrado y excepciones", () => {
  const sunday = resolveEffectiveStaffSchedule({
    collaboratorId: "STAFF-1",
    date: "2026-08-09", // Domingo
    weeklySchedules: [],
    exceptions: [],
  });
  assert.equal(sunday.isStaffWorking, false);
  assert.equal(sunday.isBusinessOpen, false);

  const mondayAbsence = resolveEffectiveStaffSchedule({
    collaboratorId: "STAFF-1",
    date: "2026-08-03", // Lunes
    weeklySchedules: [],
    exceptions: [
      {
        collaboratorId: "STAFF-1",
        date: "2026-08-03",
        type: "vacaciones",
        allDay: true,
        status: "Activa",
        reason: "Vacaciones anuales",
      },
    ],
  });
  assert.equal(mondayAbsence.isStaffWorking, false);
  assert.match(mondayAbsence.reason, /Vacaciones/);
});

test("calculateAppointmentDuration suma duraciones y buffers", () => {
  const services = [
    { servicioID: "SRV-1", servicio: "Manicura Rusa", duracionMin: 60, bufferAfterMinutes: 15 },
    { servicioID: "SRV-2", servicio: "Diseño Arte", duracionMin: 30, bufferAfterMinutes: 10 },
  ];
  const res = calculateAppointmentDuration({
    serviceLines: [{ serviceId: "SRV-1", quantity: 1 }, { serviceId: "SRV-2", quantity: 1 }],
    services,
  });
  assert.equal(res.isValid, true);
  assert.equal(res.totalServiceMinutes, 90);
  assert.equal(res.maxBufferAfter, 15);
  assert.equal(res.totalBlockedMinutes, 105);
});

test("calculateAvailableSlots genera slots excluyendo almuerzo (12:00-14:00) y citas", () => {
  const services = [{ servicioID: "SRV-1", servicio: "Uñas Acrílicas", duracionMin: 60 }];
  const result = calculateAvailableSlots({
    date: "2026-08-03", // Lunes
    collaboratorId: "STAFF-1",
    serviceLines: [{ serviceId: "SRV-1" }],
    services,
    businessSchedule: DEFAULT_BUSINESS_SCHEDULE,
    weeklySchedules: [
      {
        collaboratorId: "STAFF-1",
        dayOfWeek: 1,
        working: true,
        entryTime: "09:00",
        exitTime: "18:00",
        lunchStartTime: "12:00",
        lunchEndTime: "14:00",
      },
    ],
    appointments: [
      {
        reservaID: "RES-100",
        fecha: "2026-08-03",
        hora: "10:00",
        duracionMin: 60,
        colaboradorID: "STAFF-1",
        estado: "Confirmada",
      },
    ],
  });

  assert.equal(result.available, true);
  const times = result.slots.map((s) => s.time);

  // 10:00 a 11:00 está ocupado por RES-100.
  // 12:00 a 14:00 está ocupado por Almuerzo.
  // Cita de 60 min iniciada a las 11:30 terminaría a las 12:30 (se solapa con almuerzo) -> NO debe incluir 11:30.
  assert.ok(times.includes("09:00"));
  assert.ok(!times.includes("10:00"));
  assert.ok(!times.includes("11:30"));
  assert.ok(!times.includes("12:00"));
  assert.ok(!times.includes("13:00"));
  assert.ok(times.includes("14:00"));
});

test("selectBestAvailableCollaborator selecciona determinísticamente por puntuación", () => {
  const staff = [
    { colaboradorID: "STAFF-1", nombreCompleto: "Ana Pérez" },
    { colaboradorID: "STAFF-2", nombreCompleto: "Brenda Gómez" },
  ];
  const services = [{ servicioID: "SRV-1", servicio: "Manicura Básica", duracionMin: 30 }];

  // STAFF-1 ya tiene 3 citas el día de hoy, STAFF-2 tiene 0 citas
  const appointments = [
    { fecha: "2026-08-03", hora: "09:00", duracionMin: 60, colaboradorID: "STAFF-1", estado: "Confirmada" },
    { fecha: "2026-08-03", hora: "10:00", duracionMin: 60, colaboradorID: "STAFF-1", estado: "Confirmada" },
  ];

  const selection = selectBestAvailableCollaborator({
    eligibleCollaborators: staff,
    date: "2026-08-03",
    serviceLines: [{ serviceId: "SRV-1" }],
    services,
    appointments,
  });

  assert.equal(selection.selected.colaboradorID, "STAFF-2");
  assert.equal(selection.evaluatedCount, 2);
});

test("buildAvailabilityResponseForChatbot formatea respuesta sin datos privados", () => {
  const resp = buildAvailabilityResponseForChatbot({
    success: true,
    date: "2026-08-03",
    serviceId: "SRV-1",
    serviceName: "Pedicura SPA",
    durationMinutes: 45,
    collaboratorId: "STAFF-2",
    collaboratorName: "Brenda Gómez",
    slots: [{ startAt: "2026-08-03T09:00:00", endAt: "2026-08-03T09:45:00", time: "09:00", endTime: "09:45", collaboratorId: "STAFF-2" }],
  });

  assert.equal(resp.success, true);
  assert.equal(resp.service.name, "Pedicura SPA");
  assert.equal(resp.collaborator.name, "Brenda Gómez");
  assert.equal(resp.totalAvailableSlots, 1);
  assert.equal(resp.salary, undefined);
  assert.equal(resp.commission, undefined);
});
