-- Retiro gradual del permiso legado can_manage_invoices.
--
-- La columna se conserva temporalmente para compatibilidad con perfiles y
-- consumidores SQL anteriores, pero la SPA, /api/database y la
-- administracion de usuarios ya no la usan para autorizar ningun dominio.
-- Facturacion, inventario, nomina, cuentas, configuracion, reservas y cada
-- etapa de cierres tienen permisos especificos.

comment on column public.erp_user_profiles.can_manage_invoices is
  'OBSOLETO: conservado temporalmente por compatibilidad. No usar para nuevas autorizaciones; aplicar el permiso especifico de cada dominio.';

comment on function public.has_erp_permission(text) is
  'Consulta permisos del perfil activo. can_manage_invoices es una clave obsoleta conservada temporalmente solo por compatibilidad.';
