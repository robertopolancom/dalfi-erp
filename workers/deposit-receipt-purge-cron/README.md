# dalfi-erp-deposit-receipt-purge-cron

Worker de Cloudflare (Cron Trigger) que dispara la limpieza diaria de fotos de comprobantes de
depósito ya resueltas -- mismo patrón que `workers/booking-reminder-cron/`, aplicado a
`POST /api/booking/purge-deposit-receipts` en `server/app.mjs` (Render + Neon, `ssc.dalfistudio.com`).

## Por qué existe

Desde que ReservApp acepta subir la foto del comprobante del depósito de RD$500 (ver
[[reservapp_deposit_verification]]), esas fotos se guardan en base64 en
`app.appointment_deposit_receipts.image_data`. Una vez que la cita ya quedó **Atendida** o
**Cancelada**, el depósito ya cumplió su propósito y la foto ya no hace falta -- dejarla ahí para
siempre solo ocupa espacio en la base sin ningún beneficio.

**Qué se borra y qué NO**: solo `image_data`/`mime_type` (la foto). La fila de
`app.appointment_deposit_receipts` se queda -- `reviewed_by`/`reviewed_at`/`review_note` siguen
disponibles como rastro de auditoría de quién confirmó o rechazó el depósito y cuándo. La cita
(`app.appointments`) nunca se toca.

## Por que un Worker separado

Mismo motivo que `workers/booking-reminder-cron/README.md`: ni Cloudflare Pages ni Render ofrecen
cron nativo para este servicio, así que este Worker aparte, con su propio `wrangler.toml` y
`[triggers] crons = [...]`, hace una petición HTTP autenticada al endpoint real en Render en cada
disparo.

Este Worker **no accede a Neon directamente ni decide qué se borra** -- esa lógica vive
únicamente en `server/store.mjs` (`purgeExpiredDepositReceipts`). La responsabilidad de este
Worker es exclusivamente: construir la URL, hacer un `fetch()` con el secreto correcto en la
cabecera, verificar el código HTTP, y registrar un log no sensible del resultado.

## Qué hace `POST /api/booking/purge-deposit-receipts` en cada disparo

```sql
update app.appointment_deposit_receipts r
   set image_data = null, mime_type = null
  from app.appointments a
 where a.id = r.appointment_id
   and a.status in ('completed','cancelled')
   and a.updated_at <= now() - interval '5 days'
   and r.image_data is not null
```

Idempotente por diseño (`WHERE image_data IS NOT NULL`): un disparo repetido, o dos ejecuciones
solapadas, nunca fallan ni vuelven a tocar un comprobante ya purgado.

## Archivos

- `worker.js`: el Worker (`export default { async scheduled(...) }`).
- `wrangler.toml`: configuración de Wrangler (variable NO secreta
  `APP_BASE_URL = "https://ssc.dalfistudio.com"`; Cron Trigger activo una vez al día).
- `package.json`: solo declara `"type": "module"` (sin dependencias).
- `tests/worker.test.js`: pruebas con `fetch` mockeado, sin red real.

## 1. Configurar `DEPOSIT_RECEIPT_PURGE_CRON_SECRET` como Secret (en el Worker)

Debe ser **exactamente el mismo valor** que la variable de entorno
`DEPOSIT_RECEIPT_PURGE_CRON_SECRET` del servicio de Render `dalfi-erp`:

```bash
openssl rand -hex 32
cd workers/deposit-receipt-purge-cron
wrangler secret put DEPOSIT_RECEIPT_PURGE_CRON_SECRET
```

## 2. Confirmar que Render ya tiene configurado lo necesario

El servicio `dalfi-erp` en Render necesita, como variable de entorno:

```
DEPOSIT_RECEIPT_PURGE_CRON_SECRET = <el mismo valor del paso 1>
```

Sin esto, el endpoint responde `500` sin tocar Neon.

## 3. Desplegar

```bash
cd workers/deposit-receipt-purge-cron
wrangler deploy
```

El Cron Trigger (`crons = ["0 8 * * *"]`, una vez al día) ya está activo en `wrangler.toml` -- se
activa al desplegar.

## 4. Probar manualmente una ejecución

```bash
curl -X POST "https://ssc.dalfistudio.com/api/booking/purge-deposit-receipts" \
  -H "x-cron-secret: <el mismo valor configurado en los pasos 1 y 2>"
```

Debe responder `{"ok":true,"purgedCount":N}`.

## 5. Revisar ejecuciones y errores

`wrangler tail` (con el Worker desplegado) muestra los logs en tiempo real: un JSON de una línea
por ejecución con `ok`, `status`, `durationMs` y `outcome` -- nunca el secreto, nunca la cabecera
`Authorization` completa.

## 6. Desactivar el Cron

Comentar la sección `[triggers]` en `wrangler.toml` y volver a desplegar, o eliminar el Cron
Trigger desde el dashboard de Cloudflare (Workers & Pages →
`dalfi-erp-deposit-receipt-purge-cron` → Triggers).

## 7. Rollback

Este Worker no escribe ningún estado propio: "hacer rollback" es únicamente desactivar el Cron
Trigger y/o `wrangler rollback`, y/o quitar `DEPOSIT_RECEIPT_PURGE_CRON_SECRET` de Render. La
purga en sí es irreversible (la foto se borra de verdad) pero acotada: nunca toca una fila cuya
cita no lleve 5+ días Atendida/Cancelada, y nunca toca `app.appointments` ni el resto de la fila
del comprobante (`reviewed_by`/`reviewed_at`/`review_note` sobreviven).
