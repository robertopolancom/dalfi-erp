// Motor puro de disponibilidad y reservas por manicurista (SeBen Service)
// No accede al DOM, no realiza I/O, opera determinísticamente en America/Santo_Domingo.

export const TIMEZONE = "America/Santo_Domingo";

export const DEFAULT_BUSINESS_SCHEDULE = {
  timezone: TIMEZONE,
  weekDays: [1, 2, 3, 4, 5, 6], // Lunes (1) a Sábado (6)
  defaultOpeningTime: "09:00",
  defaultClosingTime: "18:00",
  closedDays: [0], // Domingo cerrado por defecto
  holidayClosures: [], // Array de fechas "YYYY-MM-DD"
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

// Sanitiza y normaliza la configuración general del negocio.
export function normalizeBusinessSchedule(input) {
  const src = input && typeof input === "object" ? input : {};
  const weekDays = Array.isArray(src.weekDays)
    ? src.weekDays.map(Number).filter((d) => d >= 0 && d <= 6)
    : DEFAULT_BUSINESS_SCHEDULE.weekDays;
  const closedDays = Array.isArray(src.closedDays)
    ? src.closedDays.map(Number).filter((d) => d >= 0 && d <= 6)
    : DEFAULT_BUSINESS_SCHEDULE.closedDays;
  const holidayClosures = Array.isArray(src.holidayClosures)
    ? src.holidayClosures.filter((f) => typeof f === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f))
    : [];

  return {
    timezone: TIMEZONE,
    weekDays: weekDays.length ? weekDays : [1, 2, 3, 4, 5, 6],
    defaultOpeningTime: parseTimeToMinutes(src.defaultOpeningTime) !== null ? src.defaultOpeningTime : "09:00",
    defaultClosingTime: parseTimeToMinutes(src.defaultClosingTime) !== null ? src.defaultClosingTime : "18:00",
    closedDays: Array.from(new Set(closedDays)),
    holidayClosures: Array.from(new Set(holidayClosures)),
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

  const result = {
    collaboratorId,
    date,
    dayOfWeek,
    isBusinessOpen: true,
    isStaffWorking: true,
    entryTime: bSched.defaultOpeningTime,
    exitTime: bSched.defaultClosingTime,
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

  // 1. Validar si el negocio abre
  if (bSched.closedDays.includes(dayOfWeek) || bSched.holidayClosures.includes(date)) {
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
    const sId = line.serviceId || line.servicioID;
    const match = services.find((s) => String(s.id || s.servicioID) === String(sId));

    if (!match) {
      warnings.push(`Servicio ${sId || line.name || "desconocido"} no encontrado en el catálogo.`);
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
}) {
  const bSched = normalizeBusinessSchedule(businessSchedule);
  const interval = slotIntervalMinutes || bSched.defaultSlotIntervalMinutes;

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
    const isCancelled = status.includes("cancelad") || status.includes("reprogramad") || status.includes("no_asistio");
    if (isCancelled) return false;
    const aptDate = apt.fecha || (apt.startAt ? apt.startAt.slice(0, 10) : null);
    if (aptDate !== date) return false;

    // Verificar colaboradora
    const aptStaff = String(apt.colaboradorID || apt.collaboratorId || apt.colaboradorNombre || "");
    const targetStaff = String(collaboratorId);
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
  if (referenceTime) {
    const refM = parseTimeToMinutes(referenceTime);
    if (refM !== null) {
      minAllowedStart = Math.max(minAllowedStart, refM + bSched.minimumBookingNoticeMinutes);
    }
  }

  const slots = [];

  // Recorrer el día en incrementos de `interval`
  for (let slotStart = entryMin; slotStart + totalServiceMin <= exitMin; slotStart += interval) {
    if (slotStart < minAllowedStart) continue;

    const slotEnd = slotStart + totalServiceMin;
    const blockedStart = slotStart - bufBefore;
    const blockedEnd = slotEnd + bufAfter;

    // El bloqueo total debe estar dentro del horario de atención
    if (blockedStart < entryMin || blockedEnd > exitMin) continue;

    // Verificar si se solapa con algún intervalo ocupado
    const hasConflict = busyIntervals.some((busy) => intervalsOverlap(blockedStart, blockedEnd, busy.start, busy.end));

    if (!hasConflict) {
      slots.push({
        startAt: `${date}T${formatMinutesToTime(slotStart)}:00`,
        endAt: `${date}T${formatMinutesToTime(slotEnd)}:00`,
        time: formatMinutesToTime(slotStart),
        endTime: formatMinutesToTime(slotEnd),
        collaboratorId,
        serviceDurationMinutes: totalServiceMin,
        bufferBeforeMinutes: bufBefore,
        bufferAfterMinutes: bufAfter,
      });
    }
  }

  return {
    date,
    collaboratorId,
    available: slots.length > 0,
    slots,
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

  return {
    selected: best.collaborator,
    selectedScore: best.score,
    scoreBreakdown: best.scoreData.breakdown,
    availableSlots: best.availableSlots,
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
    policies: {
      cancellation: cancellationPolicy || DEFAULT_BUSINESS_SCHEDULE.cancellationPolicy,
    },
  };
}
