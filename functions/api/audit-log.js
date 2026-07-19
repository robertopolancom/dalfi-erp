import { insertAuditLog, resolveRequester } from "./_lib/audit.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Acciones sensibles que la app puede registrar desde el navegador. Cualquier
// otra cosa se rechaza para evitar que el endpoint se use como bitacora libre.
const ALLOWED_ACTIONS = new Set([
  "reset_password",
  "invoice_edit",
  "invoice_edit_blocked",
  "reservation_edit",
  "closing_attempt_shortage",
  "closing_register_confirm",
  "closing_treasury_confirm_range",
  "closing_treasury_confirm_blocked",
  "closing_reopen",
  "closing_surplus",
  "closing_catchup_run",
  "transfer_confirm",
  "create_client_from_invoice",
  "create_client",
  "edit_client",
]);

export async function onRequestPost({ request, env }) {
  const requester = await resolveRequester(request, env);
  if (!requester) return json({ error: "Sesion invalida. Vuelve a iniciar sesion." }, 401);

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Solicitud invalida." }, 400);
  }

  const action = String(payload.action || "").trim();
  if (!ALLOWED_ACTIONS.has(action)) return json({ error: "Accion de auditoria no reconocida." }, 400);

  const result = await insertAuditLog(env, {
    tableName: String(payload.entity || "app").slice(0, 60),
    entityId: String(payload.entityId || "").slice(0, 120),
    action,
    oldData: payload.oldData ?? null,
    newData: payload.newData ?? null,
    userId: requester.id,
    userEmail: requester.email,
    userRole: requester.role,
    success: payload.success !== false,
    note: payload.note ? String(payload.note).slice(0, 500) : null,
  });

  if (!result.ok) return json({ error: result.error || "No se pudo registrar la auditoria." }, 500);
  return json({ ok: true });
}

export async function onRequest() {
  return json({ error: "Metodo no permitido." }, 405);
}
