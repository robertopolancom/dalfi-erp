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

async function requireAdmin(request, env, action = "crear usuarios") {
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
  const requesterIsAdmin = adminEmails.includes(requesterEmail) || ["administradora", "administrador", "propietaria", "propietario"].includes(requesterRole);
  if (!requesterIsAdmin) {
    return { error: json({ error: `Tu usuario no esta autorizado para ${action}.` }, 403) };
  }

  return { supabaseUrl, serviceRoleKey, requesterEmail };
}

export async function onRequestPost({ request, env }) {
  const context = await requireAdmin(request, env);
  if (context.error) return context.error;
  const { supabaseUrl, serviceRoleKey, requesterEmail } = context;

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Solicitud invalida." }, 400);
  }

  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "") || generateTemporaryPassword();
  const fullName = String(payload.fullName || "").trim();
  const role = String(payload.role || "operador").trim();

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
    return json({ error: created.msg || created.error_description || created.error || "No se pudo crear el usuario." }, createResponse.status);
  }

  return json({ id: created.id, email: created.email || email, temporaryPassword: password });
}

export async function onRequest() {
  return json({ error: "Metodo no permitido." }, 405);
}
