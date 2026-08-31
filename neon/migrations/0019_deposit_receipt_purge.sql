-- Limpieza automática del comprobante de depósito: 5 días después de que una cita quede
-- Atendida o Cancelada, se borra SOLO la foto (image_data/mime_type) -- la fila se queda
-- (reviewed_by/reviewed_at/review_note) como rastro de auditoría de quién confirmó el depósito y
-- cuándo. Ver purgeExpiredDepositReceipts en server/store.mjs y
-- workers/deposit-receipt-purge-cron/. image_data era NOT NULL desde la migración 0018 -- deja de
-- serlo para poder representar "ya se purgó" sin ambigüedad (nunca una cadena vacía como señal).
alter table app.appointment_deposit_receipts alter column image_data drop not null;
alter table app.appointment_deposit_receipts alter column mime_type drop not null;
