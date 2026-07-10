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

async function requireAdmin(request, env) {
  const supabaseUrl = env.SUPABASE_URL;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const adminEmails = String(env.ADMIN_EMAILS || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);

  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    return { error: json({ error: "Faltan variables privadas de Supabase en Cloudflare Pages." }, 500) };
  }

  if (!adminEmails.length) {
    return { error: json({ error: "Falta configurar ADMIN_EMAILS en Cloudflare Pages." }, 500) };
  }

  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return { error: json({ error: "Sesion requerida." }, 401) };

  const sessionResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!sessionResponse.ok) {
    return { error: json({ error: "Sesion invalida. Vuelve a iniciar sesion." }, 401) };
  }

  const sessionUser = await sessionResponse.json();
  const requesterEmail = normalizeEmail(sessionUser.email);
  const requesterRole = String(sessionUser.user_metadata?.role || "").toLowerCase();
  const requesterIsAdmin = adminEmails.includes(requesterEmail) || ["administradora", "administrador", "propietario"].includes(requesterRole);
  if (!requesterIsAdmin) {
    return { error: json({ error: "Tu usuario no esta autorizado para administrar usuarios." }, 403) };
  }

  return { supabaseUrl, serviceRoleKey, requesterEmail };
}

function isInactive(user) {
  if (user.user_metadata?.estado === "Inactivo") return true;
  if (!user.banned_until) return false;
  return new Date(user.banned_until).getTime() > Date.now();
}

function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.user_metadata?.full_name || "",
    role: user.user_metadata?.role || "operador",
    estado: isInactive(user) ? "Inactivo" : "Activo",
    passwordResetRequired: Boolean(user.user_metadata?.password_reset_required),
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at,
  };
}

export async function onRequestGet({ request, env }) {
  const context = await requireAdmin(request, env);
  if (context.error) return context.error;
  const { supabaseUrl, serviceRoleKey } = context;

  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=200`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return json({ error: body.msg || body.error || "No se pudo cargar usuarios." }, response.status);
  }
  return json({ users: (body.users || []).map(toPublicUser) });
}

export async function onRequestPatch({ request, env }) {
  const context = await requireAdmin(request, env);
  if (context.error) return context.error;
  const { supabaseUrl, serviceRoleKey, requesterEmail } = context;

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
  const role = String(payload.role || "operador").trim();
  const hasEstado = Object.prototype.hasOwnProperty.call(payload, "estado");
  const estado = payload.estado === "Inactivo" ? "Inactivo" : "Activo";
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "");
  const resetPassword = Boolean(payload.resetPassword);
  const temporaryPassword = resetPassword ? generateTemporaryPassword() : password;

  if (email) update.email = email;
  if (temporaryPassword) {
    if (temporaryPassword.length < 6) return json({ error: "La contrasena debe tener al menos 6 caracteres." }, 400);
    update.password = temporaryPassword;
  }

  update.user_metadata = {
    ...currentMetadata,
    full_name: fullName,
    role,
    updated_by: requesterEmail,
  };
  if (temporaryPassword) {
    update.user_metadata.password_reset_required = true;
    update.user_metadata.password_reset_reason = resetPassword ? "admin_reset" : "admin_password_update";
    update.user_metadata.password_reset_at = new Date().toISOString();
  }
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
    return json({ error: body.msg || body.message || body.error_description || body.error || "No se pudo actualizar el usuario." }, response.status);
  }

  return json({ user: toPublicUser(body), temporaryPassword: resetPassword ? temporaryPassword : undefined });
}

export async function onRequest() {
  return json({ error: "Metodo no permitido." }, 405);
}
