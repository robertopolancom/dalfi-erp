-- Desde la migración 0024, varias citas 'scheduled' pueden compartir manicurista+horario mientras
-- ninguna esté confirmada -- la primera que se confirme (depósito aprobado o autorización manual)
-- gana el horario real. Hasta ahora, las demás quedaban en el mismo horario ya perdido, esperando
-- a que el personal chocara con appointments_no_staff_overlap al intentar confirmarlas para
-- enterarse del conflicto. A partir de ahora, resolveDisplacedAppointments (server/store.mjs) las
-- reasigna automáticamente al horario libre más cercano ese mismo día apenas la ganadora se
-- confirma, y deja aquí registrado desde/hacia dónde se movió, para que:
--   1. el calendario pinte "Cita movida" (ver GET /api/reservapp/agenda) y el personal sepa que
--      debe escribirle a la clienta a confirmar si el nuevo horario le sirve.
--   2. la propia clienta vea el aviso al ir a subir su comprobante de depósito (ver GET
--      /api/reservapp/my-appointments + depositUploadControl en outputs/reservar/app.js).
-- null = nunca se movió (el caso normal). No se toca si no cupo ningún horario libre ese mismo
-- día -- en ese caso la cita se deja en conflicto para que el personal la reprograme a mano.
alter table app.appointments
  add column if not exists moved_from jsonb null;
