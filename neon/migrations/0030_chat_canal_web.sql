-- El chat "Dalfi" del sitio público (dalfistudionails) entra en la MISMA bandeja que WhatsApp.
--
-- El problema que resuelve esta migración: la bandeja nació con el teléfono como identidad
-- (`phone_normalized text not null unique`, migración 0026), y esa decisión era correcta para
-- WhatsApp -- ahí todo el mundo tiene número y es la única identidad estable que da Meta. Pero
-- quien abre la página web no tiene teléfono, y no se le puede pedir uno antes de contestarle
-- "¿a qué hora abren?". Sin esto, la única salida era inventarle un teléfono falso, que
-- envenenaría el emparejamiento con app.client_phones y las fichas de clientas.
--
-- La identidad pasa a ser "una de las dos, según el canal":
--   * whatsapp -> phone_normalized (como hasta hoy, sin cambios para las filas existentes)
--   * web      -> web_session_id, un identificador opaco que genera el navegador
--
-- Cada uno con su índice único PARCIAL, no una restricción única compartida: así dos visitantes
-- anónimos distintos no colisionan entre sí por tener los dos el teléfono en null.
--
-- OJO al hacer consultas: `on conflict (phone_normalized)` a secas YA NO infiere el índice,
-- porque ahora es parcial. Hay que escribir el predicado
-- (`on conflict (phone_normalized) where phone_normalized is not null`). El upsert de
-- NeonChatStore.ingest se actualizó junto con esta migración por esa razón exacta; si alguien
-- aplica el SQL sin el código, la ingesta de WhatsApp deja de funcionar.

begin;

alter table app.chat_conversations
  add column if not exists channel text not null default 'whatsapp';

-- Identificador de sesión del navegador. Opaco y generado en el cliente: no es una identidad
-- verificada, solo sirve para que el visitante recupere SU hilo mientras tenga la pestaña (o el
-- localStorage) vivo. Nunca debe usarse para autorizar nada.
alter table app.chat_conversations
  add column if not exists web_session_id text;

-- Nombre que la persona escribe en el widget, cuando lo escribe. El equivalente web de
-- wa_profile_name: algo que enseñar en la bandeja antes de saber quién es.
alter table app.chat_conversations
  add column if not exists web_display_name text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'app.chat_conversations'::regclass
       and conname = 'chat_conversations_channel_check'
  ) then
    alter table app.chat_conversations
      add constraint chat_conversations_channel_check
      check (channel in ('whatsapp', 'web'));
  end if;
end $$;

-- La restricción única original venía declarada en línea (`... text not null unique`), así que
-- Postgres la nombró chat_conversations_phone_normalized_key. Se sustituye por el índice parcial.
alter table app.chat_conversations
  drop constraint if exists chat_conversations_phone_normalized_key;

alter table app.chat_conversations
  alter column phone_normalized drop not null;

create unique index if not exists chat_conversations_phone_idx
  on app.chat_conversations (phone_normalized)
  where phone_normalized is not null;

create unique index if not exists chat_conversations_web_session_idx
  on app.chat_conversations (web_session_id)
  where web_session_id is not null;

-- Una conversación sin ninguna de las dos identidades no es alcanzable por nadie: ni se le puede
-- contestar, ni el visitante puede volver a ella. Mejor que la base lo impida a que aparezca una
-- fila muerta en la bandeja.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'app.chat_conversations'::regclass
       and conname = 'chat_conversations_identidad_check'
  ) then
    alter table app.chat_conversations
      add constraint chat_conversations_identidad_check
      check (phone_normalized is not null or web_session_id is not null);
  end if;
end $$;

-- Para que la bandeja pueda filtrar "las de la web" sin recorrer la tabla entera.
create index if not exists chat_conversations_channel_idx
  on app.chat_conversations (channel, last_message_at desc);

commit;
