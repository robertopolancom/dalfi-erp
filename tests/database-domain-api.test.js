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

function fakeFetch(profile = { role: "operador", is_active: true, can_manage_inventory: false }, options = {}) {
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
    if (target.includes("/rest/v1/rpc/save_erp_record_if_current")) {
      return new Response(JSON.stringify([{ saved: options.rpcSaved !== false, new_updated_at: "2026-07-26T12:01:00Z" }]), { status: options.rpcStatus || 200 });
    }
    if (target.includes("/rest/v1/erp_audit_log")) return new Response(null, { status: options.auditStatus || 201 });
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

test("database-domain dry-run: rechaza cuerpos excesivos antes de leer el documento", async () => {
  const { onRequestPost } = await import(moduleUrl);
  const fake = fakeFetch({ role: "administrador", is_active: true, can_manage_inventory: true });
  try {
    const huge = new Request("https://dalfi.test/api/database-domain?domain=inventario&dryRun=1", {
      method: "POST",
      headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "inventario", data: { inventario: "x".repeat(2 * 1024 * 1024) } }),
    });
    const response = await onRequestPost({ request: huge, env: ENV });
    assert.equal(response.status, 413);
    assert.equal(fake.calls.some((url) => url.includes("/rest/v1/erp_records")), false);
  } finally {
    fake.restore();
  }
});

test("database-domain dry-run: conserva el control optimista y devuelve conflicto sin simular una version obsoleta", async () => {
  const { onRequestPost } = await import(moduleUrl);
  const fake = fakeFetch({ role: "administrador", is_active: true, can_manage_inventory: true });
  try {
    const response = await onRequestPost({
      request: dryRunRequest("jwt", {
        domain: "inventario",
        data: { inventario: [{ itemID: "I-1" }, { itemID: "I-2" }] },
        expectedUpdatedAt: "2026-07-26T11:59:00Z",
      }),
      env: ENV,
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.conflict, true);
    assert.equal(body.updatedAt, "2026-07-26T12:00:00Z");
  } finally {
    fake.restore();
  }
});

test("database-domain dry-run: rechaza tablas de inventario con tipos invalidos", async () => {
  const { onRequestPost } = await import(moduleUrl);
  const fake = fakeFetch();
  try {
    const response = await onRequestPost({
      request: dryRunRequest("jwt", { domain: "inventario", data: { inventario: "manipulado" } }),
      env: ENV,
    });
    assert.equal(response.status, 400);
    assert.equal(fake.calls.some((url) => url.includes("/rest/v1/erp_records")), false);
  } finally {
    fake.restore();
  }
});

test("database-domain PUT: sin commit explicito no escribe y operador no autorizado recibe 403", async () => {
  const { onRequestPut } = await import(moduleUrl);
  const fake = fakeFetch();
  try {
    const missingCommit = await onRequestPut({ request: dryRunRequest(), env: ENV });
    assert.equal(missingCommit.status, 400);
    const write = await onRequestPut({
      request: new Request("https://dalfi.test/api/database-domain?domain=inventario&commit=1", {
        method: "PUT",
        headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "inventario", data: { inventario: [{ itemID: "I-1" }, { itemID: "I-2" }] }, expectedUpdatedAt: "2026-07-26T12:00:00Z" }),
      }),
      env: ENV,
    });
    assert.equal(write.status, 403);
    assert.equal(fake.calls.some((url) => url.includes("/rpc/")), false);
  } finally {
    fake.restore();
  }
});

test("database-domain PUT: perfil autorizado guarda el slice, usa el RPC y audita sin devolver el documento", async () => {
  const { onRequestPut } = await import(moduleUrl);
  const fake = fakeFetch({ role: "administrador", is_active: true, can_manage_inventory: true });
  try {
    const response = await onRequestPut({
      request: new Request("https://dalfi.test/api/database-domain?domain=inventario&commit=1", {
        method: "PUT",
        headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "inventario", data: { inventario: [{ itemID: "I-1" }, { itemID: "I-2" }] }, expectedUpdatedAt: "2026-07-26T12:00:00Z" }),
      }),
      env: ENV,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.saved, true);
    assert.equal(body.updatedAt, "2026-07-26T12:01:00Z");
    assert.deepStrictEqual(body.changes.tables, ["inventario"]);
    assert.equal(fake.calls.some((url) => url.includes("/rest/v1/rpc/save_erp_record_if_current")), true);
    assert.equal(fake.calls.some((url) => url.includes("/rest/v1/erp_audit_log")), true);
    assert.equal(JSON.stringify(body).includes("facturaID"), false);
  } finally {
    fake.restore();
  }
});

test("database-domain PUT: una propuesta identica es idempotente y no ejecuta RPC ni auditoria", async () => {
  const { onRequestPut } = await import(moduleUrl);
  const fake = fakeFetch({ role: "administrador", is_active: true, can_manage_inventory: true });
  try {
    const response = await onRequestPut({
      request: new Request("https://dalfi.test/api/database-domain?domain=inventario&commit=1", {
        method: "PUT",
        headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "inventario", data: { inventario: [{ itemID: "I-1" }] }, expectedUpdatedAt: "2026-07-26T12:00:00Z" }),
      }),
      env: ENV,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.saved, true);
    assert.equal(body.noChanges, true);
    assert.equal(fake.calls.some((url) => url.includes("/rpc/") || url.includes("erp_audit_log")), false);
  } finally {
    fake.restore();
  }
});

test("database-domain PUT: un fallo del RPC devuelve 502 y no informa un guardado falso", async () => {
  const { onRequestPut } = await import(moduleUrl);
  const fake = fakeFetch({ role: "administrador", is_active: true, can_manage_inventory: true }, { rpcStatus: 500, rpcSaved: false });
  try {
    const response = await onRequestPut({
      request: new Request("https://dalfi.test/api/database-domain?domain=inventario&commit=1", {
        method: "PUT",
        headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "inventario", data: { inventario: [{ itemID: "I-1" }, { itemID: "I-2" }] }, expectedUpdatedAt: "2026-07-26T12:00:00Z" }),
      }),
      env: ENV,
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.saved, undefined);
    assert.equal(fake.calls.some((url) => url.includes("erp_audit_log")), false);
  } finally {
    fake.restore();
  }
});

test("database-domain PUT: fallo de auditoria no revierte un guardado ya confirmado", async () => {
  const { onRequestPut } = await import(moduleUrl);
  const fake = fakeFetch({ role: "administrador", is_active: true, can_manage_inventory: true }, { auditStatus: 500 });
  try {
    const response = await onRequestPut({
      request: new Request("https://dalfi.test/api/database-domain?domain=inventario&commit=1", {
        method: "PUT",
        headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "inventario", data: { inventario: [{ itemID: "I-1" }, { itemID: "I-2" }] }, expectedUpdatedAt: "2026-07-26T12:00:00Z" }),
      }),
      env: ENV,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.saved, true);
    assert.equal(body.updatedAt, "2026-07-26T12:01:00Z");
  } finally {
    fake.restore();
  }
});

test("database-domain PUT: un payload manipulado con facturas queda fuera del merge y de los cambios autorizados", async () => {
  const { onRequestPut } = await import(moduleUrl);
  const fake = fakeFetch({ role: "administrador", is_active: true, can_manage_inventory: true });
  try {
    const response = await onRequestPut({
      request: new Request("https://dalfi.test/api/database-domain?domain=inventario&commit=1", {
        method: "PUT",
        headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "inventario",
          data: { inventario: [{ itemID: "I-1" }, { itemID: "I-2" }], facturas: [{ facturaID: "NO-DEBE-ENTRAR" }] },
          expectedUpdatedAt: "2026-07-26T12:00:00Z",
        }),
      }),
      env: ENV,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepStrictEqual(body.changes.tables, ["inventario"]);
    assert.equal(JSON.stringify(body).includes("NO-DEBE-ENTRAR"), false);
  } finally {
    fake.restore();
  }
});
