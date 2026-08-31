-- Comprobante de depósito para confirmar una cita de ReservApp (RD$500, ya exigido desde la
-- creación de la cita vía deposit_status/deposit_amount en app.appointments -- ver
-- server/store.mjs). Lo que faltaba era dónde guardar la foto que sube la clienta y quién/cuándo
-- la revisó el personal. Tabla 1:1 con la cita, no historial -- si se rechaza y se vuelve a
-- subir, se sobrescribe la misma fila (mismo criterio de simplicidad que el resto del esquema).
create table if not exists app.appointment_deposit_receipts (
  appointment_id uuid primary key references app.appointments(id) on delete cascade,
  image_data text not null,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  uploaded_at timestamptz not null default now(),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text
);
