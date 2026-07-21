const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extracted = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");

// Mismo mecanismo de extraccion por nombre de funcion (balance de llaves)
// que ya usan otros tests de este archivo (ver tests/log-audit-fallback.test.js).
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

const refreshSource = ["functionEndpoint", "isSupabaseReady", "refreshErpProfile", "performErpProfileRefresh"].map(extractFunction).join("\n\n");

function buildSandbox({ fetchImpl, supabaseReady = true }) {
  const sandbox = {
    window: { DALFI_FUNCTION_BASE: "" },
    location: { hostname: "dalfi-erp.pages.dev" },
    supabaseClient: supabaseReady ? {} : null,
    supabaseSession: supabaseReady ? { user: { email: "x@dalfi.test" }, access_token: "jwt" } : null,
    erpProfile: null,
    erpProfileLoaded: false,
    erpProfileRefreshPromise: null,
    erpProfileFailureLogged: false,
    fetch: fetchImpl,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(refreshSource, sandbox);
  return sandbox;
}

test("refreshErpProfile: dos llamadas simultaneas antes de que la primera resuelva comparten UN solo fetch (no se superponen)", async () => {
  let fetchCallCount = 0;
  let resolveFetch;
  const pending = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const sandbox = buildSandbox({
    fetchImpl: async () => {
      fetchCallCount += 1;
      await pending;
      return { ok: true, json: async () => ({ userId: "u1", email: "x@dalfi.test", role: "operador", isActive: true, permissions: {} }) };
    },
  });

  const first = sandbox.refreshErpProfile();
  const second = sandbox.refreshErpProfile();
  assert.strictEqual(sandbox.erpProfileRefreshPromise !== null, true, "debe haber una solicitud en curso registrada");
  resolveFetch();
  await Promise.all([first, second]);
  assert.strictEqual(fetchCallCount, 1, "dos llamadas solapadas deben compartir un solo fetch, no disparar dos");
  assert.strictEqual(sandbox.erpProfileRefreshPromise, null, "la marca de 'en curso' debe limpiarse al terminar");
});

test("refreshErpProfile: una vez resuelta la primera, una llamada nueva SI dispara un fetch nuevo (no queda cacheado para siempre)", async () => {
  let fetchCallCount = 0;
  const sandbox = buildSandbox({
    fetchImpl: async () => {
      fetchCallCount += 1;
      return { ok: true, json: async () => ({ userId: "u1", email: "x@dalfi.test", role: "operador", isActive: true, permissions: {} }) };
    },
  });
  await sandbox.refreshErpProfile();
  await sandbox.refreshErpProfile();
  assert.strictEqual(fetchCallCount, 2);
});

test("refreshErpProfile: un fallo de red no queda logueado en cada intento (throttle), solo la primera vez de la racha", async () => {
  const warnings = [];
  const sandbox = buildSandbox({
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  sandbox.console = { warn: (...args) => warnings.push(args), error: () => {}, log: () => {} };
  await sandbox.refreshErpProfile();
  await sandbox.refreshErpProfile();
  await sandbox.refreshErpProfile();
  assert.strictEqual(warnings.length, 1, "solo debe loguear el primer fallo de la racha, no inundar la consola cada 30s");
});

test("refreshErpProfile: tras un fallo, si el siguiente intento SI tiene exito, se resetea el throttle de logs para la proxima racha de fallos", async () => {
  const warnings = [];
  let shouldFail = true;
  const sandbox = buildSandbox({
    fetchImpl: async () => {
      if (shouldFail) throw new Error("network down");
      return { ok: true, json: async () => ({ userId: "u1", email: "x@dalfi.test", role: "operador", isActive: true, permissions: {} }) };
    },
  });
  sandbox.console = { warn: (...args) => warnings.push(args), error: () => {}, log: () => {} };
  await sandbox.refreshErpProfile();
  shouldFail = false;
  await sandbox.refreshErpProfile();
  shouldFail = true;
  await sandbox.refreshErpProfile();
  assert.strictEqual(warnings.length, 2, "una nueva racha de fallos (tras un exito intermedio) debe volver a loguear una vez");
});

test("refreshErpProfile: sin Supabase configurado (sesion cerrada), no llama a fetch y deja erpProfileLoaded=false", async () => {
  const sandbox = buildSandbox({ supabaseReady: false, fetchImpl: async () => { throw new Error("no deberia llamarse"); } });
  await sandbox.refreshErpProfile();
  assert.strictEqual(sandbox.erpProfile, null);
  assert.strictEqual(sandbox.erpProfileLoaded, false);
});

// --- Aserciones estaticas sobre el resto del ciclo de vida del poll de 30s ---
// (no son extraibles como funciones puras porque viven dentro de closures de
// wireAuth()/startRemoteRefreshLoop() atadas al DOM real; se fijan como
// invariantes de codigo, igual que ya hacen tests/migrations-security.test.js
// y tests/forgot-password-flow.test.js para casos equivalentes).

test("logout: detiene el poll de fondo (stopRemoteRefreshLoop) ademas de limpiar el perfil seguro", () => {
  const anchor = /byId\("logout-button"\)\.addEventListener\("click"/;
  const match = anchor.exec(extracted);
  assert.ok(match);
  const block = extracted.slice(match.index, match.index + 1200);
  assert.match(block, /stopRemoteRefreshLoop\(\)/, "el logout debe detener el poll de 30s, no solo limpiar el perfil en memoria");
  assert.match(block, /erpProfile\s*=\s*null/);
  assert.match(block, /erpProfileLoaded\s*=\s*false/);
});

test("poll de 30s: usa updatePrivilegeVisibility() (no updateAuthUi()) para no cerrar un panel de login/contrasena abierto por el usuario", () => {
  const anchor = /function startRemoteRefreshLoop\(\)/;
  const match = anchor.exec(extracted);
  assert.ok(match);
  const block = extracted.slice(match.index, match.index + 1000);
  assert.match(block, /refreshErpProfile\(\)\.then\(\(\)\s*=>\s*updatePrivilegeVisibility\(\)\)/);
  assert.ok(!/refreshErpProfile\(\)\.then\(\(\)\s*=>\s*updateAuthUi\(\)\)/.test(block), "el poll de fondo NO debe llamar a updateAuthUi() completo (cerraria password-change-panel)");
});

test("updateAuthUi(): sigue existiendo y sigue controlando los paneles de login (solo se le quito la duplicacion de logica de permisos, ahora en updatePrivilegeVisibility)", () => {
  assert.match(extracted, /function updatePrivilegeVisibility\(\)/);
  assert.match(extracted, /function updateAuthUi\(\)\s*\{[\s\S]{0,400}updatePrivilegeVisibility\(\)/);
});
