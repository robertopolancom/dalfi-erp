# Cierres automaticos por cron (Cloudflare Workers Cron Triggers)

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

## Paso a paso para activar el cron real

### 1. Generar un secreto y configurarlo en Cloudflare Pages

```bash
openssl rand -hex 32
```

En el dashboard de Cloudflare Pages → proyecto `dalfi-erp` → Settings →
Environment variables, agregar (como variable **secreta**, no en
`wrangler.toml`):

```
CLOSING_CRON_SECRET = <el valor generado>
```

### 2. Crear el Worker del cron (proyecto aparte)

Crear una carpeta nueva fuera de `outputs/` (por ejemplo
`cron-worker/`) con estos dos archivos:

`cron-worker/wrangler.toml`:

```toml
name = "dalfi-erp-closing-cron"
main = "worker.js"
compatibility_date = "2026-07-09"

# 03:59 UTC = 23:59 en America/Santo_Domingo (RD no tiene horario de verano,
# esta siempre en UTC-4), o sea que este cron dispara justo al final del dia
# operativo de la Republica Dominicana.
[triggers]
crons = ["59 3 * * *"]
```

`cron-worker/worker.js`:

```js
export default {
  async scheduled(event, env, ctx) {
    const response = await fetch("https://<TU-DOMINIO-DE-CLOUDFLARE-PAGES>/api/run-closing-catchup", {
      method: "POST",
      headers: { "x-cron-secret": env.CLOSING_CRON_SECRET },
    });
    if (!response.ok) {
      console.error("Cron de cierres fallo", response.status, await response.text());
    }
  },
};
```

Reemplazar `<TU-DOMINIO-DE-CLOUDFLARE-PAGES>` por el dominio real del
proyecto (por ejemplo `dalfi-erp.pages.dev` o el dominio propio).

### 3. Configurar el mismo secreto en el Worker

```bash
cd cron-worker
wrangler secret put CLOSING_CRON_SECRET
```

(pedira pegar el mismo valor generado en el paso 1).

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
  -H "x-cron-secret: <el valor generado>"
```

Debe responder `{"ok":true,"created":N}`. Un `N` en 0 es normal si ya no hay
cierres pendientes por generar en ese momento.

## Que sigue funcionando si el cron todavia no esta activo

El catch-up del navegador (`ensureProvisionalClosings`, disparado al cargar
la app, al recuperar el foco, en cada sincronizacion remota y cada 30
segundos mientras la pestana esta abierta) sigue funcionando exactamente
igual que antes. El cron es un respaldo para cuando nadie tiene el ERP
abierto, no un reemplazo.
