// Regresion del defecto real encontrado en la auditoria integral de Cierres:
// existe una columna de permiso dedicada, can_reopen_closings/canReopenClosings
// (creada en supabase/migrations/20260721000000_create_erp_user_profiles.sql,
// expuesta via /api/me), pensada especificamente para poder dar
// canManageInvoices a alguien sin darle la capacidad de reabrir cierres
// historicos ya confirmados -igual que canConfirmRegisterClosings/
// canConfirmTreasuryClosings ya estan separados de canManageInvoices para
// confirmar-. Sin embargo, la funcion real que reabre cierres
// (openClosingForEdit) y los botones "Reabrir" seguian usando
// canManageInvoices(), dejando esa columna sin ningun efecto real.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");
const authzJs = fs.readFileSync(path.join(__dirname, "..", "functions", "api", "_lib", "authz.js"), "utf8");

function extractFunction(name, source = appJs) {
  const pattern = new RegExp(`^(async )?function ${name}\\(`, "m");
  const match = pattern.exec(source);
  assert.ok(match, `no se encontro function ${name}`);
  let parenDepth = 0;
  let afterParams = source.indexOf("(", match.index);
  for (; afterParams < source.length; afterParams++) {
    if (source[afterParams] === "(") parenDepth++;
    else if (source[afterParams] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        afterParams++;
        break;
      }
    }
  }
  let depth = 0;
  let end = source.indexOf("{", afterParams);
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  return source.slice(match.index, end);
}

test("canReopenClosings() existe y lee especificamente erpProfile.permissions.canReopenClosings (no canManageInvoices)", () => {
  const fnSource = extractFunction("canReopenClosings");
  assert.match(fnSource, /erpProfile\.permissions\?\.canReopenClosings/);
  assert.ok(!/canManageInvoices/.test(fnSource), "canReopenClosings no debe depender de canManageInvoices");
});

test("openClosingForEdit() (la funcion real detras del boton 'Reabrir') exige canReopenClosings(), ya no canManageInvoices()", () => {
  const fnSource = extractFunction("openClosingForEdit");
  assert.match(fnSource, /if \(!canReopenClosings\(\)\) \{/);
  assert.ok(!/canManageInvoices/.test(fnSource), "openClosingForEdit ya no debe usar el permiso generico");
});

test("los botones 'Reabrir' (caja registradora y tesoreria) solo se pintan si canReopenClosings(), no con canManageInvoices()", () => {
  const buttonPattern = /!pending && canReopenClosings\(\) \? `<button class="secondary-btn compact open-closing"/g;
  const matches = appJs.match(buttonPattern) || [];
  assert.strictEqual(matches.length, 2, "deben ser exactamente 2: la fila de caja registradora y la de tesoreria");
});

test("setClosingViewActions(): el boton #cash-open-closing dentro del formulario tambien usa canReopenClosings(), no canManageInvoices()", () => {
  const fnSource = extractFunction("setClosingViewActions");
  assert.match(fnSource, /const canReopen = canReopenClosings\(\);/);
  assert.match(fnSource, /byId\("cash-open-closing"\)\.classList\.toggle\("hidden", !\(closing && !pending && canReopen\)\);/);
});

test("regresion: canConfirmClosings() y canManageInvoices() siguen intactas y usadas donde corresponde (guardar/confirmar cierres no se toco por este fix)", () => {
  assert.match(appJs, /function canConfirmClosings\(\) \{/);
  assert.match(appJs, /function canManageInvoices\(\) \{/);
  const confirmFn = extractFunction("startClosingConfirmation");
  assert.match(confirmFn, /if \(!canConfirmClosings\(\)\) \{/);
});

test("functions/api/_lib/authz.js: can_reopen_closings sigue mapeando a canReopenClosings y por defecto solo para roles privilegiados (sin cambios de este fix, solo confirmando que la columna que ahora se usa en el frontend sigue siendo la correcta)", () => {
  assert.match(authzJs, /canReopenClosings: Boolean\(row\.can_reopen_closings\)/);
  assert.match(authzJs, /can_reopen_closings: privileged/);
});
