# Sincronización de citas con Google Calendar

## Resultado

El ERP sigue siendo la fuente de verdad. Google Calendar recibe una copia operativa de cada cita:

- título: cliente y manicurista;
- descripción: cliente, manicurista, servicio, horario, estado e ID interno de la reserva;
- inicio y fin: calculados con la duración real del servicio cuando `horaFin` no existe;
- zona horaria: `America/Santo_Domingo`;
- visibilidad: privada;
- sin asistentes, invitaciones ni notificaciones automáticas.

El ID del evento se deriva de forma estable del ID de la reserva. Por eso:

- guardar una cita crea un evento;
- editar o reprogramar actualiza el mismo evento;
- cancelar elimina el evento;
- repetir una operación no crea duplicados.

Un fallo de Google no revierte una cita ya guardada en el ERP. La respuesta del servidor incluye un resumen `calendarSync` sin datos personales y el endpoint de sincronización permite reparar citas pendientes.

## Flujo estrictamente unidireccional

La ERP y la aplicación de agenda son los únicos lugares autorizados para crear,
editar, reprogramar o cancelar citas. Google Calendar recibe una copia de solo
consulta. Los eventos creados o modificados manualmente en Google **no se leen,
no bloquean horarios y no escriben datos en la ERP**.

`POST /api/calendar/google-pull` permanece únicamente como ruta retirada y
responde `410 CALENDAR_IMPORT_DISABLED`. Esto detiene de forma segura cualquier
invocación residual de un Worker antiguo mientras se elimina ese Worker de
Cloudflare.

## Credenciales y permisos

El proveedor recomendado es un Web App de Google Apps Script propiedad de `dalfistudionails@gmail.com`. Se ejecuta como la dueña del calendario y evita descargar o conservar una clave privada de cuenta de servicio. El Web App valida un secreto aleatorio guardado únicamente en Script Properties y en los secretos de Cloudflare.

1. Iniciar sesión en Apps Script como `dalfistudionails@gmail.com`.
2. Crear un proyecto y copiar `integrations/google-calendar-apps-script/Code.gs`.
3. Usar el manifiesto `integrations/google-calendar-apps-script/appsscript.json` y la zona horaria `America/Santo_Domingo`.
4. En **Configuración del proyecto → Propiedades de la secuencia de comandos**, crear:
   - `DALFI_WEBHOOK_SECRET`: secreto aleatorio;
   - `DALFI_CALENDAR_ID`: `dalfistudionails@gmail.com`.
5. Implementar como **Aplicación web**, ejecutar como la propietaria y permitir acceso a cualquier usuario que tenga el vínculo. El secreto sigue siendo obligatorio para ejecutar una operación.
6. Autorizar únicamente el acceso solicitado a Google Calendar.
7. Guardar la URL terminada en `/exec` y el mismo secreto en Cloudflare Pages.

Referencias oficiales:

- [Crear eventos con Calendar API](https://developers.google.com/workspace/calendar/api/guides/create-events)
- [Publicar Apps Script como Web App](https://developers.google.com/apps-script/guides/web)
- [Servicio Calendar de Apps Script](https://developers.google.com/apps-script/reference/calendar)
- [Cuotas de Apps Script](https://developers.google.com/apps-script/guides/services/quotas)

## Configuración de Cloudflare Pages

Variables no secretas:

```text
GOOGLE_CALENDAR_ENABLED=true
GOOGLE_CALENDAR_PROVIDER=apps_script
GOOGLE_CALENDAR_ID=dalfistudionails@gmail.com
GOOGLE_CALENDAR_TIME_ZONE=America/Santo_Domingo
GOOGLE_CALENDAR_TIMEOUT_MS=8000
GOOGLE_CALENDAR_MAX_SYNC_PER_SAVE=25
```

Secretos que deben configurarse únicamente con el administrador de secretos de Cloudflare:

```text
GOOGLE_APPS_SCRIPT_WEBHOOK_URL
GOOGLE_APPS_SCRIPT_WEBHOOK_SECRET

```

No pegar el secreto en `wrangler.toml`, archivos `.env`, código, documentación, GitHub, registros ni conversaciones.

Ejemplo de configuración interactiva desde el directorio del proyecto:

```bash
npx wrangler pages secret put GOOGLE_APPS_SCRIPT_WEBHOOK_URL --project-name dalfi-erp
npx wrangler pages secret put GOOGLE_APPS_SCRIPT_WEBHOOK_SECRET --project-name dalfi-erp
```

Después de configurar los secretos, cambiar `GOOGLE_CALENDAR_ENABLED` a `true` y desplegar.

La alternativa `service_account` permanece disponible para una migración futura. Requiere compartir el calendario con la cuenta de servicio y configurar `GOOGLE_SERVICE_ACCOUNT_EMAIL` y `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` como secretos.

## Sincronización inicial o reparación

El endpoint protegido exige una sesión del ERP con permiso para administrar reservas:

```text
GET  /api/calendar/google-sync
POST /api/calendar/google-sync
```

Primero ejecutar una simulación; no crea eventos:

```json
{
  "dryRun": true,
  "fromDate": "2026-08-08",
  "limit": 50
}
```

Luego, con datos ficticios verificados, ejecutar:

```json
{
  "dryRun": false,
  "fromDate": "2026-08-08",
  "limit": 50
}
```

El endpoint no devuelve nombres, correos ni teléfonos; solo conteos, IDs internos y estados técnicos.

No existe importación desde Google Calendar. La ruta histórica
`POST /api/calendar/google-pull` está deshabilitada permanentemente.

## Datos enviados a Google

Se envían únicamente:

- ID interno de la reserva;
- nombre del cliente;
- nombre de la manicurista;
- servicio;
- fecha, inicio y fin;
- estado de la cita.

No se envían teléfono, correo del cliente, facturas, pagos, depósitos, credenciales ni otros registros del ERP.

## Desactivación inmediata

Establecer `GOOGLE_CALENDAR_ENABLED=false` y desplegar. Las citas continúan funcionando en el ERP, pero no se realizan llamadas a Google Calendar.
