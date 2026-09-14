-- El estado del chatbot deja de vivir en un archivo dentro de la Mac.
--
-- Hasta ahora el bridge guardaba las conversaciones en /data/state.json, un archivo dentro de su
-- contenedor. Eso ataba el chatbot a la Mac de Roberto: si se cerraba, el bot se caía, y de hecho
-- llevaba caído (502) cuando se revisó el 2026-09-13. Mover el bridge a Cloud Run obliga a sacar
-- ese archivo de ahí, porque en Cloud Run el disco es efímero y el servicio se apaga cuando no
-- hay tráfico: cada arranque empezaría sin memoria de ninguna conversación, y una clienta a la
-- que se le pidió el comprobante volvería a empezar desde cero.
--
-- Se guarda el snapshot completo en una sola fila, no una tabla por entidad. Dos razones: el
-- estado real pesa unos 9 KB (medido sobre scratch/state.json), y el bridge ya lo serializa
-- entero en cada escritura, así que replicar esa forma es el cambio de menor riesgo -- el
-- repositorio del bridge no cambia de semántica, solo de destino. Si algún día el estado crece
-- hasta doler, esta tabla se parte en varias sin tocar el bridge.
--
-- El bridge NO se conecta a esta base: escribe a través del ERP (GET/PUT /api/booking/bridge-state,
-- autenticado con el mismo x-chatbot-secret que ya usa para reservar). Así el bridge sigue sin
-- una sola dependencia npm y no hay que repartirle credenciales de base de datos.
--
-- updated_by deja rastro de qué instancia escribió por última vez: con max-instances=1 en Cloud
-- Run no debería haber dos, y si algún día aparecen dos valores alternándose, es la señal de que
-- alguien subió el límite y el estado se está pisando.

begin;

create table if not exists app.chatbot_bridge_state (
  id boolean primary key default true,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by text,
  constraint chatbot_bridge_state_singleton check (id)
);

insert into app.chatbot_bridge_state (id, state)
values (true, '{}'::jsonb)
on conflict (id) do nothing;

commit;
