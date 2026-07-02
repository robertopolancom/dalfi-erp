const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const { randomBytes } = require("crypto");

const normalizeEmail = (value = "") => value.trim().toLowerCase();

function generateTemporaryPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(10);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("") + "#1";
}

async function requireAdmin(event) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);

  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    return { error: json(500, { error: "Faltan variables privadas de Supabase en Netlify." }) };
  }

  if (!adminEmails.length) {
    return { error: json(500, { error: "Falta configurar ADMIN_EMAILS en Netlify." }) };
  }

  const token = event.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) {
    return { error: json(401, { error: "Sesion requerida." }) };
  }

  const sessionResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!sessionResponse.ok) {
    return { error: json(401, { error: "Sesion invalida. Vuelve a iniciar sesion." }) };
  }

  const sessionUser = await sessionResponse.json();
  const requesterEmail = normalizeEmail(sessionUser.email);
  const requesterRole = String(sessionUser.user_metadata?.role || "").toLowerCase();
  const requesterIsAdmin = adminEmails.includes(requesterEmail) || ["administradora", "propietario"].includes(requesterRole);
  if (!requesterIsAdmin) {
    return { error: json(403, { error: "Tu usuario no esta autorizado para administrar usuarios." }) };
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

exports.handler = async (event) => {
  const context = await requireAdmin(event);
  if (context.error) return context.error;
  const { supabaseUrl, serviceRoleKey, requesterEmail } = context;

  if (event.httpMethod === "GET") {
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=200`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return json(response.status, { error: body.msg || body.error || "No se pudo cargar usuarios." });
    }
    return json(200, { users: (body.users || []).map(toPublicUser) });
  }

  if (event.httpMethod !== "PATCH") {
    return json(405, { error: "Metodo no permitido." });
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Solicitud invalida." });
  }

  const userId = String(payload.id || "").trim();
  if (!userId) {
    return json(400, { error: "Falta el ID del usuario." });
  }

  const currentResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  const currentUser = await currentResponse.json().catch(() => ({}));
  if (!currentResponse.ok) {
    return json(currentResponse.status, { error: currentUser.msg || currentUser.error || "No se pudo leer el usuario." });
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
    if (temporaryPassword.length < 6) {
      return json(400, { error: "La contrasena debe tener al menos 6 caracteres." });
    }
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
    return json(response.status, { error: body.msg || body.message || body.error_description || body.error || "No se pudo actualizar el usuario." });
  }

  return json(200, { user: toPublicUser(body), temporaryPassword: resetPassword ? temporaryPassword : undefined });
};
