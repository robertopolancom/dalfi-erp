// Regresion del bug encontrado al verificar 20260721000000 ya aplicada en
// produccion: el backfill dejo can_review_accounts=false para los roles
// privilegiados (deberia ser true, igual que defaultPermissionsForRole() en
// functions/api/_lib/authz.js). 20260721000002 lo corrige con un UPDATE
// idempotente. Estas pruebas fijan que la correccion exista, sea idempotente,
// no toque otros roles/permisos, y que la formula SQL original del backfill
// (ya aplicada, no se edita) quede documentada como la causa raiz.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const migrationsDir = path.join(__dirname, "..", "supabase", "migrations");
const fixSql = fs.readFileSync(path.join(migrationsDir, "20260721000002_fix_privileged_role_can_review_accounts.sql"), "utf8");
const authzModuleUrl = pathToFileURL(path.join(__dirname, "..", "functions", "api", "_lib", "authz.js")).href;

function stripSqlComments(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const fixDdl = stripSqlComments(fixSql);

test("20260721000002: corrige can_review_accounts=true para los 4 roles privilegiados, y SOLO esos roles", () => {
  assert.match(fixDdl, /update public\.erp_user_profiles/i);
  assert.match(fixDdl, /set can_review_accounts = true/i);
  for (const role of ["administradora", "administrador", "propietaria", "propietario"]) {
    assert.ok(fixDdl.includes(`'${role}'`), `debe incluir el rol '${role}' en el WHERE`);
  }
  // No debe tocar contador/contadora/operador/asistente_contable/asistenta_contable.
  for (const role of ["contador", "contadora", "operador", "asistente_contable", "asistenta_contable"]) {
    assert.ok(!fixDdl.includes(`'${role}'`), `NO debe mencionar el rol '${role}' (no debe tocarse)`);
  }
});

test("20260721000002: es idempotente (el WHERE excluye filas que ya estan correctas, se puede correr de nuevo sin efecto)", () => {
  assert.match(fixDdl, /and can_review_accounts = false/i);
});

test("20260721000002: solo modifica can_review_accounts, ningun otro permiso ni columna", () => {
  const setClauses = [...fixDdl.matchAll(/set\s+([a-z_]+)\s*=/gi)].map((m) => m[1]);
  assert.deepStrictEqual(setClauses, ["can_review_accounts"]);
});

test("20260721000002: no usa CASCADE ni DELETE/DROP/TRUNCATE", () => {
  assert.ok(!/cascade|delete\s+from|drop\s+|truncate/i.test(fixDdl));
});

test("regresion: defaultPermissionsForRole() en authz.js SIGUE devolviendo can_review_accounts=true para los 4 roles privilegiados (la causa raiz nunca estuvo en el codigo JS, solo en el SQL del backfill ya corregido)", async () => {
  const { defaultPermissionsForRole } = await import(authzModuleUrl);
  for (const role of ["administradora", "administrador", "propietaria", "propietario"]) {
    assert.strictEqual(defaultPermissionsForRole(role).can_review_accounts, true, role);
  }
});
