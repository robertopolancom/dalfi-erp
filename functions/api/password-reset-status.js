const normalizeEmail = (value = "") => value.trim().toLowerCase();

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function onRequestPost({ request, env }) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Faltan variables privadas de Supabase en Cloudflare Pages." }, 500);
  }

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Solicitud invalida." }, 400);
  }

  const email = normalizeEmail(payload.email);
  if (!email) return json({ error: "Escribe el correo del usuario." }, 400);

  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=200`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return json({ error: body.msg || body.error || "No se pudo validar el reset." }, response.status);
  }

  const user = (body.users || []).find((item) => normalizeEmail(item.email) === email);
  const canReset = Boolean(user?.user_metadata?.password_reset_required);
  return json({
    canReset,
    message: canReset
      ? "Reset autorizado. Escribe la contrasena temporal y define tu nueva contrasena."
      : "Todavia no hay un reset autorizado. Solicita al administrador resetear tu contrasena.",
  });
}

export async function onRequest() {
  return json({ error: "Metodo no permitido." }, 405);
}
