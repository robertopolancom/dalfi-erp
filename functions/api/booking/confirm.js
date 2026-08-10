// Endpoint seguro server-side para confirmar reservas y evitar doble reserva (HTTP 409 Conflict).

import { insertAuditLog } from "../_lib/audit.js";
import { syncAppointmentToGoogleCalendar } from "../_lib/google-calendar.js";
import {
  calculateAvailableSlots,
  selectBestAvailableCollaborator,
  normalizeBusinessSchedule,
  calculateAppointmentDuration,
  parseTimeToMinutes,
  determineInitialBookingStatus,
  resolveOrCreateClientProfile,
  isCollaboratorEligibleForServiceLines,
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

  const targetResId = payload.reservationId || payload.reservaID;
  if (!targetResId && (!dateStr || !timeStr || !Array.isArray(serviceLines) || serviceLines.length === 0)) {
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

    // 2. Si se proporciona reservationId / reservaID, actualizar el estado de una cita preaprobada existente
    const targetResId = payload.reservationId || payload.reservaID;
    if (targetResId) {
      const existingApt = appointments.find((a) => String(a.reservaID) === String(targetResId));
      if (!existingApt) {
        return json({ success: false, error: `Reserva '${targetResId}' no encontrada.` }, 404);
      }

      // Una cita en estadoConfirmacion "EspacioLiberado" (segundo recordatorio
      // sin confirmar, ver send-reminders.js) libera su horario para que otra
      // reserva lo tome. Si eso ya pasó (esta cita quedó "Reemplazada" —u
      // "Reprogramada", cambio manual de fecha/hora por el staff— o
      // "Cancelada"), confirmarla ahora resucitaría una reserva cuyo horario
      // ya es de otra clienta.
      const alreadyReassignedStatuses = new Set(["reemplazada", "reprogramada", "cancelada"]);
      if (alreadyReassignedStatuses.has(String(existingApt.estado || "").toLowerCase())) {
        return json({
          success: false,
          code: "ALREADY_REASSIGNED",
          error: `La reserva '${targetResId}' ya no está disponible: su horario fue reasignado (estado actual: ${existingApt.estado}).`,
        }, 409);
      }

      const nextEstado = payload.status || "Confirmada";
      let updatedApt = {
        ...existingApt,
        estado: nextEstado,
        observaciones: payload.notes || existingApt.observaciones || "",
        updated_at: new Date().toISOString(),
        // Confirmar la reserva (por respuesta del chatbot o botón del salón)
        // también confirma la asistencia — dimensión independiente de
        // estadoDeposito, que esto NUNCA toca (ver checkPreapprovedConfirmationReminder).
        ...(nextEstado === "Confirmada" ? { estadoConfirmacion: "HoraConfirmada" } : {}),
      };
      let completedClientRecord = null;

      // Un bloqueo creado desde Google solo puede completarse después de
      // validar nuevamente todos los datos contra el catálogo y el motor de
      // disponibilidad. Nunca se confirma por el mero hecho de recibir un
      // reservationId.
      const isGooglePending = Boolean(existingApt.googleCalendarEventId)
        && String(existingApt.estado || "").toLowerCase().includes("pendiente de completar");
      if (isGooglePending) {
        const completionDate = dateStr || existingApt.fecha;
        const completionTime = timeStr || existingApt.hora;
        const completionLines = Array.isArray(serviceLines) ? serviceLines : [];
        const completionClient = client && typeof client === "object" ? client : null;
        if (!completionDate || !completionTime || !completionLines.length || !completionClient) {
          return json({ success: false, code: "PENDING_RESERVATION_INCOMPLETE", error: "Para completar esta reserva se requieren clienta, servicio, fecha y hora." }, 400);
        }
        const services = Array.isArray(docData.servicios) ? docData.servicios : [];
        const staffList = Array.isArray(docData.colaboradores) ? docData.colaboradores : [];
        const weeklySchedules = Array.isArray(docData.staffWeeklySchedules) ? docData.staffWeeklySchedules : [];
        const exceptions = Array.isArray(docData.staffScheduleExceptions) ? docData.staffScheduleExceptions : [];
        const bSched = normalizeBusinessSchedule(docData.businessSchedule);
        const requestedStaffId = collaboratorPreference?.collaboratorId || existingApt.colaboradorID;
        const assigned = staffList.find((person) => String(person.colaboradorID || person.id || person.nombreCompleto) === String(requestedStaffId));
        if (!assigned || !isCollaboratorEligibleForServiceLines(assigned, completionLines, services)) {
          return json({ success: false, code: "SPECIALIST_REQUIRED_OR_NOT_ELIGIBLE", error: "Selecciona una manicurista válida para los servicios solicitados." }, 409);
        }
        const otherAppointments = appointments.filter((appointment) => String(appointment.reservaID) !== String(targetResId));
        const availability = calculateAvailableSlots({
          date: completionDate,
          collaboratorId: String(assigned.colaboradorID || assigned.id),
          serviceLines: completionLines,
          businessSchedule: bSched,
          weeklySchedules,
          exceptions,
          appointments: otherAppointments,
          services,
          now: new Date(),
        });
        if (!availability.available || !availability.slots.some((slot) => slot.time === completionTime)) {
          return json({ success: false, code: "SLOT_NO_LONGER_AVAILABLE", error: "El horario ya no está disponible." }, 409);
        }
        const duration = calculateAppointmentDuration({ serviceLines: completionLines, services });
        const startMinutes = parseTimeToMinutes(completionTime);
        const endMinutes = startMinutes + (duration.totalServiceMinutes || 30);
        const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
        const clientProfile = resolveOrCreateClientProfile({
          clientList: Array.isArray(docData.clientes) ? docData.clientes : [],
          client: completionClient,
          senderPhone: sourceConversationId || payload.senderPhone || null,
          source: source || "chatbot_whatsapp",
        });
        completedClientRecord = clientProfile;
        updatedApt = {
          ...updatedApt,
          fecha: completionDate,
          hora: completionTime,
          horaFin: endTime,
          duracionMin: duration.totalServiceMinutes || 30,
          clienteID: clientProfile.clientId,
          clienteNombre: clientProfile.clientName,
          telefono: clientProfile.clientRecord?.telefono || completionClient.phone || "",
          correo: completionClient.email || "",
          clienteProvisional: false,
          colaboradorID: String(assigned.colaboradorID || assigned.id),
          colaboradorNombre: assigned.nombreCompleto || assigned.nombre,
          servicioID: completionLines[0]?.serviceId || completionLines[0]?.servicioID || "",
          servicio: duration.evaluatedServices.map((line) => line.name).join(" + "),
          servicios: duration.evaluatedServices.map((line) => ({ servicioID: line.id, servicio: line.name, duracionMin: line.durationMinutes })),
          bloqueoGlobal: false,
          estado: payload.status || "Confirmada",
        };
      }

      const updatedReservas = appointments.map((a) =>
        String(a.reservaID) === String(targetResId) ? updatedApt : a
      );

      const nextData = { ...docData, reservas: updatedReservas };
      if (completedClientRecord?.clientRecord) {
        const clients = Array.isArray(docData.clientes) ? docData.clientes : [];
        nextData.clientes = completedClientRecord.isNew
          ? [...clients, completedClientRecord.clientRecord]
          : clients.map((item) => String(item.clienteID || item.id) === String(completedClientRecord.clientId)
            ? completedClientRecord.clientRecord : item);
      }
      const updatedDoc = currentDoc.data
        ? { ...currentDoc, data: nextData }
        : nextData;

      const saveRes = await safeFetch(`${env.SUPABASE_URL}/rest/v1/rpc/save_erp_record_if_current`, {
        method: "POST",
        headers: { ...serviceHeaders(env), "Content-Type": "application/json" },
        body: JSON.stringify({
          p_table_name: "app",
          p_record_key: "database",
          p_expected_updated_at: expectedUpdatedAt,
          p_data: updatedDoc,
        }),
      });

      if (!saveRes.ok) return json({ error: "Fallo al actualizar el estado de la reserva." }, 500);

      const calendarSync = await syncAppointmentToGoogleCalendar(
        env,
        updatedApt,
        {
          services: Array.isArray(docData.servicios) ? docData.servicios : [],
          staff: Array.isArray(docData.colaboradores) ? docData.colaboradores : [],
        },
        { fetchImpl: env.fetch || fetch },
      );

      return json({
        success: true,
        updated: true,
        calendarSync,
        appointment: {
          appointmentId: updatedApt.reservaID,
          confirmationCode: updatedApt.reservaID,
          status: updatedApt.estado,
          startAt: `${updatedApt.fecha}T${updatedApt.hora}:00`,
        },
      });
    }

    // 2b. Verificar idempotencia: si la idempotencyKey ya existe, devolver la cita guardada
    const existingKeyApt = appointments.find((a) => a.idempotencyKey === idempotencyKey);
    if (existingKeyApt) {
      const calendarSync = await syncAppointmentToGoogleCalendar(
        env,
        existingKeyApt,
        {
          services: Array.isArray(docData.servicios) ? docData.servicios : [],
          staff: Array.isArray(docData.colaboradores) ? docData.colaboradores : [],
        },
        { fetchImpl: env.fetch || fetch },
      );
      return json({
        success: true,
        idempotent: true,
        calendarSync,
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
      const requested = staffList.find(
        (s) => String(s.colaboradorID || s.id || s.nombreCompleto) === String(collaboratorPreference.collaboratorId)
      );
      if (requested && !isCollaboratorEligibleForServiceLines(requested, serviceLines, services)) {
        return json(
          {
            success: false,
            code: "SPECIALIST_NOT_ELIGIBLE",
            message: "La colaboradora seleccionada no está capacitada para uno o más de los servicios solicitados.",
          },
          409
        );
      }
      assignedCollaborator = requested;
    }

    if (!assignedCollaborator) {
      // Auto selección — debe estar capacitada para TODOS los servicios pedidos
      const eligibleStaff = staffList.filter(
        (s) =>
          String(s.estado || "Activo").toLowerCase() === "activo" &&
          isCollaboratorEligibleForServiceLines(s, serviceLines, services)
      );
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
        now: new Date(),
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
      now: new Date(),
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
      servicio: durationRes.evaluatedServices.map((s) => s.name).join(" + ") || "Servicio",
      servicios: durationRes.evaluatedServices.map((s) => ({
        servicioID: s.id,
        servicio: s.name,
        duracionMin: s.durationMinutes,
      })),
      canalOrigen: source,
      sourceConversationId: sourceConversationId || null,
      idempotencyKey,
      selectedByClient: collaboratorPreference.mode === "specific",
      assignmentStrategy,
      ...determineInitialBookingStatus({
        source,
        requestedStartAt,
        date: dateStr,
        time: timeStr,
        businessSchedule: bSched,
      }),
      observaciones: notes || clientProfile.note || "",
      // Reservas creadas por el chatbot (sin un miembro del salón presente)
      // quedan marcadas para revisión en el Dashboard.
      needsReview: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Si esta manicurista y horario ya tenían una cita con estadoConfirmacion
    // "EspacioLiberado" (llegó al segundo recordatorio sin confirmarse y
    // liberó el espacio, ver send-reminders.js), esta nueva reserva
    // confirmada la reemplaza: la vieja pasa a estado "Reemplazada" en vez de
    // quedar fantasma bloqueando o compitiendo por el mismo horario. El
    // depósito de la vieja (si lo hubiera) NO se toca aquí — la política es
    // que un reagendamiento nunca cobra depósito nuevo, y esto no es un
    // reagendamiento de esa cliente sino que otra persona tomó el horario.
    const appointmentsWithBump = appointments.map((apt) => {
      if (String(apt.estadoConfirmacion || "").toLowerCase() !== "espacioliberado") return apt;
      if (String(apt.colaboradorID || "") !== String(targetCollaboratorId)) return apt;
      if (apt.fecha !== dateStr || apt.hora !== timeStr) return apt;
      return {
        ...apt,
        estado: "Reemplazada",
        observaciones: "Reemplazada: su horario fue tomado por otra reserva confirmada tras no confirmarse a tiempo.",
        updated_at: new Date().toISOString(),
      };
    });

    // 5. Guardar atómicamente en erp_records usando save_erp_record_if_current
    const updatedDoc = currentDoc.data
      ? { ...currentDoc, data: { ...currentDoc.data, reservas: [...appointmentsWithBump, newAppointment], clientes: updatedClients } }
      : { ...currentDoc, reservas: [...appointmentsWithBump, newAppointment], clientes: updatedClients };

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

    const calendarSync = await syncAppointmentToGoogleCalendar(
      env,
      newAppointment,
      { services, staff: staffList },
      { fetchImpl: env.fetch || fetch },
    );

    return json({
      success: true,
      calendarSync,
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
