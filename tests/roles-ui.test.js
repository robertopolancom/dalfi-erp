const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");

const ALL_ROLES = [
  "operador",
  "administradora",
  "administrador",
  "propietaria",
  "propietario",
  "contador",
  "contadora",
  "asistente_contable",
  "asistenta_contable",
];

function selectBlock(source, selectAttrMatcher) {
  const start = source.search(selectAttrMatcher);
  assert.ok(start >= 0, "no se encontro el <select> esperado");
  const end = source.indexOf("</select>", start);
  return source.slice(start, end);
}

test("index.html: el formulario de creacion de usuarios (#new-user-role) ofrece los 9 roles permitidos", () => {
  const block = selectBlock(indexHtml, /<select id="new-user-role">/);
  for (const role of ALL_ROLES) {
    assert.match(block, new RegExp(`<option value="${role}"`), `falta la opcion de rol '${role}' en #new-user-role`);
  }
  // Ningun valor de opcion fuera del allowlist (evita que alguien agregue
  // un rol libre a mano en el HTML sin darse cuenta de que el backend lo
  // rechazaria de todas formas).
  const optionValues = [...block.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(optionValues.length, ALL_ROLES.length);
  for (const value of optionValues) assert.ok(ALL_ROLES.includes(value), `opcion fuera del allowlist: ${value}`);
});

test("outputs/app.js: la fila editable de cada usuario (.user-role-input) ofrece los 9 roles permitidos", () => {
  const block = selectBlock(appJs, /<select class="user-role-input compact-input">/);
  for (const role of ALL_ROLES) {
    assert.match(block, new RegExp(`value="${role}"`), `falta la opcion de rol '${role}' en .user-role-input`);
  }
  const optionValues = [...block.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(optionValues.length, ALL_ROLES.length);
  for (const value of optionValues) assert.ok(ALL_ROLES.includes(value), `opcion fuera del allowlist: ${value}`);
});

test("outputs/app.js: la fila editable de cada usuario tambien ofrece el checkbox 'Revisar auditoría' (can_review_audit explicito)", () => {
  assert.match(appJs, /user-review-audit-input/);
  assert.match(appJs, /canReviewAudit:\s*row\.querySelector\("\.user-review-audit-input"\)\.checked/);
});
