-- Bandeja de mensajes dentro del ERP, para dejar de depender de Chatwoot.
--
-- Por qué existe: hasta ahora el texto de las conversaciones de WhatsApp solo vivía en
-- Chatwoot, un Rails que exige ~4 GB y obliga a sostener un servidor entero solo para poder
-- leer y responder. El bridge (~/dalfi-chatbot-n8n) ya sabía CUÁNDO hacía falta un humano
-- --guarda estado de conversación y transferencias en su state.json-- pero no guardaba lo
-- que la clienta escribió. Estas dos tablas son ese hueco, y al vivir en Neon junto a
-- app.clients y app.appointments permiten algo que Chatwoot nunca pudo: ver la conversación
-- al lado de la ficha de la clienta y de sus citas.
--
-- Diseño deliberado:
--   * El teléfono es la identidad, no el client_id. Mucha gente escribe antes de existir
--     como clienta, y esos mensajes no se pueden perder. client_id se rellena después,
--     cuando se le da de alta, sin tocar el historial ya guardado.
--   * Nada de borrado en cascada hacia los mensajes: si se elimina una clienta, la
--     conversación queda huérfana pero legible. Un historial de WhatsApp es prueba de lo
--     que se acordó con alguien; perderlo por un alta mal hecha sería peor que el huérfano.

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Conversaciones: una por número de teléfono
-- ---------------------------------------------------------------------------
create table if not exists app.chat_conversations (
  id uuid primary key default gen_random_uuid(),

  -- Identidad real de la conversación. Normalizado igual que app.client_phones para que
  -- el mismo número escrito de diez formas distintas sea una sola conversación.
  phone_normalized text not null unique,

  -- Se rellena cuando se identifica a la persona. Null es normal y esperado: alguien
  -- escribe, todavía no es clienta. ON DELETE SET NULL a propósito -- ver cabecera.
  client_id uuid references app.clients(id) on delete set null,

  -- Nombre que mostró WhatsApp. Sirve para tener algo que enseñar antes de que exista
  -- ficha de clienta. No es autoritativo: si hay client_id, manda el nombre de la ficha.
  wa_profile_name text,

  -- Estado de la máquina del bridge (SALUDO, TRANSFERENCIA_SOLICITADA, etc.). Se copia
  -- aquí para poder ordenar y filtrar la bandeja sin consultar al bridge.
  bot_state text,

  -- El interruptor que importa. true = el bot dejó de responder y espera a una persona.
  -- Es lo que pinta la bandeja en rojo y lo que ordena la lista.
  needs_human boolean not null default false,
  handoff_reason text,
  handoff_requested_at timestamptz,

  -- Quién la tomó. Null aunque needs_human sea true = nadie la ha atendido todavía.
  assigned_staff_id uuid references app.staff(id) on delete set null,

  -- Para ordenar por actividad y calcular no leídos sin recorrer los mensajes.
  last_message_at timestamptz,
  last_message_preview text,
  staff_last_read_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- La bandeja se abre muchas veces al día y siempre pide lo mismo: lo que espera a un
-- humano primero, y dentro de eso lo más reciente arriba.
create index if not exists chat_conversations_bandeja_idx
  on app.chat_conversations (needs_human desc, last_message_at desc nulls last);

create index if not exists chat_conversations_client_idx
  on app.chat_conversations (client_id)
  where client_id is not null;

-- ---------------------------------------------------------------------------
-- Mensajes: el historial que hoy solo vive en Chatwoot
-- ---------------------------------------------------------------------------
create table if not exists app.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references app.chat_conversations(id) on delete cascade,

  -- 'in'  = lo escribió la clienta
  -- 'out' = salió del negocio (el bot o una persona; los distingue sender_type)
  direction text not null check (direction in ('in', 'out')),

  -- Quién lo produjo. 'staff' es el caso que Chatwoot cubría y que ahora cubrimos aquí.
  sender_type text not null check (sender_type in ('cliente', 'bot', 'staff', 'sistema')),
  sender_staff_id uuid references app.staff(id) on delete set null,

  body text,

  -- 'text' cubre casi todo. Los demás quedan registrados aunque no se rendericen todavía:
  -- perder el registro de que llegó una foto sería peor que no poder verla aún.
  message_type text not null default 'text'
    check (message_type in ('text', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'unsupported')),
  media_url text,

  -- Id de WhatsApp (wamid). Es la defensa contra duplicados: Meta reintenta la entrega de
  -- un webhook si no recibe 200 a tiempo, y sin esto el mismo mensaje entraría dos veces.
  -- Null para lo que sale del ERP y todavía no tiene id asignado por Meta.
  wa_message_id text unique,

  -- Estado de entrega para lo que sale. La clienta no ve esto; el personal sí necesita
  -- saber si su respuesta salió o se quedó atascada.
  delivery_status text not null default 'received'
    check (delivery_status in ('received', 'pending', 'sent', 'delivered', 'read', 'failed')),
  delivery_error text,

  -- Cola de salida que ya existía (migración 0010) y que se reutiliza en vez de crear otra.
  outbox_id uuid references app.reservapp_whatsapp_outbox(id) on delete set null,

  created_at timestamptz not null default now()
);

-- Abrir un hilo = leer sus mensajes en orden. Es la consulta más frecuente de la bandeja.
create index if not exists chat_messages_hilo_idx
  on app.chat_messages (conversation_id, created_at);

-- Contar no leídos por conversación sin recorrer todo el historial.
create index if not exists chat_messages_no_leidos_idx
  on app.chat_messages (conversation_id, created_at)
  where direction = 'in';
