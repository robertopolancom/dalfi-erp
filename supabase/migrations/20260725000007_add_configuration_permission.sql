-- Sexto paso de la separacion gradual de permisos por dominio.
-- La administracion de usuarios por API conserva ademas can_manage_users.

alter table public.erp_user_profiles
  add column if not exists can_manage_configuration boolean not null default false;

update public.erp_user_profiles
set can_manage_configuration = can_manage_invoices
where can_manage_configuration is distinct from can_manage_invoices;

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
    when 'can_manage_reservations' then p.can_manage_reservations
    when 'can_manage_billing' then p.can_manage_billing
    when 'can_manage_inventory' then p.can_manage_inventory
    when 'can_manage_payroll' then p.can_manage_payroll
    when 'can_manage_accounts' then p.can_manage_accounts
    when 'can_manage_configuration' then p.can_manage_configuration
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

comment on column public.erp_user_profiles.can_manage_configuration is
  'Permite modificar catalogos y configuracion general; administrar Auth sigue requiriendo can_manage_users.';

-- current_erp_profile() conservaba la firma original de ocho permisos. Como
-- PostgreSQL no permite cambiar el tipo de retorno con CREATE OR REPLACE, se
-- reemplaza explícitamente. No hay políticas ni funciones que dependan de
-- esta RPC; la SPA usa /api/me, pero mantenerla completa evita una matriz
-- distinta para consumidores SQL futuros.
drop function if exists public.current_erp_profile();

create function public.current_erp_profile()
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
  can_reopen_closings boolean,
  can_manage_reservations boolean,
  can_manage_billing boolean,
  can_manage_inventory boolean,
  can_manage_payroll boolean,
  can_manage_accounts boolean,
  can_manage_configuration boolean
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
    p.can_manage_users, p.can_manage_invoices, p.can_reopen_closings,
    p.can_manage_reservations, p.can_manage_billing, p.can_manage_inventory,
    p.can_manage_payroll, p.can_manage_accounts, p.can_manage_configuration
  from public.erp_user_profiles p
  where p.user_id = auth.uid();
$$;

revoke all on function public.current_erp_profile() from public;
grant execute on function public.current_erp_profile() to authenticated;
