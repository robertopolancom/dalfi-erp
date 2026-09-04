import express from "express";
import {
  resolveErpIdentity,
  requireErpPermission,
  upsertErpProfile,
  deleteErpProfile,
  fetchErpProfile,
  normalizeRole,
  permissionOverridesFromProfile,
  sanitizePermissionOverrides,
  PROFILE_PERMISSION_MAP,
  defaultPermissionsForRole,
} from "../functions/api/_lib/authz.js";
import { insertAuditLog, resolveRequester } from "../functions/api/_lib/audit.js";
import { authorizeDatabaseChanges, detectDatabaseChanges } from "../functions/api/_lib/database-authz.js";
import { extractDomainSlice } from "../functions/api/_lib/domain-slices.js";
import { syncChangedAppointmentsToGoogleCalendar } from "../functions/api/_lib/google-calendar.js";
import { registerLegacyBookingApi } from "./legacy-booking-api.mjs";
import { businessMinutesBetween } from "./store.mjs";
import { notifyNewAppointment, notifyDepositReceiptUploaded, notifyDepositReviewPending } from "./email.mjs";
import { normalizeTextForMatching } from "../outputs/lib/booking-engine.js";
import {
  RESERVAPP_ROLES,
  generateOtpCode,
  isClientRole,
  hashPassword,
  hashToken,
  normalizePhone,
  parseCookies,
  publicAccount,
  secureToken,
  sessionCookie,
  verifyPassword,
} from "./reservapp-auth.mjs";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const BOOKING_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const BOOKING_LIMIT_MAX = 25;
const RELAY_OTP_TTL_MS = 10 * 60 * 1000;
const RELAY_OTP_MAX_ATTEMPTS = 5;
const RELAY_OTP_REQUEST_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RELAY_OTP_REQUEST_LIMIT_MAX = 5;

// Ventana de negocio para el recordatorio horario de comprobantes de depósito pendientes de
// revisar (ver POST /api/booking/send-deposit-review-reminders): 8am-11pm hora de Santo
// Domingo, todos los días -- fuera de eso no se manda nada. Fija a propósito (no usa
// business_settings/weekDays de la agenda): es la ventana en la que alguien del personal puede
// razonablemente leer un correo, no el horario de atención al público.
function isWithinDepositReminderWindow(date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Santo_Domingo", hourCycle: "h23", hour: "2-digit" }).format(date),
  );
  return hour >= 8 && hour < 23;
}

function identityStatus(identity) {
  if (identity.error === "unauthenticated") return [401, "Sesion requerida."];
  if (identity.error === "inactive") return [403, "Tu usuario esta inactivo."];
  return [403, "Tu usuario no esta autorizado."];
}

function webRequest(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
  }
  return new Request(`${req.protocol}://${req.get("host")}${req.originalUrl}`, { headers });
}

export function createApp({ store, bookingStore, env = process.env, staticDir, fetchImpl = globalThis.fetch } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  // La SPA del personal (outputs/index.html) carga el cliente de Supabase desde jsdelivr y le
  // habla directo a SUPABASE_URL (el auth legado nunca se migró, ver render.yaml) -- ambos
  // hosts tienen que estar permitidos explícitamente o el CSP rompe el login del personal en
  // vez de solo bloquear ataques. Derivado de env.SUPABASE_URL en vez de hardcodeado para que
  // no se desactualice si el proyecto de Supabase cambia (mismo valor que
  // scripts/write-supabase-config.mjs usa para outputs/supabase-config.js).
  const supabaseOrigin = (() => {
    try { return new URL(String(env.SUPABASE_URL || "")).origin; } catch { return null; }
  })();
  const supabaseConnectSrc = supabaseOrigin ? `${supabaseOrigin} ${supabaseOrigin.replace(/^https:/, "wss:")}` : "";
  const staffCsp = [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${supabaseConnectSrc}`.trim(),
    "img-src 'self' data:",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "same-origin");
    // Solo en respuestas HTML (la SPA) -- las respuestas JSON de /api/* no ejecutan nada en el
    // navegador, así que no necesitan CSP, y aplicarlo ahí sin querer podría interferir con
    // integraciones que sí leen ese header sobre JSON.
    if (!req.path.startsWith("/api/")) res.set("Content-Security-Policy", staffCsp);
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: MAX_BODY_BYTES }));
  app.use(["/api/fast-booking", "/api/reservapp"], (req, res, next) => {
    const allowedOrigin = String(env.FAST_BOOKING_ORIGIN || "https://reservapp.dalfistudio.com").replace(/\/$/, "");
    const origin = String(req.get("origin") || "").replace(/\/$/, "");
    if (origin && origin === allowedOrigin) {
      res.set("Access-Control-Allow-Origin", allowedOrigin);
      res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.set("Access-Control-Allow-Headers", "Authorization,Content-Type,Idempotency-Key");
      res.set("Access-Control-Allow-Credentials", "true");
      res.set("Access-Control-Max-Age", "86400");
      res.vary("Origin");
    }
    if (req.method === "OPTIONS") {
      return origin === allowedOrigin ? res.status(204).end() : res.status(403).end();
    }
    next();
  });
  // GET /api/site-content/:siteKey lo consume dalfistudio.com desde su propio
  // origen (Cloudflare Worker aparte, no este servidor) -- a diferencia del resto del ERP, sí
  // necesita CORS para que el navegador deje leer la respuesta. Es contenido público de solo
  // lectura, sin cookies/Authorization, así que no lleva Allow-Credentials.
  app.use("/api/site-content", (req, res, next) => {
    // La misma página de Nails se sirve desde varios hostnames a la vez (raíz, www y
    // nails), así que esto acepta una LISTA separada por comas y devuelve el origen que
    // coincidió -- nunca "*", porque entonces cualquier sitio podría leer la respuesta.
    const allowedOrigins = String(
      env.SITE_CONTENT_ALLOWED_ORIGIN ||
        "https://dalfistudio.com,https://www.dalfistudio.com,https://nails.dalfistudio.com",
    )
      .split(",")
      .map((value) => value.trim().replace(/\/$/, ""))
      .filter(Boolean);
    const origin = String(req.get("origin") || "").replace(/\/$/, "");
    if (origin && allowedOrigins.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
      res.vary("Origin");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });
  app.use((req, res, next) => {
    const bookingHost = String(env.FAST_BOOKING_HOST || "reservapp.dalfistudio.com").toLowerCase();
    const suiteHost = String(env.SEBEN_SUITE_HOST || "sebensuiteconnect.dalfistudio.com").toLowerCase();
    const requestHost = String(req.hostname || "").toLowerCase();
    if (requestHost === bookingHost && req.path === "/") return res.redirect(302, "/reservar/");
    if (requestHost === suiteHost) res.set("X-Seben-Application", "Seben Suite Connect");
    next();
  });

  const authenticate = async (req, res, next) => {
    try {
      const identity = await resolveErpIdentity(webRequest(req), { ...env, fetch: fetchImpl });
      if (identity.error) {
        const [status, error] = identityStatus(identity);
        return res.status(status).json({ error });
      }
      req.erpIdentity = identity;
      next();
    } catch (error) {
      console.error("auth:", error);
      res.status(503).json({ error: "No se pudo validar la sesion." });
    }
  };

  const bookingHits = new Map();
  const bookingRateLimit = (req, res, next) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    const recent = (bookingHits.get(key) || []).filter((time) => now - time < BOOKING_LIMIT_WINDOW_MS);
    if (recent.length >= BOOKING_LIMIT_MAX) return res.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
    recent.push(now);
    bookingHits.set(key, recent);
    next();
  };

  const validPhone = (value) => {
    const digits = String(value || "").replace(/[^0-9]/g, "");
    return digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
  };
  const validPassword = (value) => String(value || "").length >= 8 && /[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(value) && /[0-9]/.test(value);
  const cleanText = (value, max = 160) => String(value || "").trim().slice(0, max);

  // Distancia de edición clásica -- para tolerar errores de tipografía (acento olvidado, letra
  // de más/menos) al comparar el nombre que el cliente escribe contra el que ya tiene su ficha,
  // sin exigir coincidencia exacta ni depender de un servicio externo de IA.
  const levenshteinDistance = (a, b) => {
    const rows = a.length + 1, cols = b.length + 1;
    const dp = Array.from({ length: rows }, (_, i) => (i === 0 ? Array.from({ length: cols }, (_, j) => j) : [i, ...Array(cols - 1).fill(0)]));
    for (let i = 1; i < rows; i += 1) {
      for (let j = 1; j < cols; j += 1) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp[rows - 1][cols - 1];
  };
  // Compara solo el PRIMER nombre real contra lo que escribió el cliente -- normaliza acentos y
  // mayúsculas (normalizeTextForMatching) y tolera hasta ~1 error de tipografía por cada 4
  // caracteres (mínimo 1) en vez de exigir coincidencia exacta.
  const namesLooselyMatch = (typed, actualFullName) => {
    const a = normalizeTextForMatching(typed);
    const b = normalizeTextForMatching(String(actualFullName || "").trim().split(/\s+/)[0] || "");
    if (!a || !b) return false;
    if (a === b) return true;
    const threshold = Math.max(1, Math.floor(Math.max(a.length, b.length) / 4));
    return levenshteinDistance(a, b) <= threshold;
  };
  const cleanServiceIds = (value) => [...new Set((Array.isArray(value) ? value : String(value || "").split(",")).map((item) => cleanText(item, 64)).filter(Boolean))].slice(0, 12);
  const authorizeEmployeeBooking = async (req) => {
    if (req.body?.actorType !== "employee") return null;
    const identity = await resolveErpIdentity(webRequest(req), { ...env, fetch: fetchImpl });
    if (identity.error || !identity.permissions?.canManageReservations) return false;
    return identity;
  };

  // El flujo público definitivo para crear/vincular un cliente es
  // /api/reservapp/auth/request-setup (crea la ficha internamente y siempre termina en el
  // envío del enlace de credenciales por WhatsApp). client/resolve y clients (POST) no los usa
  // ningún flujo público real — dejarlos accesibles sin autenticación permite enumerar
  // teléfonos/nombres de clientes existentes y llenar la ERP de fichas huérfanas sin pasar por
  // ese flujo. Solo personal autorizado (misma regla que la búsqueda GET /clients) puede
  // usarlos, para herramientas administrativas internas.
  const requireBookingStaff = async (req, res) => {
    const session = await reservappSession(req);
    if (session && ["manicurista", "asistente", "administradora", "superadministrador"].includes(session.account.role)) return true;
    const identity = await resolveErpIdentity(webRequest(req), { ...env, fetch: fetchImpl });
    if (identity.error || !identity.permissions?.canManageReservations) {
      res.status(403).json({ error: "No tienes permiso para gestionar clientes." });
      return false;
    }
    return true;
  };

  // La manicurista puede crear un cliente nuevo directamente con solo su
  // teléfono, igual que asistente/administradora -- la verificación real ya
  // no ocurre aquí. Se mueve al punto donde el cliente usa esa identidad de
  // verdad: crear sus credenciales de ReservApp (código de WhatsApp + luego
  // contraseña) o confirmar una cita agendada por el chatbot (código de
  // WhatsApp en la misma conversación). relay-otp/{request,confirm} sigue
  // existiendo como mecanismo disponible, pero ya no es obligatorio aquí.

  const relayOtpHits = new Map();
  const relayOtpRequestLimit = (accountId) => {
    const now = Date.now();
    const recent = (relayOtpHits.get(accountId) || []).filter((time) => now - time < RELAY_OTP_REQUEST_LIMIT_WINDOW_MS);
    if (recent.length >= RELAY_OTP_REQUEST_LIMIT_MAX) return false;
    recent.push(now);
    relayOtpHits.set(accountId, recent);
    return true;
  };

  // bookingHits/relayOtpHits solo se filtraban al consultarlos -- una IP o cuenta que pega una
  // sola vez se queda como entrada en el mapa para siempre, aunque su ventana ya expiró (fuga de
  // memoria lenta, hallazgo de la auditoría de seguridad, 2026-08-23). Barrido periódico que
  // borra las claves sin actividad reciente; unref() para no impedir que el proceso cierre limpio.
  const pruneHitMap = (map, windowMs) => {
    const now = Date.now();
    for (const [key, timestamps] of map) {
      const recent = timestamps.filter((time) => now - time < windowMs);
      if (recent.length === 0) map.delete(key);
      else map.set(key, recent);
    }
  };
  const rateLimitSweep = setInterval(() => {
    pruneHitMap(bookingHits, BOOKING_LIMIT_WINDOW_MS);
    pruneHitMap(relayOtpHits, RELAY_OTP_REQUEST_LIMIT_WINDOW_MS);
  }, 5 * 60 * 1000);
  rateLimitSweep.unref?.();

  // "Mi disponibilidad" (autoservicio, ver /my-schedule-exceptions más abajo) -- restringido a
  // administradora/superadministrador. Antes cualquier manicurista/asistente podía bloquear su
  // propio horario; a pedido explícito del dueño del negocio, ahora solo administración puede
  // bloquear horas (propias o de cualquier colaboradora, ver /admin/staff-schedule-exceptions).
  const requireAdministradoraSession = async (req, res) => {
    const session = await reservappSession(req);
    if (session && ["administradora", "superadministrador"].includes(session.account.role)) return session;
    res.status(403).json({ error: "No tienes permiso para esta acción." });
    return null;
  };

  // Relay OTP (verificar el teléfono de un cliente nuevo antes de agendarle una cita, ver más
  // abajo) sí sigue abierto a cualquier colaboradora -- la restricción de arriba es solo para
  // "Mi disponibilidad", no para esto.
  const requireManicuristaOrAbove = async (req, res) => {
    const session = await reservappSession(req);
    if (session && ["manicurista", "asistente", "administradora", "superadministrador"].includes(session.account.role)) return session;
    res.status(403).json({ error: "No tienes permiso para esta acción." });
    return null;
  };

  const reservappSession = async (req) => {
    const token = parseCookies(req.get("cookie")).reservapp_session;
    if (!token) return null;
    const account = await bookingStore?.sessionAccount(hashToken(token));
    return account ? { account, token } : null;
  };
  const requireReservapp = async (req, res, next) => {
    try {
      const session = await reservappSession(req);
      if (!session) return res.status(401).json({ error: "Inicia sesión para continuar." });
      req.reservapp = session;
      next();
    } catch (error) { next(error); }
  };

  const sendSetupWhatsApp = async ({ outboxId, phone, code, name, purpose = "setup" }) => {
    const bridgeSecret = String(env.ERP_WEBHOOK_SECRET || "");
    if (!bridgeSecret) return { status: "pending_configuration" };
    const bridgeBase = String(env.CHATBOT_BRIDGE_URL || "https://bot.dalfistudio.com").replace(/\/$/, "");
    // El siguiente paso (verify-code -> complete-setup) es idéntico para setup y reset -- solo
    // cambia este texto para no confundir a alguien restableciendo su contraseña con el
    // mensaje de "primera vez".
    const bodyText = purpose === "reset"
      ? `Hola ${name || ""}. Tu código para restablecer tu contraseña en Dalfi Studio Nails es: ${code}. Vence en 10 minutos.`.trim()
      : `Hola ${name || ""}. Tu código para crear tu contraseña en Dalfi Studio Nails es: ${code}. Vence en 10 minutos.`.trim();
    try {
      // Endpoint dedicado (no /webhook/overdue-reminders, que solo entiende
      // booking.confirmation_reminder y devuelve 200 IGNORED/UNKNOWN_EVENT para cualquier otro
      // evento). Con un endpoint compartido, un 200 no confirmaba que el WhatsApp se hubiera
      // enviado de verdad, así que hay que leer el cuerpo y solo marcar "sent" si el bridge
      // confirma status: "SENT" explícitamente.
      //
      // Código de 6 dígitos, no enlace mágico: el cliente lo escribe en la app para probar que
      // controla ese teléfono (POST /api/reservapp/setup/verify-code) y solo después se le pide
      // definir una contraseña -- dos pasos separados, ver activateWithToken/verifySetupOtp.
      const response = await fetchImpl(`${bridgeBase}/webhook/reservapp-activation`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-webhook-secret": bridgeSecret },
        body: JSON.stringify({
          event: "reservapp.account_setup",
          actionRequired: "send_activation_code",
          recipientPhone: normalizePhone(phone),
          clientName: name || "Cliente",
          code,
          whatsappFormattedText: bodyText,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.status !== "SENT") {
        throw new Error(`Bridge did not confirm delivery: ${payload?.status || payload?.reason || `HTTP_${response.status}`}`);
      }
      await bookingStore.markWhatsApp({ outboxId, status: "sent" });
      return { status: "sent" };
    } catch (error) {
      await bookingStore.markWhatsApp({ outboxId, status: "failed", error: cleanText(error.message, 300) });
      return { status: "failed" };
    }
  };

  // Mismo contrato de entrega que sendSetupWhatsApp (solo marca "sent" si el
  // bridge confirma status:"SENT" explícitamente) pero para el código de 6
  // dígitos del relay de manicurista, no el enlace de autorregistro.
  const sendRelayOtpWhatsApp = async ({ outboxId, phone, code, name }) => {
    const bridgeSecret = String(env.ERP_WEBHOOK_SECRET || "");
    if (!bridgeSecret) return { status: "pending_configuration" };
    const bridgeBase = String(env.CHATBOT_BRIDGE_URL || "https://bot.dalfistudio.com").replace(/\/$/, "");
    try {
      const response = await fetchImpl(`${bridgeBase}/webhook/reservapp-activation`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-webhook-secret": bridgeSecret },
        body: JSON.stringify({
          event: "reservapp.relay_otp",
          actionRequired: "send_relay_code",
          recipientPhone: normalizePhone(phone),
          clientName: name || "Cliente",
          code,
          whatsappFormattedText: `Hola ${name || ""}. Tu código para confirmar tu cita en Dalfi Studio Nails es: ${code}. Vence en 10 minutos.`.trim(),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.status !== "SENT") {
        throw new Error(`Bridge did not confirm delivery: ${payload?.status || payload?.reason || `HTTP_${response.status}`}`);
      }
      await bookingStore.markWhatsApp({ outboxId, status: "sent" });
      return { status: "sent" };
    } catch (error) {
      await bookingStore.markWhatsApp({ outboxId, status: "failed", error: cleanText(error.message, 300) });
      return { status: "failed" };
    }
  };

  // Recordatorio/escalación de confirmación de asistencia (ver checkConfirmationReminder más
  // abajo) -- mismo evento y endpoint del bridge que ya usaba functions/api/booking/send-reminders.js
  // (proyecto de Cloudflare Pages ya eliminado), así que el propio Chatbot Bridge no necesita
  // ningún cambio: sigue atendiendo la respuesta del cliente con su menú
  // "1. Confirmar mi hora / 2. Reagendar / 3. Menú principal" y llamando de vuelta a
  // POST /api/reservapp/booking/confirm-attendance cuando confirma. No usa outbox (no es un
  // código de un solo uso, es un aviso reintentable cada hora por el propio cron si falla).
  const sendConfirmationReminderWhatsApp = async ({ reservationId, phone, clientName, date, time, service, stage }) => {
    const bridgeSecret = String(env.ERP_WEBHOOK_SECRET || "");
    if (!bridgeSecret) return { ok: false, reason: "pending_configuration" };
    const bridgeBase = String(env.CHATBOT_BRIDGE_URL || "https://bot.dalfistudio.com").replace(/\/$/, "");
    const text = stage === "second"
      ? `Hola ${clientName || ""}. Tu cita de ${service || "tu servicio"} el ${date} a las ${time} está a punto de liberarse porque no hemos recibido tu confirmación. Responde "1" para confirmar tu hora ahora mismo, o la podríamos ofrecer a otro cliente.`.trim()
      : `Hola ${clientName || ""}. Recuerda tu cita de ${service || "tu servicio"} hoy/mañana ${date} a las ${time}. Responde "1" para confirmar tu asistencia o "2" para reagendar.`.trim();
    try {
      const response = await fetchImpl(`${bridgeBase}/webhook/overdue-reminders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-webhook-secret": bridgeSecret },
        body: JSON.stringify({
          event: "booking.confirmation_reminder",
          actionRequired: "await_customer_reply",
          reservationId,
          recipientPhone: normalizePhone(phone),
          whatsappFormattedText: text,
        }),
      });
      const body = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  if (bookingStore) {
    // El nuevo flujo pide identificarse ANTES de elegir servicios (pedido explícito de diseño:
    // "atención personalizada" desde el primer clic en "Reservar", no al final). Para el botón
    // "Es mi primera vez" primero solo se pide el teléfono -- este endpoint dice si ya existe
    // una ficha con ese número, SIN revelar el nombre (auditoría de seguridad 2026-08-25: antes
    // devolvía el primer nombre aquí, lo que dejaba adivinar qué teléfonos son clientes reales
    // con solo probar números). Confirmar la identidad de verdad ahora es responsabilidad de
    // /auth/verify-name, que el cliente pasa escribiendo SU nombre, no leyéndolo del servidor.
    app.post("/api/reservapp/auth/check-phone", bookingRateLimit, async (req, res, next) => {
      const phone = cleanText(req.body?.phone, 30);
      if (!validPhone(phone)) return res.status(400).json({ error: "Escribe un teléfono válido." });
      try {
        const existing = await bookingStore.accountByPhone(phone);
        // password_hash (no status) es la señal real de "ya tiene contraseña creada" -- una
        // cuenta de personal o cliente puede existir en estado "pending" (invitada, nunca activó)
        // sin haber definido ninguna todavía, y eso NO es lo mismo que iniciar sesión.
        if (existing?.password_hash) return res.json({ exists: true });
        if (existing) return res.json({ exists: true, needsPasswordOnly: true });
        // Sin cuenta de ReservApp en absoluto -- pero puede que ya sea cliente del salón (ficha
        // creada directamente en el ERP, por el personal, o en una visita anterior). En ese caso
        // no hace falta pedirle de nuevo nombre/apellido/fecha de nacimiento: ya los tenemos,
        // solo falta que defina su contraseña (ver request-setup, que ya reconoce esta misma
        // ficha por teléfono y se salta esos campos).
        const customer = await bookingStore.resolveClient({ phone });
        if (customer) return res.json({ exists: true, needsPasswordOnly: true });
        res.json({ exists: false });
      } catch (error) { next(error); }
    });

    // Confirma identidad sin que el servidor revele el nombre: el cliente escribe el suyo, y se
    // compara (tolerando errores de tipografía -- acentos, una letra de más/menos) contra el
    // primer nombre real de la ficha que corresponde a ese teléfono. Nunca devuelve el nombre
    // real ni distingue "el teléfono no existe" de "el nombre no coincidió" -- misma respuesta
    // genérica en ambos casos, para no servir de oráculo de enumeración.
    app.post("/api/reservapp/auth/verify-name", bookingRateLimit, async (req, res, next) => {
      const phone = cleanText(req.body?.phone, 30);
      const firstName = cleanText(req.body?.firstName, 80);
      if (!validPhone(phone) || !firstName) return res.status(400).json({ error: "Escribe tu nombre para continuar." });
      try {
        const existing = await bookingStore.accountByPhone(phone);
        const actualName = existing?.full_name || (await bookingStore.resolveClient({ phone }))?.full_name || "";
        const verified = Boolean(actualName) && namesLooselyMatch(firstName, actualName);
        res.json({ verified });
      } catch (error) { next(error); }
    });

    app.post("/api/reservapp/auth/request-setup", bookingRateLimit, async (req, res, next) => {
      if (req.body?.website) return res.status(204).end();
      const firstName = cleanText(req.body?.firstName, 80);
      const lastName = cleanText(req.body?.lastName, 80);
      const phone = cleanText(req.body?.phone, 30);
      const email = cleanText(req.body?.email, 160).toLowerCase();
      const birthDate = cleanText(req.body?.birthDate, 10);
      const sex = ["Femenino", "Masculino"].includes(req.body?.sex) ? req.body.sex : "";
      const address = cleanText(req.body?.address, 300);
      const preferredService = cleanText(req.body?.preferredService, 160);
      const serviceIds = cleanServiceIds(req.body?.serviceIds);
      const draft = {
        serviceIds,
        staffId: cleanText(req.body?.staffId, 64),
        date: cleanText(req.body?.date, 10),
        time: cleanText(req.body?.time, 5),
        notes: cleanText(req.body?.notes, 500),
        idempotencyKey: cleanText(req.get("Idempotency-Key") || req.body?.idempotencyKey, 120) || crypto.randomUUID(),
      };
      if (!validPhone(phone)) return res.status(400).json({ error: "Introduce un teléfono válido." });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "El correo no tiene un formato válido." });
      // Registrarse (crear cuenta) no requiere tener ya un horario elegido --
      // solo si el cliente arrancó desde el wizard de reserva vendrá un
      // borrador adjunto, y en ese caso sí debe venir completo.
      const hasDraftIntent = Boolean(serviceIds.length || draft.staffId || draft.date || draft.time);
      if (hasDraftIntent && (!serviceIds.length || !draft.staffId || !/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || !/^\d{2}:\d{2}$/.test(draft.time))) {
        return res.status(400).json({ error: "Selecciona servicios, manicurista, fecha y hora, o deja todo vacío para solo crear tu cuenta." });
      }
      try {
        // Si YA existe cualquier cuenta de ReservApp con este teléfono (de personal o de
        // cliente) sin contraseña definida todavía, se reutiliza tal cual -- nunca se crea una
        // ficha ni cuenta nueva encima. Cubre tanto una cuenta de personal invitada que nunca
        // completó su activación (status "pending") como un cliente que ya empezó este mismo
        // flujo antes. Con contraseña ya definida, sigue el candado de siempre (abajo).
        const existingAccount = await bookingStore.accountByPhone(phone);
        if (existingAccount && !existingAccount.password_hash) {
          const code = generateOtpCode();
          const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
          const prepared = await bookingStore.prepareSetup({ accountId: existingAccount.id, tokenHash: hashToken(code), expiresAt, recipientPhone: phone, draft: hasDraftIntent ? draft : null });
          // TEMPORAL: ver comentario junto a RESERVAPP_SKIP_PHONE_VERIFICATION más abajo -- mismo
          // interruptor, mismo mecanismo, solo que reutilizando una cuenta ya existente.
          if (String(env.RESERVAPP_SKIP_PHONE_VERIFICATION || "") === "true") {
            const activationTicket = secureToken();
            const newExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
            const verify = await bookingStore.verifySetupOtp({ accountId: existingAccount.id, codeHash: hashToken(code), newTokenHash: hashToken(activationTicket), newExpiresAt });
            if (!verify.notFound && !verify.locked && !verify.invalid) {
              return res.status(202).json({
                pendingConfirmation: false,
                bypassedPhoneVerification: true,
                activationTicket,
                message: "Verificación de WhatsApp deshabilitada temporalmente. Crea tu contraseña para confirmar la cita.",
              });
            }
          }
          const delivery = await sendSetupWhatsApp({ outboxId: prepared.outbox.id, phone, code, name: existingAccount.full_name || "" });
          return res.status(202).json({
            pendingConfirmation: true,
            deliveryStatus: delivery.status,
            expiresInSeconds: 600,
            message: "Te enviamos por WhatsApp un código para crear tu contraseña.",
            ...(String(env.RESERVAPP_EXPOSE_OTP_CODE || "") === "true" ? { code } : {}),
          });
        }
        const existingClient = await bookingStore.resolveClient({ phone });
        // Si el teléfono ya corresponde a una ficha del salón (creada en el ERP directamente, por
        // el personal, o en una visita anterior), no hace falta volver a pedir nombre/apellido/
        // fecha de nacimiento -- ya los tenemos. Solo un cliente realmente nuevo debe completar
        // el formulario entero.
        if (!existingClient) {
          if (!firstName || !lastName) return res.status(400).json({ error: "Nombre, apellido y teléfono válido son obligatorios." });
          if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || birthDate > new Date().toISOString().slice(0, 10)) {
            return res.status(400).json({ error: "Introduce una fecha de nacimiento válida." });
          }
        }
        if (hasDraftIntent) {
          const availability = await bookingStore.availability({ ...draft, serviceIds });
          if (!availability.slots?.some((slot) => slot.staffId === draft.staffId && slot.time === draft.time)) {
            return res.status(409).json({ error: "Ese horario acaba de ocuparse. Elige otro.", conflict: true });
          }
        }
        // Salvaguarda ante condición de carrera (otra solicitud creó la cuenta justo después del
        // chequeo de arriba) -- normalmente ya se resolvió en la rama de existingAccount.
        const existing = await bookingStore.accountByPhone(phone);
        if (existing?.password_hash) {
          // Nunca revela el nombre aquí (ver /auth/check-phone y /auth/verify-name) -- este
          // camino solo se alcanza si hubo una condición de carrera real, así que el frontend ya
          // habría verificado el nombre antes de llegar aquí en el flujo normal.
          return res.status(409).json({ error: "Ese teléfono ya tiene credenciales. Inicia sesión para reservar.", accountExists: true });
        }
        // A diferencia de antes, aquí NO se crea todavía ni la ficha en la ERP ni la cuenta de
        // ReservApp -- eso quedaría como una ficha fantasma si la persona abandona el formulario
        // sin llegar a poner su contraseña. En vez de eso, sus datos quedan guardados aparte en
        // reservapp_pending_registrations (ver store.mjs: createPendingRegistration) hasta que de
        // verdad confirme el código y ponga su contraseña -- ahí, y solo ahí, completePendingRegistration
        // consulta la ERP por su teléfono y crea (o enlaza) la ficha real. Si abandona aquí, no
        // queda ningún rastro ni en la ERP ni en ReservApp.
        const code = generateOtpCode();
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        const registration = existingClient ? null : { firstName, lastName, email, birthDate, sex, address, preferredService };
        await bookingStore.createPendingRegistration({
          phone, existingClientId: existingClient?.id || null, registration,
          draft: hasDraftIntent ? draft : null, tokenHash: hashToken(code), expiresAt,
        });
        // TEMPORAL (quitar cuando Meta apruebe WHATSAPP_ACTIVATION_TEMPLATE_NAME en el bridge de
        // WhatsApp -- dalfi-chatbot-n8n): sin esa plantilla aprobada, el bridge no puede iniciar
        // conversación con un cliente nuevo (fuera de la ventana de 24h) y el código de
        // verificación nunca llega, dejando el autorregistro completamente bloqueado. Con
        // RESERVAPP_SKIP_PHONE_VERIFICATION=true nos "autoverificamos" el mismo código que
        // acabamos de generar (mismo verifyPendingRegistrationOtp que usa /setup/verify-code,
        // mismas reglas de expiración/consumo de un solo uso) y devolvemos el activationTicket
        // directo, sin pasar por WhatsApp. El cliente sigue eligiendo su propia contraseña -- lo
        // único que se salta es la prueba de que controla ese teléfono. Para revertir: borrar
        // esta rama `if` y la env var en Render, no hace falta tocar nada más.
        if (String(env.RESERVAPP_SKIP_PHONE_VERIFICATION || "") === "true") {
          const activationTicket = secureToken();
          const newExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
          const verify = await bookingStore.verifyPendingRegistrationOtp({ phone, codeHash: hashToken(code), newTokenHash: hashToken(activationTicket), newExpiresAt });
          if (!verify.notFound && !verify.locked && !verify.invalid) {
            return res.status(202).json({
              pendingConfirmation: false,
              bypassedPhoneVerification: true,
              activationTicket,
              message: "Verificación de WhatsApp deshabilitada temporalmente. Crea tu contraseña para confirmar la cita.",
            });
          }
        }
        // firstName/lastName solo llegan si es un cliente realmente nuevo (ver validación
        // arriba) -- si ya existía en el ERP, usa el nombre que ya tenía su ficha.
        const displayName = firstName && lastName ? `${firstName} ${lastName}` : existingClient.full_name;
        // TEMPORAL: mientras RESERVAPP_SKIP_PHONE_VERIFICATION=true, la rama de arriba siempre
        // retorna antes de llegar aquí, así que este envío real nunca se ejecuta hoy.
        // createPendingRegistration todavía no inserta fila en reservapp_whatsapp_outbox -- el
        // día que se apague el interruptor y este camino vuelva a ejecutarse de verdad, hace
        // falta añadir ese insert (mismo patrón que prepareSetup) antes de confiar en el registro
        // de entregas de sendSetupWhatsApp. outboxId va en null a propósito mientras tanto.
        const delivery = await sendSetupWhatsApp({ outboxId: null, phone, code, name: displayName });
        res.status(202).json({
          pendingConfirmation: true,
          deliveryStatus: delivery.status,
          expiresInSeconds: 600,
          message: "Te enviamos por WhatsApp un código para crear tu contraseña y confirmar la cita.",
          ...(String(env.RESERVAPP_EXPOSE_OTP_CODE || "") === "true" ? { code } : {}),
        });
      } catch (error) {
        if (error?.code === "PHONE_ACCOUNT_CONFLICT") return res.status(409).json({ error: error.message });
        next(error);
      }
    });

    // Primer paso del setup en dos pasos: probar que el cliente/colaboradora controla el
    // teléfono con el código de 6 dígitos que le llegó por WhatsApp. Si es correcto, rota el
    // token en reservapp_setup_tokens a un secreto nuevo largo (el "activationTicket") que
    // /api/reservapp/auth/complete-setup consume para fijar la contraseña -- ese endpoint no
    // cambia, sigue esperando el mismo tipo de token que siempre consumió.
    app.post("/api/reservapp/setup/verify-code", bookingRateLimit, async (req, res, next) => {
      const phone = cleanText(req.body?.phone, 30);
      const code = cleanText(req.body?.code, 6);
      if (!validPhone(phone) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: "Código inválido." });
      try {
        const account = await bookingStore.accountByPhone(phone);
        const activationTicket = secureToken();
        const newExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        // Cuenta ya existente (invitación de personal, o alguien que ya tenía cuenta antes de
        // este cambio) -- camino de siempre, sin tocar. Si no hay cuenta, es un autorregistro
        // nuevo: el código vive en reservapp_pending_registrations, no en reservapp_setup_tokens,
        // porque todavía no existe ninguna cuenta a la que colgarlo.
        const result = account
          ? await bookingStore.verifySetupOtp({ accountId: account.id, codeHash: hashToken(code), newTokenHash: hashToken(activationTicket), newExpiresAt })
          : await bookingStore.verifyPendingRegistrationOtp({ phone, codeHash: hashToken(code), newTokenHash: hashToken(activationTicket), newExpiresAt });
        if (result.locked) return res.status(429).json({ error: "Demasiados intentos. Solicita un nuevo código.", code: "OTP_LOCKED" });
        if (result.notFound) return res.status(410).json({ error: "El código venció o no fue solicitado. Solicita uno nuevo.", code: "OTP_NOT_FOUND" });
        if (result.invalid) return res.status(401).json({ error: "Código incorrecto.", code: "OTP_INVALID", attemptsRemaining: result.attemptsRemaining });
        res.json({ verified: true, activationTicket });
      } catch (error) { next(error); }
    });

    app.post("/api/reservapp/auth/complete-setup", bookingRateLimit, async (req, res, next) => {
      const token = cleanText(req.body?.token, 180);
      const password = String(req.body?.password || "");
      if (!token || !validPassword(password)) return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres, una letra y un número." });
      try {
        const sessionToken = secureToken();
        const sessionExpiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
        const tokenHash = hashToken(token);
        const passwordHash = await hashPassword(password);
        const sessionTokenHash = hashToken(sessionToken);
        // Primero el camino de siempre (cuenta ya existente -- invitación de personal, o un
        // cliente/clienta de antes de este cambio): activateWithToken. Si no encuentra el token
        // ahí, es porque viene del autorregistro nuevo, donde todavía no existía ninguna cuenta
        // -- completePendingRegistration recién ahí consulta la ERP por el teléfono y crea (o
        // enlaza) la ficha real y la cuenta de ReservApp. Devuelve la misma forma que
        // activateWithToken para que el resto de esta ruta no tenga que distinguir entre las dos.
        let account = await bookingStore.activateWithToken({ tokenHash, passwordHash, sessionTokenHash, sessionExpiresAt });
        if (!account) account = await bookingStore.completePendingRegistration({ tokenHash, passwordHash, sessionTokenHash, sessionExpiresAt });
        if (!account) return res.status(410).json({ error: "El enlace venció o ya fue utilizado. Solicita uno nuevo." });
        let appointment = null;
        let bookingError = null;
        if (account.draft) {
          const input = {
            clientId: account.client_id,
            serviceIds: account.draft.service_ids,
            staffId: account.draft.staff_id,
            date: String(account.draft.appointment_date).slice(0, 10),
            time: String(account.draft.appointment_time).slice(0, 5),
            notes: account.draft.notes || "",
            source: "RESERVAPP_CLIENTE",
            createdBy: { role: "cliente", accountId: account.account_id },
            idempotencyKey: account.draft.idempotency_key,
          };
          const availability = await bookingStore.availability(input);
          if (availability.slots?.some((slot) => slot.staffId === input.staffId && slot.time === input.time)) {
            input.endTime = new Date(new Date(`2000-01-01T${input.time}:00Z`).getTime() + availability.durationMinutes * 60_000).toISOString().slice(11, 16);
            const created = await bookingStore.createAppointment(input);
            if (!created.conflict && !created.missing) {
              appointment = { id: created.appointment.id, reference: created.appointment.legacy_id };
              // account.draft.id solo existe cuando el borrador venía de reservapp_booking_drafts
              // (camino de activateWithToken) -- el de completePendingRegistration nunca crea esa
              // fila, así que no hay nada que marcar "confirmado" ahí.
              if (account.draft.id) await bookingStore.markDraftConfirmed(account.draft.id, created.appointment.id);
              if (!created.idempotent) await syncChangedAppointmentsToGoogleCalendar(env, created.previousDocument, created.document, { fetchImpl });
            } else bookingError = "Tu cuenta quedó activa, pero el horario se ocupó. Inicia sesión y elige otro.";
          } else bookingError = "Tu cuenta quedó activa, pero el horario se ocupó. Inicia sesión y elige otro.";
        }
        res.set("Set-Cookie", sessionCookie(sessionToken, 30 * 86_400));
        res.json({ account: publicAccount(account), appointment, bookingError });
      } catch (error) {
        if (error?.code === "PHONE_ACCOUNT_CONFLICT") return res.status(409).json({ error: error.message });
        if (error?.code === "PENDING_REGISTRATION_CLIENT_GONE") return res.status(410).json({ error: error.message });
        next(error);
      }
    });

    app.post("/api/reservapp/auth/login", bookingRateLimit, async (req, res, next) => {
      const phone = cleanText(req.body?.phone, 30);
      const password = String(req.body?.password || "");
      if (!validPhone(phone) || !password) return res.status(400).json({ error: "Escribe tu teléfono y contraseña." });
      try {
        const account = await bookingStore.accountByPhone(phone);
        const correct = account?.status === "active" && await verifyPassword(password, account.password_hash);
        if (!correct) return res.status(401).json({ error: "Teléfono o contraseña incorrectos." });
        const sessionToken = secureToken();
        const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
        await bookingStore.createSession({ accountId: account.id, tokenHash: hashToken(sessionToken), expiresAt });
        res.set("Set-Cookie", sessionCookie(sessionToken, 30 * 86_400));
        res.json({ account: publicAccount(account) });
      } catch (error) { next(error); }
    });

    // Reutiliza el mismo pipeline de OTP que el setup de cuenta nueva (prepareSetup ->
    // /setup/verify-code -> /auth/complete-setup) -- verify-code y complete-setup no necesitan
    // saber si vinieron de aquí o de request-setup, solo consumen el token/OTP que sea. La
    // única diferencia real es que aquí NO se crea un cliente nuevo ni se adjunta un draft de
    // cita, y solo procede si la cuenta ya existe y está activa.
    app.post("/api/reservapp/auth/request-password-reset", bookingRateLimit, async (req, res, next) => {
      const phone = cleanText(req.body?.phone, 30);
      if (!validPhone(phone)) return res.status(400).json({ error: "Introduce un teléfono válido de 10 dígitos." });
      try {
        const account = await bookingStore.accountByPhone(phone);
        if (account?.password_hash) {
          // TEMPORAL A PROPÓSITO (pedido explícito del dueño del negocio, 2026-08-25): estamos
          // esperando a que Meta apruebe la verificación de la empresa -- hasta entonces el
          // bridge no puede mandar códigos reales por WhatsApp, y RESERVAPP_SKIP_PHONE_VERIFICATION
          // se queda en "true". Mientras tanto, /auth/verify-name + /auth/set-password-after-verification
          // reemplazan el código real: el cliente confirma su identidad escribiendo su nombre en
          // vez de recibir un código. Cuando Meta apruebe y se apague el interruptor, este mismo
          // bloque vuelve a mandar el código real (rama de abajo) -- no borrar esa rama.
          if (String(env.RESERVAPP_SKIP_PHONE_VERIFICATION || "") === "true") {
            return res.json({ pendingConfirmation: false, needsNameConfirmation: true });
          }
          const code = generateOtpCode();
          const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
          const prepared = await bookingStore.prepareSetup({ accountId: account.id, tokenHash: hashToken(code), expiresAt, recipientPhone: phone });
          await sendSetupWhatsApp({ outboxId: prepared.outbox.id, phone, code, name: account.full_name || "", purpose: "reset" });
          return res.status(202).json({
            pendingConfirmation: true,
            message: "Si ese teléfono tiene una cuenta activa, te enviamos por WhatsApp un código para restablecer tu contraseña.",
          });
        }
        // Sin contraseña creada todavía: no necesariamente "olvidó" la suya -- puede que nunca
        // haya definido ninguna (cuenta de personal invitada sin activar, o ficha del ERP sin
        // credenciales de ReservApp todavía -- mismos dos casos que reconoce /auth/check-phone).
        if (account) return res.json({ pendingConfirmation: false, needsNameConfirmation: true });
        const customer = await bookingStore.resolveClient({ phone });
        if (customer) return res.json({ pendingConfirmation: false, needsNameConfirmation: true });
        // Ni cuenta ni ficha -- misma respuesta genérica que antes, este endpoint no debe servir
        // para enumerar qué teléfonos existen en el sistema.
        res.status(202).json({
          pendingConfirmation: true,
          message: "Si ese teléfono tiene una cuenta activa, te enviamos por WhatsApp un código para restablecer tu contraseña.",
        });
      } catch (error) { next(error); }
    });

    // Autoservicio de contraseña una vez confirmada la identidad por nombre (/auth/verify-name):
    // sirve tanto para crear la contraseña por primera vez como para reemplazar una que ya no
    // recuerda -- misma acción en ambos casos, sin distinguir, porque desde aquí solo importa
    // "ya sé quién dice ser, déjala definir una contraseña". Vuelve a verificar el nombre aquí
    // mismo (nunca confía en que el frontend ya lo hizo en /auth/verify-name) y NUNCA reactiva
    // una cuenta que administración suspendió/bloqueó a propósito -- esa sigue exigiendo que
    // administración la reinicie (POST /admin/accounts/:id/reset-password o "Reiniciar acceso").
    app.post("/api/reservapp/auth/set-password-after-verification", bookingRateLimit, async (req, res, next) => {
      const phone = cleanText(req.body?.phone, 30);
      const firstName = cleanText(req.body?.firstName, 80);
      const password = String(req.body?.password || "");
      if (!validPhone(phone) || !firstName) return res.status(400).json({ error: "Escribe tu nombre para continuar." });
      if (!validPassword(password)) return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres, una letra y un número." });
      // Borrador de cita opcional (si venía de reservar y se identificó a mitad del wizard) --
      // mismo criterio que request-setup: solo se valida/crea si de verdad hay una selección
      // completa, nunca a medias.
      const serviceIds = cleanServiceIds(req.body?.serviceIds);
      const draft = {
        serviceIds, staffId: cleanText(req.body?.staffId, 64), date: cleanText(req.body?.date, 10),
        time: cleanText(req.body?.time, 5), notes: cleanText(req.body?.notes, 500),
      };
      const hasDraftIntent = Boolean(serviceIds.length || draft.staffId || draft.date || draft.time);
      if (hasDraftIntent && (!serviceIds.length || !draft.staffId || !/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || !/^\d{2}:\d{2}$/.test(draft.time))) {
        return res.status(400).json({ error: "Selecciona servicios, manicurista, fecha y hora, o deja todo vacío para solo definir tu contraseña." });
      }
      try {
        const existingAccount = await bookingStore.accountByPhone(phone);
        const customer = existingAccount ? null : await bookingStore.resolveClient({ phone });
        const actualName = existingAccount?.full_name || customer?.full_name || "";
        if (!actualName || !namesLooselyMatch(firstName, actualName)) {
          return res.status(401).json({ error: "No pudimos confirmar tu identidad con ese nombre. Pide a administración que reinicie tu acceso." });
        }
        let accountId = existingAccount?.id;
        let clientId = existingAccount?.client_id || customer?.id;
        if (!accountId) accountId = (await bookingStore.ensureClientAccount({ clientId: customer.id, phone })).id;
        const updated = await bookingStore.setOwnPasswordAndActivate({ id: accountId, passwordHash: await hashPassword(password) });
        if (!updated) return res.status(403).json({ error: "Esta cuenta está suspendida. Pide a administración que reinicie tu acceso." });
        const sessionToken = secureToken();
        const sessionExpiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
        await bookingStore.createSession({ accountId, tokenHash: hashToken(sessionToken), expiresAt: sessionExpiresAt });
        const account = await bookingStore.accountByPhone(phone);
        let appointment = null;
        let bookingError = null;
        if (hasDraftIntent && clientId) {
          const input = { clientId, ...draft, serviceIds, source: "RESERVAPP_CLIENTE", createdBy: { role: "cliente", accountId }, idempotencyKey: crypto.randomUUID() };
          const availability = await bookingStore.availability(input);
          if (availability.slots?.some((slot) => slot.staffId === draft.staffId && slot.time === draft.time)) {
            input.endTime = new Date(new Date(`2000-01-01T${draft.time}:00Z`).getTime() + availability.durationMinutes * 60_000).toISOString().slice(11, 16);
            const created = await bookingStore.createAppointment(input);
            if (!created.conflict && !created.missing) {
              appointment = { id: created.appointment.id, reference: created.appointment.legacy_id };
              if (!created.idempotent) await syncChangedAppointmentsToGoogleCalendar(env, created.previousDocument, created.document, { fetchImpl });
            } else bookingError = "Tu contraseña quedó definida, pero el horario se ocupó. Elige otro.";
          } else bookingError = "Tu contraseña quedó definida, pero el horario se ocupó. Elige otro.";
        }
        res.set("Set-Cookie", sessionCookie(sessionToken, 30 * 86_400));
        res.json({ account: publicAccount(account), appointment, bookingError });
      } catch (error) { next(error); }
    });

    app.post("/api/reservapp/auth/logout", async (req, res, next) => {
      try {
        const token = parseCookies(req.get("cookie")).reservapp_session;
        if (token) await bookingStore.revokeSession(hashToken(token));
        res.set("Set-Cookie", sessionCookie("", 0));
        res.status(204).end();
      } catch (error) { next(error); }
    });

    app.get("/api/reservapp/auth/me", requireReservapp, (req, res) => {
      res.json({ account: publicAccount(req.reservapp.account) });
    });

    app.get("/api/reservapp/agenda", requireReservapp, async (req, res, next) => {
      const date = cleanText(req.query.date, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Fecha inválida." });
      try { res.json(await bookingStore.agenda({ date, account: req.reservapp.account })); }
      catch (error) { next(error); }
    });

    // Cancelar una cita desde la agenda del equipo -- antes solo se podía desde el ERP legado.
    // Cualquier cuenta de personal (no cliente) puede hacerlo, igual que ya puede ver /agenda.
    app.post("/api/reservapp/agenda/appointments/:id/cancel", requireReservapp, async (req, res, next) => {
      if (isClientRole(req.reservapp.account.role)) return res.status(403).json({ error: "Solo el personal puede cancelar citas desde aquí." });
      const reason = cleanText(req.body?.reason, 200);
      try {
        const cancelled = await bookingStore.cancelAppointment({ id: req.params.id, reason });
        if (!cancelled) return res.status(404).json({ error: "Esa cita no existe o ya estaba cancelada." });
        res.json({ ok: true, appointment: cancelled });
      } catch (error) { next(error); }
    });

    // Cambiar el estatus de una cita (Programada/Confirmada/Atendida) desde un click, tanto
    // desde el Panel de colaboradores de ReservApp como desde la matriz del ERP -- por eso el
    // guard de autorización es requireBookingStaff (sesión de personal de ReservApp O identidad
    // del ERP con canManageReservations), no requireReservapp a secas. "Retrasada" nunca es un
    // valor válido aquí: se calcula solo en el frontend a partir de la hora de inicio.
    const ALLOWED_MANUAL_STATUSES = new Set(["scheduled", "confirmed", "completed"]);
    app.post("/api/reservapp/agenda/appointments/:id/status", async (req, res, next) => {
      if (!(await requireBookingStaff(req, res))) return;
      const status = cleanText(req.body?.status, 20);
      if (!ALLOWED_MANUAL_STATUSES.has(status)) return res.status(400).json({ error: "Estatus inválido." });
      try {
        const updated = await bookingStore.setAppointmentStatus({ id: req.params.id, status });
        if (!updated) return res.status(404).json({ error: "Esa cita no existe o ya está cancelada." });
        res.json({ ok: true, appointment: updated });
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        next(error);
      }
    });

    // El personal revisa el comprobante de depósito subido por el cliente -- mismo guard que
    // /status (personal de ReservApp o identidad del ERP con canManageReservations).
    app.get("/api/reservapp/agenda/appointments/:id/deposit", async (req, res, next) => {
      if (!(await requireBookingStaff(req, res))) return;
      try {
        const receipt = await bookingStore.getDepositReceipt({ appointmentId: req.params.id });
        if (!receipt) return res.status(404).json({ error: "Todavía no hay un comprobante subido para esta cita." });
        res.json({ receipt });
      } catch (error) { next(error); }
    });

    app.post("/api/reservapp/agenda/appointments/:id/deposit/review", async (req, res, next) => {
      if (!(await requireBookingStaff(req, res))) return;
      const approve = req.body?.approve === true;
      const note = cleanText(req.body?.note, 200);
      try {
        const session = await reservappSession(req);
        const reviewedBy = session?.account.role ? `${session.account.role}:${session.account.id}` : "erp";
        const updated = await bookingStore.reviewDepositReceipt({ appointmentId: req.params.id, approve, reviewedBy, note: note || null });
        res.json({ ok: true, appointment: updated });
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        next(error);
      }
    });

    // "Citas activas" / historial para un cliente -- a diferencia de /agenda (un día, vista de
    // equipo), esta ruta es exclusiva de cuentas cliente y siempre usa su propio client_id de la
    // sesión, nunca uno recibido del cliente.
    app.get("/api/reservapp/my-appointments", requireReservapp, async (req, res, next) => {
      if (!isClientRole(req.reservapp.account.role)) return res.status(403).json({ error: "Solo disponible para cuentas de cliente." });
      const scope = req.query.scope === "history" ? "history" : "active";
      try { res.json({ appointments: await bookingStore.listClientAppointments({ clientId: req.reservapp.account.client_id, scope }) }); }
      catch (error) { next(error); }
    });

    // El cliente sube la foto del comprobante del depósito de RD$500 -- ver
    // submitDepositReceipt en server/store.mjs. Base64 en JSON (no multipart) porque el límite
    // de body ya está en 8MB (MAX_BODY_BYTES) y evita sumar una dependencia como multer solo
    // para esto -- este repo solo depende de express+pg.
    const ALLOWED_DEPOSIT_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
    app.post("/api/reservapp/my-appointments/:id/deposit", requireReservapp, async (req, res, next) => {
      if (!isClientRole(req.reservapp.account.role)) return res.status(403).json({ error: "Solo disponible para cuentas de cliente." });
      const mimeType = cleanText(req.body?.mimeType, 20);
      const imageBase64 = String(req.body?.imageBase64 || "");
      if (!ALLOWED_DEPOSIT_MIME_TYPES.has(mimeType)) return res.status(400).json({ error: "La imagen debe ser JPEG, PNG o WEBP." });
      if (!imageBase64) return res.status(400).json({ error: "Falta la imagen del comprobante." });
      try {
        const updated = await bookingStore.submitDepositReceipt({
          appointmentId: req.params.id, clientId: req.reservapp.account.client_id, imageBase64, mimeType,
        });
        res.json({ ok: true, appointment: updated });
        // Mejor esfuerzo, después de responder -- nunca bloquea la subida del comprobante.
        bookingStore.appointmentSummary(req.params.id)
          .then((s) => {
            if (!s) return;
            return notifyDepositReceiptUploaded(env, {
              legacyId: s.legacy_id, clientName: s.client_name, serviceName: s.service_name,
              staffName: s.staff_name, date: s.date, time: s.time,
            });
          })
          .catch(() => {});
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        next(error);
      }
    });

    // Cuentas bancarias activas para mostrar junto al botón "Cargar comprobante" -- mismos campos
    // y mismo filtro (tipoCuenta="Banco" + estado activo) que ya usa el ERP legado en
    // bankAccounts()/isBankAccount() de outputs/app.js, para no duplicar cuentas de caja/efectivo.
    app.get("/api/reservapp/bank-accounts", requireReservapp, async (req, res, next) => {
      try {
        const row = await store.read();
        const cuentas = Array.isArray(row?.data?.cuentas) ? row.data.cuentas : [];
        const accounts = cuentas
          .filter((a) => String(a.tipoCuenta || "") === "Banco" && String(a.estado || "Activo").toLowerCase() === "activo")
          .map((a) => ({
            banco: a.entidad || "",
            tipoProducto: a.tipoProducto || "",
            numeroCuenta: a.numeroCuenta || "",
            titular: a.titular || "",
            documento: a.documentoTitular || "",
            tipoDocumento: a.tipoDocumentoTitular || "Cédula",
          }))
          .filter((a) => a.banco && a.numeroCuenta);
        res.json({ accounts });
      } catch (error) { next(error); }
    });

    // Compartido por todos los endpoints de "Configuración de usuarios" -- misma regla que ya
    // usaba POST /admin/accounts: administradora/superadministrador de ReservApp, o personal
    // del ERP legado con canManageUsers, pero SOLO un superadministrador de ReservApp puede
    // tocar cuentas con rol superadministrador (evita que una administradora del ERP se
    // autoeleve creando/editando una cuenta superadministrador de ReservApp).
    const resolveAdminAuthority = async (req) => {
      const session = await reservappSession(req);
      const sessionRole = session?.account.role;
      let allowed = sessionRole && ["administradora", "superadministrador"].includes(sessionRole);
      const actingAsSuperadmin = sessionRole === "superadministrador";
      if (!allowed && !session) {
        const identity = await resolveErpIdentity(webRequest(req), { ...env, fetch: fetchImpl });
        allowed = !identity.error && Boolean(identity.permissions?.canManageUsers);
      }
      return { allowed, actingAsSuperadmin, session };
    };

    app.post("/api/reservapp/admin/accounts", bookingRateLimit, async (req, res, next) => {
      const role = cleanText(req.body?.role, 32);
      const staffId = cleanText(req.body?.staffId, 64);
      const phone = cleanText(req.body?.phone, 30);
      if (!RESERVAPP_ROLES.includes(role) || isClientRole(role) || !staffId || !validPhone(phone)) {
        return res.status(400).json({ error: "Selecciona colaboradora, rol y teléfono válidos." });
      }
      try {
        const { allowed, actingAsSuperadmin, session } = await resolveAdminAuthority(req);
        if (role === "superadministrador" && !actingAsSuperadmin) return res.status(403).json({ error: "Solo administración puede crear credenciales del equipo." });
        if (!allowed) return res.status(403).json({ error: "Solo administración puede crear credenciales del equipo." });
        const account = await bookingStore.createEmployeeAccount({ staffId, phone, role, createdByAccountId: session?.account.id || null });
        const code = generateOtpCode();
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        const prepared = await bookingStore.prepareSetup({ accountId: account.id, tokenHash: hashToken(code), expiresAt, recipientPhone: phone });
        const delivery = await sendSetupWhatsApp({ outboxId: prepared.outbox.id, phone, code, name: "Equipo Dalfi" });
        res.status(201).json({ account: publicAccount(account), deliveryStatus: delivery.status });
      } catch (error) {
        if (error?.code === "23505") return res.status(409).json({ error: "Ese teléfono o colaboradora ya tiene credenciales." });
        if (error?.code === "23503") return res.status(400).json({ error: "La colaboradora seleccionada no existe." });
        next(error);
      }
    });

    app.get("/api/reservapp/admin/accounts", bookingRateLimit, async (req, res, next) => {
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede ver el equipo." });
        res.json({ accounts: await bookingStore.listEmployeeAccounts() });
      } catch (error) { next(error); }
    });

    app.patch("/api/reservapp/admin/accounts/:id", bookingRateLimit, async (req, res, next) => {
      const role = req.body?.role != null ? cleanText(req.body.role, 32) : null;
      const status = req.body?.status != null ? cleanText(req.body.status, 20) : null;
      if (role && (!RESERVAPP_ROLES.includes(role) || isClientRole(role))) return res.status(400).json({ error: "Rol inválido." });
      if (status && !["pending", "active", "suspended"].includes(status)) return res.status(400).json({ error: "Estado inválido." });
      if (!role && !status) return res.status(400).json({ error: "Nada que actualizar." });
      try {
        const { allowed, actingAsSuperadmin } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede editar el equipo." });
        if ((role === "superadministrador" || status) && !actingAsSuperadmin) {
          // Una administradora (no superadmin) puede editar personal normal, pero tocar una
          // cuenta que YA es (o pasaría a ser) superadministrador exige ser superadmin -- mismo
          // candado de autoelevación que la creación de cuentas.
          const target = await bookingStore.listEmployeeAccounts();
          const current = target.find((row) => row.id === req.params.id);
          if (current?.role === "superadministrador" || role === "superadministrador") {
            return res.status(403).json({ error: "Solo un superadministrador puede editar esta cuenta." });
          }
        }
        const updated = await bookingStore.updateEmployeeAccount({ id: req.params.id, role, status });
        if (!updated) return res.status(404).json({ error: "Cuenta no encontrada." });
        res.json({ account: updated });
      } catch (error) { next(error); }
    });

    // Válvula de escape mientras /auth/request-password-reset está apagado (ver comentario ahí
    // arriba): administración fija la contraseña a mano, sin depender del código de WhatsApp.
    // Sirve tanto para personal como para clientes -- reservapp_accounts.id es el mismo id que
    // devuelve tanto listEmployeeAccounts como account_id en listClientsForAdmin.
    app.post("/api/reservapp/admin/accounts/:id/reset-password", bookingRateLimit, async (req, res, next) => {
      const password = String(req.body?.password || "");
      if (!validPassword(password)) return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres, una letra y un número." });
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede restablecer contraseñas." });
        const updated = await bookingStore.resetAccountPassword({ id: req.params.id, passwordHash: await hashPassword(password) });
        if (!updated) return res.status(404).json({ error: "Esa cuenta no existe." });
        res.json({ ok: true });
      } catch (error) { next(error); }
    });

    // Alternativa al reset manual de arriba: en vez de que administración escriba la
    // contraseña nueva, borra la que tenía -- la próxima vez que esa persona ponga su teléfono
    // en ReservApp, la reconoce sin contraseña (ver check-phone/request-setup) y la manda
    // directo a "¿Eres tú? Crea tu contraseña" para que la defina ella misma.
    app.post("/api/reservapp/admin/accounts/:id/clear-password", bookingRateLimit, async (req, res, next) => {
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede reiniciar credenciales." });
        const updated = await bookingStore.clearAccountPassword({ id: req.params.id });
        if (!updated) return res.status(404).json({ error: "Esa cuenta no existe." });
        res.json({ ok: true });
      } catch (error) { next(error); }
    });

    // Un paso más allá de clear-password: en vez de dejar la cuenta sin contraseña, la borra
    // entera. Sirve para personal que ya no trabaja aquí y para clientes que pidieron que se les
    // quite el acceso a la app -- la ficha de staff/cliente queda intacta, solo desaparece el
    // acceso. Al irse la cuenta se libera su teléfono, así que volver a invitar a esa persona es
    // simplemente crearle credenciales de nuevo.
    app.delete("/api/reservapp/admin/accounts/:id", bookingRateLimit, async (req, res, next) => {
      try {
        const { allowed, actingAsSuperadmin, session } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede borrar credenciales." });
        // Borrarse a sí misma dejaría al salón sin quien administre si era la única -- y en
        // cualquier caso es un accidente, no una intención.
        if (session && session.account.id === req.params.id) {
          return res.status(400).json({ error: "No puedes borrar tus propias credenciales." });
        }
        // Mismo candado de autoelevación que PATCH /admin/accounts/:id: una administradora que
        // no es superadministrador no puede quitarle el acceso a un superadministrador.
        if (!actingAsSuperadmin) {
          const accounts = await bookingStore.listEmployeeAccounts();
          const target = accounts.find((row) => row.id === req.params.id);
          if (target?.role === "superadministrador") {
            return res.status(403).json({ error: "Solo un superadministrador puede borrar esta cuenta." });
          }
        }
        const deleted = await bookingStore.deleteAccount({ id: req.params.id });
        if (!deleted) return res.status(404).json({ error: "Esa cuenta no existe." });
        res.json({ ok: true });
      } catch (error) { next(error); }
    });

    app.get("/api/reservapp/admin/clients", bookingRateLimit, async (req, res, next) => {
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede ver clientes." });
        res.json({ clients: await bookingStore.listClientsForAdmin({ query: cleanText(req.query.q, 120) }) });
      } catch (error) { next(error); }
    });

    app.patch("/api/reservapp/admin/clients/:id", bookingRateLimit, async (req, res, next) => {
      const status = cleanText(req.body?.status, 20);
      if (!["active", "blocked"].includes(status)) return res.status(400).json({ error: "Estado inválido." });
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede editar clientes." });
        const updated = await bookingStore.updateClientStatus({ id: req.params.id, status });
        if (!updated) return res.status(404).json({ error: "Cliente no encontrado." });
        res.json({ client: updated });
      } catch (error) { next(error); }
    });

    // "Borrar cliente" -- borrado lógico (ver softDeleteClient). La ficha desaparece de todo lo
    // vivo pero su historial de citas, facturas e ingresos se queda; si esa persona vuelve, se
    // registra de cero con un id nuevo. Se le borra de paso la cuenta de ReservApp, porque su
    // teléfono tiene que quedar libre para ese registro nuevo.
    //
    // Con citas futuras sin cancelar no se borra: se cancelan primero desde el ERP, por el flujo
    // normal, que es el que mantiene sincronizado el documento que ve el personal.
    app.delete("/api/reservapp/admin/clients/:id", bookingRateLimit, async (req, res, next) => {
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede borrar clientes." });
        const deleted = await bookingStore.softDeleteClient({ id: req.params.id });
        if (!deleted) return res.status(404).json({ error: "Ese cliente no existe o ya fue borrado." });
        if (deleted.blocked) {
          return res.status(409).json({
            error: `Este cliente tiene ${deleted.blocked} cita(s) futuras sin cancelar. Cancélalas primero y vuelve a intentarlo.`,
            upcomingAppointments: deleted.blocked,
          });
        }
        res.json({ ok: true, deletedAccount: deleted.deletedAccount });
      } catch (error) { next(error); }
    });

    // Banner promocional (Fase 6) -- generar solo redacta una propuesta con Gemini (bridge de
    // WhatsApp, ver banner-generator.js del chatbot), publicar/quitar es lo único que de verdad
    // cambia lo que ve ReservApp (GET /api/fast-booking/catalog).
    app.post("/api/reservapp/admin/banner/generate", bookingRateLimit, async (req, res, next) => {
      const instructions = cleanText(req.body?.instructions, 500);
      if (!instructions) return res.status(400).json({ error: "Escribe qué quieres anunciar." });
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede generar el banner." });
        const bridgeSecret = String(env.ERP_WEBHOOK_SECRET || "");
        const bridgeBase = String(env.CHATBOT_BRIDGE_URL || "https://bot.dalfistudio.com").replace(/\/$/, "");
        const response = await fetchImpl(`${bridgeBase}/webhook/generate-banner`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-webhook-secret": bridgeSecret },
          body: JSON.stringify({ instructions }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.status !== "OK") {
          return res.status(502).json({ error: payload?.error || "No se pudo generar el banner." });
        }
        res.json({ banner: payload.banner });
      } catch (error) { next(error); }
    });

    app.post("/api/reservapp/admin/banner", bookingRateLimit, async (req, res, next) => {
      const text = cleanText(req.body?.text, 140);
      const theme = cleanText(req.body?.theme, 20);
      const bgColor = cleanText(req.body?.bgColor, 10);
      const textColor = cleanText(req.body?.textColor, 10);
      if (!text || !theme || !/^#[0-9a-fA-F]{6}$/.test(bgColor) || !/^#[0-9a-fA-F]{6}$/.test(textColor)) {
        return res.status(400).json({ error: "Datos de banner inválidos." });
      }
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede publicar el banner." });
        const banner = await bookingStore.setBanner({ text, theme, bgColor, textColor });
        res.json({ banner });
      } catch (error) { next(error); }
    });

    app.delete("/api/reservapp/admin/banner", bookingRateLimit, async (req, res, next) => {
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede quitar el banner." });
        await bookingStore.clearBanner();
        res.status(204).end();
      } catch (error) { next(error); }
    });

    // Segundo cuadro de mensaje, independiente del banner promocional -- sin generación por IA
    // (administración escribe el texto final directo), pensado para notas más largas y
    // permanentes en vez de promociones puntuales.
    app.post("/api/reservapp/admin/info-banner", bookingRateLimit, async (req, res, next) => {
      const text = cleanText(req.body?.text, 800);
      if (!text) return res.status(400).json({ error: "Escribe el mensaje." });
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede publicar el mensaje." });
        const infoBanner = await bookingStore.setInfoBanner({ text });
        res.json({ infoBanner });
      } catch (error) { next(error); }
    });

    app.delete("/api/reservapp/admin/info-banner", bookingRateLimit, async (req, res, next) => {
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede quitar el mensaje." });
        await bookingStore.clearInfoBanner();
        res.status(204).end();
      } catch (error) { next(error); }
    });

    // Panel "Horarios" -- este es el único lugar que de verdad afecta la disponibilidad real de
    // ReservApp (ver comentario junto a businessSettings() en store.mjs). El editor del ERP legado
    // sigue funcionando para mostrar/leer, pero escribir horario ahí ya no es la fuente de verdad.
    app.get("/api/reservapp/admin/business-settings", bookingRateLimit, async (req, res, next) => {
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede ver los horarios." });
        res.json(await bookingStore.businessSettings());
      } catch (error) { next(error); }
    });

    app.patch("/api/reservapp/admin/business-settings", bookingRateLimit, async (req, res, next) => {
      const patch = {};
      if (req.body?.defaultOpeningTime != null) {
        if (!/^\d{2}:\d{2}$/.test(req.body.defaultOpeningTime)) return res.status(400).json({ error: "Hora de apertura inválida." });
        patch.defaultOpeningTime = req.body.defaultOpeningTime;
      }
      if (req.body?.defaultClosingTime != null) {
        if (!/^\d{2}:\d{2}$/.test(req.body.defaultClosingTime)) return res.status(400).json({ error: "Hora de cierre inválida." });
        patch.defaultClosingTime = req.body.defaultClosingTime;
      }
      if (Array.isArray(req.body?.weekDays)) {
        const weekDays = req.body.weekDays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
        patch.weekDays = [...new Set(weekDays)];
      }
      if (req.body?.weeklyHours != null && typeof req.body.weeklyHours === "object" && !Array.isArray(req.body.weeklyHours)) {
        const weeklyHours = {};
        for (const [day, value] of Object.entries(req.body.weeklyHours)) {
          if (!/^[0-6]$/.test(day)) continue;
          if (value === null) { weeklyHours[day] = null; continue; }
          const open = cleanText(value?.open, 5); const close = cleanText(value?.close, 5);
          if (!/^\d{2}:\d{2}$/.test(open) || !/^\d{2}:\d{2}$/.test(close) || open >= close) {
            return res.status(400).json({ error: `Horario inválido para el día ${day}.` });
          }
          weeklyHours[day] = { open, close };
        }
        patch.weeklyHours = weeklyHours;
      }
      if (Array.isArray(req.body?.holidayClosures)) {
        const dates = req.body.holidayClosures.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
        patch.holidayClosures = [...new Set(dates)].sort();
      }
      // scheduleExceptions: mismo formato que ya usaba el editor del ERP legado -- fecha puntual +
      // open/close (ambos vacíos = cerrado todo el día). No pasa por la validación estricta de
      // open<close de weeklyHours porque el editor legado ya permite guardar una sola hora puesta
      // (el usuario la corrige después); solo se descarta si la fecha no es válida.
      if (Array.isArray(req.body?.scheduleExceptions)) {
        patch.scheduleExceptions = req.body.scheduleExceptions
          .filter((exc) => exc && /^\d{4}-\d{2}-\d{2}$/.test(exc.date))
          .map((exc) => ({
            date: exc.date,
            open: /^\d{2}:\d{2}$/.test(exc.open) ? exc.open : null,
            close: /^\d{2}:\d{2}$/.test(exc.close) ? exc.close : null,
            label: cleanText(exc.label, 120),
          }));
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nada que actualizar." });
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede editar los horarios." });
        res.json(await bookingStore.updateBusinessSettings(patch));
      } catch (error) { next(error); }
    });

    app.get("/api/reservapp/admin/staff-schedules", bookingRateLimit, async (req, res, next) => {
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede ver el horario del personal." });
        res.json({ schedules: await bookingStore.listStaffWeeklySchedules(cleanText(req.query.staffId, 64) || null) });
      } catch (error) { next(error); }
    });

    app.post("/api/reservapp/admin/staff-schedules", bookingRateLimit, async (req, res, next) => {
      const staffId = cleanText(req.body?.staffId, 64);
      const weekday = Number(req.body?.weekday);
      const startTime = cleanText(req.body?.startTime, 5);
      const endTime = cleanText(req.body?.endTime, 5);
      const active = req.body?.active !== false;
      if (!staffId || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return res.status(400).json({ error: "Colaboradora y día de la semana son obligatorios." });
      if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || startTime >= endTime) {
        return res.status(400).json({ error: "La hora de fin debe ser posterior a la de inicio." });
      }
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede editar el horario del personal." });
        res.json({ schedule: await bookingStore.setStaffWeeklySchedule({ staffId, weekday, startTime, endTime, active }) });
      } catch (error) { next(error); }
    });

    app.delete("/api/reservapp/admin/staff-schedules/:staffId/:weekday", bookingRateLimit, async (req, res, next) => {
      const weekday = Number(req.params.weekday);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return res.status(400).json({ error: "Día de la semana inválido." });
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede editar el horario del personal." });
        await bookingStore.deleteStaffWeeklySchedule({ staffId: cleanText(req.params.staffId, 64), weekday });
        res.status(204).end();
      } catch (error) { next(error); }
    });

    app.get("/api/reservapp/admin/staff-schedule-exceptions", bookingRateLimit, async (req, res, next) => {
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede ver las excepciones de horario." });
        res.json({ exceptions: await bookingStore.listStaffScheduleExceptions(cleanText(req.query.staffId, 64) || null) });
      } catch (error) { next(error); }
    });

    app.post("/api/reservapp/admin/staff-schedule-exceptions", bookingRateLimit, async (req, res, next) => {
      const staffId = cleanText(req.body?.staffId, 64);
      const date = cleanText(req.body?.date, 10);
      const available = Boolean(req.body?.available);
      const startTime = available ? cleanText(req.body?.startTime, 5) : "";
      const endTime = available ? cleanText(req.body?.endTime, 5) : "";
      const reason = cleanText(req.body?.reason, 200);
      if (!staffId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Colaboradora y fecha son obligatorias." });
      if (available && (startTime || endTime) && (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || startTime >= endTime)) {
        return res.status(400).json({ error: "La hora de fin debe ser posterior a la de inicio." });
      }
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede editar excepciones de horario." });
        res.json({
          exception: await bookingStore.setStaffScheduleException({
            staffId, date, available, reason,
            startTime: startTime || null, endTime: endTime || null,
          }),
        });
      } catch (error) { next(error); }
    });

    app.delete("/api/reservapp/admin/staff-schedule-exceptions/:staffId/:date", bookingRateLimit, async (req, res, next) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: "Fecha inválida." });
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede editar excepciones de horario." });
        await bookingStore.deleteStaffScheduleException({ staffId: cleanText(req.params.staffId, 64), date: req.params.date });
        res.status(204).end();
      } catch (error) { next(error); }
    });

    // Aviso en Configuración de usuarios de qué colaboradoras marcaron su propia disponibilidad
    // recientemente (últimos 30 días) desde "Mi disponibilidad" -- ver setStaffScheduleException
    // createdBy más abajo.
    app.get("/api/reservapp/admin/staff-schedule-changes", bookingRateLimit, async (req, res, next) => {
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede ver estos cambios." });
        res.json({ changes: await bookingStore.listRecentStaffCreatedExceptions({}) });
      } catch (error) { next(error); }
    });

    // "Mi disponibilidad": solo administradora/superadministrador (ver requireAdministradoraSession
    // arriba) marca sus propios días u horas no disponibles -- mismas tablas y misma lógica de
    // availability() que ya usa el editor de administración, solo que acotado a la propia sesión
    // (nunca a un staffId ajeno) y marcado created_by='staff' para que aparezca en el aviso de
    // arriba. Manicurista/asistente ya no pueden bloquearse a sí mismas (pedido explícito del
    // dueño del negocio) -- si necesitan bloquear una hora, se lo piden a administración, que sí
    // puede bloquear cualquier colaboradora desde /admin/staff-schedule-exceptions.
    app.get("/api/reservapp/my-schedule-exceptions", bookingRateLimit, async (req, res, next) => {
      const session = await requireAdministradoraSession(req, res);
      if (!session) return;
      if (!session.account.staff_id) return res.status(403).json({ error: "Esta cuenta no está vinculada a una colaboradora." });
      try {
        res.json({ exceptions: await bookingStore.listStaffScheduleExceptions(session.account.staff_id) });
      } catch (error) { next(error); }
    });

    app.post("/api/reservapp/my-schedule-exceptions", bookingRateLimit, async (req, res, next) => {
      const session = await requireAdministradoraSession(req, res);
      if (!session) return;
      if (!session.account.staff_id) return res.status(403).json({ error: "Esta cuenta no está vinculada a una colaboradora." });
      const date = cleanText(req.body?.date, 10);
      const available = Boolean(req.body?.available);
      const startTime = available ? cleanText(req.body?.startTime, 5) : "";
      const endTime = available ? cleanText(req.body?.endTime, 5) : "";
      const reason = cleanText(req.body?.reason, 200);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Elige una fecha válida." });
      if (available && (startTime || endTime) && (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || startTime >= endTime)) {
        return res.status(400).json({ error: "La hora de fin debe ser posterior a la de inicio." });
      }
      try {
        res.json({
          exception: await bookingStore.setStaffScheduleException({
            staffId: session.account.staff_id, date, available, reason,
            startTime: startTime || null, endTime: endTime || null, createdBy: "staff",
          }),
        });
      } catch (error) { next(error); }
    });

    app.delete("/api/reservapp/my-schedule-exceptions/:date", bookingRateLimit, async (req, res, next) => {
      const session = await requireAdministradoraSession(req, res);
      if (!session) return;
      if (!session.account.staff_id) return res.status(403).json({ error: "Esta cuenta no está vinculada a una colaboradora." });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: "Fecha inválida." });
      try {
        await bookingStore.deleteStaffScheduleException({ staffId: session.account.staff_id, date: req.params.date });
        res.status(204).end();
      } catch (error) { next(error); }
    });

    // Motor de recordatorios de confirmación de asistencia -- disparado por un Cloudflare Worker
    // con Cron Trigger cada hora (workers/booking-reminder-cron/), mismo mecanismo que antes de
    // eliminar dalfi-erp.pages.dev, solo que ahora apunta aquí en vez de a esa Pages Function
    // muerta. Aplica a TODA cita futura sin importar canal de origen (ver createAppointment) --
    // "Programada" recibe recordatorio a <=4h laborales de la cita; "PendienteConfirmarHora"
    // recibe el segundo + libera el horario a >=1h laboral después del primero sin respuesta
    // (ver businessMinutesBetween/resolveBusinessDayWindow en store.mjs).
    // bookingRateLimit aquí no afecta el cron real (una llamada por hora, muy por debajo del
    // límite) -- solo evita que alguien intentando adivinar BOOKING_REMINDER_CRON_SECRET a fuerza
    // bruta lo haga sin ningún freno (antes esta ruta era la única sin límite de intentos).
    app.post("/api/booking/send-reminders", bookingRateLimit, async (req, res, next) => {
      const expectedSecret = env.BOOKING_REMINDER_CRON_SECRET;
      if (!expectedSecret) return res.status(500).json({ error: "Falta configurar BOOKING_REMINDER_CRON_SECRET." });
      if ((req.get("x-cron-secret") || "") !== expectedSecret) return res.status(401).json({ error: "Secreto de cron inválido." });
      try {
        const { settings } = await bookingStore.businessSettings();
        const appointments = await bookingStore.listAppointmentsForReminderSweep();
        const now = Date.now();
        let remindersSent = 0;
        let escalationsSent = 0;
        const failures = [];
        for (const apt of appointments) {
          if (!apt.client_phone) continue;
          const common = {
            reservationId: apt.legacy_id, phone: apt.client_phone, clientName: apt.client_name,
            date: apt.apt_date, time: apt.apt_time, service: apt.service_name,
          };
          if (apt.confirmation_status === "Programada") {
            const hoursUntil = businessMinutesBetween(now, new Date(apt.starts_at).getTime(), settings) / 60;
            if (hoursUntil > 4) continue;
            const result = await sendConfirmationReminderWhatsApp({ ...common, stage: "first" });
            if (!result.ok) { failures.push({ reservationId: apt.legacy_id, error: result.error || result.status }); continue; }
            await bookingStore.markConfirmationReminderSent({ appointmentId: apt.id, stage: "first" });
            remindersSent += 1;
          } else if (apt.confirmation_status === "PendienteConfirmarHora" && apt.first_reminder_sent_at) {
            const hoursSinceFirst = businessMinutesBetween(new Date(apt.first_reminder_sent_at).getTime(), now, settings) / 60;
            if (hoursSinceFirst < 1) continue;
            const result = await sendConfirmationReminderWhatsApp({ ...common, stage: "second" });
            if (!result.ok) { failures.push({ reservationId: apt.legacy_id, error: result.error || result.status }); continue; }
            await bookingStore.markConfirmationReminderSent({ appointmentId: apt.id, stage: "second" });
            escalationsSent += 1;
          }
        }
        res.json({ ok: true, remindersSent, escalationsSent, failures });
      } catch (error) { next(error); }
    });

    // Disparado por workers/deposit-receipt-purge-cron (una vez al día) -- borra SOLO la foto del
    // comprobante de depósito de citas ya Atendidas/Canceladas hace 5+ días, nunca la fila ni la
    // cita (ver purgeExpiredDepositReceipts en server/store.mjs). Mismo patrón de secreto por
    // cabecera que /api/booking/send-reminders, con su propio secreto dedicado.
    app.post("/api/booking/purge-deposit-receipts", bookingRateLimit, async (req, res, next) => {
      const expectedSecret = env.DEPOSIT_RECEIPT_PURGE_CRON_SECRET;
      if (!expectedSecret) return res.status(500).json({ error: "Falta configurar DEPOSIT_RECEIPT_PURGE_CRON_SECRET." });
      if ((req.get("x-cron-secret") || "") !== expectedSecret) return res.status(401).json({ error: "Secreto de cron inválido." });
      try {
        res.json({ ok: true, ...(await bookingStore.purgeExpiredDepositReceipts()) });
      } catch (error) { next(error); }
    });

    // Disparado por workers/deposit-review-reminder-cron cada hora -- si estamos dentro de la
    // ventana de negocio (8am-11pm hora de Santo Domingo), manda un correo recordatorio al
    // personal por cada cita que sigue con un comprobante de depósito subido sin revisar
    // (deposit_status='ComprobanteRecibido'). Fuera de esa ventana no manda nada (no se rompe
    // nada por saltarse ejecuciones nocturnas -- el próximo tick dentro de la ventana retoma).
    app.post("/api/booking/send-deposit-review-reminders", bookingRateLimit, async (req, res, next) => {
      const expectedSecret = env.DEPOSIT_REVIEW_REMINDER_CRON_SECRET;
      if (!expectedSecret) return res.status(500).json({ error: "Falta configurar DEPOSIT_REVIEW_REMINDER_CRON_SECRET." });
      if ((req.get("x-cron-secret") || "") !== expectedSecret) return res.status(401).json({ error: "Secreto de cron inválido." });
      try {
        if (!isWithinDepositReminderWindow()) return res.json({ ok: true, skipped: "outside_window", sent: 0 });
        const pending = await bookingStore.listPendingDepositReviews();
        let sent = 0;
        for (const s of pending) {
          const result = await notifyDepositReviewPending(env, {
            legacyId: s.legacy_id, clientName: s.client_name, serviceName: s.service_name,
            staffName: s.staff_name, date: s.date, time: s.time,
          });
          if (result.sent) sent += 1;
        }
        res.json({ ok: true, pending: pending.length, sent });
      } catch (error) { next(error); }
    });

    // Cuentas bancarias activas para que el Chatbot Bridge (dalfi-chatbot-n8n, ver
    // src/erp-adapter.js listBankAccounts()) las muestre cuando la clienta pide transferir el
    // depósito de RD$500 -- secreto por cabecera dedicado (x-chatbot-secret / env CHATBOT_SECRET,
    // ya declarado en render.yaml pero sin usar hasta ahora), igual patrón que
    // /api/booking/send-reminders pero con su propio nombre de cabecera porque este es tráfico
    // entrante del bridge, no de un cron. El bridge guarda ese mismo valor como
    // ERP_CHATBOT_SECRET (ver erp-adapter.js) -- el nombre de la variable no tiene que coincidir
    // entre los dos servicios, solo el secreto en sí. Mismo filtro y mismos nombres de campo que
    // ya espera buildPaymentAccountCandidate() del lado del bot (banco/tipoCuenta/numeroCuenta/
    // titular/documento/tipoDocumento) para no tener que tocar ese código.
    app.get("/api/booking/bank-accounts", bookingRateLimit, async (req, res, next) => {
      const expectedSecret = env.CHATBOT_SECRET;
      if (!expectedSecret) return res.status(500).json({ error: "Falta configurar CHATBOT_SECRET." });
      if ((req.get("x-chatbot-secret") || "") !== expectedSecret) return res.status(401).json({ error: "Secreto de chatbot inválido." });
      try {
        const row = await store.read();
        const cuentas = Array.isArray(row?.data?.cuentas) ? row.data.cuentas : [];
        const accounts = cuentas
          .filter((a) => String(a.tipoCuenta || "") === "Banco" && String(a.estado || "Activo").toLowerCase() === "activo")
          .map((a) => ({
            id: String(a.cuentaID || a.id || ""),
            banco: a.entidad || "",
            tipoCuenta: a.tipoProducto || "",
            numeroCuenta: a.numeroCuenta || "",
            titular: a.titular || "",
            documento: a.documentoTitular || "",
            tipoDocumento: a.tipoDocumentoTitular || "Cédula",
          }))
          .filter((a) => a.banco && a.numeroCuenta);
        res.json({ success: true, accounts });
      } catch (error) { next(error); }
    });

    // Confirma la asistencia de una cita -- llamado por el Chatbot Bridge cuando el cliente
    // responde "1. Confirmar mi hora" por WhatsApp (x-webhook-secret compartido, mismo que usa el
    // bridge para notify-invoice-sent.js), por el botón "Confirmar cita en salón" del ERP legado
    // (sesión de administración), o por el propio cliente desde "Citas activas" en ReservApp
    // (sesión cliente -- acotada a su propio client_id dentro de confirmAppointmentAttendance,
    // nunca confía en el reservationId por sí solo). Confirmar asistencia NUNCA aparta el
    // horario (eso solo lo hace el depósito aprobado o la autorización manual de administración,
    // ver reviewDepositReceipt/setAppointmentStatus) -- alreadyReassigned:true aquí solo puede
    // pasar si esta cita puntual ya quedó cancelada/reasignada por otro lado mientras tanto.
    app.post("/api/reservapp/booking/confirm-attendance", bookingRateLimit, async (req, res, next) => {
      const bridgeSecret = String(env.ERP_WEBHOOK_SECRET || "");
      const viaBridge = bridgeSecret && (req.get("x-webhook-secret") || "") === bridgeSecret;
      let clientId = null;
      if (!viaBridge) {
        const session = await reservappSession(req);
        if (isClientRole(session?.account.role)) {
          clientId = session.account.client_id;
        } else {
          const { allowed } = await resolveAdminAuthority(req);
          if (!allowed) return res.status(401).json({ error: "No autorizado." });
        }
      }
      const reservationId = cleanText(req.body?.reservationId, 80);
      if (!reservationId) return res.status(400).json({ error: "Se requiere reservationId." });
      try {
        const result = await bookingStore.confirmAppointmentAttendance({ legacyId: reservationId, clientId });
        if (result.missing) return res.status(404).json({ error: `Reserva '${reservationId}' no encontrada.` });
        if (result.alreadyReassigned) {
          return res.status(409).json({
            success: false, code: "ALREADY_REASSIGNED",
            error: `El horario de la reserva '${reservationId}' ya no está disponible: fue tomado por otra reserva. Selecciona otro horario.`,
          });
        }
        res.json({ success: true, confirmed: true });
      } catch (error) { next(error); }
    });

    // Relay OTP: cuando una MANICURISTA quiere agendar a un cliente que
    // todavía no existe en el sistema, primero debe comprobar que controla
    // ese teléfono con un código de 6 dígitos enviado por WhatsApp -- no
    // puede simplemente inventar un número y convertirlo en identidad
    // verificada (a diferencia de asistente/administradora, que sí pueden
    // crear clientes directamente vía POST /api/fast-booking/clients).
    app.post("/api/reservapp/clients/relay-otp/request", bookingRateLimit, async (req, res, next) => {
      const session = await requireManicuristaOrAbove(req, res);
      if (!session) return;
      const phone = cleanText(req.body?.phone, 30);
      const firstName = cleanText(req.body?.firstName, 80);
      const lastName = cleanText(req.body?.lastName, 80);
      const email = cleanText(req.body?.email, 160).toLowerCase();
      if (!validPhone(phone)) return res.status(400).json({ error: "Introduce un teléfono válido de 10 dígitos." });
      if (!firstName) return res.status(400).json({ error: "El nombre del cliente es obligatorio." });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "El correo no tiene un formato válido." });
      if (!relayOtpRequestLimit(session.account.id)) return res.status(429).json({ error: "Demasiados códigos solicitados. Espera unos minutos." });
      try {
        // Respuesta idéntica exista o no el cliente -- este endpoint NO debe
        // servir para enumerar teléfonos ya registrados. La consulta explícita
        // de "¿este cliente ya existe?" es responsabilidad de
        // POST /api/fast-booking/client/resolve (mismo nivel de autorización);
        // el frontend lo llama primero y solo llega aquí si no encontró nada.
        // Si de todos modos llega un teléfono ya existente, no se crea un OTP
        // ni se manda WhatsApp -- responde igual que si sí se hubiera enviado.
        const existing = await bookingStore.resolveClient({ phone });
        let deliveryStatus = "sent";
        let exposedCode;
        if (!existing) {
          const code = generateOtpCode();
          const expiresAt = new Date(Date.now() + RELAY_OTP_TTL_MS).toISOString();
          const prepared = await bookingStore.createRelayOtp({
            requestedByAccountId: session.account.id, phone, firstName, lastName, email,
            codeHash: hashToken(code), expiresAt, maxAttempts: RELAY_OTP_MAX_ATTEMPTS,
          });
          const delivery = await sendRelayOtpWhatsApp({ outboxId: prepared.outbox.id, phone, code, name: `${firstName} ${lastName}`.trim() });
          deliveryStatus = delivery.status;
          exposedCode = code;
        }
        res.status(202).json({
          pendingConfirmation: true,
          deliveryStatus,
          expiresInSeconds: Math.floor(RELAY_OTP_TTL_MS / 1000),
          message: "Si el teléfono no tiene ya un cliente registrado, le enviamos un código de WhatsApp para confirmar.",
          ...(String(env.RESERVAPP_EXPOSE_OTP_CODE || "") === "true" && exposedCode ? { code: exposedCode } : {}),
        });
      } catch (error) { next(error); }
    });

    app.post("/api/reservapp/clients/relay-otp/confirm", bookingRateLimit, async (req, res, next) => {
      const session = await requireManicuristaOrAbove(req, res);
      if (!session) return;
      const phone = cleanText(req.body?.phone, 30);
      const code = cleanText(req.body?.code, 6);
      if (!validPhone(phone) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: "Código inválido." });
      try {
        const result = await bookingStore.verifyRelayOtp({ phone, codeHash: hashToken(code) });
        if (result.locked) return res.status(429).json({ error: "Demasiados intentos. Solicita un nuevo código.", code: "OTP_LOCKED" });
        if (result.notFound) return res.status(410).json({ error: "El código venció o no fue solicitado. Solicita uno nuevo.", code: "OTP_NOT_FOUND" });
        if (result.invalid) {
          return res.status(401).json({ error: "Código incorrecto.", code: "OTP_INVALID", attemptsRemaining: result.attemptsRemaining });
        }
        const otp = result.row;
        let customer = await bookingStore.resolveClient({ phone });
        if (!customer) {
          const id = `CLI-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
          const fullName = `${otp.first_name} ${otp.last_name || ""}`.trim();
          const legacyPayload = {
            clienteID: id, nombre: otp.first_name, apellido: otp.last_name || "", nombreCompleto: fullName,
            telefono: phone, correo: otp.email || "", estado: "Activo", origenRegistro: "RESERVAPP_MANICURISTA_OTP",
            fechaRegistro: new Date().toISOString(),
            observaciones: `Teléfono verificado por WhatsApp; registrada por manicurista (cuenta ${otp.requested_by_account_id}).`,
          };
          const created = await bookingStore.createClient({
            firstName: otp.first_name, lastName: otp.last_name || "", fullName, phone, email: otp.email || "",
            source: "RESERVAPP_MANICURISTA_OTP", legacyPayload,
          });
          if (created.duplicate) customer = await bookingStore.resolveClient({ phone });
          else customer = created.client;
        }
        if (!customer) return res.status(409).json({ error: "No pudimos vincular el teléfono con una ficha de cliente." });
        if (bookingStore.markRelayOtpClient) await bookingStore.markRelayOtpClient(otp.id, customer.id);
        res.json({ verified: true, client: { id: customer.id, name: customer.full_name } });
      } catch (error) { next(error); }
    });

    app.get("/api/fast-booking/catalog", bookingRateLimit, async (_req, res, next) => {
      try { res.json(await bookingStore.catalog()); } catch (error) { next(error); }
    });

    app.get("/api/fast-booking/availability", bookingRateLimit, async (req, res, next) => {
      const serviceIds = cleanServiceIds(req.query.serviceIds || req.query.serviceId);
      // staffId es opcional a propósito: sin él, bookingStore.availability() ya devuelve los
      // horarios de TODAS las manicuristas elegibles para ese servicio en un solo llamado (cada
      // slot trae su staffId/staffName) -- es lo que usa el paso 3 del wizard para mostrar el
      // día completo por manicurista en una sola página.
      const staffId = cleanText(req.query.staffId, 64);
      const date = cleanText(req.query.date, 10);
      if (!serviceIds.length || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Servicios y fecha son obligatorios." });
      try {
        const result = await bookingStore.availability({ serviceIds, staffId: staffId || undefined, date });
        if (result.missing) return res.status(404).json({ error: "Servicio o colaboradora no disponible." });
        // Sin bloque continuo para 2+ servicios (y sin restringir a una sola colaboradora en
        // particular): busca una alternativa ese mismo día antes de rendirse -- ver
        // availabilityFallback en server/store.mjs para los 3 niveles de prioridad.
        if (!result.slots.length && !result.closed && !staffId && serviceIds.length > 1) {
          result.fallback = await bookingStore.availabilityFallback({ serviceIds, date });
        }
        res.json(result);
      } catch (error) { next(error); }
    });

    app.post("/api/fast-booking/client/resolve", bookingRateLimit, async (req, res, next) => {
      const phone = cleanText(req.body?.phone, 30);
      const email = cleanText(req.body?.email, 160).toLowerCase();
      if (!validPhone(phone)) return res.status(400).json({ error: "Introduce un teléfono válido de 10 dígitos." });
      try {
        if (!(await requireBookingStaff(req, res))) return;
        const customer = await bookingStore.resolveClient({ phone, email });
        res.json(customer ? { found: true, client: { id: customer.id, firstName: customer.full_name.split(/\s+/)[0] } } : { found: false });
      } catch (error) { next(error); }
    });

    app.post("/api/fast-booking/clients", bookingRateLimit, async (req, res, next) => {
      if (req.body?.website) return res.status(204).end();
      const firstName = cleanText(req.body?.firstName, 80);
      const lastName = cleanText(req.body?.lastName, 80);
      const phone = cleanText(req.body?.phone, 30);
      const email = cleanText(req.body?.email, 160).toLowerCase();
      const birthDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.birthDate) ? req.body.birthDate : "";
      const sex = ["Femenino", "Masculino"].includes(req.body?.sex) ? req.body.sex : "";
      const address = cleanText(req.body?.address, 300);
      const preferredService = cleanText(req.body?.preferredService, 160);
      if (!firstName || !lastName || !validPhone(phone)) return res.status(400).json({ error: "Nombre, apellido y teléfono válido son obligatorios." });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "El correo no tiene un formato válido." });
      const id = `CLI-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const source = req.body?.actorType === "employee" ? "PWA_EMPLEADO" : "PWA_CLIENTE";
      const legacyPayload = {
        clienteID: id, nombre: firstName, apellido: lastName, nombreCompleto: `${firstName} ${lastName}`,
        telefono: phone, correo: email, estado: "Activo", origenRegistro: source,
        fechaNacimiento: birthDate, sexo: sex, direccion: address, servicioPreferido: preferredService,
        fechaRegistro: new Date().toISOString(), observaciones: "Creado desde reserva rápida.",
      };
      try {
        if (!(await requireBookingStaff(req, res))) return;
        const result = await bookingStore.createClient({
          firstName, lastName, fullName: legacyPayload.nombreCompleto, phone, email, source, legacyPayload,
          birthDate, sex, address, preferredService,
        });
        if (result.duplicate) return res.status(409).json({ error: `Ya existe un cliente con ese ${result.matchedBy === "email" ? "correo" : "teléfono"}.`, duplicate: true, matchedBy: result.matchedBy });
        const calendarSync = await syncChangedAppointmentsToGoogleCalendar(env, result.previousDocument, result.document, { fetchImpl });
        res.status(201).json({ client: { id: result.client.id, name: result.client.full_name }, calendarSync });
      } catch (error) { next(error); }
    });

    app.get("/api/fast-booking/clients", bookingRateLimit, async (req, res, next) => {
      try {
        if (!(await requireBookingStaff(req, res))) return;
        const query = cleanText(req.query.q, 80);
        res.json({ clients: query.length < 2 ? [] : await bookingStore.searchClients(query) });
      } catch (error) { next(error); }
    });

    app.post("/api/fast-booking/appointments", bookingRateLimit, async (req, res, next) => {
      if (req.body?.website) return res.status(204).end();
      const clientId = cleanText(req.body?.clientId, 64);
      const notes = cleanText(req.body?.notes, 500);
      const idempotencyKey = cleanText(req.get("Idempotency-Key") || req.body?.idempotencyKey, 120);
      // Servicios combinados repartidos entre distintas manicuristas (ej. servicio 1 con Ana,
      // servicio 2 con Jaimely porque Ana no tenía espacio) -- ver createComboAppointment en
      // store.mjs. Cada segmento del arreglo ya viene con su propia manicurista/horario
      // elegidos en el paso 3 del wizard (uno por servicio); no son intercambiables entre sí.
      const rawSegments = Array.isArray(req.body?.segments) ? req.body.segments : null;
      if (!clientId || !idempotencyKey) return res.status(400).json({ error: "Completa todos los datos de la cita." });
      let input = null;
      let segments = null;
      if (!rawSegments) {
        input = {
          clientId, serviceIds: cleanServiceIds(req.body?.serviceIds || req.body?.serviceId),
          staffId: cleanText(req.body?.staffId, 64), date: cleanText(req.body?.date, 10),
          time: cleanText(req.body?.time, 5), notes, idempotencyKey,
        };
        if (!input.serviceIds.length || !input.staffId || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) {
          return res.status(400).json({ error: "Completa todos los datos de la cita." });
        }
      } else {
        segments = rawSegments.map((seg) => ({
          serviceIds: cleanServiceIds(seg?.serviceIds || seg?.serviceId),
          staffId: cleanText(seg?.staffId, 64), date: cleanText(seg?.date, 10), time: cleanText(seg?.time, 5),
        }));
        if (!segments.length || segments.some((seg) => !seg.serviceIds.length || !seg.staffId || !/^\d{4}-\d{2}-\d{2}$/.test(seg.date) || !/^\d{2}:\d{2}$/.test(seg.time))) {
          return res.status(400).json({ error: "Completa todos los datos de la cita." });
        }
      }
      try {
        const appSession = await reservappSession(req);
        // canalOrigen/creadoPor identifican con precisión quién agendó la cita (cliente,
        // manicurista, asistente o administradora) -- no un genérico "PWA_EMPLEADO" que no
        // distinguía el rol real de quien la creó.
        let source, createdBy;
        if (req.body?.actorType === "employee") {
          if (appSession && !isClientRole(appSession.account.role)) {
            source = `RESERVAPP_${appSession.account.role.toUpperCase()}`;
            createdBy = { role: appSession.account.role, accountId: appSession.account.id };
          } else {
            const employee = await authorizeEmployeeBooking(req);
            if (employee === false) return res.status(403).json({ error: "Inicia sesión con una cuenta autorizada para reservar como empleado." });
            const erpRole = employee?.role || "administradora";
            source = `ERP_${erpRole.toUpperCase()}`;
            createdBy = { role: erpRole, email: employee?.email || null };
          }
        } else {
          if (!appSession || !isClientRole(appSession.account.role) || appSession.account.client_id !== clientId) {
            return res.status(401).json({ error: "Inicia sesión con tu teléfono y contraseña para reservar." });
          }
          source = "RESERVAPP_CLIENTE";
          createdBy = { role: "cliente", accountId: appSession.account.id };
        }

        if (rawSegments) {
          for (const seg of segments) {
            const availability = await bookingStore.availability(seg);
            if (!availability.slots?.some((slot) => slot.staffId === seg.staffId && slot.time === seg.time)) {
              return res.status(409).json({ error: "Uno de los horarios elegidos acaba de ocuparse. Vuelve a elegir.", conflict: true });
            }
            seg.endTime = new Date(new Date(`2000-01-01T${seg.time}:00Z`).getTime() + availability.durationMinutes * 60_000).toISOString().slice(11, 16);
          }
          const result = await bookingStore.createComboAppointment({ clientId, segments, notes, source, createdBy, idempotencyKey });
          if (result.conflict) return res.status(409).json({ error: "Uno de los horarios elegidos acaba de ocuparse. Vuelve a elegir.", conflict: true });
          if (result.missing) return res.status(404).json({ error: "Cliente, servicio o colaboradora no disponible." });
          let calendarSync = { skipped: true, reason: "combo" };
          for (const appt of result.appointments) {
            if (!appt.idempotent) calendarSync = await syncChangedAppointmentsToGoogleCalendar(env, appt.previousDocument, appt.document, { fetchImpl });
            if (!appt.idempotent && appt.legacyPayload) {
              const p = appt.legacyPayload;
              notifyNewAppointment(env, {
                legacyId: p.reservaID, clientName: p.clienteNombre, serviceName: p.servicio,
                staffName: p.colaboradorNombre, date: p.fecha, time: p.hora,
              }).catch(() => {});
            }
          }
          return res.status(201).json({
            appointments: result.appointments.map((a) => ({ id: a.appointment.id, reference: a.appointment.legacy_id })),
            groupId: result.groupId, depositAmount: 500, calendarSync,
          });
        }

        input.source = source; input.createdBy = createdBy;
        const availability = await bookingStore.availability(input);
        if (!availability.slots?.some((slot) => slot.staffId === input.staffId && slot.time === input.time)) return res.status(409).json({ error: "Ese horario acaba de ocuparse. Elige otro.", conflict: true });
        input.endTime = new Date(`2000-01-01T${input.time}:00Z`);
        input.endTime = new Date(input.endTime.getTime() + availability.durationMinutes * 60_000).toISOString().slice(11, 16);
        const result = await bookingStore.createAppointment(input);
        if (result.conflict) return res.status(409).json({ error: "Ese horario acaba de ocuparse. Elige otro.", conflict: true });
        if (result.missing) return res.status(404).json({ error: "Cliente, servicio o colaboradora no disponible." });
        const calendarSync = result.idempotent ? { skipped: true, reason: "idempotent" } : await syncChangedAppointmentsToGoogleCalendar(env, result.previousDocument, result.document, { fetchImpl });
        // Mejor esfuerzo, nunca bloquea ni revierte la reserva si el correo falla (ver
        // sendBusinessEmail en server/email.mjs).
        if (!result.idempotent && result.legacyPayload) {
          const p = result.legacyPayload;
          notifyNewAppointment(env, {
            legacyId: p.reservaID, clientName: p.clienteNombre, serviceName: p.servicio,
            staffName: p.colaboradorNombre, date: p.fecha, time: p.hora,
          }).catch(() => {});
        }
        res.status(result.idempotent ? 200 : 201).json({
          appointment: { id: result.appointment.id, reference: result.appointment.legacy_id },
          idempotent: Boolean(result.idempotent), depositAmount: 500, calendarSync,
        });
      } catch (error) { next(error); }
    });
  }

  app.get("/health", async (_req, res) => {
    try {
      const row = await store.read({ metadataOnly: true });
      res.status(row ? 200 : 503).json({ ok: Boolean(row), database: row ? "ready" : "missing" });
    } catch {
      res.status(503).json({ ok: false, database: "unavailable" });
    }
  });

  app.get("/api/me", authenticate, (req, res) => {
    const { userId, email, role, isActive, permissions } = req.erpIdentity;
    res.json({ userId, email, role, isActive, permissions });
  });

  app.get("/api/database", authenticate, async (req, res, next) => {
    try {
      const metadataOnly = req.query.metadata === "1";
      const row = await store.read({ metadataOnly });
      if (!row) return res.status(404).json({ error: "Base de datos no encontrada." });
      res.json(metadataOnly ? { updatedAt: row.updatedAt } : { data: row.data, updatedAt: row.updatedAt });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/database", authenticate, async (req, res, next) => {
    const payload = req.body;
    if (!payload?.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
      return res.status(400).json({ error: "Documento invalido." });
    }
    if (payload.expectedUpdatedAt != null && typeof payload.expectedUpdatedAt !== "string") {
      return res.status(400).json({ error: "Version esperada invalida." });
    }
    try {
      const current = await store.read();
      if (!current) return res.status(404).json({ error: "Base de datos no encontrada." });
      if (current.updatedAt !== (payload.expectedUpdatedAt || null)) {
        return res.status(409).json({ error: "Otra sesion guardo primero.", conflict: true, updatedAt: current.updatedAt });
      }
      const changes = detectDatabaseChanges(current.data, payload.data);
      const authorization = authorizeDatabaseChanges(req.erpIdentity, changes);
      if (!authorization.allowed) {
        return res.status(403).json({ error: "Tu usuario no esta autorizado para modificar estas areas." });
      }
      if (authorization.noChanges) return res.json({ saved: true, noChanges: true, updatedAt: current.updatedAt });
      const result = await store.save({
        document: payload.data,
        expectedUpdatedAt: payload.expectedUpdatedAt || null,
        identity: req.erpIdentity,
        changes: { domains: changes.domains, tables: changes.changedTables, envelope: changes.changedEnvelope },
      });
      if (result.missing) return res.status(404).json({ error: "Base de datos no encontrada." });
      if (result.conflict) {
        return res.status(409).json({ error: "Otra sesion guardo primero.", conflict: true, updatedAt: result.updatedAt });
      }
      const calendarSync = await syncChangedAppointmentsToGoogleCalendar(env, result.previousDocument, payload.data, { fetchImpl });
      res.json({
        saved: true,
        updatedAt: result.updatedAt,
        changes: { domains: changes.domains, tables: changes.changedTables },
        calendarSync,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/database-domain", authenticate, async (req, res, next) => {
    if (req.query.domain !== "inventario") return res.status(400).json({ error: "Dominio no disponible." });
    try {
      const row = await store.read();
      if (!row) return res.status(404).json({ error: "Base de datos no encontrada." });
      const slice = extractDomainSlice(row.data, "inventario");
      res.json({ domain: "inventario", data: slice.data, updatedAt: row.updatedAt, source: "neon" });
    } catch (error) {
      next(error);
    }
  });

  // --- Contenido editable de páginas públicas de marketing ----------------
  // Un documento JSON por sitio (hoy solo "dalfistudionails"), leído sin auth por la propia
  // página pública en cada carga y editado desde el panel "Página web" del ERP (outputs/app.js),
  // gateado por canManageConfiguration -- ver getSiteContent/saveSiteContent en server/store.mjs.
  const KNOWN_SITE_CONTENT_KEYS = new Set(["dalfistudionails"]);

  app.get("/api/site-content/:siteKey", async (req, res, next) => {
    try {
      if (!KNOWN_SITE_CONTENT_KEYS.has(req.params.siteKey)) return res.status(404).json({ error: "Sitio no encontrado." });
      const row = await bookingStore.getSiteContent(req.params.siteKey);
      if (!row) return res.status(404).json({ error: "Sitio no encontrado." });
      res.json(row);
    } catch (error) { next(error); }
  });

  app.put("/api/site-content/:siteKey", async (req, res, next) => {
    try {
      const auth = await requireErpPermission(webRequest(req), { ...env, fetch: fetchImpl }, "canManageConfiguration", "editar el contenido del sitio");
      if (auth.error) return relayAuthError(res, auth.error);
      if (!KNOWN_SITE_CONTENT_KEYS.has(req.params.siteKey)) return res.status(404).json({ error: "Sitio no encontrado." });
      if (!req.body?.content || typeof req.body.content !== "object" || Array.isArray(req.body.content)) {
        return res.status(400).json({ error: "Contenido inválido." });
      }
      const saved = await bookingStore.saveSiteContent(req.params.siteKey, req.body.content, auth.identity.email);
      res.json(saved);
    } catch (error) { next(error); }
  });

  // --- Gestion de usuarios (Supabase Auth) --------------------------------
  // Puerto de functions/api/users.js, create-user.js y audit-log.js (Cloudflare
  // Pages Functions). Esas rutas dejaron de desplegarse cuando la app se migro
  // a este servidor Express en Render (ver comentario de supabaseOrigin mas
  // arriba: "el auth legado nunca se migro"), pero outputs/app.js seguia
  // llamando a /api/users, /api/create-user y /api/audit-log esperando estas
  // mismas rutas. Sin ellas registradas aqui, esas peticiones caian en el
  // catch-all de la SPA (mas abajo) y devolvian el index.html con status 200
  // en vez de JSON: el fetch "tenia exito" pero result.users quedaba
  // undefined, asi que el panel de Usuarios mostraba "No hay usuarios
  // registrados" en vez de un error real, aunque Supabase Auth nunca fallo.
  const generateTemporaryPassword = () => {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("") + "#1";
  };

  const relayAuthError = async (res, response) => {
    const body = await response.json().catch(() => ({ error: "No autorizado." }));
    return res.status(response.status).json(body);
  };

  const normalizeUserEmail = (value = "") => String(value || "").trim().toLowerCase();

  function isInactiveAuthUser(user) {
    if (user.user_metadata?.estado === "Inactivo") return true;
    if (!user.banned_until) return false;
    return new Date(user.banned_until).getTime() > Date.now();
  }

  function toPublicUser(user, profile) {
    return {
      id: user.id,
      email: user.email,
      fullName: user.user_metadata?.full_name || "",
      role: profile?.role || user.user_metadata?.role || "operador",
      canReviewAccounts: profile ? Boolean(profile.can_review_accounts) : Boolean(user.user_metadata?.canReviewAccounts),
      canReviewAudit: Boolean(profile?.can_review_audit),
      permissions: profile ? permissionOverridesFromProfile(profile) : {},
      estado: profile ? (profile.is_active ? "Activo" : "Inactivo") : isInactiveAuthUser(user) ? "Inactivo" : "Activo",
      passwordResetRequired: Boolean(user.user_metadata?.password_reset_required),
      hasSecureProfile: Boolean(profile),
      createdAt: user.created_at,
      lastSignInAt: user.last_sign_in_at,
    };
  }

  app.get("/api/users", async (req, res, next) => {
    try {
      const auth = await requireErpPermission(webRequest(req), { ...env, fetch: fetchImpl }, "canManageUsers", "administrar usuarios");
      if (auth.error) return relayAuthError(res, auth.error);
      const supabaseUrl = env.SUPABASE_URL;
      const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseUrl || !serviceRoleKey) return res.status(500).json({ error: "Faltan variables privadas de Supabase." });

      const [usersResponse, profilesResponse] = await Promise.all([
        fetchImpl(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=200`, {
          headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
        }),
        fetchImpl(`${supabaseUrl}/rest/v1/erp_user_profiles?select=*`, {
          headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
        }),
      ]);
      const body = await usersResponse.json().catch(() => ({}));
      if (!usersResponse.ok) {
        return res.status(usersResponse.status).json({ error: body.msg || body.error || "No se pudo cargar usuarios." });
      }
      const profiles = profilesResponse.ok ? await profilesResponse.json().catch(() => []) : [];
      const profileByUserId = new Map((profiles || []).map((row) => [row.user_id, row]));
      res.json({ users: (body.users || []).map((user) => toPublicUser(user, profileByUserId.get(user.id))) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/users", async (req, res, next) => {
    try {
      const auth = await requireErpPermission(webRequest(req), { ...env, fetch: fetchImpl }, "canManageUsers", "administrar usuarios");
      if (auth.error) return relayAuthError(res, auth.error);
      const { identity } = auth;
      const supabaseUrl = env.SUPABASE_URL;
      const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseUrl || !serviceRoleKey) return res.status(500).json({ error: "Faltan variables privadas de Supabase." });
      const requesterEmail = identity.email;
      const requesterId = identity.userId;
      const requesterRole = identity.role;

      const payload = req.body || {};
      const userId = String(payload.id || "").trim();
      if (!userId) return res.status(400).json({ error: "Falta el ID del usuario." });

      const currentResponse = await fetchImpl(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      });
      const currentUser = await currentResponse.json().catch(() => ({}));
      if (!currentResponse.ok) {
        return res.status(currentResponse.status).json({ error: currentUser.msg || currentUser.error || "No se pudo leer el usuario." });
      }

      const currentMetadata = currentUser.user_metadata || {};
      const update = {};
      const fullName = String(payload.fullName || "").trim();
      const role = normalizeRole(payload.role);
      const hasEstado = Object.prototype.hasOwnProperty.call(payload, "estado");
      const estado = payload.estado === "Inactivo" ? "Inactivo" : "Activo";
      const email = normalizeUserEmail(payload.email);
      const password = String(payload.password || "");
      const resetPassword = Boolean(payload.resetPassword);
      const temporaryPassword = resetPassword ? generateTemporaryPassword() : password;
      const hasCanReviewAccounts = Object.prototype.hasOwnProperty.call(payload, "canReviewAccounts");
      const hasCanReviewAudit = Object.prototype.hasOwnProperty.call(payload, "canReviewAudit");
      const hasPermissions = Object.prototype.hasOwnProperty.call(payload, "permissions");
      const requestedPermissions = hasPermissions ? sanitizePermissionOverrides(payload.permissions) : null;

      const hasUnknownPermission = hasPermissions
        && Object.keys(payload.permissions || {}).some((key) => !Object.prototype.hasOwnProperty.call(PROFILE_PERMISSION_MAP, key));
      if (hasPermissions && (!requestedPermissions || Object.keys(requestedPermissions).length === 0 || hasUnknownPermission)) {
        return res.status(400).json({ error: "La matriz de permisos no es valida." });
      }
      if (temporaryPassword && temporaryPassword.length < 6) {
        return res.status(400).json({ error: "La contrasena debe tener al menos 6 caracteres." });
      }

      const priorProfile = await fetchErpProfile({ ...env, fetch: fetchImpl }, userId);
      const isActive = hasEstado ? estado !== "Inactivo" : priorProfile ? Boolean(priorProfile.is_active) : true;
      const priorPermissions = priorProfile ? permissionOverridesFromProfile(priorProfile) : null;
      const permissionOverrides = hasPermissions ? { ...(priorPermissions || {}), ...requestedPermissions } : priorPermissions;
      const proposedCanManageUsers = Object.prototype.hasOwnProperty.call(permissionOverrides || {}, "canManageUsers")
        ? permissionOverrides.canManageUsers
        : defaultPermissionsForRole(role).can_manage_users;
      if (userId === requesterId && (!isActive || !proposedCanManageUsers)) {
        return res.status(400).json({ error: "No puedes inactivar tu propio usuario ni retirarte el permiso de administrar usuarios." });
      }
      const canReviewAccountsOverride = hasCanReviewAccounts
        ? Boolean(payload.canReviewAccounts)
        : priorProfile ? Boolean(priorProfile.can_review_accounts) : undefined;
      const canReviewAuditOverride = hasCanReviewAudit
        ? Boolean(payload.canReviewAudit)
        : priorProfile ? Boolean(priorProfile.can_review_audit) : undefined;

      const profileResult = await upsertErpProfile({ ...env, fetch: fetchImpl }, {
        userId,
        email: email || currentUser.email,
        role,
        isActive,
        canReviewAccountsOverride,
        canReviewAuditOverride,
        permissionOverrides,
      });
      if (!profileResult.ok) {
        console.error(`api/users PATCH: fallo sincronizar erp_user_profiles para ${userId}, se aborta sin tocar Auth: ${profileResult.error}`);
        await insertAuditLog({ ...env, fetch: fetchImpl }, {
          tableName: "usuarios", entityId: userId, action: "update_user", oldData: null, newData: null,
          userId: requesterId, userEmail: requesterEmail, userRole: requesterRole, success: false,
          note: "No se pudo sincronizar el perfil seguro; la operacion se aborto sin modificar nada en Auth.",
        }).catch(() => null);
        return res.status(500).json({ error: "No se pudo actualizar el usuario. Intenta de nuevo." });
      }

      update.user_metadata = { ...currentMetadata, full_name: fullName, role, updated_by: requesterEmail };
      if (email) update.email = email;
      if (temporaryPassword) {
        update.password = temporaryPassword;
        update.user_metadata.password_reset_required = true;
        update.user_metadata.password_reset_reason = resetPassword ? "admin_reset" : "admin_password_update";
        update.user_metadata.password_reset_at = new Date().toISOString();
      }
      if (hasCanReviewAccounts) update.user_metadata.canReviewAccounts = Boolean(payload.canReviewAccounts);
      if (hasEstado) {
        update.user_metadata.estado = estado;
        update.ban_duration = estado === "Inactivo" ? "876000h" : "none";
      }

      const response = await fetchImpl(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
        body: JSON.stringify(update),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const failureMessage = body.msg || body.message || body.error_description || body.error || "No se pudo actualizar el usuario.";
        const compensation = priorProfile
          ? await upsertErpProfile({ ...env, fetch: fetchImpl }, {
              userId,
              email: priorProfile.email,
              role: priorProfile.role,
              isActive: priorProfile.is_active,
              canReviewAccountsOverride: priorProfile.can_review_accounts,
              canReviewAuditOverride: priorProfile.can_review_audit,
              permissionOverrides: permissionOverridesFromProfile(priorProfile),
            })
          : await deleteErpProfile({ ...env, fetch: fetchImpl }, userId);
        if (!compensation.ok) {
          console.error(`api/users PATCH: Auth rechazo el cambio Y TAMBIEN fallo revertir erp_user_profiles para ${userId}: ${compensation.error}`);
        }
        await insertAuditLog({ ...env, fetch: fetchImpl }, {
          tableName: "usuarios", entityId: userId, action: resetPassword ? "reset_password" : "update_user",
          oldData: { email: currentUser.email }, newData: null,
          userId: requesterId, userEmail: requesterEmail, userRole: requesterRole, success: false,
          note: compensation.ok
            ? `${failureMessage} (el perfil seguro se revirtio automaticamente)`
            : `${failureMessage} (ADEMAS fallo revertir el perfil seguro, requiere revision manual)`,
        }).catch(() => null);
        return res.status(response.status).json({ error: failureMessage });
      }

      if (resetPassword) {
        await fetchImpl(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}/logout`, {
          method: "POST",
          headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
        }).catch(() => null);
        await insertAuditLog({ ...env, fetch: fetchImpl }, {
          tableName: "usuarios", entityId: userId, action: "reset_password",
          oldData: { email: currentUser.email, password_reset_required: Boolean(currentMetadata.password_reset_required) },
          newData: { email: body.email, password_reset_required: true, password_reset_reason: update.user_metadata.password_reset_reason },
          userId: requesterId, userEmail: requesterEmail, userRole: requesterRole, success: true,
          note: `Contrasena temporal generada por ${requesterEmail} para ${body.email || currentUser.email}.`,
        }).catch(() => null);
      }

      await insertAuditLog({ ...env, fetch: fetchImpl }, {
        tableName: "usuarios", entityId: userId, action: "update_user_permissions",
        oldData: priorProfile ? { role: priorProfile.role, isActive: priorProfile.is_active, permissions: priorPermissions } : null,
        newData: { role, isActive, permissions: permissionOverridesFromProfile(profileResult.profile) },
        userId: requesterId, userEmail: requesterEmail, userRole: requesterRole, success: true,
        note: `Perfil y permisos actualizados por ${requesterEmail}.`,
      }).catch(() => null);

      res.json({ user: toPublicUser(body, profileResult.profile), temporaryPassword: resetPassword ? temporaryPassword : undefined });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/create-user", async (req, res, next) => {
    try {
      const auth = await requireErpPermission(webRequest(req), { ...env, fetch: fetchImpl }, "canManageUsers", "crear usuarios");
      if (auth.error) return relayAuthError(res, auth.error);
      const { identity } = auth;
      const supabaseUrl = env.SUPABASE_URL;
      const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseUrl || !serviceRoleKey) return res.status(500).json({ error: "Faltan variables privadas de Supabase." });
      const requesterEmail = identity.email;
      const requesterId = identity.userId;
      const requesterRole = identity.role;

      const payload = req.body || {};
      const email = normalizeUserEmail(payload.email);
      const password = String(payload.password || "") || generateTemporaryPassword();
      const fullName = String(payload.fullName || "").trim();
      const role = normalizeRole(payload.role);
      const hasPermissions = Object.prototype.hasOwnProperty.call(payload, "permissions");
      const permissionOverrides = hasPermissions ? sanitizePermissionOverrides(payload.permissions) : null;
      const hasUnknownPermission = hasPermissions
        && Object.keys(payload.permissions || {}).some((key) => !Object.prototype.hasOwnProperty.call(PROFILE_PERMISSION_MAP, key));

      if (!email) return res.status(400).json({ error: "El correo es obligatorio." });
      if (password.length < 6) return res.status(400).json({ error: "La contrasena debe tener al menos 6 caracteres." });
      if (hasPermissions && (!permissionOverrides || Object.keys(permissionOverrides).length === 0 || hasUnknownPermission)) {
        return res.status(400).json({ error: "La matriz de permisos no es valida." });
      }

      const createResponse = await fetchImpl(`${supabaseUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
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
        const failureMessage = created.msg || created.error_description || created.error || "No se pudo crear el usuario.";
        await insertAuditLog({ ...env, fetch: fetchImpl }, {
          tableName: "usuarios", entityId: email, action: "create_user", oldData: null, newData: null,
          userId: requesterId, userEmail: requesterEmail, userRole: requesterRole, success: false,
          note: `Intento de creacion de usuario fallido: ${failureMessage}`,
        }).catch(() => null);
        return res.status(createResponse.status).json({ error: failureMessage });
      }

      const profileResult = await upsertErpProfile({ ...env, fetch: fetchImpl }, {
        userId: created.id, email: created.email || email, role, isActive: true, permissionOverrides,
      });
      if (!profileResult.ok) {
        console.error(`api/create-user: fallo el alta de erp_user_profiles para ${created.id}, compensando (borrando el usuario Auth huerfano): ${profileResult.error}`);
        const deleteResponse = await fetchImpl(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(created.id)}`, {
          method: "DELETE",
          headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
        }).catch((error) => {
          console.error(`api/create-user: tambien fallo borrar el usuario Auth huerfano ${created.id}:`, error);
          return null;
        });
        const compensated = Boolean(deleteResponse?.ok);
        await insertAuditLog({ ...env, fetch: fetchImpl }, {
          tableName: "usuarios", entityId: created.id || email, action: "create_user", oldData: null,
          newData: { email: created.email || email, role },
          userId: requesterId, userEmail: requesterEmail, userRole: requesterRole, success: false,
          note: compensated
            ? "El usuario se creo en Auth pero fallo el alta del perfil seguro; se revirtio borrando el usuario Auth huerfano."
            : `ALERTA: el usuario se creo en Auth (id ${created.id}) pero fallo el alta del perfil seguro Y TAMBIEN fallo borrarlo. Requiere revision manual en Supabase Auth.`,
        }).catch(() => null);
        return res.status(500).json({ error: "No se pudo completar la creacion del usuario. Intenta de nuevo o contacta soporte." });
      }

      await insertAuditLog({ ...env, fetch: fetchImpl }, {
        tableName: "usuarios", entityId: created.id || email, action: "create_user", oldData: null,
        newData: {
          email: created.email || email,
          role,
          permissions: profileResult.profile
            ? Object.fromEntries(Object.entries(PROFILE_PERMISSION_MAP).map(([camelKey, sqlColumn]) => [camelKey, Boolean(profileResult.profile[sqlColumn])]))
            : null,
          created_by: requesterEmail,
        },
        userId: requesterId, userEmail: requesterEmail, userRole: requesterRole, success: true,
        note: `Usuario creado con contrasena temporal por ${requesterEmail}.`,
      }).catch(() => null);

      res.json({ id: created.id, email: created.email || email, temporaryPassword: password });
    } catch (error) {
      next(error);
    }
  });

  const ALLOWED_AUDIT_ACTIONS = new Set([
    "reset_password", "invoice_edit", "invoice_edit_blocked", "reservation_edit",
    "closing_attempt_shortage", "closing_register_confirm", "closing_treasury_confirm_range",
    "closing_treasury_confirm_blocked", "closing_reopen", "closing_surplus", "closing_catchup_run",
    "transfer_confirm", "create_client_from_invoice", "create_client", "edit_client",
    "expense_create", "expense_edit",
  ]);

  app.post("/api/audit-log", async (req, res, next) => {
    try {
      const requester = await resolveRequester(webRequest(req), { ...env, fetch: fetchImpl });
      if (!requester) return res.status(401).json({ error: "Sesion invalida. Vuelve a iniciar sesion." });
      const payload = req.body || {};
      const action = String(payload.action || "").trim();
      if (!ALLOWED_AUDIT_ACTIONS.has(action)) return res.status(400).json({ error: "Accion de auditoria no reconocida." });

      const result = await insertAuditLog({ ...env, fetch: fetchImpl }, {
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
      if (!result.ok) {
        console.error("audit-log: fallo insertAuditLog", result.error);
        return res.status(500).json({ error: "No se pudo registrar la auditoria." });
      }
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  registerLegacyBookingApi(app, { store, env, fetchImpl });

  if (staticDir) {
    app.use("/reservar", express.static(`${staticDir}/reservar`, { extensions: ["html"] }));
    app.get("/reservar", (_req, res) => res.sendFile("index.html", { root: `${staticDir}/reservar` }));
    app.use(express.static(staticDir, { extensions: ["html"] }));
    app.get("/{*splat}", (_req, res) => res.sendFile("index.html", { root: staticDir }));
  }

  app.use((error, _req, res, _next) => {
    if (error?.type === "entity.too.large") return res.status(413).json({ error: "Solicitud demasiado grande." });
    if (error instanceof SyntaxError) return res.status(400).json({ error: "Solicitud invalida." });
    console.error("api:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  });
  return app;
}
