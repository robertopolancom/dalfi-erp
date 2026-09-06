-- Imágenes de las páginas públicas, subidas desde el panel "Página web" del ERP. Hasta ahora las
-- fotos de dalfistudio.com eran archivos dentro de outputs/dalfistudionails/assets/, así que
-- cambiar una foto exigía tocar el repositorio y desplegar -- justo lo que el panel existía para
-- evitar con los textos. Con esto, el personal sube y cambia fotos sin pasar por código.
--
-- Se guarda el base64 en una columna text, igual que app.appointment_deposit_receipts
-- (migración 0018): mismo patrón ya probado en este proyecto, sin sumar un bucket de objetos ni
-- otro proveedor. Las fotos de una landing son pocas y pequeñas; si algún día son muchas, esto se
-- muda a R2 sin tocar el resto (el sitio solo conoce el id, nunca dónde está guardado).
--
-- El id es un uuid y el contenido de una fila NUNCA cambia (para reemplazar una foto se sube otra
-- y se apunta al id nuevo), así que la ruta pública puede cachear de forma inmutable.
create table if not exists app.site_media (
  id uuid primary key default gen_random_uuid(),
  site_key text not null,
  image_data text not null,
  mime_type text not null,
  byte_size integer not null,
  -- Texto alternativo: accesibilidad y SEO. Va aquí y no en el JSON del contenido porque
  -- describe la imagen en sí, no el sitio donde se use -- la misma foto reutilizada en dos
  -- secciones se describe igual.
  alt_text text not null default '',
  created_at timestamptz not null default now(),
  created_by text
);

-- El panel lista las imágenes de un sitio, la más reciente primero.
create index if not exists site_media_site_key_created_idx
  on app.site_media (site_key, created_at desc);
