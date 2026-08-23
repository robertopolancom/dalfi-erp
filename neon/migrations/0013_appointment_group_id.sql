begin;

-- Servicios combinados con distinta manicurista por servicio (ej. servicio 1 con Ana, servicio
-- 2 con Jaimely porque Ana no tenía espacio) no caben en una sola fila de app.appointments --
-- staff_id es una sola columna, no soporta varias colaboradoras. En vez de forzar un modelo de
-- una cita con múltiples colaboradoras (cambio de esquema mucho más grande), se crean varias
-- filas de appointments consecutivas -- una por servicio+colaboradora -- y se vinculan con este
-- group_id compartido para que el personal las vea como una sola visita en la agenda. Nullable
-- y sin default: una cita de un solo servicio (el caso de siempre) no lo necesita y queda NULL.
alter table app.appointments
  add column if not exists group_id uuid;

create index if not exists appointments_group_idx on app.appointments (group_id) where group_id is not null;

commit;
