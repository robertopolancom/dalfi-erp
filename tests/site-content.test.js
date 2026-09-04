// Panel de administración "Página web" (ERP) para editar el contenido de
// dalfistudio.com sin tocar código -- ver GET/PUT /api/site-content/:siteKey en
// server/app.mjs y getSiteContent/saveSiteContent en server/store.mjs. GET es público (lo consume
// la página pública en cada carga); PUT exige canManageConfiguration.

import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { NeonBookingStore } from "../server/store.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

const SAMPLE_CONTENT = { hero: { kicker: "Baní", headline: "Título", headlineAccent: "acento", lede: "", metaItems: [] } };

function fakePool({ existingRow = null } = {}) {
  const saved = [];
  return {
    saved,
    async query(sql, params) {
      if (sql.includes("select site_key, content, updated_at, updated_by from app.site_content")) {
        return { rows: existingRow ? [existingRow] : [] };
      }
      if (sql.includes("insert into app.site_content")) {
        const [siteKey, content, updatedBy] = params;
        const row = { site_key: siteKey, content, updated_at: "2026-08-31T00:00:00.000Z", updated_by: updatedBy };
        saved.push(row);
        return { rows: [row] };
      }
      throw new Error(`Consulta no simulada: ${sql}`);
    },
  };
}

function erpFetch({ canManageConfiguration = true } = {}) {
  return async (url) => {
    const target = String(url);
    if (target.includes("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "erp-user-1", email: "admin@ejemplo.test" }), { status: 200 });
    }
    if (target.includes("erp_user_profiles")) {
      return new Response(
        JSON.stringify([{ user_id: "erp-user-1", role: "administradora", is_active: true, can_manage_configuration: canManageConfiguration }]),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 401 });
  };
}

async function withServer({ fetchImpl, existingRow } = {}, run) {
  const pool = fakePool({ existingRow });
  const bookingStore = new NeonBookingStore(pool);
  const app = createApp({
    store: documentStore(), bookingStore, fetchImpl,
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test" },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`, pool); }
  finally { server.close(); await once(server, "close"); }
}

test("GET /api/site-content/dalfistudionails: público, sin auth, devuelve el contenido guardado", async () => {
  await withServer({ existingRow: { site_key: "dalfistudionails", content: SAMPLE_CONTENT, updated_at: "x", updated_by: "y" } }, async (base) => {
    const response = await fetch(`${base}/api/site-content/dalfistudionails`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.content, SAMPLE_CONTENT);
  });
});

test("GET /api/site-content/otro-sitio: sitio desconocido -> 404", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/api/site-content/otro-sitio`);
    assert.equal(response.status, 404);
  });
});

test("GET /api/site-content/dalfistudionails: sin fila todavía guardada -> 404", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/api/site-content/dalfistudionails`);
    assert.equal(response.status, 404);
  });
});

test("PUT /api/site-content/dalfistudionails: sin sesión -> 401", async () => {
  await withServer({ fetchImpl: async () => new Response("{}", { status: 401 }) }, async (base) => {
    const response = await fetch(`${base}/api/site-content/dalfistudionails`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: SAMPLE_CONTENT }),
    });
    assert.equal(response.status, 401);
  });
});

test("PUT /api/site-content/dalfistudionails: sin canManageConfiguration -> 403, no guarda", async () => {
  await withServer({ fetchImpl: erpFetch({ canManageConfiguration: false }) }, async (base, pool) => {
    const response = await fetch(`${base}/api/site-content/dalfistudionails`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: "Bearer erp-jwt" },
      body: JSON.stringify({ content: SAMPLE_CONTENT }),
    });
    assert.equal(response.status, 403);
    assert.equal(pool.saved.length, 0);
  });
});

test("PUT /api/site-content/dalfistudionails: con canManageConfiguration guarda y responde 200", async () => {
  await withServer({ fetchImpl: erpFetch({ canManageConfiguration: true }) }, async (base, pool) => {
    const response = await fetch(`${base}/api/site-content/dalfistudionails`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: "Bearer erp-jwt" },
      body: JSON.stringify({ content: SAMPLE_CONTENT }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.content, SAMPLE_CONTENT);
    assert.equal(pool.saved.length, 1);
    assert.equal(pool.saved[0].updated_by, "admin@ejemplo.test");
  });
});

test("PUT /api/site-content/dalfistudionails: contenido inválido -> 400", async () => {
  await withServer({ fetchImpl: erpFetch({ canManageConfiguration: true }) }, async (base) => {
    const response = await fetch(`${base}/api/site-content/dalfistudionails`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: "Bearer erp-jwt" },
      body: JSON.stringify({ content: "no es un objeto" }),
    });
    assert.equal(response.status, 400);
  });
});
