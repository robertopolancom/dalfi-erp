// Pruebas para la ventana de "4 horas antes de la cita" consciente del
// horario laboral (por día de semana + excepciones puntuales), en vez de
// horas de reloj puro. Ver outputs/lib/booking-engine.js:
// businessMinutesUntil / resolveBusinessDayWindow / normalizeBusinessSchedule
// y sus consumidores determineInitialBookingStatus /
// checkPreapprovedConfirmationReminder.
//
// Fechas de referencia usadas en estas pruebas (America/Santo_Domingo):
// 2026-08-08 Sábado, 2026-08-09 Domingo (cerrado por defecto),
// 2026-08-10 Lunes, 2026-08-11 Martes.

import test from "node:test";
import assert from "node:assert/strict";

import {
  businessMinutesUntil,
  resolveBusinessDayWindow,
  normalizeBusinessSchedule,
  determineInitialBookingStatus,
  checkPreapprovedConfirmationReminder,
  resolveEffectiveStaffSchedule,
} from "../outputs/lib/booking-engine.js";

// America/Santo_Domingo es UTC-4 fijo (sin horario de verano) — "HH:MM" de
// un día SD equivale a "HH+4:MM" UTC del mismo día.
function sdMs(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [h, min] = timeStr.split(":").map(Number);
  return Date.UTC(y, m - 1, d, h + 4, min, 0);
}

const DEFAULT_SCHEDULE = {}; // usa el default: Lunes-Sábado 9:00-18:00, Domingo cerrado

test("businessMinutesUntil: el ejemplo del usuario — cita el martes 9am, reservada el lunes 1pm, quedan 5h laborales (no 20h de reloj)", () => {
  const from = sdMs("2026-08-10", "13:00"); // lunes 1pm
  const to = sdMs("2026-08-11", "09:00"); // martes 9am
  const minutes = businessMinutesUntil(from, to, DEFAULT_SCHEDULE);
  assert.equal(minutes, 5 * 60); // lunes 13:00-18:00 = 5h, nada más (martes empieza justo a las 9)
});

test("businessMinutesUntil: reservada el lunes 2:30pm (3.5h reales de operación antes de la cita del martes 9am)", () => {
  const from = sdMs("2026-08-10", "14:30");
  const to = sdMs("2026-08-11", "09:00");
  const minutes = businessMinutesUntil(from, to, DEFAULT_SCHEDULE);
  assert.equal(minutes, 3.5 * 60);
});

test("determineInitialBookingStatus: con 5h laborales de anticipación queda Preaprobada/Programada; con 3.5h queda Confirmada/NoRequerida directo", () => {
  const base = { source: "chatbot_whatsapp", date: "2026-08-11", time: "09:00", businessSchedule: DEFAULT_SCHEDULE };
  assert.deepEqual(
    determineInitialBookingStatus({ ...base, referenceTime: new Date(sdMs("2026-08-10", "13:00")) }),
    { estado: "Preaprobada", estadoDeposito: "Pendiente", estadoConfirmacion: "Programada" },
  );
  assert.deepEqual(
    determineInitialBookingStatus({ ...base, referenceTime: new Date(sdMs("2026-08-10", "14:30")) }),
    { estado: "Confirmada", estadoDeposito: "Pendiente", estadoConfirmacion: "NoRequerida" },
  );
});

test("businessMinutesUntil: Domingo (día cerrado por defecto) no cuenta minutos, aunque haya 40 horas de reloj de por medio", () => {
  // Sábado 5pm (1h antes del cierre) -> Lunes 9am (apertura). De reloj son
  // ~40h; en horario laboral real solo cuenta la 1h que queda el sábado —
  // el domingo entero no suma nada.
  const from = sdMs("2026-08-08", "17:00");
  const to = sdMs("2026-08-10", "09:00");
  const minutes = businessMinutesUntil(from, to, DEFAULT_SCHEDULE);
  assert.equal(minutes, 60);
});

test("determineInitialBookingStatus: reservar el sábado 5pm para el lunes 9am queda Confirmada directo (solo 1h laboral de margen, aunque falten ~40h de reloj)", () => {
  const result = determineInitialBookingStatus({
    source: "chatbot_whatsapp",
    date: "2026-08-10",
    time: "09:00",
    referenceTime: new Date(sdMs("2026-08-08", "17:00")),
    businessSchedule: DEFAULT_SCHEDULE,
  });
  assert.equal(result.estado, "Confirmada");
  assert.equal(result.estadoConfirmacion, "NoRequerida");
});

test("scheduleExceptions: un feriado de día completo hace que ese día no cuente, aunque normalmente esté abierto", () => {
  const schedule = { scheduleExceptions: [{ date: "2026-08-10", open: null, close: null, label: "Feriado nacional" }] };
  const from = sdMs("2026-08-10", "10:00"); // lunes 10am, pero es feriado
  const to = sdMs("2026-08-11", "09:00"); // martes 9am
  const minutes = businessMinutesUntil(from, to, schedule);
  assert.equal(minutes, 0); // el lunes (feriado) no suma nada, y el martes empieza justo a las 9
});

test("scheduleExceptions: un horario especial (cierre temprano) se respeta en el conteo", () => {
  const schedule = { scheduleExceptions: [{ date: "2026-08-10", open: "09:00", close: "14:00", label: "Nochebuena" }] };
  const from = sdMs("2026-08-10", "10:00"); // lunes 10am, cierra especial a las 2pm
  const to = sdMs("2026-08-11", "09:00");
  const minutes = businessMinutesUntil(from, to, schedule);
  assert.equal(minutes, 4 * 60); // 10am-2pm = 4h, en vez de las 8h que darían con el horario normal (10am-6pm)
});

test("resolveBusinessDayWindow: una excepción de fecha tiene prioridad sobre weeklyHours", () => {
  const schedule = normalizeBusinessSchedule({
    scheduleExceptions: [{ date: "2026-08-10", open: "10:00", close: "12:00", label: "Reunión de personal" }],
  });
  const window = resolveBusinessDayWindow("2026-08-10", schedule);
  assert.deepEqual(window, { openMinutes: 600, closeMinutes: 720 }); // 10:00 y 12:00 en minutos
});

test("resolveBusinessDayWindow: Domingo sin excepciones devuelve null (cerrado)", () => {
  const schedule = normalizeBusinessSchedule({});
  assert.equal(resolveBusinessDayWindow("2026-08-09", schedule), null);
});

test("checkPreapprovedConfirmationReminder: usa businessSchedule para decidir si requiere el primer recordatorio", () => {
  const apt = {
    estado: "Preaprobada",
    estadoConfirmacion: "Programada",
    canalOrigen: "chatbot_whatsapp",
    fecha: "2026-08-11",
    hora: "09:00",
    created_at: sdMs("2026-08-08", "10:00").toString(),
  };
  const farCheck = checkPreapprovedConfirmationReminder(apt, new Date(sdMs("2026-08-10", "13:00")).toISOString(), DEFAULT_SCHEDULE);
  assert.equal(farCheck.hoursUntilAppointment, 5);
  assert.equal(farCheck.requiresFirstReminder, false);
  const closeCheck = checkPreapprovedConfirmationReminder(apt, new Date(sdMs("2026-08-10", "14:30")).toISOString(), DEFAULT_SCHEDULE);
  assert.equal(closeCheck.hoursUntilAppointment, 3.5);
  assert.equal(closeCheck.requiresFirstReminder, true);
});

test("Regresión: normalizeBusinessSchedule() sin weeklyHours explícito (documento legado) sigue derivando Lunes-Sábado 9-18, Domingo cerrado", () => {
  const schedule = normalizeBusinessSchedule({});
  assert.equal(schedule.weeklyHours[0], null); // domingo
  assert.deepEqual(schedule.weeklyHours[1], { open: "09:00", close: "18:00" }); // lunes
  assert.deepEqual(schedule.weeklyHours[6], { open: "09:00", close: "18:00" }); // sábado
  assert.deepEqual(schedule.weekDays, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(schedule.closedDays, [0]);
});

test("Regresión: resolveEffectiveStaffSchedule con la configuración default devuelve el mismo horario que antes de este cambio", () => {
  const result = resolveEffectiveStaffSchedule({
    collaboratorId: "COL-1",
    date: "2026-08-10", // lunes
    weeklySchedules: [],
    exceptions: [],
    businessSchedule: {},
  });
  assert.equal(result.isBusinessOpen, true);
  assert.equal(result.entryTime, "09:00");
  assert.equal(result.exitTime, "18:00");

  const sunday = resolveEffectiveStaffSchedule({
    collaboratorId: "COL-1",
    date: "2026-08-09", // domingo
    weeklySchedules: [],
    exceptions: [],
    businessSchedule: {},
  });
  assert.equal(sunday.isBusinessOpen, false);
});
