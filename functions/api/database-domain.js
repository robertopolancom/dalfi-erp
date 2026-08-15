import { insertAuditLog } from "./_lib/audit.js";
import { resolveErpIdentity } from "./_lib/authz.js";
import { authorizeDatabaseChanges, detectDatabaseChanges } from "./_lib/database-authz.js";
import { extractDomainSlice, mergeDomainSlice } from "./_lib/domain-slices.js";

const TABLE_NAME = "app";
const RECORD_KEY = "database";
const MAX_DRY_RUN_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DOMAIN_WRITE_BODY_BYTES = 2 * 1024 * 1024;

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

function isValidInventorySlice(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  for (const table of ["inventario", "inventarioMovimientos"]) {
    if (Object.prototype.hasOwnProperty.call(data, table) && !Array.isArray(data[table])) return false;
  }
  return true;
}

function hasValidExpectedUpdatedAt(payload) {
  return payload?.expectedUpdatedAt === undefined || payload?.expectedUpdatedAt === null || typeof payload.expectedUpdatedAt === "string";
}

// Dominios habilitados solo para lectura (GET). Los mismos permisos que ya
// aplica resolveErpIdentity/authorizeDatabaseChanges deciden que puede
// escribir cada usuario; leer un dominio no requiere permiso adicional al
// de tener sesion activa, igual que "inventario". "reservas" se agrego para
// que apps externas autenticadas (ej. seben-reservas) puedan mostrar la
// agenda por manicurista/admin sin exponer el documento monolitico.
// Los demas dominios (facturacion, nomina, cuentas, configuracion) siguen
// sin contrato propio: no exponerlos aun.
const READABLE_DOMAINS = new Set(["inventario", "reservas"]);

export async function onRequestGet({ request, env }) {
  const identity = await resolveErpIdentity(request, env);
  if (identity.error) return identityError(identity);
  const domain = new URL(request.url).searchParams.get("domain") || "";
  if (!READABLE_DOMAINS.has(domain)) return json({ error: "Dominio no disponible." }, 400);
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

// Simula una mutacion de un dominio sin escribir ni generar auditoria. Este
// contrato permite validar permisos y diferencias antes de separar la
// persistencia real por tablas propias.
export async function onRequestPost({ request, env }) {
  const identity = await resolveErpIdentity(request, env);
  if (identity.error) return identityError(identity);
  const url = new URL(request.url);
  if (url.searchParams.get("dryRun") !== "1") return json({ error: "Solo se admite dryRun=1." }, 400);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "Persistencia no configurada." }, 500);
  const contentLength = Number(request.headers.get("content-length")) || 0;
  if (contentLength > MAX_DRY_RUN_BODY_BYTES) return json({ error: "Solicitud demasiado grande." }, 413);
  let payload;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_DRY_RUN_BODY_BYTES) {
      return json({ error: "Solicitud demasiado grande." }, 413);
    }
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Solicitud invalida." }, 400);
  }
  if (payload?.domain !== "inventario" || !isValidInventorySlice(payload.data)) {
    return json({ error: "Slice de inventario invalido." }, 400);
  }
  if (!hasValidExpectedUpdatedAt(payload)) return json({ error: "Version esperada invalida." }, 400);
  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/erp_records?table_name=eq.${TABLE_NAME}&record_key=eq.${RECORD_KEY}&select=data,updated_at`,
      { headers: serviceHeaders(env) },
    );
    if (!response.ok) return json({ error: "No se pudo leer el documento." }, 502);
    const rows = await response.json().catch(() => []);
    const row = rows?.[0];
    if (!row?.data) return json({ error: "Base de datos no encontrada." }, 404);
    if (payload.expectedUpdatedAt !== undefined && (payload.expectedUpdatedAt || null) !== (row.updated_at || null)) {
      return json({ conflict: true, error: "Otra sesion guardo primero.", updatedAt: row.updated_at || null }, 409);
    }
    const merged = mergeDomainSlice(row.data, payload.domain, payload.data).document;
    const changes = detectDatabaseChanges(row.data, merged);
    const authorization = authorizeDatabaseChanges(identity, changes);
    return json({
      dryRun: true,
      allowed: authorization.allowed,
      reason: authorization.reason || null,
      permissions: authorization.permissions || [],
      changes: { domains: changes.domains, tables: changes.changedTables },
      updatedAt: row.updated_at || null,
    });
  } catch (error) {
    console.error("database-domain POST dry-run:", error);
    return json({ error: "No se pudo simular el cambio." }, 500);
  }
}

// Escritura opt-in por dominio. No se utiliza todavía por la SPA: permite
// validar el contrato aislado antes de migrar el guardado principal.
export async function onRequestPut({ request, env }) {
  const identity = await resolveErpIdentity(request, env);
  if (identity.error) return identityError(identity);
  const url = new URL(request.url);
  if (url.searchParams.get("commit") !== "1") return json({ error: "Solo se admite commit=1." }, 400);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "Persistencia no configurada." }, 500);
  const contentLength = Number(request.headers.get("content-length")) || 0;
  if (contentLength > MAX_DOMAIN_WRITE_BODY_BYTES) return json({ error: "Solicitud demasiado grande." }, 413);
  let payload;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_DOMAIN_WRITE_BODY_BYTES) return json({ error: "Solicitud demasiado grande." }, 413);
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Solicitud invalida." }, 400);
  }
  if (payload?.domain !== "inventario" || !isValidInventorySlice(payload.data)) {
    return json({ error: "Slice de inventario invalido." }, 400);
  }
  if (!hasValidExpectedUpdatedAt(payload)) return json({ error: "Version esperada invalida." }, 400);
  try {
    const currentResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/erp_records?table_name=eq.${TABLE_NAME}&record_key=eq.${RECORD_KEY}&select=data,updated_at`,
      { headers: serviceHeaders(env) },
    );
    if (!currentResponse.ok) return json({ error: "No se pudo leer el documento." }, 502);
    const rows = await currentResponse.json().catch(() => []);
    const row = rows?.[0];
    if (!row?.data) return json({ error: "Base de datos no encontrada." }, 404);
    if ((payload.expectedUpdatedAt || null) !== (row.updated_at || null)) {
      return json({ conflict: true, error: "Otra sesion guardo primero.", updatedAt: row.updated_at || null }, 409);
    }
    const merged = mergeDomainSlice(row.data, payload.domain, payload.data).document;
    const changes = detectDatabaseChanges(row.data, merged);
    const authorization = authorizeDatabaseChanges(identity, changes);
    if (!authorization.allowed) return json({ error: "Tu usuario no esta autorizado para modificar inventario." }, 403);
    if (authorization.noChanges) return json({ saved: true, noChanges: true, updatedAt: row.updated_at || null });
    const saveResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/save_erp_record_if_current`, {
      method: "POST",
      headers: { ...serviceHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({
        p_table_name: TABLE_NAME,
        p_record_key: RECORD_KEY,
        p_data: merged,
        p_expected_updated_at: payload.expectedUpdatedAt || null,
      }),
    });
    if (!saveResponse.ok) return json({ error: "No se pudo guardar el dominio." }, 502);
    const resultRows = await saveResponse.json().catch(() => []);
    const result = Array.isArray(resultRows) ? resultRows[0] : resultRows;
    if (!result?.saved) return json({ conflict: true, error: "Otra sesion guardo primero.", updatedAt: result?.new_updated_at || null }, 409);
    const audit = await insertAuditLog(env, {
      tableName: "erp_records",
      entityId: `${TABLE_NAME}/${RECORD_KEY}`,
      action: "database_domain_save",
      oldData: null,
      newData: { domain: payload.domain, domains: changes.domains, tables: changes.changedTables },
      userId: identity.userId,
      userEmail: identity.email,
      userRole: identity.role,
      success: true,
      note: "Guardado de dominio autorizado por la capa server-side.",
    });
    if (!audit.ok) console.error("database-domain PUT: guardado completado pero fallo auditoria", audit.error);
    return json({ saved: true, updatedAt: result.new_updated_at || null, changes: { domains: changes.domains, tables: changes.changedTables } });
  } catch (error) {
    console.error("database-domain PUT:", error);
    return json({ error: "No se pudo guardar el dominio." }, 500);
  }
}

export async function onRequest() {
  return json({ error: "Metodo no permitido." }, 405);
}
