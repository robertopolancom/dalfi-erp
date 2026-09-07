-- Regenera src/domain/__tests__/disponibilidad-2027.fixture.json a partir de la
-- vista real, para que las pruebas del espejo en cliente usen exactamente los
-- días laborables que calcula el servidor.
--
--   psql "$PGURL" -qtAX -f neon/tests/exportar_fixture.sql \
--     > src/domain/__tests__/disponibilidad-2027.fixture.json
select json_build_object(
  'generado_por', 'psql -f neon/tests/exportar_fixture.sql',
  'ventana', (select json_build_object('inicio', ventana_inicio, 'fin', ventana_fin)
              from configuracion_publica),
  'dias', (select json_agg(json_build_object(
             'fecha', fecha, 'laborable', laborable,
             'ocupados', ocupados, 'max_simultaneos', max_simultaneos) order by fecha)
           from disponibilidad_publica)
);
