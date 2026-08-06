// Endpoint seguro server-side para confirmar reservas y evitar doble reserva (HTTP 409 Conflict).

import { insertAuditLog } from "../_lib/audit.js";
import {
  calculateAvailableSlots,
  selectBestAvailableCollaborator,
  normalizeBusinessSchedule,
  calculateAppointmentDuration,
  parseTimeToMinutes,
  determineInitialBookingStatus,
  resolveOrCreateClientProfile,
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

  const safeFetch = env.fetch || fetch;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Solicitud JSON inválida." }, 400);
  }

  const {
    idempotencyKey,
    client,
    serviceLines = [],
    requestedStartAt, // e.g. "2026-08-03T09:00:00"
    date: payloadDate,
    time: payloadTime,
    collaboratorPreference = {},
    source = "chatbot_whatsapp",
    sourceConversationId = null,
    notes = "",
  } = payload || {};

  if (!idempotencyKey) {
    return json({ success: false, error: "Se requiere idempotencyKey." }, 400);
  }

  const dateStr = requestedStartAt ? requestedStartAt.slice(0, 10) : payloadDate;
  const timeStr = requestedStartAt ? requestedStartAt.slice(11, 16) : payloadTime;

  if (!dateStr || !timeStr || !Array.isArray(serviceLines) || serviceLines.length === 0) {
    return json({ success: false, error: "Datos de cita incompletos (fecha, hora y servicio requeridos)." }, 400);
  }

  try {
    // 1. Leer estado actual de erp_records con optimistic lock info
    const response = await safeFetch(
      `${env.SUPABASE_URL}/rest/v1/erp_records?table_name=eq.app&record_key=eq.database&select=data,updated_at`,
      { headers: serviceHeaders(env) }
    );
    if (!response.ok) return json({ error: "No se pudo conectar a la base de datos." }, 502);

    const rows = await response.json().catch(() => []);
    const row = rows?.[0];
    if (!row?.data) return json({ error: "Base de datos no encontrada." }, 404);

    const currentDoc = row.data || {};
    const expectedUpdatedAt = row.updated_at || null;
    const docData = currentDoc.data || currentDoc;
    const appointments = Array.isArray(docData.reservas) ? docData.reservas : [];

    // 2. Verificar idempotencia: si la idempotencyKey ya existe, devolver la cita guardada
    const existingKeyApt = appointments.find((a) => a.idempotencyKey === idempotencyKey);
    if (existingKeyApt) {
      return json({
        success: true,
        idempotent: true,
        appointment: {
          appointmentId: existingKeyApt.reservaID,
          confirmationCode: existingKeyApt.reservaID,
          startAt: `${existingKeyApt.fecha}T${existingKeyApt.hora}:00`,
          endAt: `${existingKeyApt.fecha}T${existingKeyApt.horaFin || existingKeyApt.hora}:00`,
          collaboratorId: existingKeyApt.colaboradorID,
          collaboratorName: existingKeyApt.colaboradorNombre,
          status: existingKeyApt.estado || "Confirmada",
        },
      });
    }

    const services = Array.isArray(docData.servicios) ? docData.servicios : [];
    const staffList = Array.isArray(docData.colaboradores) ? docData.colaboradores : [];
    const weeklySchedules = Array.isArray(docData.staffWeeklySchedules) ? docData.staffWeeklySchedules : [];
    const exceptions = Array.isArray(docData.staffScheduleExceptions) ? docData.staffScheduleExceptions : [];
    const bSched = normalizeBusinessSchedule(docData.businessSchedule);

    // Resolver colaboradora
    let assignedCollaborator = null;
    let assignmentStrategy = "specific";

    if (collaboratorPreference.mode === "specific" && collaboratorPreference.collaboratorId) {
      assignedCollaborator = staffList.find(
        (s) => String(s.colaboradorID || s.id || s.nombreCompleto) === String(collaboratorPreference.collaboratorId)
      );
    }

    if (!assignedCollaborator) {
      // Auto selección
      const eligibleStaff = staffList.filter((s) => String(s.estado || "Activo").toLowerCase() === "activo");
      const best = selectBestAvailableCollaborator({
        eligibleCollaborators: eligibleStaff,
        date: dateStr,
        serviceLines,
        services,
        businessSchedule: bSched,
        weeklySchedules,
        exceptions,
        appointments,
        requestedTime: timeStr,
      });

      if (!best.selected) {
        return json(
          {
            success: false,
            code: "NO_STAFF_AVAILABLE",
            message: "No hay manicurista disponible para el horario seleccionado.",
          },
          409
        );
      }

      assignedCollaborator = best.selected;
      assignmentStrategy = "automatic";
    }

    const targetCollaboratorId = String(assignedCollaborator.colaboradorID || assignedCollaborator.id);

    // 3. Validar disponibilidad real en servidor (Prevención de Doble Reserva)
    const avail = calculateAvailableSlots({
      date: dateStr,
      collaboratorId: targetCollaboratorId,
      serviceLines,
      businessSchedule: bSched,
      weeklySchedules,
      exceptions,
      appointments,
      services,
    });

    const isSlotFree = avail.available && avail.slots.some((s) => s.time === timeStr);

    if (!isSlotFree) {
      // Registrar intento fallido por conflicto
      await insertAuditLog(env, {
        tableName: "erp_records",
        entityId: "app/database",
        action: "booking_conflict_detected",
        oldData: null,
        newData: { date: dateStr, time: timeStr, collaboratorId: targetCollaboratorId, idempotencyKey },
        userId: "chatbot_system",
        userEmail: "system@chatbot",
        userRole: "system",
        success: false,
        note: "Conflicto de disponibilidad detectado al intentar confirmar cita.",
      });

      return json(
        {
          success: false,
          code: "SLOT_NO_LONGER_AVAILABLE",
          message: "El horario seleccionado ya no está disponible.",
          alternatives: avail.slots.slice(0, 3),
        },
        409
      );
    }

    // 4. Resolver o crear perfil de cliente en ERP con subcapa de líneas vinculadas
    const clientList = Array.isArray(docData.clientes) ? docData.clientes : [];
    const clientProfile = resolveOrCreateClientProfile({
      clientList,
      client,
      senderPhone: sourceConversationId || payload.senderPhone || null,
      source,
    });

    let updatedClients = clientList;
    if (clientProfile.isNew) {
      updatedClients = [...clientList, clientProfile.clientRecord];
    } else {
      updatedClients = clientList.map((c) =>
        String(c.clienteID || c.id) === clientProfile.clientId ? clientProfile.clientRecord : c
      );
    }

    const durationRes = calculateAppointmentDuration({ serviceLines, services });
    const durationMin = durationRes.totalServiceMinutes || 30;
    const startMin = parseTimeToMinutes(timeStr) || 540;
    const endMin = startMin + durationMin;
    const endH = String(Math.floor(endMin / 60)).padStart(2, "0");
    const endM = String(endMin % 60).padStart(2, "0");
    const endTimeStr = `${endH}:${endM}`;

    const newReservaID = `RES-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const newAppointment = {
      reservaID: newReservaID,
      fecha: dateStr,
      hora: timeStr,
      horaFin: endTimeStr,
      duracionMin: durationMin,
      clienteID: clientProfile.clientId,
      clienteNombre: clientProfile.clientName,
      telefono: clientProfile.phone,
      correo: client?.email || "",
      clienteProvisional: false,
      colaboradorID: targetCollaboratorId,
      colaboradorNombre: assignedCollaborator.nombreCompleto || assignedCollaborator.nombre,
      servicioID: serviceLines[0]?.serviceId || "SRV-GENERIC",
      servicio: durationRes.evaluatedServices[0]?.name || "Servicio",
      canalOrigen: source,
      sourceConversationId: sourceConversationId || null,
      idempotencyKey,
      selectedByClient: collaboratorPreference.mode === "specific",
      assignmentStrategy,
      estado: determineInitialBookingStatus({
        source,
        requestedStartAt,
        date: dateStr,
        time: timeStr,
      }),
      observaciones: notes || clientProfile.note || "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // 5. Guardar atómicamente en erp_records usando save_erp_record_if_current
    const updatedDoc = currentDoc.data
      ? { ...currentDoc, data: { ...currentDoc.data, reservas: [...appointments, newAppointment], clientes: updatedClients } }
      : { ...currentDoc, reservas: [...appointments, newAppointment], clientes: updatedClients };

    const saveResponse = await safeFetch(`${env.SUPABASE_URL}/rest/v1/rpc/save_erp_record_if_current`, {
      method: "POST",
      headers: {
        ...serviceHeaders(env),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_table_name: "app",
        p_record_key: "database",
        p_data: updatedDoc,
        p_expected_updated_at: expectedUpdatedAt,
      }),
    });

    if (!saveResponse.ok) {
      return json({ error: "No se pudo guardar la reserva en la base de datos." }, 502);
    }

    const saveResultRows = await saveResponse.json().catch(() => []);
    const saveResult = Array.isArray(saveResultRows) ? saveResultRows[0] : saveResultRows;

    if (!saveResult?.saved) {
      return json(
        {
          success: false,
          code: "CONCURRENCY_CONFLICT",
          message: "Otra sesión actualizó la base de datos simultáneamente. Por favor reintente.",
        },
        409
      );
    }

    // Auditoría
    await insertAuditLog(env, {
      tableName: "erp_records",
      entityId: "app/database",
      action: "appointment_confirmed",
      oldData: null,
      newData: { reservaID: newReservaID, idempotencyKey, fecha: dateStr, hora: timeStr, colaboradorID: targetCollaboratorId },
      userId: "booking_api",
      userEmail: "system@seben",
      userRole: "system",
      success: true,
      note: "Reserva confirmada con éxito por la API de reservas.",
    });

    return json({
      success: true,
      appointment: {
        appointmentId: newReservaID,
        confirmationCode: newReservaID,
        startAt: `${dateStr}T${timeStr}:00`,
        endAt: `${dateStr}T${endTimeStr}:00`,
        collaboratorId: targetCollaboratorId,
        collaboratorName: assignedCollaborator.nombreCompleto || assignedCollaborator.nombre,
        status: "Confirmada",
      },
    });
  } catch (error) {
    console.error("booking/confirm POST:", error);
    return json({ error: "Error al procesar la confirmación de reserva." }, 500);
  }
}
