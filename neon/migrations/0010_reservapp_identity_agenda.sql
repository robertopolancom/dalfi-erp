begin;

create table if not exists app.reservapp_accounts (
  id uuid primary key default gen_random_uuid(),
  phone_normalized text not null unique,
  client_id uuid unique references app.clients(id) on delete cascade,
  staff_id uuid unique references app.staff(id) on delete cascade,
  role text not null check (role in ('clienta','manicurista','asistente','administradora','superadministrador')),
  password_hash text,
  status text not null default 'pending' check (status in ('pending','active','suspended')),
  verified_at timestamptz,
  last_login_at timestamptz,
  created_by_account_id uuid references app.reservapp_accounts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((role = 'clienta' and client_id is not null and staff_id is null)
      or (role <> 'clienta' and staff_id is not null and client_id is null))
);

create table if not exists app.reservapp_setup_tokens (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references app.reservapp_accounts(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists reservapp_setup_tokens_active_idx
  on app.reservapp_setup_tokens (account_id, expires_at desc)
  where consumed_at is null;

create table if not exists app.reservapp_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references app.reservapp_accounts(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists reservapp_sessions_active_idx
  on app.reservapp_sessions (account_id, expires_at desc)
  where revoked_at is null;

create table if not exists app.reservapp_booking_drafts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references app.reservapp_accounts(id) on delete cascade,
  service_ids uuid[] not null,
  staff_id uuid not null references app.staff(id),
  appointment_date date not null,
  appointment_time time not null,
  notes text,
  idempotency_key text not null unique,
  status text not null default 'pending_setup' check (status in ('pending_setup','ready','confirmed','expired','cancelled')),
  appointment_id uuid references app.appointments(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(service_ids) > 0)
);

create table if not exists app.reservapp_whatsapp_outbox (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references app.reservapp_accounts(id) on delete cascade,
  recipient_phone text not null,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','sent','failed','cancelled')),
  attempt_count integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists reservapp_whatsapp_outbox_pending_idx
  on app.reservapp_whatsapp_outbox (created_at)
  where status = 'pending';

commit;
