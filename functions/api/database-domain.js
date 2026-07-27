import { resolveErpIdentity } from "./_lib/authz.js";
import { extractDomainSlice } from "./_lib/domain-slices.js";

const TABLE_NAME = "app";
const RECORD_KEY = "database";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function identityError(identity) {
  if (identity.error === "unauthenticated") return json({ error: "Sesion requerida." }, 401);
  if (identity.error === "inactive") return json({ error: "Tu usuario esta inactivo." }, 403);
  return json({ error: "Tu usuario no esta autorizado." }, 403);
}

function serviceHeaders(env) {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
}

export async function onRequestGet({ request, env }) {
  const identity = await resolveErpIdentity(request, env);
  if (identity.error) return identityError(identity);
  const domain = new URL(request.url).searchParams.get("domain") || "";
  // Primer corte de la migracion: solo inventario. No exponer aun servicios,
  // facturacion ni otros dominios hasta completar sus contratos propios.
  if (domain !== "inventario") return json({ error: "Dominio no disponible." }, 400);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "Persistencia no configurada." }, 500);
  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/erp_records?table_name=eq.${TABLE_NAME}&record_key=eq.${RECORD_KEY}&select=data,updated_at`,
      { headers: serviceHeaders(env) },
    );
    if (!response.ok) return json({ error: "No se pudo leer el dominio." }, 502);
    const rows = await response.json().catch(() => []);
    const row = rows?.[0];
    if (!row?.data) return json({ error: "Base de datos no encontrada." }, 404);
    const slice = extractDomainSlice(row.data, domain);
    return json({ domain, data: slice.data, updatedAt: row.updated_at || null, source: "erp_records" });
  } catch (error) {
    console.error("database-domain GET:", error);
    return json({ error: "No se pudo leer el dominio." }, 500);
  }
}

export async function onRequest() {
  return json({ error: "Metodo no permitido." }, 405);
}
