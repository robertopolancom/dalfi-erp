// Endpoint público/chatbot para consultar el catálogo de servicios de manicura/pedicura y sus duraciones.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function serviceHeaders(env) {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
}

export async function onRequestGet({ env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Persistencia no configurada." }, 500);
  }

  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/erp_records?table_name=eq.app&record_key=eq.database&select=data`,
      { headers: serviceHeaders(env) }
    );
    if (!response.ok) return json({ error: "No se pudo consultar el catálogo de servicios." }, 502);

    const rows = await response.json().catch(() => []);
    const doc = rows?.[0]?.data || {};
    const docData = doc.data || doc;
    const servicesList = Array.isArray(docData.servicios) ? docData.servicios : [];

    const activeServices = servicesList
      .filter((s) => String(s.estado || "Activo").toLowerCase() === "activo")
      .map((s) => ({
        id: String(s.servicioID || s.id || s.servicio),
        name: s.servicio || s.name || "Servicio",
        durationMinutes: Number(s.duracionMin || s.durationMinutes || s.duration) || 60,
        price: Number(s.precio || s.price) || 0,
        active: true,
      }));

    return json({
      success: true,
      services: activeServices,
    });
  } catch (error) {
    return json({ error: `Error al consultar servicios: ${error.message}` }, 500);
  }
}
