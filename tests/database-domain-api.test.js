const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const moduleUrl = pathToFileURL(path.join(__dirname, "..", "functions", "api", "database-domain.js")).href;
const ENV = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_PUBLISHABLE_KEY: "publishable", SUPABASE_SERVICE_ROLE_KEY: "service-role" };

function request(method = "GET", token = "jwt", domain = "inventario") {
  return new Request(`https://dalfi.test/api/database-domain?domain=${domain}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function dryRunRequest(token = "jwt", body = { domain: "inventario", data: { inventario: [{ itemID: "I-1" }, { itemID: "I-2" }] } }) {
  return new Request("https://dalfi.test/api/database-domain?domain=inventario&dryRun=1", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fakeFetch(profile = { role: "operador", is_active: true, can_manage_inventory: false }) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes("/auth/v1/user")) return new Response(JSON.stringify({ id: "user-1", email: "operador@dalfi.test" }), { status: 200 });
    if (target.includes("/rest/v1/erp_user_profiles")) {
      return new Response(JSON.stringify([profile]), { status: 200 });
    }
    if (target.includes("/rest/v1/erp_records")) {
      return new Response(JSON.stringify([{ updated_at: "2026-07-26T12:00:00Z", data: { data: { inventario: [{ itemID: "I-1" }], facturas: [{ facturaID: "F-1" }] } } }]), { status: 200 });
    }
    throw new Error(`ruta inesperada: ${target}`);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

test("database-domain: sin JWT responde 401 y no lee erp_records", async () => {
  const { onRequestGet } = await import(moduleUrl);
  const fake = fakeFetch();
  try {
    const response = await onRequestGet({ request: request("GET", null), env: ENV });
    assert.equal(response.status, 401);
    assert.equal(fake.calls.some((url) => url.includes("/rest/v1/erp_records")), false);
  } finally {
    fake.restore();
  }
});

test("database-domain: inventario devuelve solo su slice y nunca facturas", async () => {
  const { onRequestGet } = await import(moduleUrl);
  const fake = fakeFetch();
  try {
    const response = await onRequestGet({ request: request(), env: ENV });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepStrictEqual(body.data, { inventario: [{ itemID: "I-1" }] });
    assert.equal(body.source, "erp_records");
    assert.equal(Object.prototype.hasOwnProperty.call(body.data, "facturas"), false);
  } finally {
    fake.restore();
  }
});

test("database-domain: dominios no habilitados y metodos de escritura no se exponen", async () => {
  const module = await import(moduleUrl);
  const fake = fakeFetch();
  try {
    const unknown = await module.onRequestGet({ request: request("GET", "jwt", "facturacion"), env: ENV });
    assert.equal(unknown.status, 400);
    const put = await module.onRequest({ request: request("PUT"), env: ENV });
    assert.equal(put.status, 405);
    const missingDryRun = await module.onRequestPost({ request: request("POST"), env: ENV });
    assert.equal(missingDryRun.status, 400);
  } finally {
    fake.restore();
  }
});

test("database-domain dry-run: operador recibe denegacion y nunca se ejecuta una escritura", async () => {
  const { onRequestPost } = await import(moduleUrl);
  const fake = fakeFetch();
  try {
    const response = await onRequestPost({ request: dryRunRequest(), env: ENV });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.dryRun, true);
    assert.equal(body.allowed, false);
    assert.equal(body.reason, "missing_inventory_permission");
    assert.deepStrictEqual(body.changes.tables, ["inventario"]);
    assert.equal(fake.calls.some((url) => url.includes("/rpc/") || url.includes("/rest/v1/erp_records") && false), false);
  } finally {
    fake.restore();
  }
});

test("database-domain dry-run: perfil autorizado aprueba el cambio sin ejecutar una escritura", async () => {
  const { onRequestPost } = await import(moduleUrl);
  const fake = fakeFetch({ role: "administrador", is_active: true, can_manage_inventory: true });
  try {
    const response = await onRequestPost({ request: dryRunRequest(), env: ENV });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.dryRun, true);
    assert.equal(body.allowed, true);
    assert.equal(body.reason, null);
    assert.deepStrictEqual(body.changes.tables, ["inventario"]);
    assert.equal(fake.calls.some((url) => url.includes("/rpc/")), false);
  } finally {
    fake.restore();
  }
});
