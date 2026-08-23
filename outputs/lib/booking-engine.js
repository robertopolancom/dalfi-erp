// Motor puro de disponibilidad y reservas por manicurista (SeBen Service)
// No accede al DOM, no realiza I/O, opera determinísticamente en America/Santo_Domingo.

export const TIMEZONE = "America/Santo_Domingo";

// Horario por día de semana (0=Domingo..6=Sábado): null = cerrado ese día.
// Fuente de verdad única para "¿está abierto el negocio y a qué hora?" —
// weekDays/closedDays/defaultOpeningTime/defaultClosingTime (abajo) quedan
// solo por compatibilidad hacia atrás y se derivan de esto en
// normalizeBusinessSchedule(), nunca al revés.
export const DEFAULT_WEEKLY_HOURS = {
  0: null,
  1: { open: "09:00", close: "18:00" },
  2: { open: "09:00", close: "18:00" },
  3: { open: "09:00", close: "18:00" },
  4: { open: "09:00", close: "18:00" },
  5: { open: "09:00", close: "18:00" },
  6: { open: "09:00", close: "18:00" },
};

export const DEFAULT_BUSINESS_SCHEDULE = {
  timezone: TIMEZONE,
  weekDays: [1, 2, 3, 4, 5, 6], // Lunes (1) a Sábado (6)
  defaultOpeningTime: "09:00",
  defaultClosingTime: "18:00",
  closedDays: [0], // Domingo cerrado por defecto
  holidayClosures: [], // Array de fechas "YYYY-MM-DD" (cierre total, legado — ver scheduleExceptions)
  weeklyHours: DEFAULT_WEEKLY_HOURS,
  // Excepciones puntuales por fecha: cierre total (open/close null) u
  // horario especial (ej. cierre temprano en Nochebuena). Tiene prioridad
  // sobre weeklyHours para esa fecha exacta. Editable desde el Dashboard
  // ("Configuración General del Establecimiento").
  scheduleExceptions: [], // [{ date: "YYYY-MM-DD", open, close, label }]
  minimumBookingNoticeMinutes: 30,
  maximumAdvanceBookingDays: 60,
  defaultSlotIntervalMinutes: 15,
  defaultBufferBeforeMinutes: 0,
  defaultBufferAfterMinutes: 0,
  cancellationPolicy: "Cancelación libre hasta 2 horas antes de la cita.",
  reschedulingPolicy: "Reprogramación libre hasta 2 horas antes de la cita.",
  updatedAt: null,
  updatedBy: null,
};

export const DEFAULT_LUNCH_DURATION_MINUTES = 120;
export const DEFAULT_LUNCH_START = "12:00";
export const DEFAULT_LUNCH_END = "14:00";

// Convierte "HH:MM" a minutos desde medianoche (0..1439).
export function parseTimeToMinutes(timeStr) {
  if (typeof timeStr !== "string") return null;
  const parts = timeStr.trim().split(":");
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

// Convierte minutos desde medianoche a "HH:MM".
export function formatMinutesToTime(totalMinutes) {
  if (typeof totalMinutes !== "number" || isNaN(totalMinutes) || !isFinite(totalMinutes)) return "00:00";
  const mins = Math.max(0, Math.floor(totalMinutes)) % 1440;
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
}

// Obtiene el día de la semana (0=Domingo, 1=Lunes, ..., 6=Sábado) para una fecha YYYY-MM-DD.
export function getDayOfWeekFromDateString(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const parts = dateStr.split("-");
  if (parts.length !== 3) return null;
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCDay();
}

// Resuelve la fecha/hora actual en America/Santo_Domingo (UTC-4 fijo, sin horario de verano)
// a partir de un Date/ISO string. Acepta también un objeto ya resuelto {date, time} para pruebas.
export function resolveSantoDomingoNow(now) {
  if (now && typeof now === "object" && typeof now.date === "string") {
    return { date: now.date, time: now.time || "00:00" };
  }
  const d = now instanceof Date ? now : new Date(now);
  const shifted = new Date(d.getTime() - 4 * 60 * 60 * 1000);
  return { date: shifted.toISOString().slice(0, 10), time: shifted.toISOString().slice(11, 16) };
}

// Convierte una fecha/hora civil del negocio a un instante real. Santo
// Domingo usa UTC-4 todo el año; hacerlo explícito evita que Node/Render
// interprete "YYYY-MM-DDTHH:MM" en la zona horaria propia del servidor.
export function santoDomingoDateTimeToMs(dateStr, timeStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))) return NaN;
  const minutes = parseTimeToMinutes(String(timeStr || ""));
  if (minutes === null) return NaN;
  const [year, month, day] = dateStr.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 4 + Math.floor(minutes / 60), minutes % 60, 0);
}

function bookingDateTimeToMs(value, fallbackDate = null, fallbackTime = null) {
  const raw = String(value || "");
  const naive = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d{1,3})?)?$/);
  if (naive) return santoDomingoDateTimeToMs(naive[1], naive[2]);
  if (raw) return new Date(raw).getTime();
  return santoDomingoDateTimeToMs(fallbackDate, fallbackTime);
}

// Diferencia en días de calendario (dateStr - baseDateStr), ambos "YYYY-MM-DD".
export function diffCalendarDays(dateStr, baseDateStr) {
  const parse = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(dateStr) - parse(baseDateStr)) / 86400000);
}

// Normaliza un único día de weeklyHours: {open,close} válido, o null (cerrado).
function normalizeDayWindow(entry) {
  if (!entry || typeof entry !== "object") return null;
  const open = parseTimeToMinutes(entry.open) !== null ? entry.open : null;
  const close = parseTimeToMinutes(entry.close) !== null ? entry.close : null;
  if (open === null || close === null) return null;
  if (parseTimeToMinutes(close) <= parseTimeToMinutes(open)) return null; // rango inválido, tratar como cerrado
  return { open, close };
}

// Sanitiza y normaliza la configuración general del negocio. weeklyHours es
// la fuente de verdad para "¿abierto y a qué hora, por día de semana?" —
// weekDays/closedDays/defaultOpeningTime/defaultClosingTime quedan
// derivados de ella al final (nunca al revés), para que documentos legados
// (sin weeklyHours todavía) sigan funcionando igual que antes.
export function normalizeBusinessSchedule(input) {
  const src = input && typeof input === "object" ? input : {};
  const legacyWeekDays = Array.isArray(src.weekDays)
    ? src.weekDays.map(Number).filter((d) => d >= 0 && d <= 6)
    : DEFAULT_BUSINESS_SCHEDULE.weekDays;
  const legacyClosedDays = Array.isArray(src.closedDays)
    ? src.closedDays.map(Number).filter((d) => d >= 0 && d <= 6)
    : DEFAULT_BUSINESS_SCHEDULE.closedDays;
  const legacyOpen = parseTimeToMinutes(src.defaultOpeningTime) !== null ? src.defaultOpeningTime : "09:00";
  const legacyClose = parseTimeToMinutes(src.defaultClosingTime) !== null ? src.defaultClosingTime : "18:00";
  const holidayClosures = Array.isArray(src.holidayClosures)
    ? src.holidayClosures.filter((f) => typeof f === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f))
    : [];

  const weeklyHours = {};
  for (let day = 0; day <= 6; day += 1) {
    if (src.weeklyHours && typeof src.weeklyHours === "object") {
      weeklyHours[day] = normalizeDayWindow(src.weeklyHours[day] ?? src.weeklyHours[String(day)]);
    } else {
      // Sin weeklyHours explícito: derivar de los campos legados (mismo
      // resultado que el comportamiento anterior a esta función).
      const openThatDay = legacyWeekDays.includes(day) && !legacyClosedDays.includes(day);
      weeklyHours[day] = openThatDay ? { open: legacyOpen, close: legacyClose } : null;
    }
  }
  const weekDays = [];
  const closedDays = [];
  for (let day = 0; day <= 6; day += 1) {
    if (weeklyHours[day]) weekDays.push(day);
    else closedDays.push(day);
  }

  const scheduleExceptions = Array.isArray(src.scheduleExceptions)
    ? src.scheduleExceptions
        .filter((exc) => exc && typeof exc === "object" && /^\d{4}-\d{2}-\d{2}$/.test(exc.date || ""))
        .map((exc) => ({
          date: exc.date,
          open: parseTimeToMinutes(exc.open) !== null ? exc.open : null,
          close: parseTimeToMinutes(exc.close) !== null ? exc.close : null,
          label: typeof exc.label === "string" ? exc.label.slice(0, 120) : "",
        }))
    : [];

  return {
    timezone: TIMEZONE,
    weekDays: weekDays.length ? weekDays : [1, 2, 3, 4, 5, 6],
    defaultOpeningTime: legacyOpen,
    defaultClosingTime: legacyClose,
    closedDays,
    holidayClosures: Array.from(new Set(holidayClosures)),
    weeklyHours,
    scheduleExceptions,
    minimumBookingNoticeMinutes: Math.max(0, Number(src.minimumBookingNoticeMinutes) || 30),
    maximumAdvanceBookingDays: Math.max(1, Number(src.maximumAdvanceBookingDays) || 60),
    defaultSlotIntervalMinutes: Math.max(5, Number(src.defaultSlotIntervalMinutes) || 15),
    defaultBufferBeforeMinutes: Math.max(0, Number(src.defaultBufferBeforeMinutes) || 0),
    defaultBufferAfterMinutes: Math.max(0, Number(src.defaultBufferAfterMinutes) || 0),
    cancellationPolicy: src.cancellationPolicy || DEFAULT_BUSINESS_SCHEDULE.cancellationPolicy,
    reschedulingPolicy: src.reschedulingPolicy || DEFAULT_BUSINESS_SCHEDULE.reschedulingPolicy,
    updatedAt: src.updatedAt || null,
    updatedBy: src.updatedBy || null,
  };
}

// Ventana de apertura del negocio para una fecha exacta, o null si está
// cerrado. Prioridad: scheduleExceptions (fecha exacta) > holidayClosures
// (legado, cierre total) > weeklyHours[díaDeSemana]. Recibe un
// businessSchedule YA normalizado (normalizeBusinessSchedule) — para no
// re-normalizar en cada iteración de businessMinutesUntil.
export function resolveBusinessDayWindow(dateStr, normalizedSchedule) {
  const exception = normalizedSchedule.scheduleExceptions.find((exc) => exc.date === dateStr);
  if (exception) {
    if (exception.open === null || exception.close === null) return null;
    return { openMinutes: parseTimeToMinutes(exception.open), closeMinutes: parseTimeToMinutes(exception.close) };
  }
  if (normalizedSchedule.holidayClosures.includes(dateStr)) return null;
  const dayOfWeek = getDayOfWeekFromDateString(dateStr);
  const window = dayOfWeek === null ? null : normalizedSchedule.weeklyHours[dayOfWeek];
  if (!window) return null;
  return { openMinutes: parseTimeToMinutes(window.open), closeMinutes: parseTimeToMinutes(window.close) };
}

// Minutos de horario laboral real entre dos instantes (fromMs, toMs),
// saltando cierres nocturnos, días cerrados y excepciones — camina día por
// día en America/Santo_Domingo. Usada para que "faltan N horas para la
// cita" cuente solo horas en que el salón realmente puede atender/revisar
// la reserva, en vez de horas de reloj puro (ver
// determineInitialBookingStatus/checkPreapprovedConfirmationReminder).
// Devuelve 0 si toMs <= fromMs (la cita ya pasó).
export function businessMinutesUntil(fromMs, toMs, businessSchedule = {}) {
  if (!(toMs > fromMs)) return 0;
  const bSched = normalizeBusinessSchedule(businessSchedule);
  let totalMinutes = 0;
  let cursorMs = fromMs;
  // Límite defensivo: nunca camina más allá de ~2 años de días, para que un
  // businessSchedule corrupto (todo cerrado) nunca cause un bucle largo.
  for (let guard = 0; guard < 730 && cursorMs < toMs; guard += 1) {
    const cursorSD = resolveSantoDomingoNow(new Date(cursorMs));
    const window = resolveBusinessDayWindow(cursorSD.date, bSched);
    // Medianoche (America/Santo_Domingo, UTC-4 fijo) del día del cursor, en ms UTC.
    const [y, m, d] = cursorSD.date.split("-").map(Number);
    const dayStartMs = Date.UTC(y, m - 1, d, 4, 0, 0); // 00:00 SD == 04:00 UTC
    if (window) {
      const openMs = dayStartMs + window.openMinutes * 60000;
      const closeMs = dayStartMs + window.closeMinutes * 60000;
      const segStart = Math.max(cursorMs, openMs);
      const segEnd = Math.min(toMs, closeMs);
      if (segEnd > segStart) totalMinutes += (segEnd - segStart) / 60000;
    }
    cursorMs = dayStartMs + 24 * 3600000; // medianoche del día siguiente
  }
  return totalMinutes;
}

// Normaliza el horario semanal individual de una colaboradora.
export function normalizeStaffWeeklySchedule(input) {
  const src = input && typeof input === "object" ? input : {};
  const dayOfWeek = Number(src.dayOfWeek);
  const validDay = !isNaN(dayOfWeek) && dayOfWeek >= 0 && dayOfWeek <= 6 ? dayOfWeek : 1;

  const entryMin = parseTimeToMinutes(src.entryTime) ?? 540; // 09:00
  const exitMin = parseTimeToMinutes(src.exitTime) ?? 1080; // 18:00
  const lunchStartMin = parseTimeToMinutes(src.lunchStartTime) ?? 720; // 12:00
  const lunchEndMin = parseTimeToMinutes(src.lunchEndTime) ?? 840; // 14:00

  // Asegurar 120 min de almuerzo si no se especifica o si es inconsistente
  let finalLunchStart = lunchStartMin;
  let finalLunchEnd = lunchEndMin;
  if (finalLunchEnd <= finalLunchStart || (finalLunchEnd - finalLunchStart) < 30) {
    finalLunchStart = 720;
    finalLunchEnd = 840;
  }
  const lunchDuration = finalLunchEnd - finalLunchStart;

  return {
    scheduleId: src.scheduleId || `SCH-${String(Math.random()).slice(2, 8)}`,
    collaboratorId: String(src.collaboratorId || src.colaboradorID || ""),
    weekStartDate: src.weekStartDate || null,
    dayOfWeek: validDay,
    working: src.working !== undefined ? Boolean(src.working) : validDay !== 0, // Domingo libre por defecto
    entryTime: formatMinutesToTime(entryMin),
    exitTime: formatMinutesToTime(exitMin),
    lunchStartTime: formatMinutesToTime(finalLunchStart),
    lunchEndTime: formatMinutesToTime(finalLunchEnd),
    lunchDurationMinutes: lunchDuration,
    effectiveFrom: src.effectiveFrom || null,
    effectiveTo: src.effectiveTo || null,
    observation: src.observation || "",
    updatedAt: src.updatedAt || null,
    updatedBy: src.updatedBy || null,
  };
}

// Resuelve el horario efectivo de una colaboradora para una fecha específica.
export function resolveEffectiveStaffSchedule({
  collaboratorId,
  date,
  weeklySchedules = [],
  exceptions = [],
  businessSchedule = {},
}) {
  const bSched = normalizeBusinessSchedule(businessSchedule);
  const dayOfWeek = getDayOfWeekFromDateString(date);
  const dayWindow = date ? resolveBusinessDayWindow(date, bSched) : null;

  const result = {
    collaboratorId,
    date,
    dayOfWeek,
    isBusinessOpen: true,
    isStaffWorking: true,
    entryTime: dayWindow ? formatMinutesToTime(dayWindow.openMinutes) : bSched.defaultOpeningTime,
    exitTime: dayWindow ? formatMinutesToTime(dayWindow.closeMinutes) : bSched.defaultClosingTime,
    lunchStartTime: DEFAULT_LUNCH_START,
    lunchEndTime: DEFAULT_LUNCH_END,
    lunchDurationMinutes: DEFAULT_LUNCH_DURATION_MINUTES,
    exceptions: [],
    reason: "",
  };

  if (dayOfWeek === null) {
    result.isStaffWorking = false;
    result.reason = "Fecha inválida.";
    return result;
  }

  // 1. Validar si el negocio abre (weeklyHours/scheduleExceptions/holidayClosures, ver resolveBusinessDayWindow)
  if (!dayWindow) {
    result.isBusinessOpen = false;
    result.isStaffWorking = false;
    result.reason = "El establecimiento está cerrado este día.";
    return result;
  }

  // 2. Buscar horario semanal de la manicurista para este día
  const matchingSched = weeklySchedules.find(
    (ws) =>
      String(ws.collaboratorId || ws.colaboradorID) === String(collaboratorId) &&
      Number(ws.dayOfWeek) === dayOfWeek &&
      (!ws.effectiveFrom || ws.effectiveFrom <= date) &&
      (!ws.effectiveTo || ws.effectiveTo >= date)
  );

  if (matchingSched) {
    const norm = normalizeStaffWeeklySchedule(matchingSched);
    result.isStaffWorking = norm.working;
    result.entryTime = norm.entryTime;
    result.exitTime = norm.exitTime;
    result.lunchStartTime = norm.lunchStartTime;
    result.lunchEndTime = norm.lunchEndTime;
    result.lunchDurationMinutes = norm.lunchDurationMinutes;
    if (!norm.working) {
      result.reason = "Día no laborable según horario semanal de la manicurista.";
    }
  } else if (dayOfWeek === 0) {
    result.isStaffWorking = false;
    result.reason = "Domingo es día libre predeterminado.";
  }

  // 3. Evaluar excepciones de horario activas para este día
  const activeExceptions = exceptions.filter(
    (exc) =>
      String(exc.collaboratorId || exc.colaboradorID) === String(collaboratorId) &&
      exc.date === date &&
      (exc.status || "Activa") === "Activa"
  );

  result.exceptions = activeExceptions;

  for (const exc of activeExceptions) {
    const type = String(exc.type || "").toLowerCase();
    if (exc.allDay || type === "ausencia" || type === "vacaciones" || type === "permiso" || type === "bloqueo") {
      result.isStaffWorking = false;
      result.reason = `Excepción activa: ${exc.reason || exc.type || "Bloqueo/Ausencia"}`;
      break;
    } else if (type === "entrada_especial" && exc.startTime) {
      result.entryTime = exc.startTime;
    } else if (type === "salida_especial" && exc.endTime) {
      result.exitTime = exc.endTime;
    } else if (type === "almuerzo_especial" && exc.startTime && exc.endTime) {
      result.lunchStartTime = exc.startTime;
      result.lunchEndTime = exc.endTime;
      const s = parseTimeToMinutes(exc.startTime) || 720;
      const e = parseTimeToMinutes(exc.endTime) || 840;
      result.lunchDurationMinutes = Math.max(0, e - s);
    }
  }

  return result;
}

// Calcula la duración total de un servicio o conjunto de servicios.
export function calculateAppointmentDuration({ serviceLines = [], services = [], defaultBufferAfter = 0 }) {
  let totalServiceMinutes = 0;
  let maxBufferBefore = 0;
  let maxBufferAfter = defaultBufferAfter;
  const evaluatedServices = [];
  const warnings = [];

  for (const line of serviceLines) {
    const targetKey = String(line.serviceId || line.servicioID || line.id || line.name || "").toLowerCase();
    const match = services.find(
      (s) =>
        String(s.servicioID || s.id || s.servicio).toLowerCase() === targetKey
    );

    if (!match) {
      warnings.push(`Servicio ${targetKey || line.name || "desconocido"} no encontrado en el catálogo.`);
      continue;
    }

    const duration = Number(match.duracionMin || match.duration || match.durationMinutes) || 0;
    if (duration <= 0) {
      warnings.push(`Servicio '${match.servicio || match.name}' no tiene una duración válida configurada.`);
    } else {
      totalServiceMinutes += duration * (Number(line.quantity) || 1);
    }

    const bufBefore = Number(match.bufferBeforeMinutes) || 0;
    const bufAfter = Number(match.bufferAfterMinutes) || 0;

    if (bufBefore > maxBufferBefore) maxBufferBefore = bufBefore;
    if (bufAfter > maxBufferAfter) maxBufferAfter = bufAfter;

    evaluatedServices.push({
      id: match.servicioID || match.id,
      name: match.servicio || match.name,
      durationMinutes: duration,
      bufferBeforeMinutes: bufBefore,
      bufferAfterMinutes: bufAfter,
    });
  }

  const totalBlockedMinutes = totalServiceMinutes + maxBufferBefore + maxBufferAfter;

  return {
    totalServiceMinutes,
    maxBufferBefore,
    maxBufferAfter,
    totalBlockedMinutes,
    evaluatedServices,
    warnings,
    isValid: totalServiceMinutes > 0 && warnings.length === 0,
  };
}

// Verifica si una colaboradora está habilitada para realizar un servicio específico.
// Si el servicio no define eligibleCollaboratorIds (o está vacío), se considera abierto a cualquier colaboradora activa.
export function isCollaboratorEligibleForService(collaborator, service) {
  const eligible = service?.eligibleCollaboratorIds;
  if (!Array.isArray(eligible) || eligible.length === 0) return true;
  const collaboratorId = String(collaborator?.colaboradorID || collaborator?.id || "");
  const collaboratorName = String(collaborator?.nombreCompleto || collaborator?.nombre || "");
  return eligible.includes(collaboratorId) || eligible.includes(collaboratorName);
}

// Verifica si una colaboradora está habilitada para TODAS las líneas de servicio de una reserva.
// Servicios que no se encuentren en el catálogo se ignoran aquí (calculateAppointmentDuration ya los reporta como warning).
export function isCollaboratorEligibleForServiceLines(collaborator, serviceLines = [], services = []) {
  return serviceLines.every((line) => {
    const targetKey = String(line.serviceId || line.servicioID || line.id || line.name || "").toLowerCase();
    const service = services.find((s) => String(s.servicioID || s.id || s.servicio).toLowerCase() === targetKey);
    if (!service) return true;
    return isCollaboratorEligibleForService(collaborator, service);
  });
}

// Comprueba si dos rangos numéricos [start1, end1] y [start2, end2] se solapan.
export function intervalsOverlap(start1, end1, start2, end2) {
  return Math.max(start1, start2) < Math.min(end1, end2);
}

// Verifica si dos citas se solapan.
export function appointmentOverlaps(apt1, apt2) {
  const start1 = typeof apt1.startMin === "number" ? apt1.startMin : parseTimeToMinutes(apt1.hora || apt1.startAt);
  const duration1 = Number(apt1.duracionMin || apt1.durationMinutes) || 30;
  const bufAfter1 = Number(apt1.bufferAfterMinutes) || 0;
  const end1 = start1 + duration1 + bufAfter1;

  const start2 = typeof apt2.startMin === "number" ? apt2.startMin : parseTimeToMinutes(apt2.hora || apt2.startAt);
  const duration2 = Number(apt2.duracionMin || apt2.durationMinutes) || 30;
  const bufAfter2 = Number(apt2.bufferAfterMinutes) || 0;
  const end2 = start2 + duration2 + bufAfter2;

  if (start1 === null || start2 === null) return false;
  return intervalsOverlap(start1, end1, start2, end2);
}

// Motor principal para calcular los slots de disponibilidad disponibles.
export function calculateAvailableSlots({
  date,
  collaboratorId,
  serviceLines = [],
  businessSchedule = {},
  weeklySchedules = [],
  exceptions = [],
  appointments = [],
  services = [],
  slotIntervalMinutes = null,
  referenceTime = null, // "HH:MM" si es para la fecha de hoy
  now = null, // Date | ISO string | {date,time} — si se provee, aplica fecha pasada + anticipación mín/máx
  // Aditivo y desactivado por defecto: cuando es true, además de `slots` (solo los libres,
  // comportamiento de siempre, sin cambios) se devuelve `allSlotsWithAvailability` con TODOS
  // los intervalos del día (libres, ocupados y ya pasados) marcados con `available`/`reason`.
  // Pensado para el chatbot de WhatsApp (mostrar horarios tachados como percepción de demanda),
  // no cambia nada para quien no pida esto explícitamente (personal, ReservApp).
  includeUnavailable = false,
}) {
  const bSched = normalizeBusinessSchedule(businessSchedule);
  const interval = slotIntervalMinutes || bSched.defaultSlotIntervalMinutes;

  let resolvedNow = null;
  if (now) {
    resolvedNow = resolveSantoDomingoNow(now);
    if (date < resolvedNow.date) {
      return {
        date,
        collaboratorId,
        available: false,
        reason: "No se pueden reservar fechas pasadas.",
        slots: [],
        warnings: [],
      };
    }
    const daysAhead = diffCalendarDays(date, resolvedNow.date);
    if (daysAhead > bSched.maximumAdvanceBookingDays) {
      return {
        date,
        collaboratorId,
        available: false,
        reason: `La fecha solicitada excede la anticipación máxima permitida (${bSched.maximumAdvanceBookingDays} días).`,
        slots: [],
        warnings: [],
      };
    }
  }

  const effectiveSched = resolveEffectiveStaffSchedule({
    collaboratorId,
    date,
    weeklySchedules,
    exceptions,
    businessSchedule: bSched,
  });

  if (!effectiveSched.isBusinessOpen || !effectiveSched.isStaffWorking) {
    return {
      date,
      collaboratorId,
      available: false,
      reason: effectiveSched.reason,
      slots: [],
      warnings: [effectiveSched.reason],
    };
  }

  const durationResult = calculateAppointmentDuration({
    serviceLines,
    services,
    defaultBufferAfter: bSched.defaultBufferAfterMinutes,
  });

  if (!durationResult.isValid) {
    return {
      date,
      collaboratorId,
      available: false,
      reason: "No se pudo calcular la duración de los servicios seleccionados.",
      slots: [],
      warnings: durationResult.warnings,
    };
  }

  const totalServiceMin = durationResult.totalServiceMinutes;
  const bufBefore = durationResult.maxBufferBefore;
  const bufAfter = durationResult.maxBufferAfter;
  const totalBlockedMin = durationResult.totalBlockedMinutes;

  const openingMin = parseTimeToMinutes(bSched.defaultOpeningTime) ?? 540;
  const closingMin = parseTimeToMinutes(bSched.defaultClosingTime) ?? 1080;

  const entryMin = Math.max(openingMin, parseTimeToMinutes(effectiveSched.entryTime) ?? 540);
  const exitMin = Math.min(closingMin, parseTimeToMinutes(effectiveSched.exitTime) ?? 1080);

  const lunchStartMin = parseTimeToMinutes(effectiveSched.lunchStartTime) ?? 720;
  const lunchEndMin = parseTimeToMinutes(effectiveSched.lunchEndTime) ?? 840;

  // Recopilar todos los intervalos ocupados/bloqueados
  const busyIntervals = [];

  // 1. Almuerzo
  if (lunchEndMin > lunchStartMin) {
    busyIntervals.push({ start: lunchStartMin, end: lunchEndMin, type: "almuerzo", label: "Horario de almuerzo" });
  }

  // 2. Citas existentes activas
  const activeAppointments = appointments.filter((apt) => {
    const status = String(apt.estado || apt.status || "").toLowerCase();
    const confirmState = String(apt.estadoConfirmacion || "").toLowerCase();
    // "EspacioLiberado" (Preaprobada que llegó al segundo recordatorio sin
    // confirmarse, ver checkPreapprovedConfirmationReminder + send-reminders.js)
    // y "Reemplazada" (otra reserva confirmada ya tomó ese horario, ver
    // functions/api/booking/confirm.js) liberan el horario igual que una
    // cancelación: no deben seguir bloqueando la agenda de la manicurista.
    // "Reprogramada" ya NO se trata como cancelada: hoy significa que la
    // clienta reagendó su propia cita (vía el chatbot) o el staff le cambió
    // fecha/hora — sigue siendo su reserva activa y debe seguir bloqueando
    // el horario nuevo que ocupa. Solo "Reemplazada" (otra reserva confirmada
    // ya tomó ese horario) y "EspacioLiberado" liberan la agenda.
    const isCancelled = status.includes("cancelad")
      || status.includes("no_asistio") || status.includes("reemplazada")
      || confirmState === "espacioliberado";
    if (isCancelled) return false;
    const aptDate = apt.fecha || (apt.startAt ? apt.startAt.slice(0, 10) : null);
    if (aptDate !== date) return false;

    // Verificar colaboradora
    const aptStaff = String(apt.colaboradorID || apt.collaboratorId || apt.colaboradorNombre || "");
    const targetStaff = String(collaboratorId);
    if (apt.bloqueoGlobal === true || apt.globalBlock === true) return true;
    return aptStaff.includes(targetStaff) || targetStaff.includes(aptStaff);
  });

  for (const apt of activeAppointments) {
    const startM = parseTimeToMinutes(apt.hora || (apt.startAt ? apt.startAt.slice(11, 16) : null));
    if (startM === null) continue;
    const durM = Number(apt.duracionMin || apt.durationMinutes) || 30;
    const aptBufAfter = Number(apt.bufferAfterMinutes) || 0;
    busyIntervals.push({
      start: startM,
      end: startM + durM + aptBufAfter,
      type: "cita",
      label: `Reserva ${apt.reservaID || apt.id || ""}`,
    });
  }

  // 3. Excepciones parciales de horario
  for (const exc of effectiveSched.exceptions) {
    if (!exc.allDay && exc.startTime && exc.endTime) {
      const sM = parseTimeToMinutes(exc.startTime);
      const eM = parseTimeToMinutes(exc.endTime);
      if (sM !== null && eM !== null && eM > sM) {
        busyIntervals.push({ start: sM, end: eM, type: "excepcion", label: exc.reason || exc.type });
      }
    }
  }

  // 4. Límite de aviso mínimo si es hoy
  let minAllowedStart = entryMin;
  const effectiveReferenceTime = referenceTime || (resolvedNow && date === resolvedNow.date ? resolvedNow.time : null);
  if (effectiveReferenceTime) {
    const refM = parseTimeToMinutes(effectiveReferenceTime);
    if (refM !== null) {
      minAllowedStart = Math.max(minAllowedStart, refM + bSched.minimumBookingNoticeMinutes);
    }
  }

  const slots = [];
  const allSlotsWithAvailability = includeUnavailable ? [] : null;

  // Recorrer el día en incrementos de `interval`
  for (let slotStart = entryMin; slotStart + totalServiceMin <= exitMin; slotStart += interval) {
    const slotEnd = slotStart + totalServiceMin;
    const baseEntry = {
      startAt: `${date}T${formatMinutesToTime(slotStart)}:00`,
      endAt: `${date}T${formatMinutesToTime(slotEnd)}:00`,
      time: formatMinutesToTime(slotStart),
      endTime: formatMinutesToTime(slotEnd),
    };

    if (slotStart < minAllowedStart) {
      if (includeUnavailable) allSlotsWithAvailability.push({ ...baseEntry, available: false, reason: 'PAST' });
      continue;
    }

    const blockedStart = slotStart - bufBefore;
    const blockedEnd = slotEnd + bufAfter;

    // El bloqueo total debe estar dentro del horario de atención
    if (blockedStart < entryMin || blockedEnd > exitMin) continue;

    // Verificar si se solapa con algún intervalo ocupado
    const hasConflict = busyIntervals.some((busy) => intervalsOverlap(blockedStart, blockedEnd, busy.start, busy.end));

    if (!hasConflict) {
      const entry = {
        ...baseEntry,
        collaboratorId,
        serviceDurationMinutes: totalServiceMin,
        bufferBeforeMinutes: bufBefore,
        bufferAfterMinutes: bufAfter,
      };
      slots.push(entry);
      if (includeUnavailable) allSlotsWithAvailability.push({ ...entry, available: true });
    } else if (includeUnavailable) {
      allSlotsWithAvailability.push({ ...baseEntry, available: false, reason: 'OCUPADO' });
    }
  }

  return {
    date,
    collaboratorId,
    available: slots.length > 0,
    slots,
    ...(includeUnavailable ? { allSlotsWithAvailability } : {}),
    reason: slots.length > 0 ? "" : "No hay horarios disponibles para esta manicurista en la fecha seleccionada.",
    warnings: [],
  };
}

// Algoritmo de puntuación para asignación inteligente de manicurista cuando la clienta NO especifica preferencia.
export function scoreEligibleCollaborator({
  collaborator,
  date,
  serviceDurationMinutes,
  dayAppointments = [],
  weekAppointments = [],
  requestedTime = null,
  clientPreviousCollaboratorId = null,
}) {
  const staffId = String(collaborator.colaboradorID || collaborator.id || collaborator.nombreCompleto);

  // 1. Filtro de ocupación del día
  const staffDayApts = dayAppointments.filter(
    (apt) => String(apt.colaboradorID || apt.collaboratorId || apt.colaboradorNombre || "") === staffId
  );

  const dayBookedMinutes = staffDayApts.reduce(
    (sum, apt) => sum + (Number(apt.duracionMin || apt.durationMinutes) || 30),
    0
  );
  const dayAptCount = staffDayApts.length;

  // 2. Filtro de ocupación de la semana
  const staffWeekApts = weekAppointments.filter(
    (apt) => String(apt.colaboradorID || apt.collaboratorId || apt.colaboradorNombre || "") === staffId
  );
  const weekBookedMinutes = staffWeekApts.reduce(
    (sum, apt) => sum + (Number(apt.duracionMin || apt.durationMinutes) || 30),
    0
  );

  // Criterio A: Carga diaria equilibrada (max 50 pts)
  // Menos minutos reservados = mayor puntuación
  const workloadBalanceScore = Math.max(0, 50 - dayBookedMinutes / 10 - dayAptCount * 5);

  // Criterio B: Carga semanal justa (max 30 pts)
  const weeklyFairnessScore = Math.max(0, 30 - weekBookedMinutes / 60);

  // Criterio C: Ajuste a hora solicitada o reducción de huecos (max 20 pts)
  let gapReductionScore = 10;
  if (requestedTime) {
    const reqMin = parseTimeToMinutes(requestedTime);
    if (reqMin !== null && staffDayApts.length > 0) {
      const closestDist = Math.min(
        ...staffDayApts.map((apt) => {
          const aptMin = parseTimeToMinutes(apt.hora || (apt.startAt ? apt.startAt.slice(11, 16) : null)) || 0;
          return Math.abs(aptMin - reqMin);
        })
      );
      if (closestDist <= 60) gapReductionScore = 20; // Pegado a otra cita (reduce vacíos)
    }
  }

  // Criterio D: Continuidad de preferencia histórica autorizada de la clienta (max 10 pts)
  const clientContinuityScore = clientPreviousCollaboratorId && String(clientPreviousCollaboratorId) === staffId ? 10 : 0;

  const totalScore = Math.round(workloadBalanceScore + weeklyFairnessScore + gapReductionScore + clientContinuityScore);

  return {
    collaboratorId: staffId,
    name: collaborator.nombreCompleto || collaborator.nombre || staffId,
    totalScore,
    breakdown: {
      workloadBalanceScore,
      weeklyFairnessScore,
      gapReductionScore,
      clientContinuityScore,
      dayBookedMinutes,
      dayAptCount,
      weekBookedMinutes,
    },
  };
}

// Selecciona la mejor manicurista disponible mediante puntuación determinista (sin random puro).
export function selectBestAvailableCollaborator({
  eligibleCollaborators = [],
  date,
  serviceLines = [],
  services = [],
  businessSchedule = {},
  weeklySchedules = [],
  exceptions = [],
  appointments = [],
  requestedTime = null,
  seed = "default",
  now = null,
  // Ver el comentario equivalente en calculateAvailableSlots: aditivo, no cambia nada para
  // quien no lo pida. Aquí solo se recalcula (una vez más) para la colaboradora que termina
  // ganando la selección automática — no tendría sentido calcularlo para cada candidata
  // descartada.
  includeUnavailable = false,
}) {
  const candidates = [];

  const durationResult = calculateAppointmentDuration({ serviceLines, services });
  const serviceDurationMinutes = durationResult.totalServiceMinutes || 30;

  // Filtrar citas del día y la semana
  const dayAppointments = appointments.filter((apt) => (apt.fecha || apt.startAt?.slice(0, 10)) === date);

  // Considerar semana (7 días alrededor de la fecha)
  const weekAppointments = appointments.filter((apt) => {
    const aptD = apt.fecha || apt.startAt?.slice(0, 10);
    return aptD && Math.abs((new Date(aptD) - new Date(date)) / 86400000) <= 3;
  });

  for (const staff of eligibleCollaborators) {
    const staffId = String(staff.colaboradorID || staff.id || staff.nombreCompleto);

    // Calcular disponibilidad
    const avail = calculateAvailableSlots({
      date,
      collaboratorId: staffId,
      serviceLines,
      businessSchedule,
      weeklySchedules,
      exceptions,
      appointments,
      services,
      referenceTime: null,
      now,
    });

    if (!avail.available || avail.slots.length === 0) continue;

    // Si se solicitó hora específica, verificar que tenga ese slot
    if (requestedTime) {
      const hasSlotAtTime = avail.slots.some((s) => s.time === requestedTime);
      if (!hasSlotAtTime) continue;
    }

    const scoreData = scoreEligibleCollaborator({
      collaborator: staff,
      date,
      serviceDurationMinutes,
      dayAppointments,
      weekAppointments,
      requestedTime,
    });

    candidates.push({
      collaborator: staff,
      score: scoreData.totalScore,
      scoreData,
      availableSlots: avail.slots,
    });
  }

  if (candidates.length === 0) {
    return {
      selected: null,
      reason: "Ninguna manicurista autorizada tiene disponibilidad para la fecha u hora requerida.",
      evaluatedCount: 0,
      candidates: [],
    };
  }

  // Ordenar candidatos por puntuación descendente.
  // Desempate determinista estable por ID/nombre para evitar aleatoriedad pura.
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const nameA = String(a.collaborator.nombreCompleto || a.collaborator.id);
    const nameB = String(b.collaborator.nombreCompleto || b.collaborator.id);
    return nameA.localeCompare(nameB);
  });

  const best = candidates[0];
  let allSlotsWithAvailability = null;
  if (includeUnavailable) {
    const bestStaffId = String(best.collaborator.colaboradorID || best.collaborator.id || best.collaborator.nombreCompleto);
    const fullAvail = calculateAvailableSlots({
      date, collaboratorId: bestStaffId, serviceLines, businessSchedule, weeklySchedules,
      exceptions, appointments, services, referenceTime: null, now, includeUnavailable: true,
    });
    allSlotsWithAvailability = fullAvail.allSlotsWithAvailability;
  }

  return {
    selected: best.collaborator,
    selectedScore: best.score,
    scoreBreakdown: best.scoreData.breakdown,
    availableSlots: best.availableSlots,
    ...(includeUnavailable ? { allSlotsWithAvailability } : {}),
    reason: `Selección automática asignó a '${best.collaborator.nombreCompleto || best.collaborator.id}' con puntuación ${best.score}.`,
    evaluatedCount: candidates.length,
    candidates: candidates.map((c) => ({
      id: c.collaborator.colaboradorID || c.collaborator.id,
      name: c.collaborator.nombreCompleto,
      score: c.score,
    })),
  };
}

// Construye la respuesta estructurada para el Chatbot.
export function buildAvailabilityResponseForChatbot({
  success = true,
  date,
  serviceId,
  serviceName,
  durationMinutes,
  collaboratorId = null,
  collaboratorName = null,
  slots = [],
  cancellationPolicy = null,
  errorCode = null,
  errorMessage = null,
  // Aditivo: solo aparece en la respuesta cuando quien llama pidió includeUnavailable (hoy,
  // únicamente el chatbot de WhatsApp para mostrar horarios ocupados/pasados tachados). El
  // personal y ReservApp nunca lo piden, así que nunca ven este campo.
  allSlotsWithAvailability = null,
}) {
  if (!success) {
    return {
      success: false,
      code: errorCode || "AVAILABILITY_ERROR",
      message: errorMessage || "No se pudo consultar la disponibilidad.",
      timezone: TIMEZONE,
      date: date || null,
      slots: [],
    };
  }

  return {
    success: true,
    timezone: TIMEZONE,
    date,
    service: {
      id: serviceId || null,
      name: serviceName || "Servicio",
      durationMinutes: durationMinutes || 0,
    },
    collaborator: collaboratorId
      ? {
          id: collaboratorId,
          name: collaboratorName || "Manicurista",
        }
      : null,
    totalAvailableSlots: slots.length,
    slots: slots.map((s) => ({
      startAt: s.startAt,
      endAt: s.endAt,
      time: s.time,
      endTime: s.endTime,
      collaboratorId: s.collaboratorId,
    })),
    ...(allSlotsWithAvailability
      ? {
          allSlots: allSlotsWithAvailability.map((s) => ({
            startAt: s.startAt, endAt: s.endAt, time: s.time, endTime: s.endTime,
            available: s.available, reason: s.reason || null,
          })),
        }
      : {}),
    policies: {
      cancellation: cancellationPolicy || DEFAULT_BUSINESS_SCHEDULE.cancellationPolicy,
    },
  };
}

// Genera la matriz diaria consolidada de reservas y disponibilidad para todas las manicuristas.
export function buildConsolidatedDailyMatrix({
  date,
  staffList = [],
  appointments = [],
  services = [],
  businessSchedule = {},
  weeklySchedules = [],
  exceptions = [],
  slotIntervalMinutes = 30,
}) {
  const bSched = normalizeBusinessSchedule(businessSchedule);
  const openingMin = parseTimeToMinutes(bSched.defaultOpeningTime) ?? 540;
  const closingMin = parseTimeToMinutes(bSched.defaultClosingTime) ?? 1080;
  const step = slotIntervalMinutes || 30;

  const activeStaff = staffList.filter((s) => String(s.estado || "Activo").toLowerCase() === "activo");

  const staffColumns = activeStaff.map((s) => ({
    id: String(s.colaboradorID || s.id || s.nombreCompleto),
    name: s.nombreCompleto || s.nombre || String(s.colaboradorID || s.id),
  }));

  // Generar ranuras de hora
  const timeSlots = [];
  for (let min = openingMin; min < closingMin; min += step) {
    timeSlots.push({
      time: formatMinutesToTime(min),
      timeMin: min,
    });
  }

  // Pre-resolver horarios efectivos y citas activas por manicurista
  const staffContextMap = new Map();
  for (const staff of staffColumns) {
    const effSched = resolveEffectiveStaffSchedule({
      collaboratorId: staff.id,
      date,
      weeklySchedules,
      exceptions,
      businessSchedule: bSched,
    });

    const staffApts = appointments.filter((apt) => {
      const status = String(apt.estado || apt.status || "").toLowerCase();
      const confirmState = String(apt.estadoConfirmacion || "").toLowerCase();
      // "EspacioLiberado"/"Reemplazada" liberan el horario igual que una
      // cancelación — ver el bloque equivalente en calculateAvailableSlots arriba.
      // Ver el comentario equivalente en calculateAvailableSlots más arriba:
      // "Reprogramada" es un estado activo (la clienta o el staff reagendó),
      // no una cancelación — no se excluye aquí.
      const isCancelled = status.includes("cancelad")
        || status.includes("no_asistio") || status.includes("reemplazada")
        || confirmState === "espacioliberado";
      if (isCancelled) return false;
      const aptDate = apt.fecha || (apt.startAt ? apt.startAt.slice(0, 10) : null);
      if (aptDate !== date) return false;

      const aptStaff = String(apt.colaboradorID || apt.collaboratorId || apt.colaboradorNombre || "");
      if (apt.bloqueoGlobal === true || apt.globalBlock === true) return true;
      return aptStaff.includes(staff.id) || staff.id.includes(aptStaff);
    });

    staffContextMap.set(staff.id, {
      effSched,
      appointments: staffApts,
    });
  }

  const matrix = timeSlots.map((slot) => {
    const slotMin = slot.timeMin;
    const staffSlots = {};
    let availableCount = 0;
    let bookedCount = 0;
    let lunchCount = 0;
    let exceptionCount = 0;

    for (const staff of staffColumns) {
      const ctx = staffContextMap.get(staff.id);
      const eff = ctx.effSched;

      if (!eff.isBusinessOpen || !eff.isStaffWorking) {
        staffSlots[staff.id] = {
          status: "closed",
          label: "Cerrado / No laborable",
          busyUntil: null,
          appointment: null,
        };
        continue;
      }

      const entryM = parseTimeToMinutes(eff.entryTime) ?? openingMin;
      const exitM = parseTimeToMinutes(eff.exitTime) ?? closingMin;
      const lunchStartM = parseTimeToMinutes(eff.lunchStartTime) ?? 720;
      const lunchEndM = parseTimeToMinutes(eff.lunchEndTime) ?? 840;

      // 1. Fuera de jornada individual
      if (slotMin < entryM || slotMin >= exitM) {
        staffSlots[staff.id] = {
          status: "outside",
          label: "Fuera de jornada",
          busyUntil: null,
          appointment: null,
        };
        continue;
      }

      // 2. Almuerzo
      if (lunchEndM > lunchStartM && slotMin >= lunchStartM && slotMin < lunchEndM) {
        lunchCount++;
        staffSlots[staff.id] = {
          status: "lunch",
          label: `Almuerzo (${eff.lunchStartTime} - ${eff.lunchEndTime})`,
          busyUntil: eff.lunchEndTime,
          appointment: null,
        };
        continue;
      }

      // 3. Excepciones
      const exc = eff.exceptions.find((e) => {
        if (e.allDay) return true;
        const sM = parseTimeToMinutes(e.startTime);
        const eM = parseTimeToMinutes(e.endTime);
        return sM !== null && eM !== null && slotMin >= sM && slotMin < eM;
      });

      if (exc) {
        exceptionCount++;
        staffSlots[staff.id] = {
          status: "exception",
          label: `Bloqueo: ${exc.reason || exc.type || "Excepción"}`,
          busyUntil: exc.endTime || null,
          appointment: null,
        };
        continue;
      }

      // 4. Citas activas
      const matchingApt = ctx.appointments.find((apt) => {
        const startM = parseTimeToMinutes(apt.hora || (apt.startAt ? apt.startAt.slice(11, 16) : null));
        if (startM === null) return false;
        const durM = Number(apt.duracionMin || apt.durationMinutes) || 30;
        const endM = startM + durM;
        return slotMin >= startM && slotMin < endM;
      });

      if (matchingApt) {
        bookedCount++;
        const startM = parseTimeToMinutes(matchingApt.hora || (matchingApt.startAt ? matchingApt.startAt.slice(11, 16) : null));
        const durM = Number(matchingApt.duracionMin || matchingApt.durationMinutes) || 30;
        const endM = startM + durM;
        const busyUntilStr = matchingApt.horaFin || formatMinutesToTime(endM);

        staffSlots[staff.id] = {
          status: "booked",
          label: `Reservada hasta ${busyUntilStr}`,
          busyUntil: busyUntilStr,
          clientName: matchingApt.clienteNombre || matchingApt.client || "Cliente",
          service: matchingApt.servicio || matchingApt.service || "Servicio",
          appointmentId: matchingApt.reservaID || matchingApt.id,
          appointmentStatus: matchingApt.estado || "Confirmada",
          source: matchingApt.canalOrigen || matchingApt.source || "ERP",
          appointment: matchingApt,
        };
      } else {
        availableCount++;
        staffSlots[staff.id] = {
          status: "available",
          label: "Disponible",
          busyUntil: null,
          appointment: null,
        };
      }
    }

    return {
      time: slot.time,
      timeMin: slot.timeMin,
      staffSlots,
      availableCount,
      bookedCount,
      lunchCount,
      exceptionCount,
    };
  });

  return {
    date,
    staffColumns,
    timeSlots,
    matrix,
    businessSchedule: bSched,
  };
}

// Decide si toca enviar el primer/segundo recordatorio de confirmación de
// asistencia, o liberar el horario — según estadoConfirmacion (dimensión
// independiente de estado/estadoDeposito, ver determineInitialBookingStatus)
// y horas laborales reales (businessMinutesUntil, nunca reloj puro).
//
// Regla (dos disparos exactos, no una cadencia horaria):
// - "Programada" + faltan <=4h laborales para la cita -> requiresFirstReminder.
// - "PendienteConfirmarHora" (primer recordatorio ya enviado, estampado en
//   appointment.primerRecordatorioEnviadoEn) + ya pasó >=1h laboral desde
//   ese envío sin que la clienta confirme/reagende -> requiresSecondReminder
//   Y shouldRelease (el segundo recordatorio y la liberación del horario
//   ocurren en el mismo evento, tal como pide el encargo).
// - Cualquier otro estadoConfirmacion (NoRequerida, HoraConfirmada,
//   EspacioLiberado, Reagendada) no necesita ninguna acción de este motor.
export function checkPreapprovedConfirmationReminder(appointment, referenceDateStr = null, businessSchedule = {}) {
  const none = { requiresFirstReminder: false, requiresSecondReminder: false, shouldRelease: false, hoursUntilAppointment: null };
  if (!appointment) return none;
  const confirmState = String(appointment.estadoConfirmacion || "");
  if (confirmState !== "Programada" && confirmState !== "PendienteConfirmarHora") return none;

  const refTime = referenceDateStr ? new Date(referenceDateStr).getTime() : Date.now();
  const aptDateStr = appointment.fecha || (appointment.startAt ? appointment.startAt.slice(0, 10) : null);
  const aptTimeStr = appointment.hora || (appointment.startAt ? appointment.startAt.slice(11, 16) : null);
  let aptStartMs = null;
  if (aptDateStr && aptTimeStr) {
    aptStartMs = santoDomingoDateTimeToMs(aptDateStr, aptTimeStr);
  }
  if (!aptStartMs) return none;

  const hoursUntilAppointment = Math.round((businessMinutesUntil(refTime, aptStartMs, businessSchedule) / 60) * 10) / 10;

  if (confirmState === "Programada") {
    return {
      requiresFirstReminder: hoursUntilAppointment <= 4,
      requiresSecondReminder: false,
      shouldRelease: false,
      hoursUntilAppointment,
    };
  }

  // confirmState === "PendienteConfirmarHora"
  const firstReminderAt = appointment.primerRecordatorioEnviadoEn;
  if (!firstReminderAt) {
    // No debería pasar (se estampa siempre al enviar el primero) — salvaguarda defensiva.
    return { requiresFirstReminder: true, requiresSecondReminder: false, shouldRelease: false, hoursUntilAppointment };
  }
  const firstReminderMs = new Date(firstReminderAt).getTime();
  const businessHoursSinceFirstReminder = businessMinutesUntil(firstReminderMs, refTime, businessSchedule) / 60;
  const requiresSecondReminder = businessHoursSinceFirstReminder >= 1;
  return {
    requiresFirstReminder: false,
    requiresSecondReminder,
    shouldRelease: requiresSecondReminder,
    hoursUntilAppointment,
  };
}

// Determina el estado inicial de una reserva nueva, en sus 3 dimensiones
// independientes (estado general / estadoDeposito / estadoConfirmacion —
// ver el modelo documentado en el encargo de depósitos y confirmación).
// Si se reservó vía chatbot con 4 horas laborales o menos de anticipación a
// la cita, "estado" queda "Confirmada" automáticamente y "estadoConfirmacion"
// nace "NoRequerida" (nunca se programan recordatorios para esa cita). De lo
// contrario (más de 4h laborales de anticipación), "estado" queda
// "Preaprobada" y "estadoConfirmacion" nace "Programada". Si es del ERP
// (canal no-chatbot), "Confirmada" + "NoRequerida" siempre. "estadoDeposito"
// siempre nace "Pendiente" — su transición la maneja el flujo de
// comprobantes, no este motor. businessSchedule: ver normalizeBusinessSchedule
// — las 4h se cuentan solo en horario laboral real (businessMinutesUntil).
export function determineInitialBookingStatus({ source, requestedStartAt = null, date = null, time = null, referenceTime = new Date(), businessSchedule = {} }) {
  const src = String(source || "").toLowerCase();
  const isChatbot = src.includes("chatbot") || src.includes("whatsapp") || src.includes("instagram");
  if (!isChatbot) return { estado: "Confirmada", estadoDeposito: "Pendiente", estadoConfirmacion: "NoRequerida" };

  let aptStartMs = null;
  if (requestedStartAt) {
    aptStartMs = bookingDateTimeToMs(requestedStartAt);
  } else if (date && time) {
    aptStartMs = santoDomingoDateTimeToMs(date, time);
  }

  if (!aptStartMs || isNaN(aptStartMs)) return { estado: "Preaprobada", estadoDeposito: "Pendiente", estadoConfirmacion: "Programada" };

  const refMs = referenceTime instanceof Date ? referenceTime.getTime() : new Date(referenceTime).getTime();
  const hoursUntilAppointment = businessMinutesUntil(refMs, aptStartMs, businessSchedule) / 60;

  // Si quedan 4 horas laborales o menos para la cita (o cita inminente), queda "Confirmada" automáticamente
  if (hoursUntilAppointment <= 4) {
    return { estado: "Confirmada", estadoDeposito: "Pendiente", estadoConfirmacion: "NoRequerida" };
  }

  return { estado: "Preaprobada", estadoDeposito: "Pendiente", estadoConfirmacion: "Programada" };
}

// Normaliza números de teléfono para comparar sin formato (espacios, guiones, extensión +1)
export function normalizePhoneDigits(phoneStr) {
  if (!phoneStr) return "";
  const digits = String(phoneStr).replace(/\D/g, "");
  // Si empieza con código de país 1 (ej. 1809...), tomar los últimos 10 dígitos para Republica Dominicana
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits;
}

// Normaliza textos para comparación difusa (quita acentos, puntuación y pasa a minúsculas)
export function normalizeTextForMatching(str) {
  if (!str) return "";
  return String(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

// Compara la similitud de dos nombres de clientes (índice Jaccard de tokens)
export function calculateNameSimilarity(name1, name2) {
  const norm1 = normalizeTextForMatching(name1);
  const norm2 = normalizeTextForMatching(name2);
  if (!norm1 || !norm2) return 0;
  if (norm1 === norm2) return 1.0;

  const tokens1 = new Set(norm1.split(/\s+/).filter(Boolean));
  const tokens2 = new Set(norm2.split(/\s+/).filter(Boolean));

  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }

  const union = new Set([...tokens1, ...tokens2]).size;
  return union === 0 ? 0 : intersection / union;
}

// Compara dos números telefónicos considerando los últimos 7 y 10 dígitos (soporta formatos locales e internacionales)
export function isPhoneMatch(phone1, phone2) {
  const digits1 = normalizePhoneDigits(phone1);
  const digits2 = normalizePhoneDigits(phone2);
  if (!digits1 || !digits2) return false;
  if (digits1 === digits2) return true;
  if (digits1.length >= 7 && digits2.length >= 7) {
    return digits1.slice(-7) === digits2.slice(-7) && (digits1.slice(-10) === digits2.slice(-10) || digits1.length < 10 || digits2.length < 10);
  }
  return false;
}

// Resuelve o crea un perfil de cliente ERP evitando duplicados mediante deduplicación inteligente multi-capa
export function resolveOrCreateClientProfile({
  clientList = [],
  client = {},
  senderPhone = null,
  source = "chatbot_whatsapp",
  phoneVerified = false,
}) {
  const targetPhone = client.phone || client.telefono || "";
  const targetName = client.name || client.clienteNombre || client.nombreCompleto || "Cliente Chatbot";
  const targetEmail = (client.email || client.correo || "").trim().toLowerCase();
  const targetDob = client.dateOfBirth || client.fechaNacimiento || "";
  const targetPreferredService = client.preferredService || client.servicioInteres || "";

  const normalizedTargetPhone = normalizePhoneDigits(targetPhone);
  const normalizedSenderPhone = normalizePhoneDigits(senderPhone);

  const clients = Array.isArray(clientList) ? clientList : [];

  // CAPA 1: Coincidencia por teléfono principal o sublíneas de contacto
  let existingClient = clients.find((c) => {
    const mainPhone = c.telefono || c.phone;
    if (isPhoneMatch(mainPhone, targetPhone)) return true;

    const linked = Array.isArray(c.lineasContactoVinculadas) ? c.lineasContactoVinculadas : [];
    return linked.some((l) => isPhoneMatch(l.phone || l.telefono, targetPhone));
  });

  // CAPA 2: Coincidencia por emisor de WhatsApp (senderPhone)
  if (!existingClient && normalizedSenderPhone) {
    existingClient = clients.find((c) => {
      const mainPhone = c.telefono || c.phone;
      if (isPhoneMatch(mainPhone, senderPhone)) return true;
      const linked = Array.isArray(c.lineasContactoVinculadas) ? c.lineasContactoVinculadas : [];
      return linked.some((l) => isPhoneMatch(l.phone || l.telefono, senderPhone));
    });
  }

  // CAPA 3: Coincidencia por correo electrónico exacto
  if (!existingClient && targetEmail) {
    existingClient = clients.find((c) => {
      const email = (c.correo || c.email || "").trim().toLowerCase();
      return email && email === targetEmail;
    });
  }

  // CAPA 4: Coincidencia inteligente por Similitud Fonética/Nombre + Dígitos coincidente
  if (!existingClient && targetName) {
    existingClient = clients.find((c) => {
      const nameSim = calculateNameSimilarity(targetName, c.nombreCompleto || c.nombre || "");
      if (nameSim >= 0.85) return true; // Nombres prácticamente idénticos (ej. "Maria Gomez" y "María Gómez")
      const mainPhone = c.telefono || c.phone;
      if (nameSim >= 0.5 && isPhoneMatch(mainPhone, targetPhone)) return true;
      return false;
    });
  }

  const nowISO = new Date().toISOString();

  if (existingClient) {
    // Cliente existente encontrado. Vincular sublíneas de contacto para no duplicar
    const linkedLines = Array.isArray(existingClient.lineasContactoVinculadas)
      ? [...existingClient.lineasContactoVinculadas]
      : [];

    if (normalizedSenderPhone && !isPhoneMatch(existingClient.telefono, senderPhone)) {
      const alreadyLinked = linkedLines.some((l) => isPhoneMatch(l.phone, senderPhone));
      if (!alreadyLinked) {
        linkedLines.push({
          phone: senderPhone,
          name: `Línea emisor WhatsApp (${targetName})`,
          source,
          linkedAt: nowISO,
        });
        existingClient.lineasContactoVinculadas = linkedLines;
      }
    }

    if (targetPhone && !isPhoneMatch(existingClient.telefono, targetPhone)) {
      const alreadyLinked = linkedLines.some((l) => isPhoneMatch(l.phone, targetPhone));
      if (!alreadyLinked) {
        linkedLines.push({
          phone: targetPhone,
          name: `Teléfono secundario (${targetName})`,
          source,
          linkedAt: nowISO,
        });
        existingClient.lineasContactoVinculadas = linkedLines;
      }
    }

    if (targetEmail && !existingClient.correo) {
      existingClient.correo = targetEmail;
    }
    if (targetDob && !existingClient.fechaNacimiento) {
      existingClient.fechaNacimiento = targetDob;
    }
    if (targetPreferredService && !existingClient.servicioInteres) {
      existingClient.servicioInteres = targetPreferredService;
    }

    // Un cliente que ya está verificado nunca se "desverifica" por una llamada posterior sin
    // el flag — solo se escribe cuando esta llamada trae una prueba nueva de verificación.
    if (phoneVerified && !existingClient.telefonoVerificado) {
      existingClient.telefonoVerificado = true;
      existingClient.telefonoVerificadoEn = nowISO;
    }

    existingClient.updated_at = nowISO;

    return {
      isNew: false,
      clientRecord: existingClient,
      clientId: String(existingClient.clienteID || existingClient.id),
      clientName: existingClient.nombreCompleto || targetName,
      phone: existingClient.telefono || targetPhone,
      linkedToExisting: true,
      note: `Cliente coincidente detectado ('${existingClient.nombreCompleto}'). Datos unificados sin duplicar.`,
    };
  }

  // CAPA 5: Si definitivamente no existe ninguna coincidencia, crear perfil único
  const newClientId = `CLI-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const linkedLines = [];
  if (senderPhone && !isPhoneMatch(senderPhone, targetPhone)) {
    linkedLines.push({
      phone: senderPhone,
      name: `WhatsApp emisor`,
      source,
      linkedAt: nowISO,
    });
  }

  const newClientRecord = {
    clienteID: newClientId,
    nombreCompleto: targetName,
    telefono: targetPhone,
    correo: targetEmail,
    fechaNacimiento: targetDob || null,
    servicioInteres: targetPreferredService || null,
    lineasContactoVinculadas: linkedLines,
    origenRegistro: source,
    estado: "Activo",
    telefonoVerificado: Boolean(phoneVerified),
    telefonoVerificadoEn: phoneVerified ? nowISO : null,
    // Clientas creadas por el chatbot (sin un miembro del salón validando los
    // datos en el momento) quedan marcadas para revisión en el Dashboard.
    needsReview: true,
    created_at: nowISO,
    updated_at: nowISO,
  };

  return {
    isNew: true,
    clientRecord: newClientRecord,
    clientId: newClientId,
    clientName: targetName,
    phone: targetPhone,
    linkedToExisting: false,
    note: `Nuevo cliente '${targetName}' registrado con perfil único.`,
  };
}

// Escanea y fusiona clientes duplicados en un listado completo
export function deduplicateClientDatabase(clientList = []) {
  if (!Array.isArray(clientList)) return { cleanedList: [], mergedCount: 0 };
  const cleanedList = [];
  let mergedCount = 0;

  for (const client of clientList) {
    const res = resolveOrCreateClientProfile({
      clientList: cleanedList,
      client,
      source: client.origenRegistro || "ERP",
    });

    if (res.isNew) {
      cleanedList.push(res.clientRecord);
    } else {
      mergedCount++;
    }
  }

  return {
    cleanedList,
    mergedCount,
  };
}

// Genera el texto formateado para WhatsApp de una factura, cobro o adición de servicio.
export function generateWhatsAppReceiptText({
  eventType = "invoice.created",
  invoiceId = "",
  clientName = "Cliente",
  clientPhone = "",
  date = "",
  lines = [],
  subtotal = 0,
  tip = 0,
  total = 0,
  paymentMethods = [],
  serviceName = "",
  staffName = "",
  time = "",
}) {
  const formattedDate = date || new Date().toISOString().slice(0, 10);
  const businessName = "DALFI STUDIO NAILS & ACADEMY";
  const whenText = `${formattedDate}${time ? ` a las ${time}` : ""}`;

  if (eventType === "booking.preapproved_reminder") {
    return `🌸 *${businessName}* 🌸
⏰ *RECORDATORIO: CITA PENDIENTE DE CONFIRMAR*
----------------------------------------
👤 *Cliente:* ${clientName}
✨ *Servicio:* ${serviceName || "Servicio"}
📅 *Fecha:* ${whenText}
👩‍🎨 *Especialista:* ${staffName || "Manicurista"}
----------------------------------------
Tu cita todavía está *pendiente de confirmación* del salón. Responde a este mensaje o llámanos para confirmarla. ¡Te esperamos! ✨`;
  }

  // Mismo texto para el primer y segundo recordatorio de confirmación de
  // asistencia (el encargo pide reenviar exactamente el mismo menú la
  // segunda vez) — la diferencia entre ambos la maneja el estado de la
  // reserva (estadoConfirmacion), no el mensaje.
  if (eventType === "booking.confirmation_reminder") {
    return `Queremos confirmar tu asistencia a la cita reservada. 💖

👤 *Cliente:* ${clientName}
✨ *Servicio:* ${serviceName || "Servicio"}
📅 *Fecha:* ${whenText}

1. Confirmar mi hora

2. Reagendar mi cita

3. Menú principal`;
  }

  if (eventType === "booking.preapproved_escalation") {
    return `🌸 *${businessName}* 🌸
⚠️ *TU CITA NECESITA ATENCIÓN*
----------------------------------------
👤 *Cliente:* ${clientName}
✨ *Servicio:* ${serviceName || "Servicio"}
📅 *Fecha:* ${whenText}
----------------------------------------
Un miembro de nuestro equipo te contactará en breve para confirmar los detalles de tu cita. ¡Gracias por tu paciencia! ✨`;
  }

  if (eventType === "service.added") {
    return `🌸 *${businessName}* 🌸
💅 *NUEVO SERVICIO AGREGADO A TU CITA*
----------------------------------------
👤 *Cliente:* ${clientName}
📅 *Fecha:* ${formattedDate}
✨ *Servicio:* ${serviceName || "Servicio"}
👩‍🎨 *Especialista:* ${staffName || "Manicurista"}
----------------------------------------
¡Nos vemos pronto en el salón! ✨`;
  }

  if (eventType === "payment.recorded") {
    return `🌸 *${businessName}* 🌸
🧾 *RECIBO DE PAGO / COBRO*
----------------------------------------
👤 *Cliente:* ${clientName}
📅 *Fecha:* ${formattedDate}
📋 *Factura / Referencia:* ${invoiceId}
💰 *Monto Pagado:* RD$ ${Number(total || subtotal).toLocaleString("es-DO", { minimumFractionDigits: 2 })}
💳 *Forma de Pago:* ${Array.isArray(paymentMethods) && paymentMethods.length ? paymentMethods.join(", ") : "Efectivo / Transferencia"}
----------------------------------------
¡Gracias por tu pago! ✨`;
  }

  // Por defecto: invoice.created
  let linesText = "";
  if (Array.isArray(lines) && lines.length > 0) {
    linesText = lines
      .map((l) => `• ${l.name || l.concepto || "Servicio"}: RD$ ${Number(l.total || l.precio || 0).toLocaleString("es-DO", { minimumFractionDigits: 2 })}`)
      .join("\n");
  } else if (serviceName) {
    linesText = `• ${serviceName}: RD$ ${Number(subtotal || total).toLocaleString("es-DO", { minimumFractionDigits: 2 })}`;
  } else {
    linesText = `• Servicio de Manicura / Pedicura: RD$ ${Number(subtotal || total).toLocaleString("es-DO", { minimumFractionDigits: 2 })}`;
  }

  const paymentsText = Array.isArray(paymentMethods) && paymentMethods.length ? paymentMethods.join(", ") : "Contado";

  return `🌸 *${businessName}* 🌸
🧾 *COMPROBANTE DE FACTURA N° ${invoiceId || "FACTURA"}*
----------------------------------------
👤 *Cliente:* ${clientName}
📱 *Teléfono:* ${clientPhone || "N/A"}
📅 *Fecha:* ${formattedDate}

💅 *Detalle de Servicios / Productos:*
${linesText}

----------------------------------------
💰 *Subtotal:* RD$ ${Number(subtotal || total).toLocaleString("es-DO", { minimumFractionDigits: 2 })}
${tip > 0 ? `✨ *Propina:* RD$ ${Number(tip).toLocaleString("es-DO", { minimumFractionDigits: 2 })}\n` : ""}💳 *Total Factura:* RD$ ${Number(total).toLocaleString("es-DO", { minimumFractionDigits: 2 })}
✅ *Pagado:* RD$ ${Number(total).toLocaleString("es-DO", { minimumFractionDigits: 2 })} (${paymentsText})
----------------------------------------
¡Gracias por visitarnos en Dalfi Studio! ✨`;
}

export function buildChatbotNotificationPayload({
  eventType = "invoice.created",
  actionRequired = null,
  clientPhone = "",
  clientName = "Cliente",
  invoiceId = "",
  receiptText = "",
  extraData = {},
}) {
  const defaultAction =
    eventType === "booking.preapproved_escalation"
      ? "escalate_to_human_agent"
      : eventType === "booking.preapproved_reminder"
      ? "send_customer_reminder"
      : "process_notification";

  return {
    event: eventType,
    actionRequired: actionRequired || defaultAction,
    timestamp: new Date().toISOString(),
    recipientPhone: clientPhone,
    clientName,
    receiptNumber: invoiceId,
    whatsappFormattedText: receiptText,
    data: extraData,
  };
}

if (typeof globalThis !== "undefined") {
  globalThis.DalfiBookingEngine = {
    TIMEZONE,
    DEFAULT_BUSINESS_SCHEDULE,
    DEFAULT_LUNCH_DURATION_MINUTES,
    DEFAULT_LUNCH_START,
    DEFAULT_LUNCH_END,
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
    buildConsolidatedDailyMatrix,
    checkPreapprovedConfirmationReminder,
    determineInitialBookingStatus,
    normalizePhoneDigits,
    normalizeTextForMatching,
    calculateNameSimilarity,
    isPhoneMatch,
    resolveOrCreateClientProfile,
    deduplicateClientDatabase,
    generateWhatsAppReceiptText,
    buildChatbotNotificationPayload,
  };
}
