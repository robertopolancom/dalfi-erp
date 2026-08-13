const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const DEFAULT_TIME_ZONE = "America/Santo_Domingo";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_SYNC_PER_SAVE = 25;

let cachedToken = null;

const normalize = (value = "") =>
  String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

function cleanText(value, maxLength = 160) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function boolEnv(value) {
  return /^(1|true|yes|si|sí|on)$/i.test(String(value || "").trim());
}

function base64Url(bytes) {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlJson(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function pemToPkcs8(privateKey) {
  const normalized = String(privateKey || "").replace(/\\n/g, "\n").trim();
  const encoded = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (!encoded) throw new Error("GOOGLE_PRIVATE_KEY_MISSING");
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function googleCalendarConfig(env = {}) {
  const enabled = boolEnv(env.GOOGLE_CALENDAR_ENABLED);
  const provider = cleanText(env.GOOGLE_CALENDAR_PROVIDER, 40) || "service_account";
  const calendarId = cleanText(env.GOOGLE_CALENDAR_ID, 320);
  const serviceAccountEmail = cleanText(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, 320);
  const privateKey = String(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "");
  const appsScriptUrl = String(env.GOOGLE_APPS_SCRIPT_WEBHOOK_URL || "").trim();
  const appsScriptSecret = String(env.GOOGLE_APPS_SCRIPT_WEBHOOK_SECRET || "");
  const providerConfigured = provider === "apps_script"
    ? /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(appsScriptUrl) && Boolean(appsScriptSecret)
    : Boolean(calendarId && serviceAccountEmail && privateKey);
  return {
    enabled,
    configured: Boolean(enabled && providerConfigured),
    provider,
    calendarId,
    serviceAccountEmail,
    privateKey,
    appsScriptUrl,
    appsScriptSecret,
    timeZone: cleanText(env.GOOGLE_CALENDAR_TIME_ZONE, 80) || DEFAULT_TIME_ZONE,
    timeoutMs: clampInteger(env.GOOGLE_CALENDAR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 30000),
    maxSyncPerSave: clampInteger(
      env.GOOGLE_CALENDAR_MAX_SYNC_PER_SAVE,
      DEFAULT_MAX_SYNC_PER_SAVE,
      1,
      100,
    ),
  };
}

async function createServiceAccountAssertion(config, nowMs = Date.now()) {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iss: config.serviceAccountEmail,
    scope: GOOGLE_CALENDAR_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  });
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(config.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(signature)}`;
}

export async function getGoogleAccessToken(env, runtime = {}) {
  const config = googleCalendarConfig(env);
  if (!config.configured) throw new Error("GOOGLE_CALENDAR_NOT_CONFIGURED");
  const nowMs = runtime.nowMs ?? Date.now();
  const cacheKey = `${config.serviceAccountEmail}|${config.calendarId}`;
  if (cachedToken?.cacheKey === cacheKey && cachedToken.expiresAt > nowMs + 60000) {
    return cachedToken.value;
  }

  const fetchImpl = runtime.fetchImpl || fetch;
  const assertion = await createServiceAccountAssertion(config, nowMs);
  const response = await fetchWithTimeout(
    fetchImpl,
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    },
    config.timeoutMs,
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) throw new Error("GOOGLE_TOKEN_REQUEST_FAILED");
  cachedToken = {
    cacheKey,
    value: String(payload.access_token),
    expiresAt: nowMs + Math.max(60, Number(payload.expires_in) || 3600) * 1000,
  };
  return cachedToken.value;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function validTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function addLocalMinutes(date, time, minutes) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes));
  return {
    date: `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, "0")}-${String(result.getUTCDate()).padStart(2, "0")}`,
    time: `${String(result.getUTCHours()).padStart(2, "0")}:${String(result.getUTCMinutes()).padStart(2, "0")}`,
  };
}

function appointmentDuration(appointment, services = []) {
  const direct = Number(appointment?.duracionMin);
  if (Number.isFinite(direct) && direct > 0) return Math.min(24 * 60, Math.round(direct));

  const lines = Array.isArray(appointment?.servicios) ? appointment.servicios : [];
  const lineTotal = lines.reduce((sum, line) => sum + Math.max(0, Number(line?.duracionMin) || 0), 0);
  if (lineTotal > 0) return Math.min(24 * 60, Math.round(lineTotal));

  const serviceId = String(appointment?.servicioID || "");
  const serviceName = normalize(appointment?.servicio);
  const match = services.find(
    (service) =>
      (serviceId && String(service?.servicioID || service?.id || "") === serviceId) ||
      (serviceName && normalize(service?.nombre || service?.servicio) === serviceName),
  );
  const catalogDuration = Number(match?.duracionMin || match?.durationMinutes);
  return Number.isFinite(catalogDuration) && catalogDuration > 0
    ? Math.min(24 * 60, Math.round(catalogDuration))
    : 30;
}

function staffId(person) {
  return String(person?.colaboradorID || person?.id || "");
}

function staffIsActive(person) {
  return normalize(person?.estado || "Activo") === "activo";
}

export function resolveStaffCalendarColorId(appointment, staff = []) {
  const appointmentId = String(appointment?.colaboradorID || appointment?.collaboratorId || "");
  const appointmentName = normalize(appointment?.colaboradorNombre || appointment?.staff);
  const assigned = staff.find((person) =>
    (appointmentId && staffId(person) === appointmentId) ||
    (appointmentName && normalize(person?.nombreCompleto || person?.nombre) === appointmentName)
  );
  const explicit = Number.parseInt(String(
    appointment?.googleCalendarColorId || assigned?.googleCalendarColorId || ""
  ), 10);
  if (explicit >= 1 && explicit <= 11) return String(explicit);
  if (!assigned) return null;
  const ordered = staff
    .filter(staffIsActive)
    .slice()
    .sort((left, right) => staffId(left).localeCompare(staffId(right)) ||
      normalize(left?.nombreCompleto || left?.nombre).localeCompare(normalize(right?.nombreCompleto || right?.nombre)));
  const index = ordered.findIndex((person) => staffId(person) === staffId(assigned));
  return String((Math.max(0, index) % 11) + 1);
}

function resolveStaffName(appointment, staff = []) {
  const direct = cleanText(appointment?.colaboradorNombre || appointment?.staff, 120);
  if (direct) return direct;
  const id = String(appointment?.colaboradorID || appointment?.collaboratorId || "");
  const match = staff.find((person) => staffId(person) === id);
  return cleanText(match?.nombreCompleto || match?.nombre, 120) || "Sin asignar";
}

function isCancelled(appointment) {
  return new Set(["cancelada", "cancelado", "anulada", "anulado"]).has(normalize(appointment?.estado || appointment?.status));
}

export async function googleEventIdForReservation(reservationId) {
  const value = cleanText(reservationId, 240);
  if (!value) throw new Error("APPOINTMENT_ID_MISSING");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `dalfi${hex.slice(0, 48)}`;
}

export function buildGoogleCalendarEvent(appointment, context = {}) {
  const reservationId = cleanText(appointment?.reservaID || appointment?.id || appointment?.appointmentId, 240);
  const date = String(appointment?.fecha || appointment?.date || "").slice(0, 10);
  const time = String(appointment?.hora || appointment?.time || "").slice(0, 5);
  if (!reservationId || !validDate(date) || !validTime(time)) return null;

  const durationMin = appointmentDuration(appointment, context.services || []);
  let endDate = date;
  let endTime = String(appointment?.horaFin || appointment?.endTime || "").slice(0, 5);
  if (!validTime(endTime)) {
    const calculated = addLocalMinutes(date, time, durationMin);
    endDate = calculated.date;
    endTime = calculated.time;
  } else if (endTime <= time && durationMin > 0) {
    endDate = addLocalMinutes(date, time, durationMin).date;
  }

  const clientName = cleanText(appointment?.clienteNombre || appointment?.client, 120) || "Clienta sin nombre";
  const staffName = resolveStaffName(appointment, context.staff || []);
  const serviceName = cleanText(appointment?.servicio || appointment?.service, 160) || "Servicio";
  const status = cleanText(appointment?.estado || appointment?.status, 60) || "Programada";
  const timeZone = cleanText(context.timeZone, 80) || DEFAULT_TIME_ZONE;
  const summary = cleanText(`Cita: ${clientName} — ${staffName}`, 180);
  const colorId = resolveStaffCalendarColorId(appointment, context.staff || []);
  const description = [
    `Clienta: ${clientName}`,
    `Manicurista: ${staffName}`,
    `Servicio: ${serviceName}`,
    `Horario: ${time}–${endTime}`,
    `Estado: ${status}`,
    `Reserva ERP: ${reservationId}`,
  ].join("\n");

  return {
    reservationId,
    cancelled: isCancelled(appointment),
    event: {
      summary,
      description,
      ...(colorId ? { colorId } : {}),
      visibility: "private",
      start: { dateTime: `${date}T${time}:00`, timeZone },
      end: { dateTime: `${endDate}T${endTime}:00`, timeZone },
      extendedProperties: {
        private: {
          erpReservationId: reservationId,
          erpSource: "dalfi-erp",
        },
      },
    },
  };
}

function appointmentFingerprint(appointment, context = {}) {
  const built = buildGoogleCalendarEvent(appointment, context);
  if (!built) return "invalid";
  return JSON.stringify({ cancelled: built.cancelled, event: built.event });
}

export function diffCalendarAppointments(before = [], after = [], context = {}) {
  const beforeById = new Map(
    before
      .filter(Boolean)
      .map((appointment) => [String(appointment.reservaID || appointment.id || appointment.appointmentId || ""), appointment])
      .filter(([id]) => id),
  );
  const afterById = new Map(
    after
      .filter(Boolean)
      .map((appointment) => [String(appointment.reservaID || appointment.id || appointment.appointmentId || ""), appointment])
      .filter(([id]) => id),
  );
  const changed = [];

  for (const [id, appointment] of afterById) {
    const previous = beforeById.get(id);
    if (!previous || appointmentFingerprint(previous, context) !== appointmentFingerprint(appointment, context)) {
      changed.push(appointment);
    }
  }
  for (const [id, appointment] of beforeById) {
    if (!afterById.has(id)) changed.push({ ...appointment, estado: "Cancelada" });
  }
  return changed;
}

function publicFailure(code, appointmentId = null) {
  return { ok: false, skipped: false, code, appointmentId };
}

async function calendarRequest(env, url, options, runtime) {
  const config = googleCalendarConfig(env);
  const tokenProvider = runtime.getAccessToken || getGoogleAccessToken;
  const accessToken = await tokenProvider(env, runtime);
  const fetchImpl = runtime.fetchImpl || fetch;
  return fetchWithTimeout(
    fetchImpl,
    url,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options?.body ? { "Content-Type": "application/json" } : {}),
        ...(options?.headers || {}),
      },
    },
    config.timeoutMs,
  );
}

async function syncThroughAppsScript(config, built, runtime) {
  const fetchImpl = runtime.fetchImpl || fetch;
  const action = built.cancelled ? "delete" : "upsert";
  const response = await fetchWithTimeout(
    fetchImpl,
    config.appsScriptUrl,
    {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        secret: config.appsScriptSecret,
        action,
        appointmentId: built.reservationId,
        event: built.cancelled ? null : built.event,
      }),
    },
    config.timeoutMs,
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.ok) return publicFailure("WEBHOOK_FAILED", built.reservationId);
  return {
    ok: true,
    skipped: false,
    action: cleanText(payload.action, 24) || (built.cancelled ? "deleted" : "updated"),
    appointmentId: built.reservationId,
  };
}

async function appsScriptRequest(config, payload, runtime = {}) {
  const fetchImpl = runtime.fetchImpl || fetch;
  const response = await fetchWithTimeout(
    fetchImpl,
    config.appsScriptUrl,
    {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secret: config.appsScriptSecret, ...payload }),
    },
    config.timeoutMs,
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.ok) throw new Error(cleanText(body?.code, 48) || "WEBHOOK_FAILED");
  return body;
}

export async function listGoogleCalendarEvents(env, window = {}, runtime = {}) {
  const config = googleCalendarConfig(env);
  if (!config.enabled) return { ok: true, skipped: true, events: [], code: "DISABLED" };
  if (!config.configured || config.provider !== "apps_script") {
    return { ok: false, skipped: false, events: [], code: "PULL_PROVIDER_UNAVAILABLE" };
  }
  const from = String(window.from || "");
  const to = String(window.to || "");
  if (!from || !to) return { ok: false, skipped: false, events: [], code: "INVALID_WINDOW" };
  try {
    const body = await appsScriptRequest(config, { action: "list", from, to, limit: Math.min(250, Number(window.limit) || 250) }, runtime);
    return { ok: true, skipped: false, events: Array.isArray(body.events) ? body.events : [], code: "OK" };
  } catch (error) {
    return { ok: false, skipped: false, events: [], code: error?.name === "AbortError" ? "TIMEOUT" : "PULL_FAILED" };
  }
}

export async function claimGoogleCalendarEvent(env, eventId, appointmentId, runtime = {}) {
  const config = googleCalendarConfig(env);
  if (!config.enabled || config.provider !== "apps_script") return { ok: true, skipped: true, code: "DISABLED" };
  if (!config.configured) return publicFailure("NOT_CONFIGURED", appointmentId);
  try {
    const body = await appsScriptRequest(config, {
      action: "claim", eventId: cleanText(eventId, 300), appointmentId: cleanText(appointmentId, 240),
    }, runtime);
    return { ok: true, skipped: false, action: cleanText(body.action, 24) || "claimed", appointmentId };
  } catch {
    return publicFailure("CLAIM_FAILED", appointmentId);
  }
}

export async function syncAppointmentToGoogleCalendar(env, appointment, context = {}, runtime = {}) {
  const config = googleCalendarConfig(env);
  if (!config.enabled) return { ok: true, skipped: true, code: "DISABLED" };
  if (!config.configured) return publicFailure("NOT_CONFIGURED");

  const built = buildGoogleCalendarEvent(appointment, {
    ...context,
    timeZone: config.timeZone,
  });
  if (!built) return publicFailure("INVALID_APPOINTMENT");

  try {
    if (config.provider === "apps_script") {
      return await syncThroughAppsScript(config, built, runtime);
    }
    if (config.provider !== "service_account") {
      return publicFailure("UNSUPPORTED_PROVIDER", built.reservationId);
    }
    const eventId = await googleEventIdForReservation(built.reservationId);
    const calendarPath = `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(config.calendarId)}/events`;
    const eventPath = `${calendarPath}/${encodeURIComponent(eventId)}`;

    if (built.cancelled) {
      const response = await calendarRequest(
        env,
        `${eventPath}?sendUpdates=none`,
        { method: "DELETE" },
        runtime,
      );
      if (response.status === 204 || response.status === 404) {
        return { ok: true, skipped: false, action: "deleted", appointmentId: built.reservationId };
      }
      return publicFailure("DELETE_FAILED", built.reservationId);
    }

    const insertResponse = await calendarRequest(
      env,
      `${calendarPath}?sendUpdates=none`,
      { method: "POST", body: JSON.stringify({ id: eventId, ...built.event }) },
      runtime,
    );
    if (insertResponse.ok) {
      return { ok: true, skipped: false, action: "created", appointmentId: built.reservationId };
    }
    if (insertResponse.status !== 409) return publicFailure("CREATE_FAILED", built.reservationId);

    const patchResponse = await calendarRequest(
      env,
      `${eventPath}?sendUpdates=none`,
      { method: "PATCH", body: JSON.stringify(built.event) },
      runtime,
    );
    if (!patchResponse.ok) return publicFailure("UPDATE_FAILED", built.reservationId);
    return { ok: true, skipped: false, action: "updated", appointmentId: built.reservationId };
  } catch (error) {
    const code = error?.name === "AbortError" ? "TIMEOUT" : "SYNC_ERROR";
    return publicFailure(code, built.reservationId);
  }
}

function documentData(document) {
  return document?.data && typeof document.data === "object" ? document.data : document || {};
}

export async function syncChangedAppointmentsToGoogleCalendar(env, beforeDocument, afterDocument, runtime = {}) {
  const config = googleCalendarConfig(env);
  if (!config.enabled) return { ok: true, skipped: true, code: "DISABLED", total: 0, synced: 0, failed: 0 };
  if (!config.configured) return { ok: false, skipped: false, code: "NOT_CONFIGURED", total: 0, synced: 0, failed: 0 };

  const before = documentData(beforeDocument);
  const after = documentData(afterDocument);
  const context = {
    services: Array.isArray(after.servicios) ? after.servicios : [],
    staff: Array.isArray(after.colaboradores) ? after.colaboradores : [],
  };
  const changes = diffCalendarAppointments(
    Array.isArray(before.reservas) ? before.reservas : [],
    Array.isArray(after.reservas) ? after.reservas : [],
    context,
  );
  const limited = changes.slice(0, config.maxSyncPerSave);
  const results = [];
  for (const appointment of limited) {
    results.push(await syncAppointmentToGoogleCalendar(env, appointment, context, runtime));
  }
  const failed = results.filter((result) => !result.ok).length;
  return {
    ok: failed === 0 && changes.length <= limited.length,
    skipped: changes.length === 0,
    code: changes.length > limited.length ? "BATCH_LIMIT" : failed ? "PARTIAL_FAILURE" : "OK",
    total: changes.length,
    attempted: limited.length,
    synced: results.length - failed,
    failed,
  };
}

export function todayInTimeZone(timeZone = DEFAULT_TIME_ZONE, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}
