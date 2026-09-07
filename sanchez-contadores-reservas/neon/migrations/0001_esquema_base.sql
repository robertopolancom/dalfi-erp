-- 0001_esquema_base.sql
-- Esquema base del sistema de reserva de fechas para presentación de estados
-- contables anuales (Sánchez Contadores).
--
-- Base: Neon (PostgreSQL). El único cliente de esta base es el servicio Express
-- desplegado en Render, con una sola cadena DATABASE_URL. No hay roles por
-- usuario final ni RLS: la autorización la hace el servidor antes de tocar la
-- base, y el público nunca habla con Postgres directamente.
--
-- Este archivo define estructura, restricciones e índices. La lógica de negocio
-- vive en funciones SQL en las migraciones 0003 y 0004.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------

create type reserva_estado    as enum ('reservada', 'en_proceso', 'entregada', 'cancelada');
create type bloqueo_tipo      as enum ('feriado', 'personal', 'otro');
create type solicitud_tipo    as enum ('cambio', 'cancelacion');
create type solicitud_estado  as enum ('pendiente', 'aprobada', 'rechazada');

-- ---------------------------------------------------------------------------
-- configuracion
-- Fila única (id = 1). Define la ventana de trabajo, el máximo de centros
-- simultáneos y el año activo. La contadora la edita desde el panel.
-- ---------------------------------------------------------------------------

create table configuracion (
  id                 smallint primary key default 1 check (id = 1),
  ventana_inicio_mes smallint not null default 2  check (ventana_inicio_mes between 1 and 12),
  ventana_inicio_dia smallint not null default 1  check (ventana_inicio_dia between 1 and 31),
  ventana_fin_mes    smallint not null default 7  check (ventana_fin_mes between 1 and 12),
  ventana_fin_dia    smallint not null default 31 check (ventana_fin_dia between 1 and 31),
  max_simultaneos    smallint not null default 3  check (max_simultaneos > 0),
  anio_activo        smallint not null default 2027 check (anio_activo between 2000 and 2100),
  actualizado_en     timestamptz not null default now()
);

comment on table configuracion is
  'Parámetros globales. Fila única. ventana_* define el rango 1-feb a 31-jul por defecto.';

insert into configuracion (id) values (1);

-- ---------------------------------------------------------------------------
-- administradores
-- La contadora y, si hace falta, un segundo administrador de respaldo. La
-- contraseña se guarda como hash scrypt: `scrypt$<N>$<sal hex>$<derivada hex>`.
-- Nunca en claro, nunca reversible.
-- ---------------------------------------------------------------------------

create table administradores (
  id              uuid primary key default gen_random_uuid(),
  correo          text not null unique check (position('@' in correo) > 1),
  nombre          text not null,
  hash_clave      text not null,
  activo          boolean not null default true,
  creado_en       timestamptz not null default now(),
  ultimo_acceso   timestamptz
);

comment on table administradores is
  'Cuentas del panel. Se crean con `npm run admin:crear`, nunca desde la app.';

-- ---------------------------------------------------------------------------
-- sesiones
-- Solo se guarda el SHA-256 del token. Si alguien lee esta tabla no puede
-- suplantar a nadie, porque el token original no está aquí.
-- ---------------------------------------------------------------------------

create table sesiones (
  hash_token   text primary key,
  admin_id     uuid not null references administradores (id) on delete cascade,
  creada_en    timestamptz not null default now(),
  expira_en    timestamptz not null,
  ultima_ip    text
);

create index sesiones_admin_idx  on sesiones (admin_id);
create index sesiones_expira_idx on sesiones (expira_en);

-- ---------------------------------------------------------------------------
-- centros
-- ---------------------------------------------------------------------------

create table centros (
  id                       uuid primary key default gen_random_uuid(),
  nombre                   text not null unique check (length(btrim(nombre)) > 0),
  correo_contacto          text,
  telefono                 text,
  duracion_dias_laborables smallint not null default 5
                             check (duracion_dias_laborables between 1 and 60),
  activo                   boolean not null default true,
  creado_en                timestamptz not null default now(),
  actualizado_en           timestamptz not null default now()
);

comment on column centros.duracion_dias_laborables is
  'Días laborables que ocupa la preparación del reporte de este centro. Default 5.';

create index centros_activo_nombre_idx on centros (activo, nombre);

-- ---------------------------------------------------------------------------
-- feriados
-- Precargados por la migración 0002 (Ley 139-97). Editables por la contadora.
-- ---------------------------------------------------------------------------

create table feriados (
  fecha           date primary key,
  nombre          text not null,
  anio            smallint not null generated always as
                    (extract(year from fecha)::smallint) stored,
  trasladado      boolean not null default false,
  fecha_original  date,
  creado_en       timestamptz not null default now()
);

comment on column feriados.trasladado is
  'true si la fecha resulta de aplicar el traslado al lunes de la Ley 139-97.';
comment on column feriados.fecha_original is
  'Fecha de calendario del feriado antes del traslado. NULL si no hubo traslado.';

create index feriados_anio_idx on feriados (anio);

-- ---------------------------------------------------------------------------
-- bloqueos
-- Rangos que la contadora inhabilita manualmente (vacaciones, cierres, etc.).
-- ---------------------------------------------------------------------------

create table bloqueos (
  id            uuid primary key default gen_random_uuid(),
  fecha_inicio  date not null,
  fecha_fin     date not null,
  tipo          bloqueo_tipo not null default 'otro',
  descripcion   text,
  creado_por    uuid references administradores (id) on delete set null,
  creado_en     timestamptz not null default now(),
  constraint bloqueos_rango_valido check (fecha_fin >= fecha_inicio)
);

create index bloqueos_rango_idx on bloqueos (fecha_inicio, fecha_fin);

-- ---------------------------------------------------------------------------
-- reservas
-- ---------------------------------------------------------------------------

create table reservas (
  id                       uuid primary key default gen_random_uuid(),
  centro_id                uuid not null references centros (id) on delete restrict,
  anio                     smallint not null,
  fecha_inicio             date not null,
  fecha_fin                date not null,
  duracion_dias_laborables smallint not null check (duracion_dias_laborables between 1 and 60),
  estado                   reserva_estado not null default 'reservada',
  codigo_reserva           text not null unique,
  correo_contacto          text not null,
  telefono                 text not null,
  creado_en                timestamptz not null default now(),
  actualizado_en           timestamptz not null default now(),
  constraint reservas_rango_valido check (fecha_fin >= fecha_inicio),
  constraint reservas_anio_coincide check (extract(year from fecha_inicio)::smallint = anio)
);

-- Regla 5: una reserva por centro por año.
-- Decisión explícita: solo el estado `cancelada` libera el cupo del centro.
-- Una reserva ya `entregada` significa que el trabajo del año se hizo, así que
-- tampoco habilita una segunda reserva en el mismo año.
create unique index reservas_una_por_centro_anio
  on reservas (centro_id, anio)
  where estado <> 'cancelada';

create index reservas_rango_idx  on reservas (fecha_inicio, fecha_fin);
create index reservas_estado_idx on reservas (estado);
create index reservas_anio_idx   on reservas (anio);

-- ---------------------------------------------------------------------------
-- solicitudes_cambio
-- ---------------------------------------------------------------------------

create table solicitudes_cambio (
  id                  uuid primary key default gen_random_uuid(),
  reserva_id          uuid not null references reservas (id) on delete cascade,
  tipo                solicitud_tipo not null,
  nueva_fecha_inicio  date,
  motivo              text not null check (length(btrim(motivo)) > 0),
  estado              solicitud_estado not null default 'pendiente',
  nota_resolucion     text,
  creado_en           timestamptz not null default now(),
  resuelta_en         timestamptz,
  resuelta_por        uuid references administradores (id) on delete set null,
  constraint solicitudes_cambio_requiere_fecha
    check (tipo <> 'cambio' or nueva_fecha_inicio is not null),
  constraint solicitudes_cancelacion_sin_fecha
    check (tipo <> 'cancelacion' or nueva_fecha_inicio is null)
);

-- Una sola solicitud pendiente por reserva a la vez.
create unique index solicitudes_una_pendiente_por_reserva
  on solicitudes_cambio (reserva_id)
  where estado = 'pendiente';

create index solicitudes_estado_idx on solicitudes_cambio (estado, creado_en);

-- ---------------------------------------------------------------------------
-- notificaciones_log
-- ---------------------------------------------------------------------------

create table notificaciones_log (
  id            uuid primary key default gen_random_uuid(),
  reserva_id    uuid references reservas (id) on delete set null,
  canal         text not null,
  destinatario  text not null,
  tipo_evento   text not null,
  enviado_en    timestamptz not null default now(),
  resultado     text not null,
  detalle       text
);

create index notificaciones_log_reserva_idx on notificaciones_log (reserva_id, enviado_en desc);
create index notificaciones_log_evento_idx  on notificaciones_log (tipo_evento, enviado_en desc);

-- ---------------------------------------------------------------------------
-- rate_limit_publico
-- Contador por ventana para el endpoint público de reserva.
-- ---------------------------------------------------------------------------

create table rate_limit_publico (
  clave           text primary key,
  ventana_inicio  timestamptz not null default now(),
  conteo          integer not null default 0
);

-- ---------------------------------------------------------------------------
-- Trigger genérico de actualizado_en
-- ---------------------------------------------------------------------------

create or replace function tocar_actualizado_en()
returns trigger
language plpgsql
as $$
begin
  new.actualizado_en := now();
  return new;
end;
$$;

create trigger centros_actualizado_en
  before update on centros
  for each row execute function tocar_actualizado_en();

create trigger reservas_actualizado_en
  before update on reservas
  for each row execute function tocar_actualizado_en();

create trigger configuracion_actualizado_en
  before update on configuracion
  for each row execute function tocar_actualizado_en();
