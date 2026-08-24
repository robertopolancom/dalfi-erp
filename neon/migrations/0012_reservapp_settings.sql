begin;

-- Configuración de ReservApp editable desde el panel de administración (hoy solo el banner
-- promocional). key/value en vez de una columna por feature: el panel "Configuración de
-- usuarios" puede sumar ajustes nuevos sin otra migración.
create table if not exists app.reservapp_settings (
  key text primary key,
  value jsonb not null,
  updated_by_account_id uuid references app.reservapp_accounts(id) on delete set null,
  updated_at timestamptz not null default now()
);

commit;
