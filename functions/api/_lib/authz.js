// Resolucion de identidad y permisos seguros para las Cloudflare Functions.
//
// Fuente de verdad: la tabla erp_user_profiles (Supabase), consultada aqui
// SIEMPRE con la llave de servicio. NUNCA se usa user_metadata.role ni
// user_metadata.canReviewAccounts para autorizar una accion — ver auditoria
// tecnica 2026-07-20/21. ADMIN_EMAILS solo actua como respaldo de
// emergencia complementario (por si un perfil seguro no existe todavia),
// nunca como fuente principal: ver resolveErpIdentity().

const normalizeEmail = (value = "") => String(value || "").trim().toLowerCase();

// Debe mantenerse en sincronia con el CHECK de
// supabase/migrations/20260721000000_create_erp_user_profiles.sql y con
// PRIVILEGED_ROLES/ACCOUNT_REVIEW_ROLES en outputs/lib/closing-math.js.
export const PRIVILEGED_ROLES = new Set(["administradora", "administrador", "propietaria", "propietario"]);
export const ACCOUNT_REVIEW_ROLES = new Set(["contador", "contadora"]);
export const ALLOWED_ROLES = new Set([
  "operador",
  ...PRIVILEGED_ROLES,
  ...ACCOUNT_REVIEW_ROLES,
  "asistente_contable",
  "asistenta_contable",
]);

export function normalizeRole(role) {
  const normalized = String(role || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  return ALLOWED_ROLES.has(normalized) ? normalized : "operador";
}

// Espejo en JS de la tabla de permisos por defecto que aplica el backfill
// SQL de la migracion de erp_user_profiles. Ningun rol distinto a
// administradora/administrador/propietaria/propietario recibe permisos
// administrativos por defecto.
export function defaultPermissionsForRole(role) {
  const normalized = normalizeRole(role);
  const privileged = PRIVILEGED_ROLES.has(normalized);
  const reviewer = ACCOUNT_REVIEW_ROLES.has(normalized);
  return {
    can_review_accounts: privileged || reviewer,
    can_review_audit: privileged || reviewer,
    can_submit_register_count: true,
    can_confirm_register_closings: privileged,
    can_confirm_treasury_closings: privileged,
    can_manage_users: privileged,
    can_manage_invoices: privileged,
    can_reopen_closings: privileged,
  };
}

function emergencyAdminEmails(env) {
  return String(env.ADMIN_EMAILS || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
}

function allPermissionsGranted() {
  return {
    canReviewAccounts: true,
    canReviewAudit: true,
    canSubmitRegisterCount: true,
    canConfirmRegisterClosings: true,
    canConfirmTreasuryClosings: true,
    canManageUsers: true,
    canManageInvoices: true,
    canReopenClosings: true,
  };
}

function permissionsFromProfileRow(row) {
  return {
    canReviewAccounts: Boolean(row.can_review_accounts),
    canReviewAudit: Boolean(row.can_review_audit),
    canSubmitRegisterCount: Boolean(row.can_submit_register_count),
    canConfirmRegisterClosings: Boolean(row.can_confirm_register_closings),
    canConfirmTreasuryClosings: Boolean(row.can_confirm_treasury_closings),
    canManageUsers: Boolean(row.can_manage_users),
    canManageInvoices: Boolean(row.can_manage_invoices),
    canReopenClosings: Boolean(row.can_reopen_closings),
  };
}

// Revalida el JWT contra Supabase Auth (nunca confia en lo que mande el
// navegador en el cuerpo de la peticion).
export async function fetchAuthUser(request, env) {
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
  return { id: user.id, email: normalizeEmail(user.email || "") };
}

// Lee el perfil seguro con la llave de servicio (erp_user_profiles no se
// expone directamente a authenticated: solo service_role puede leerla por
// fuera de las funciones SQL SECURITY DEFINER).
export async function fetchErpProfile(env, userId) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey || !userId) return null;
  const response = await fetch(`${supabaseUrl}/rest/v1/erp_user_profiles?user_id=eq.${encodeURIComponent(userId)}&select=*`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return rows?.[0] || null;
}

// Crea o actualiza (upsert) el perfil seguro de un usuario. Los permisos se
// recalculan siempre a partir del rol (defaultPermissionsForRole); dos
// permisos admiten un override explicito, can_review_accounts (para
// preservar el flag "Revisar cuentas" que ya existia como caso especial en
// user_metadata.canReviewAccounts) y can_review_audit (para que
// asistente_contable/asistenta_contable puedan revisar auditoria SOLO
// cuando un administrador lo marca explicitamente, ver seccion 6 de la
// revision de seguridad). Ambos overrides solo pueden SUMAR el permiso
// (OR), nunca quitarlo si el rol ya lo otorga por defecto.
export async function upsertErpProfile(env, { userId, email, role, isActive = true, canReviewAccountsOverride, canReviewAuditOverride } = {}) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey || !userId) {
    return { ok: false, error: "Faltan variables privadas de Supabase para administrar perfiles." };
  }
  const normalizedRole = normalizeRole(role);
  const defaults = defaultPermissionsForRole(normalizedRole);
  const payload = {
    user_id: userId,
    email: normalizeEmail(email),
    role: normalizedRole,
    is_active: Boolean(isActive),
    can_review_accounts: defaults.can_review_accounts || Boolean(canReviewAccountsOverride),
    can_review_audit: defaults.can_review_audit || Boolean(canReviewAuditOverride),
    can_submit_register_count: defaults.can_submit_register_count,
    can_confirm_register_closings: defaults.can_confirm_register_closings,
    can_confirm_treasury_closings: defaults.can_confirm_treasury_closings,
    can_manage_users: defaults.can_manage_users,
    can_manage_invoices: defaults.can_manage_invoices,
    can_reopen_closings: defaults.can_reopen_closings,
  };
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/erp_user_profiles?on_conflict=user_id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, error: body || `HTTP ${response.status}` };
    }
    return { ok: true, profile: payload };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

// Borra el perfil seguro de un usuario. Se usa SOLO como compensacion: por
// ejemplo, si erp_user_profiles se actualizo con exito pero el PATCH
// correspondiente en Supabase Auth fallo despues, y el perfil no existia
// antes de este intento (no hay a que version previa volver), se borra en
// vez de dejarlo con datos que nunca se reflejaron en Auth.
export async function deleteErpProfile(env, userId) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey || !userId) {
    return { ok: false, error: "Faltan variables privadas de Supabase para administrar perfiles." };
  }
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/erp_user_profiles?user_id=eq.${encodeURIComponent(userId)}`, {
      method: "DELETE",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
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

// Identidad + permisos efectivos de quien hace la peticion. Nunca lee
// user_metadata para autorizar: solo JWT (identidad) + erp_user_profiles
// (permisos). Si no hay perfil pero el correo esta en ADMIN_EMAILS, se
// concede acceso administrativo de emergencia (viaEmergencyFallback=true)
// para no dejar el sistema sin ningun administrador operable mientras se
// completa la migracion de perfiles.
export async function resolveErpIdentity(request, env) {
  const authUser = await fetchAuthUser(request, env);
  if (!authUser) return { error: "unauthenticated" };

  const profile = await fetchErpProfile(env, authUser.id);

  if (!profile) {
    const adminEmails = emergencyAdminEmails(env);
    if (adminEmails.includes(authUser.email)) {
      return {
        userId: authUser.id,
        email: authUser.email,
        role: "administradora",
        isActive: true,
        permissions: allPermissionsGranted(),
        viaEmergencyFallback: true,
      };
    }
    return { error: "no_profile", userId: authUser.id, email: authUser.email };
  }

  if (!profile.is_active) {
    return { error: "inactive", userId: authUser.id, email: authUser.email };
  }

  return {
    userId: authUser.id,
    email: authUser.email,
    role: profile.role,
    isActive: true,
    permissions: permissionsFromProfileRow(profile),
    viaEmergencyFallback: false,
  };
}

const PERMISSION_TO_CAMEL = {
  canReviewAccounts: "canReviewAccounts",
  canReviewAudit: "canReviewAudit",
  canSubmitRegisterCount: "canSubmitRegisterCount",
  canConfirmRegisterClosings: "canConfirmRegisterClosings",
  canConfirmTreasuryClosings: "canConfirmTreasuryClosings",
  canManageUsers: "canManageUsers",
  canManageInvoices: "canManageInvoices",
  canReopenClosings: "canReopenClosings",
};

const jsonError = (body, status) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Helper de alto nivel para endpoints que exigen un permiso concreto.
// Devuelve { error: Response } listo para "return" si la peticion debe
// rechazarse, o { identity } si esta autorizada. Nunca expone en la
// respuesta si el motivo del 403 fue "sin perfil" vs "sin el permiso": ese
// detalle solo se registra en el log del servidor (console.warn), no se
// filtra al cliente.
export async function requireErpPermission(request, env, permissionKey, actionLabel = "realizar esta accion") {
  const identity = await resolveErpIdentity(request, env);
  if (identity.error === "unauthenticated") {
    return { error: jsonError({ error: "Sesion requerida." }, 401) };
  }
  if (identity.error === "inactive") {
    console.warn(`erp_user_profiles: usuario inactivo intento ${actionLabel} (${identity.email}).`);
    return { error: jsonError({ error: "Tu usuario esta inactivo." }, 403) };
  }
  if (identity.error === "no_profile") {
    console.warn(`erp_user_profiles: sin perfil seguro, intento ${actionLabel} (${identity.email}).`);
    return { error: jsonError({ error: `Tu usuario no esta autorizado para ${actionLabel}.` }, 403) };
  }
  const camelKey = PERMISSION_TO_CAMEL[permissionKey] || permissionKey;
  if (!identity.permissions?.[camelKey]) {
    return { error: jsonError({ error: `Tu usuario no esta autorizado para ${actionLabel}.` }, 403) };
  }
  return { identity };
}
