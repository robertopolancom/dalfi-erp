const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extracted = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");

// Mismo mecanismo de extraccion por nombre de funcion (balance de llaves)
// que ya usa tests/log-audit-fallback.test.js: no depende de numeros de
// linea, asi que no se desincroniza si el archivo crece en otro punto.
function extractFunction(name) {
  const pattern = new RegExp(`^(async )?function ${name}\\(`, "m");
  const match = pattern.exec(extracted);
  if (!match) throw new Error(`No se encontro function ${name} en outputs/app.js`);
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

const permissionsSource = ["canManageInvoices", "canConfirmClosings", "canReviewAccountsUser"].map(extractFunction).join("\n\n");

function buildSandbox({ supabaseClient, supabaseSession, erpProfile, erpProfileLoaded }) {
  const sandbox = { supabaseClient, supabaseSession, erpProfile, erpProfileLoaded };
  vm.createContext(sandbox);
  vm.runInContext(permissionsSource, sandbox);
  return sandbox;
}

function fullPermissions() {
  return {
    canReviewAccounts: true,
    canReviewAudit: true,
    canSubmitRegisterCount: true,
    canConfirmRegisterClosings: true,
    canConfirmTreasuryClosings: true,
    canManageUsers: true,
    canManageInvoices: true,
    canReopenClosings: true,
  };
}

function noPermissions() {
  return {
    canReviewAccounts: false,
    canReviewAudit: false,
    canSubmitRegisterCount: true,
    canConfirmRegisterClosings: false,
    canConfirmTreasuryClosings: false,
    canManageUsers: false,
    canManageInvoices: false,
    canReopenClosings: false,
  };
}

test("canManageInvoices/canConfirmClosings/canReviewAccountsUser: mientras /api/me no ha respondido, aplican minimo privilegio (false)", () => {
  const sandbox = buildSandbox({
    supabaseClient: {},
    supabaseSession: { user: { email: "x@dalfi.test" }, access_token: "jwt" },
    erpProfile: null,
    erpProfileLoaded: false, // todavia no se pidio /api/me
  });
  assert.strictEqual(sandbox.canManageInvoices(), false);
  assert.strictEqual(sandbox.canConfirmClosings(), false);
  assert.strictEqual(sandbox.canReviewAccountsUser(), false);
});

test("canManageInvoices/canConfirmClosings/canReviewAccountsUser: si /api/me fallo (erpProfile=null tras intentarlo), tambien minimo privilegio — NUNCA asume administrador", () => {
  const sandbox = buildSandbox({
    supabaseClient: {},
    supabaseSession: { user: { email: "x@dalfi.test" }, access_token: "jwt" },
    erpProfile: null,
    erpProfileLoaded: true, // se intento y fallo
  });
  assert.strictEqual(sandbox.canManageInvoices(), false);
  assert.strictEqual(sandbox.canConfirmClosings(), false);
  assert.strictEqual(sandbox.canReviewAccountsUser(), false);
});

test("un operador (perfil cargado, sin permisos) no puede administrar facturas, cierres ni cuentas", () => {
  const sandbox = buildSandbox({
    supabaseClient: {},
    supabaseSession: { user: { email: "operador@dalfi.test" }, access_token: "jwt" },
    erpProfile: { role: "operador", isActive: true, permissions: noPermissions() },
    erpProfileLoaded: true,
  });
  assert.strictEqual(sandbox.canManageInvoices(), false);
  assert.strictEqual(sandbox.canConfirmClosings(), false);
  assert.strictEqual(sandbox.canReviewAccountsUser(), false);
});

test("una administradora con permisos SI puede administrar facturas, confirmar cierres y revisar cuentas", () => {
  const sandbox = buildSandbox({
    supabaseClient: {},
    supabaseSession: { user: { email: "admin@dalfi.test" }, access_token: "jwt" },
    erpProfile: { role: "administradora", isActive: true, permissions: fullPermissions() },
    erpProfileLoaded: true,
  });
  assert.strictEqual(sandbox.canManageInvoices(), true);
  assert.strictEqual(sandbox.canConfirmClosings(), true);
  assert.strictEqual(sandbox.canReviewAccountsUser(), true);
});

test("un perfil inactivo (is_active=false) nunca autoriza, aunque los permisos vengan en true (perfil desactualizado/carrera)", () => {
  const sandbox = buildSandbox({
    supabaseClient: {},
    supabaseSession: { user: { email: "exadmin@dalfi.test" }, access_token: "jwt" },
    erpProfile: { role: "administradora", isActive: false, permissions: fullPermissions() },
    erpProfileLoaded: true,
  });
  assert.strictEqual(sandbox.canManageInvoices(), false);
  assert.strictEqual(sandbox.canConfirmClosings(), false);
  assert.strictEqual(sandbox.canReviewAccountsUser(), false);
});

test("modo local sin Supabase configurado (sin cliente/sesion): conserva el comportamiento previo (siempre permitido)", () => {
  const sandbox = buildSandbox({
    supabaseClient: null,
    supabaseSession: null,
    erpProfile: null,
    erpProfileLoaded: false,
  });
  assert.strictEqual(sandbox.canManageInvoices(), true);
  assert.strictEqual(sandbox.canConfirmClosings(), true);
  assert.strictEqual(sandbox.canReviewAccountsUser(), true);
});

test("contador/contadora: puede revisar cuentas pero NO confirmar cierres ni administrar facturas", () => {
  const sandbox = buildSandbox({
    supabaseClient: {},
    supabaseSession: { user: { email: "contador@dalfi.test" }, access_token: "jwt" },
    erpProfile: {
      role: "contador",
      isActive: true,
      permissions: { ...noPermissions(), canReviewAccounts: true, canReviewAudit: true },
    },
    erpProfileLoaded: true,
  });
  assert.strictEqual(sandbox.canReviewAccountsUser(), true);
  assert.strictEqual(sandbox.canManageInvoices(), false);
  assert.strictEqual(sandbox.canConfirmClosings(), false);
});
