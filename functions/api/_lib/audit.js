// Utilidades compartidas por las funciones de Cloudflare Pages para escribir en
// erp_audit_log usando la llave de servicio (nunca expuesta al navegador) y para
// resolver de forma confiable quien esta haciendo la llamada a partir de su JWT.
// No confiar nunca en un email/rol que venga en el cuerpo de la peticion: siempre
// se revalida contra Supabase Auth aqui, y el ROL se lee de erp_user_profiles
// (nunca de user_metadata.role, que el propio usuario puede llegar a editar) —
// ver auditoria tecnica 2026-07-20/21 y functions/api/_lib/authz.js.

import { fetchAuthUser, fetchErpProfile } from "./authz.js";

export async function resolveRequester(request, env) {
  const authUser = await fetchAuthUser(request, env);
  if (!authUser) return null;
  let role = "";
  try {
    const profile = await fetchErpProfile(env, authUser.id);
    role = profile?.role || "";
  } catch {
    // Si falla la consulta del perfil seguro no bloqueamos el registro de
    // auditoria: se guarda igual, pero nunca con un rol declarado por el
    // navegador — queda vacio en vez de confiar en user_metadata.
  }
  return { id: authUser.id, email: authUser.email, role };
}

// Redacta claves, tokens y contrasenas de lo que se vaya a guardar en
// old_data/new_data/note. Los llamadores actuales de logAudit() nunca
// deberian mandar esto, pero la bitacora de auditoria no debe depender solo
// de la disciplina de cada llamador para no filtrar un secreto.
const SENSITIVE_KEY_PATTERN = /pass|contras|token|secret|clave|api[-_]?key|service[-_]?role|authorization|jwt/i;
const REDACTED = "[REDACTADO]";

function sanitizeAuditValue(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item, depth + 1));
  if (typeof value === "object") {
    const clean = {};
    for (const [key, val] of Object.entries(value)) {
      clean[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitizeAuditValue(val, depth + 1);
    }
    return clean;
  }
  if (typeof value === "string" && value.length > 4000) return `${value.slice(0, 4000)}…`;
  return value;
}

export async function insertAuditLog(env, entry) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return { ok: false, error: "Faltan variables privadas de Supabase para registrar auditoria." };
  }
  const payload = {
    table_name: entry.tableName || "app",
    record_key: entry.entityId || "",
    action: entry.action,
    old_data: sanitizeAuditValue(entry.oldData ?? null),
    new_data: sanitizeAuditValue(entry.newData ?? null),
    user_id: entry.userId || null,
    user_email: entry.userEmail || null,
    user_role: entry.userRole || null,
    success: entry.success !== false,
    note: entry.note || null,
  };
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/erp_audit_log`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, error: body || `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
