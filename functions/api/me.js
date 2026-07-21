// GET /api/me — perfil y permisos efectivos del usuario autenticado.
//
// Es la unica fuente que el frontend debe usar para decidir que puede hacer
// el usuario actual (ver outputs/app.js: refreshErpProfile()). Nunca lee
// user_metadata: el rol y los permisos vienen de erp_user_profiles via
// resolveErpIdentity() (functions/api/_lib/authz.js). No devuelve datos de
// ningun otro usuario, ni metadata completa, ni claves ni tokens.

import { resolveErpIdentity } from "./_lib/authz.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function onRequestGet({ request, env }) {
  const identity = await resolveErpIdentity(request, env);

  if (identity.error === "unauthenticated") {
    return json({ error: "Sesion requerida." }, 401);
  }
  if (identity.error === "inactive") {
    console.warn(`/api/me: usuario inactivo (${identity.email}).`);
    return json({ error: "Tu usuario esta inactivo." }, 403);
  }
  if (identity.error === "no_profile") {
    console.warn(`/api/me: sin perfil seguro (${identity.email}).`);
    return json({ error: "Tu usuario no tiene un perfil autorizado. Contacta a un administrador." }, 403);
  }

  return json({
    userId: identity.userId,
    email: identity.email,
    role: identity.role,
    isActive: identity.isActive,
    permissions: identity.permissions,
  });
}

export async function onRequest() {
  return json({ error: "Metodo no permitido." }, 405);
}
