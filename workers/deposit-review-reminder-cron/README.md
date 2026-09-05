# dalfi-erp-deposit-review-reminder-cron

Worker de Cloudflare (Cron Trigger) que dispara el recordatorio horario por correo de
comprobantes de depósito pendientes de revisar -- mismo patrón que
`workers/deposit-receipt-purge-cron/`, aplicado a
`POST /api/booking/send-deposit-review-reminders` en `server/app.mjs` (Render + Neon,
`ssc.dalfistudio.com`).

## Por qué existe

Una cita nueva no aparta su horario hasta que el personal confirma el depósito de RD$500 (ver
[[dalfi_reservapp_architecture]] y `neon/migrations/0024_deposit_or_admin_gates_slot.sql`). Si la
clienta ya subió su comprobante pero nadie lo revisa, esa cita se queda "en el limbo"
indefinidamente. Este Worker asegura que el personal reciba un correo cada hora (mientras la
ventana de negocio esté abierta) por cada comprobante que siga sin aprobarse o rechazarse, hasta
que alguien lo haga.

## Por qué un Worker separado

Mismo motivo que el resto de `workers/*-cron/`: ni Cloudflare Pages ni Render ofrecen cron nativo
para este servicio, así que este Worker aparte, con su propio `wrangler.toml` y
`[triggers] crons = [...]`, hace una petición HTTP autenticada al endpoint real en Render en cada
disparo.

Este Worker **no accede a Neon directamente, no decide qué cuenta como "pendiente" ni decide la
ventana de negocio** -- corre TODAS las horas, todos los días, y es el endpoint en Render
(`isWithinDepositReminderWindow` en `server/app.mjs`) el que decide si son las 8am-11pm hora de
Santo Domingo antes de mandar nada. Mantener esa regla en un solo lugar (server-side) evita el
error clásico de calcular una ventana horaria local a partir de una expresión cron en UTC.

## Qué hace `POST /api/booking/send-deposit-review-reminders` en cada disparo

1. Si NO son las 8am-11pm hora de Santo Domingo, responde `{ok:true, skipped:"outside_window", sent:0}` y no manda nada.
2. Si sí, busca toda cita con `deposit_status='ComprobanteRecibido'` (comprobante subido, sin aprobar ni rechazar) y estado no cancelado/reasignado (`listPendingDepositReviews` en `server/store.mjs`).
3. Por cada una, manda un correo a `GMAIL_USER` (Gmail SMTP con contraseña de aplicación, ver `server/email.mjs`) recordando que sigue sin revisarse.

Cada comprobante recibe como máximo un correo por disparo con el endpoint dentro de la ventana --
en la práctica, uno por hora mientras siga pendiente.

## Archivos

- `worker.js`: el Worker (`export default { async scheduled(...) }`).
- `wrangler.toml`: configuración de Wrangler (variable NO secreta
  `APP_BASE_URL = "https://ssc.dalfistudio.com"`; Cron Trigger activo cada hora).
- `package.json`: solo declara `"type": "module"` (sin dependencias).
- `tests/worker.test.js`: pruebas con `fetch` mockeado, sin red real.

## 1. Configurar `DEPOSIT_REVIEW_REMINDER_CRON_SECRET` como Secret (en el Worker)

Debe ser **exactamente el mismo valor** que la variable de entorno
`DEPOSIT_REVIEW_REMINDER_CRON_SECRET` del servicio de Render `dalfi-erp`:

```bash
openssl rand -hex 32
cd workers/deposit-review-reminder-cron
wrangler secret put DEPOSIT_REVIEW_REMINDER_CRON_SECRET
```

## 2. Confirmar que Render ya tiene configurado lo necesario

El servicio `dalfi-erp` en Render necesita, como variables de entorno:

```
DEPOSIT_REVIEW_REMINDER_CRON_SECRET = <el mismo valor del paso 1>
GMAIL_USER = dalfistudionails@gmail.com
GMAIL_APP_PASSWORD = <contraseña de aplicación de Gmail, ver server/email.mjs>
```

Sin `DEPOSIT_REVIEW_REMINDER_CRON_SECRET`, el endpoint responde `500` sin tocar Neon. Sin
`GMAIL_USER`/`GMAIL_APP_PASSWORD`, el endpoint sigue funcionando pero ningún correo sale (queda
registrado en el log del servicio, ver `sendBusinessEmail` en `server/email.mjs`).

## 3. Desplegar

```bash
cd workers/deposit-review-reminder-cron
wrangler deploy
```

El Cron Trigger (`crons = ["0 * * * *"]`, cada hora) ya está activo en `wrangler.toml` -- se
activa al desplegar.

## 4. Probar manualmente una ejecución

```bash
curl -X POST "https://ssc.dalfistudio.com/api/booking/send-deposit-review-reminders" \
  -H "x-cron-secret: <el mismo valor configurado en los pasos 1 y 2>"
```

Debe responder `{"ok":true,"pending":N,"sent":N}` (o `{"ok":true,"skipped":"outside_window","sent":0}`
si se prueba fuera de las 8am-11pm hora de Santo Domingo).

## 5. Revisar ejecuciones y errores

`wrangler tail` (con el Worker desplegado) muestra los logs en tiempo real: un JSON de una línea
por ejecución con `ok`, `status`, `durationMs` y `outcome` -- nunca el secreto, nunca la cabecera
`Authorization` completa.

## 6. Desactivar el Cron

Comentar la sección `[triggers]` en `wrangler.toml` y volver a desplegar, o eliminar el Cron
Trigger desde el dashboard de Cloudflare (Workers & Pages →
`dalfi-erp-deposit-review-reminder-cron` → Triggers).

## 7. Rollback

Este Worker no escribe ningún estado propio: "hacer rollback" es únicamente desactivar el Cron
Trigger y/o `wrangler rollback`, y/o quitar `DEPOSIT_REVIEW_REMINDER_CRON_SECRET`/`GMAIL_USER`/
`GMAIL_APP_PASSWORD` de Render. No borra ni modifica nada en Neon: solo lee y manda correos.
