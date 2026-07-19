-- Migracion: columnas nuevas para auditoria real (erp_audit_log)
-- Fecha: 2026-07-19
--
-- Contexto: la tabla erp_audit_log ya existia en supabase/schema.sql pero
-- ningun endpoint escribia en ella. Ahora functions/api/_lib/audit.js y
-- functions/api/audit-log.js insertan registros ahi para acciones sensibles
-- (reset de contraseña, edicion de factura, confirmacion/reapertura de
-- cierres, confirmacion de transferencias, etc.), y necesitan estas columnas
-- adicionales: quien hizo la accion (correo y rol, ademas del user_id que ya
-- existia), si la accion tuvo exito, y una observacion en texto libre.
--
-- Es idempotente: se puede correr varias veces sin error y sin duplicar
-- columnas. NO se ejecuto automaticamente como parte de este cambio; debe
-- aplicarse manualmente desde el SQL Editor de Supabase cuando el equipo lo
-- confirme.

alter table if exists erp_audit_log
  add column if not exists user_email text,
  add column if not exists user_role text,
  add column if not exists success boolean not null default true,
  add column if not exists note text;

create index if not exists erp_audit_log_action_idx on erp_audit_log (action);
create index if not exists erp_audit_log_created_at_idx on erp_audit_log (created_at desc);

-- Nota sobre RLS (no se modifica en esta migracion):
-- erp_audit_log ya tiene RLS habilitada con politicas de SELECT e INSERT
-- para "authenticated" (ver supabase/schema.sql). No existen politicas de
-- UPDATE ni DELETE para esa tabla, así que por defecto Postgres las deniega:
-- ningun cliente (ni siquiera autenticado) puede modificar o borrar un
-- registro de auditoria ya escrito. Las funciones de Cloudflare insertan
-- usando la llave de servicio, que de todas formas evita RLS.
--
-- El hallazgo de seguridad mas amplio (RLS de erp_records permitiendo
-- lectura/escritura total a cualquier usuario autenticado) sigue abierto y
-- fuera del alcance de este cambio puntual; ver el informe de arquitectura
-- para el detalle y la recomendacion de endurecerlo en una fase aparte.
