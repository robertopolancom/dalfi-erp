// Endpoint server-side para cancelar una reserva.

import { insertAuditLog } from "../_lib/audit.js";

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

  const { appointmentId, reason = "", idempotencyKey = null } = payload || {};

  if (!appointmentId) {
    return json({ success: false, error: "Se requiere 'appointmentId'." }, 400);
  }

  const safeFetch = env.fetch || fetch;

  try {
    const response = await safeFetch(
      `${env.SUPABASE_URL}/rest/v1/erp_records?table_name=eq.app&record_key=eq.database&select=data,updated_at`,
      { headers: serviceHeaders(env) }
    );
    if (!response.ok) return json({ error: "No se pudo conectar a la base de datos." }, 502);

    const rows = await response.json().catch(() => []);
    const row = rows?.[0];
    if (!row?.data) return json({ error: "Base de datos no encontrada." }, 404);

    const currentDoc = row.data;
    const expectedUpdatedAt = row.updated_at || null;
    const docData = currentDoc.data || currentDoc;
    const appointments = Array.isArray(docData.reservas) ? docData.reservas : [];

    const targetIndex = appointments.findIndex((a) => String(a.reservaID || a.id) === String(appointmentId));
    if (targetIndex === -1) {
      return json({ success: false, error: "La reserva especificada no fue encontrada." }, 404);
    }

    const targetApt = appointments[targetIndex];
    if (targetApt.estado === "Cancelada") {
      return json({ success: true, message: "La reserva ya se encontraba cancelada.", appointment: targetApt });
    }

    const updatedApt = {
      ...targetApt,
      estado: "Cancelada",
      cancellationReason: reason,
      cancelledAt: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const newAppointments = [...appointments];
    newAppointments[targetIndex] = updatedApt;

    const updatedDoc = currentDoc.data
      ? { ...currentDoc, data: { ...currentDoc.data, reservas: newAppointments } }
      : { ...currentDoc, reservas: newAppointments };

    const saveResponse = await safeFetch(`${env.SUPABASE_URL}/rest/v1/rpc/save_erp_record_if_current`, {
      method: "POST",
      headers: { ...serviceHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({
        p_table_name: "app",
        p_record_key: "database",
        p_data: updatedDoc,
        p_expected_updated_at: expectedUpdatedAt,
      }),
    });

    if (!saveResponse.ok) return json({ error: "No se pudo cancelar la reserva." }, 502);

    await insertAuditLog(env, {
      tableName: "erp_records",
      entityId: "app/database",
      action: "appointment_cancelled",
      oldData: { reservaID: appointmentId, status: targetApt.estado },
      newData: { reservaID: appointmentId, status: "Cancelada", reason },
      userId: "booking_api",
      userEmail: "system@seben",
      userRole: "system",
      success: true,
      note: "Reserva cancelada exitosamente.",
    });

    return json({
      success: true,
      message: "Reserva cancelada con éxito. El horario ha sido liberado.",
      appointmentId,
      status: "Cancelada",
    });
  } catch (error) {
    console.error("booking/cancel POST:", error);
    return json({ error: "Error interno al cancelar la reserva." }, 500);
  }
}
