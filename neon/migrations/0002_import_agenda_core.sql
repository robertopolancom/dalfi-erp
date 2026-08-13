begin;

create or replace function app.normalize_phone(value text)
returns text
language sql
immutable
strict
as $$
  select case
    when length(regexp_replace(value, '[^0-9]', '', 'g')) = 10
      then '1' || regexp_replace(value, '[^0-9]', '', 'g')
    else regexp_replace(value, '[^0-9]', '', 'g')
  end
$$;

create or replace function migration.import_agenda_core(p_run_id uuid)
returns jsonb
language plpgsql
as $$
declare
  doc jsonb;
  counts jsonb;
begin
  select payload into doc
  from migration.source_snapshots
  where import_run_id = p_run_id
  order by created_at desc
  limit 1;

  if doc is null then
    raise exception 'Snapshot not found for import run %', p_run_id;
  end if;
  if jsonb_typeof(doc->'data') = 'object' then doc := doc->'data'; end if;

  insert into app.clients (
    legacy_id, full_name, first_name, last_name, email, birth_date, sex,
    address, preferred_service, status, needs_review, registration_source,
    notes, legacy_payload, created_at, updated_at
  )
  select
    item->>'clienteID',
    coalesce(nullif(item->>'nombreCompleto',''), trim(concat(item->>'nombre',' ',item->>'apellido')), 'Cliente'),
    nullif(item->>'nombre',''), nullif(item->>'apellido',''),
    nullif(lower(trim(item->>'correo')),''),
    nullif(item->>'fechaNacimiento','')::date,
    nullif(item->>'sexo',''), nullif(item->>'direccion',''),
    nullif(item->>'servicioInteres',''),
    case when lower(coalesce(item->>'estado','Activo')) = 'activo' then 'active' else 'inactive' end,
    coalesce((item->>'needsReview')::boolean,false),
    nullif(item->>'origenRegistro',''), nullif(item->>'observaciones',''), item,
    coalesce(nullif(item->>'created_at','')::timestamptz,
             nullif(item->>'fechaCreacion','')::timestamptz,
             nullif(item->>'fechaRegistro','')::timestamptz, now()),
    coalesce(nullif(item->>'updated_at','')::timestamptz,
             nullif(item->>'fechaActualizacion','')::timestamptz, now())
  from jsonb_array_elements(coalesce(doc->'clientes','[]')) item
  on conflict (legacy_id) do update set
    full_name=excluded.full_name, email=excluded.email,
    legacy_payload=excluded.legacy_payload, updated_at=excluded.updated_at;

  insert into app.client_phones (
    client_id, phone_original, phone_normalized, label, source, is_primary
  )
  select c.id, item->>'telefono', app.normalize_phone(item->>'telefono'),
         'Principal', coalesce(item->>'origenRegistro','ERP'), true
  from jsonb_array_elements(coalesce(doc->'clientes','[]')) item
  join app.clients c on c.legacy_id=item->>'clienteID'
  where nullif(app.normalize_phone(item->>'telefono'),'') is not null
  on conflict (phone_normalized) do update set label=excluded.label;

  insert into app.client_phones (
    client_id, phone_original, phone_normalized, label, source, is_primary
  )
  select c.id, coalesce(line->>'phone',line->>'telefono'),
         app.normalize_phone(coalesce(line->>'phone',line->>'telefono')),
         coalesce(line->>'name',line->>'nombre','Secundario'),
         coalesce(line->>'source','ERP'), false
  from jsonb_array_elements(coalesce(doc->'clientes','[]')) item
  join app.clients c on c.legacy_id=item->>'clienteID'
  cross join lateral jsonb_array_elements(coalesce(item->'lineasContactoVinculadas','[]')) line
  where nullif(app.normalize_phone(coalesce(line->>'phone',line->>'telefono')),'') is not null
  on conflict (phone_normalized) do update set label=excluded.label;

  insert into app.staff (
    legacy_id, full_name, first_name, last_name, role_name, phone, email,
    address, monthly_salary, calendar_color_id, status, hired_on, legacy_payload
  )
  select item->>'colaboradorID', coalesce(item->>'nombreCompleto',item->>'nombre'),
         item->>'nombre', item->>'apellido', item->>'funcion', item->>'telefono',
         item->>'correo', item->>'direccion', coalesce((item->>'salarioMensual')::numeric,0),
         item->>'googleCalendarColorId',
         case when lower(coalesce(item->>'estado','Activo'))='activo' then 'active' else 'inactive' end,
         nullif(item->>'fechaIngreso','')::date, item
  from jsonb_array_elements(coalesce(doc->'colaboradores','[]')) item
  on conflict (legacy_id) do update set
    full_name=excluded.full_name, legacy_payload=excluded.legacy_payload;

  insert into app.services (
    legacy_id, name, category, base_price, duration_minutes, status, legacy_payload
  )
  select item->>'servicioID', item->>'servicio', item->>'categoria',
         coalesce((item->>'precioBase')::numeric,0),
         greatest(coalesce((item->>'duracionMin')::integer,30),1),
         case when lower(coalesce(item->>'estado','Activo'))='activo' then 'active' else 'inactive' end,
         item
  from jsonb_array_elements(coalesce(doc->'servicios','[]')) item
  on conflict (legacy_id) do update set
    name=excluded.name, base_price=excluded.base_price,
    duration_minutes=excluded.duration_minutes, legacy_payload=excluded.legacy_payload;

  update app.business_settings
  set timezone=coalesce(doc->'businessSchedule'->>'timezone','America/Santo_Domingo'),
      settings=coalesce(doc->'businessSchedule','{}'), updated_at=now()
  where id=true;

  insert into app.appointments (
    legacy_id, idempotency_key, client_id, staff_id, starts_at, ends_at, status,
    confirmation_status, deposit_status, deposit_amount, source_channel,
    source_conversation_id, provisional_client, global_block,
    google_calendar_event_id, invoice_legacy_id, notes, legacy_payload,
    created_at, updated_at
  )
  select
    item->>'reservaID', nullif(item->>'idempotencyKey',''), c.id, s.id,
    ((item->>'fecha')::date + (item->>'hora')::time) at time zone 'America/Santo_Domingo',
    ((item->>'fecha')::date + coalesce(nullif(item->>'horaFin','')::time,
      (item->>'hora')::time + make_interval(mins=>coalesce((item->>'duracionMin')::integer,30))))
      at time zone 'America/Santo_Domingo',
    case
      when lower(coalesce(item->>'estado','')) in ('cancelada','cancelado','anulada','anulado') then 'cancelled'
      when lower(coalesce(item->>'estado',''))='reemplazada' then 'replaced'
      when lower(coalesce(item->>'estado','')) like '%confirm%' then 'confirmed'
      when lower(coalesce(item->>'estado','')) like '%complet%' then 'completed'
      else 'scheduled'
    end,
    nullif(item->>'estadoConfirmacion',''), nullif(item->>'estadoDeposito',''),
    coalesce((item->>'montoDeposito')::numeric,0), nullif(item->>'canalOrigen',''),
    nullif(item->>'sourceConversationId',''),
    coalesce((item->>'clienteProvisional')::boolean,false),
    coalesce((item->>'bloqueoGlobal')::boolean,false),
    nullif(item->>'googleCalendarEventId',''), nullif(item->>'facturaID',''),
    nullif(item->>'observaciones',''), item,
    coalesce(nullif(item->>'created_at','')::timestamptz,now()),
    coalesce(nullif(item->>'updated_at','')::timestamptz,now())
  from jsonb_array_elements(coalesce(doc->'reservas','[]')) item
  left join app.clients c on c.legacy_id=item->>'clienteID'
  left join app.staff s on s.legacy_id=item->>'colaboradorID'
  on conflict (legacy_id) do update set
    starts_at=excluded.starts_at, ends_at=excluded.ends_at,
    status=excluded.status, legacy_payload=excluded.legacy_payload,
    updated_at=excluded.updated_at;

  delete from app.appointment_services x
  using app.appointments a
  where x.appointment_id=a.id
    and a.legacy_id in (select item->>'reservaID' from jsonb_array_elements(coalesce(doc->'reservas','[]')) item);

  insert into app.appointment_services (
    appointment_id, service_id, legacy_service_id, service_name_snapshot,
    duration_minutes, position
  )
  select a.id, s.id, line->>'servicioID',
         coalesce(line->>'servicio', item->>'servicio', 'Servicio'),
         greatest(coalesce((line->>'duracionMin')::integer,(item->>'duracionMin')::integer,30),1),
         line_data.ordinality::integer
  from jsonb_array_elements(coalesce(doc->'reservas','[]')) item
  join app.appointments a on a.legacy_id=item->>'reservaID'
  cross join lateral jsonb_array_elements(
    case when jsonb_array_length(coalesce(item->'servicios','[]')) > 0
      then item->'servicios'
      else jsonb_build_array(jsonb_build_object(
        'servicioID',item->>'servicioID','servicio',item->>'servicio',
        'duracionMin',item->>'duracionMin')) end
  ) with ordinality as line_data(line, ordinality)
  left join app.services s on s.legacy_id=line->>'servicioID';

  counts := jsonb_build_object(
    'clients',(select count(*) from app.clients),
    'clientPhones',(select count(*) from app.client_phones),
    'staff',(select count(*) from app.staff),
    'services',(select count(*) from app.services),
    'appointments',(select count(*) from app.appointments),
    'appointmentServices',(select count(*) from app.appointment_services)
  );
  update migration.import_runs
  set status='completed', finished_at=now(), imported_counts=counts
  where id=p_run_id;
  return counts;
exception when others then
  update migration.import_runs
  set status='failed', finished_at=now(), error_message=sqlerrm
  where id=p_run_id;
  raise;
end
$$;

commit;
