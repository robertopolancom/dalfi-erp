begin;

-- Transitional persistence contract for the existing SPA. The normalized
-- tables remain available for the new booking API, while this singleton keeps
-- the legacy document working during the gradual frontend migration.
create table if not exists app.erp_document (
  id boolean primary key default true check (id),
  document jsonb not null,
  source_updated_at timestamptz,
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default clock_timestamp()
);

insert into app.erp_document (id, document, source_updated_at)
select
  true,
  snapshot.payload,
  snapshot.source_updated_at
from migration.source_snapshots snapshot
join migration.import_runs run on run.id = snapshot.import_run_id
where snapshot.source_table = 'app'
  and snapshot.source_key = 'database'
  and run.status in ('completed', 'reconciled')
order by coalesce(run.finished_at, run.started_at) desc
limit 1
on conflict (id) do nothing;

create table if not exists app.api_audit_log (
  id bigint generated always as identity primary key,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  actor_user_id text,
  actor_email text,
  actor_role text,
  changes jsonb not null default '{}'::jsonb,
  success boolean not null default true,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists api_audit_log_created_at_idx
  on app.api_audit_log (created_at desc);

commit;
