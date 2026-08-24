import express from "express";
import { resolveErpIdentity } from "../functions/api/_lib/authz.js";
import { authorizeDatabaseChanges, detectDatabaseChanges } from "../functions/api/_lib/database-authz.js";
import { extractDomainSlice } from "../functions/api/_lib/domain-slices.js";
import { syncChangedAppointmentsToGoogleCalendar } from "../functions/api/_lib/google-calendar.js";
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
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "same-origin");
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

  // A diferencia de requireBookingStaff: crear una clienta NUEVA es la única
  // operación que la MANICURISTA no puede hacer directamente -- debe pasar
  // primero por /api/reservapp/clients/relay-otp/{request,confirm} para
  // comprobar que la clienta controla ese teléfono. Buscar una clienta ya
  // existente (client/resolve, GET clients) sigue abierto para manicurista
  // sin restricción adicional, igual que reservar para ella una vez resuelta.
  const requireBookingStaffCanCreateClients = async (req, res) => {
    const session = await reservappSession(req);
    if (session) {
      if (["asistente", "administradora", "superadministrador"].includes(session.account.role)) return true;
      if (session.account.role === "manicurista") {
        res.status(403).json({
          error: "Verifica el teléfono de la clienta con el código de WhatsApp antes de crearla.",
          code: "OTP_REQUIRED_FOR_MANICURISTA",
        });
        return false;
      }
    }
    const identity = await resolveErpIdentity(webRequest(req), { ...env, fetch: fetchImpl });
    if (identity.error || !identity.permissions?.canManageReservations) {
      res.status(403).json({ error: "No tienes permiso para gestionar clientas." });
      return false;
    }
    return true;
  };

  const relayOtpHits = new Map();
  const relayOtpRequestLimit = (accountId) => {
    const now = Date.now();
    const recent = (relayOtpHits.get(accountId) || []).filter((time) => now - time < RELAY_OTP_REQUEST_LIMIT_WINDOW_MS);
    if (recent.length >= RELAY_OTP_REQUEST_LIMIT_MAX) return false;
    recent.push(now);
    relayOtpHits.set(accountId, recent);
    return true;
  };

  // Guard compartido por el panel "Configuración de usuarios" (banner promocional, listar/editar
  // cuentas): misma regla que ya usaba POST /admin/accounts -- administradora/superadministrador
  // de ReservApp, o el personal legado del ERP con canManageUsers cuando no hay cookie
  // reservapp_session. No incluye el candado extra de "solo superadmin crea superadmin"; eso
  // sigue siendo específico de asignar ese rol, no de esta sección en general.
  const requireReservappAdmin = async (req, res) => {
    const session = await reservappSession(req);
    const sessionRole = session?.account.role;
    let allowed = sessionRole && ["administradora", "superadministrador"].includes(sessionRole);
    if (!allowed && !session) {
      const identity = await resolveErpIdentity(webRequest(req), { ...env, fetch: fetchImpl });
      allowed = !identity.error && Boolean(identity.permissions?.canManageUsers);
    }
    if (!allowed) {
      res.status(403).json({ error: "Solo administración puede acceder a esta sección." });
      return null;
    }
    return session;
  };

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

  const sendSetupWhatsApp = async ({ outboxId, phone, setupUrl, name }) => {
    const bridgeSecret = String(env.ERP_WEBHOOK_SECRET || "");
    if (!bridgeSecret) return { status: "pending_configuration" };
    const bridgeBase = String(env.CHATBOT_BRIDGE_URL || "https://bot.sebengroup.com").replace(/\/$/, "");
    try {
      // Endpoint dedicado (no /webhook/overdue-reminders, que solo entiende
      // booking.confirmation_reminder y devuelve 200 IGNORED/UNKNOWN_EVENT para cualquier otro
      // evento). Con un endpoint compartido, un 200 no confirmaba que el WhatsApp se hubiera
      // enviado de verdad, así que hay que leer el cuerpo y solo marcar "sent" si el bridge
      // confirma status: "SENT" explícitamente.
      const response = await fetchImpl(`${bridgeBase}/webhook/reservapp-activation`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-webhook-secret": bridgeSecret },
        body: JSON.stringify({
          event: "reservapp.account_setup",
          actionRequired: "send_activation_link",
          recipientPhone: normalizePhone(phone),
          clientName: name || "Cliente",
          setupUrl,
          whatsappFormattedText: `Hola ${name || ""}. Crea tu contraseña para confirmar tu cita en Dalfi Studio Nails: ${setupUrl}`.trim(),
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

  if (bookingStore) {
    app.post("/api/reservapp/auth/request-setup", bookingRateLimit, async (req, res, next) => {
      if (req.body?.website) return res.status(204).end();
      const firstName = cleanText(req.body?.firstName, 80);
      const lastName = cleanText(req.body?.lastName, 80);
      const phone = cleanText(req.body?.phone, 30);
      const email = cleanText(req.body?.email, 160).toLowerCase();
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
            fechaRegistro: new Date().toISOString(), observaciones: "Creado al solicitar credenciales de ReservApp.",
          };
          const created = await bookingStore.createClient({ firstName, lastName, fullName: legacyPayload.nombreCompleto, phone, email, source: "RESERVAPP_CLIENTE", legacyPayload });
          if (created.duplicate) customer = await bookingStore.resolveClient({ phone });
          else customer = created.client;
        }
        if (!customer) return res.status(409).json({ error: "No pudimos vincular el teléfono con una ficha de cliente." });
        const existing = await bookingStore.accountByPhone(phone);
        if (existing?.status === "active") return res.status(409).json({ error: "Ese teléfono ya tiene credenciales. Inicia sesión para reservar.", accountExists: true });
        const account = await bookingStore.ensureClientAccount({ clientId: customer.id, phone });
        const rawToken = secureToken();
        const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
        const publicUrl = String(env.RESERVAPP_PUBLIC_URL || "https://reservapp.sebengroup.com").replace(/\/$/, "");
        const setupUrl = `${publicUrl}/?setup=${encodeURIComponent(rawToken)}`;
        const prepared = await bookingStore.prepareSetup({ accountId: account.id, tokenHash: hashToken(rawToken), expiresAt, recipientPhone: phone, setupUrl, draft: hasDraftIntent ? draft : null });
        const delivery = await sendSetupWhatsApp({ outboxId: prepared.outbox.id, phone, setupUrl, name: `${firstName} ${lastName}` });
        res.status(202).json({
          pendingConfirmation: true,
          deliveryStatus: delivery.status,
          message: "Te enviamos por WhatsApp el enlace para crear tu contraseña y confirmar la cita.",
          ...(String(env.RESERVAPP_EXPOSE_SETUP_LINK || "") === "true" ? { setupUrl } : {}),
        });
      } catch (error) {
        if (error?.code === "PHONE_ACCOUNT_CONFLICT") return res.status(409).json({ error: error.message });
        next(error);
      }
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

    app.post("/api/reservapp/admin/accounts", bookingRateLimit, async (req, res, next) => {
      const role = cleanText(req.body?.role, 32);
      const staffId = cleanText(req.body?.staffId, 64);
      const phone = cleanText(req.body?.phone, 30);
      if (!RESERVAPP_ROLES.includes(role) || role === "clienta" || !staffId || !validPhone(phone)) {
        return res.status(400).json({ error: "Selecciona colaboradora, rol y teléfono válidos." });
      }
      try {
        const session = await reservappSession(req);
        const sessionRole = session?.account.role;
        let allowed = sessionRole && ["administradora", "superadministrador"].includes(sessionRole);
        // Solo una cuenta ReservApp que YA es superadministrador puede crear otra. El personal
        // del ERP legado (autenticado vía Supabase, sin cookie reservapp_session) nunca cuenta
        // como superadministrador aquí, sin importar sus permisos del lado ERP — de lo
        // contrario cualquier administradora del ERP podría autoelevarse creando una cuenta
        // superadministrador de ReservApp.
        let actingAsSuperadmin = sessionRole === "superadministrador";
        if (!allowed && !session) {
          const identity = await resolveErpIdentity(webRequest(req), { ...env, fetch: fetchImpl });
          allowed = !identity.error && Boolean(identity.permissions?.canManageUsers);
        }
        if (role === "superadministrador" && !actingAsSuperadmin) allowed = false;
        if (!allowed) return res.status(403).json({ error: "Solo administración puede crear credenciales del equipo." });
        const account = await bookingStore.createEmployeeAccount({ staffId, phone, role, createdByAccountId: session?.account.id || null });
        const rawToken = secureToken();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
        const publicUrl = String(env.RESERVAPP_PUBLIC_URL || "https://reservapp.sebengroup.com").replace(/\/$/, "");
        const setupUrl = `${publicUrl}/?setup=${encodeURIComponent(rawToken)}`;
        const prepared = await bookingStore.prepareSetup({ accountId: account.id, tokenHash: hashToken(rawToken), expiresAt, recipientPhone: phone, setupUrl });
        const delivery = await sendSetupWhatsApp({ outboxId: prepared.outbox.id, phone, setupUrl, name: "Equipo Dalfi" });
        res.status(201).json({ account: publicAccount(account), deliveryStatus: delivery.status });
      } catch (error) {
        if (error?.code === "23505") return res.status(409).json({ error: "Ese teléfono o colaboradora ya tiene credenciales." });
        if (error?.code === "23503") return res.status(400).json({ error: "La colaboradora seleccionada no existe." });
        next(error);
      }
    });

    // Banner promocional configurable: la misma lista cerrada de 5 temas que
    // bridge/banner-generator.js en dalfi-chatbot-n8n (nunca colores libres, ni
    // generados por IA ni escritos a mano -- el JSON en reservapp_settings solo
    // guarda el nombre del tema, los hex de verdad viven acá, del lado del
    // servidor que sirve la app pública).
    const BANNER_THEMES = {
      verde: { bgColor: "#002F24", textColor: "#FFFFFF" },
      crema: { bgColor: "#F8F0DD", textColor: "#1A1712" },
      dorado: { bgColor: "#F6E7C4", textColor: "#5B3A00" },
      rojo: { bgColor: "#A5303F", textColor: "#FFFFFF" },
      rosado: { bgColor: "#F6E1E5", textColor: "#5C1F2B" },
    };
    const BANNER_SETTING_KEY = "promo_banner";

    app.get("/api/reservapp/banner", bookingRateLimit, async (_req, res, next) => {
      try {
        const saved = await bookingStore.getSetting(BANNER_SETTING_KEY);
        if (!saved?.enabled || !saved?.text) return res.json({ enabled: false });
        const theme = BANNER_THEMES[saved.theme] ? saved.theme : "verde";
        res.json({ enabled: true, text: String(saved.text).slice(0, 140), theme, ...BANNER_THEMES[theme] });
      } catch (error) { next(error); }
    });

    app.post("/api/reservapp/admin/banner/generate", bookingRateLimit, async (req, res, next) => {
      if (!(await requireReservappAdmin(req, res))) return;
      const instructions = cleanText(req.body?.instructions, 500);
      const bridgeSecret = String(env.ERP_WEBHOOK_SECRET || "");
      const bridgeBase = String(env.CHATBOT_BRIDGE_URL || "https://bot.sebengroup.com").replace(/\/$/, "");
      if (!bridgeSecret) return res.status(200).json({ ok: false, code: "AI_CREDENTIAL_MISSING", error: "La generación con IA no está configurada." });
      try {
        const response = await fetchImpl(`${bridgeBase}/webhook/generate-banner`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-webhook-secret": bridgeSecret },
          body: JSON.stringify({ instructions }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.status !== "OK") {
          return res.status(200).json({ ok: false, code: payload?.code || "AI_UNAVAILABLE", error: payload?.error || "No se pudo generar el banner." });
        }
        res.json({ ok: true, banner: payload.banner });
      } catch (error) { next(error); }
    });

    app.put("/api/reservapp/admin/banner", bookingRateLimit, async (req, res, next) => {
      const session = await requireReservappAdmin(req, res);
      if (!session) return;
      const enabled = Boolean(req.body?.enabled);
      const text = cleanText(req.body?.text, 140);
      const theme = BANNER_THEMES[req.body?.theme] ? req.body.theme : "verde";
      if (enabled && !text) return res.status(400).json({ error: "Escribe el texto del banner o desactívalo." });
      try {
        await bookingStore.upsertSetting({ key: BANNER_SETTING_KEY, value: { enabled, text, theme }, updatedByAccountId: session.account?.id || null });
        res.json({ enabled, text, theme, ...BANNER_THEMES[theme] });
      } catch (error) { next(error); }
    });

    // Configuración de usuarios: listar y editar cuentas ReservApp existentes
    // (staff y clientas) -- crear cuentas de staff sigue siendo
    // POST /api/reservapp/admin/accounts, esto es lo que faltaba para
    // bloquear/reactivar o cambiar de rol una cuenta ya creada.
    app.get("/api/reservapp/admin/accounts", bookingRateLimit, async (req, res, next) => {
      if (!(await requireReservappAdmin(req, res))) return;
      const role = cleanText(req.query.role, 32);
      try {
        const accounts = await bookingStore.listAccounts({ role: RESERVAPP_ROLES.includes(role) ? role : null });
        res.json({ accounts });
      } catch (error) { next(error); }
    });

    app.patch("/api/reservapp/admin/accounts/:id", bookingRateLimit, async (req, res, next) => {
      const session = await requireReservappAdmin(req, res);
      if (!session) return;
      const id = cleanText(req.params.id, 64);
      const role = req.body?.role !== undefined ? cleanText(req.body.role, 32) : undefined;
      const status = req.body?.status !== undefined ? cleanText(req.body.status, 32) : undefined;
      if (role !== undefined && !RESERVAPP_ROLES.includes(role)) return res.status(400).json({ error: "Rol inválido." });
      if (status !== undefined && !["active", "suspended"].includes(status)) return res.status(400).json({ error: "Estado inválido." });
      // Solo un superadministrador puede asignar o quitar el rol superadministrador -- mismo
      // candado que POST /admin/accounts, para que nadie se autoeleve.
      if (role === "superadministrador" && session.account.role !== "superadministrador") {
        return res.status(403).json({ error: "Solo un superadministrador puede asignar ese rol." });
      }
      if (id === session.account.id && (status === "suspended" || role)) {
        return res.status(400).json({ error: "No puedes cambiar tu propio rol ni bloquearte a ti misma." });
      }
      try {
        const target = await bookingStore.listAccounts({});
        const current = target.find((a) => a.id === id);
        if (!current) return res.status(404).json({ error: "Cuenta no encontrada." });
        // El rol está atado 1:1 a un recurso ERP (client_id o staff_id, ver constraint de la
        // tabla) -- una clienta nunca puede pasar a ser staff ni viceversa desde este panel,
        // solo se le puede cambiar el estado.
        if (role && role !== current.role && (role === "clienta" || current.role === "clienta")) {
          return res.status(400).json({ error: "No se puede cambiar entre clienta y staff. Crea una cuenta nueva del tipo correcto." });
        }
        const updated = await bookingStore.updateAccount(id, { role, status });
        res.json({ account: updated });
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
      const staffId = cleanText(req.query.staffId, 64);
      const date = cleanText(req.query.date, 10);
      if (!serviceIds.length || !staffId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Servicios, colaboradora y fecha son obligatorios." });
      try {
        const result = await bookingStore.availability({ serviceIds, staffId, date });
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
      if (!firstName || !lastName || !validPhone(phone)) return res.status(400).json({ error: "Nombre, apellido y teléfono válido son obligatorios." });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "El correo no tiene un formato válido." });
      const id = `CLI-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const source = req.body?.actorType === "employee" ? "PWA_EMPLEADO" : "PWA_CLIENTE";
      const legacyPayload = {
        clienteID: id, nombre: firstName, apellido: lastName, nombreCompleto: `${firstName} ${lastName}`,
        telefono: phone, correo: email, estado: "Activo", origenRegistro: source,
        fechaRegistro: new Date().toISOString(), observaciones: "Creado desde reserva rápida.",
      };
      try {
        if (!(await requireBookingStaffCanCreateClients(req, res))) return;
        const result = await bookingStore.createClient({ firstName, lastName, fullName: legacyPayload.nombreCompleto, phone, email, source, legacyPayload });
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
      const input = {
        clientId: cleanText(req.body?.clientId, 64), serviceIds: cleanServiceIds(req.body?.serviceIds || req.body?.serviceId),
        staffId: cleanText(req.body?.staffId, 64), date: cleanText(req.body?.date, 10),
        time: cleanText(req.body?.time, 5), notes: cleanText(req.body?.notes, 500),
        source: req.body?.actorType === "employee" ? "PWA_EMPLEADO" : "PWA_CLIENTE",
        idempotencyKey: cleanText(req.get("Idempotency-Key") || req.body?.idempotencyKey, 120),
      };
      if (!input.clientId || !input.serviceIds.length || !input.staffId || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time) || !input.idempotencyKey) {
        return res.status(400).json({ error: "Completa todos los datos de la cita." });
      }
      try {
        const appSession = await reservappSession(req);
        if (req.body?.actorType === "employee") {
          if (!appSession || appSession.account.role === "clienta") {
            const employee = await authorizeEmployeeBooking(req);
            if (employee === false) return res.status(403).json({ error: "Inicia sesión con una cuenta autorizada para reservar como empleado." });
          }
        } else if (!appSession || appSession.account.role !== "clienta" || appSession.account.client_id !== input.clientId) {
          return res.status(401).json({ error: "Inicia sesión con tu teléfono y contraseña para reservar." });
        }
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
