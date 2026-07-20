-- Migracion: eliminar indice GIN sin uso sobre erp_records.data
-- Fecha: 2026-07-20
--
-- Contexto: erp_records_data_gin_idx (creado en supabase/schema.sql) indexa
-- el contenido del jsonb "data", pero ninguna consulta del repo filtra
-- dentro de esa columna: siempre se lee/escribe la unica fila por
-- table_name+record_key ("app"/"database"). Como cada guardado reescribe el
-- documento entero, ese indice se recalcula en cada UPSERT (cada 700ms
-- cuando hay cambios pendientes) sin aportar ningun beneficio de consulta,
-- solo costo de escritura y espacio en disco contra el limite gratuito de
-- Supabase (500MB).
--
-- Es idempotente (IF EXISTS). NO se ejecuto automaticamente como parte de
-- este cambio: debe aplicarse manualmente desde el SQL Editor de Supabase
-- cuando el equipo lo confirme.

drop index if exists erp_records_data_gin_idx;
