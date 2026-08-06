// Endpoint server-side para reprogramar una reserva existente.

import { insertAuditLog } from "../_lib/audit.js";
import {
  calculateAvailableSlots,
  normalizeBusinessSchedule,
  calculateAppointmentDuration,
  parseTimeToMinutes,
} from "../../../outputs/lib/booking-engine.js";

import { validateChatbotSecret } from "./_auth.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function serviceHeaders(env) {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
}

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Persistencia no configurada." }, 500);
  }

  if (!validateChatbotSecret(request, env)) {
    return json({ success: false, error: "No autorizado. Se requiere x-chatbot-secret o Bearer token dedicado del Chatbot Bridge." }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Solicitud JSON inválida." }, 400);
  }

  const {
    appointmentId,
    newStartAt,
    date: newDate,
    time: newTime,
    newCollaboratorId = null,
    reason = "",
  } = payload || {};

  const targetDate = newStartAt ? newStartAt.slice(0, 10) : newDate;
  const targetTime = newStartAt ? newStartAt.slice(11, 16) : newTime;

  if (!appointmentId || !targetDate || !targetTime) {
    return json({ success: false, error: "Parámetros 'appointmentId', 'date' y 'time' requeridos." }, 400);
  }

  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/erp_records?table_name=eq.app&record_key=eq.database&select=data,updated_at`,
      { headers: serviceHeaders(env) }
    );
    if (!response.ok) return json({ error: "No se pudo conectar a la base de datos." }, 502);

    const rows = await response.json().catch(() => []);
    const row = rows?.[0];
    if (!row?.data) return json({ error: "Base de datos no encontrada." }, 404);

    const currentDoc = row.data;
    const expectedUpdatedAt = row.updated_at || null;
    const appointments = Array.isArray(currentDoc.reservas) ? currentDoc.reservas : [];

    const targetIndex = appointments.findIndex((a) => String(a.reservaID || a.id) === String(appointmentId));
    if (targetIndex === -1) {
      return json({ success: false, error: "La reserva no fue encontrada." }, 404);
    }

    const currentApt = appointments[targetIndex];
    const services = Array.isArray(currentDoc.servicios) ? currentDoc.servicios : [];
    const staffList = Array.isArray(currentDoc.colaboradores) ? currentDoc.colaboradores : [];
    const weeklySchedules = Array.isArray(currentDoc.staffWeeklySchedules) ? currentDoc.staffWeeklySchedules : [];
    const exceptions = Array.isArray(currentDoc.staffScheduleExceptions) ? currentDoc.staffScheduleExceptions : [];
    const bSched = normalizeBusinessSchedule(currentDoc.businessSchedule);

    const collabId = newCollaboratorId || currentApt.colaboradorID;
    const staffMember = staffList.find((s) => String(s.colaboradorID || s.id || s.nombreCompleto) === String(collabId));

    // Filtrar citas excluyendo la cita actual que se está reprogramando (para evitar auto-conflicto)
    const otherAppointments = appointments.filter((a) => String(a.reservaID || a.id) !== String(appointmentId));

    const serviceLines = [{ serviceId: currentApt.servicioID, quantity: 1 }];
    const avail = calculateAvailableSlots({
      date: targetDate,
      collaboratorId: collabId,
      serviceLines,
      businessSchedule: bSched,
      weeklySchedules,
      exceptions,
      appointments: otherAppointments,
      services,
    });

    const isSlotFree = avail.available && avail.slots.some((s) => s.time === targetTime);
    if (!isSlotFree) {
      return json(
        {
          success: false,
          code: "SLOT_NO_LONGER_AVAILABLE",
          message: "El nuevo horario solicitado no está disponible para la manicurista.",
          alternatives: avail.slots.slice(0, 3),
        },
        409
      );
    }

    const durationRes = calculateAppointmentDuration({ serviceLines, services });
    const durationMin = durationRes.totalServiceMinutes || currentApt.duracionMin || 30;
    const startMin = parseTimeToMinutes(targetTime) || 540;
    const endMin = startMin + durationMin;
    const endH = String(Math.floor(endMin / 60)).padStart(2, "0");
    const endM = String(endMin % 60).padStart(2, "0");
    const endTimeStr = `${endH}:${endM}`;

    const updatedApt = {
      ...currentApt,
      fecha: targetDate,
      hora: targetTime,
      horaFin: endTimeStr,
      duracionMin: durationMin,
      colaboradorID: collabId,
      colaboradorNombre: staffMember?.nombreCompleto || currentApt.colaboradorNombre,
      estado: "Reprogramada",
      observaciones: reason ? `Reprogramada: ${reason}. ${currentApt.observaciones || ""}`.trim() : currentApt.observaciones,
      updated_at: new Date().toISOString(),
    };

    const newAppointments = [...appointments];
    newAppointments[targetIndex] = updatedApt;

    const updatedDoc = {
      ...currentDoc,
      data: {
        ...currentDoc.data,
        reservas: newAppointments,
      },
    };

    const saveResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/save_erp_record_if_current`, {
      method: "POST",
      headers: { ...serviceHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({
        p_table_name: "app",
        p_record_key: "database",
        p_data: updatedDoc,
        p_expected_updated_at: expectedUpdatedAt,
      }),
    });

    if (!saveResponse.ok) return json({ error: "No se pudo reprogramar la reserva." }, 502);

    await insertAuditLog(env, {
      tableName: "erp_records",
      entityId: "app/database",
      action: "appointment_rescheduled",
      oldData: { fecha: currentApt.fecha, hora: currentApt.hora },
      newData: { fecha: targetDate, hora: targetTime, colaboradorID: collabId, reason },
      userId: "booking_api",
      userEmail: "system@seben",
      userRole: "system",
      success: true,
      note: "Reserva reprogramada exitosamente.",
    });

    return json({
      success: true,
      message: "Reserva reprogramada con éxito.",
      appointment: {
        appointmentId,
        startAt: `${targetDate}T${targetTime}:00`,
        endAt: `${targetDate}T${endTimeStr}:00`,
        collaboratorId: collabId,
        collaboratorName: updatedApt.colaboradorNombre,
        status: "Reprogramada",
      },
    });
  } catch (error) {
    console.error("booking/reschedule POST:", error);
    return json({ error: "Error interno al reprogramar la reserva." }, 500);
  }
}
