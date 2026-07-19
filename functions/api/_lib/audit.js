// Utilidades compartidas por las funciones de Cloudflare Pages para escribir en
// erp_audit_log usando la llave de servicio (nunca expuesta al navegador) y para
// resolver de forma confiable quien esta haciendo la llamada a partir de su JWT.
// No confiar nunca en un email/rol que venga en el cuerpo de la peticion: siempre
// se revalida contra Supabase Auth aqui.

export async function resolveRequester(request, env) {
  const supabaseUrl = env.SUPABASE_URL;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !supabaseUrl || !publishableKey) return null;
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null);
  if (!user?.id) return null;
  return {
    id: user.id,
    email: String(user.email || "").trim().toLowerCase(),
    role: String(user.user_metadata?.role || "").trim().toLowerCase(),
  };
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
    old_data: entry.oldData ?? null,
    new_data: entry.newData ?? null,
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
