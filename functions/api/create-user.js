import { insertAuditLog } from "./_lib/audit.js";
import { requireErpPermission, upsertErpProfile, normalizeRole } from "./_lib/authz.js";

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

export async function onRequestPost({ request, env }) {
  const auth = await requireErpPermission(request, env, "canManageUsers", "crear usuarios");
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

  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "") || generateTemporaryPassword();
  const fullName = String(payload.fullName || "").trim();
  const role = normalizeRole(payload.role);

  if (!email) return json({ error: "El correo es obligatorio." }, 400);
  if (password.length < 6) return json({ error: "La contrasena debe tener al menos 6 caracteres." }, 400);

  const createResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        role,
        created_by: requesterEmail,
        password_reset_required: true,
        password_reset_reason: "initial_password",
        password_reset_at: new Date().toISOString(),
      },
    }),
  });

  const created = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok) {
    const failureMessage = created.msg || created.error_description || created.error || "No se pudo crear el usuario.";
    await insertAuditLog(env, {
      tableName: "usuarios",
      entityId: email,
      action: "create_user",
      oldData: null,
      newData: null,
      userId: requesterId,
      userEmail: requesterEmail,
      userRole: requesterRole,
      success: false,
      note: `Intento de creacion de usuario fallido: ${failureMessage}`,
    }).catch(() => null);
    return json({ error: failureMessage }, createResponse.status);
  }

  // El perfil seguro se crea aqui mismo, ademas del usuario en Supabase
  // Auth: sin esto, el usuario nuevo no tendria fila en erp_user_profiles y
  // /api/me le devolveria 403 (sin perfil) hasta el proximo backfill
  // manual. is_active=true por defecto (columna DEFAULT true), permisos
  // segun el rol elegido en el formulario de creacion.
  const profileResult = await upsertErpProfile(env, {
    userId: created.id,
    email: created.email || email,
    role,
    isActive: true,
  });

  if (!profileResult.ok) {
    // No dejar un usuario Auth activo y sin perfil seguro: eso lo dejaria
    // en un estado confuso (le decimos "usuario creado" pero /api/me le
    // devolveria 403 en todo). Se compensa borrando el usuario Auth recien
    // creado, se registra el fallo en auditoria (sin exponer el detalle
    // interno al cliente) y se responde error, NUNCA exito.
    console.error(`create-user: fallo el alta de erp_user_profiles para ${created.id}, compensando (borrando el usuario Auth huerfano): ${profileResult.error}`);
    const deleteResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(created.id)}`, {
      method: "DELETE",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    }).catch((error) => {
      console.error(`create-user: tambien fallo borrar el usuario Auth huerfano ${created.id}:`, error);
      return null;
    });
    const compensated = Boolean(deleteResponse?.ok);
    await insertAuditLog(env, {
      tableName: "usuarios",
      entityId: created.id || email,
      action: "create_user",
      oldData: null,
      newData: { email: created.email || email, role },
      userId: requesterId,
      userEmail: requesterEmail,
      userRole: requesterRole,
      success: false,
      note: compensated
        ? "El usuario se creo en Auth pero fallo el alta del perfil seguro; se revirtio borrando el usuario Auth huerfano."
        : `ALERTA: el usuario se creo en Auth (id ${created.id}) pero fallo el alta del perfil seguro Y TAMBIEN fallo borrarlo. Requiere revision manual en Supabase Auth.`,
    }).catch(() => null);
    return json({ error: "No se pudo completar la creacion del usuario. Intenta de nuevo o contacta soporte." }, 500);
  }

  await insertAuditLog(env, {
    tableName: "usuarios",
    entityId: created.id || email,
    action: "create_user",
    oldData: null,
    newData: { email: created.email || email, role, created_by: requesterEmail },
    userId: requesterId,
    userEmail: requesterEmail,
    userRole: requesterRole,
    success: true,
    note: `Usuario creado con contrasena temporal por ${requesterEmail}.`,
  }).catch(() => null);

  return json({ id: created.id, email: created.email || email, temporaryPassword: password });
}

export async function onRequest() {
  return json({ error: "Metodo no permitido." }, 405);
}
