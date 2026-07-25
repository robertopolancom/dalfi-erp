-- Primer paso de la separacion gradual de permisos por dominio.
-- Solo cambia estructura y permisos; no modifica reservas ni otros datos ERP.

alter table public.erp_user_profiles
  add column if not exists can_manage_reservations boolean not null default false;

update public.erp_user_profiles
set can_manage_reservations = role in (
  'operador',
  'administradora', 'administrador',
  'propietaria', 'propietario'
)
where can_manage_reservations is distinct from (
  role in ('operador', 'administradora', 'administrador', 'propietaria', 'propietario')
);

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

comment on column public.erp_user_profiles.can_manage_reservations is
  'Permite crear y editar reservas. No concede permisos de facturacion.';
