begin;

create table if not exists app.booking_audit_log (
  id bigint generated always as identity primary key,
  action text not null,
  actor_type text not null check (actor_type in ('customer','employee','system')),
  actor_user_id text,
  client_id uuid references app.clients(id) on delete set null,
  appointment_id uuid references app.appointments(id) on delete set null,
  source_ip_hash text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists booking_audit_created_idx on app.booking_audit_log (created_at desc);
create index if not exists appointments_availability_idx
  on app.appointments (staff_id, starts_at, ends_at)
  where status not in ('cancelled','replaced');

commit;
