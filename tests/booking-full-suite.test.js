import test from "node:test";
import assert from "node:assert/strict";

import {
  TIMEZONE,
  DEFAULT_BUSINESS_SCHEDULE,
  normalizeBusinessSchedule,
  normalizeStaffWeeklySchedule,
  resolveEffectiveStaffSchedule,
  calculateAppointmentDuration,
  calculateAvailableSlots,
  scoreEligibleCollaborator,
  selectBestAvailableCollaborator,
  buildAvailabilityResponseForChatbot,
} from "../outputs/lib/booking-engine.js";

// ==========================================
// A. HORARIO GENERAL DEL NEGOCIO (1-7)
// ==========================================
test("1. Lunes abierto por defecto", () => {
  const sched = normalizeBusinessSchedule();
  assert.equal(sched.weekDays.includes(1), true);
});

test("2. Sábado abierto por defecto", () => {
  const sched = normalizeBusinessSchedule();
  assert.equal(sched.weekDays.includes(6), true);
});

test("3. Domingo cerrado por defecto", () => {
  const sched = normalizeBusinessSchedule();
  assert.equal(sched.closedDays.includes(0), true);
});

test("4. Apertura 9:00 a.m. por defecto", () => {
  const sched = normalizeBusinessSchedule();
  assert.equal(sched.defaultOpeningTime, "09:00");
});

test("5. Cierre 6:00 p.m. (18:00) por defecto", () => {
  const sched = normalizeBusinessSchedule();
  assert.equal(sched.defaultClosingTime, "18:00");
});

test("6. Feriado configurado bloquea disponibilidad del día", () => {
  const bSched = normalizeBusinessSchedule({ holidayClosures: ["2026-12-25"] });
  const eff = resolveEffectiveStaffSchedule({
    collaboratorId: "COL-1",
    date: "2026-12-25",
    businessSchedule: bSched,
  });
  assert.equal(eff.isBusinessOpen, false);
  assert.equal(eff.isStaffWorking, false);
});

test("7. Horario configurable sin dispersar ni hardcodear", () => {
  const custom = normalizeBusinessSchedule({
    defaultOpeningTime: "08:00",
    defaultClosingTime: "19:00",
    closedDays: [0, 1], // Domingo y Lunes cerrados
  });
  assert.equal(custom.defaultOpeningTime, "08:00");
  assert.equal(custom.defaultClosingTime, "19:00");
  assert.deepEqual(custom.closedDays, [0, 1]);
});

// ==========================================
// B. HORARIO INDIVIDUAL POR MANICURISTA (8-14)
// ==========================================
test("8. Entrada y salida normales asignadas por manicurista", () => {
  const norm = normalizeStaffWeeklySchedule({
    collaboratorId: "COL-1",
    dayOfWeek: 2,
    entryTime: "09:30",
    exitTime: "17:30",
  });
  assert.equal(norm.entryTime, "09:30");
  assert.equal(norm.exitTime, "17:30");
});

test("9. Entrada tardía restringe los slots de la mañana", () => {
  const avail = calculateAvailableSlots({
    date: "2026-08-03", // Lunes
    collaboratorId: "COL-1",
    serviceLines: [{ serviceId: "SRV-1" }],
    services: [{ servicioID: "SRV-1", duracionMin: 30 }],
    weeklySchedules: [
      { collaboratorId: "COL-1", dayOfWeek: 1, working: true, entryTime: "11:00", exitTime: "18:00" },
    ],
  });
  const times = avail.slots.map((s) => s.time);
  assert.equal(times.includes("09:00"), false);
  assert.equal(times.includes("11:00"), true);
});

test("10. Salida temprana restringe los slots de la tarde", () => {
  const avail = calculateAvailableSlots({
    date: "2026-08-03",
    collaboratorId: "COL-1",
    serviceLines: [{ serviceId: "SRV-1" }],
    services: [{ servicioID: "SRV-1", duracionMin: 30 }],
    weeklySchedules: [
      { collaboratorId: "COL-1", dayOfWeek: 1, working: true, entryTime: "09:00", exitTime: "15:00" },
    ],
  });
  const times = avail.slots.map((s) => s.time);
  assert.equal(times.includes("14:30"), true);
  assert.equal(times.includes("15:00"), false);
  assert.equal(times.includes("17:00"), false);
});

test("11. Día libre individual desactiva disponibilidad", () => {
  const eff = resolveEffectiveStaffSchedule({
    collaboratorId: "COL-1",
    date: "2026-08-05", // Miércoles
    weeklySchedules: [{ collaboratorId: "COL-1", dayOfWeek: 3, working: false }],
  });
  assert.equal(eff.isStaffWorking, false);
});

test("12. Horario fuera de jornada del negocio queda bloqueado", () => {
  const avail = calculateAvailableSlots({
    date: "2026-08-03",
    collaboratorId: "COL-1",
    serviceLines: [{ serviceId: "SRV-1" }],
    services: [{ servicioID: "SRV-1", duracionMin: 60 }],
    businessSchedule: { defaultOpeningTime: "09:00", defaultClosingTime: "18:00" },
    weeklySchedules: [
      { collaboratorId: "COL-1", dayOfWeek: 1, working: true, entryTime: "07:00", exitTime: "21:00" },
    ],
  });
  const times = avail.slots.map((s) => s.time);
  // Debe recortar al horario del negocio 09:00 - 18:00
  assert.equal(times.includes("07:00"), false);
  assert.equal(times.includes("09:00"), true);
  assert.equal(times.includes("17:00"), true);
  assert.equal(times.includes("18:00"), false);
});

test("13. Copia semanal y 14. Vigencia de horarios", () => {
  const eff = resolveEffectiveStaffSchedule({
    collaboratorId: "COL-1",
    date: "2026-08-03",
    weeklySchedules: [
      { collaboratorId: "COL-1", dayOfWeek: 1, working: true, entryTime: "10:00", exitTime: "16:00", effectiveFrom: "2026-08-01", effectiveTo: "2026-08-31" },
    ],
  });
  assert.equal(eff.entryTime, "10:00");
  assert.equal(eff.exitTime, "16:00");
});

// ==========================================
// C. DOS HORAS DE ALMUERZO CONTINUO (15-20)
// ==========================================
test("15. Almuerzo continuo de 120 minutos asignado por defecto", () => {
  const norm = normalizeStaffWeeklySchedule({ collaboratorId: "COL-1", dayOfWeek: 1 });
  assert.equal(norm.lunchDurationMinutes, 120);
});

test("16. Almuerzo se ubica dentro de la jornada de trabajo", () => {
  const eff = resolveEffectiveStaffSchedule({
    collaboratorId: "COL-1",
    date: "2026-08-03",
  });
  assert.equal(eff.lunchStartTime, "12:00");
  assert.equal(eff.lunchEndTime, "14:00");
});

test("18. Servicio que cruza el intervalo de almuerzo queda excluido", () => {
  const avail = calculateAvailableSlots({
    date: "2026-08-03",
    collaboratorId: "COL-1",
    serviceLines: [{ serviceId: "SRV-1" }],
    services: [{ servicioID: "SRV-1", duracionMin: 60 }],
    weeklySchedules: [
      { collaboratorId: "COL-1", dayOfWeek: 1, working: true, entryTime: "09:00", exitTime: "18:00", lunchStartTime: "12:00", lunchEndTime: "14:00" },
    ],
  });
  const times = avail.slots.map((s) => s.time);
  // Un servicio de 60 min a las 11:30 terminaría 12:30 (dentro de almuerzo) -> NO disponible
  assert.equal(times.includes("11:30"), false);
  assert.equal(times.includes("12:00"), false);
  assert.equal(times.includes("13:00"), false);
  assert.equal(times.includes("14:00"), true);
});

test("20. Cambio de almuerzo actualiza la disponibilidad de forma dinámica", () => {
  const availCustomLunch = calculateAvailableSlots({
    date: "2026-08-03",
    collaboratorId: "COL-1",
    serviceLines: [{ serviceId: "SRV-1" }],
    services: [{ servicioID: "SRV-1", duracionMin: 60 }],
    weeklySchedules: [
      { collaboratorId: "COL-1", dayOfWeek: 1, working: true, entryTime: "09:00", exitTime: "18:00", lunchStartTime: "13:00", lunchEndTime: "15:00" },
    ],
  });
  const times = availCustomLunch.slots.map((s) => s.time);
  assert.equal(times.includes("12:00"), true); // Ahora 12:00 libre
  assert.equal(times.includes("13:00"), false); // 13:00 a 15:00 ocupado por almuerzo
});

// ==========================================
// D. DURACIÓN DE SERVICIOS Y BUFFERS (21-26)
// ==========================================
test("21. Servicio de 30 minutos genera intervalos exactos de 30m", () => {
  const dur = calculateAppointmentDuration({
    serviceLines: [{ serviceId: "S30" }],
    services: [{ servicioID: "S30", duracionMin: 30 }],
  });
  assert.equal(dur.totalServiceMinutes, 30);
});

test("22. Servicio de 60 minutos genera bloques de 60m", () => {
  const dur = calculateAppointmentDuration({
    serviceLines: [{ serviceId: "S60" }],
    services: [{ servicioID: "S60", duracionMin: 60 }],
  });
  assert.equal(dur.totalServiceMinutes, 60);
});

test("23. Servicio de 90 minutos genera bloques de 90m", () => {
  const dur = calculateAppointmentDuration({
    serviceLines: [{ serviceId: "S90" }],
    services: [{ servicioID: "S90", duracionMin: 90 }],
  });
  assert.equal(dur.totalServiceMinutes, 90);
});

test("24. Varios servicios consecutivos acumulan la duración total", () => {
  const dur = calculateAppointmentDuration({
    serviceLines: [{ serviceId: "S60" }, { serviceId: "S30" }],
    services: [{ servicioID: "S60", duracionMin: 60 }, { servicioID: "S30", duracionMin: 30 }],
  });
  assert.equal(dur.totalServiceMinutes, 90);
});

test("25. Buffer posterior añade tiempo de descanso/limpieza bloqueado", () => {
  const dur = calculateAppointmentDuration({
    serviceLines: [{ serviceId: "S60" }],
    services: [{ servicioID: "S60", duracionMin: 60, bufferAfterMinutes: 15 }],
  });
  assert.equal(dur.maxBufferAfter, 15);
  assert.equal(dur.totalBlockedMinutes, 75);
});

test("26. Servicio sin duración válida genera advertencia y rechaza slots automáticos", () => {
  const dur = calculateAppointmentDuration({
    serviceLines: [{ serviceId: "SINVALID" }],
    services: [{ servicioID: "SINVALID", duracionMin: 0 }],
  });
  assert.equal(dur.isValid, false);
  assert.equal(dur.warnings.length > 0, true);
});

// ==========================================
// E. ASIGNACIÓN INTELIGENTE Y PUNTUACIÓN (41-47)
// ==========================================
test("41. Menor carga diaria premia a manicurista con menos minutos ocupados", () => {
  const staff1 = { colaboradorID: "COL-1", nombreCompleto: "Ana" };
  const staff2 = { colaboradorID: "COL-2", nombreCompleto: "Brenda" };

  const s1 = scoreEligibleCollaborator({
    collaborator: staff1,
    date: "2026-08-03",
    serviceDurationMinutes: 60,
    dayAppointments: [{ colaboradorID: "COL-1", duracionMin: 180 }],
  });

  const s2 = scoreEligibleCollaborator({
    collaborator: staff2,
    date: "2026-08-03",
    serviceDurationMinutes: 60,
    dayAppointments: [],
  });

  assert.equal(s2.totalScore > s1.totalScore, true);
});

test("44. Empate en puntuación usa desempate determinista estable (nunca random puro)", () => {
  const staffList = [
    { colaboradorID: "COL-B", nombreCompleto: "Brenda" },
    { colaboradorID: "COL-A", nombreCompleto: "Ana" },
  ];
  const services = [{ servicioID: "S30", duracionMin: 30 }];

  const res1 = selectBestAvailableCollaborator({
    eligibleCollaborators: staffList,
    date: "2026-08-03",
    serviceLines: [{ serviceId: "S30" }],
    services,
  });

  const res2 = selectBestAvailableCollaborator({
    eligibleCollaborators: staffList,
    date: "2026-08-03",
    serviceLines: [{ serviceId: "S30" }],
    services,
  });

  assert.equal(res1.selected.colaboradorID, res2.selected.colaboradorID);
  assert.equal(res1.selected.nombreCompleto, "Ana"); // Orden numérico/alfabético estable
});

// ==========================================
// F. TÉCNICA E INVARIANTES (87-93)
// ==========================================
test("87. Cero NaN y 88. Cero Infinito en los cálculos de disponibilidad", () => {
  const result = calculateAvailableSlots({
    date: "2026-08-03",
    collaboratorId: "COL-1",
    serviceLines: [{ serviceId: "S30" }],
    services: [{ servicioID: "S30", duracionMin: 30 }],
    slotIntervalMinutes: NaN,
  });
  assert.equal(result.slots.length > 0, true);
  for (const s of result.slots) {
    assert.equal(isNaN(s.serviceDurationMinutes), false);
    assert.equal(isFinite(s.serviceDurationMinutes), true);
  }
});
