import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { hashToken } from "../server/reservapp-auth.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

const ADMIN_TOKEN = "admin-session-token";
const SUPERADMIN_TOKEN = "superadmin-session-token";
const MANICURISTA_TOKEN = "manicurista-session-token";

function bookingStore({ settings = {}, accounts = [] } = {}) {
  const upsertedSettings = [];
  const updatedAccounts = [];
  return {
    upsertedSettings,
    updatedAccounts,
    async sessionAccount(tokenHash) {
      if (tokenHash === hashToken(ADMIN_TOKEN)) return { id: "admin-1", role: "administradora" };
      if (tokenHash === hashToken(SUPERADMIN_TOKEN)) return { id: "superadmin-1", role: "superadministrador" };
      if (tokenHash === hashToken(MANICURISTA_TOKEN)) return { id: "manicurista-1", role: "manicurista" };
      return null;
    },
    async getSetting(key) { return settings[key] ?? null; },
    async upsertSetting(input) { upsertedSettings.push(input); },
    async listAccounts() { return accounts; },
    async updateAccount(id, patch) { updatedAccounts.push({ id, patch }); return { id, role: patch.role, status: patch.status }; },
  };
}

async function withServer(store, run, { fetchImpl, env = {} } = {}) {
  const app = createApp({
    store: documentStore(), bookingStore: store,
    fetchImpl: fetchImpl || (async () => new Response(JSON.stringify({ status: "SENT" }), { status: 200 })),
    env: {
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test",
      ERP_WEBHOOK_SECRET: "shared-secret", CHATBOT_BRIDGE_URL: "https://bridge.test",
      ...env,
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
}

function withCookie(token) {
  return token ? { Cookie: `reservapp_session=${token}` } : {};
}

test("GET /banner: sin configuración guardada, responde enabled:false (la app se ve como hoy)", async () => {
  await withServer(bookingStore(), async (base) => {
    const response = await fetch(`${base}/api/reservapp/banner`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: false });
  });
});

test("GET /banner: es pública, no exige sesión", async () => {
  await withServer(bookingStore({ settings: { promo_banner: { enabled: true, text: "2x1 los lunes", theme: "rojo" } } }), async (base) => {
    const response = await fetch(`${base}/api/reservapp/banner`);
    const body = await response.json();
    assert.equal(body.enabled, true);
    assert.equal(body.text, "2x1 los lunes");
    assert.deepEqual({ bgColor: body.bgColor, textColor: body.textColor }, { bgColor: "#A5303F", textColor: "#FFFFFF" });
  });
});

test("GET /banner: un tema guardado fuera de la lista cerrada cae al tema por defecto, nunca colores libres", async () => {
  await withServer(bookingStore({ settings: { promo_banner: { enabled: true, text: "Promo", theme: "arcoiris" } } }), async (base) => {
    const body = await (await fetch(`${base}/api/reservapp/banner`)).json();
    assert.equal(body.theme, "verde");
  });
});

test("PUT /admin/banner: sin sesión de administración, 403", async () => {
  await withServer(bookingStore(), async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/banner`, {
      method: "PUT", headers: { "Content-Type": "application/json", ...withCookie(MANICURISTA_TOKEN) },
      body: JSON.stringify({ enabled: true, text: "Hola", theme: "verde" }),
    });
    assert.equal(response.status, 403);
  });
});

test("PUT /admin/banner: administradora guarda el banner y el tema resuelve a colores de la lista cerrada", async () => {
  const store = bookingStore();
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/banner`, {
      method: "PUT", headers: { "Content-Type": "application/json", ...withCookie(ADMIN_TOKEN) },
      body: JSON.stringify({ enabled: true, text: "2x1 en manicura", theme: "dorado" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.bgColor, "#F6E7C4");
    assert.equal(store.upsertedSettings[0].value.theme, "dorado");
    assert.equal(store.upsertedSettings[0].updatedByAccountId, "admin-1");
  });
});

test("PUT /admin/banner: activarlo sin texto se rechaza en vez de guardar un banner vacío", async () => {
  await withServer(bookingStore(), async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/banner`, {
      method: "PUT", headers: { "Content-Type": "application/json", ...withCookie(ADMIN_TOKEN) },
      body: JSON.stringify({ enabled: true, text: "  ", theme: "verde" }),
    });
    assert.equal(response.status, 400);
  });
});

test("POST /admin/banner/generate: reenvía las instrucciones al bridge de Gemini con el secreto compartido", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ status: "OK", banner: { text: "2x1 los lunes", theme: "rojo", bgColor: "#A5303F", textColor: "#FFFFFF" } }), { status: 200 });
  };
  await withServer(bookingStore(), async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/banner/generate`, {
      method: "POST", headers: { "Content-Type": "application/json", ...withCookie(ADMIN_TOKEN) },
      body: JSON.stringify({ instructions: "banner rojo festivo, 2x1 los lunes" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.banner.theme, "rojo");
    assert.equal(calls[0].url, "https://bridge.test/webhook/generate-banner");
    assert.equal(calls[0].body.instructions, "banner rojo festivo, 2x1 los lunes");
  }, { fetchImpl });
});

test("POST /admin/banner/generate: si el bridge falla, responde 200 con ok:false y no revienta (queda como estaba)", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ status: "FAILED", code: "AI_TIMEOUT", error: "Gemini tardó demasiado." }), { status: 200 });
  await withServer(bookingStore(), async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/banner/generate`, {
      method: "POST", headers: { "Content-Type": "application/json", ...withCookie(ADMIN_TOKEN) },
      body: JSON.stringify({ instructions: "algo llamativo" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "AI_TIMEOUT");
  }, { fetchImpl });
});

test("GET /admin/accounts: sin sesión de administración, 403", async () => {
  await withServer(bookingStore(), async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/accounts`, { headers: withCookie(MANICURISTA_TOKEN) });
    assert.equal(response.status, 403);
  });
});

test("GET /admin/accounts: administradora recibe la lista completa (staff y clientas)", async () => {
  const accounts = [
    { id: "c1", role: "clienta", status: "active", full_name: "Ana Pérez" },
    { id: "s1", role: "manicurista", status: "active", full_name: "Dalfina" },
  ];
  await withServer(bookingStore({ accounts }), async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/accounts`, { headers: withCookie(ADMIN_TOKEN) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).accounts, accounts);
  });
});

test("PATCH /admin/accounts/:id: bloquea una clienta (status=suspended) sin tocar su rol", async () => {
  const accounts = [{ id: "c1", role: "clienta", status: "active", full_name: "Ana Pérez" }];
  const store = bookingStore({ accounts });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/accounts/c1`, {
      method: "PATCH", headers: { "Content-Type": "application/json", ...withCookie(ADMIN_TOKEN) },
      body: JSON.stringify({ status: "suspended" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(store.updatedAccounts[0], { id: "c1", patch: { role: undefined, status: "suspended" } });
  });
});

test("PATCH /admin/accounts/:id: no deja cambiar una clienta a rol de staff (ni viceversa)", async () => {
  const accounts = [{ id: "c1", role: "clienta", status: "active", full_name: "Ana Pérez" }];
  await withServer(bookingStore({ accounts }), async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/accounts/c1`, {
      method: "PATCH", headers: { "Content-Type": "application/json", ...withCookie(ADMIN_TOKEN) },
      body: JSON.stringify({ role: "asistente" }),
    });
    assert.equal(response.status, 400);
  });
});

test("PATCH /admin/accounts/:id: solo un superadministrador puede asignar el rol superadministrador", async () => {
  const accounts = [{ id: "s1", role: "manicurista", status: "active", full_name: "Dalfina" }];
  await withServer(bookingStore({ accounts }), async (base) => {
    const asAdmin = await fetch(`${base}/api/reservapp/admin/accounts/s1`, {
      method: "PATCH", headers: { "Content-Type": "application/json", ...withCookie(ADMIN_TOKEN) },
      body: JSON.stringify({ role: "superadministrador" }),
    });
    assert.equal(asAdmin.status, 403);

    const asSuperadmin = await fetch(`${base}/api/reservapp/admin/accounts/s1`, {
      method: "PATCH", headers: { "Content-Type": "application/json", ...withCookie(SUPERADMIN_TOKEN) },
      body: JSON.stringify({ role: "superadministrador" }),
    });
    assert.equal(asSuperadmin.status, 200);
  });
});

test("PATCH /admin/accounts/:id: una administradora no puede bloquearse ni cambiarse el rol a sí misma", async () => {
  const accounts = [{ id: "admin-1", role: "administradora", status: "active", full_name: "Yo Misma" }];
  await withServer(bookingStore({ accounts }), async (base) => {
    const response = await fetch(`${base}/api/reservapp/admin/accounts/admin-1`, {
      method: "PATCH", headers: { "Content-Type": "application/json", ...withCookie(ADMIN_TOKEN) },
      body: JSON.stringify({ status: "suspended" }),
    });
    assert.equal(response.status, 400);
  });
});
