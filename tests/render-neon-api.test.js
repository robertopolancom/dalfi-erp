import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";

const permissions = {
  can_review_accounts: true,
  can_review_audit: true,
  can_submit_register_count: true,
  can_confirm_register_closings: true,
  can_confirm_treasury_closings: true,
  can_manage_users: true,
  can_manage_invoices: true,
  can_manage_billing: true,
  can_manage_inventory: true,
  can_manage_payroll: true,
  can_manage_accounts: true,
  can_manage_configuration: true,
  can_manage_reservations: true,
  can_reopen_closings: true,
};

function authFetch(url) {
  if (String(url).includes("/auth/v1/user")) {
    return Promise.resolve(new Response(JSON.stringify({ id: "user-1", email: "admin@example.test" }), { status: 200 }));
  }
  if (String(url).includes("erp_user_profiles")) {
    return Promise.resolve(new Response(JSON.stringify([{ user_id: "user-1", email: "admin@example.test", role: "administradora", is_active: true, ...permissions }]), { status: 200 }));
  }
  throw new Error(`Unexpected fetch: ${url}`);
}

function memoryStore() {
  let row = { data: { data: { clientes: [] } }, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 };
  return {
    async read({ metadataOnly = false } = {}) {
      return metadataOnly ? { updatedAt: row.updatedAt, version: row.version } : structuredClone(row);
    },
    async save({ document, expectedUpdatedAt }) {
      if (expectedUpdatedAt !== row.updatedAt) return { conflict: true, updatedAt: row.updatedAt };
      const previousDocument = row.data;
      row = { data: structuredClone(document), updatedAt: "2026-08-13T00:01:00.000Z", version: 2 };
      return { saved: true, updatedAt: row.updatedAt, version: 2, previousDocument };
    },
  };
}

async function withServer(fn) {
  const app = createApp({
    store: memoryStore(),
    env: {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    },
    fetchImpl: authFetch,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("Render health comprueba que el documento de Neon existe", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, database: "ready" });
  });
});

test("Render API conserva autenticacion Supabase y lee el documento desde Neon", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/database`, { headers: { Authorization: "Bearer valid-test-token" } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data, { data: { clientes: [] } });
    assert.equal(body.updatedAt, "2026-08-13T00:00:00.000Z");
  });
});

test("Render API rechaza escrituras con una version anterior", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/database`, {
      method: "PUT",
      headers: { Authorization: "Bearer valid-test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ data: { data: { clientes: [] } }, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).conflict, true);
  });
});
