# Separación gradual del dominio de inventario

## Contrato actual

- Lectura autenticada: `GET /api/database-domain?domain=inventario`.
- Simulación sin escritura: `POST /api/database-domain?domain=inventario&dryRun=1`.
- Guardado aislado (implementado localmente): `PUT /api/database-domain?domain=inventario&commit=1`.
- Ambos endpoints requieren JWT válido y perfil ERP activo.
- El origen temporal sigue siendo `erp_records` con `service_role` en el servidor.
- El slice no expone `facturas`, pagos ni facturación de servicios.
- El `dry-run` devuelve `allowed`, `reason`, tablas cambiadas, dominios y `updatedAt`.
- El `dry-run` nunca ejecuta RPC, guardado ni auditoría de persistencia.
- El guardado aislado fusiona solo `inventario` e `inventarioMovimientos`, usa el
  RPC optimista y registra auditoría server-side.
- El cuerpo máximo del `dry-run` es 2 MB.

## Autorización verificada

- Operador sin `canManageInventory`: lectura permitida, simulación de cambio rechazada.
- Perfil autorizado con `canManageInventory`: simulación aprobada.
- Versión obsoleta: respuesta `409`; no se continúa la simulación.
- Cuerpo excesivo: respuesta `413` antes de leer `erp_records`.

## Secuencia pendiente

1. Comparar el slice con una futura tabla propia de inventario.
2. Mantener doble lectura temporal y registrar divergencias técnicas.
3. Validar el guardado aislado en un entorno autenticado antes de publicarlo.
4. Implementar escritura por dominio para las demás operaciones de inventario
   solo después de validar la comparación.
5. Mantener efectos de facturación de servicios fuera de este contrato.
6. Retirar gradualmente la escritura monolítica únicamente con migración coordinada,
   respaldo verificable y pruebas E2E completas.

## Riesgos pendientes

- La separación física de tablas todavía no está implementada.
- El fallback de la SPA continúa cargando el documento completo.
- El `dry-run` no sustituye la autorización del guardado real.
- Push, despliegue, cambios de secretos y endurecimiento adicional de RLS requieren
  una sesión operativa con verificación explícita.
