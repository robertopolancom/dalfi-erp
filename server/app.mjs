import express from "express";
import { resolveErpIdentity } from "../functions/api/_lib/authz.js";
import { authorizeDatabaseChanges, detectDatabaseChanges } from "../functions/api/_lib/database-authz.js";
import { extractDomainSlice } from "../functions/api/_lib/domain-slices.js";
import { syncChangedAppointmentsToGoogleCalendar } from "../functions/api/_lib/google-calendar.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

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

export function createApp({ store, env = process.env, staticDir, fetchImpl = globalThis.fetch } = {}) {
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
