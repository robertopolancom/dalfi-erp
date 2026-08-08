// Endpoint público/chatbot para consultar horarios de disponibilidad reales.

import {
  calculateAvailableSlots,
  selectBestAvailableCollaborator,
  buildAvailabilityResponseForChatbot,
  normalizeBusinessSchedule,
  calculateAppointmentDuration,
  isCollaboratorEligibleForServiceLines,
} from "../../../outputs/lib/booking-engine.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function serviceHeaders(env) {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
}

export async function onRequestGet({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Persistencia no configurada." }, 500);
  }

  const safeFetch = env.fetch || fetch;

  try {
    const url = new URL(request.url);
    // Soporta un solo servicio (?serviceId=X) o varios para bloque continuo
    // (?serviceId=X&serviceId=Y o ?serviceId=X,Y).
    const rawServiceIds = url.searchParams.getAll("serviceId");
    const serviceIds = rawServiceIds
      .flatMap((v) => v.split(","))
      .map((v) => v.trim())
      .filter(Boolean);
    const serviceId = serviceIds[0] || null; // primer servicio, usado para nombre/duración de referencia
    const date = url.searchParams.get("date"); // YYYY-MM-DD
    const collaboratorId = url.searchParams.get("collaboratorId"); // opcional

    if (serviceIds.length === 0 || !date) {
      return json({ success: false, error: "Parámetros 'serviceId' y 'date' son requeridos." }, 400);
    }

    const response = await safeFetch(
      `${env.SUPABASE_URL}/rest/v1/erp_records?table_name=eq.app&record_key=eq.database&select=data`,
      { headers: serviceHeaders(env) }
    );
    if (!response.ok) return json({ error: "No se pudo consultar la disponibilidad." }, 502);

    const rows = await response.json().catch(() => []);
    const currentDoc = rows?.[0]?.data || {};
    const docData = currentDoc.data || currentDoc;

    const services = Array.isArray(docData.servicios) ? docData.servicios : [];
    const staffList = Array.isArray(docData.colaboradores) ? docData.colaboradores : [];
    const appointments = Array.isArray(docData.reservas) ? docData.reservas : [];
    const weeklySchedules = Array.isArray(docData.staffWeeklySchedules) ? docData.staffWeeklySchedules : [];
    const exceptions = Array.isArray(docData.staffScheduleExceptions) ? docData.staffScheduleExceptions : [];
    const bSched = normalizeBusinessSchedule(docData.businessSchedule);

    const targetService = services.find(
      (s) => String(s.servicioID || s.id || s.servicio).toLowerCase() === String(serviceId).toLowerCase()
    );
    if (!targetService) {
      return json(
        buildAvailabilityResponseForChatbot({
          success: false,
          errorCode: "SERVICE_NOT_FOUND",
          errorMessage: "El servicio solicitado no existe en el catálogo.",
        }),
        404
      );
    }

    const serviceLines = serviceIds.map((id) => ({ serviceId: id, quantity: 1 }));
    const durationRes = calculateAppointmentDuration({ serviceLines, services });
    if (!durationRes.isValid) {
      return json(
        buildAvailabilityResponseForChatbot({
          success: false,
          errorCode: "SERVICE_NOT_FOUND",
          errorMessage:
            durationRes.warnings[0] || "Uno o más de los servicios solicitados no existen en el catálogo.",
        }),
        404
      );
    }
    const combinedServiceName = durationRes.evaluatedServices.map((s) => s.name).join(" + ");
    const combinedDurationMinutes = durationRes.totalServiceMinutes;

    if (collaboratorId) {
      // 1. Manicurista específica elegida por la clienta
      const staffMember = staffList.find(
        (s) => String(s.colaboradorID || s.id || s.nombreCompleto) === String(collaboratorId)
      );

      if (!staffMember || !isCollaboratorEligibleForServiceLines(staffMember, serviceLines, services)) {
        return json(
          buildAvailabilityResponseForChatbot({
            success: false,
            date,
            serviceId,
            errorCode: "SPECIALIST_NOT_ELIGIBLE",
            errorMessage: "La colaboradora seleccionada no está capacitada para uno o más de los servicios solicitados.",
          }),
          409
        );
      }

      const avail = calculateAvailableSlots({
        date,
        collaboratorId,
        serviceLines,
        businessSchedule: bSched,
        weeklySchedules,
        exceptions,
        appointments,
        services,
        now: new Date(),
      });

      return json(
        buildAvailabilityResponseForChatbot({
          success: avail.available,
          date,
          serviceId,
          serviceName: combinedServiceName || targetService.servicio || targetService.name,
          durationMinutes: combinedDurationMinutes || targetService.duracionMin || targetService.durationMinutes || 30,
          collaboratorId,
          collaboratorName: staffMember?.nombreCompleto || staffMember?.nombre || collaboratorId,
          slots: avail.slots,
          cancellationPolicy: bSched.cancellationPolicy,
          errorMessage: avail.reason,
        })
      );
    } else {
      // 2. Asignación automática sin preferencia — debe estar capacitada para TODOS los servicios pedidos
      const eligibleStaff = staffList.filter((s) => {
        const estado = String(s.estado || "Activo").toLowerCase();
        if (estado !== "activo") return false;
        return isCollaboratorEligibleForServiceLines(s, serviceLines, services);
      });

      const bestSelection = selectBestAvailableCollaborator({
        eligibleCollaborators: eligibleStaff,
        date,
        serviceLines,
        services,
        businessSchedule: bSched,
        weeklySchedules,
        exceptions,
        appointments,
        now: new Date(),
      });

      if (!bestSelection.selected) {
        return json(
          buildAvailabilityResponseForChatbot({
            success: false,
            date,
            serviceId,
            serviceName: combinedServiceName || targetService.servicio || targetService.name,
            durationMinutes: combinedDurationMinutes || targetService.duracionMin || targetService.durationMinutes || 30,
            errorMessage: bestSelection.reason,
          })
        );
      }

      return json(
        buildAvailabilityResponseForChatbot({
          success: true,
          date,
          serviceId,
          serviceName: combinedServiceName || targetService.servicio || targetService.name,
          durationMinutes: combinedDurationMinutes || targetService.duracionMin || targetService.durationMinutes || 30,
          collaboratorId: bestSelection.selected.colaboradorID || bestSelection.selected.id,
          collaboratorName: bestSelection.selected.nombreCompleto,
          slots: bestSelection.availableSlots,
          cancellationPolicy: bSched.cancellationPolicy,
        })
      );
    }
  } catch (error) {
    console.error("booking/availability GET error:", error);
    return json({ error: "Error al calcular disponibilidad.", detail: String(error?.message || error) }, 500);
  }
}
