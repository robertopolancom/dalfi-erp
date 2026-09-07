-- 0004_reglas_reservas.sql
-- Validación, creación atómica de reservas y resolución de solicitudes.

create type resultado_validacion as (
  ok             boolean,
  codigo_error   text,
  mensaje        text,
  fecha_fin      date,
  dia_conflicto  date
);

-- ---------------------------------------------------------------------------
-- validar_reserva: aplica en orden las reglas 1, 2, 3 y 5.
-- p_excluir_reserva permite revalidar una reserva existente contra una fecha
-- nueva (aprobación de solicitud de cambio) sin que choque consigo misma.
-- ---------------------------------------------------------------------------

create or replace function validar_reserva(
  p_centro_id        uuid,
  p_fecha_inicio     date,
  p_excluir_reserva  uuid default null
)
returns resultado_validacion
language plpgsql
stable
set search_path = public
as $$
declare
  v_centro        centros%rowtype;
  v_config        configuracion%rowtype;
  v_ventana_ini   date;
  v_ventana_fin   date;
  v_fecha_fin     date;
  v_conflicto     date;
  v_anio          integer;
begin
  select * into v_config from configuracion where id = 1;

  if p_fecha_inicio is null then
    return (false, 'FECHA_REQUERIDA', 'Debes elegir una fecha de inicio.', null, null)::resultado_validacion;
  end if;

  select * into v_centro from centros where id = p_centro_id;
  if not found then
    return (false, 'CENTRO_NO_EXISTE', 'El centro educativo no existe.', null, null)::resultado_validacion;
  end if;

  if not v_centro.activo then
    return (false, 'CENTRO_INACTIVO',
            'El centro está inactivo. Comunícate con la contadora.', null, null)::resultado_validacion;
  end if;

  -- Regla 1: año activo y ventana de trabajo
  v_anio := extract(year from p_fecha_inicio)::integer;
  if v_anio <> v_config.anio_activo then
    return (false, 'FUERA_DE_ANIO',
            format('Solo se reservan fechas del año %s.', v_config.anio_activo),
            null, null)::resultado_validacion;
  end if;

  select inicio, fin into v_ventana_ini, v_ventana_fin from ventana_del_anio(v_anio);

  if p_fecha_inicio < v_ventana_ini or p_fecha_inicio > v_ventana_fin then
    return (false, 'FUERA_DE_VENTANA',
            format('Solo se reservan fechas entre el %s y el %s.',
                   to_char(v_ventana_ini, 'DD/MM/YYYY'), to_char(v_ventana_fin, 'DD/MM/YYYY')),
            null, null)::resultado_validacion;
  end if;

  -- Regla 2: la fecha de inicio debe ser un día laborable
  if not es_dia_laborable(p_fecha_inicio) then
    return (false, 'DIA_NO_LABORABLE',
            'Esa fecha no es un día laborable disponible.', null, null)::resultado_validacion;
  end if;

  v_fecha_fin := calcular_fecha_fin(p_fecha_inicio, v_centro.duracion_dias_laborables);
  if v_fecha_fin is null then
    return (false, 'SIN_DIAS_SUFICIENTES',
            'No hay días laborables suficientes desde esa fecha.', null, null)::resultado_validacion;
  end if;

  -- Regla 1 (cierre): la fecha fin tampoco puede salirse de la ventana
  if v_fecha_fin > v_ventana_fin then
    return (false, 'FIN_FUERA_DE_VENTANA',
            format('La reserva terminaría el %s y la ventana cierra el %s.',
                   to_char(v_fecha_fin, 'DD/MM/YYYY'), to_char(v_ventana_fin, 'DD/MM/YYYY')),
            v_fecha_fin, null)::resultado_validacion;
  end if;

  -- Regla 5: una reserva no cancelada por centro por año
  if exists (
    select 1 from reservas r
    where r.centro_id = p_centro_id
      and r.anio = v_anio
      and r.estado <> 'cancelada'
      and (p_excluir_reserva is null or r.id <> p_excluir_reserva)
  ) then
    return (false, 'CENTRO_YA_RESERVO',
            'Este centro ya tiene una reserva para el año. Solicita un cambio en vez de reservar de nuevo.',
            v_fecha_fin, null)::resultado_validacion;
  end if;

  -- Regla 3: capacidad simultánea en todo el rango
  v_conflicto := primer_dia_sin_cupo(p_fecha_inicio, v_fecha_fin, p_excluir_reserva);
  if v_conflicto is not null then
    return (false, 'SIN_CUPO',
            format('El %s ya hay %s centros en proceso. Elige otra fecha.',
                   to_char(v_conflicto, 'DD/MM/YYYY'), v_config.max_simultaneos),
            v_fecha_fin, v_conflicto)::resultado_validacion;
  end if;

  return (true, null, null, v_fecha_fin, null)::resultado_validacion;
end;
$$;

-- ---------------------------------------------------------------------------
-- Regla 9: creación atómica.
-- Un lock consultivo por año serializa validación e inserción, de modo que dos
-- centros que envían a la vez no pueden quedarse con el mismo hueco. El lock se
-- libera solo al terminar la transacción de la función.
-- ---------------------------------------------------------------------------

create or replace function crear_reserva(
  p_centro_id       uuid,
  p_fecha_inicio    date,
  p_correo_contacto text,
  p_telefono        text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_val     resultado_validacion;
  v_centro  centros%rowtype;
  v_anio    integer := extract(year from p_fecha_inicio)::integer;
  v_reserva reservas%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('reservas:' || v_anio::text));

  v_val := validar_reserva(p_centro_id, p_fecha_inicio, null);
  if not v_val.ok then
    return jsonb_build_object('ok', false, 'codigo_error', v_val.codigo_error, 'mensaje', v_val.mensaje);
  end if;

  select * into v_centro from centros where id = p_centro_id;

  insert into reservas (
    centro_id, anio, fecha_inicio, fecha_fin, duracion_dias_laborables,
    estado, codigo_reserva, correo_contacto, telefono
  ) values (
    p_centro_id, v_anio, p_fecha_inicio, v_val.fecha_fin, v_centro.duracion_dias_laborables,
    'reservada', generar_codigo_reserva(v_anio), btrim(p_correo_contacto), btrim(p_telefono)
  )
  returning * into v_reserva;

  return jsonb_build_object(
    'ok', true,
    'reserva', jsonb_build_object(
      'id',              v_reserva.id,
      'codigo_reserva',  v_reserva.codigo_reserva,
      'centro',          v_centro.nombre,
      'fecha_inicio',    v_reserva.fecha_inicio,
      'fecha_fin',       v_reserva.fecha_fin,
      'duracion',        v_reserva.duracion_dias_laborables,
      'correo_contacto', v_reserva.correo_contacto,
      'estado',          v_reserva.estado
    )
  );
exception
  when unique_violation then
    return jsonb_build_object(
      'ok', false,
      'codigo_error', 'CENTRO_YA_RESERVO',
      'mensaje', 'Este centro ya tiene una reserva para el año.'
    );
end;
$$;

revoke all on function crear_reserva(uuid, date, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Regla 6: solicitudes de cambio y cancelación.
-- Nada se modifica hasta que la contadora aprueba.
-- ---------------------------------------------------------------------------

create or replace function crear_solicitud(
  p_codigo_reserva     text,
  p_tipo               solicitud_tipo,
  p_nueva_fecha_inicio date,
  p_motivo             text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_reserva reservas%rowtype;
  v_val     resultado_validacion;
  v_id      uuid;
begin
  select * into v_reserva from reservas where codigo_reserva = btrim(upper(p_codigo_reserva));
  if not found then
    return jsonb_build_object('ok', false, 'codigo_error', 'RESERVA_NO_EXISTE',
                              'mensaje', 'No encontramos una reserva con ese código.');
  end if;

  if v_reserva.estado = 'cancelada' then
    return jsonb_build_object('ok', false, 'codigo_error', 'RESERVA_CANCELADA',
                              'mensaje', 'Esa reserva ya está cancelada.');
  end if;

  if v_reserva.estado = 'entregada' then
    return jsonb_build_object('ok', false, 'codigo_error', 'RESERVA_ENTREGADA',
                              'mensaje', 'Esa reserva ya fue entregada.');
  end if;

  if exists (select 1 from solicitudes_cambio s
             where s.reserva_id = v_reserva.id and s.estado = 'pendiente') then
    return jsonb_build_object('ok', false, 'codigo_error', 'SOLICITUD_PENDIENTE',
                              'mensaje', 'Ya hay una solicitud pendiente para esta reserva.');
  end if;

  if p_tipo = 'cambio' then
    if p_nueva_fecha_inicio is null then
      return jsonb_build_object('ok', false, 'codigo_error', 'FECHA_REQUERIDA',
                                'mensaje', 'Indica la nueva fecha que prefieres.');
    end if;

    -- Validación temprana: no aceptamos solicitudes hacia fechas imposibles.
    -- La validación definitiva se repite al aprobar, porque la disponibilidad
    -- puede cambiar entre la solicitud y la aprobación.
    v_val := validar_reserva(v_reserva.centro_id, p_nueva_fecha_inicio, v_reserva.id);
    if not v_val.ok then
      return jsonb_build_object('ok', false, 'codigo_error', v_val.codigo_error,
                                'mensaje', v_val.mensaje);
    end if;
  end if;

  insert into solicitudes_cambio (reserva_id, tipo, nueva_fecha_inicio, motivo)
  values (v_reserva.id, p_tipo,
          case when p_tipo = 'cambio' then p_nueva_fecha_inicio else null end,
          btrim(p_motivo))
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'solicitud_id', v_id,
    'reserva', jsonb_build_object(
      'id',              v_reserva.id,
      'codigo_reserva',  v_reserva.codigo_reserva,
      'correo_contacto', v_reserva.correo_contacto,
      'fecha_inicio',    v_reserva.fecha_inicio,
      'fecha_fin',       v_reserva.fecha_fin
    )
  );
end;
$$;

revoke all on function crear_solicitud(text, solicitud_tipo, date, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Aprobación / rechazo. Solo la contadora autenticada.
-- Al aprobar un cambio se revalidan TODAS las reglas sobre la nueva fecha.
-- ---------------------------------------------------------------------------

create or replace function resolver_solicitud(
  p_solicitud_id uuid,
  p_aprobar      boolean,
  p_nota         text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_sol     solicitudes_cambio%rowtype;
  v_reserva reservas%rowtype;
  v_val     resultado_validacion;
begin
  if auth.uid() is null then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  select * into v_sol from solicitudes_cambio where id = p_solicitud_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'codigo_error', 'SOLICITUD_NO_EXISTE',
                              'mensaje', 'La solicitud no existe.');
  end if;

  if v_sol.estado <> 'pendiente' then
    return jsonb_build_object('ok', false, 'codigo_error', 'SOLICITUD_RESUELTA',
                              'mensaje', 'Esa solicitud ya fue resuelta.');
  end if;

  select * into v_reserva from reservas where id = v_sol.reserva_id for update;

  if not p_aprobar then
    update solicitudes_cambio
       set estado = 'rechazada', nota_resolucion = p_nota,
           resuelta_en = now(), resuelta_por = auth.uid()
     where id = p_solicitud_id;

    return jsonb_build_object('ok', true, 'accion', 'rechazada',
                              'reserva_id', v_reserva.id,
                              'codigo_reserva', v_reserva.codigo_reserva,
                              'destinatario', v_reserva.correo_contacto);
  end if;

  perform pg_advisory_xact_lock(hashtext('reservas:' || v_reserva.anio::text));

  if v_sol.tipo = 'cancelacion' then
    update reservas set estado = 'cancelada' where id = v_reserva.id;
  else
    v_val := validar_reserva(v_reserva.centro_id, v_sol.nueva_fecha_inicio, v_reserva.id);
    if not v_val.ok then
      return jsonb_build_object('ok', false, 'codigo_error', v_val.codigo_error,
                                'mensaje', v_val.mensaje);
    end if;

    update reservas
       set fecha_inicio = v_sol.nueva_fecha_inicio,
           fecha_fin    = v_val.fecha_fin,
           anio         = extract(year from v_sol.nueva_fecha_inicio)::smallint
     where id = v_reserva.id;
  end if;

  update solicitudes_cambio
     set estado = 'aprobada', nota_resolucion = p_nota,
         resuelta_en = now(), resuelta_por = auth.uid()
   where id = p_solicitud_id;

  select * into v_reserva from reservas where id = v_sol.reserva_id;

  return jsonb_build_object('ok', true, 'accion', 'aprobada',
                            'tipo', v_sol.tipo,
                            'reserva_id', v_reserva.id,
                            'codigo_reserva', v_reserva.codigo_reserva,
                            'destinatario', v_reserva.correo_contacto,
                            'fecha_inicio', v_reserva.fecha_inicio,
                            'fecha_fin', v_reserva.fecha_fin);
end;
$$;

-- ---------------------------------------------------------------------------
-- Regla 7: un bloqueo nunca cancela reservas. Esta función lista las que
-- quedarían afectadas para que el panel las muestre como advertencia.
-- ---------------------------------------------------------------------------

create or replace function reservas_afectadas_por_rango(p_inicio date, p_fin date)
returns table (
  id             uuid,
  codigo_reserva text,
  centro         text,
  fecha_inicio   date,
  fecha_fin      date,
  estado         reserva_estado
)
language sql
stable
set search_path = public
as $$
  select r.id, r.codigo_reserva, c.nombre, r.fecha_inicio, r.fecha_fin, r.estado
  from reservas r
  join centros c on c.id = r.centro_id
  where r.estado in ('reservada', 'en_proceso')
    and r.fecha_inicio <= p_fin
    and r.fecha_fin    >= p_inicio
  order by r.fecha_inicio;
$$;
