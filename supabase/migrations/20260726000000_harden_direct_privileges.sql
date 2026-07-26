-- Endurecimiento gradual de privilegios directos del documento ERP.
--
-- PRECONDICION: la capa /api/database y el Worker de cierres deben estar
-- publicados y verificados. Esta migracion no cambia filas ni politicas de
-- negocio; elimina privilegios heredados que no necesita el navegador.
-- service_role conserva el acceso que usan exclusivamente las funciones del
-- servidor y el Worker.

-- erp_records no debe ser consultable ni mantenible directamente por ningun
-- rol de cliente. La unica via es /api/database con service_role.
revoke all on table public.erp_records from anon, authenticated;
grant select, insert, update, delete on table public.erp_records to service_role;

-- La bitacora solo puede ser leida por authenticated cuando la politica RLS
-- erp_audit_log_authorized_read lo permite. No se conceden REFERENCES,
-- TRIGGER ni MAINTAIN a roles de cliente.
revoke all on table public.erp_audit_log from anon, authenticated;
grant select on table public.erp_audit_log to authenticated;
grant all on table public.erp_audit_log to service_role;

-- Estos helpers SECURITY DEFINER solo son necesarios para evaluar politicas
-- de sesiones autenticadas. anon no debe poder invocarlos directamente.
revoke all on function public.current_erp_profile() from anon;
revoke all on function public.has_erp_role(text[]) from anon;
revoke all on function public.has_erp_permission(text) from anon;

-- set_updated_at se invoca como trigger del propietario de las tablas; no es
-- una API publica para anon/authenticated.
revoke all on function public.set_updated_at() from anon, authenticated;
grant execute on function public.set_updated_at() to service_role;

comment on table public.erp_records is
  'Documento principal de SeBen Service. Sin privilegios directos para anon/authenticated; acceso exclusivamente mediante funciones server-side con service_role.';

-- === Verificacion posterior (documentada; NO se ejecuta aqui) =============
-- 1. anon/authenticated no tienen SELECT/INSERT/UPDATE/DELETE/MAINTAIN sobre
--    erp_records.
-- 2. authenticated conserva SELECT de erp_audit_log, sujeto a RLS.
-- 3. anon no puede ejecutar helpers SECURITY DEFINER ni set_updated_at.
-- 4. /api/database, auditoria server-side y Worker siguen funcionando.

