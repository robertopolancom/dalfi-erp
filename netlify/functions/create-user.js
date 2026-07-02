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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Metodo no permitido." });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);

  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    return json(500, { error: "Faltan variables privadas de Supabase en Netlify." });
  }

  if (!adminEmails.length) {
    return json(500, { error: "Falta configurar ADMIN_EMAILS en Netlify." });
  }

  const token = event.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) {
    return json(401, { error: "Sesion requerida." });
  }

  const sessionResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!sessionResponse.ok) {
    return json(401, { error: "Sesion invalida. Vuelve a iniciar sesion." });
  }

  const sessionUser = await sessionResponse.json();
  const requesterEmail = normalizeEmail(sessionUser.email);
  const requesterRole = String(sessionUser.user_metadata?.role || "").toLowerCase();
  const requesterIsAdmin = adminEmails.includes(requesterEmail) || ["administradora", "propietario"].includes(requesterRole);
  if (!requesterIsAdmin) {
    return json(403, { error: "Tu usuario no esta autorizado para crear usuarios." });
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Solicitud invalida." });
  }

  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "") || generateTemporaryPassword();
  const fullName = String(payload.fullName || "").trim();
  const role = String(payload.role || "operador").trim();

  if (!email) {
    return json(400, { error: "El correo es obligatorio." });
  }

  if (password.length < 6) {
    return json(400, { error: "La contrasena debe tener al menos 6 caracteres." });
  }

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
    return json(createResponse.status, { error: created.msg || created.error_description || created.error || "No se pudo crear el usuario." });
  }

  return json(200, { id: created.id, email: created.email || email, temporaryPassword: password });
};
