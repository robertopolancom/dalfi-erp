begin;

create table if not exists app.payment_processors (
 id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
 name text not null, processor_type text, commission_rate numeric(10,6) not null default 0,
 status text not null default 'active', legacy_payload jsonb not null default '{}'
);
create table if not exists app.expense_concepts (
 id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
 name text not null, category text, concept_type text, status text not null default 'active',
 legacy_payload jsonb not null default '{}'
);
create table if not exists app.payroll_discount_concepts (
 id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
 name text not null, status text not null default 'active', legacy_payload jsonb not null default '{}'
);
create table if not exists app.stations (
 id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
 name text not null, primary_staff_name text, status text not null default 'active',
 legacy_payload jsonb not null default '{}', created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists app.shifts (
 id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
 shift_date date not null, status text, confirmation_status text, closed_at timestamptz,
 closed_by text, automatic_close boolean not null default false, is_single boolean not null default false,
 legacy_payload jsonb not null default '{}', created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists app.station_assignments (
 id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
 station_id uuid references app.stations(id), shift_id uuid references app.shifts(id),
 staff_id uuid references app.staff(id), staff_name_snapshot text, status text,
 released_at timestamptz, legacy_payload jsonb not null default '{}',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists app.inventory_settings (
 id boolean primary key default true check(id), settings jsonb not null default '{}',
 updated_at timestamptz not null default now()
);
insert into app.inventory_settings(id) values(true) on conflict do nothing;

create or replace function migration.import_operational_catalogs(p_run_id uuid)
returns jsonb language plpgsql as $$
declare doc jsonb; result jsonb;
begin
 select payload into doc from migration.source_snapshots where import_run_id=p_run_id order by created_at desc limit 1;
 if jsonb_typeof(doc->'data')='object' then doc:=doc->'data'; end if;
 insert into app.payment_processors(legacy_id,name,processor_type,commission_rate,status,legacy_payload)
 select item->>'procesadorID',item->>'nombre',item->>'tipo',app.json_num(item,'comisionPorcentaje'),
 case when lower(coalesce(item->>'estado','Activo'))='activo' then 'active' else 'inactive' end,item
 from jsonb_array_elements(coalesce(doc->'procesadores','[]'))item
 on conflict(legacy_id) do update set name=excluded.name,commission_rate=excluded.commission_rate,legacy_payload=excluded.legacy_payload;
 insert into app.expense_concepts(legacy_id,name,category,concept_type,status,legacy_payload)
 select item->>'conceptoID',item->>'concepto',item->>'categoria',item->>'tipo',
 case when lower(coalesce(item->>'estado','Activo'))='activo' then 'active' else 'inactive' end,item
 from jsonb_array_elements(coalesce(doc->'conceptosEgresos','[]'))item
 on conflict(legacy_id) do update set name=excluded.name,legacy_payload=excluded.legacy_payload;
 insert into app.payroll_discount_concepts(legacy_id,name,status,legacy_payload)
 select item->>'conceptoID',item->>'concepto',case when lower(coalesce(item->>'estado','Activo'))='activo' then 'active' else 'inactive' end,item
 from jsonb_array_elements(coalesce(doc->'conceptosDescuentoNomina','[]'))item
 on conflict(legacy_id) do update set name=excluded.name,legacy_payload=excluded.legacy_payload;
 insert into app.stations(legacy_id,name,primary_staff_name,status,legacy_payload,created_at,updated_at)
 select item->>'stationId',item->>'nombre',item->>'colaboradoraPrincipal',coalesce(item->>'estado','Activo'),item,
 coalesce(nullif(item->>'fechaCreacion','')::timestamptz,now()),coalesce(nullif(item->>'fechaActualizacion','')::timestamptz,now())
 from jsonb_array_elements(coalesce(doc->'mesas','[]'))item
 on conflict(legacy_id) do update set name=excluded.name,status=excluded.status,legacy_payload=excluded.legacy_payload,updated_at=excluded.updated_at;
 insert into app.shifts(legacy_id,shift_date,status,confirmation_status,closed_at,closed_by,automatic_close,is_single,legacy_payload,created_at,updated_at)
 select item->>'turnoId',(item->>'fecha')::date,item->>'estado',item->>'estadoConfirmacion',nullif(item->>'fechaCierre','')::timestamptz,
 item->>'cerradoPor',coalesce((item->>'cierreAutomatico')::boolean,false),coalesce((item->>'esUnico')::boolean,false),item,
 coalesce(nullif(item->>'fechaCreacion','')::timestamptz,now()),coalesce(nullif(item->>'fechaActualizacion','')::timestamptz,now())
 from jsonb_array_elements(coalesce(doc->'turnos','[]'))item
 on conflict(legacy_id) do update set status=excluded.status,legacy_payload=excluded.legacy_payload,updated_at=excluded.updated_at;
 insert into app.station_assignments(legacy_id,station_id,shift_id,staff_id,staff_name_snapshot,status,released_at,legacy_payload,created_at,updated_at)
 select item->>'asignacionId',stn.id,sh.id,s.id,item->>'colaboradorNombre',item->>'estado',nullif(item->>'fechaLiberacion','')::timestamptz,item,
 coalesce(nullif(item->>'fechaCreacion','')::timestamptz,now()),coalesce(nullif(item->>'fechaActualizacion','')::timestamptz,now())
 from jsonb_array_elements(coalesce(doc->'asignacionesMesaTurno','[]'))item
 left join app.stations stn on stn.legacy_id=item->>'stationId'
 left join app.shifts sh on sh.legacy_id=item->>'turnoId'
 left join app.staff s on s.legacy_id=item->>'colaboradorId'
 on conflict(legacy_id) do update set status=excluded.status,legacy_payload=excluded.legacy_payload,updated_at=excluded.updated_at;
 update app.inventory_settings set settings=coalesce((doc->'configuracionInventario')->0,'{}'),updated_at=now() where id=true;
 result:=jsonb_build_object('paymentProcessors',(select count(*) from app.payment_processors),
 'expenseConcepts',(select count(*) from app.expense_concepts),'payrollDiscountConcepts',(select count(*) from app.payroll_discount_concepts),
 'stations',(select count(*) from app.stations),'shifts',(select count(*) from app.shifts),'stationAssignments',(select count(*) from app.station_assignments));
 update migration.import_runs set imported_counts=imported_counts||result where id=p_run_id;
 return result;
end $$;

commit;
