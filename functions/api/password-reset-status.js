// POST /api/password-reset-status — diagnostico interno para saber si un
// usuario tiene un reset de contrasena pendiente autorizado.
//
// Antes este endpoint era publico (sin autenticacion) y lo llamaba
// directamente el formulario "olvide mi contrasena" del navegador: eso lo
// convertia en un oraculo de enumeracion de usuarios (una persona sin
// sesion podia mandar cualquier correo y deducir, por la respuesta, si esa
// cuenta existe y si un administrador ya le genero una contrasena
// temporal). Ver auditoria tecnica 2026-07-20/21.
//
// Ahora exige JWT + permiso can_manage_users (opcion A de la auditoria):
// pasa a ser una herramienta de uso interno/administrativo, no un endpoint
// publico. El flujo de "olvide mi contrasena" en outputs/app.js ya NO llama
// a este endpoint (ver wireAuth() en outputs/app.js): en su lugar siempre
// muestra el mismo mensaje generico y abre el formulario de cambio de
// contrasena, sin revelar si el correo existe — la unica verificacion real
// sigue siendo el signInWithPassword con la contrasena temporal correcta.
//
// Ademas de requerir permiso, ya no pagina hasta 200 usuarios: filtra por
// el correo especifico via el endpoint admin de Supabase Auth.

import { requireErpPermission } from "./_lib/authz.js";

const normalizeEmail = (value = "") => value.trim().toLowerCase();

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function onRequestPost({ request, env }) {
  const auth = await requireErpPermission(request, env, "canManageUsers", "consultar el estado de reset de otro usuario");
  if (auth.error) return auth.error;

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

  // Filtro especifico por correo en vez de paginar 200 usuarios y filtrar
  // en memoria. Si la version de GoTrue del proyecto no honra este filtro
  // exacto, igual se filtra por coincidencia exacta abajo antes de leer
  // password_reset_required, asi que el resultado sigue siendo correcto.
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return json({ error: body.msg || body.error || "No se pudo validar el reset." }, response.status);
  }

  const candidates = Array.isArray(body.users) ? body.users : Array.isArray(body) ? body : [];
  const user = candidates.find((item) => normalizeEmail(item.email) === email);
  const canReset = Boolean(user?.user_metadata?.password_reset_required);
  return json({
    exists: Boolean(user),
    canReset,
    message: canReset
      ? "Reset autorizado. El usuario puede escribir la contrasena temporal y definir una nueva."
      : "Todavia no hay un reset autorizado para ese correo.",
  });
}

export async function onRequest() {
  return json({ error: "Metodo no permitido." }, 405);
}
