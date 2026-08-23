// Fase 6 del plan "ReservApp: rebrand + panel de personal + sesión + banner con IA" -- banner
// promocional configurable. Generar llama al bridge de WhatsApp (Gemini directo, ver
// banner-generator.js en dalfi-chatbot-n8n); publicar/quitar cambian lo que ve ReservApp de
// verdad (GET /api/fast-booking/catalog).

import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { hashToken } from "../server/reservapp-auth.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

const ADMIN_TOKEN = "admin-session-token";
const MANICURISTA_TOKEN = "manicurista-session-token";

function bookingStore() {
  let banner = null;
  return {
    get banner() { return banner; },
    async sessionAccount(tokenHash) {
      if (tokenHash === hashToken(ADMIN_TOKEN)) return { id: "admin-1", role: "administradora" };
      if (tokenHash === hashToken(MANICURISTA_TOKEN)) return { id: "mani-1", role: "manicurista" };
      return null;
    },
    async catalog() { return { services: [], staff: [], schedule: { timezone: "America/Santo_Domingo", settings: {} }, banner }; },
    async setBanner(value) { banner = value; return banner; },
    async clearBanner() { banner = null; },
  };
}

async function withServer(fetchImpl, run) {
  const store = bookingStore();
  const app = createApp({
    store: documentStore(), bookingStore: store, fetchImpl,
    env: {
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test",
      ERP_WEBHOOK_SECRET: "shared-secret", CHATBOT_BRIDGE_URL: "https://bridge.test",
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`, store); }
  finally { server.close(); await once(server, "close"); }
}

function withCookie(token) { return { Cookie: `reservapp_session=${token}` }; }

test("POST /admin/banner/generate: administradora recibe la propuesta del bridge", async () => {
  const fetchImpl = async (url, options) => {
    assert.match(String(url), /\/webhook\/generate-banner$/);
    assert.equal(options.headers["x-webhook-secret"], "shared-secret");
    return new Response(JSON.stringify({ status: "OK", banner: { text: "2x1 los lunes", theme: "rojo", bgColor: "#A5303F", textColor: "#FFFFFF" } }), { status: 200 });
  };
  await withServer(fetchImpl, async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/banner/generate`, {
      method: "POST", headers: { ...withCookie(ADMIN_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ instructions: "banner rojo festivo, 2x1 los lunes" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).banner.theme, "rojo");
  });
});

test("POST /admin/banner/generate: una manicurista no puede generar el banner", async () => {
  const fetchImpl = async () => new Response("{}", { status: 200 });
  await withServer(fetchImpl, async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/banner/generate`, {
      method: "POST", headers: { ...withCookie(MANICURISTA_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ instructions: "algo" }),
    });
    assert.equal(response.status, 403);
  });
});

test("POST /admin/banner/generate: si el bridge falla, responde 502 con el motivo", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ status: "FAILED", code: "AI_TIMEOUT", error: "Gemini tardó demasiado." }), { status: 200 });
  await withServer(fetchImpl, async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/banner/generate`, {
      method: "POST", headers: { ...withCookie(ADMIN_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ instructions: "algo" }),
    });
    assert.equal(response.status, 502);
  });
});

test("POST /admin/banner: publica el banner y GET /catalog lo expone", async () => {
  await withServer(async () => new Response("{}"), async (base) => {
    const publish = await fetch(`${base}/api/reservapp/admin/banner`, {
      method: "POST", headers: { ...withCookie(ADMIN_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Bienvenida", theme: "crema", bgColor: "#F8F0DD", textColor: "#1A1712" }),
    });
    assert.equal(publish.status, 200);

    const catalog = await fetch(`${base}/api/fast-booking/catalog`);
    const body = await catalog.json();
    assert.equal(body.banner.theme, "crema");
  });
});

test("POST /admin/banner: rechaza colores que no sean hex de 6 dígitos", async () => {
  await withServer(async () => new Response("{}"), async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/banner`, {
      method: "POST", headers: { ...withCookie(ADMIN_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Bienvenida", theme: "crema", bgColor: "red", textColor: "#1A1712" }),
    });
    assert.equal(response.status, 400);
  });
});

test("DELETE /admin/banner: quita el banner y GET /catalog vuelve a devolver null (se ve igual que siempre)", async () => {
  await withServer(async () => new Response("{}"), async (base, store) => {
    store.setBanner({ text: "x", theme: "verde", bgColor: "#002F24", textColor: "#FFFFFF" });
    const remove = await fetch(`${base}/api/reservapp/admin/banner`, { method: "DELETE", headers: withCookie(ADMIN_TOKEN) });
    assert.equal(remove.status, 204);
    const catalog = await fetch(`${base}/api/fast-booking/catalog`);
    assert.equal((await catalog.json()).banner, null);
  });
});

test("GET /catalog: sin banner publicado nunca, devuelve null por defecto", async () => {
  await withServer(async () => new Response("{}"), async (base) => {
    const catalog = await fetch(`${base}/api/fast-booking/catalog`);
    assert.equal((await catalog.json()).banner, null);
  });
});
