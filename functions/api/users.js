import { insertAuditLog } from "./_lib/audit.js";
import { requireErpPermission, upsertErpProfile, deleteErpProfile, normalizeRole, fetchErpProfile } from "./_lib/authz.js";

const normalizeEmail = (value = "") => value.trim().toLowerCase();

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function generateTemporaryPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("") + "#1";
}

function isInactive(user) {
  if (user.user_metadata?.estado === "Inactivo") return true;
  if (!user.banned_until) return false;
  return new Date(user.banned_until).getTime() > Date.now();
}

// role/canReviewAccounts/estado se muestran desde erp_user_profiles cuando
// existe (fuente autoritativa); solo caen a user_metadata como aproximacion
// visual para un usuario que todavia no tiene perfil seguro (por ejemplo,
// justo antes de correr el backfill). fullName/passwordResetRequired si
// siguen viniendo de user_metadata: son datos de despliegue visual, no de
// autorizacion.
function toPublicUser(user, profile) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.user_metadata?.full_name || "",
    role: profile?.role || user.user_metadata?.role || "operador",
    canReviewAccounts: profile ? Boolean(profile.can_review_accounts) : Boolean(user.user_metadata?.canReviewAccounts),
    canReviewAudit: Boolean(profile?.can_review_audit),
    estado: profile ? (profile.is_active ? "Activo" : "Inactivo") : isInactive(user) ? "Inactivo" : "Activo",
    passwordResetRequired: Boolean(user.user_metadata?.password_reset_required),
    hasSecureProfile: Boolean(profile),
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at,
  };
}

export async function onRequestGet({ request, env }) {
  const auth = await requireErpPermission(request, env, "canManageUsers", "administrar usuarios");
  if (auth.error) return auth.error;
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Faltan variables privadas de Supabase en Cloudflare Pages." }, 500);
  }

  const [usersResponse, profilesResponse] = await Promise.all([
    fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=200`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    }),
    fetch(`${supabaseUrl}/rest/v1/erp_user_profiles?select=*`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    }),
  ]);
  const body = await usersResponse.json().catch(() => ({}));
  if (!usersResponse.ok) {
    return json({ error: body.msg || body.error || "No se pudo cargar usuarios." }, usersResponse.status);
  }
  const profiles = profilesResponse.ok ? await profilesResponse.json().catch(() => []) : [];
  const profileByUserId = new Map((profiles || []).map((row) => [row.user_id, row]));

  return json({ users: (body.users || []).map((user) => toPublicUser(user, profileByUserId.get(user.id))) });
}

export async function onRequestPatch({ request, env }) {
  const auth = await requireErpPermission(request, env, "canManageUsers", "administrar usuarios");
  if (auth.error) return auth.error;
  const { identity } = auth;
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Faltan variables privadas de Supabase en Cloudflare Pages." }, 500);
  }
  const requesterEmail = identity.email;
  const requesterId = identity.userId;
  const requesterRole = identity.role;

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Solicitud invalida." }, 400);
  }

  const userId = String(payload.id || "").trim();
  if (!userId) return json({ error: "Falta el ID del usuario." }, 400);

  const currentResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  const currentUser = await currentResponse.json().catch(() => ({}));
  if (!currentResponse.ok) {
    return json({ error: currentUser.msg || currentUser.error || "No se pudo leer el usuario." }, currentResponse.status);
  }

  const currentMetadata = currentUser.user_metadata || {};
  const update = {};
  const fullName = String(payload.fullName || "").trim();
  const role = normalizeRole(payload.role);
  const hasEstado = Object.prototype.hasOwnProperty.call(payload, "estado");
  const estado = payload.estado === "Inactivo" ? "Inactivo" : "Activo";
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "");
  const resetPassword = Boolean(payload.resetPassword);
  const temporaryPassword = resetPassword ? generateTemporaryPassword() : password;
  const hasCanReviewAccounts = Object.prototype.hasOwnProperty.call(payload, "canReviewAccounts");
  const hasCanReviewAudit = Object.prototype.hasOwnProperty.call(payload, "canReviewAudit");

  if (temporaryPassword && temporaryPassword.length < 6) {
    return json({ error: "La contrasena debe tener al menos 6 caracteres." }, 400);
  }

  // erp_user_profiles es la fuente de verdad de rol/permisos: se sincroniza
  // ANTES de tocar Auth, no despues. Si esta llamada no trajo "estado",
  // "canReviewAccounts" o "canReviewAudit", se conserva lo que ya tuviera
  // el perfil (o el default del rol si todavia no existia perfil), en vez
  // de resetearlo silenciosamente cada vez que se guarda cualquier otro
  // campo (por ejemplo, editar solo el nombre no debe quitarle a un
  // asistente contable el permiso de auditoria que un administrador ya le
  // habia marcado explicitamente).
  const priorProfile = await fetchErpProfile(env, userId);
  const isActive = hasEstado ? estado !== "Inactivo" : priorProfile ? Boolean(priorProfile.is_active) : true;
  const canReviewAccountsOverride = hasCanReviewAccounts
    ? Boolean(payload.canReviewAccounts)
    : priorProfile
      ? Boolean(priorProfile.can_review_accounts)
      : undefined;
  const canReviewAuditOverride = hasCanReviewAudit
    ? Boolean(payload.canReviewAudit)
    : priorProfile
      ? Boolean(priorProfile.can_review_audit)
      : undefined;

  const profileResult = await upsertErpProfile(env, {
    userId,
    email: email || currentUser.email,
    role,
    isActive,
    canReviewAccountsOverride,
    canReviewAuditOverride,
  });
  if (!profileResult.ok) {
    // Se aborta ANTES de tocar Auth: asi nunca queda "Auth actualizado pero
    // perfil sin actualizar". El usuario conserva su rol/permisos previos
    // sin cambios en ningun lado.
    console.error(`users.js PATCH: fallo sincronizar erp_user_profiles para ${userId}, se aborta sin tocar Auth: ${profileResult.error}`);
    await insertAuditLog(env, {
      tableName: "usuarios",
      entityId: userId,
      action: "update_user",
      oldData: null,
      newData: null,
      userId: requesterId,
      userEmail: requesterEmail,
      userRole: requesterRole,
      success: false,
      note: "No se pudo sincronizar el perfil seguro; la operacion se aborto sin modificar nada en Auth.",
    }).catch(() => null);
    return json({ error: "No se pudo actualizar el usuario. Intenta de nuevo." }, 500);
  }

  update.user_metadata = {
    ...currentMetadata,
    full_name: fullName,
    role,
    updated_by: requesterEmail,
  };
  if (email) update.email = email;
  if (temporaryPassword) {
    update.password = temporaryPassword;
    update.user_metadata.password_reset_required = true;
    update.user_metadata.password_reset_reason = resetPassword ? "admin_reset" : "admin_password_update";
    update.user_metadata.password_reset_at = new Date().toISOString();
  }
  // Permiso explicito de solo-lectura para el modulo de Cuentas, ademas del
  // acceso ya otorgado a roles privilegiados/contable por rol. No habilita
  // ninguna accion de escritura: esas siguen exigiendo isPrivilegedRole en
  // cada funcion de negocio, no solo este flag.
  if (hasCanReviewAccounts) update.user_metadata.canReviewAccounts = Boolean(payload.canReviewAccounts);
  if (hasEstado) {
    update.user_metadata.estado = estado;
    update.ban_duration = estado === "Inactivo" ? "876000h" : "none";
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify(update),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failureMessage = body.msg || body.message || body.error_description || body.error || "No se pudo actualizar el usuario.";
    // Compensacion: el perfil seguro YA se actualizo arriba, pero Auth
    // rechazo el cambio. Se revierte el perfil para no dejar "perfil
    // actualizado pero Auth no actualizado" — si no existia antes, se
    // borra; si existia, se restaura exactamente a lo que tenia.
    const compensation = priorProfile
      ? await upsertErpProfile(env, {
          userId,
          email: priorProfile.email,
          role: priorProfile.role,
          isActive: priorProfile.is_active,
          canReviewAccountsOverride: priorProfile.can_review_accounts,
          canReviewAuditOverride: priorProfile.can_review_audit,
        })
      : await deleteErpProfile(env, userId);
    if (!compensation.ok) {
      console.error(`users.js PATCH: Auth rechazo el cambio Y TAMBIEN fallo revertir erp_user_profiles para ${userId}: ${compensation.error}`);
    }
    await insertAuditLog(env, {
      tableName: "usuarios",
      entityId: userId,
      action: resetPassword ? "reset_password" : "update_user",
      oldData: { email: currentUser.email },
      newData: null,
      userId: requesterId,
      userEmail: requesterEmail,
      userRole: requesterRole,
      success: false,
      note: compensation.ok
        ? `${failureMessage} (el perfil seguro se revirtio automaticamente)`
        : `${failureMessage} (ADEMAS fallo revertir el perfil seguro, requiere revision manual)`,
    }).catch(() => null);
    return json({ error: failureMessage }, response.status);
  }

  if (resetPassword) {
    await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}/logout`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    }).catch(() => null);

    // No se guarda la contrasena en la auditoria, solo el hecho de que se reseteo.
    await insertAuditLog(env, {
      tableName: "usuarios",
      entityId: userId,
      action: "reset_password",
      oldData: { email: currentUser.email, password_reset_required: Boolean(currentMetadata.password_reset_required) },
      newData: { email: body.email, password_reset_required: true, password_reset_reason: update.user_metadata.password_reset_reason },
      userId: requesterId,
      userEmail: requesterEmail,
      userRole: requesterRole,
      success: true,
      note: `Contrasena temporal generada por ${requesterEmail} para ${body.email || currentUser.email}.`,
    }).catch(() => null);
  }

  return json({
    user: toPublicUser(body, profileResult.profile),
    temporaryPassword: resetPassword ? temporaryPassword : undefined,
  });
}

export async function onRequest() {
  return json({ error: "Metodo no permitido." }, 405);
}
