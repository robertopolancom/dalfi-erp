const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extracted = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");

// Solo necesitamos la porcion de app.js relacionada con logAudit(); se extrae
// por NOMBRE de funcion (balance de llaves), no por numero de linea, para
// que la prueba no se desincronice cada vez que el archivo crece en otro
// punto mas arriba.
function extractFunction(name) {
  const pattern = new RegExp(`^(async )?function ${name}\\(`, "m");
  const match = pattern.exec(extracted);
  if (!match) throw new Error(`No se encontro function ${name} en outputs/app.js`);
  // Primero balancea PARENTESIS desde la lista de parametros (para no
  // confundirse si un parametro usa desestructuracion "{ a, b } = {}", que
  // trae sus propias llaves antes del cuerpo real de la funcion).
  let parenDepth = 0;
  let afterParams = extracted.indexOf("(", match.index);
  for (; afterParams < extracted.length; afterParams++) {
    if (extracted[afterParams] === "(") parenDepth++;
    else if (extracted[afterParams] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        afterParams++;
        break;
      }
    }
  }
  let depth = 0;
  let end = extracted.indexOf("{", afterParams);
  for (; end < extracted.length; end++) {
    if (extracted[end] === "{") depth++;
    else if (extracted[end] === "}") {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  return extracted.slice(match.index, end);
}

const logAuditSource = ["functionEndpoint", "isSupabaseReady", "logAudit", "uid"].map(extractFunction).join("\n\n");

function buildSandbox({ fetchImpl, supabaseReady }) {
  const sandbox = {
    window: { DALFI_FUNCTION_BASE: "" },
    location: { hostname: "dalfi-erp.pages.dev" },
    supabaseClient: supabaseReady ? {} : null,
    supabaseSession: supabaseReady ? { user: { email: "duena@dalfi.test" }, access_token: "fake-jwt" } : null,
    database: { data: {} },
    fetch: fetchImpl,
    console,
    currentUserEmail: () => "duena@dalfi.test",
    currentRoleKey: () => "propietaria",
    saveState: () => {
      sandbox.saveStateCalls = (sandbox.saveStateCalls || 0) + 1;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(logAuditSource, sandbox);
  return sandbox;
}

test("logAudit: si Supabase no esta listo (sin sesion), guarda directo en el respaldo local sin llamar a fetch", async () => {
  const sandbox = buildSandbox({
    supabaseReady: false,
    fetchImpl: async () => {
      throw new Error("no deberia llamarse a fetch");
    },
  });
  const result = await sandbox.logAudit("invoice_edit", { entity: "facturas", entityId: "FAC-1" });
  assert.strictEqual(result, false);
  assert.strictEqual(sandbox.database.data.auditLogLocal.length, 1);
  assert.strictEqual(sandbox.database.data.auditLogLocal[0].action, "invoice_edit");
});

test("logAudit: si la funcion de auditoria (Cloudflare) responde con error (p.ej. columna faltante en Supabase), NO bloquea la operacion: cae al respaldo local", async () => {
  const sandbox = buildSandbox({
    supabaseReady: true,
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'column "user_email" does not exist' }),
  });
  const result = await sandbox.logAudit("closing_register_confirm", { entity: "cierres", entityId: "CIE-1" });
  assert.strictEqual(result, false, "logAudit no lanza y no bloquea: devuelve false pero la operacion de negocio ya se guardo antes de llamarlo");
  assert.strictEqual(sandbox.database.data.auditLogLocal.length, 1);
  assert.strictEqual(sandbox.database.data.auditLogLocal[0].action, "closing_register_confirm");
  assert.strictEqual(sandbox.saveStateCalls, 1, "el respaldo local se persiste con saveState()");
});

test("logAudit: si fetch lanza una excepcion de red, tampoco se propaga: cae al respaldo local igual", async () => {
  const sandbox = buildSandbox({
    supabaseReady: true,
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  const result = await sandbox.logAudit("transfer_confirm", { entity: "transferencias", entityId: "TRF-1" });
  assert.strictEqual(result, false);
  assert.strictEqual(sandbox.database.data.auditLogLocal.length, 1);
});

test("logAudit: cuando la funcion de auditoria SI responde ok, no usa el respaldo local", async () => {
  const sandbox = buildSandbox({
    supabaseReady: true,
    fetchImpl: async () => ({ ok: true }),
  });
  const result = await sandbox.logAudit("reservation_edit", { entity: "reservas", entityId: "RES-1" });
  assert.strictEqual(result, true);
  assert.strictEqual((sandbox.database.data.auditLogLocal || []).length, 0);
});
