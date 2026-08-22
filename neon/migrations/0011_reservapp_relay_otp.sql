begin;

-- Código corto (6 dígitos) que una clienta nueva recibe por WhatsApp cuando
-- una MANICURISTA intenta registrarla para agendarle una cita. La clienta
-- lee el código en voz alta y la manicurista lo teclea para confirmar que
-- controla ese teléfono, antes de que se cree la ficha en app.clients.
--
-- No reemplaza reservapp_setup_tokens (ese sigue siendo el enlace mágico de
-- autorregistro cuando la clienta se registra ella misma, sin staff de por
-- medio). Este es exclusivamente el mecanismo de "relay" para asistencia de
-- terceros por manicurista.
create table if not exists app.reservapp_relay_otps (
  id uuid primary key default gen_random_uuid(),
  requested_by_account_id uuid not null references app.reservapp_accounts(id) on delete cascade,
  phone_normalized text not null,
  first_name text not null,
  last_name text,
  email text,
  code_hash text not null,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_client_id uuid references app.clients(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists reservapp_relay_otps_active_idx
  on app.reservapp_relay_otps (phone_normalized, expires_at desc)
  where consumed_at is null;

create index if not exists reservapp_relay_otps_requester_idx
  on app.reservapp_relay_otps (requested_by_account_id, created_at desc);

commit;
