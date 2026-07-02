const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const normalizeEmail = (value = "") => value.trim().toLowerCase();

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Metodo no permitido." });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return json(500, { error: "Faltan variables privadas de Supabase en Netlify." });
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Solicitud invalida." });
  }

  const email = normalizeEmail(payload.email);
  if (!email) {
    return json(400, { error: "Escribe el correo del usuario." });
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=200`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return json(response.status, { error: body.msg || body.error || "No se pudo validar el reset." });
  }

  const user = (body.users || []).find((item) => normalizeEmail(item.email) === email);
  const canReset = Boolean(user?.user_metadata?.password_reset_required);
  return json(200, {
    canReset,
    message: canReset
      ? "Reset autorizado. Escribe la contrasena temporal y define tu nueva contrasena."
      : "Todavia no hay un reset autorizado. Solicita al administrador resetear tu contrasena.",
  });
};
