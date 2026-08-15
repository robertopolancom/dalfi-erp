begin;

create table if not exists migration.legacy_records (
  id bigint generated always as identity primary key,
  import_run_id uuid not null references migration.import_runs(id),
  collection_name text not null,
  source_ordinal integer not null check (source_ordinal > 0),
  source_key text,
  payload jsonb not null,
  payload_sha256 text not null,
  created_at timestamptz not null default now(),
  unique (import_run_id, collection_name, source_ordinal)
);

create index if not exists legacy_records_collection_key_idx
  on migration.legacy_records (collection_name, source_key);

create or replace function migration.import_all_legacy_records(p_run_id uuid)
returns jsonb
language plpgsql
as $$
declare
  doc jsonb;
  imported_count bigint;
  collection_count bigint;
begin
  select payload into doc
  from migration.source_snapshots
  where import_run_id=p_run_id
  order by created_at desc limit 1;
  if doc is null then raise exception 'Snapshot not found for import run %',p_run_id; end if;
  if jsonb_typeof(doc->'data')='object' then doc:=doc->'data'; end if;

  delete from migration.legacy_records where import_run_id=p_run_id;

  insert into migration.legacy_records (
    import_run_id, collection_name, source_ordinal, source_key, payload, payload_sha256
  )
  select p_run_id, collection.key, element.ordinality::integer,
    coalesce(
      element.value->>'clienteID', element.value->>'colaboradorID',
      element.value->>'servicioID', element.value->>'reservaID',
      element.value->>'facturaID', element.value->>'detalleID',
      element.value->>'pagoID', element.value->>'ingresoID',
      element.value->>'aplicacionID', element.value->>'cxCID',
      element.value->>'cxPID', element.value->>'cierreID',
      element.value->>'propinaID', element.value->>'nominaID',
      element.value->>'cuentaID', element.value->>'procesadorID',
      element.value->>'conceptoID', element.value->>'itemID',
      element.value->>'movementId', element.value->>'movimientoID',
      element.value->>'locationId', element.value->>'stationId',
      element.value->>'turnoId', element.value->>'asignacionId',
      element.value->>'id'
    ),
    element.value,
    encode(digest(convert_to(element.value::text,'UTF8'),'sha256'),'hex')
  from jsonb_each(doc) collection
  cross join lateral jsonb_array_elements(collection.value)
    with ordinality element(value,ordinality)
  where jsonb_typeof(collection.value)='array';

  select count(*),count(distinct collection_name)
  into imported_count,collection_count
  from migration.legacy_records where import_run_id=p_run_id;

  return jsonb_build_object('records',imported_count,'collections',collection_count);
end
$$;

commit;
