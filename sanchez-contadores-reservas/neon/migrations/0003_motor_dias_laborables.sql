-- 0003_motor_dias_laborables.sql
-- Motor de días laborables, ventana de trabajo y capacidad simultánea.
--
-- Estas funciones son la ÚNICA fuente de verdad de las reglas de negocio. El
-- frontend replica el cálculo solo para pintar el calendario; el servidor
-- siempre revalida antes de escribir.

-- ---------------------------------------------------------------------------
-- Regla 2: días laborables
-- Un día es inhábil si es sábado, domingo, feriado o cae dentro de un bloqueo.
-- ---------------------------------------------------------------------------

create or replace function es_dia_laborable(p_fecha date)
returns boolean
language sql
stable
set search_path = public
as $$
  select p_fecha is not null
     and extract(isodow from p_fecha) < 6
     and not exists (select 1 from feriados f where f.fecha = p_fecha)
     and not exists (
       select 1 from bloqueos b
       where p_fecha between b.fecha_inicio and b.fecha_fin
     );
$$;

comment on function es_dia_laborable(date) is
  'true si la fecha no es fin de semana, feriado ni parte de un bloqueo.';

-- ---------------------------------------------------------------------------
-- Fecha fin de una reserva: el n-ésimo día laborable contando el inicio como 1.
-- Devuelve NULL si la fecha de inicio no es laborable.
-- ---------------------------------------------------------------------------

create or replace function calcular_fecha_fin(p_inicio date, p_dias integer)
returns date
language plpgsql
stable
set search_path = public
as $$
declare
  v_restantes integer := p_dias;
  v_fecha     date    := p_inicio;
  v_guardia   integer := 0;
begin
  if p_inicio is null or p_dias is null or p_dias < 1 then
    return null;
  end if;

  if not es_dia_laborable(p_inicio) then
    return null;
  end if;

  loop
    if es_dia_laborable(v_fecha) then
      v_restantes := v_restantes - 1;
      exit when v_restantes = 0;
    end if;

    v_fecha   := v_fecha + 1;
    v_guardia := v_guardia + 1;

    -- Si un bloqueo enorme deja más de dos años sin días hábiles, abortamos en
    -- vez de girar para siempre.
    if v_guardia > 730 then
      raise exception 'No hay suficientes días laborables desde % para % días',
        p_inicio, p_dias;
    end if;
  end loop;

  return v_fecha;
end;
$$;

-- ---------------------------------------------------------------------------
-- Conteo de días laborables en un rango cerrado.
-- ---------------------------------------------------------------------------

create or replace function contar_dias_laborables(p_inicio date, p_fin date)
returns integer
language sql
stable
set search_path = public
as $$
  select coalesce(count(*), 0)::integer
  from generate_series(p_inicio, p_fin, interval '1 day') as d(dia)
  where es_dia_laborable(d.dia::date);
$$;

-- ---------------------------------------------------------------------------
-- Regla 1: ventana de trabajo del año (1 de febrero a 31 de julio por defecto)
-- ---------------------------------------------------------------------------

create or replace function ventana_del_anio(p_anio integer)
returns table (inicio date, fin date)
language sql
stable
set search_path = public
as $$
  select make_date(p_anio, c.ventana_inicio_mes, c.ventana_inicio_dia),
         make_date(p_anio, c.ventana_fin_mes,    c.ventana_fin_dia)
  from configuracion c
  where c.id = 1;
$$;

-- ---------------------------------------------------------------------------
-- Regla 3: capacidad simultánea.
-- Devuelve el PRIMER día laborable del rango en el que ya se alcanzó el máximo
-- de reservas activas, o NULL si todo el rango tiene cupo. Se evalúa el rango
-- completo, no solo el día inicial.
-- ---------------------------------------------------------------------------

create or replace function primer_dia_sin_cupo(
  p_inicio           date,
  p_fin              date,
  p_excluir_reserva  uuid default null
)
returns date
language sql
stable
set search_path = public
as $$
  select d.dia::date
  from generate_series(p_inicio, p_fin, interval '1 day') as d(dia)
  where es_dia_laborable(d.dia::date)
    and (
      select count(*)
      from reservas r
      where r.estado in ('reservada', 'en_proceso')
        and (p_excluir_reserva is null or r.id <> p_excluir_reserva)
        and d.dia::date between r.fecha_inicio and r.fecha_fin
    ) >= (select c.max_simultaneos from configuracion c where c.id = 1)
  order by d.dia
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Código de reserva legible: SC-<AÑO>-<6 caracteres>
-- Alfabeto sin caracteres ambiguos (0/O, 1/I) para dictarlo por teléfono.
-- ---------------------------------------------------------------------------

create or replace function generar_codigo_reserva(p_anio integer)
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  v_alfabeto constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_codigo   text;
  v_intento  integer := 0;
begin
  loop
    v_codigo := 'SC-' || p_anio || '-';
    for _ in 1..6 loop
      v_codigo := v_codigo ||
        substr(v_alfabeto, 1 + floor(random() * length(v_alfabeto))::integer, 1);
    end loop;

    exit when not exists (select 1 from reservas r where r.codigo_reserva = v_codigo);

    v_intento := v_intento + 1;
    if v_intento > 50 then
      raise exception 'No se pudo generar un código de reserva único';
    end if;
  end loop;

  return v_codigo;
end;
$$;
