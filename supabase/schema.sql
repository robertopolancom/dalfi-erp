-- Esquema inicial Supabase para Dalfi Studio Nail & Academy ERP
-- Fase base: tablas flexibles compatibles con el database.json actual.
-- En una fase posterior se pueden normalizar más columnas y relaciones.

create extension if not exists "pgcrypto";

create table if not exists erp_records (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  record_key text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (table_name, record_key)
);

create index if not exists erp_records_table_name_idx on erp_records (table_name);
-- No hay indice GIN sobre "data": esta tabla siempre se lee/escribe por la
-- fila unica (table_name, record_key), nunca filtrando dentro del jsonb, asi
-- que ese indice solo agregaria costo de escritura sin beneficio de
-- consulta (ver supabase/migrations/2026-07-20_drop_unused_gin_index.sql).

create table if not exists erp_audit_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  record_key text,
  action text not null,
  old_data jsonb,
  new_data jsonb,
  user_id uuid,
  created_at timestamptz not null default now()
);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists erp_records_set_updated_at on erp_records;
create trigger erp_records_set_updated_at
before update on erp_records
for each row
execute function set_updated_at();

alter table erp_records enable row level security;
alter table erp_audit_log enable row level security;

-- Politicas iniciales para desarrollo.
-- Antes de producción real se deben endurecer por roles.
drop policy if exists "erp_records_authenticated_read" on erp_records;
create policy "erp_records_authenticated_read"
on erp_records for select
to authenticated
using (true);

drop policy if exists "erp_records_authenticated_write" on erp_records;
create policy "erp_records_authenticated_write"
on erp_records for all
to authenticated
using (true)
with check (true);

drop policy if exists "erp_audit_log_authenticated_read" on erp_audit_log;
create policy "erp_audit_log_authenticated_read"
on erp_audit_log for select
to authenticated
using (true);

drop policy if exists "erp_audit_log_authenticated_insert" on erp_audit_log;
create policy "erp_audit_log_authenticated_insert"
on erp_audit_log for insert
to authenticated
with check (true);
