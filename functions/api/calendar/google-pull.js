import { requireErpPermission } from "../_lib/authz.js";
import {
  claimGoogleCalendarEvent,
  googleCalendarConfig,
  listGoogleCalendarEvents,
} from "../_lib/google-calendar.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

const normalize = (value = "") => String(value || "").trim().toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const clean = (value, max = 160) => String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ").trim().slice(0, max);
const serviceHeaders = (env) => ({ apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` });

function localParts(iso, timeZone = "America/Santo_Domingo") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${map.year}-${map.month}-${map.day}`, time: `${map.hour}:${map.minute}` };
}

function minutesBetween(start, end) {
  const value = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
  return Number.isFinite(value) && value > 0 ? Math.min(24 * 60, value) : 30;
}

function parseGoogleEvent(event, staff = [], timeZone = "America/Santo_Domingo") {
  const eventId = clean(event?.eventId, 300);
  const start = new Date(String(event?.start || ""));
  const end = new Date(String(event?.end || ""));
  if (!eventId || isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return null;
  const startLocal = localParts(start.toISOString(), timeZone);
  const endLocal = localParts(end.toISOString(), timeZone);
  const description = clean(event?.description, 2000);
  const staffLine = description.match(/(?:^|\n)\s*Manicurista:\s*([^\n]+)/i)?.[1] || "";
  const title = clean(event?.summary, 180) || "Evento de Google Calendar";
  const titleStaff = title.split(/[—–-]/).slice(1).join("-").trim();
  const requestedStaff = clean(staffLine || titleStaff, 120);
  const candidates = staff.filter((person) => {
    const name = normalize(person?.nombreCompleto || person?.nombre);
    return name && requestedStaff && (name === normalize(requestedStaff) || normalize(requestedStaff) === name);
  });
  const assigned = candidates.length === 1 ? candidates[0] : null;
  const clientFromDescription = description.match(/(?:^|\n)\s*Clienta:\s*([^\n]+)/i)?.[1];
  const clientName = clean(clientFromDescription || title.replace(/^Cita:\s*/i, "").split(/[—–]/)[0], 120) || "Pendiente de completar";
  return {
    eventId,
    fecha: startLocal.date,
    hora: startLocal.time,
    horaFin: endLocal.time,
    duracionMin: minutesBetween(start.toISOString(), end.toISOString()),
    clienteNombre: clientName,
    colaboradorID: assigned ? String(assigned.colaboradorID || assigned.id || "") : "",
    colaboradorNombre: assigned ? clean(assigned.nombreCompleto || assigned.nombre, 120) : "",
    bloqueoGlobal: !assigned,
    googleCalendarEventId: eventId,
    clienteProvisional: true,
    estado: "Pendiente de completar",
    servicio: "Pendiente de completar",
    servicioID: "PENDIENTE",
    servicios: [],
    canalOrigen: "Google Calendar",
    observaciones: "Bloqueo importado desde Google Calendar. Complete los datos de la reserva.",
  };
}

async function readDocument(env) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/erp_records?table_name=eq.app&record_key=eq.database&select=data,updated_at`, { headers: serviceHeaders(env) });
  if (!response.ok) throw new Error("ERP_READ_FAILED");
  const row = (await response.json().catch(() => []))?.[0];
  if (!row?.data) throw new Error("ERP_NOT_FOUND");
  return { envelope: row.data, data: row.data.data && typeof row.data.data === "object" ? row.data.data : row.data, updatedAt: row.updated_at || null };
}

async function saveDocument(env, envelope, expectedUpdatedAt) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/save_erp_record_if_current`, {
    method: "POST", headers: { ...serviceHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ p_table_name: "app", p_record_key: "database", p_data: envelope, p_expected_updated_at: expectedUpdatedAt }),
  });
  if (!response.ok) throw new Error("ERP_SAVE_FAILED");
  return (await response.json().catch(() => []))?.[0] || {};
}

function reservationIdForEvent(eventId) {
  return `GCAL-${clean(eventId, 48).replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 80);
}

export { parseGoogleEvent, reservationIdForEvent };

async function authorized(request, env) {
  const secret = String(env.GOOGLE_CALENDAR_SYNC_SECRET || "");
  if (secret && request.headers.get("x-calendar-sync-secret") === secret) return { cron: true };
  return requireErpPermission(request, env, "canManageReservations", "importar bloqueos de Google Calendar");
}

export async function onRequestPost({ request, env }) {
  const auth = await authorized(request, env);
  if (auth.error) return auth.error;
  const config = googleCalendarConfig(env);
  if (!config.configured || config.provider !== "apps_script") return json({ success: false, code: "NOT_CONFIGURED" }, 409);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ success: false, code: "PERSISTENCE_NOT_CONFIGURED" }, 500);
  try {
    const now = Date.now();
    const from = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString();
    const pulled = await listGoogleCalendarEvents(env, { from, to, limit: 250 }, { fetchImpl: env.fetch || fetch });
    if (!pulled.ok) return json({ success: false, code: pulled.code }, 502);
    const current = await readDocument(env);
    const data = current.data;
    const reservations = Array.isArray(data.reservas) ? data.reservas : [];
    const staff = Array.isArray(data.colaboradores) ? data.colaboradores : [];
    const incoming = new Map(pulled.events.map((event) => [event.eventId, parseGoogleEvent(event, staff, config.timeZone)]).filter(([, value]) => value));
    let changed = false;
    const importedIds = new Set();
    const nextReservations = reservations.map((existing) => {
      const eventId = String(existing?.googleCalendarEventId || "");
      if (!eventId) return existing;
      const incomingReservation = incoming.get(eventId);
      if (!incomingReservation) {
        if (String(existing.estado || "").toLowerCase().includes("pendiente de completar")) {
          changed = true;
          return { ...existing, estado: "Cancelada", observaciones: "Evento eliminado de Google Calendar." };
        }
        return existing;
      }
      importedIds.add(eventId);
      const completed = !existing.clienteProvisional && !String(existing.estado || "").toLowerCase().includes("pendiente de completar");
      if (completed) return existing;
      changed = true;
      return { ...existing, ...incomingReservation, reservaID: existing.reservaID };
    });
    for (const [eventId, reservation] of incoming) {
      if (importedIds.has(eventId) || reservations.some((item) => String(item?.googleCalendarEventId || "") === eventId)) continue;
      const created = { ...reservation, reservaID: reservationIdForEvent(eventId), createdAt: new Date().toISOString(), updated_at: new Date().toISOString() };
      nextReservations.push(created);
      changed = true;
    }
    if (changed) {
      const nextData = { ...data, reservas: nextReservations };
      const nextEnvelope = current.envelope.data ? { ...current.envelope, data: nextData } : nextData;
      const saved = await saveDocument(env, nextEnvelope, current.updatedAt);
      if (!saved?.saved) return json({ success: false, code: "ERP_CONFLICT" }, 409);
    }
    const claims = [];
    for (const [eventId, reservation] of incoming) {
      claims.push(await claimGoogleCalendarEvent(env, eventId, reservationIdForEvent(eventId), { fetchImpl: env.fetch || fetch }));
    }
    return json({ success: true, imported: incoming.size, changed, claims: claims.filter((item) => item.ok).length });
  } catch (error) {
    console.error("calendar/google-pull:", error?.message || "PULL_FAILED");
    return json({ success: false, code: "PULL_FAILED" }, 500);
  }
}

export async function onRequest() { return json({ error: "Método no permitido." }, 405); }
