// Endpoint server-side para sincronización de clientes y sublíneas de contacto entre ERP y Chatbot.

import { validateChatbotSecret } from "./_auth.js";
import { resolveOrCreateClientProfile } from "../../../outputs/lib/booking-engine.js";

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

  if (!validateChatbotSecret(request, env)) {
    return json({ success: false, error: "No autorizado. Se requiere x-chatbot-secret o Bearer token dedicado del Chatbot Bridge." }, 401);
  }

  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/erp_records?table_name=eq.app&record_key=eq.database&select=data`,
      { headers: serviceHeaders(env) }
    );
    if (!response.ok) return json({ error: "No se pudo conectar a la base de datos." }, 502);

    const rows = await response.json().catch(() => []);
    const doc = rows?.[0]?.data || {};
    const docData = doc.data || doc;
    const clientList = Array.isArray(docData.clientes) ? docData.clientes : [];

    const activeClients = clientList
      .filter((c) => String(c.estado || "Activo").toLowerCase() === "activo")
      .map((c) => ({
        clientId: String(c.clienteID || c.id),
        name: c.nombreCompleto || c.nombre || "Cliente",
        phone: c.telefono || "",
        email: c.correo || "",
        linkedContactLines: Array.isArray(c.lineasContactoVinculadas) ? c.lineasContactoVinculadas : [],
      }));

    return json({
      success: true,
      totalClients: activeClients.length,
      clients: activeClients,
    });
  } catch (error) {
    return json({ error: `Error consultando clientes: ${error.message}` }, 500);
  }
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

  const { client, senderPhone = null, source = "chatbot_whatsapp" } = payload || {};
  if (!client || (!client.phone && !client.telefono && !senderPhone)) {
    return json({ success: false, error: "Se requiere información del cliente y número de teléfono." }, 400);
  }

  try {
    const fetchResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/erp_records?table_name=eq.app&record_key=eq.database&select=data,updated_at`,
      { headers: serviceHeaders(env) }
    );
    if (!fetchResponse.ok) return json({ error: "No se pudo conectar a la base de datos." }, 502);

    const rows = await fetchResponse.json().catch(() => []);
    const row = rows?.[0];
    if (!row?.data) return json({ error: "Base de datos no encontrada." }, 404);

    const currentDoc = row.data || {};
    const expectedUpdatedAt = row.updated_at || null;
    const docData = currentDoc.data || currentDoc;
    const clientList = Array.isArray(docData.clientes) ? docData.clientes : [];

    const profileRes = resolveOrCreateClientProfile({
      clientList,
      client,
      senderPhone,
      source,
    });

    let updatedClients = clientList;
    if (profileRes.isNew) {
      updatedClients = [...clientList, profileRes.clientRecord];
    } else {
      updatedClients = clientList.map((c) =>
        String(c.clienteID || c.id) === profileRes.clientId ? profileRes.clientRecord : c
      );
    }

    const updatedDoc = currentDoc.data
      ? { ...currentDoc, data: { ...currentDoc.data, clientes: updatedClients } }
      : { ...currentDoc, clientes: updatedClients };

    const saveResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/save_erp_record_if_current`, {
      method: "POST",
      headers: { ...serviceHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({
        p_table_name: "app",
        p_record_key: "database",
        p_expected_updated_at: expectedUpdatedAt,
        p_data: updatedDoc,
      }),
    });

    if (!saveResponse.ok) return json({ error: "Fallo al guardar cliente en el servidor." }, 500);

    return json({
      success: true,
      isNew: profileRes.isNew,
      client: {
        clientId: profileRes.clientId,
        name: profileRes.clientName,
        phone: profileRes.phone,
        linkedContactLines: profileRes.clientRecord.lineasContactoVinculadas || [],
      },
      note: profileRes.note,
    });
  } catch (error) {
    return json({ error: `Error procesando cliente: ${error.message}` }, 500);
  }
}
