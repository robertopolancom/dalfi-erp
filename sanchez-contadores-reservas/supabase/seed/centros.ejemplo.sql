-- Plantilla para cargar de golpe la lista inicial de centros educativos.
--
-- Sustituye estas filas por las reales antes de ejecutarlo. La contadora puede
-- luego editar cada centro desde el panel; este archivo solo evita teclear la
-- lista completa a mano la primera vez.
--
--   psql "$SUPABASE_DB_URL" -f supabase/seed/centros.ejemplo.sql

insert into centros (nombre, correo_contacto, telefono, duracion_dias_laborables) values
  ('Colegio Ejemplo Uno',  'direccion@ejemplo1.edu.do', '809-000-0001', 5),
  ('Colegio Ejemplo Dos',  'direccion@ejemplo2.edu.do', '809-000-0002', 5),
  ('Politécnico Ejemplo',  'direccion@ejemplo3.edu.do', '809-000-0003', 8)
on conflict (nombre) do nothing;
