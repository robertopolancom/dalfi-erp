import { insertAuditLog } from "./_lib/audit.js";
import { resolveErpIdentity } from "./_lib/authz.js";
import { authorizeDatabaseChanges, detectDatabaseChanges } from "./_lib/database-authz.js";

const TABLE_NAME = "app";
const RECORD_KEY = "database";
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

function identityError(identity) {
  if (identity.error === "unauthenticated") return json({ error: "Sesion requerida." }, 401);
  if (identity.error === "inactive") return json({ error: "Tu usuario esta inactivo." }, 403);
  return json({ error: "Tu usuario no esta autorizado para acceder a la base de datos." }, 403);
}

function serviceHeaders(env, prefer) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

async function readRemoteDocument(env, metadataOnly = false) {
  const select = metadataOnly ? "updated_at" : "data,updated_at";
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/erp_records?table_name=eq.${TABLE_NAME}&record_key=eq.${RECORD_KEY}&select=${select}`,
    { headers: serviceHeaders(env) },
  );
  if (!response.ok) throw new Error(`No se pudo leer erp_records (HTTP ${response.status}).`);
  const rows = await response.json().catch(() => []);
  return rows?.[0] || null;
}

async function saveRemoteDocument(env, document, expectedUpdatedAt) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/save_erp_record_if_current`, {
    method: "POST",
    headers: {
      ...serviceHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_table_name: TABLE_NAME,
      p_record_key: RECORD_KEY,
      p_data: document,
      p_expected_updated_at: expectedUpdatedAt || null,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`No se pudo guardar erp_records (HTTP ${response.status}): ${body}`);
  }
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] : rows;
}

async function requireActiveIdentity(request, env) {
  const identity = await resolveErpIdentity(request, env);
  return identity.error ? { error: identityError(identity) } : { identity };
}

export async function onRequestGet({ request, env }) {
  const auth = await requireActiveIdentity(request, env);
  if (auth.error) return auth.error;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Persistencia no configurada." }, 500);
  }
  try {
    const url = new URL(request.url);
    const metadataOnly = url.searchParams.get("metadata") === "1";
    const row = await readRemoteDocument(env, metadataOnly);
    if (!row) return json({ error: "Base de datos no encontrada." }, 404);
    return json(metadataOnly ? { updatedAt: row.updated_at || null } : { data: row.data, updatedAt: row.updated_at || null });
  } catch (error) {
    console.error("database GET:", error);
    return json({ error: "No se pudo leer la base de datos." }, 500);
  }
}

export async function onRequestPut({ request, env }) {
  const auth = await requireActiveIdentity(request, env);
  if (auth.error) return auth.error;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Persistencia no configurada." }, 500);
  }
  const contentLength = Number(request.headers.get("content-length")) || 0;
  if (contentLength > MAX_BODY_BYTES) return json({ error: "Solicitud demasiado grande." }, 413);

  let payload;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return json({ error: "Solicitud demasiado grande." }, 413);
    }
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Solicitud invalida." }, 400);
  }
  if (!payload?.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
    return json({ error: "Documento invalido." }, 400);
  }
  if (payload.expectedUpdatedAt !== null && payload.expectedUpdatedAt !== undefined && typeof payload.expectedUpdatedAt !== "string") {
    return json({ error: "Version esperada invalida." }, 400);
  }

  try {
    const current = await readRemoteDocument(env, false);
    if (!current?.data) return json({ error: "Base de datos no encontrada." }, 404);
    if ((current.updated_at || null) !== (payload.expectedUpdatedAt || null)) {
      return json({ error: "Otra sesion guardo primero.", conflict: true, updatedAt: current.updated_at || null }, 409);
    }

    const changes = detectDatabaseChanges(current.data, payload.data);
    const authorization = authorizeDatabaseChanges(auth.identity, changes);
    if (!authorization.allowed) {
      console.warn("database PUT bloqueado", {
        userId: auth.identity.userId,
        reason: authorization.reason,
        domains: authorization.domains || [],
        tables: authorization.tables || [],
        permissions: authorization.permissions || [],
      });
      return json({ error: "Tu usuario no esta autorizado para modificar estas areas." }, 403);
    }
    if (authorization.noChanges) return json({ saved: true, noChanges: true, updatedAt: current.updated_at || null });

    const result = await saveRemoteDocument(env, payload.data, payload.expectedUpdatedAt || null);
    if (!result?.saved) {
      return json({ error: "Otra sesion guardo primero.", conflict: true, updatedAt: result?.new_updated_at || null }, 409);
    }

    const audit = await insertAuditLog(env, {
      tableName: "erp_records",
      entityId: `${TABLE_NAME}/${RECORD_KEY}`,
      action: "database_save",
      oldData: null,
      newData: {
        domains: changes.domains,
        tables: changes.changedTables,
        envelope: changes.changedEnvelope,
      },
      userId: auth.identity.userId,
      userEmail: auth.identity.email,
      userRole: auth.identity.role,
      success: true,
      note: "Guardado autorizado por la capa segura de persistencia.",
    });
    if (!audit.ok) console.error("database PUT: guardado completado pero fallo auditoria", audit.error);

    return json({ saved: true, updatedAt: result.new_updated_at || null, changes: { domains: changes.domains, tables: changes.changedTables } });
  } catch (error) {
    console.error("database PUT:", error);
    return json({ error: "No se pudo guardar la base de datos." }, 500);
  }
}

export async function onRequest() {
  return json({ error: "Metodo no permitido." }, 405);
}
