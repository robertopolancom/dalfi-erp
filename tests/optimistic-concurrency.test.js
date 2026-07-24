const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");
const migration = fs.readFileSync(
  path.join(__dirname, "..", "supabase", "migrations", "20260725000000_optimistic_erp_record_save.sql"),
  "utf8",
);
const cronJs = fs.readFileSync(path.join(__dirname, "..", "functions", "api", "run-closing-catchup.js"), "utf8");

test("la migración compara updated_at y nunca convierte un conflicto en upsert", () => {
  assert.match(migration, /record\.updated_at = p_expected_updated_at/);
  assert.match(migration, /on conflict \(table_name, record_key\) do nothing/);
  assert.match(migration, /return query select false, true, v_updated_at/);
  assert.doesNotMatch(migration, /on conflict \(table_name, record_key\) do update/i);
});

test("la función de guardado usa SECURITY INVOKER y permisos mínimos", () => {
  assert.match(migration, /security invoker/i);
  assert.match(migration, /revoke all on function public\.save_erp_record_if_current[\s\S]*from anon/);
  assert.match(migration, /grant execute on function public\.save_erp_record_if_current[\s\S]*to authenticated/);
  assert.match(migration, /grant execute on function public\.save_erp_record_if_current[\s\S]*to service_role/);
});

test("la SPA carga y guarda exclusivamente mediante /api/database con la version esperada", () => {
  assert.match(appJs, /fetch\("\/api\/database"/);
  assert.match(appJs, /fetch\("\/api\/database\?metadata=1"/);
  assert.match(appJs, /expectedUpdatedAt:\s*lastKnownRemoteUpdatedAt/);
  assert.match(appJs, /Authorization:\s*`Bearer \$\{supabaseSession\.access_token\}`/);
  assert.doesNotMatch(appJs, /\.from\("erp_records"\)/);
  assert.doesNotMatch(appJs, /\.rpc\("save_erp_record_if_current"/);
});

test("un conflicto detiene nuevos autosaves y avisa sin sobrescribir", () => {
  assert.match(appJs, /remoteConflictDetected = true/);
  assert.match(appJs, /scheduleRemoteSave\(\)[\s\S]*remoteConflictDetected/);
  assert.match(appJs, /No se sobrescribió ningún dato remoto/);
});

test("el Cron usa el mismo RPC y responde 409 ante una versión obsoleta", () => {
  assert.match(cronJs, /rest\/v1\/rpc\/save_erp_record_if_current/);
  assert.match(cronJs, /p_expected_updated_at: expectedUpdatedAt/);
  assert.match(cronJs, /error\.status = 409/);
  assert.match(cronJs, /error\.status \|\| 500/);
});
