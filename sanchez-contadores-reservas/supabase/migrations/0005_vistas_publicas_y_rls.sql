-- 0005_vistas_publicas_y_rls.sql
-- Superficie pública (sin login) y Row Level Security.
--
-- Principio: `anon` no toca ninguna tabla directamente. Solo lee dos vistas
-- agregadas y llama funciones acotadas. Toda escritura pública pasa por Edge
-- Functions que validan la entrada y llaman a las funciones de negocio.

-- ---------------------------------------------------------------------------
-- Vistas públicas
-- ---------------------------------------------------------------------------

-- Solo nombre y duración. El correo y el teléfono del centro NO son públicos.
create or replace view centros_publicos as
  select c.id, c.nombre, c.duracion_dias_laborables
  from centros c
  where c.activo
  order by c.nombre;

comment on view centros_publicos is
  'Desplegable del formulario público. Sin datos de contacto.';

-- Disponibilidad día a día de la ventana del año activo. Devuelve conteos
-- agregados: nunca revela qué centro ocupa qué día.
create or replace view disponibilidad_publica as
  select
    d.dia::date                                        as fecha,
    es_dia_laborable(d.dia::date)                      as laborable,
    (
      select count(*)::integer
      from reservas r
      where r.estado in ('reservada', 'en_proceso')
        and d.dia::date between r.fecha_inicio and r.fecha_fin
    )                                                  as ocupados,
    (select c.max_simultaneos from configuracion c where c.id = 1) as max_simultaneos
  from configuracion cfg
  cross join lateral (
    select inicio, fin from ventana_del_anio(cfg.anio_activo)
  ) v
  cross join lateral generate_series(v.inicio, v.fin, interval '1 day') as d(dia)
  where cfg.id = 1;

comment on view disponibilidad_publica is
  'Un registro por día de la ventana del año activo, con cupo agregado.';

-- Parámetros que el frontend necesita para pintar el calendario.
create or replace view configuracion_publica as
  select c.anio_activo,
         c.max_simultaneos,
         v.inicio as ventana_inicio,
         v.fin    as ventana_fin
  from configuracion c
  cross join lateral (select inicio, fin from ventana_del_anio(c.anio_activo)) v
  where c.id = 1;

-- ---------------------------------------------------------------------------
-- Consulta pública de una reserva por código
-- ---------------------------------------------------------------------------

create or replace function consultar_reserva(p_codigo text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_reserva reservas%rowtype;
  v_centro  centros%rowtype;
  v_sol     solicitudes_cambio%rowtype;
begin
  select * into v_reserva from reservas where codigo_reserva = btrim(upper(p_codigo));
  if not found then
    return jsonb_build_object('ok', false, 'codigo_error', 'RESERVA_NO_EXISTE',
                              'mensaje', 'No encontramos una reserva con ese código.');
  end if;

  select * into v_centro from centros where id = v_reserva.centro_id;

  select * into v_sol
  from solicitudes_cambio
  where reserva_id = v_reserva.id and estado = 'pendiente'
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'reserva', jsonb_build_object(
      'codigo_reserva', v_reserva.codigo_reserva,
      'centro',         v_centro.nombre,
      'fecha_inicio',   v_reserva.fecha_inicio,
      'fecha_fin',      v_reserva.fecha_fin,
      'duracion',       v_reserva.duracion_dias_laborables,
      'estado',         v_reserva.estado
    ),
    'solicitud_pendiente', case when v_sol.id is null then null else jsonb_build_object(
      'tipo',               v_sol.tipo,
      'nueva_fecha_inicio', v_sol.nueva_fecha_inicio,
      'creado_en',          v_sol.creado_en
    ) end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table centros             enable row level security;
alter table reservas            enable row level security;
alter table bloqueos            enable row level security;
alter table feriados            enable row level security;
alter table configuracion       enable row level security;
alter table solicitudes_cambio  enable row level security;
alter table notificaciones_log  enable row level security;
alter table rate_limit_publico  enable row level security;

-- La contadora autenticada administra todo. La estructura admite un segundo
-- administrador de respaldo sin cambios: basta crear otra cuenta en Supabase
-- Auth y estas políticas la cubren.
do $$
declare
  t text;
begin
  foreach t in array array[
    'centros', 'reservas', 'bloqueos', 'feriados', 'configuracion',
    'solicitudes_cambio', 'notificaciones_log'
  ]
  loop
    execute format(
      'create policy %I on %I for all to authenticated using (true) with check (true)',
      'admin_todo_' || t, t
    );
  end loop;
end;
$$;

-- rate_limit_publico no lo lee ni escribe nadie salvo el service role, que
-- ignora RLS. Sin políticas queda cerrado para anon y authenticated.

-- ---------------------------------------------------------------------------
-- Permisos explícitos
-- ---------------------------------------------------------------------------

-- Las vistas se ejecutan con los privilegios de su propietario, así que anon
-- puede leerlas sin tener acceso a las tablas base.
grant select on centros_publicos, disponibilidad_publica, configuracion_publica
  to anon, authenticated;

grant execute on function consultar_reserva(text) to anon, authenticated;

-- Estas funciones solo las invoca el service role desde Edge Functions.
revoke execute on function crear_reserva(uuid, date, text, text) from anon;
revoke execute on function crear_solicitud(text, solicitud_tipo, date, text) from anon;

-- Funciones de lectura que el panel usa directamente.
grant execute on function es_dia_laborable(date)                        to authenticated;
grant execute on function calcular_fecha_fin(date, integer)             to authenticated;
grant execute on function contar_dias_laborables(date, date)            to authenticated;
grant execute on function ventana_del_anio(integer)                     to authenticated;
grant execute on function primer_dia_sin_cupo(date, date, uuid)         to authenticated;
grant execute on function validar_reserva(uuid, date, uuid)             to authenticated;
grant execute on function resolver_solicitud(uuid, boolean, text)       to authenticated;
grant execute on function reservas_afectadas_por_rango(date, date)      to authenticated;
