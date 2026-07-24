-- Evita que dos sesiones sobrescriban silenciosamente el documento ERP.
--
-- Cada escritor debe enviar el updated_at que leyo junto con el documento.
-- La actualizacion solo ocurre si esa version sigue siendo la vigente. Si
-- otra sesion guardo primero, se devuelve conflict=true sin modificar datos.

create or replace function public.save_erp_record_if_current(
  p_table_name text,
  p_record_key text,
  p_data jsonb,
  p_expected_updated_at timestamptz
)
returns table (
  saved boolean,
  conflict boolean,
  new_updated_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_updated_at timestamptz;
begin
  if p_table_name is null or p_record_key is null or p_data is null then
    raise exception 'table_name, record_key y data son obligatorios';
  end if;

  -- Inicializacion segura: solo crea la fila si todavia no existe. Nunca
  -- convierte expected=null en un upsert que pueda pisar datos existentes.
  if p_expected_updated_at is null then
    insert into public.erp_records (table_name, record_key, data)
    values (p_table_name, p_record_key, p_data)
    on conflict (table_name, record_key) do nothing
    returning updated_at into v_updated_at;

    if found then
      return query select true, false, v_updated_at;
      return;
    end if;
  else
    update public.erp_records as record
    set data = p_data
    where record.table_name = p_table_name
      and record.record_key = p_record_key
      and record.updated_at = p_expected_updated_at
    returning record.updated_at into v_updated_at;

    if found then
      return query select true, false, v_updated_at;
      return;
    end if;
  end if;

  select record.updated_at
  into v_updated_at
  from public.erp_records as record
  where record.table_name = p_table_name
    and record.record_key = p_record_key;

  return query select false, true, v_updated_at;
end;
$$;

revoke all on function public.save_erp_record_if_current(text, text, jsonb, timestamptz) from public;
revoke all on function public.save_erp_record_if_current(text, text, jsonb, timestamptz) from anon;
grant execute on function public.save_erp_record_if_current(text, text, jsonb, timestamptz) to authenticated;
grant execute on function public.save_erp_record_if_current(text, text, jsonb, timestamptz) to service_role;

comment on function public.save_erp_record_if_current(text, text, jsonb, timestamptz) is
  'Guardado optimista del documento ERP: compara updated_at y nunca sobrescribe una version mas reciente.';
