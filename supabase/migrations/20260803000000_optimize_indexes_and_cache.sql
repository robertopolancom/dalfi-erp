-- Optimización de índices y cache (DALFI ERP)
--
-- erp_records ya tiene un índice único sobre (table_name, record_key). Ese
-- índice cubre las lecturas actuales por ambas columnas; un índice adicional
-- solo sobre table_name duplica entradas y encarece cada guardado del
-- documento JSON completo.
drop index if exists public.erp_records_table_name_idx;

-- La bitácora se consulta normalmente por acción y por rango/orden temporal.
-- El índice compuesto evita combinar dos índices y conserva el recorrido más
-- reciente primero para reportes y revisiones de auditoría.
create index if not exists erp_audit_log_action_created_at_idx
  on public.erp_audit_log (action, created_at desc);
drop index if exists public.erp_audit_log_action_idx;

-- Consultas de trazabilidad por usuario (cierres, facturas y cambios de
-- permisos) también deben poder recuperar rápidamente lo más reciente.
create index if not exists erp_audit_log_user_created_at_idx
  on public.erp_audit_log (user_id, created_at desc)
  where user_id is not null;
