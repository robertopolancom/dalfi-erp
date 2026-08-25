-- Motor de recordatorios de confirmación de asistencia (portado desde
-- outputs/lib/booking-engine.js / functions/api/booking/send-reminders.js, que dependían del
-- proyecto de Cloudflare Pages "dalfi-erp" ya eliminado). Aplica a TODAS las citas, sin importar
-- canal de origen -- ver server/app.mjs checkConfirmationReminder.

alter table app.appointments add column if not exists first_reminder_sent_at timestamptz;

-- Una cita en confirmation_status='EspacioLiberado' (segundo recordatorio enviado sin respuesta)
-- deja de bloquear su horario para otras reservas -- igual que 'cancelled'/'replaced' ya hacían.
-- Si nadie más lo toma y la clienta confirma después, confirmAppointmentAttendance() la regresa a
-- 'HoraConfirmada' sin haber perdido nunca la fila ni el historial.
alter table app.appointments
  drop constraint if exists appointments_no_staff_overlap;
alter table app.appointments
  add constraint appointments_no_staff_overlap
  exclude using gist (
    staff_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (staff_id is not null and status not in ('cancelled','replaced') and confirmation_status is distinct from 'EspacioLiberado');
