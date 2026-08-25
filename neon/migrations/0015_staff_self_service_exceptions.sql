-- Autoservicio de disponibilidad: cada manicurista/asistente puede marcar sus propios días u
-- horas no disponibles desde ReservApp (antes solo lo podía hacer administración desde
-- Configuración de usuarios). created_by distingue quién hizo el último cambio de esa fila, para
-- que administración pueda ver un listado de "cambios recientes hechos por el propio personal"
-- sin tener que revisar colaboradora por colaboradora.

alter table app.staff_schedule_exceptions add column if not exists created_by text not null default 'admin';
alter table app.staff_schedule_exceptions add column if not exists updated_at timestamptz not null default now();
