import { requireErpPermission } from "../_lib/authz.js";
import {
  googleCalendarConfig,
  syncAppointmentToGoogleCalendar,
  todayInTimeZone,
} from "../_lib/google-calendar.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function serviceHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
}

async function requireReservationsAccess(request, env) {
  return requireErpPermission(request, env, "canManageReservations", "sincronizar el calendario de reservas");
}

async function readErpData(env) {
  const fetchImpl = env.fetch || fetch;
  const response = await fetchImpl(
    `${env.SUPABASE_URL}/rest/v1/erp_records?table_name=eq.app&record_key=eq.database&select=data`,
    { headers: serviceHeaders(env) },
  );
  if (!response.ok) throw new Error("ERP_READ_FAILED");
  const rows = await response.json().catch(() => []);
  const document = rows?.[0]?.data || {};
  return document.data && typeof document.data === "object" ? document.data : document;
}

export async function onRequestGet({ request, env }) {
  const auth = await requireReservationsAccess(request, env);
  if (auth.error) return auth.error;
  const config = googleCalendarConfig(env);
  return json({
    enabled: config.enabled,
    configured: config.configured,
    calendarId: config.calendarId || null,
    timeZone: config.timeZone,
  });
}

export async function onRequestPost({ request, env }) {
  const auth = await requireReservationsAccess(request, env);
  if (auth.error) return auth.error;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Persistencia no configurada." }, 500);
  }

  const config = googleCalendarConfig(env);
  if (!config.configured) {
    return json({
      success: false,
      code: config.enabled ? "NOT_CONFIGURED" : "DISABLED",
      error: "La sincronización con Google Calendar todavía no está configurada.",
    }, 409);
  }

  let payload = {};
  try {
    const raw = await request.text();
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return json({ error: "Solicitud JSON inválida." }, 400);
  }

  const dryRun = payload.dryRun !== false;
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(payload.limit || 50), 10) || 50));
  const requestedIds = Array.isArray(payload.appointmentIds)
    ? new Set(payload.appointmentIds.slice(0, 100).map((value) => String(value)))
    : null;
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.fromDate || ""))
    ? String(payload.fromDate)
    : todayInTimeZone(config.timeZone);

  try {
    const data = await readErpData(env);
    const services = Array.isArray(data.servicios) ? data.servicios : [];
    const staff = Array.isArray(data.colaboradores) ? data.colaboradores : [];
    const appointments = (Array.isArray(data.reservas) ? data.reservas : [])
      .filter((appointment) => {
        const id = String(appointment?.reservaID || appointment?.id || "");
        if (!id || (requestedIds && !requestedIds.has(id))) return false;
        const status = String(appointment?.estado || "").toLowerCase();
        if (["cancelada", "cancelado", "anulada", "anulado"].includes(status)) return false;
        return String(appointment?.fecha || "") >= fromDate;
      })
      .slice(0, limit);

    if (dryRun) {
      return json({ success: true, dryRun: true, fromDate, candidates: appointments.length });
    }

    const results = [];
    for (const appointment of appointments) {
      results.push(await syncAppointmentToGoogleCalendar(
        env,
        appointment,
        { services, staff },
        { fetchImpl: env.fetch || fetch },
      ));
    }
    const failed = results.filter((result) => !result.ok).length;
    return json({
      success: failed === 0,
      dryRun: false,
      fromDate,
      total: results.length,
      synced: results.length - failed,
      failed,
      results: results.map(({ appointmentId, ok, action, code }) => ({ appointmentId, ok, action, code })),
    }, failed ? 207 : 200);
  } catch (error) {
    console.error("calendar/google-sync POST:", error?.message === "ERP_READ_FAILED" ? "ERP_READ_FAILED" : "SYNC_REQUEST_FAILED");
    return json({ error: "No se pudo sincronizar el calendario." }, 500);
  }
}

export async function onRequest() {
  return json({ error: "Método no permitido." }, 405);
}
