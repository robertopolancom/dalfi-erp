# Tareas automaticas por cron (Cloudflare Workers Cron Triggers)

## Por que hace falta esto

`outputs/app.js` ya genera los cierres diarios pendientes ("catch-up") cada
vez que alguien abre la app, recupera el foco de la pestana, o cada 30
segundos mientras la tiene abierta (ver `ensureProvisionalClosings()` y
`startRemoteRefreshLoop()`). Eso funciona bien mientras alguien tenga el ERP
abierto en el navegador, pero **no existe ningun proceso corriendo del lado
del servidor**: si nadie abre la app durante varios dias, no se genera
ningun cierre, porque no hay nada ejecutandose sin un navegador activo.

Esa es la causa real de que los cierres se hayan detenido despues del 9 de
julio: no fue un bug puntual que borrara la logica, fue que ningun cliente
tuvo la pestana abierta el tiempo suficiente para disparar la recuperacion.

Cloudflare **Pages** (a diferencia de Cloudflare **Workers**) no soporta Cron
Triggers directamente sobre sus Pages Functions. La forma soportada de tener
una tarea programada real es:

1. Un Worker separado (no Pages) con su propio `wrangler.toml` y un
   `[triggers] crons = [...]`.
2. Ese Worker, en cada disparo, hace un `fetch()` autenticado al endpoint
   `functions/api/run-closing-catchup.js` que ya esta en este repo.

Este documento deja ese Worker listo para desplegar, pero **no se despliega
automaticamente**: hay que crearlo y activarlo manualmente en Cloudflare,
como pide el encargo de este cambio.

## Que ya existe en el repo

- `functions/api/run-closing-catchup.js`: Pages Function que, dado un header
  `x-cron-secret` valido, genera los cierres "sin confirmar" que falten
  (mismo criterio que el catch-up del navegador: cualquier dia anterior a
  hoy en hora de America/Santo_Domingo, o el dia de hoy solo en su ultimo
  minuto) y escribe un registro en `erp_audit_log` con cuantos cierres creo.
- Desde julio 2026 el modelo es de **exactamente dos cierres por dia**:
  `closingType: "register"` (caja registradora) y `closingType: "treasury"`
  (consolidado de bancos, caja fuerte, caja chica y demas cuentas). El
  endpoint nunca crea un cierre por cuenta, y tambien normaliza (sin borrar
  datos) los cierres antiguos que no tengan `closingType` todavia.
- Ese endpoint valida el secreto contra `env.CLOSING_CRON_SECRET`. Sin esa
  variable configurada, responde 500 en vez de ejecutar nada.
- `functions/api/booking/send-reminders.js`: mismo patron, pero para las
  citas "Preaprobadas" por el chatbot. Dado un header `x-cron-secret` valido
  (`env.BOOKING_REMINDER_CRON_SECRET`), recorre `reservas`, usa
  `checkPreapprovedConfirmationReminder()` (el mismo motor que ya usaba el
  banner de la Matriz Consolidada) para decidir por cada cita si hay que:
  - enviar un **recordatorio** al cliente (`booking.preapproved_reminder`,
    una vez por cada `hourlyCycle` — no reenvia el mismo recordatorio si el
    cron corre varias veces dentro de la misma hora), o
  - **escalar a un agente humano** (`booking.preapproved_escalation`) cuando
    la hora de la cita ya llego y sigue sin confirmarse en el salon.

  Ambos casos llaman a `POST https://bot.sebengroup.com/webhook/overdue-reminders`
  del Chatbot Bridge, autenticado con `env.ERP_WEBHOOK_SECRET` (cabecera
  `x-webhook-secret`, el mismo secreto compartido que usa
  `notify-invoice-sent.js`). El progreso de cada cita (`lastReminderCycleSent`,
  `escalatedAt`) se guarda en el propio registro de la reserva para no
  reenviar el mismo aviso en la siguiente corrida del cron.

## Paso a paso para activar el cron real

### 1. Generar los secretos y configurarlos en Cloudflare Pages

```bash
openssl rand -hex 32
```

Repetir para cada secreto (van a salir valores distintos cada vez que se
corre el comando). En el dashboard de Cloudflare Pages → proyecto
`dalfi-erp` → Settings → Environment variables, agregar (como variable
**secreta**, no en `wrangler.toml`):

```
CLOSING_CRON_SECRET = <valor generado>
BOOKING_REMINDER_CRON_SECRET = <otro valor generado>
ERP_WEBHOOK_SECRET = <el mismo secreto compartido que se configuro en el .env
                       del Chatbot Bridge como ERP_WEBHOOK_SECRET — ver
                       dalfi-chatbot-n8n/.env.example>
```

`CHATBOT_BRIDGE_URL` no hace falta configurarla salvo que el bridge deje de
vivir en `https://bot.sebengroup.com` — tanto `send-reminders.js` como
`notify-invoice-sent.js` usan ese dominio por defecto si la variable no esta
presente.

### 2. Crear el Worker del cron (proyecto aparte)

Crear una carpeta nueva fuera de `outputs/` (por ejemplo
`cron-worker/`) con estos dos archivos. El mismo Worker dispara **dos**
trabajos con horarios distintos: el catch-up de cierres (una vez al dia) y
los recordatorios/escalaciones de citas preaprobadas del chatbot (cada hora
— ver seccion siguiente).

`cron-worker/wrangler.toml`:

```toml
name = "dalfi-erp-closing-cron"
main = "worker.js"
compatibility_date = "2026-07-09"

# 03:59 UTC = 23:59 en America/Santo_Domingo (RD no tiene horario de verano,
# esta siempre en UTC-4), o sea que este cron dispara justo al final del dia
# operativo de la Republica Dominicana.
# El segundo horario ("0 * * * *") dispara cada hora en punto, para los
# recordatorios de citas preaprobadas del chatbot (ver mas abajo).
[triggers]
crons = ["59 3 * * *", "0 * * * *"]
```

`cron-worker/worker.js`:

```js
export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "59 3 * * *") {
      const response = await fetch("https://<TU-DOMINIO-DE-CLOUDFLARE-PAGES>/api/run-closing-catchup", {
        method: "POST",
        headers: { "x-cron-secret": env.CLOSING_CRON_SECRET },
      });
      if (!response.ok) {
        console.error("Cron de cierres fallo", response.status, await response.text());
      }
      return;
    }

    if (event.cron === "0 * * * *") {
      const response = await fetch("https://<TU-DOMINIO-DE-CLOUDFLARE-PAGES>/api/booking/send-reminders", {
        method: "POST",
        headers: { "x-cron-secret": env.BOOKING_REMINDER_CRON_SECRET },
      });
      if (!response.ok) {
        console.error("Cron de recordatorios de citas fallo", response.status, await response.text());
      }
    }
  },
};
```

Reemplazar `<TU-DOMINIO-DE-CLOUDFLARE-PAGES>` por el dominio real del
proyecto (por ejemplo `dalfi-erp.pages.dev` o el dominio propio).

### 3. Configurar los mismos secretos en el Worker

```bash
cd cron-worker
wrangler secret put CLOSING_CRON_SECRET
wrangler secret put BOOKING_REMINDER_CRON_SECRET
```

(pedira pegar el mismo valor generado en el paso 1, y el generado para
`BOOKING_REMINDER_CRON_SECRET` en la seccion siguiente).

### 4. Desplegar el Worker

```bash
wrangler deploy
```

Este paso **no se ejecuto** como parte de este cambio: el despliegue queda
pendiente de que el equipo lo confirme, siguiendo la regla de no
desplegar/hacer push sin autorizacion.

### 5. Verificar

Tras desplegar, se puede disparar manualmente para probar:

```bash
curl -X POST "https://<TU-DOMINIO>/api/run-closing-catchup" \
  -H "x-cron-secret: <CLOSING_CRON_SECRET>"

curl -X POST "https://<TU-DOMINIO>/api/booking/send-reminders" \
  -H "x-cron-secret: <BOOKING_REMINDER_CRON_SECRET>"
```

El primero debe responder `{"ok":true,"created":N}`. Un `N` en 0 es normal
si ya no hay cierres pendientes por generar en ese momento.

El segundo debe responder `{"ok":true,"remindersSent":N,"escalationsSent":N,"failures":[]}`.
Ceros son normales si no hay citas preaprobadas dentro de la ventana de 4h en
ese momento. Si `failures` no esta vacio, cada entrada trae el `reservaID` y
el error devuelto por el bridge (revisar `ERP_WEBHOOK_SECRET` primero — es la
causa mas comun de fallo).

## Que sigue funcionando si el cron todavia no esta activo

El catch-up del navegador (`ensureProvisionalClosings`, disparado al cargar
la app, al recuperar el foco, en cada sincronizacion remota y cada 30
segundos mientras la pestana esta abierta) sigue funcionando exactamente
igual que antes. El cron de cierres es un respaldo para cuando nadie tiene
el ERP abierto, no un reemplazo.

El banner de "Citas Preaprobadas por Chatbot pendientes de confirmación" en
la Matriz Consolidada tambien sigue funcionando igual (sigue siendo la forma
en que el salon confirma la cita manualmente) — el cron de recordatorios es
un canal adicional hacia el cliente por WhatsApp, no depende de que la
matriz este abierta ni la reemplaza.
