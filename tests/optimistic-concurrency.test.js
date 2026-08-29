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

test("si el login no puede leer /api/database, la SPA no intenta guardar el respaldo local", () => {
  const loginBlock = appJs.slice(appJs.indexOf('byId("auth-form").addEventListener'), appJs.indexOf("function wireUserAdmin"));
  assert.match(loginBlock, /No se pudo leer la base de datos\. No se guardó ningún dato\./);
  assert.doesNotMatch(loginBlock, /else \{\s*await saveRemoteDatabase\(\)/);
});

test("el refresco remoto conserva el codigo HTTP en el estado visible sin exponer el cuerpo", () => {
  assert.match(appJs, /Error leyendo base de datos \(HTTP \$\{status\}\)/);
  assert.match(appJs, /match\(\/HTTP\\s\+\(\\d\{3\}\)\/\)/);
});

test("el login tiene timeout y no queda indefinidamente en Conectando Supabase", () => {
  assert.match(appJs, /withSupabaseTimeout\(supabaseClient\.auth\.signInWithPassword/);
  assert.match(appJs, /Supabase no respondió en 15 segundos/);
  assert.match(appJs, /window\.setTimeout/);
});

test("el login muestra el HTTP real si falla la lectura inicial de /api/database", () => {
  const loginBlock = appJs.slice(appJs.indexOf('byId("auth-form").addEventListener'), appJs.indexOf("function wireUserAdmin"));
  assert.match(loginBlock, /withSupabaseTimeout\(loadRemoteDatabase\(\)\)/);
  assert.match(loginBlock, /No se pudo leer la base de datos \(HTTP \$\{status\}\)/);
  assert.match(loginBlock, /auth\.signOut\(\)/);
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
