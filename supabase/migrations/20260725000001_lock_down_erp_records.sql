-- Migracion: cerrar acceso directo al documento principal erp_records
-- Fecha: 2026-07-25
--
-- PRECONDICION DE DESPLIEGUE:
--   La version de Pages que contiene functions/api/database.js debe estar
--   publicada y verificada ANTES de aplicar esta migracion. Esa funcion
--   revalida JWT + erp_user_profiles, autoriza los cambios por dominio y usa
--   service_role para leer/guardar. La SPA ya no consulta erp_records ni
--   invoca save_erp_record_if_current directamente.
--
-- Esta migracion no modifica datos. Solo elimina policies/grants directos de
-- anon/authenticated. service_role conserva sus privilegios y bypass de RLS,
-- por lo que /api/database y el Worker de cierres siguen operando.

alter table public.erp_records enable row level security;

drop policy if exists "erp_records_authenticated_read" on public.erp_records;
drop policy if exists "erp_records_authenticated_write" on public.erp_records;

revoke select, insert, update, delete, truncate, references, trigger
on table public.erp_records
from anon, authenticated;

revoke all
on function public.save_erp_record_if_current(text, text, jsonb, timestamptz)
from public, anon, authenticated;

grant select, insert, update, delete
on table public.erp_records
to service_role;

grant execute
on function public.save_erp_record_if_current(text, text, jsonb, timestamptz)
to service_role;

comment on table public.erp_records is
  'Documento principal de SeBen Service. Acceso directo bloqueado para anon/authenticated; lectura y escritura exclusivamente mediante Cloudflare Pages Functions con service_role, JWT, perfil activo, autorizacion por dominio y control optimista.';

comment on function public.save_erp_record_if_current(text, text, jsonb, timestamptz) is
  'Guardado optimista interno. EXECUTE exclusivo de service_role; el navegador debe usar /api/database.';

-- === Verificacion posterior (documentada; NO se ejecuta aqui) =============
-- 1. Como anon/authenticated, SELECT/UPDATE directo a erp_records debe fallar.
-- 2. Como authenticated, RPC save_erp_record_if_current debe fallar.
-- 3. /api/database GET/PUT debe funcionar para perfiles activos autorizados.
-- 4. El Worker debe conservar acceso mediante SUPABASE_SERVICE_ROLE_KEY.
--
-- === Rollback documentado (NO se ejecuta como parte de esta migracion) =====
-- grant select, insert, update, delete on table public.erp_records to authenticated;
-- create policy "erp_records_authenticated_read"
--   on public.erp_records for select to authenticated using (true);
-- create policy "erp_records_authenticated_write"
--   on public.erp_records for all to authenticated using (true) with check (true);
-- grant execute
--   on function public.save_erp_record_if_current(text, text, jsonb, timestamptz)
--   to authenticated;
