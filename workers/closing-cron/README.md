# dalfi-erp-closing-cron

Worker de Cloudflare (Cron Trigger) que dispara el catch-up de cierres de
dalfi-erp cuando nadie tiene el ERP abierto en el navegador. Es un
complemento de `functions/CRON.md` (que ya documentaba este plan) con el
Worker realmente implementado y probado, listo para desplegar cuando el
equipo lo autorice. **Ninguno de los pasos de este documento se ejecuto como
parte de esta tarea**: ni el despliegue del Worker, ni la configuracion de
secretos reales, ni la activacion del Cron Trigger.

## Por que un Worker separado

Cloudflare **Pages** no soporta Cron Triggers directamente sobre sus Pages
Functions. La unica forma soportada de tener una tarea programada real es un
Worker aparte (no Pages) con su propio `wrangler.toml` y un
`[triggers] crons = [...]`, que en cada disparo hace una peticion HTTP
autenticada al endpoint que ya existe en este repo:
`functions/api/run-closing-catchup.js`.

Este Worker **no accede a Supabase directamente ni duplica ninguna regla de
negocio de cierres** (fecha comercial, tipos register/treasury, filtros de
transferencia/anulado, saldo inicial). Toda esa logica sigue viviendo
unicamente en `functions/api/run-closing-catchup.js` (y su espejo en
`outputs/app.js`). La responsabilidad de este Worker es exclusivamente:
construir la URL, hacer un `fetch()` con el secreto correcto en la cabecera,
verificar el codigo HTTP, y registrar un log no sensible del resultado.

## Archivos

- `worker.js`: el Worker (`export default { async scheduled(...) }`).
- `wrangler.toml`: configuracion de Wrangler para este Worker (variable NO
  secreta `APP_BASE_URL` con un placeholder; la expresion cron propuesta
  queda comentada, sin activar).
- `package.json`: solo declara `"type": "module"` (sin dependencias; el
  Worker usa unicamente `fetch`/`AbortController`/`console`, ya disponibles
  en el runtime de Cloudflare Workers).
- `tests/worker.test.js`: pruebas con `fetch` mockeado, sin red real.

## 1. Configurar `APP_BASE_URL`

Editar `wrangler.toml` y reemplazar el placeholder por el dominio real:

```toml
[vars]
APP_BASE_URL = "https://dalfi-erp.pages.dev"
```

`APP_BASE_URL` **no es secreto** (es simplemente el dominio publico del
sitio), por eso vive en `[vars]` y no como Secret.

## 2. Configurar `CLOSING_CRON_SECRET` como Secret (en el Worker)

Debe ser **exactamente el mismo valor** que ya usa
`functions/api/run-closing-catchup.js` vía `env.CLOSING_CRON_SECRET` en
Cloudflare Pages (ver el paso siguiente). Generar un valor nuevo solo si se
va a rotar tambien el de Pages al mismo tiempo:

```bash
openssl rand -hex 32
```

Configurarlo en el Worker (nunca en `wrangler.toml`, nunca en Git):

```bash
cd workers/closing-cron
wrangler secret put CLOSING_CRON_SECRET
```

## 3. Configurar el mismo secreto en Cloudflare Pages

Dashboard de Cloudflare Pages → proyecto `dalfi-erp` → Settings →
Environment variables → agregar como variable **secreta**:

```
CLOSING_CRON_SECRET = <el mismo valor del paso 2>
```

Sin esta variable configurada en Pages, `functions/api/run-closing-catchup.js`
responde `500` (que es exactamente lo que se observo antes de esta tarea: el
endpoint existe y esta protegido, pero `CLOSING_CRON_SECRET` nunca se llego a
configurar en Pages, asi que rechaza cualquier solicitud antes de tocar
Supabase).

## 4. Agregar el Cron Trigger

En `workers/closing-cron/wrangler.toml`, descomentar:

```toml
[triggers]
crons = ["59 3 * * *"]
```

**Cloudflare Cron Triggers siempre usan UTC.** Republica Dominicana no
observa horario de verano (esta siempre en UTC-4), asi que `59 3 * * *`
(03:59 UTC) equivale de forma estable, todo el ano, a las 23:59 hora de
Santo Domingo — el mismo "ultimo minuto del dia" que ya usa
`isAutomaticClosingEligible()` en `outputs/lib/closing-math.js` para decidir
si un dia ya "termino" y es elegible para cierre automatico. Es una
propuesta conservadora (una sola vez al dia, despues de terminar la
operacion), pensada para activarse solo cuando el equipo lo confirme.

## 5. Desplegar

```bash
cd workers/closing-cron
wrangler deploy
```

## 6. Probar manualmente una ejecucion

Sin esperar al disparo programado, se puede invocar el endpoint directamente
(esto SI toca el endpoint real, asi que solo debe hacerse cuando el equipo
este listo):

```bash
curl -X POST "https://dalfi-erp.pages.dev/api/run-closing-catchup" \
  -H "x-cron-secret: <el mismo valor configurado en los pasos 2 y 3>"
```

Debe responder `{"ok":true,"created":N}`. `N` en `0` es normal si no habia
ningun cierre pendiente por generar en ese momento.

## 7. Revisar ejecuciones y errores

`wrangler tail` (con el Worker desplegado) muestra los logs en tiempo real.
Cada ejecucion registra un JSON de una linea con `ok`, `status`,
`durationMs` y `outcome` — nunca el secreto, nunca la cabecera
`Authorization` completa, nunca el cuerpo de la respuesta del endpoint.

## 8. Desactivar el Cron

Comentar de nuevo la seccion `[triggers]` en `wrangler.toml` y volver a
desplegar, o eliminar el Cron Trigger desde el dashboard de Cloudflare
(Workers & Pages → `dalfi-erp-closing-cron` → Triggers).

## 9. Rotar el secreto

1. Generar un valor nuevo (`openssl rand -hex 32`).
2. Configurarlo en Cloudflare Pages (paso 3) **y** en el Worker (paso 2) con
   el mismo valor, en cualquier orden — mientras ambos no coincidan
   momentaneamente, el endpoint simplemente rechaza con `401` (no hay ningun
   estado intermedio inseguro).

## 10. Rollback

Este Worker no escribe ningun estado propio (no tiene KV, ni D1, ni
Durable Objects): "hacer rollback" es unicamente:

- Desactivar el Cron Trigger (paso 8), y/o
- `wrangler rollback` a una version anterior del Worker, y/o
- Quitar `CLOSING_CRON_SECRET` de Cloudflare Pages (el endpoint vuelve a
  responder `500` sin ejecutar nada, igual que su estado actual).

Ninguna accion de este Worker puede corromper `erp_records`: en el peor caso
(disparo repetido, secreto viejo, etc.) el endpoint que llama es idempotente
(no crea un cierre para una fecha/tipo que ya tiene uno) y nunca reabre ni
reescribe un cierre ya confirmado.

## 11. Verificar que no queden cierres duplicados

```bash
npx supabase db query --linked "select \"businessDate\", \"closingType\", count(*) from erp_records er, jsonb_to_recordset(er.data->'cierres') as c(\"businessDate\" text, \"closingType\" text) where er.table_name='app' and er.record_key='database' group by 1,2 having count(*) > 1;"
```

Una tabla vacia confirma que no hay mas de un cierre por fecha y tipo (la
misma regla que ya garantizan `registerClosingForDate`/`treasuryClosingForDate`
en `functions/api/run-closing-catchup.js` y en `outputs/app.js`).

## 12. Confirmar que el Worker no accede directamente a Supabase

```bash
grep -i "supabase" workers/closing-cron/worker.js
```

No debe devolver ninguna coincidencia (`workers/closing-cron/tests/worker.test.js`
tiene una prueba automatizada equivalente que falla si alguna vez se
introduce una referencia a Supabase, `erp_records` o a cualquier regla de
negocio de cierres directamente en este Worker).
