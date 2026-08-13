import express from "express";
import { resolveErpIdentity } from "../functions/api/_lib/authz.js";
import { authorizeDatabaseChanges, detectDatabaseChanges } from "../functions/api/_lib/database-authz.js";
import { extractDomainSlice } from "../functions/api/_lib/domain-slices.js";
import { syncChangedAppointmentsToGoogleCalendar } from "../functions/api/_lib/google-calendar.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const BOOKING_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const BOOKING_LIMIT_MAX = 25;

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
  app.use((req, res, next) => {
    const bookingHost = String(env.FAST_BOOKING_HOST || "reservaap.sebengroup.com").toLowerCase();
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
  const cleanText = (value, max = 160) => String(value || "").trim().slice(0, max);
  const authorizeEmployeeBooking = async (req) => {
    if (req.body?.actorType !== "employee") return null;
    const identity = await resolveErpIdentity(webRequest(req), { ...env, fetch: fetchImpl });
    if (identity.error || !identity.permissions?.can_manage_reservations) return false;
    return identity;
  };

  if (bookingStore) {
    app.get("/api/fast-booking/catalog", bookingRateLimit, async (_req, res, next) => {
      try { res.json(await bookingStore.catalog()); } catch (error) { next(error); }
    });

    app.get("/api/fast-booking/availability", bookingRateLimit, async (req, res, next) => {
      const serviceId = cleanText(req.query.serviceId, 64);
      const staffId = cleanText(req.query.staffId, 64);
      const date = cleanText(req.query.date, 10);
      if (!serviceId || !staffId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Servicio, colaboradora y fecha son obligatorios." });
      try {
        const result = await bookingStore.availability({ serviceId, staffId, date });
        if (result.missing) return res.status(404).json({ error: "Servicio o colaboradora no disponible." });
        res.json(result);
      } catch (error) { next(error); }
    });

    app.post("/api/fast-booking/client/resolve", bookingRateLimit, async (req, res, next) => {
      const phone = cleanText(req.body?.phone, 30);
      const email = cleanText(req.body?.email, 160).toLowerCase();
      if (!validPhone(phone)) return res.status(400).json({ error: "Introduce un teléfono válido de 10 dígitos." });
      try {
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
        const employee = await authorizeEmployeeBooking(req);
        if (employee === false) return res.status(403).json({ error: "Inicia sesión con una cuenta autorizada para reservar como empleado." });
        const result = await bookingStore.createClient({ firstName, lastName, fullName: legacyPayload.nombreCompleto, phone, email, source, legacyPayload });
        if (result.duplicate) return res.status(409).json({ error: `Ya existe un cliente con ese ${result.matchedBy === "email" ? "correo" : "teléfono"}.`, duplicate: true, matchedBy: result.matchedBy });
        const calendarSync = await syncChangedAppointmentsToGoogleCalendar(env, result.previousDocument, result.document, { fetchImpl });
        res.status(201).json({ client: { id: result.client.id, name: result.client.full_name }, calendarSync });
      } catch (error) { next(error); }
    });

    app.get("/api/fast-booking/clients", authenticate, async (req, res, next) => {
      if (!req.erpIdentity.permissions?.can_manage_reservations) return res.status(403).json({ error: "No tienes permiso para reservar citas." });
      const query = cleanText(req.query.q, 80);
      if (query.length < 2) return res.json({ clients: [] });
      try { res.json({ clients: await bookingStore.searchClients(query) }); } catch (error) { next(error); }
    });

    app.post("/api/fast-booking/appointments", bookingRateLimit, async (req, res, next) => {
      if (req.body?.website) return res.status(204).end();
      const input = {
        clientId: cleanText(req.body?.clientId, 64), serviceId: cleanText(req.body?.serviceId, 64),
        staffId: cleanText(req.body?.staffId, 64), date: cleanText(req.body?.date, 10),
        time: cleanText(req.body?.time, 5), notes: cleanText(req.body?.notes, 500),
        source: req.body?.actorType === "employee" ? "PWA_EMPLEADO" : "PWA_CLIENTE",
        idempotencyKey: cleanText(req.get("Idempotency-Key") || req.body?.idempotencyKey, 120),
      };
      if (!input.clientId || !input.serviceId || !input.staffId || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time) || !input.idempotencyKey) {
        return res.status(400).json({ error: "Completa todos los datos de la cita." });
      }
      try {
        const employee = await authorizeEmployeeBooking(req);
        if (employee === false) return res.status(403).json({ error: "Inicia sesión con una cuenta autorizada para reservar como empleado." });
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
