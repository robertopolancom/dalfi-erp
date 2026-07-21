-- Consulta de SOLO LECTURA para correr ANTES de aplicar
-- 20260721000000_create_erp_user_profiles.sql.
--
-- NO es una migracion (a proposito vive fuera de supabase/migrations/ para
-- que "supabase db push" nunca la interprete como una). No modifica nada.
--
-- Muestra, para cada usuario en auth.users, exactamente lo mismo que
-- calcularia el backfill de la migracion: el rol normalizado esperado, si
-- recibira permisos administrativos, y si quedara activo. Sirve para
-- confirmar ANTES de aplicar la migracion que al menos un usuario recibira
-- can_manage_users=true (si no, la migracion abortara sola por la
-- salvaguarda que agrega al final, pero es mejor saberlo de antemano).
--
-- El correo se enmascara (2 primeros caracteres + dominio) para no imprimir
-- direcciones completas en salidas de consola/informes.
--
-- Como correrla (solo lectura, usa la sesion ya autenticada de la CLI):
--   npx supabase db query --linked -f supabase/pre_migration_check_user_profiles.sql

select
  left(coalesce(au.email, ''), 2) || '***@' || split_part(coalesce(au.email, ''), '@', 2) as email_masked,
  coalesce(au.raw_user_meta_data ->> 'role', '(sin rol)') as rol_original,
  case
    when regexp_replace(lower(trim(coalesce(au.raw_user_meta_data ->> 'role', ''))), '\s+', '_', 'g') in (
      'operador', 'administradora', 'administrador', 'propietaria', 'propietario',
      'contador', 'contadora', 'asistente_contable', 'asistenta_contable'
    )
    then regexp_replace(lower(trim(coalesce(au.raw_user_meta_data ->> 'role', ''))), '\s+', '_', 'g')
    else 'operador'
  end as rol_normalizado_esperado,
  (regexp_replace(lower(trim(coalesce(au.raw_user_meta_data ->> 'role', ''))), '\s+', '_', 'g') in ('administradora', 'administrador', 'propietaria', 'propietario')) as recibira_permisos_admin,
  not (
    coalesce(au.raw_user_meta_data ->> 'estado', '') = 'Inactivo'
    or (au.banned_until is not null and au.banned_until > now())
  ) as estara_activo
from auth.users au
order by rol_normalizado_esperado, email_masked;
