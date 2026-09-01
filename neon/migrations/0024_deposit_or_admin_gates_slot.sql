-- Hasta ahora, toda cita nueva bloqueaba su horario desde el momento en que se creaba (status
-- 'scheduled'), sin importar si el depósito de RD$500 se había confirmado o no -- eso permitía
-- que reservas nunca confirmadas (la clienta nunca sube el comprobante, nunca llega) siguieran
-- ocupando el horario indefinidamente, sin que nadie más pudiera tomarlo.
--
-- A partir de ahora, una cita solo "aparta" su horario cuando pasa a status='confirmed' (o ya
-- 'completed') -- y a esos dos estados solo se llega por una de dos vías manuales:
--   1. el personal aprueba el comprobante de depósito (reviewDepositReceipt en server/store.mjs,
--      que ahora también pone status='confirmed' al aprobar), o
--   2. el personal autoriza la cita manualmente sin depósito (setAppointmentStatus, mismo
--      endpoint /api/reservapp/agenda/appointments/:id/status que ya existía).
-- Mientras una cita siga en 'scheduled' (recién creada, por cualquier canal), varias reservas
-- pueden coexistir sobre el mismo horario sin chocar entre sí -- la primera que el personal
-- confirme gana el horario; las demás quedan para reprogramar (ver el manejo de la violación de
-- este mismo constraint en reviewDepositReceipt/setAppointmentStatus).
alter table app.appointments
  drop constraint if exists appointments_no_staff_overlap;
alter table app.appointments
  add constraint appointments_no_staff_overlap
  exclude using gist (
    staff_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (staff_id is not null and status in ('confirmed','completed') and confirmation_status is distinct from 'EspacioLiberado');
