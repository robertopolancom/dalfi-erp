const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const apiUrl = pathToFileURL(path.join(__dirname, "..", "functions", "api", "database.js")).href;
const policyUrl = pathToFileURL(path.join(__dirname, "..", "functions", "api", "_lib", "database-authz.js")).href;
const ENV = {
  SUPABASE_URL: "https://fake.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "publishable",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
};

const baseDocument = () => ({
  meta: { version: 1 },
  schema: [],
  data: { clientes: [], facturas: [], reservas: [], cierres: [], nomina: [], inventario: [], cuentas: [], servicios: [] },
});

function profile(overrides = {}) {
  return {
    role: "operador",
    is_active: true,
    can_review_accounts: false,
    can_review_audit: false,
    can_submit_register_count: true,
    can_confirm_register_closings: false,
    can_confirm_treasury_closings: false,
    can_manage_users: false,
    can_manage_invoices: false,
    can_manage_billing: false,
    can_manage_inventory: false,
    can_manage_reservations: true,
    can_reopen_closings: false,
    ...overrides,
  };
}

function request(method, body, token = "jwt") {
  return new Request("https://dalfi.test/api/database", {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function fakeSupabase({ document = baseDocument(), updatedAt = "2026-07-25T10:00:00Z", profileRow = profile(), rpcResult } = {}) {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, method: options.method || "GET", body: options.body });
    if (target.includes("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "user-1", email: "user@dalfi.test" }), { status: 200 });
    }
    if (target.includes("/rest/v1/erp_user_profiles")) return new Response(JSON.stringify([profileRow]), { status: 200 });
    if (target.includes("/rest/v1/erp_records")) {
      return new Response(JSON.stringify([{ data: document, updated_at: updatedAt }]), { status: 200 });
    }
    if (target.includes("/rest/v1/rpc/save_erp_record_if_current")) {
      return new Response(JSON.stringify([rpcResult || { saved: true, conflict: false, new_updated_at: "2026-07-25T10:01:00Z" }]), { status: 200 });
    }
    if (target.includes("/rest/v1/erp_audit_log")) return new Response(null, { status: 201 });
    throw new Error(`URL inesperada: ${target}`);
  };
  return {
    calls,
    restore() {
      global.fetch = originalFetch;
    },
  };
}

test("detector clasifica tablas por dominio y marca tablas desconocidas", async () => {
  const { detectDatabaseChanges } = await import(policyUrl);
  const current = baseDocument();
  const proposed = structuredClone(current);
  proposed.data.facturas.push({ facturaID: "F-1" });
  proposed.data.nomina.push({ nominaID: "N-1" });
  proposed.data.tablaInyectada = [{ admin: true }];
  const changes = detectDatabaseChanges(current, proposed);
  assert.deepStrictEqual(changes.domains, ["facturacion", "nomina"]);
  assert.deepStrictEqual(changes.unknownTables, ["tablaInyectada"]);
});

test("GET exige JWT y no consulta erp_records sin sesion", async () => {
  const { onRequestGet } = await import(apiUrl);
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error("no debe consultar");
  };
  try {
    const response = await onRequestGet({ request: request("GET", null, null), env: ENV });
    assert.strictEqual(response.status, 401);
    assert.strictEqual(calls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET rechaza perfil inactivo antes de leer el documento", async () => {
  const { onRequestGet } = await import(apiUrl);
  const fake = fakeSupabase({ profileRow: profile({ is_active: false }) });
  try {
    const response = await onRequestGet({ request: request("GET"), env: ENV });
    assert.strictEqual(response.status, 403);
    assert.ok(!fake.calls.some((call) => call.url.includes("/rest/v1/erp_records")));
  } finally {
    fake.restore();
  }
});

test("usuario con permiso de facturacion guarda y el servidor genera auditoria minima", async () => {
  const { onRequestPut } = await import(apiUrl);
  const current = baseDocument();
  const proposed = structuredClone(current);
  proposed.data.facturas.push({ facturaID: "F-1", total: 100 });
  const fake = fakeSupabase({ document: current, profileRow: profile({ can_manage_billing: true }) });
  try {
    const response = await onRequestPut({
      request: request("PUT", { data: proposed, expectedUpdatedAt: "2026-07-25T10:00:00Z" }),
      env: ENV,
    });
    assert.strictEqual(response.status, 200);
    assert.ok(fake.calls.some((call) => call.url.includes("/rpc/save_erp_record_if_current")));
    const audit = fake.calls.find((call) => call.url.includes("/erp_audit_log"));
    assert.ok(audit);
    const auditBody = JSON.parse(audit.body);
    assert.deepStrictEqual(auditBody.new_data, { domains: ["facturacion"], tables: ["facturas"], envelope: [] });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(auditBody.new_data, "data"), false);
  } finally {
    fake.restore();
  }
});

test("sin permiso de facturacion no se puede manipular facturas mediante una llamada directa", async () => {
  const { onRequestPut } = await import(apiUrl);
  const current = baseDocument();
  const proposed = structuredClone(current);
  proposed.data.facturas.push({ facturaID: "F-BLOCKED", total: 100 });
  const fake = fakeSupabase({ document: current, profileRow: profile({ can_manage_billing: false }) });
  try {
    const response = await onRequestPut({
      request: request("PUT", { data: proposed, expectedUpdatedAt: "2026-07-25T10:00:00Z" }),
      env: ENV,
    });
    assert.strictEqual(response.status, 403);
    assert.ok(!fake.calls.some((call) => call.url.includes("/rpc/save_erp_record_if_current")));
  } finally {
    fake.restore();
  }
});

test("permiso de reservas se exige en servidor y no depende de que la interfaz oculte Editar", async () => {
  const { onRequestPut } = await import(apiUrl);
  const current = baseDocument();
  const proposed = structuredClone(current);
  proposed.data.reservas.push({ reservaID: "RES-1", fecha: "2026-07-25", estado: "Programada" });

  let fake = fakeSupabase({
    document: current,
    profileRow: profile({ can_manage_reservations: false }),
  });
  try {
    const denied = await onRequestPut({
      request: request("PUT", { data: proposed, expectedUpdatedAt: "2026-07-25T10:00:00Z" }),
      env: ENV,
    });
    assert.strictEqual(denied.status, 403);
    assert.ok(!fake.calls.some((call) => call.url.includes("/rpc/save_erp_record_if_current")));
  } finally {
    fake.restore();
  }

  fake = fakeSupabase({ document: current, profileRow: profile({ can_manage_reservations: true }) });
  try {
    const allowed = await onRequestPut({
      request: request("PUT", { data: proposed, expectedUpdatedAt: "2026-07-25T10:00:00Z" }),
      env: ENV,
    });
    assert.strictEqual(allowed.status, 200);
    assert.ok(fake.calls.some((call) => call.url.includes("/rpc/save_erp_record_if_current")));
  } finally {
    fake.restore();
  }
});

test("operador no puede cambiar nomina y nunca alcanza el RPC", async () => {
  const { onRequestPut } = await import(apiUrl);
  const current = baseDocument();
  const proposed = structuredClone(current);
  proposed.data.nomina.push({ nominaID: "N-1", total: 50000 });
  const fake = fakeSupabase({ document: current, profileRow: profile({ can_manage_billing: true }) });
  try {
    const response = await onRequestPut({
      request: request("PUT", { data: proposed, expectedUpdatedAt: "2026-07-25T10:00:00Z" }),
      env: ENV,
    });
    assert.strictEqual(response.status, 403);
    assert.ok(!fake.calls.some((call) => call.url.includes("/rpc/save_erp_record_if_current")));
  } finally {
    fake.restore();
  }
});

test("operador puede anexar una factura pero no modificar una factura historica", async () => {
  const { onRequestPut } = await import(apiUrl);
  const current = baseDocument();
  current.data.facturas = [{ facturaID: "F-0", total: 100 }];
  const proposed = structuredClone(current);
  proposed.data.facturas[0].total = 999;
  const fake = fakeSupabase({ document: current });
  try {
    const response = await onRequestPut({
      request: request("PUT", { data: proposed, expectedUpdatedAt: "2026-07-25T10:00:00Z" }),
      env: ENV,
    });
    assert.strictEqual(response.status, 403);
    assert.ok(!fake.calls.some((call) => call.url.includes("/rpc/save_erp_record_if_current")));
  } finally {
    fake.restore();
  }
});

test("permiso de someter conteo no permite confirmar ni reabrir cierres", async () => {
  const { onRequestPut } = await import(apiUrl);
  const current = baseDocument();
  current.data.cierres = [{ cierreID: "C-1", closingType: "register", estado: "Pendiente", requiereConfirmacion: true }];
  const confirmed = structuredClone(current);
  confirmed.data.cierres[0].estado = "Confirmado";
  confirmed.data.cierres[0].requiereConfirmacion = false;
  let fake = fakeSupabase({ document: current });
  try {
    const response = await onRequestPut({
      request: request("PUT", { data: confirmed, expectedUpdatedAt: "2026-07-25T10:00:00Z" }),
      env: ENV,
    });
    assert.strictEqual(response.status, 403);
  } finally {
    fake.restore();
  }

  const historical = baseDocument();
  historical.data.cierres = [{ cierreID: "C-2", closingType: "register", estado: "Confirmado", requiereConfirmacion: false }];
  const reopened = structuredClone(historical);
  reopened.data.cierres[0].balanceContado = 1;
  fake = fakeSupabase({ document: historical });
  try {
    const response = await onRequestPut({
      request: request("PUT", { data: reopened, expectedUpdatedAt: "2026-07-25T10:00:00Z" }),
      env: ENV,
    });
    assert.strictEqual(response.status, 403);
  } finally {
    fake.restore();
  }
});

test("operador puede guardar efectos append-only de inventario ligados a una factura", async () => {
  const { onRequestPut } = await import(apiUrl);
  const current = baseDocument();
  current.data.inventarioMovimientos = [];
  current.data.consumosPendientes = [];
  const proposed = structuredClone(current);
  proposed.data.facturas.push({ facturaID: "F-3" });
  proposed.data.inventarioMovimientos.push({ movementId: "M-1", sourceId: "F-3" });
  const fake = fakeSupabase({ document: current, profileRow: profile({ can_manage_billing: true }) });
  try {
    const response = await onRequestPut({
      request: request("PUT", { data: proposed, expectedUpdatedAt: "2026-07-25T10:00:00Z" }),
      env: ENV,
    });
    assert.strictEqual(response.status, 200);
    assert.ok(fake.calls.some((call) => call.url.includes("/rpc/save_erp_record_if_current")));
  } finally {
    fake.restore();
  }
});

test("operador no puede editar movimientos de inventario existentes aunque tambien cambie facturas", async () => {
  const { onRequestPut } = await import(apiUrl);
  const current = baseDocument();
  current.data.inventarioMovimientos = [{ movementId: "M-1", cantidad: 1 }];
  const proposed = structuredClone(current);
  proposed.data.facturas.push({ facturaID: "F-4" });
  proposed.data.inventarioMovimientos[0].cantidad = 999;
  const fake = fakeSupabase({ document: current });
  try {
    const response = await onRequestPut({
      request: request("PUT", { data: proposed, expectedUpdatedAt: "2026-07-25T10:00:00Z" }),
      env: ENV,
    });
    assert.strictEqual(response.status, 403);
    assert.ok(!fake.calls.some((call) => call.url.includes("/rpc/save_erp_record_if_current")));
  } finally {
    fake.restore();
  }
});

test("permiso especifico permite inventario sin canManageInvoices, pero nunca tablas desconocidas", async () => {
  const { onRequestPut } = await import(apiUrl);
  const admin = profile({
    role: "operador",
    can_manage_invoices: false,
    can_manage_billing: false,
    can_manage_inventory: true,
  });
  const current = baseDocument();
  const inventoryChange = structuredClone(current);
  inventoryChange.data.inventario.push({ itemID: "I-1" });
  let fake = fakeSupabase({ document: current, profileRow: admin });
  try {
    const allowed = await onRequestPut({
      request: request("PUT", { data: inventoryChange, expectedUpdatedAt: "2026-07-25T10:00:00Z" }),
      env: ENV,
    });
    assert.strictEqual(allowed.status, 200);
  } finally {
    fake.restore();
  }

  const unknownChange = structuredClone(current);
  unknownChange.data.tablaInyectada = [];
  fake = fakeSupabase({ document: current, profileRow: admin });
  try {
    const denied = await onRequestPut({
      request: request("PUT", { data: unknownChange, expectedUpdatedAt: "2026-07-25T10:00:00Z" }),
      env: ENV,
    });
    assert.strictEqual(denied.status, 403);
    assert.ok(!fake.calls.some((call) => call.url.includes("/rpc/save_erp_record_if_current")));
  } finally {
    fake.restore();
  }
});

test("version obsoleta devuelve 409 antes de autorizar o escribir", async () => {
  const { onRequestPut } = await import(apiUrl);
  const current = baseDocument();
  const proposed = structuredClone(current);
  proposed.data.facturas.push({ facturaID: "F-2" });
  const fake = fakeSupabase({ document: current, updatedAt: "2026-07-25T10:05:00Z" });
  try {
    const response = await onRequestPut({
      request: request("PUT", { data: proposed, expectedUpdatedAt: "2026-07-25T10:00:00Z" }),
      env: ENV,
    });
    assert.strictEqual(response.status, 409);
    assert.ok(!fake.calls.some((call) => call.url.includes("/rpc/save_erp_record_if_current")));
  } finally {
    fake.restore();
  }
});
