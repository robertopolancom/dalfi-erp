# dalfi-erp-booking-reminder-cron

Worker de Cloudflare (Cron Trigger) que dispara los recordatorios de
confirmación de asistencia y la escalación/liberación de horario de
cualquier cita futura (sin importar canal de origen) que no se confirma a
tiempo. Es el mismo patrón que `workers/closing-cron/`, aplicado a
`POST /api/booking/send-reminders` en `server/app.mjs` (Render + Neon,
`ssc.sebengroup.com`).

Este Worker antes llamaba a `functions/api/booking/send-reminders.js` en el
proyecto de Cloudflare Pages `dalfi-erp` (Supabase). Ese proyecto se eliminó
porque `ssc.sebengroup.com` (Render) es el backend real en uso diario; la
lógica de recordatorios se portó a `server/store.mjs`
(`businessMinutesBetween`/`resolveBusinessDayWindow`) y `server/app.mjs`. La
única diferencia operativa: `BOOKING_REMINDER_CRON_SECRET` ahora se
configura como variable de entorno del servicio de Render `dalfi-erp`, no en
Cloudflare Pages.

## Por que un Worker separado

Cloudflare **Pages** no soporta Cron Triggers directamente sobre sus Pages
Functions, y Render tampoco ofrece cron nativo para este servicio. La forma
más simple de tener una tarea programada real es este Worker aparte, con su
propio `wrangler.toml` y un `[triggers] crons = [...]`, que en cada disparo
hace una petición HTTP autenticada al endpoint real en Render.

Este Worker **no accede a Neon directamente ni duplica ninguna regla de
negocio de reservas** (ventana de 4h laborales antes de la cita, cadencia de
escalación, qué estado toma una cita al reasignarse). Toda esa lógica vive
únicamente en `server/store.mjs`/`server/app.mjs`. La responsabilidad de
este Worker es exclusivamente: construir la URL, hacer un `fetch()` con el
secreto correcto en la cabecera, verificar el código HTTP, y registrar un
log no sensible del resultado.

## Qué hace `POST /api/booking/send-reminders` en cada disparo

Por cada cita futura (cualquier canal de origen) que no está en un estado
cerrado:

1. Si su `confirmation_status` es `"Programada"` y faltan 4 horas laborales
   o menos para la cita, envía el primer recordatorio por WhatsApp (vía el
   Chatbot Bridge) y la pasa a `"PendienteConfirmarHora"`.
2. Si su `confirmation_status` es `"PendienteConfirmarHora"` y ya pasó 1
   hora laboral o más desde ese primer recordatorio sin que la clienta
   confirme, envía un segundo recordatorio **y**, en el mismo paso, la pasa
   a `"EspacioLiberado"` -- `availability()` deja de contarla como ocupada,
   así que su horario reaparece disponible para otra reserva. Si nadie más
   lo toma, la clienta (o el salón) todavía puede confirmarla después vía
   `POST /api/reservapp/booking/confirm-attendance`; si otra reserva ocupa
   ese mismo horario primero, esa confirmación tardía responde
   `409 ALREADY_REASSIGNED` pidiendo elegir otro horario.

## Archivos

- `worker.js`: el Worker (`export default { async scheduled(...) }`).
- `wrangler.toml`: configuración de Wrangler (variable NO secreta
  `APP_BASE_URL = "https://ssc.sebengroup.com"`; Cron Trigger activo cada hora).
- `package.json`: solo declara `"type": "module"` (sin dependencias).
- `tests/worker.test.js`: pruebas con `fetch` mockeado, sin red real.

## 1. Configurar `BOOKING_REMINDER_CRON_SECRET` como Secret (en el Worker)

Debe ser **exactamente el mismo valor** que la variable de entorno
`BOOKING_REMINDER_CRON_SECRET` del servicio de Render `dalfi-erp`:

```bash
openssl rand -hex 32
cd workers/booking-reminder-cron
wrangler secret put BOOKING_REMINDER_CRON_SECRET
```

## 2. Confirmar que Render ya tiene configurado lo necesario

El servicio `dalfi-erp` en Render necesita, como variables de entorno:

```
BOOKING_REMINDER_CRON_SECRET = <el mismo valor del paso 1>
ERP_WEBHOOK_SECRET = <el mismo secreto compartido que ya usa el resto de
                       server/app.mjs para hablar con el Chatbot Bridge>
CHATBOT_BRIDGE_URL = https://bot.sebengroup.com   (o el valor real vigente)
```

Sin `BOOKING_REMINDER_CRON_SECRET` configurado, el endpoint responde `500`
sin tocar Neon. Sin `ERP_WEBHOOK_SECRET`, cada intento de envío queda
registrado como fallo en `failures` (nunca se marca el recordatorio como
enviado sin que el bridge lo confirme).

## 3. Desplegar

```bash
cd workers/booking-reminder-cron
wrangler deploy
```

El Cron Trigger (`crons = ["0 * * * *"]`, una vez por hora, cualquier
minuto en punto en UTC) ya está activo en `wrangler.toml` — se activa al
desplegar.

## 4. Probar manualmente una ejecución

```bash
curl -X POST "https://ssc.sebengroup.com/api/booking/send-reminders" \
  -H "x-cron-secret: <el mismo valor configurado en los pasos 1 y 2>"
```

Debe responder `{"ok":true,"remindersSent":N,"escalationsSent":M,"failures":[]}`.

## 5. Revisar ejecuciones y errores

`wrangler tail` (con el Worker desplegado) muestra los logs en tiempo real:
un JSON de una línea por ejecución con `ok`, `status`, `durationMs` y
`outcome` — nunca el secreto, nunca la cabecera `Authorization` completa.

## 6. Desactivar el Cron

Comentar la sección `[triggers]` en `wrangler.toml` y volver a desplegar, o
eliminar el Cron Trigger desde el dashboard de Cloudflare (Workers & Pages
→ `dalfi-erp-booking-reminder-cron` → Triggers).

## 7. Rollback

Este Worker no escribe ningún estado propio: "hacer rollback" es
únicamente desactivar el Cron Trigger y/o `wrangler rollback`, y/o quitar
`BOOKING_REMINDER_CRON_SECRET` de Render. Ninguna acción de este Worker
puede corromper `app.appointments`: el endpoint solo actúa sobre citas cuyo
`confirmation_status` sigue en `"Programada"`/`"PendienteConfirmarHora"` y
solo avanza ese estado después de que el bridge confirme el envío, así que
un disparo repetido nunca reenvía el mismo recordatorio ni vuelve a escalar
algo que ya se procesó.
