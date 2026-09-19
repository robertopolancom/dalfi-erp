-- Registro nuevo sin datos hasta después del código (2026-09-19).
--
-- La 0017 exigía que un registro pendiente trajera la ficha del ERP o los datos de la persona
-- (check existing_client_id is not null or registration is not null). Desde el 2026-09-18 el código
-- se pide SOLO con el teléfono, para no revelar si alguien es cliente, y los datos se piden
-- después de verificar el código (ver server/app.mjs, /auth/request-code). Con esa regla, TODO
-- cliente nuevo recibía "Error interno del servidor" al pedir el código.
--
-- Se puede quitar sin riesgo: completePendingRegistration (server/store.mjs) ya se niega a crear
-- la cuenta si no hay ficha ni datos (PENDING_REGISTRATION_NEEDS_PROFILE). La regla sigue, pero en
-- el momento correcto.
alter table app.reservapp_pending_registrations
  drop constraint if exists reservapp_pending_registrations_check;
