// Estas pruebas verifican el TEXTO de las migraciones nuevas (analisis
// estatico), no el comportamiento real de Postgres/RLS: esta fase no aplica
// ninguna migracion remota (ver seccion 13 de la tarea: solo dry-run), asi
// que no hay una base de datos real contra la cual correr una prueba de
// integracion. Una vez que un administrador autorice y aplique estas
// migraciones, la verificacion real de RLS debe hacerse contra el proyecto
// Supabase (por ejemplo con dos usuarios de prueba, uno operador y uno
// administradora) y no solo con estas pruebas.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migrationsDir = path.join(__dirname, "..", "supabase", "migrations");
const profilesSql = fs.readFileSync(path.join(migrationsDir, "20260721000000_create_erp_user_profiles.sql"), "utf8");
const auditLogSql = fs.readFileSync(path.join(migrationsDir, "20260721000001_secure_erp_audit_log.sql"), "utf8");

// Ambas migraciones documentan su intencion y su rollback en comentarios SQL
// ("-- ..."), que a proposito mencionan cosas como "CASCADE" o "using
// (true)" para explicar que NO se usan / ya no se usan. Las aserciones de
// "no debe contener X" solo tienen sentido sobre las sentencias SQL reales,
// asi que se les quitan los comentarios antes de revisarlas.
function stripSqlComments(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const profilesDdl = stripSqlComments(profilesSql);
const auditLogDdl = stripSqlComments(auditLogSql);

test("20260721000000: crea erp_user_profiles con RLS habilitada y CHECK de roles", () => {
  assert.match(profilesSql, /create table if not exists public\.erp_user_profiles/i);
  assert.match(profilesSql, /alter table public\.erp_user_profiles enable row level security/i);
  assert.match(profilesSql, /erp_user_profiles_role_check check/i);
  for (const role of ["operador", "administradora", "administrador", "propietaria", "propietario", "contador", "contadora", "asistente_contable", "asistenta_contable"]) {
    assert.ok(profilesSql.includes(`'${role}'`), `el CHECK debe incluir el rol '${role}'`);
  }
});

test("20260721000000: NO otorga acceso directo de tabla a anon/authenticated (revoke explicito, sin GRANT de vuelta)", () => {
  assert.match(profilesSql, /revoke all on public\.erp_user_profiles from anon, authenticated/i);
  assert.ok(!/grant\s+(select|insert|update|delete|all)\s+on\s+public\.erp_user_profiles\s+to\s+(anon|authenticated)/i.test(profilesSql), "no debe haber ningun GRANT de vuelta a anon/authenticated sobre la tabla");
});

test("20260721000000: el backfill es idempotente (ON CONFLICT DO NOTHING, nunca sobreescribe)", () => {
  assert.match(profilesSql, /on conflict \(user_id\) do nothing/i);
  assert.ok(!/on conflict \(user_id\) do update/i.test(profilesSql), "el backfill no debe pisar perfiles ya existentes");
});

test("20260721000000: operador NO aparece asociado a ningun permiso administrativo TRUE por defecto en el backfill", () => {
  // El backfill solo pone TRUE en columnas administrativas para los 4 roles
  // privilegiados; comprobamos que esa lista de roles es exactamente la
  // esperada en cada bloque "in (...)" usado para derivar permisos.
  const privilegedBlocks = profilesSql.match(/u\.normalized_role in \([^)]*\)/g) || [];
  assert.ok(privilegedBlocks.length >= 5, "debe haber varios bloques normalized_role in (...) para los permisos administrativos");
  const adminOnlyBlocks = privilegedBlocks.filter((block) => !block.includes("contador"));
  for (const block of adminOnlyBlocks) {
    assert.ok(!block.includes("'operador'"), `un bloque de permiso administrativo no debe incluir 'operador': ${block}`);
  }
});

test("20260721000000: define current_erp_profile/has_erp_role/has_erp_permission como SECURITY DEFINER con search_path fijo, usando auth.uid()", () => {
  for (const fn of ["current_erp_profile", "has_erp_role", "has_erp_permission"]) {
    const pattern = new RegExp(`create or replace function public\\.${fn}\\([^)]*\\)[\\s\\S]*?security definer[\\s\\S]*?set search_path = public`, "i");
    assert.match(profilesSql, pattern, `${fn} debe ser SECURITY DEFINER con search_path fijo`);
  }
  assert.match(profilesSql, /grant execute on function public\.current_erp_profile\(\) to authenticated/i);
  assert.match(profilesSql, /grant execute on function public\.has_erp_role\(text\[\]\) to authenticated/i);
  assert.match(profilesSql, /grant execute on function public\.has_erp_permission\(text\) to authenticated/i);
  assert.ok(!/user_id\s+uuid\s*(:=|default)/i.test(profilesSql), "las funciones no deben aceptar un user_id como parametro desde el navegador");
});

test("20260721000000: incluye rollback documentado (no ejecutado)", () => {
  assert.match(profilesSql, /=== Rollback documentado/i);
  assert.match(profilesSql, /-- drop table if exists public\.erp_user_profiles/);
});

test("20260721000000: aborta la migracion (RAISE EXCEPTION) si no queda ningun perfil activo con can_manage_users=true tras el backfill", () => {
  assert.match(profilesDdl, /do \$\$/i);
  assert.match(profilesDdl, /where\s+is_active\s*=\s*true\s+and\s+can_manage_users\s*=\s*true/i);
  assert.match(profilesDdl, /raise exception/i);
  // La salvaguarda debe ir DESPUES del backfill (si fuera antes, siempre
  // abortaria porque la tabla todavia estaria vacia).
  const backfillIndex = profilesDdl.search(/insert into public\.erp_user_profiles/i);
  const guardIndex = profilesDdl.search(/raise exception/i);
  assert.ok(backfillIndex >= 0 && guardIndex > backfillIndex, "la salvaguarda debe evaluarse despues del INSERT del backfill, no antes");
});

test("20260721000000: la salvaguarda NO crea un administrador de emergencia automatico (solo aborta)", () => {
  const guardSection = profilesDdl.slice(profilesDdl.search(/raise exception/i) - 400, profilesDdl.search(/raise exception/i) + 200);
  assert.ok(!/insert into/i.test(guardSection), "la salvaguarda no debe insertar filas nuevas, solo verificar y abortar");
});

test("supabase/pre_migration_check_user_profiles.sql: existe, es de solo lectura (SELECT unicamente) y enmascara el correo", () => {
  const checkPath = path.join(migrationsDir, "..", "pre_migration_check_user_profiles.sql");
  assert.ok(fs.existsSync(checkPath), "debe existir supabase/pre_migration_check_user_profiles.sql");
  const sql = fs.readFileSync(checkPath, "utf8");
  const ddl = stripSqlComments(sql);
  assert.match(ddl.trim(), /^select/i, "debe ser una consulta de solo lectura (empieza con SELECT)");
  assert.ok(!/insert|update|delete|drop|alter|create|truncate/i.test(ddl), "no debe contener ninguna sentencia de escritura");
  assert.match(ddl, /email_masked/i, "debe enmascarar el correo en vez de mostrarlo completo");
  assert.ok(!/select\s+au\.email\b/i.test(ddl), "no debe seleccionar el correo completo sin enmascarar");
});

test("20260721001: elimina la politica de INSERT abierta de erp_audit_log y no crea ninguna de reemplazo para authenticated", () => {
  assert.match(auditLogSql, /drop policy if exists "erp_audit_log_authenticated_insert" on erp_audit_log/i);
  assert.ok(!/create policy[\s\S]*?for insert[\s\S]*?to authenticated/i.test(auditLogDdl), "no debe crear ninguna politica de INSERT para authenticated");
});

test("20260721001: revoca INSERT/UPDATE/DELETE/TRUNCATE de anon y authenticated sobre erp_audit_log", () => {
  assert.match(auditLogSql, /revoke insert, update, delete, truncate on erp_audit_log from anon, authenticated/i);
});

test("20260721001: la nueva politica de SELECT exige can_review_audit o rol administrativo (usa las funciones SECURITY DEFINER, no expone SELECT completo)", () => {
  assert.match(auditLogSql, /create policy "erp_audit_log_authorized_read"/i);
  assert.match(auditLogSql, /has_erp_permission\('can_review_audit'\)/);
  assert.match(auditLogSql, /has_erp_role\(array\['administradora', 'administrador', 'propietaria', 'propietario'\]\)/);
  assert.ok(!/using \(\s*true\s*\)/i.test(auditLogDdl), "no debe quedar ninguna politica 'using (true)' (lectura abierta) en esta migracion");
});

test("20260721001: no crea ninguna politica de UPDATE ni DELETE (quedan bloqueados por omision con RLS activa)", () => {
  assert.ok(!/for update/i.test(auditLogDdl));
  assert.ok(!/for delete/i.test(auditLogDdl));
});

test("20260721001: no usa CASCADE en ningun punto y no borra/modifica filas existentes", () => {
  assert.ok(!/cascade/i.test(auditLogDdl));
  assert.ok(!/delete from erp_audit_log/i.test(auditLogDdl));
  assert.ok(!/update erp_audit_log/i.test(auditLogDdl));
});

test("20260721001: incluye rollback documentado (no ejecutado)", () => {
  assert.match(auditLogSql, /=== Rollback documentado/i);
  assert.match(auditLogSql, /-- create policy "erp_audit_log_authenticated_insert"/);
});

test("ninguna de las dos migraciones nuevas toca erp_records ni sus politicas (fuera de comentarios explicativos)", () => {
  // erp_records SI se menciona en comentarios (para documentar que a
  // proposito no se toca); lo que no debe aparecer es en una sentencia SQL
  // real fuera de comentarios.
  assert.ok(!/erp_records/i.test(profilesDdl), "20260721000000 no debe tener DDL real sobre erp_records");
  assert.ok(!/erp_records/i.test(auditLogDdl), "20260721000001 no debe tener DDL real sobre erp_records");
});
