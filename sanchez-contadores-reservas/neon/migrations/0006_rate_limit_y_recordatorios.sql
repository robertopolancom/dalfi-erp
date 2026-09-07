-- 0006_rate_limit_y_recordatorios.sql
-- Soporte para el endpoint público y para el cron de recordatorios.

-- ---------------------------------------------------------------------------
-- Rate limiting por ventana fija.
-- Devuelve true si la petición cabe dentro del límite y la contabiliza; false
-- si ya se agotó. Atómico: el UPDATE ... RETURNING bloquea la fila.
-- ---------------------------------------------------------------------------

create or replace function consumir_rate_limit(
  p_clave            text,
  p_limite           integer,
  p_ventana_segundos integer
)
returns boolean
language plpgsql
volatile
set search_path = public
as $$
declare
  v_conteo integer;
begin
  insert into rate_limit_publico (clave, ventana_inicio, conteo)
  values (p_clave, now(), 0)
  on conflict (clave) do nothing;

  update rate_limit_publico
     set ventana_inicio = case
           when now() - ventana_inicio > make_interval(secs => p_ventana_segundos)
             then now() else ventana_inicio end,
         conteo = case
           when now() - ventana_inicio > make_interval(secs => p_ventana_segundos)
             then 1 else conteo + 1 end
   where clave = p_clave
  returning conteo into v_conteo;

  return v_conteo <= p_limite;
end;
$$;

-- Limpieza de contadores viejos, para que la tabla no crezca sin control.
create or replace function purgar_rate_limit()
returns integer
language sql
volatile
set search_path = public
as $$
  with borradas as (
    delete from rate_limit_publico
    where ventana_inicio < now() - interval '1 day'
    returning 1
  )
  select count(*)::integer from borradas;
$$;

-- ---------------------------------------------------------------------------
-- Recordatorios: reservas que empiezan dentro de exactamente N días laborables
-- y a las que todavía no se les envió el recordatorio.
-- ---------------------------------------------------------------------------

create or replace function reservas_para_recordatorio(p_dias_laborables integer default 3)
returns table (
  reserva_id      uuid,
  codigo_reserva  text,
  centro          text,
  correo_contacto text,
  fecha_inicio    date,
  fecha_fin       date,
  duracion        smallint
)
language sql
stable
set search_path = public
as $$
  -- El objetivo es la fecha que queda a p_dias_laborables días hábiles desde
  -- hoy. calcular_fecha_fin cuenta el día inicial como el primero, así que
  -- pedimos p_dias_laborables + 1 desde el siguiente día hábil.
  with objetivo as (
    select calcular_fecha_fin(
      (select min(d.dia::date)
       from generate_series(current_date + 1, current_date + 30, interval '1 day') as d(dia)
       where es_dia_laborable(d.dia::date)),
      p_dias_laborables
    ) as fecha
  )
  select r.id, r.codigo_reserva, c.nombre, r.correo_contacto,
         r.fecha_inicio, r.fecha_fin, r.duracion_dias_laborables
  from reservas r
  join centros c on c.id = r.centro_id
  cross join objetivo o
  where r.estado = 'reservada'
    and r.fecha_inicio = o.fecha
    and not exists (
      select 1 from notificaciones_log n
      where n.reserva_id = r.id
        and n.tipo_evento = 'recordatorio'
        and n.resultado = 'enviado'
    );
$$;
