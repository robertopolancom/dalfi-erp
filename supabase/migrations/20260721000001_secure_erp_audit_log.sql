-- Migracion: proteger erp_audit_log (RLS)
-- Fecha: 2026-07-21
--
-- Contexto: erp_audit_log ya tenia RLS habilitada (ver supabase/schema.sql),
-- pero con una politica de INSERT abierta a CUALQUIER usuario autenticado
-- (using(true)/with check(true)) y una politica de SELECT igual de abierta.
-- Esto significaba que, sin pasar por functions/api/audit-log.js, cualquier
-- usuario autenticado podia insertar entradas de auditoria fabricadas
-- directamente contra la API REST de Supabase, y cualquier usuario
-- autenticado podia leer TODA la bitacora (incluyendo acciones de otros
-- usuarios), sin importar su rol.
--
-- Esta migracion:
--   1. Elimina la politica de INSERT para authenticated (no se crea ninguna
--      de reemplazo: la unica via de escritura pasa a ser service_role,
--      usado exclusivamente por functions/api/_lib/audit.js).
--   2. Revoca INSERT/UPDATE/DELETE/TRUNCATE de anon y authenticated sobre
--      erp_audit_log (defensa en profundidad ademas de RLS).
--   3. Reemplaza la politica de SELECT abierta por una que exige
--      has_erp_permission('can_review_audit') o rol administrativo
--      (administradora/administrador/propietaria/propietario), usando las
--      funciones SECURITY DEFINER creadas en
--      20260721000000_create_erp_user_profiles.sql.
--   4. Mantiene UPDATE y DELETE bloqueados: no se crea ninguna politica para
--      esas operaciones, asi que con RLS activa quedan denegadas por
--      defecto para todo rol que no sea service_role.
--
-- Depende de 20260721000000_create_erp_user_profiles.sql (usa
-- has_erp_permission/has_erp_role). NO modifica ninguna fila existente de
-- erp_audit_log, no usa CASCADE, y NO toca erp_records ni sus politicas.

drop policy if exists "erp_audit_log_authenticated_insert" on erp_audit_log;
drop policy if exists "erp_audit_log_authenticated_read" on erp_audit_log;

revoke insert, update, delete, truncate on erp_audit_log from anon, authenticated;

create policy "erp_audit_log_authorized_read"
on erp_audit_log for select
to authenticated
using (
  public.has_erp_permission('can_review_audit')
  or public.has_erp_role(array['administradora', 'administrador', 'propietaria', 'propietario'])
);

-- Sin politica de INSERT/UPDATE/DELETE para authenticated ni anon: con RLS
-- habilitada, la ausencia de politica deniega la operacion por defecto.
-- service_role sigue pudiendo escribir (bypassa RLS y conserva sus GRANT de
-- tabla estandar de Supabase), que es exactamente lo que usa
-- functions/api/_lib/audit.js con SUPABASE_SERVICE_ROLE_KEY.

comment on table erp_audit_log is
  'Bitacora de auditoria. Escritura SOLO via service_role (functions/api/_lib/audit.js). Lectura restringida a usuarios con can_review_audit o rol administrativo (ver has_erp_permission/has_erp_role en 20260721000000_create_erp_user_profiles.sql). UPDATE/DELETE bloqueados para todo rol que no sea service_role.';

-- === Rollback documentado (NO se ejecuta como parte de esta migracion) =====
-- drop policy if exists "erp_audit_log_authorized_read" on erp_audit_log;
-- create policy "erp_audit_log_authenticated_read" on erp_audit_log
--   for select to authenticated using (true);
-- create policy "erp_audit_log_authenticated_insert" on erp_audit_log
--   for insert to authenticated with check (true);
-- grant insert on erp_audit_log to authenticated;
