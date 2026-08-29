begin;

-- Hasta ahora, POST /api/reservapp/auth/request-setup escribía la ficha nueva en app.clients y
-- la cuenta nueva en app.reservapp_accounts en el instante en que alguien enviaba el formulario
-- "Es mi primera vez" -- antes de verificar el teléfono por WhatsApp o de poner una contraseña.
-- Si abandonaba ahí, quedaba una ficha fantasma en la ERP y una cuenta sin contraseña en
-- ReservApp. Esta tabla guarda esos datos aparte mientras se espera la contraseña -- nada toca
-- app.clients ni app.reservapp_accounts hasta que la persona de verdad la confirma (ver
-- server/store.mjs: createPendingRegistration / verifyPendingRegistrationOtp /
-- completePendingRegistration). Si abandona el formulario, esta fila simplemente expira sola.
--
-- existing_client_id: cuando el teléfono ya corresponde a una ficha conocida del salón (creada
-- en la ERP, por el personal, o en una visita anterior) -- se enlaza a ella tal cual, sin volver
-- a pedir sus datos. registration: cuando es de verdad una persona nueva, sus datos del
-- formulario, para crear la ficha recién al confirmar. Exactamente uno de los dos debe venir.
create table if not exists app.reservapp_pending_registrations (
  id uuid primary key default gen_random_uuid(),
  phone_normalized text not null,
  phone_original text not null,
  existing_client_id uuid references app.clients(id) on delete cascade,
  registration jsonb,
  draft jsonb,
  token_hash text not null unique,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  otp_verified_at timestamptz,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((existing_client_id is not null) or (registration is not null))
);

create index if not exists reservapp_pending_registrations_phone_idx
  on app.reservapp_pending_registrations (phone_normalized)
  where consumed_at is null;

commit;
