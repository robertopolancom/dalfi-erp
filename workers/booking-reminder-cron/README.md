# dalfi-erp-booking-reminder-cron

Worker de Cloudflare (Cron Trigger) que dispara los recordatorios horarios y
la escalacion/liberacion de horario de las citas "Preaprobadas" del chatbot
que no se confirman a tiempo. Es el mismo patron que
`workers/closing-cron/`, aplicado a `functions/api/booking/send-reminders.js`
en vez de `functions/api/run-closing-catchup.js`. **Ninguno de los pasos de
este documento se ejecuto como parte de esta tarea**: ni el despliegue del
Worker, ni la configuracion de secretos reales, ni la activacion del Cron
Trigger.

## Por que un Worker separado

Cloudflare **Pages** no soporta Cron Triggers directamente sobre sus Pages
Functions. La unica forma soportada de tener una tarea programada real es un
Worker aparte (no Pages) con su propio `wrangler.toml` y un
`[triggers] crons = [...]`, que en cada disparo hace una peticion HTTP
autenticada al endpoint que ya existe en este repo:
`functions/api/booking/send-reminders.js`.

Este Worker **no accede a Supabase directamente ni duplica ninguna regla de
negocio de reservas** (ventana de 4h antes de la cita, calculo de
disponibilidad, que estado toma una cita al reasignarse). Toda esa logica
sigue viviendo unicamente en `functions/api/booking/send-reminders.js` y en
`outputs/lib/booking-engine.js`. La responsabilidad de este Worker es
exclusivamente: construir la URL, hacer un `fetch()` con el secreto correcto
en la cabecera, verificar el codigo HTTP, y registrar un log no sensible del
resultado.

## Que hace `send-reminders.js` en cada disparo

Por cada reserva `Preaprobada` (o de origen chatbot) que no esta en un
estado cerrado:

1. Si faltan 4h o menos para la cita (o ya paso 1h desde que se creo sin
   confirmarse), calcula si toca enviar un recordatorio horario por
   WhatsApp al cliente (`booking.preapproved_reminder`).
2. Si la hora de la cita ya llego y sigue sin confirmarse en el salon,
   escala a un agente humano (`booking.preapproved_escalation`) **y** marca
   la reserva como `"No confirmada"`, liberando su horario (ver
   `outputs/lib/booking-engine.js` `calculateAvailableSlots`). Si nadie mas
   toma ese horario, el salon todavia puede confirmarla despues (ver la
   guarda `ALREADY_REASSIGNED` en `functions/api/booking/confirm.js`); si
   otra reserva confirmada lo toma primero, esta queda `"Reprogramada"`
   automaticamente.

## Archivos

- `worker.js`: el Worker (`export default { async scheduled(...) }`).
- `wrangler.toml`: configuracion de Wrangler (variable NO secreta
  `APP_BASE_URL`; Cron Trigger activo cada hora).
- `package.json`: solo declara `"type": "module"` (sin dependencias).
- `tests/worker.test.js`: pruebas con `fetch` mockeado, sin red real.

## 1. Configurar `BOOKING_REMINDER_CRON_SECRET` como Secret (en el Worker)

Debe ser **exactamente el mismo valor** que ya usa
`functions/api/booking/send-reminders.js` vía `env.BOOKING_REMINDER_CRON_SECRET`
en Cloudflare Pages:

```bash
openssl rand -hex 32
cd workers/booking-reminder-cron
wrangler secret put BOOKING_REMINDER_CRON_SECRET
```

## 2. Confirmar que Cloudflare Pages ya tiene configurado lo necesario

`functions/api/booking/send-reminders.js` requiere, en Cloudflare Pages
(Settings → Environment variables, como Secret):

```
BOOKING_REMINDER_CRON_SECRET = <el mismo valor del paso 1>
ERP_WEBHOOK_SECRET = <el mismo secreto compartido que ya usa notify-invoice-sent.js
                       y que el Chatbot Bridge tiene como ERP_WEBHOOK_SECRET>
```

Sin `BOOKING_REMINDER_CRON_SECRET` configurado en Pages, el endpoint
responde `500` sin tocar Supabase (mismo comportamiento seguro que
`run-closing-catchup.js`).

## 3. Desplegar

```bash
cd workers/booking-reminder-cron
wrangler deploy
```

El Cron Trigger (`crons = ["0 * * * *"]`, una vez por hora, cualquier
minuto en punto en UTC) ya esta activo en `wrangler.toml` — se activa al
desplegar.

## 4. Probar manualmente una ejecucion

```bash
curl -X POST "https://dalfi-erp.pages.dev/api/booking/send-reminders" \
  -H "x-cron-secret: <el mismo valor configurado en los pasos 1 y 2>"
```

Debe responder `{"ok":true,"remindersSent":N,"escalationsSent":M,"failures":[]}`.

## 5. Revisar ejecuciones y errores

`wrangler tail` (con el Worker desplegado) muestra los logs en tiempo real:
un JSON de una linea por ejecucion con `ok`, `status`, `durationMs` y
`outcome` — nunca el secreto, nunca la cabecera `Authorization` completa.

## 6. Desactivar el Cron

Comentar la seccion `[triggers]` en `wrangler.toml` y volver a desplegar, o
eliminar el Cron Trigger desde el dashboard de Cloudflare (Workers & Pages
→ `dalfi-erp-booking-reminder-cron` → Triggers).

## 7. Rollback

Este Worker no escribe ningun estado propio: "hacer rollback" es
unicamente desactivar el Cron Trigger y/o `wrangler rollback`, y/o quitar
`BOOKING_REMINDER_CRON_SECRET` de Cloudflare Pages. Ninguna accion de este
Worker puede corromper `erp_records`: `send-reminders.js` es idempotente por
ciclo horario (`apt.lastReminderCycleSent`) y por escalacion
(`apt.escalatedAt`), asi que un disparo repetido nunca reenvia el mismo
recordatorio ni vuelve a escalar/marcar "No confirmada" algo que ya se
proceso.
