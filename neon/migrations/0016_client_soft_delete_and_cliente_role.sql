-- Dos cambios que pide "Configuración de usuarios" del panel de administración:
--
-- 1. "Borrar cliente" es un borrado LÓGICO (status='deleted'), no un delete físico. La ficha
--    deja de existir para todo lo vivo (búsqueda, reservas, duplicados, listado) pero sus citas,
--    facturas e ingresos quedan intactos -- borrarlos de verdad descuadraría la contabilidad
--    histórica. Si esa persona vuelve al salón, se registra de cero y recibe un id nuevo: el id
--    viejo queda muerto, colgando solo del historial. Para que ese "registrarse de cero" sea
--    posible, la unicidad de correo pasa a aplicar únicamente entre clientes NO borrados; el
--    teléfono se filtra igual pero en la consulta de duplicados (nunca tuvo índice único).
--
-- 2. El rol 'clienta' pasa a llamarse 'cliente' -- el salón atiende hombres también, y el rol
--    salía tal cual en el selector de roles del panel. Es un rename de datos + CHECK, no un
--    cambio de estructura.
--
-- Orden de despliegue: esta migración primero, backend después, frontends al final. Entre la
-- migración y el deploy del backend las cuentas de cliente quedan con rol 'cliente' y el código
-- viejo compara contra 'clienta' -- durante esa ventana una clienta con sesión abierta ve la
-- agenda del equipo en vez de la suya. Correr la migración fuera de horario de atención.

begin;

-- 1. Rol 'clienta' -> 'cliente'.
--
-- Los dos CHECK de reservapp_accounts que mencionan el rol se crearon sin nombre en la
-- migración 0010, así que Postgres los autonombró; se buscan por definición en vez de por
-- nombre para no depender de ese autonombrado, y se recrean con nombre explícito.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname from pg_constraint
     where conrelid = 'app.reservapp_accounts'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%clienta%'
  loop
    execute format('alter table app.reservapp_accounts drop constraint %I', constraint_name);
  end loop;
end $$;

update app.reservapp_accounts set role = 'cliente', updated_at = now() where role = 'clienta';

alter table app.reservapp_accounts
  add constraint reservapp_accounts_role_check
  check (role in ('cliente','manicurista','asistente','administradora','superadministrador'));

alter table app.reservapp_accounts
  add constraint reservapp_accounts_role_owner_check
  check ((role = 'cliente' and client_id is not null and staff_id is null)
      or (role <> 'cliente' and staff_id is not null and client_id is null));

-- 2. Borrado lógico de clientes.
--
-- app.clients.status no tiene CHECK (es texto libre), así que 'deleted' no necesita cambio de
-- estructura -- pero sí hace falta que deje de bloquear el registro de un cliente nuevo con el
-- mismo correo. El índice de 0001 cubría toda fila con correo; ahora excluye las borradas.
drop index if exists app.clients_email_unique;
create unique index if not exists clients_email_unique
  on app.clients (lower(email))
  where email is not null and btrim(email) <> '' and status <> 'deleted';

-- La búsqueda de clientes (searchClients, resolveClient, duplicados) filtra por status en cada
-- consulta; este índice evita que ese filtro extra cueste un scan en la tabla completa.
create index if not exists clients_status_idx on app.clients (status);

commit;
