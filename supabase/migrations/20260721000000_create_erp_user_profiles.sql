-- Migracion: tabla segura de perfiles y permisos (erp_user_profiles)
-- Fecha: 2026-07-21
--
-- Contexto (auditorias tecnica y contable 2026-07-20/21): hoy toda la
-- autorizacion real del ERP (quien es administrador, quien puede revisar
-- Cuentas, etc.) se resuelve leyendo user_metadata de Supabase Auth, tanto
-- en el navegador (outputs/app.js) como en las Cloudflare Functions
-- (functions/api/*.js). user_metadata es editable por el propio usuario en
-- ciertos flujos de Supabase Auth y nunca fue disenado como fuente de
-- autorizacion. Esta migracion crea una tabla nueva, separada de
-- auth.users, que pasa a ser la UNICA fuente confiable de rol y permisos.
--
-- Esta migracion NO toca erp_records ni sus politicas RLS existentes (esa
-- tabla sigue leyendose/escribiendose directo desde el navegador; cerrar su
-- RLS es un cambio independiente y posterior, fuera de este alcance).
--
-- Es idempotente: puede correrse mas de una vez sin duplicar la tabla ni
-- perder ediciones manuales ya hechas sobre erp_user_profiles (el backfill
-- usa ON CONFLICT DO NOTHING, nunca sobreescribe una fila ya existente).

create table if not exists public.erp_user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null,
  is_active boolean not null default true,
  can_review_accounts boolean not null default false,
  can_review_audit boolean not null default false,
  can_submit_register_count boolean not null default false,
  can_confirm_register_closings boolean not null default false,
  can_confirm_treasury_closings boolean not null default false,
  can_manage_users boolean not null default false,
  can_manage_invoices boolean not null default false,
  can_reopen_closings boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Roles reconocidos hoy por el sistema. Debe mantenerse en sincronia con
-- ALLOWED_ROLES en functions/api/_lib/authz.js y con PRIVILEGED_ROLES /
-- ACCOUNT_REVIEW_ROLES en outputs/lib/closing-math.js.
alter table public.erp_user_profiles
  drop constraint if exists erp_user_profiles_role_check;
alter table public.erp_user_profiles
  add constraint erp_user_profiles_role_check check (
    role in (
      'operador',
      'administradora',
      'administrador',
      'propietaria',
      'propietario',
      'contador',
      'contadora',
      'asistente_contable',
      'asistenta_contable'
    )
  );

-- Reutiliza set_updated_at(), ya creada en supabase/schema.sql para
-- erp_records (idempotente: si no existiera todavia en el entorno donde se
-- aplique esta migracion, se crea aqui tambien con el mismo cuerpo).
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists erp_user_profiles_set_updated_at on public.erp_user_profiles;
create trigger erp_user_profiles_set_updated_at
before update on public.erp_user_profiles
for each row
execute function public.set_updated_at();

-- RLS: habilitada, SIN politicas para anon/authenticated. Con RLS activa y
-- cero politicas, esos roles no ven ni pueden escribir ninguna fila sin
-- importar los GRANT de tabla. Se revocan tambien los privilegios de tabla
-- como segunda capa (defensa en profundidad), para que quede explicito en
-- el propio esquema que esta tabla nunca se expone directamente.
alter table public.erp_user_profiles enable row level security;
revoke all on public.erp_user_profiles from anon, authenticated;

comment on table public.erp_user_profiles is
  'Fuente confiable de rol y permisos del ERP. NUNCA se expone directamente a anon/authenticated: se administra solo via service_role (Cloudflare Functions) y se consulta desde el propio usuario solo a traves de current_erp_profile()/has_erp_role()/has_erp_permission() (SECURITY DEFINER, definidas mas abajo).';

-- === Backfill idempotente desde auth.users =================================
-- Por cada usuario existente sin perfil todavia:
--   - role se migra desde raw_user_meta_data->>'role', normalizado (trim +
--     minusculas + espacios internos convertidos a "_"); si el resultado no
--     es uno de los roles reconocidos, se asigna 'operador'.
--   - is_active queda en false si el usuario esta baneado (banned_until en
--     el futuro) o si user_metadata.estado = 'Inactivo'.
--   - permisos administrativos (can_manage_users, can_manage_invoices,
--     can_confirm_register_closings, can_confirm_treasury_closings,
--     can_reopen_closings, can_review_audit) van a TRUE solo para
--     administradora/administrador/propietaria/propietario.
--   - contador/contadora reciben can_review_accounts=true y
--     can_review_audit=true, pero NUNCA permisos administrativos.
--   - el flag canReviewAccounts que ya existiera en user_metadata se
--     conserva (se combina con OR junto al default de rol).
--   - operador, asistente_contable/asistenta_contable, y cualquier valor no
--     reconocido migrado a 'operador', no reciben ningun permiso
--     administrativo por defecto.
-- ON CONFLICT DO NOTHING: si esta migracion se vuelve a aplicar, nunca pisa
-- perfiles que ya existan ni ediciones manuales posteriores al backfill.
insert into public.erp_user_profiles (
  user_id, email, role, is_active,
  can_review_accounts, can_review_audit, can_submit_register_count,
  can_confirm_register_closings, can_confirm_treasury_closings,
  can_manage_users, can_manage_invoices, can_reopen_closings
)
select
  u.id,
  coalesce(u.email, ''),
  u.normalized_role,
  not (
    coalesce(u.raw_user_meta_data->>'estado', '') = 'Inactivo'
    or (u.banned_until is not null and u.banned_until > now())
  ),
  (u.normalized_role in ('contador', 'contadora'))
    or coalesce((u.raw_user_meta_data->>'canReviewAccounts')::boolean, false),
  u.normalized_role in ('administradora', 'administrador', 'propietaria', 'propietario', 'contador', 'contadora'),
  true,
  u.normalized_role in ('administradora', 'administrador', 'propietaria', 'propietario'),
  u.normalized_role in ('administradora', 'administrador', 'propietaria', 'propietario'),
  u.normalized_role in ('administradora', 'administrador', 'propietaria', 'propietario'),
  u.normalized_role in ('administradora', 'administrador', 'propietaria', 'propietario'),
  u.normalized_role in ('administradora', 'administrador', 'propietaria', 'propietario')
from (
  select
    au.id,
    au.email,
    au.raw_user_meta_data,
    au.banned_until,
    case
      when regexp_replace(lower(trim(coalesce(au.raw_user_meta_data ->> 'role', ''))), '\s+', '_', 'g') in (
        'operador', 'administradora', 'administrador', 'propietaria', 'propietario',
        'contador', 'contadora', 'asistente_contable', 'asistenta_contable'
      )
      then regexp_replace(lower(trim(coalesce(au.raw_user_meta_data ->> 'role', ''))), '\s+', '_', 'g')
      else 'operador'
    end as normalized_role
  from auth.users au
) u
on conflict (user_id) do nothing;

-- === Funciones SQL seguras ==================================================
-- Nunca aceptan user_id desde el navegador: siempre usan auth.uid(). No
-- exponen SELECT completo sobre erp_user_profiles a authenticated; son la
-- unica via de lectura del propio perfil para el cliente, y la base para
-- que futuras politicas RLS (de OTRAS tablas, p.ej. erp_audit_log en la
-- siguiente migracion) puedan preguntar "el usuario actual tiene tal
-- rol/permiso" sin necesitar acceso de lectura directo a esta tabla.

create or replace function public.current_erp_profile()
returns table (
  user_id uuid,
  email text,
  role text,
  is_active boolean,
  can_review_accounts boolean,
  can_review_audit boolean,
  can_submit_register_count boolean,
  can_confirm_register_closings boolean,
  can_confirm_treasury_closings boolean,
  can_manage_users boolean,
  can_manage_invoices boolean,
  can_reopen_closings boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select
    p.user_id, p.email, p.role, p.is_active,
    p.can_review_accounts, p.can_review_audit, p.can_submit_register_count,
    p.can_confirm_register_closings, p.can_confirm_treasury_closings,
    p.can_manage_users, p.can_manage_invoices, p.can_reopen_closings
  from public.erp_user_profiles p
  where p.user_id = auth.uid();
$$;

revoke all on function public.current_erp_profile() from public;
grant execute on function public.current_erp_profile() to authenticated;

create or replace function public.has_erp_role(role_keys text[])
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.erp_user_profiles p
    where p.user_id = auth.uid()
      and p.is_active
      and p.role = any(role_keys)
  );
$$;

revoke all on function public.has_erp_role(text[]) from public;
grant execute on function public.has_erp_role(text[]) to authenticated;

create or replace function public.has_erp_permission(permission_key text)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  result boolean;
begin
  select case permission_key
    when 'can_review_accounts' then p.can_review_accounts
    when 'can_review_audit' then p.can_review_audit
    when 'can_submit_register_count' then p.can_submit_register_count
    when 'can_confirm_register_closings' then p.can_confirm_register_closings
    when 'can_confirm_treasury_closings' then p.can_confirm_treasury_closings
    when 'can_manage_users' then p.can_manage_users
    when 'can_manage_invoices' then p.can_manage_invoices
    when 'can_reopen_closings' then p.can_reopen_closings
    else false
  end
  into result
  from public.erp_user_profiles p
  where p.user_id = auth.uid()
    and p.is_active;
  return coalesce(result, false);
end;
$$;

revoke all on function public.has_erp_permission(text) from public;
grant execute on function public.has_erp_permission(text) to authenticated;

-- === Salvaguarda contra bloqueo administrativo =============================
-- Si, despues del backfill, no queda NINGUN perfil activo con
-- can_manage_users=true, esta migracion aborta con RAISE EXCEPTION: eso
-- revierte TODA la transaccion (la creacion de la tabla, las funciones y el
-- backfill incluidos), porque Supabase CLI aplica cada archivo de migracion
-- como una sola transaccion. Es preferible que la migracion falle de forma
-- explicita a dejar el ERP sin ningun usuario capaz de administrar usuarios
-- despues de aplicarla.
--
-- A proposito NO se crea aqui ningun administrador de emergencia
-- automatico: si esto aborta, un humano debe revisar manualmente por que
-- ningun usuario existente califica (por ejemplo, ninguno tiene
-- administradora/administrador/propietaria/propietario en
-- raw_user_meta_data->>'role', o todos estan baneados/inactivos) antes de
-- reintentar la migracion.
do $$
declare
  active_admin_count integer;
begin
  select count(*) into active_admin_count
  from public.erp_user_profiles
  where is_active = true
    and can_manage_users = true;

  if active_admin_count = 0 then
    raise exception 'erp_user_profiles: no quedo ningun perfil activo con can_manage_users=true despues del backfill. Abortando toda la migracion (rollback) para no dejar el ERP sin administrador. Revisa manualmente los roles en auth.users antes de reintentar; esta migracion NO crea un administrador de emergencia automaticamente.';
  end if;
end
$$;

-- === Rollback documentado (NO se ejecuta como parte de esta migracion) =====
-- revoke execute on function public.has_erp_permission(text) from authenticated;
-- drop function if exists public.has_erp_permission(text);
-- revoke execute on function public.has_erp_role(text[]) from authenticated;
-- drop function if exists public.has_erp_role(text[]);
-- revoke execute on function public.current_erp_profile() from authenticated;
-- drop function if exists public.current_erp_profile();
-- drop trigger if exists erp_user_profiles_set_updated_at on public.erp_user_profiles;
-- drop table if exists public.erp_user_profiles;
-- (no se incluye DROP FUNCTION set_updated_at(): la sigue usando erp_records)
