const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
const createUser = fs.readFileSync(path.join(__dirname, "..", "functions", "api", "create-user.js"), "utf8");

const presetsStart = app.indexOf("const userPermissionPresets = {");
const presetsEnd = app.indexOf("const permissionsForPreset =", presetsStart);
const presetsSource = app.slice(presetsStart, presetsEnd);

test("perfiles predefinidos: existen exactamente Recepción, Facturación, Inventario, Nómina, Contabilidad y Supervisión", () => {
  const expected = {
    reception: "Recepción",
    billing: "Facturación",
    inventory: "Inventario",
    payroll: "Nómina",
    accounting: "Contabilidad",
    supervision: "Supervisión",
  };
  for (const [key, label] of Object.entries(expected)) {
    assert.match(presetsSource, new RegExp(`${key}:\\s*\\{[\\s\\S]*?label: "${label}"`));
    assert.match(html, new RegExp(`<option value="${key}">${label}</option>`));
  }
  assert.strictEqual((presetsSource.match(/label:/g) || []).length, 6);
});

test("perfiles predefinidos: ninguno concede administrar usuarios ni reabrir cierres", () => {
  assert.doesNotMatch(presetsSource, /"canManageUsers"/);
  assert.doesNotMatch(presetsSource, /"canReopenClosings"/);
});

test("Recepción y Contabilidad tienen composiciones operativas explícitas", () => {
  assert.match(
    presetsSource,
    /reception:[\s\S]*?enabled: \["canManageReservations", "canManageBilling", "canSubmitRegisterCount"\]/,
  );
  assert.match(
    presetsSource,
    /accounting:[\s\S]*?enabled: \["canReviewAccounts", "canReviewAudit", "canManageAccounts", "canConfirmTreasuryClosings"\]/,
  );
});

test("aplicar un perfil marca las 13 casillas; editar una casilla vuelve el perfil a Personalizado", () => {
  assert.match(app, /Object\.fromEntries\(userPermissionOptions\.map\(\(\[key\]\) => \[key, enabled\.has\(key\)\]\)\)/);
  assert.match(app, /row\.querySelectorAll\("\.user-permission-input"\)\.forEach/);
  assert.match(app, /input\.checked = Boolean\(permissions\[input\.dataset\.permission\]\)/);
  assert.match(app, /if \(event\.target\.matches\("\.user-permission-input"\)\)/);
  assert.match(app, /preset\.value = ""/);
});

test("crear usuario permite Según el rol o una plantilla, y el servidor valida la matriz", () => {
  assert.match(html, /<select id="new-user-permission-preset">/);
  assert.match(html, /<option value="">Según el rol<\/option>/);
  assert.match(app, /const presetKey = byId\("new-user-permission-preset"\)\.value/);
  assert.match(app, /\.\.\.\(permissions \? \{ permissions \} : \{\}\)/);
  assert.match(createUser, /sanitizePermissionOverrides\(payload\.permissions\)/);
  assert.match(createUser, /hasUnknownPermission/);
  assert.match(createUser, /permissionOverrides,/);
});
