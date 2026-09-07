-- reglas.test.sql
-- Pruebas de las reglas de negocio contra el motor SQL real.
--
-- Ejecutar sobre una base limpia (Neon o Postgres local) con las migraciones
-- aplicadas:
--   psql -f neon/migrations/000*.sql
--   psql -v ON_ERROR_STOP=1 -f neon/tests/reglas.test.sql
--
-- Todo corre dentro de una transacción que se revierte al final, así que la
-- base queda igual que antes.

begin;

create or replace function _assert(p_cond boolean, p_label text)
returns void language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'FALLA: %', p_label;
  end if;
  raise notice '  ok  %', p_label;
end;
$$;

create or replace function _assert_eq(p_actual anyelement, p_esperado anyelement, p_label text)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_esperado then
    raise exception 'FALLA: % (esperado %, obtenido %)', p_label, p_esperado, p_actual;
  end if;
  raise notice '  ok  % = %', p_label, p_actual;
end;
$$;

-- Centros de prueba
insert into centros (nombre, correo_contacto, telefono) values
  ('Colegio Alfa',   'alfa@test.do',   '809-000-0001'),
  ('Colegio Beta',   'beta@test.do',   '809-000-0002'),
  ('Colegio Gamma',  'gamma@test.do',  '809-000-0003'),
  ('Colegio Delta',  'delta@test.do',  '809-000-0004'),
  ('Colegio Epsilon','epsilon@test.do','809-000-0005');

insert into centros (nombre, correo_contacto, telefono, duracion_dias_laborables)
values ('Colegio Largo', 'largo@test.do', '809-000-0006', 10);

insert into centros (nombre, correo_contacto, telefono, activo)
values ('Colegio Inactivo', 'inactivo@test.do', '809-000-0007', false);

\echo ''
\echo '== Regla 2: días laborables =='
do $$
begin
  perform _assert_eq(es_dia_laborable('2027-02-01'), true,  'lunes 1-feb-2027 es laborable');
  perform _assert_eq(es_dia_laborable('2027-02-06'), false, 'sábado no es laborable');
  perform _assert_eq(es_dia_laborable('2027-02-07'), false, 'domingo no es laborable');
  perform _assert_eq(es_dia_laborable('2027-03-26'), false, 'Viernes Santo 2027 no es laborable');
  perform _assert_eq(es_dia_laborable('2027-05-27'), false, 'Corpus Christi 2027 no es laborable');
end;
$$;

\echo ''
\echo '== Caso límite: feriado trasladado por la Ley 139-97 =='
do $$
begin
  -- Duarte cae martes 26-ene-2027, así que se celebra el lunes 25.
  perform _assert_eq(es_dia_laborable('2027-01-25'), false,
    'lunes 25-ene-2027 (Duarte trasladado) NO es laborable');
  perform _assert_eq(es_dia_laborable('2027-01-26'), true,
    'martes 26-ene-2027 (fecha original de Duarte) SÍ es laborable');
  -- El 1 de mayo de 2027 cae sábado: el Art. 1 no aplica y no se traslada.
  perform _assert_eq(es_dia_laborable('2027-05-03'), true,
    'lunes 3-may-2027 es laborable (el Día del Trabajo cayó sábado, no se trasladó)');
end;
$$;

\echo ''
\echo '== Cálculo de fecha fin en días laborables =='
do $$
begin
  perform _assert_eq(calcular_fecha_fin('2027-02-01', 5), date '2027-02-05',
    'lun 1-feb + 5 días laborables = vie 5-feb');
  perform _assert_eq(calcular_fecha_fin('2027-02-01', 1), date '2027-02-01',
    'duración 1 termina el mismo día');
  perform _assert_eq(calcular_fecha_fin('2027-02-04', 5), date '2027-02-10',
    'jue 4-feb + 5 salta el fin de semana y termina mié 10-feb');
  -- Semana Santa: viernes 26-mar es feriado, así que el quinto día cae el lunes 29.
  perform _assert_eq(calcular_fecha_fin('2027-03-22', 5), date '2027-03-29',
    'lun 22-mar + 5 salta el Viernes Santo y termina lun 29-mar');
  perform _assert_eq(calcular_fecha_fin('2027-02-06', 5), null,
    'una fecha de inicio no laborable devuelve NULL');
  perform _assert_eq(contar_dias_laborables('2027-03-22', '2027-03-29'), 5,
    'el rango 22-mar a 29-mar contiene 5 días laborables');
end;
$$;

\echo ''
\echo '== Regla 1: ventana de trabajo (1-feb a 31-jul) =='
do $$
declare v resultado_validacion; c_alfa uuid; c_beta uuid;
begin
  select id into c_alfa from centros where nombre = 'Colegio Alfa';
  select id into c_beta from centros where nombre = 'Colegio Beta';

  v := validar_reserva(c_alfa, '2027-01-29');
  perform _assert_eq(v.codigo_error, 'FUERA_DE_VENTANA', 'antes del 1-feb se rechaza');

  v := validar_reserva(c_alfa, '2027-08-02');
  perform _assert_eq(v.codigo_error, 'FUERA_DE_VENTANA', 'después del 31-jul se rechaza');

  v := validar_reserva(c_alfa, '2026-02-02');
  perform _assert_eq(v.codigo_error, 'FUERA_DE_ANIO', 'otro año se rechaza');

  -- Caso límite del cierre de ventana. El 31-jul-2027 cae sábado, así que el
  -- último día laborable de la ventana es el viernes 30. Con 5 días de
  -- duración, el último inicio posible es el lunes 26 de julio.
  v := validar_reserva(c_alfa, '2027-07-26');
  perform _assert_eq(v.ok, true, 'lun 26-jul es el último inicio válido');
  perform _assert_eq(v.fecha_fin, date '2027-07-30', 'termina el vie 30-jul, dentro de la ventana');

  v := validar_reserva(c_beta, '2027-07-27');
  perform _assert_eq(v.codigo_error, 'FIN_FUERA_DE_VENTANA',
    'mar 27-jul se rechaza porque terminaría en agosto');
end;
$$;

\echo ''
\echo '== Regla 3: capacidad simultánea (tercer y cuarto centro) =='
do $$
declare
  r jsonb; c uuid; v resultado_validacion;
begin
  -- Tres centros arrancan el mismo lunes: los tres deben caber.
  foreach c in array (select array_agg(id order by nombre)
                      from centros where nombre in ('Colegio Alfa','Colegio Beta','Colegio Gamma'))
  loop
    r := crear_reserva(c, '2027-02-01', 'x@test.do', '809-000-0000');
    perform _assert_eq((r->>'ok')::boolean, true,
      format('reserva simultánea aceptada para %s', (select nombre from centros where id = c)));
  end loop;

  -- El cuarto choca contra max_simultaneos = 3.
  select id into c from centros where nombre = 'Colegio Delta';
  r := crear_reserva(c, '2027-02-01', 'x@test.do', '809-000-0000');
  perform _assert_eq((r->>'ok')::boolean, false, 'el cuarto centro simultáneo se rechaza');
  perform _assert_eq(r->>'codigo_error', 'SIN_CUPO', 'el motivo es falta de cupo');

  -- Un inicio distinto que SOLAPA parcialmente también se rechaza: la regla
  -- mira el rango completo, no solo el día inicial.
  v := validar_reserva(c, '2027-02-03');
  perform _assert_eq(v.codigo_error, 'SIN_CUPO',
    'un rango que solapa parcialmente los tres activos se rechaza');
  perform _assert_eq(v.dia_conflicto, date '2027-02-03', 'informa el primer día sin cupo');

  -- Fuera del solapamiento sí hay cupo: los tres primeros terminan el 5-feb.
  v := validar_reserva(c, '2027-02-08');
  perform _assert_eq(v.ok, true, 'la semana siguiente vuelve a tener cupo');
end;
$$;

\echo ''
\echo '== Regla 5: una reserva por centro por año =='
do $$
declare r jsonb; c uuid;
begin
  select id into c from centros where nombre = 'Colegio Alfa';
  r := crear_reserva(c, '2027-03-01', 'x@test.do', '809-000-0000');
  perform _assert_eq((r->>'ok')::boolean, false, 'un centro con reserva activa no puede reservar otra vez');
  perform _assert_eq(r->>'codigo_error', 'CENTRO_YA_RESERVO', 'el motivo es reserva existente');

  -- Tras cancelar, el centro vuelve a quedar libre.
  update reservas set estado = 'cancelada' where centro_id = c;
  r := crear_reserva(c, '2027-03-01', 'x@test.do', '809-000-0000');
  perform _assert_eq((r->>'ok')::boolean, true, 'cancelada la anterior, puede reservar de nuevo');
end;
$$;

\echo ''
\echo '== Centro inactivo =='
do $$
declare r jsonb; c uuid;
begin
  select id into c from centros where nombre = 'Colegio Inactivo';
  r := crear_reserva(c, '2027-06-01', 'x@test.do', '809-000-0000');
  perform _assert_eq(r->>'codigo_error', 'CENTRO_INACTIVO', 'un centro inactivo no puede reservar');
end;
$$;

\echo ''
\echo '== Caso límite: un bloqueo parte un rango =='
do $$
declare c uuid; v resultado_validacion;
begin
  select id into c from centros where nombre = 'Colegio Epsilon';

  -- Sin bloqueo: lun 7-jun + 5 = vie 11-jun.
  v := validar_reserva(c, '2027-06-07');
  perform _assert_eq(v.fecha_fin, date '2027-06-11', 'sin bloqueo termina el vie 11-jun');

  -- Bloqueamos mié 9 y jue 10: el rango se parte y se estira dos días.
  insert into bloqueos (fecha_inicio, fecha_fin, tipo, descripcion)
  values ('2027-06-09', '2027-06-10', 'personal', 'Capacitación');

  perform _assert_eq(es_dia_laborable('2027-06-09'), false, 'el día bloqueado deja de ser laborable');

  v := validar_reserva(c, '2027-06-07');
  perform _assert_eq(v.fecha_fin, date '2027-06-15',
    'con el bloqueo en medio, el rango se estira hasta el mar 15-jun');
  perform _assert_eq(contar_dias_laborables('2027-06-07','2027-06-15'), 5,
    'el rango partido sigue teniendo exactamente 5 días laborables');

  -- Un inicio que cae dentro del bloqueo se rechaza.
  v := validar_reserva(c, '2027-06-09');
  perform _assert_eq(v.codigo_error, 'DIA_NO_LABORABLE', 'no se puede iniciar dentro de un bloqueo');
end;
$$;

\echo ''
\echo '== Regla 7: un bloqueo advierte pero no cancela =='
do $$
declare n integer; c uuid; r jsonb;
begin
  select id into c from centros where nombre = 'Colegio Epsilon';
  r := crear_reserva(c, '2027-06-07', 'x@test.do', '809-000-0000');
  perform _assert_eq((r->>'ok')::boolean, true, 'reserva de prueba creada');

  select count(*) into n from reservas_afectadas_por_rango('2027-06-08','2027-06-08');
  perform _assert(n >= 1, 'el bloqueo nuevo lista las reservas afectadas');

  select count(*) into n from reservas where estado = 'cancelada' and centro_id = c;
  perform _assert_eq(n, 0, 'ninguna reserva se canceló automáticamente');
end;
$$;

\echo ''
\echo '== Regla 6: solicitudes de cambio y cancelación =='
do $$
declare r jsonb; sol uuid; c uuid; admin uuid; cod text; f date;
begin
  insert into administradores (correo, nombre, hash_clave)
  values ('contadora@test.do', 'Contadora de prueba', 'scrypt$16384$00$00')
  returning id into admin;

  -- Elegimos una reserva concreta para que la prueba sea determinista.
  select r.codigo_reserva, r.centro_id into cod, c
  from reservas r
  join centros ce on ce.id = r.centro_id
  where ce.nombre = 'Colegio Epsilon' and r.estado = 'reservada';

  -- Una solicitud no altera la reserva.
  select fecha_inicio into f from reservas where codigo_reserva = cod;
  r := crear_solicitud(cod, 'cambio', '2027-06-21', 'Se nos cruzó la auditoría interna');
  perform _assert_eq((r->>'ok')::boolean, true, 'solicitud de cambio aceptada');
  perform _assert_eq((select fecha_inicio from reservas where codigo_reserva = cod), f,
    'la reserva NO cambia mientras la solicitud está pendiente');

  -- Segunda solicitud pendiente: rechazada.
  r := crear_solicitud(cod, 'cambio', '2027-06-28', 'Otra vez');
  perform _assert_eq(r->>'codigo_error', 'SOLICITUD_PENDIENTE', 'solo una solicitud pendiente por reserva');

  -- Aprobar mueve la reserva y revalida las reglas.
  select id into sol from solicitudes_cambio where estado = 'pendiente' limit 1;
  r := resolver_solicitud(sol, true, admin, 'Aprobado');
  perform _assert_eq((r->>'ok')::boolean, true, 'la contadora aprueba el cambio');
  perform _assert_eq((select fecha_inicio from reservas where codigo_reserva = cod), date '2027-06-21',
    'al aprobar, la reserva se mueve a la nueva fecha');
  perform _assert_eq((select fecha_fin from reservas where codigo_reserva = cod), date '2027-06-25',
    'la fecha fin se recalcula en días laborables');

  -- Cancelación por solicitud.
  r := crear_solicitud(cod, 'cancelacion', null, 'Cerramos el año fiscal en otra firma');
  select id into sol from solicitudes_cambio where estado = 'pendiente' limit 1;
  r := resolver_solicitud(sol, true, admin, null);
  perform _assert_eq((select estado from reservas where codigo_reserva = cod)::text, 'cancelada',
    'al aprobar la cancelación la reserva queda cancelada');
end;
$$;

\echo ''
\echo '== Autorización: resolver exige un administrador activo =='
do $$
declare sol uuid; admin uuid; fallo boolean := false; cod text; r jsonb;
begin
  select id into admin from administradores limit 1;

  -- Creamos una solicitud nueva sobre una reserva viva para tener algo que resolver.
  select codigo_reserva into cod from reservas where estado = 'reservada' limit 1;
  r := crear_solicitud(cod, 'cambio', '2027-04-05', 'Prueba de autorización');
  select id into sol from solicitudes_cambio where estado = 'pendiente' limit 1;

  begin
    r := resolver_solicitud(sol, true, null, null);
  exception when insufficient_privilege then
    fallo := true;
  end;
  perform _assert_eq(fallo, true, 'sin administrador la resolución se rechaza');

  fallo := false;
  begin
    r := resolver_solicitud(sol, true, gen_random_uuid(), null);
  exception when insufficient_privilege then
    fallo := true;
  end;
  perform _assert_eq(fallo, true, 'con un administrador inexistente también se rechaza');

  update administradores set activo = false where id = admin;
  fallo := false;
  begin
    r := resolver_solicitud(sol, true, admin, null);
  exception when insufficient_privilege then
    fallo := true;
  end;
  perform _assert_eq(fallo, true, 'un administrador desactivado no puede resolver');
  update administradores set activo = true where id = admin;
end;
$$;

\echo ''
\echo '== Consulta pública por código =='
do $$
declare r jsonb; cod text;
begin
  select codigo_reserva into cod from reservas limit 1;
  r := consultar_reserva(lower(cod));
  perform _assert_eq((r->>'ok')::boolean, true, 'el código se busca sin distinguir mayúsculas');
  r := consultar_reserva('SC-2027-NOEXIS');
  perform _assert_eq(r->>'codigo_error', 'RESERVA_NO_EXISTE', 'un código inexistente devuelve error claro');
end;
$$;

\echo ''
\echo '== Formato del código de reserva =='
do $$
declare cod text;
begin
  select codigo_reserva into cod from reservas limit 1;
  perform _assert(cod ~ '^SC-2027-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$',
    format('el código %s usa el formato SC-AÑO-XXXXXX sin caracteres ambiguos', cod));
end;
$$;

rollback;
