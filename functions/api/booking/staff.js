// Endpoint público/chatbot para consultar la lista de manicuristas activas y sus servicios.
// No expone nómina, salarios, ni información privada.

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

  try {
    const url = new URL(request.url);
    const serviceId = url.searchParams.get("serviceId");

    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/erp_records?table_name=eq.app&record_key=eq.database&select=data`,
      { headers: serviceHeaders(env) }
    );
    if (!response.ok) return json({ error: "No se pudo consultar el catálogo de manicuristas." }, 502);

    const rows = await response.json().catch(() => []);
    const data = rows?.[0]?.data || {};
    const staffList = Array.isArray(data.colaboradores) ? data.colaboradores : [];
    const servicesList = Array.isArray(data.servicios) ? data.servicios : [];

    let targetService = null;
    if (serviceId) {
      targetService = servicesList.find((s) => String(s.servicioID || s.id) === String(serviceId));
    }

    const filtered = staffList
      .filter((s) => {
        const estado = String(s.estado || "Activo").toLowerCase();
        if (estado !== "activo") return false;

        // Filtrar si realiza el servicio especificado
        if (targetService) {
          const eligible = targetService.eligibleCollaboratorIds;
          if (Array.isArray(eligible) && eligible.length > 0) {
            const sId = String(s.colaboradorID || s.id || s.nombreCompleto);
            if (!eligible.includes(sId) && !eligible.includes(s.nombreCompleto)) return false;
          }
        }
        return true;
      })
      .map((s) => ({
        id: String(s.colaboradorID || s.id || s.nombreCompleto),
        displayName: s.nombreCompleto || `${s.nombre || ""} ${s.apellido || ""}`.trim(),
        available: true,
      }));

    return json({
      success: true,
      staff: filtered,
    });
  } catch (error) {
    console.error("booking/staff GET:", error);
    return json({ error: "Error interno al consultar manicuristas." }, 500);
  }
}
