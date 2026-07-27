# Especificación de emulación para Claude Code

Esta especificación permite reproducir localmente la lógica operativa de
SeBen Service sin usar producción. La emulación debe cubrir todo el sistema
excepto la facturación de servicios.

## Alcance incluido

Claude Code debe poder emular:

- autenticación Supabase y sesiones JWT;
- perfiles activos e inactivos;
- roles y permisos específicos;
- `/api/me`;
- `/api/database` con control optimista;
- autorización por dominio;
- auditoría server-side;
- venta de productos;
- inventario por ubicación;
- lotes, vencimientos y FEFO;
- compras y transferencias de inventario;
- consumos internos y de Academia;
- entregas a colaboradoras y mesas;
- pagos en efectivo, tarjeta y transferencias;
- transferencias pendientes de confirmar;
- crédito y cuentas por cobrar;
- nómina, propinas y pagos a colaboradoras;
- cuentas, ingresos, egresos y tesorería;
- cierres de caja y tesorería;
- Worker de cierres automáticos;
- idempotencia y control de doble conteo;
- reportes;
- RLS y bloqueo de llamadas directas;
- interfaz de solo lectura por permisos;
- auditoría y verificación de logs.

## Exclusión explícita

No emular ni ejecutar:

- creación de facturas de servicios;
- edición de facturas de servicios;
- pagos productivos de facturas de servicios;
- datos reales de clientes o colaboradoras;
- cierres históricos reales;
- llamadas a dominios `*.pages.dev` o Supabase productivo;
- secretos reales, tokens reales o contraseñas reales.

La venta de productos sí se emula como un flujo independiente y nunca debe
mezclarse con una factura de servicios.

## Entorno aislado obligatorio

Usar una de estas opciones:

1. Supabase local + Wrangler Pages Dev.
2. Un proyecto Supabase staging dedicado.
3. Fixtures puros en memoria para pruebas unitarias.

Variables esperadas para el modo autenticado local:

```sh
E2E_AUTH_LOCAL=1
E2E_AUTH_BASE_URL=http://127.0.0.1:8788
E2E_AUTH_EMAIL=<usuario-local>
E2E_AUTH_PASSWORD=<contraseña-local>
```

Las credenciales deben llegar por variables de entorno o Keychain. Nunca se
escriben en archivos, fixtures, commits ni informes.

## Estado mínimo inicial

Crear solo datos sintéticos:

- un administrador activo con todos los permisos;
- un operador activo sin `canManageBilling` ni `canManageInventory`;
- un contador con permisos de revisión;
- una cuenta de efectivo;
- una cuenta bancaria;
- un artículo vendible con stock;
- un artículo sin stock;
- una ubicación activa que permita venta;
- una ubicación inactiva;
- un lote vigente;
- un lote vencido;
- un cliente sintético para crédito;
- un colaborador sintético para nómina.

No crear fixtures de facturación de servicios.

## Contratos que deben respetarse

### `/api/me`

Debe devolver únicamente la identidad validada por servidor:

```json
{
  "userId": "...",
  "email": "...",
  "role": "operador",
  "isActive": true,
  "permissions": {}
}
```

El navegador no puede elegir `role`, `isActive` ni permisos.

### `/api/database`

- `GET` requiere JWT y perfil activo.
- `PUT` requiere JWT y perfil activo.
- `expectedUpdatedAt` debe coincidir.
- El servidor detecta dominios modificados.
- Cada dominio se autoriza por permiso específico.
- Una mutación no autorizada devuelve `403`.
- Un conflicto de versión devuelve `409`.
- El guardado autorizado genera auditoría.
- El navegador nunca invoca directamente la RPC de guardado.

### Dominios de autorización

| Dominio | Permiso |
|---|---|
| Reservas | `canManageReservations` |
| Venta de productos | `canManageInventory` |
| Inventario | `canManageInventory` |
| Nómina | `canManagePayroll` |
| Cuentas | `canManageAccounts` |
| Configuración | `canManageConfiguration` |
| Facturación de servicios | Fuera de alcance |
| Cierres | permisos específicos de cierre |
| Auditoría | `canReviewAudit` |

`canManageInvoices` es legado y no debe utilizarse como llave maestra.

## Flujos que Claude Code debe reproducir

### Venta de productos

1. Seleccionar artículo vendible.
2. Seleccionar ubicación activa autorizada.
3. Validar stock de esa ubicación.
4. Rechazar stock insuficiente.
5. Calcular descuento e impuesto.
6. Registrar forma de pago.
7. Crear venta en `ventasDirectas`.
8. Crear movimiento de salida.
9. Crear pago o CxC según corresponda.
10. Crear auditoría.
11. Repetir el mismo request y no duplicar movimientos.

La venta de productos debe usar una clave idempotente estable por venta,
artículo, ubicación y lote.

### Transferencia pendiente

1. Registrar transferencia como pendiente.
2. No tratarla como ingreso confirmado.
3. Mostrar advertencia de confirmación.
4. Confirmarla una sola vez.
5. Si no se confirma, convertir el saldo en crédito.
6. Auditar cada transición.

### Crédito y cuentas por cobrar

- El crédito requiere cliente.
- La transferencia pendiente requiere cliente.
- Los pagos se aplican FIFO.
- La CxC debe indicar si proviene de producto.
- Una CxC revertida no debe volver a cobrarse.

### Inventario

- Nunca permitir negativo silencioso.
- Validar ubicación por línea.
- No usar ubicación de respaldo automática.
- No duplicar movimiento de salida.
- FEFO debe ignorar lotes vencidos.
- La reversión restaura el movimiento original.
- Los movimientos son inmutables; se corrigen con movimientos inversos.

### Nómina

- El operador no puede modificar nómina.
- `canManagePayroll` es independiente de `canManageInvoices`.
- Los pagos y propinas deben auditarse.
- Las CxC de colaboradoras no se mezclan con CxC de clientes.

### Cuentas y cierres

- Separar efectivo de banco.
- Transferencias internas no deben contarse dos veces.
- Un faltante bloquea confirmación.
- Un cierre confirmado bloquea ediciones relacionadas.
- Reabrir exige permiso específico.
- El Worker crea cierres pendientes, nunca cierres confirmados.
- Repetir el Worker debe crear cero duplicados.

### Worker de cierres

Probar sin ejecutar catch-up productivo:

- sin secreto: `401` cuando la configuración existe;
- secreto incorrecto: `401`;
- secreto correcto en fixture: procesa una vez;
- segunda ejecución: `created = 0`;
- ninguna respuesta expone secretos.

## Matriz mínima de seguridad

### Administrador

- puede consultar todos los dominios;
- puede operar inventario, productos, nómina, cuentas y cierres;
- puede revisar auditoría.

### Operador

- puede consultar según el perfil;
- no puede guardar inventario sin permiso;
- no puede vender productos sin permiso;
- no puede modificar cierres;
- no puede modificar nómina ni cuentas sin permiso;
- la API debe devolver `403` aunque manipule la interfaz.

### Contador

- puede revisar cuentas y auditoría si tiene esos permisos;
- no confirma cierres sin permiso específico;
- no administra inventario ni venta de productos por defecto.

## Pruebas obligatorias

Ejecutar desde el repositorio:

```sh
npm test
npm run test:e2e
node --check outputs/app.js
node --check functions/api/run-closing-catchup.js
npx supabase db push --dry-run --linked
git diff --check
```

La emulación autenticada debe ejecutar el test de staging aislado con
`E2E_AUTH_LOCAL=1`. El resultado esperado es:

- login correcto;
- `/api/me` correcto;
- lectura de `/api/database` correcta;
- mutación directa del operador: `403`;
- botones de escritura deshabilitados;
- cero errores de aplicación.

## Reglas de seguridad para Claude Code

- No usar producción para crear fixtures.
- No ejecutar ventas, pagos, transferencias ni cierres reales.
- No ejecutar catch-up histórico real.
- No imprimir tokens ni secretos.
- No guardar contraseñas en el repositorio.
- No modificar RLS sin backup verificable y dry-run.
- No editar migraciones ya aplicadas.
- No usar `reset --hard`, `rebase` ni `push --force`.
- Acumular commits locales y publicar solo con autorización explícita.

## Criterio de éxito

La emulación se considera correcta cuando reproduce todos los flujos incluidos,
rechaza las operaciones no autorizadas tanto en la interfaz como en la API,
mantiene inventario y saldos idempotentes, genera auditoría, conserva RLS y
no contiene ninguna dependencia de facturación de servicios ni de producción.

