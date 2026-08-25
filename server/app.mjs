import express from "express";
import { resolveErpIdentity } from "../functions/api/_lib/authz.js";
import { authorizeDatabaseChanges, detectDatabaseChanges } from "../functions/api/_lib/database-authz.js";
import { extractDomainSlice } from "../functions/api/_lib/domain-slices.js";
import { syncChangedAppointmentsToGoogleCalendar } from "../functions/api/_lib/google-calendar.js";
import { registerLegacyBookingApi } from "./legacy-booking-api.mjs";
import { businessMinutesBetween } from "./store.mjs";
import {
  RESERVAPP_ROLES,
  generateOtpCode,
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
    const allowedOrigin = String(env.FAST_BOOKING_ORIGIN || "https://reservapp.sebengroup.com").replace(/\/$/, "");
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
  app.use((req, res, next) => {
    const bookingHost = String(env.FAST_BOOKING_HOST || "reservapp.sebengroup.com").toLowerCase();
    const suiteHost = String(env.SEBEN_SUITE_HOST || "ssc.sebengroup.com").toLowerCase();
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
  const cleanServiceIds = (value) => [...new Set((Array.isArray(value) ? value : String(value || "").split(",")).map((item) => cleanText(item, 64)).filter(Boolean))].slice(0, 12);
  const authorizeEmployeeBooking = async (req) => {
    if (req.body?.actorType !== "employee") return null;
    const identity = await resolveErpIdentity(webRequest(req), { ...env, fetch: fetchImpl });
    if (identity.error || !identity.permissions?.canManageReservations) return false;
    return identity;
  };

  // El flujo público definitivo para crear/vincular una clienta es
  // /api/reservapp/auth/request-setup (crea la ficha internamente y siempre termina en el
  // envío del enlace de credenciales por WhatsApp). client/resolve y clients (POST) no los usa
  // ningún flujo público real — dejarlos accesibles sin autenticación permite enumerar
  // teléfonos/nombres de clientas existentes y llenar la ERP de fichas huérfanas sin pasar por
  // ese flujo. Solo personal autorizado (misma regla que la búsqueda GET /clients) puede
  // usarlos, para herramientas administrativas internas.
  const requireBookingStaff = async (req, res) => {
    const session = await reservappSession(req);
    if (session && ["manicurista", "asistente", "administradora", "superadministrador"].includes(session.account.role)) return true;
    const identity = await resolveErpIdentity(webRequest(req), { ...env, fetch: fetchImpl });
    if (identity.error || !identity.permissions?.canManageReservations) {
      res.status(403).json({ error: "No tienes permiso para gestionar clientas." });
      return false;
    }
    return true;
  };

  // La manicurista puede crear una clienta nueva directamente con solo su
  // teléfono, igual que asistente/administradora -- la verificación real ya
  // no ocurre aquí. Se mueve al punto donde la clienta usa esa identidad de
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
    const bridgeBase = String(env.CHATBOT_BRIDGE_URL || "https://bot.sebengroup.com").replace(/\/$/, "");
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
      // Código de 6 dígitos, no enlace mágico: la clienta lo escribe en la app para probar que
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
    const bridgeBase = String(env.CHATBOT_BRIDGE_URL || "https://bot.sebengroup.com").replace(/\/$/, "");
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
  // ningún cambio: sigue atendiendo la respuesta de la clienta con su menú
  // "1. Confirmar mi hora / 2. Reagendar / 3. Menú principal" y llamando de vuelta a
  // POST /api/reservapp/booking/confirm-attendance cuando confirma. No usa outbox (no es un
  // código de un solo uso, es un aviso reintentable cada hora por el propio cron si falla).
  const sendConfirmationReminderWhatsApp = async ({ reservationId, phone, clientName, date, time, service, stage }) => {
    const bridgeSecret = String(env.ERP_WEBHOOK_SECRET || "");
    if (!bridgeSecret) return { ok: false, reason: "pending_configuration" };
    const bridgeBase = String(env.CHATBOT_BRIDGE_URL || "https://bot.sebengroup.com").replace(/\/$/, "");
    const text = stage === "second"
      ? `Hola ${clientName || ""}. Tu cita de ${service || "tu servicio"} el ${date} a las ${time} está a punto de liberarse porque no hemos recibido tu confirmación. Responde "1" para confirmar tu hora ahora mismo, o la podríamos ofrecer a otra clienta.`.trim()
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
    // una cuenta activa con ese número (y su primer nombre, para que confirme "sí, soy yo")
    // antes de pedir nombre/apellido/correo completos. Mismo candado que request-setup: solo
    // revela status==='active' (una cuenta pending/sin activar sigue el registro normal, que ya
    // reutiliza esa misma ficha) y solo el primer nombre, nunca el resto de los datos.
    app.post("/api/reservapp/auth/check-phone", bookingRateLimit, async (req, res, next) => {
      const phone = cleanText(req.body?.phone, 30);
      if (!validPhone(phone)) return res.status(400).json({ error: "Escribe un teléfono válido." });
      try {
        const existing = await bookingStore.accountByPhone(phone);
        if (existing?.status !== "active") return res.json({ exists: false });
        const firstName = String(existing.full_name || "").trim().split(/\s+/)[0] || "";
        res.json({ exists: true, firstName });
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
      if (!firstName || !lastName || !validPhone(phone)) return res.status(400).json({ error: "Nombre, apellido y teléfono válido son obligatorios." });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "El correo no tiene un formato válido." });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || birthDate > new Date().toISOString().slice(0, 10)) {
        return res.status(400).json({ error: "Introduce una fecha de nacimiento válida." });
      }
      // Registrarse (crear cuenta) no requiere tener ya un horario elegido --
      // solo si la clienta arrancó desde el wizard de reserva vendrá un
      // borrador adjunto, y en ese caso sí debe venir completo.
      const hasDraftIntent = Boolean(serviceIds.length || draft.staffId || draft.date || draft.time);
      if (hasDraftIntent && (!serviceIds.length || !draft.staffId || !/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || !/^\d{2}:\d{2}$/.test(draft.time))) {
        return res.status(400).json({ error: "Selecciona servicios, manicurista, fecha y hora, o deja todo vacío para solo crear tu cuenta." });
      }
      try {
        if (hasDraftIntent) {
          const availability = await bookingStore.availability({ ...draft, serviceIds });
          if (!availability.slots?.some((slot) => slot.staffId === draft.staffId && slot.time === draft.time)) {
            return res.status(409).json({ error: "Ese horario acaba de ocuparse. Elige otro.", conflict: true });
          }
        }
        let customer = await bookingStore.resolveClient({ phone });
        if (!customer) {
          const id = `CLI-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
          const legacyPayload = {
            clienteID: id, nombre: firstName, apellido: lastName, nombreCompleto: `${firstName} ${lastName}`,
            telefono: phone, correo: email, estado: "Activo", origenRegistro: "RESERVAPP_CLIENTE",
            fechaNacimiento: birthDate, sexo: sex, direccion: address, servicioPreferido: preferredService,
            fechaRegistro: new Date().toISOString(), observaciones: "Creado al solicitar credenciales de ReservApp.",
          };
          const created = await bookingStore.createClient({
            firstName, lastName, fullName: legacyPayload.nombreCompleto, phone, email, source: "RESERVAPP_CLIENTE", legacyPayload,
            birthDate, sex, address, preferredService,
          });
          if (created.duplicate) customer = await bookingStore.resolveClient({ phone });
          else customer = created.client;
        }
        if (!customer) return res.status(409).json({ error: "No pudimos vincular el teléfono con una ficha de cliente." });
        const existing = await bookingStore.accountByPhone(phone);
        if (existing?.status === "active") {
          // Primer nombre nada más -- suficiente para que confirme "sí, soy yo" sin exponerle
          // el apellido/nombre completo a quien haya escrito un teléfono que no es suyo.
          const firstName = String(existing.full_name || "").trim().split(/\s+/)[0] || "";
          return res.status(409).json({ error: "Ese teléfono ya tiene credenciales. Inicia sesión para reservar.", accountExists: true, firstName });
        }
        const account = await bookingStore.ensureClientAccount({ clientId: customer.id, phone });
        const code = generateOtpCode();
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        const prepared = await bookingStore.prepareSetup({ accountId: account.id, tokenHash: hashToken(code), expiresAt, recipientPhone: phone, draft: hasDraftIntent ? draft : null });
        // TEMPORAL (quitar cuando Meta apruebe WHATSAPP_ACTIVATION_TEMPLATE_NAME en el bridge de
        // WhatsApp -- dalfi-chatbot-n8n): sin esa plantilla aprobada, el bridge no puede iniciar
        // conversación con una clienta nueva (fuera de la ventana de 24h) y el código de
        // verificación nunca llega, dejando el autorregistro completamente bloqueado. Con
        // RESERVAPP_SKIP_PHONE_VERIFICATION=true nos "autoverificamos" el mismo código que
        // acabamos de generar (mismo verifySetupOtp que usa /setup/verify-code, mismas reglas de
        // expiración/consumo de un solo uso) y devolvemos el activationTicket directo, sin pasar
        // por WhatsApp. La clienta sigue eligiendo su propia contraseña -- lo único que se salta
        // es la prueba de que controla ese teléfono. Para revertir: borrar esta rama `if` y la
        // env var en Render, no hace falta tocar nada más.
        if (String(env.RESERVAPP_SKIP_PHONE_VERIFICATION || "") === "true") {
          const activationTicket = secureToken();
          const newExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
          const verify = await bookingStore.verifySetupOtp({ accountId: account.id, codeHash: hashToken(code), newTokenHash: hashToken(activationTicket), newExpiresAt });
          if (!verify.notFound && !verify.locked && !verify.invalid) {
            return res.status(202).json({
              pendingConfirmation: false,
              bypassedPhoneVerification: true,
              activationTicket,
              message: "Verificación de WhatsApp deshabilitada temporalmente. Crea tu contraseña para confirmar la cita.",
            });
          }
        }
        const delivery = await sendSetupWhatsApp({ outboxId: prepared.outbox.id, phone, code, name: `${firstName} ${lastName}` });
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

    // Primer paso del setup en dos pasos: probar que la clienta/colaboradora controla el
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
        if (!account) return res.status(410).json({ error: "El código venció o no fue solicitado. Solicita uno nuevo.", code: "OTP_NOT_FOUND" });
        const activationTicket = secureToken();
        const newExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        const result = await bookingStore.verifySetupOtp({
          accountId: account.id,
          codeHash: hashToken(code),
          newTokenHash: hashToken(activationTicket),
          newExpiresAt,
        });
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
        const account = await bookingStore.activateWithToken({ tokenHash: hashToken(token), passwordHash: await hashPassword(password), sessionTokenHash: hashToken(sessionToken), sessionExpiresAt });
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
            createdBy: { role: "clienta", accountId: account.account_id },
            idempotencyKey: account.draft.idempotency_key,
          };
          const availability = await bookingStore.availability(input);
          if (availability.slots?.some((slot) => slot.staffId === input.staffId && slot.time === input.time)) {
            input.endTime = new Date(new Date(`2000-01-01T${input.time}:00Z`).getTime() + availability.durationMinutes * 60_000).toISOString().slice(11, 16);
            const created = await bookingStore.createAppointment(input);
            if (!created.conflict && !created.missing) {
              appointment = { id: created.appointment.id, reference: created.appointment.legacy_id };
              await bookingStore.markDraftConfirmed(account.draft.id, created.appointment.id);
              if (!created.idempotent) await syncChangedAppointmentsToGoogleCalendar(env, created.previousDocument, created.document, { fetchImpl });
            } else bookingError = "Tu cuenta quedó activa, pero el horario se ocupó. Inicia sesión y elige otro.";
          } else bookingError = "Tu cuenta quedó activa, pero el horario se ocupó. Inicia sesión y elige otro.";
        }
        res.set("Set-Cookie", sessionCookie(sessionToken, 30 * 86_400));
        res.json({ account: publicAccount(account), appointment, bookingError });
      } catch (error) { next(error); }
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
    // única diferencia real es que aquí NO se crea una clienta nueva ni se adjunta un draft de
    // cita, y solo procede si la cuenta ya existe y está activa.
    app.post("/api/reservapp/auth/request-password-reset", bookingRateLimit, async (req, res, next) => {
      const phone = cleanText(req.body?.phone, 30);
      if (!validPhone(phone)) return res.status(400).json({ error: "Introduce un teléfono válido de 10 dígitos." });
      // TEMPORAL (mismo interruptor que RESERVAPP_SKIP_PHONE_VERIFICATION, ver comentario junto a
      // /auth/request-setup): saltarse la prueba de teléfono para CREAR una cuenta nueva es un
      // riesgo aceptable, pero hacerlo para restablecer la contraseña de una cuenta YA ACTIVA no
      // -- cualquiera que supiera el número de otra clienta podría robarle el acceso sin que
      // llegue ningún código real. Mientras el bridge no pueda mandar ese código por WhatsApp, el
      // autoservicio de "olvidé mi contraseña" queda apagado: solo administración puede
      // restablecer una contraseña, con POST /api/reservapp/admin/accounts/:id/reset-password.
      if (String(env.RESERVAPP_SKIP_PHONE_VERIFICATION || "") === "true") {
        return res.status(202).json({
          pendingConfirmation: false,
          selfServiceDisabled: true,
          message: "Por ahora no podemos verificar tu teléfono por WhatsApp. Escríbenos o pide en el salón que la administración restablezca tu contraseña.",
        });
      }
      try {
        const account = await bookingStore.accountByPhone(phone);
        // Misma respuesta exista o no la cuenta -- este endpoint no debe servir para enumerar
        // qué teléfonos tienen cuenta activa en ReservApp.
        if (account?.status === "active") {
          const code = generateOtpCode();
          const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
          const prepared = await bookingStore.prepareSetup({ accountId: account.id, tokenHash: hashToken(code), expiresAt, recipientPhone: phone });
          await sendSetupWhatsApp({ outboxId: prepared.outbox.id, phone, code, name: account.full_name || "", purpose: "reset" });
        }
        res.status(202).json({
          pendingConfirmation: true,
          message: "Si ese teléfono tiene una cuenta activa, te enviamos por WhatsApp un código para restablecer tu contraseña.",
        });
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

    // "Citas activas" / historial para una clienta -- a diferencia de /agenda (un día, vista de
    // equipo), esta ruta es exclusiva de cuentas clienta y siempre usa su propio client_id de la
    // sesión, nunca uno recibido del cliente.
    app.get("/api/reservapp/my-appointments", requireReservapp, async (req, res, next) => {
      if (req.reservapp.account.role !== "clienta") return res.status(403).json({ error: "Solo disponible para cuentas de clienta." });
      const scope = req.query.scope === "history" ? "history" : "active";
      try { res.json({ appointments: await bookingStore.listClientAppointments({ clientId: req.reservapp.account.client_id, scope }) }); }
      catch (error) { next(error); }
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
      if (!RESERVAPP_ROLES.includes(role) || role === "clienta" || !staffId || !validPhone(phone)) {
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
      if (role && (!RESERVAPP_ROLES.includes(role) || role === "clienta")) return res.status(400).json({ error: "Rol inválido." });
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
    // Sirve tanto para personal como para clientas -- reservapp_accounts.id es el mismo id que
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

    app.get("/api/reservapp/admin/clients", bookingRateLimit, async (req, res, next) => {
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede ver clientas." });
        res.json({ clients: await bookingStore.listClientsForAdmin({ query: cleanText(req.query.q, 120) }) });
      } catch (error) { next(error); }
    });

    app.patch("/api/reservapp/admin/clients/:id", bookingRateLimit, async (req, res, next) => {
      const status = cleanText(req.body?.status, 20);
      if (!["active", "blocked"].includes(status)) return res.status(400).json({ error: "Estado inválido." });
      try {
        const { allowed } = await resolveAdminAuthority(req);
        if (!allowed) return res.status(403).json({ error: "Solo administración puede editar clientas." });
        const updated = await bookingStore.updateClientStatus({ id: req.params.id, status });
        if (!updated) return res.status(404).json({ error: "Clienta no encontrada." });
        res.json({ client: updated });
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
        const bridgeBase = String(env.CHATBOT_BRIDGE_URL || "https://bot.sebengroup.com").replace(/\/$/, "");
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

    // Motor de recordatorios de confirmación de asistencia -- disparado por un Cloudflare Worker
    // con Cron Trigger cada hora (workers/booking-reminder-cron/), mismo mecanismo que antes de
    // eliminar dalfi-erp.pages.dev, solo que ahora apunta aquí en vez de a esa Pages Function
    // muerta. Aplica a TODA cita futura sin importar canal de origen (ver createAppointment) --
    // "Programada" recibe recordatorio a <=4h laborales de la cita; "PendienteConfirmarHora"
    // recibe el segundo + libera el horario a >=1h laboral después del primero sin respuesta
    // (ver businessMinutesBetween/resolveBusinessDayWindow en store.mjs).
    app.post("/api/booking/send-reminders", async (req, res, next) => {
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

    // Confirma la asistencia de una cita -- llamado por el Chatbot Bridge cuando la clienta
    // responde "1. Confirmar mi hora" por WhatsApp (x-webhook-secret compartido, mismo que usa el
    // bridge para notify-invoice-sent.js), por el botón "Confirmar cita en salón" del ERP legado
    // (sesión de administración), o por la propia clienta desde "Citas activas" en ReservApp
    // (sesión clienta -- acotada a su propio client_id dentro de confirmAppointmentAttendance,
    // nunca confía en el reservationId por sí solo). Si el horario ya fue tomado por otra reserva
    // mientras esta esperaba (EspacioLiberado -> otra cita ocupó esa colaboradora+horario),
    // responde alreadyReassigned:true para que quien llama le pida a la clienta elegir otro horario.
    app.post("/api/reservapp/booking/confirm-attendance", bookingRateLimit, async (req, res, next) => {
      const bridgeSecret = String(env.ERP_WEBHOOK_SECRET || "");
      const viaBridge = bridgeSecret && (req.get("x-webhook-secret") || "") === bridgeSecret;
      let clientId = null;
      if (!viaBridge) {
        const session = await reservappSession(req);
        if (session?.account.role === "clienta") {
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

    // Relay OTP: cuando una MANICURISTA quiere agendar a una clienta que
    // todavía no existe en el sistema, primero debe comprobar que controla
    // ese teléfono con un código de 6 dígitos enviado por WhatsApp -- no
    // puede simplemente inventar un número y convertirlo en identidad
    // verificada (a diferencia de asistente/administradora, que sí pueden
    // crear clientas directamente vía POST /api/fast-booking/clients).
    app.post("/api/reservapp/clients/relay-otp/request", bookingRateLimit, async (req, res, next) => {
      const session = await requireManicuristaOrAbove(req, res);
      if (!session) return;
      const phone = cleanText(req.body?.phone, 30);
      const firstName = cleanText(req.body?.firstName, 80);
      const lastName = cleanText(req.body?.lastName, 80);
      const email = cleanText(req.body?.email, 160).toLowerCase();
      if (!validPhone(phone)) return res.status(400).json({ error: "Introduce un teléfono válido de 10 dígitos." });
      if (!firstName) return res.status(400).json({ error: "El nombre de la clienta es obligatorio." });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "El correo no tiene un formato válido." });
      if (!relayOtpRequestLimit(session.account.id)) return res.status(429).json({ error: "Demasiados códigos solicitados. Espera unos minutos." });
      try {
        // Respuesta idéntica exista o no la clienta -- este endpoint NO debe
        // servir para enumerar teléfonos ya registrados. La consulta explícita
        // de "¿esta clienta ya existe?" es responsabilidad de
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
          message: "Si el teléfono no tiene ya una clienta registrada, le enviamos un código de WhatsApp para confirmar.",
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
        // canalOrigen/creadoPor identifican con precisión quién agendó la cita (clienta,
        // manicurista, asistente o administradora) -- no un genérico "PWA_EMPLEADO" que no
        // distinguía el rol real de quien la creó.
        let source, createdBy;
        if (req.body?.actorType === "employee") {
          if (appSession && appSession.account.role !== "clienta") {
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
          if (!appSession || appSession.account.role !== "clienta" || appSession.account.client_id !== clientId) {
            return res.status(401).json({ error: "Inicia sesión con tu teléfono y contraseña para reservar." });
          }
          source = "RESERVAPP_CLIENTE";
          createdBy = { role: "clienta", accountId: appSession.account.id };
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
