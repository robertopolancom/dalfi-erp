const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const migration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20260725000001_lock_down_erp_records.sql"),
  "utf8",
);
const appJs = fs.readFileSync(path.join(root, "outputs", "app.js"), "utf8");
const databaseApi = fs.readFileSync(path.join(root, "functions", "api", "database.js"), "utf8");
const closingApi = fs.readFileSync(path.join(root, "functions", "api", "run-closing-catchup.js"), "utf8");

function stripComments(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const ddl = stripComments(migration);

test("la migracion elimina ambas policies abiertas de erp_records", () => {
  assert.match(ddl, /drop policy if exists "erp_records_authenticated_read" on public\.erp_records/i);
  assert.match(ddl, /drop policy if exists "erp_records_authenticated_write" on public\.erp_records/i);
  assert.doesNotMatch(ddl, /create policy[\s\S]*to authenticated/i);
  assert.doesNotMatch(ddl, /using\s*\(\s*true\s*\)|with check\s*\(\s*true\s*\)/i);
});

test("anon/authenticated pierden privilegios directos de tabla", () => {
  assert.match(
    ddl,
    /revoke select, insert, update, delete, truncate, references, trigger\s+on table public\.erp_records\s+from anon, authenticated/i,
  );
  assert.doesNotMatch(ddl, /grant\s+(select|insert|update|delete|all)[\s\S]*public\.erp_records[\s\S]*to\s+(anon|authenticated)/i);
});

test("authenticated pierde EXECUTE del RPC y service_role lo conserva", () => {
  assert.match(
    ddl,
    /revoke all\s+on function public\.save_erp_record_if_current\(text, text, jsonb, timestamptz\)\s+from public, anon, authenticated/i,
  );
  assert.match(
    ddl,
    /grant execute\s+on function public\.save_erp_record_if_current\(text, text, jsonb, timestamptz\)\s+to service_role/i,
  );
  assert.doesNotMatch(
    ddl,
    /grant execute\s+on function public\.save_erp_record_if_current\(text, text, jsonb, timestamptz\)\s+to authenticated/i,
  );
});

test("service_role conserva acceso de tabla para Pages y Worker", () => {
  assert.match(ddl, /grant select, insert, update, delete\s+on table public\.erp_records\s+to service_role/i);
  assert.match(databaseApi, /env\.SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(databaseApi, /Authorization:\s*`Bearer \$\{key\}`/);
  assert.match(closingApi, /env\.SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(closingApi, /Authorization:\s*`Bearer \$\{serviceRoleKey\}`/);
});

test("la SPA no tiene ninguna ruta directa a erp_records o al RPC", () => {
  assert.match(appJs, /fetch\("\/api\/database"/);
  assert.doesNotMatch(appJs, /\.from\("erp_records"\)/);
  assert.doesNotMatch(appJs, /\.rpc\("save_erp_record_if_current"/);
  assert.doesNotMatch(appJs, /rest\/v1\/erp_records|rest\/v1\/rpc\/save_erp_record_if_current/);
});

test("la migracion no modifica datos y documenta precondicion, verificacion y rollback", () => {
  assert.doesNotMatch(ddl, /^\s*(insert\s+into|update\s+public\.|delete\s+from|truncate\s+table)\b/im);
  assert.match(migration, /PRECONDICION DE DESPLIEGUE/);
  assert.match(migration, /Verificacion posterior/);
  assert.match(migration, /Rollback documentado/);
});
