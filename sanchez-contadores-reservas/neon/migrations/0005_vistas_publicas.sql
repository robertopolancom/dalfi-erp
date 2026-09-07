-- 0005_vistas_publicas.sql
-- Superficie que consume la parte pública de la aplicación.
--
-- En Neon no hay RLS ni roles por usuario final: la única conexión es la del
-- servicio Express, y la autorización se hace allí. Estas vistas existen para
-- que las rutas públicas del servidor tengan una superficie estrecha y no
-- puedan devolver de más por descuido: quien consulta disponibilidad recibe
-- conteos agregados, nunca qué centro ocupa qué día ni datos de contacto
-- ajenos.

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
-- Nota sobre autorización
-- ---------------------------------------------------------------------------
--
-- Aquí NO hay políticas de Row Level Security. En el diseño anterior sobre
-- Supabase, `anon` y `authenticated` eran roles reales de Postgres y RLS era la
-- última línea de defensa contra un cliente que hablara directo con la base.
-- Con Neon detrás de Render eso no aplica: la base solo acepta la conexión del
-- servicio, DATABASE_URL nunca sale del servidor y el navegador únicamente ve
-- las rutas HTTP.
--
-- Dónde vive cada control ahora:
--   * Autenticación de la contadora  -> server/auth.ts (scrypt + sesiones)
--   * Qué puede pedir el público     -> las rutas de server/app.ts y estas vistas
--   * Reglas de negocio              -> funciones de las migraciones 0003 y 0004
--
-- Consecuencia operativa: la cadena DATABASE_URL es el secreto más sensible del
-- sistema. Nunca debe aparecer en el frontend, en Git ni en logs.
