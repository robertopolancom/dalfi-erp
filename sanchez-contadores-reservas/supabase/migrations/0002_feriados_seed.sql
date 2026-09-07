-- 0002_feriados_seed.sql
-- Feriados nacionales de República Dominicana, 2026 y 2027.
--
-- FUENTE NORMATIVA: Ley No. 139-97 (G.O. 9957, 25 de junio de 1997), texto
-- literal de sus artículos 1 a 4. El listado se validó además contra el
-- anuncio oficial del Ministerio de Trabajo para 2026: los tres traslados
-- calculados aquí (5 de enero, 4 de mayo y 9 de noviembre de 2026) coinciden
-- con los publicados.
--
-- REGLA DE TRASLADO (Artículo 1)
--   Un feriado trasladable que cae en martes o miércoles se celebra el LUNES
--   PRECEDENTE; si cae en jueves o viernes, el LUNES SIGUIENTE. Si cae en
--   sábado, domingo o lunes NO se traslada.
--
-- FERIADOS QUE SÍ SE TRASLADAN (Artículo 4)
--   6 de enero      Día de los Santos Reyes
--   26 de enero     Natalicio de Juan Pablo Duarte
--   1 de mayo       Día del Trabajo
--   16 de agosto    Día de la Restauración
--   6 de noviembre  Día de la Constitución
--
-- FERIADOS QUE NO SE TRASLADAN (Artículo 2)
--   1 de enero      Año Nuevo
--   21 de enero     Nuestra Señora de la Altagracia
--   27 de febrero   Día de la Independencia Nacional
--   24 de septiembre Nuestra Señora de las Mercedes
--   25 de diciembre Navidad
--   16 de agosto    SOLO cuando coincide con el inicio de un período
--                   constitucional (año de toma de posesión presidencial);
--                   en los demás años es trasladable por el Artículo 4.
--
-- FERIADOS RELIGIOSOS TAMPOCO TRASLADABLES (Artículo 3)
--   Jueves Santo, Viernes Santo y Corpus Christi, porque su fecha ya se fija
--   en razón del día de la semana. Se derivan del Domingo de Pascua:
--   Viernes Santo = Pascua - 2 días; Corpus Christi = Pascua + 60 días.
--   NOTA: el Jueves Santo no aparece en el calendario de feriados no
--   laborables que publica el Ministerio de Trabajo, por lo que no se siembra.
--
-- PÁRRAFO DEL ARTÍCULO 4
--   Si el 1 de mayo cae en domingo, su carácter no laborable pasa al lunes
--   siguiente. No aplica en 2026 (viernes) ni en 2027 (sábado).
--
-- La contadora puede editar, agregar o eliminar filas de esta tabla desde el
-- panel de administración; el motor de días laborables lee siempre la tabla,
-- nunca estas constantes.

insert into feriados (fecha, nombre, trasladado, fecha_original) values
  ('2026-01-01', 'Año Nuevo', false, null),  -- jueves 2026-01-01
  ('2026-01-05', 'Día de los Santos Reyes', true, '2026-01-06'),  -- martes 2026-01-06 -> lunes (Art. 1)
  ('2026-01-21', 'Nuestra Señora de la Altagracia', false, null),  -- miércoles 2026-01-21
  ('2026-01-26', 'Natalicio de Juan Pablo Duarte', false, null),  -- lunes 2026-01-26
  ('2026-02-27', 'Día de la Independencia Nacional', false, null),  -- viernes 2026-02-27
  ('2026-04-03', 'Viernes Santo', false, null),  -- viernes 2026-04-03
  ('2026-05-04', 'Día del Trabajo', true, '2026-05-01'),  -- viernes 2026-05-01 -> lunes (Art. 1)
  ('2026-06-04', 'Corpus Christi', false, null),  -- jueves 2026-06-04
  ('2026-08-16', 'Día de la Restauración', false, null),  -- domingo 2026-08-16
  ('2026-09-24', 'Nuestra Señora de las Mercedes', false, null),  -- jueves 2026-09-24
  ('2026-11-09', 'Día de la Constitución', true, '2026-11-06'),  -- viernes 2026-11-06 -> lunes (Art. 1)
  ('2026-12-25', 'Navidad', false, null),  -- viernes 2026-12-25
  ('2027-01-01', 'Año Nuevo', false, null),  -- viernes 2027-01-01
  ('2027-01-04', 'Día de los Santos Reyes', true, '2027-01-06'),  -- miércoles 2027-01-06 -> lunes (Art. 1)
  ('2027-01-21', 'Nuestra Señora de la Altagracia', false, null),  -- jueves 2027-01-21
  ('2027-01-25', 'Natalicio de Juan Pablo Duarte', true, '2027-01-26'),  -- martes 2027-01-26 -> lunes (Art. 1)
  ('2027-02-27', 'Día de la Independencia Nacional', false, null),  -- sábado 2027-02-27
  ('2027-03-26', 'Viernes Santo', false, null),  -- viernes 2027-03-26
  ('2027-05-01', 'Día del Trabajo', false, null),  -- sábado 2027-05-01
  ('2027-05-27', 'Corpus Christi', false, null),  -- jueves 2027-05-27
  ('2027-08-16', 'Día de la Restauración', false, null),  -- lunes 2027-08-16
  ('2027-09-24', 'Nuestra Señora de las Mercedes', false, null),  -- viernes 2027-09-24
  ('2027-11-06', 'Día de la Constitución', false, null),  -- sábado 2027-11-06
  ('2027-12-25', 'Navidad', false, null)  -- sábado 2027-12-25
on conflict (fecha) do nothing;
