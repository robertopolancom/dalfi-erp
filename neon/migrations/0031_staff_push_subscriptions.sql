-- Suscripciones de Web Push del personal, para la bandeja móvil (PWA seben-inbox).
--
-- Por qué aquí y no en Supabase: el bearer que trae la PWA lo emite Supabase, pero la identidad
-- de AGENTE con la que ya trabaja la bandeja es app.staff (ver staffIdByEmail en store.mjs, que
-- resuelve el correo del bearer contra app.staff). Supabase es otra base de datos: una clave
-- foránea contra erp_user_profiles no se puede declarar desde aquí, y mantener la referencia "a
-- mano" sería inventarse una integridad que nadie garantiza. Se referencia lo que sí está en esta
-- base y es lo que de verdad usa el código.
--
-- Un agente puede tener VARIAS suscripciones: el móvil, la tableta del salón, el navegador del
-- escritorio. Por eso la unicidad es por endpoint, no por usuario.
--
-- Sobre p256dh y auth: son las claves con las que se cifra el contenido de cada notificación para
-- ESE dispositivo. No dan acceso a nada del sistema, pero sí permiten a quien las tenga mandarle
-- notificaciones a esa persona. No se registran nunca en logs (ver server/push.mjs) y no deben
-- salir de esta base: si alguna vez otro servicio necesita enviar push, que llame al ERP, no que
-- se lleve estas columnas.

begin;

create table if not exists app.staff_push_subscriptions (
  id uuid primary key default gen_random_uuid(),

  -- A quién avisar. ON DELETE CASCADE a propósito: si alguien deja de ser personal, sus
  -- dispositivos dejan de recibir avisos del negocio en el mismo acto.
  user_id uuid not null references app.staff(id) on delete cascade,

  -- La URL que da el navegador al suscribirse. Es la identidad del DISPOSITIVO y es única en todo
  -- el mundo, así que sirve de clave natural: si el mismo navegador vuelve a suscribirse, se
  -- actualiza su fila en vez de acumular duplicados que luego mandan la misma notificación dos
  -- veces.
  endpoint text not null unique,

  p256dh text not null,
  auth text not null,

  -- Para poder distinguir "el iPhone de Dalfina" de "su navegador del salón" cuando haya que
  -- explicarle por qué le llegan dos avisos. Solo informativo.
  user_agent text,

  created_at timestamptz not null default now(),

  -- Última vez que el servicio de push aceptó un envío. Sirve para limpiar a mano lo que lleve
  -- meses muerto sin esperar a que acumule fallos.
  last_success_at timestamptz,

  -- Fallos consecutivos que NO son 404/410. Un 404 o un 410 significan "esta suscripción ya no
  -- existe" y se borra en el acto; el resto (5xx del servicio de push, red) son pasajeros y no
  -- deben costarle a nadie sus notificaciones al primer tropiezo. A los 5 seguidos se borra.
  fail_count integer not null default 0
);

-- El envío pregunta siempre "las suscripciones de esta persona", nunca "esta suscripción suelta".
create index if not exists staff_push_subscriptions_user_idx
  on app.staff_push_subscriptions (user_id);

commit;
