-- Los adjuntos de WhatsApp dejan de depender de Chatwoot.
--
-- Hasta ahora, cuando alguien mandaba una foto --el comprobante de un depósito, la referencia
-- de un diseño, una captura-- el bridge la bajaba de Meta y la subía a Chatwoot, porque era el
-- único sitio donde el personal podía verla. La bandeja del ERP registraba que había llegado
-- algo (message_type='image') pero no el contenido, así que apagar Chatwoot habría dejado esas
-- fotos inalcanzables.
--
-- Se guarda el archivo en la propia tabla, en base64, que es exactamente lo que ya hace
-- app.appointment_deposit_receipts.image_data desde la migración 0018. Misma decisión y por el
-- mismo motivo: son pocos archivos, pequeños, y montar almacenamiento aparte para esto costaría
-- más de lo que ahorra. Con la misma consecuencia, además: hay que purgarlos, y por eso la
-- columna admite null desde el principio -- un adjunto purgado deja la fila y su registro, solo
-- pierde el contenido. Ver 0019 para el precedente.
--
-- media_url se queda: sirve para un adjunto que viva fuera (si algún día se usa almacenamiento
-- externo) y para no perder la referencia de Meta cuando exista.

begin;

alter table app.chat_messages add column if not exists media_data text;
alter table app.chat_messages add column if not exists media_mime text;
alter table app.chat_messages add column if not exists media_filename text;

-- Para poder encontrar rápido lo que hay que purgar sin recorrer todo el historial. Solo indexa
-- las filas que de verdad ocupan espacio.
create index if not exists chat_messages_con_adjunto_idx
  on app.chat_messages (created_at)
  where media_data is not null;

commit;
