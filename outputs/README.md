# ERP Centro de Uñas

Aplicación web local para operar un centro de uñas con:

- Dashboard con facturación del día, cobros de cuentas por cobrar del día y citas del día.
- Facturación con búsqueda digitable de clientes y servicios.
- Facturación con múltiples servicios por factura, colaboradora por servicio, adicionales, descuentos, propina y distribución de propina por colaboradora.
- Facturación con múltiples formas de pago: efectivo, tarjeta, transferencia confirmada, transferencia pendiente, crédito y balance a favor.
- Cuentas por cobrar y registro de abonos.
- Reservas por cliente, servicio, fecha, hora y técnico/a.
- Payroll por período, quincena o mes con salario, comisión por umbral, propinas, descuentos, CxC de colaboradores y CxP generada.
- Cierres de caja por fecha con esperado, contado, gastos y diferencia.
- Egresos para gastos, costos, inversiones, avances y transferencias entre cuentas/cajas.
- Mantenimiento de clientes y servicios.
- Mantenimiento ampliado de colaboradores y cuentas/cajas.
- Base de datos normalizada en `database.json`, creada desde el Excel de Dalfi Studio Nail.

## Uso

Abre `index.html` desde un servidor local para que la aplicación pueda cargar `database.json`.
Los cambios se guardan en el navegador usando `localStorage`.

La app usa estas llaves internas:

- `dalfi-erp-db-v1`: base normalizada alimentada por la aplicación.
- `dalfi-erp-app-state-v1`: vista rápida que usa la interfaz.

## Base de datos

`database.json` contiene las tablas extraídas del archivo Excel:

- Maestros: clientes, colaboradores, servicios, cuentas financieras/cajas, procesadores y conceptos de egresos.
- Operación: facturas, detalle de factura, pagos, cuentas por cobrar, ingresos y aplicaciones de ingresos.
- Tesorería: egresos, transferencias y cierres de caja.
- Nómina: propinas, umbrales de comisión y nómina.
- Reservas: tabla agregada para la agenda de la aplicación.

## Archivos

- `index.html`: estructura de la aplicación.
- `styles.css`: diseño visual responsive.
- `app.js`: lógica, datos de muestra y persistencia local.
- `database.json`: estructura y datos iniciales de la base.

## Formularios maestros

La pantalla `Base de datos` permite alimentar las tablas principales del Excel por módulo. Solo se muestra el módulo seleccionado; dentro de cada módulo se puede agregar, editar o inactivar registros:

- `T_Clientes`: nombre completo, nombre, apellido, teléfono, sexo, correo, dirección, estado, fecha y observaciones.
- `T_Servicios`: servicio, categoría, precio base, duración y estado.
- `T_Colaboradores`: nombre completo, función, teléfono, salario mensual, dirección, correo, estado y fecha de ingreso.
- `T_Cuentas`: bancos, cajas operativas, cajas fuertes y cajas chicas con entidad, producto, número, titular, moneda, balance inicial y balance mínimo.
- `T_UmbralesComision`: rangos desde/hasta y porcentaje de comisión para nómina.

## Facturación

Desde Facturación se puede crear un cliente nuevo con todos los campos principales de `T_Clientes`.
Cada factura puede tener varias líneas de servicio. Cada línea guarda un servicio único, colaboradora, precio base, monto adicional con detalle cuando aplica, descuento con detalle cuando aplica y subtotal.
La propina pagada en caja se divide inicialmente en partes iguales entre las colaboradoras de la factura y puede editarse antes de guardar. Al guardar, se alimenta `T_Propinas` para nómina.

Las formas de pago permiten mezclar varios métodos en una factura. Cada método muestra solo los campos necesarios: efectivo va a caja registradora, transferencias muestran cuentas bancarias, tarjeta muestra procesador, y crédito muestra fecha de pago.
Las transferencias pendientes y créditos alimentan cuentas por cobrar; las transferencias confirmadas y efectivo alimentan ingresos; tarjeta se registra como pago de contado y deja trazada una CxC al procesador para conciliación posterior.
Si el cliente paga más del total, el sobrante puede ir a balance a favor del cliente o a cuenta de sobrante.
Si el cliente tiene CxC previa, los pagos confirmados se aplican primero a esas cuentas antes de cubrir la factura nueva.
La aplicación no crea CxC automáticamente por falta de pago: si falta monto para completar la factura, debe agregarse una forma de pago `Crédito` o `Transferencia pendiente` por ese monto. Si las formas de pago son menores al total a cobrar, la factura no se guarda.
Las transferencias pendientes aparecen en Cuentas por cobrar con acciones para confirmar o declinar. Si se declinan, quedan como CxC vencida del cliente con fecha del mismo día.

## Cierres

El cierre de caja separa efectivo, tarjeta, transferencias confirmadas, egresos y diferencias. También permite registrar compañía de tarjeta y número de lote para validar que lo facturado por tarjeta coincida con el cierre y quede pendiente de conciliación.
El efectivo esperado solo se muestra cuando se pulsa `Generar cuadre de efectivo`. Si el conteo inicial es menor, se documenta el faltante, exige motivo y pide un monto contado rectificado antes de guardar. Así queda trazabilidad del intento inicial y del conteo corregido para evaluación de caja. Si el contado final es mayor, el excedente se registra como sobrante de caja.
El retiro para dejar solo el monto operativo no se hace desde el cierre: debe registrarse luego como egreso/transferencia desde caja registradora hacia caja fuerte o banco.

## Egresos

El módulo `Egresos` registra salidas desde una caja o cuenta. Permite clasificar como gasto, costo, inversión, transferencia entre cuentas/cajas o avance autorizado.
Las transferencias alimentan la tabla `transferencias`; los avances autorizados generan una CxC por el monto entregado.
Los avances de efectivo se limitan a colaboradores y suplidores de servicios/productos; no se registran avances a clientes.

## Payroll

En `Base de datos > Colaboradores` se puede editar el salario mensual y asignar uno o varios umbrales de comisión al colaborador.
Los umbrales se crean en `Base de datos > Umbrales comisión`; no existe umbral global automático. Si un colaborador no tiene umbrales asignados, Payroll no calcula comisión para ese colaborador.
En `Nómina` se selecciona empleado, período y corte. La app calcula salario del período, ventas del colaborador, comisión según los umbrales asignados, propinas pendientes, descuentos AFP/seguro/otros y descuentos de CxC del colaborador.
Al generar el payroll se crea el registro en `nomina`, se marcan propinas como pagadas, se aplican los descuentos contra CxC seleccionadas y se crea una cuenta por pagar en `cuentasPagar`.
El reporte de nómina se puede filtrar por empleado o período.
