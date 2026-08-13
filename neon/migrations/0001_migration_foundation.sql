begin;

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create schema if not exists migration;
create schema if not exists app;

create table if not exists migration.import_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_updated_at timestamptz,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','completed','failed','reconciled')),
  source_counts jsonb not null default '{}'::jsonb,
  imported_counts jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  error_message text
);

create table if not exists migration.source_snapshots (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references migration.import_runs(id),
  source_table text not null,
  source_key text not null,
  source_updated_at timestamptz,
  payload jsonb not null,
  payload_sha256 text not null,
  created_at timestamptz not null default now(),
  unique (source_table, source_key, payload_sha256)
);

create table if not exists app.clients (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  full_name text not null,
  first_name text,
  last_name text,
  email text,
  birth_date date,
  sex text,
  address text,
  preferred_service text,
  status text not null default 'active',
  needs_review boolean not null default false,
  registration_source text,
  notes text,
  legacy_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists clients_email_unique
  on app.clients (lower(email)) where email is not null and btrim(email) <> '';
create index if not exists clients_name_search on app.clients (lower(full_name));

create table if not exists app.client_phones (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references app.clients(id) on delete cascade,
  phone_original text not null,
  phone_normalized text not null,
  label text,
  source text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (phone_normalized)
);

create unique index if not exists one_primary_phone_per_client
  on app.client_phones (client_id) where is_primary;

create table if not exists app.staff (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  full_name text not null,
  first_name text,
  last_name text,
  role_name text,
  phone text,
  email text,
  address text,
  monthly_salary numeric(14,2),
  calendar_color_id text,
  status text not null default 'active',
  hired_on date,
  legacy_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app.services (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  name text not null,
  category text,
  base_price numeric(14,2) not null default 0 check (base_price >= 0),
  duration_minutes integer not null check (duration_minutes > 0),
  status text not null default 'active',
  legacy_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists services_name_unique on app.services (lower(name));

create table if not exists app.staff_services (
  staff_id uuid not null references app.staff(id) on delete cascade,
  service_id uuid not null references app.services(id) on delete cascade,
  primary key (staff_id, service_id)
);

create table if not exists app.business_settings (
  id boolean primary key default true check (id),
  timezone text not null default 'America/Santo_Domingo',
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists app.staff_weekly_schedules (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  staff_id uuid not null references app.staff(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  active boolean not null default true,
  legacy_payload jsonb not null default '{}'::jsonb,
  check (end_time > start_time)
);

create table if not exists app.staff_schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  staff_id uuid references app.staff(id) on delete cascade,
  exception_date date not null,
  start_time time,
  end_time time,
  available boolean not null default false,
  reason text,
  legacy_payload jsonb not null default '{}'::jsonb,
  check ((start_time is null and end_time is null) or end_time > start_time)
);

create table if not exists app.appointments (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  idempotency_key text unique,
  client_id uuid references app.clients(id),
  staff_id uuid references app.staff(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled',
  confirmation_status text,
  deposit_status text,
  deposit_amount numeric(14,2) not null default 0 check (deposit_amount >= 0),
  source_channel text,
  source_conversation_id text,
  provisional_client boolean not null default false,
  global_block boolean not null default false,
  google_calendar_event_id text,
  invoice_legacy_id text,
  notes text,
  legacy_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index if not exists appointments_start_idx on app.appointments (starts_at);
create index if not exists appointments_client_idx on app.appointments (client_id, starts_at desc);
create index if not exists appointments_staff_idx on app.appointments (staff_id, starts_at);

alter table app.appointments
  drop constraint if exists appointments_no_staff_overlap;
alter table app.appointments
  add constraint appointments_no_staff_overlap
  exclude using gist (
    staff_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (staff_id is not null and status not in ('cancelled','replaced'));

create table if not exists app.appointment_services (
  appointment_id uuid not null references app.appointments(id) on delete cascade,
  service_id uuid references app.services(id),
  legacy_service_id text,
  service_name_snapshot text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  price_snapshot numeric(14,2),
  position integer not null default 1 check (position > 0),
  primary key (appointment_id, position)
);

create table if not exists app.appointment_status_history (
  id bigint generated always as identity primary key,
  appointment_id uuid not null references app.appointments(id) on delete cascade,
  previous_status text,
  next_status text not null,
  changed_by text,
  reason text,
  created_at timestamptz not null default now()
);

insert into app.business_settings (id, timezone, settings)
values (true, 'America/Santo_Domingo', '{}'::jsonb)
on conflict (id) do nothing;

commit;
