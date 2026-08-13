begin;

alter table app.income_applications alter column receivable_id drop not null;
alter table app.income_applications add column if not exists receivable_legacy_id text;
create index if not exists income_applications_receivable_legacy_idx
  on app.income_applications(receivable_legacy_id);

create or replace function migration.import_historical_income_applications(p_run_id uuid)
returns bigint language plpgsql as $$
declare doc jsonb; imported bigint;
begin
  select payload into doc from migration.source_snapshots
  where import_run_id=p_run_id order by created_at desc limit 1;
  if jsonb_typeof(doc->'data')='object' then doc:=doc->'data'; end if;

  insert into app.income_applications(
    legacy_id,income_id,receivable_id,receivable_legacy_id,invoice_id,payment_id,
    amount,notes,legacy_payload,created_at,updated_at)
  select item->>'aplicacionID',inc.id,r.id,item->>'cxCID',i.id,p.id,
    app.json_num(item,'montoAplicado'),item->>'observaciones',item,
    coalesce(nullif(item->>'fechaCreacion','')::timestamptz,now()),
    coalesce(nullif(item->>'fechaActualizacion','')::timestamptz,now())
  from jsonb_array_elements(coalesce(doc->'ingresoAplicaciones','[]')) item
  join app.income inc on inc.legacy_id=item->>'ingresoID'
  left join app.receivables r on r.legacy_id=item->>'cxCID'
  left join app.invoices i on i.legacy_id=item->>'facturaID'
  left join app.payments p on p.legacy_id=item->>'pagoID'
  on conflict(legacy_id) do update set amount=excluded.amount,
    receivable_id=excluded.receivable_id,receivable_legacy_id=excluded.receivable_legacy_id,
    legacy_payload=excluded.legacy_payload,updated_at=excluded.updated_at;

  select count(*) into imported from app.income_applications;
  update migration.import_runs set imported_counts=imported_counts||
    jsonb_build_object('incomeApplications',imported) where id=p_run_id;
  return imported;
end $$;

commit;
