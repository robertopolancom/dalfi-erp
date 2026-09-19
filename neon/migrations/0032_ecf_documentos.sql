-- e-CF: comprobantes fiscales electrónicos emitidos y secuencias autorizadas (fase C, 2026-09-18).
--
-- Por qué tablas propias y no el documento JSON del ERP: el e-CF es un registro fiscal que no se
-- edita ni se borra. Lo que se emitió queda aquí con su estado ante la DGII, su TrackId y la
-- respuesta del proveedor, aunque la factura del ERP se edite después. Anular es emitir una nota de
-- crédito (E34) que referencia al original, no cambiar este registro.
--
-- La SECUENCIA de e-NCF es del contribuyente, no del PSFE: la DGII autoriza rangos por tipo y aquí
-- se reparten de forma atómica (sin huecos ni duplicados, aunque dos cajas facturen a la vez). Si
-- se cambia de proveedor, el nuevo sigue desde "siguiente".
--
-- Aditiva e idempotente: se puede correr dos veces sin romper nada.

create table if not exists app.ecf_secuencias (
  tipo text primary key check (tipo in ('31','32','33','34')),
  siguiente bigint not null check (siguiente >= 1),
  hasta bigint not null,
  vence date,
  actualizado_en timestamptz not null default now(),
  check (siguiente <= hasta + 1)
);

create table if not exists app.ecf_documentos (
  id uuid primary key default gen_random_uuid(),
  -- De dónde sale: una factura de servicios, una venta directa de productos, o una nota de crédito.
  origen text not null check (origen in ('factura','venta','nota_credito')),
  origen_id text not null,
  tipo text not null check (tipo in ('31','32','33','34')),
  encf text not null unique check (encf ~ '^E(31|32|33|34)[0-9]{10}$'),
  -- Con qué adaptador salió: las que queden en proceso se consultan con ESE proveedor.
  proveedor text not null,
  estado text not null default 'pendiente'
    check (estado in ('pendiente','en_proceso','aceptado','aceptado_condicional','rechazado','error')),
  track_id text,
  codigo_seguridad text,
  fecha_firma timestamptz,
  -- Para una nota de crédito: el e-NCF que modifica.
  referencia_encf text,
  documento jsonb not null,
  respuesta jsonb,
  intentos integer not null default 0,
  proximo_intento timestamptz not null default now(),
  ultimo_error text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

-- Una factura o venta tiene UN comprobante principal; si se rechaza, se corrige y se vuelve a
-- intentar con el mismo registro. Las notas de crédito pueden ser varias.
create unique index if not exists ecf_documentos_un_principal
  on app.ecf_documentos (origen, origen_id)
  where origen in ('factura','venta');

create index if not exists ecf_documentos_cola
  on app.ecf_documentos (proximo_intento)
  where estado in ('pendiente','en_proceso','error');
