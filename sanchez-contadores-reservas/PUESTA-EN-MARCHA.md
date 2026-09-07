# Puesta en marcha — Reserva de fechas, Sánchez Contadores

**Informe para Claude Code.** Este documento es autosuficiente: contiene todo lo
necesario para llevar la aplicación desde el código hasta producción, sin
depender de ninguna conversación anterior.

---

## 0. Situación de partida

### Qué existe

El código está escrito, probado y empujado a GitHub.

| Dato | Valor |
|---|---|
| Repositorio | `robertopolancom/dalfi-erp` |
| Rama | `claude/creemos-startup-6vcckx` |
| Subcarpeta | `sanchez-contadores-reservas/` |
| Último commit | `055935a` |

### Qué NO existe todavía

Nada fuera de GitHub. Estas son las cuentas y recursos que hay que **crear y
registrar** durante esta puesta en marcha:

- [ ] Repositorio propio en GitHub (el código vive hoy dentro del repo del ERP)
- [ ] Proyecto y base de datos en **Neon**
- [ ] Servicio web y cron job en **Render**
- [ ] Registro DNS en **Cloudflare** (`sebengroup.com`)
- [ ] Dominio verificado en **Resend**
- [ ] Cuenta de administrador de la contadora dentro de la aplicación

### Qué es la aplicación

Los centros educativos clientes de Sánchez Contadores reservan la fecha en que
se prepara su reporte contable anual. Reemplaza la coordinación por WhatsApp.

- **Público, sin login:** eligen su centro de una lista, tocan un día del
  calendario y reciben un código de reserva.
- **Contadora, con login:** calendario general, reservas con exportación a
  Excel, solicitudes de cambio, bloqueos, centros, feriados y configuración.

### Arquitectura

| Capa | Tecnología |
|---|---|
| Frontend | React 19 + TypeScript estricto + Vite + Tailwind |
| Servidor | Express 5 sobre Node 22, TypeScript compilado |
| Base de datos | Neon (PostgreSQL), vía `pg.Pool` |
| Hospedaje | Render: un servicio web + un cron job |
| Dominio | `sanchezcontadores.sebengroup.com` (DNS en Cloudflare) |
| Correo | Resend, API HTTP |
| Autenticación | Propia: `scrypt` + cookie `HttpOnly` |

**Un solo servicio sirve la API y el frontend compilado.** No hay CORS que
configurar ni dos despliegues que sincronizar.

**Las reglas de negocio viven en SQL**, no en el servidor ni en el navegador.
El servidor valida la entrada y traduce respuestas; el frontend solo pinta.

---

## 1. Cómo usar este informe

Instrucciones para Claude Code:

1. **Ve fase por fase.** Cada una termina con una verificación. No pases a la
   siguiente sin que la verificación pase.
2. **Nunca escribas un secreto en un archivo del repositorio.** Todos los
   valores sensibles se introducen a mano en los paneles de Neon, Render y
   Cloudflare. En este documento aparecen como `<PLACEHOLDER>`.
3. **La persona está delante de la computadora.** Cuando haga falta entrar a un
   panel web, dile exactamente qué pantalla abrir y qué pegar; no intentes
   hacerlo tú.
4. **Si algo falla, mira primero la sección 9** (catálogo de problemas
   conocidos) antes de improvisar. Los siete casos de ahí ya se detectaron y
   tienen causa identificada.
5. **No cambies la lógica de negocio** para hacer pasar un despliegue. Si una
   regla estorba, dilo y pregunta.

---

## 2. Fase 0 — Repositorio propio

El código está hoy dentro de `dalfi-erp`, que es el ERP de otro cliente (Dalfi
Studio), con otro stack. Son dos productos distintos y deben separarse.

```bash
# Desde una copia local de dalfi-erp, en la rama del proyecto
git checkout claude/creemos-startup-6vcckx
git subtree split --prefix=sanchez-contadores-reservas -b scr-solo
```

La persona crea en GitHub un repositorio **vacío** llamado
`sanchez-contadores-reservas` (sin README ni .gitignore). Después:

```bash
git push git@github.com:<USUARIO>/sanchez-contadores-reservas.git scr-solo:main
```

**Verificación:** clonar el repo nuevo en una carpeta limpia y comprobar que
`npm install && npm run build` termina sin errores.

---

## 3. Fase 1 — Neon (base de datos)

### Crear

En https://console.neon.tech: proyecto nuevo, región la más cercana a
República Dominicana (`us-east-1` suele ser la mejor opción).

Copiar la cadena de conexión del endpoint **con pooling** (Neon la marca como
*Pooled connection*). Tiene esta forma:

```
postgresql://<usuario>:<clave>@<host>-pooler.<region>.aws.neon.tech/<base>?sslmode=require
```

> Si se usa el endpoint directo en vez del pooled, el plan gratuito agota
> conexiones rápido y la app empieza a dar errores intermitentes bajo carga.

### Aplicar las migraciones

Son seis, versionadas y **no idempotentes**: se aplican una sola vez, en orden,
sobre una base limpia.

```bash
export DATABASE_URL="<CADENA_POOLED_DE_NEON>"
npm run db:migrar
```

| Migración | Qué crea |
|---|---|
| `0001_esquema_base.sql` | Tablas, tipos, índices, administradores y sesiones |
| `0002_feriados_seed.sql` | Feriados de RD 2026 y 2027 (Ley 139-97) |
| `0003_motor_dias_laborables.sql` | Días laborables, fecha fin, ventana, cupo |
| `0004_reglas_reservas.sql` | Validación, creación atómica, solicitudes |
| `0005_vistas_publicas.sql` | Vistas agregadas y consulta por código |
| `0006_rate_limit_y_recordatorios.sql` | Rate limiting y recordatorios |

### Crear la cuenta de la contadora

```bash
npm run admin:crear -- <CORREO_CONTADORA> "<NOMBRE>" "<CONTRASEÑA_LARGA>"
```

La contraseña debe tener al menos 12 caracteres. Se guarda como hash `scrypt`,
nunca en claro. El mismo comando, repetido con otro correo, crea el
administrador de respaldo; repetido con el mismo correo, cambia la contraseña.

> Pídele la contraseña a la persona y que la escriba ella. No la generes tú ni
> la dejes en el historial de la terminal si se puede evitar.

### Cargar los centros educativos

Dos opciones: desde el panel una vez desplegado, o de golpe adaptando
`neon/seed/centros.ejemplo.sql` con la lista real.

### Verificación

```bash
psql "$DATABASE_URL" -c "select count(*) from feriados;"        # debe dar 24
psql "$DATABASE_URL" -c "select anio_activo, max_simultaneos from configuracion;"
psql "$DATABASE_URL" -c "select correo, activo from administradores;"
```

Esperado: 24 feriados, `anio_activo = 2027`, `max_simultaneos = 3`, y la cuenta
de la contadora activa.

---

## 4. Fase 2 — Render (servicio web)

### Crear

En https://dashboard.render.com: **New → Blueprint**, conectar el repositorio
nuevo. Render lee `render.yaml` y propone dos servicios:

- `sanchez-contadores-reservas` (web)
- `sanchez-contadores-recordatorios` (cron diario)

### Variables de entorno

Las que el blueprint ya fija, **no hay que tocar**:

| Variable | Valor | Por qué |
|---|---|---|
| `NODE_VERSION` | `22` | |
| `NODE_ENV` | `production` | Activa la cookie `Secure` y el TLS estricto a Neon |
| `SALTOS_DE_PROXY` | `2` | Cloudflare + Render son dos proxies. Ver problema 4 |
| `DETRAS_DE_CLOUDFLARE` | `1` | Lee la IP real de `CF-Connecting-IP` |
| `DOMINIO_CANONICO` | `sanchezcontadores.sebengroup.com` | |
| `APP_URL` | `https://sanchezcontadores.sebengroup.com` | Base de los enlaces de los correos |
| `PG_POOL_MAX` | `5` | |

Las marcadas `sync: false` se introducen **a mano** en el dashboard:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | La cadena pooled de Neon de la fase 1 |
| `RESEND_API_KEY` | Se obtiene en la fase 4. Puede quedar vacía al principio |
| `CORREO_REMITENTE` | `Sánchez Contadores <reservas@sebengroup.com>` |
| `CORREO_CONTADORA` | Correo donde la contadora recibe las copias |

`CRON_SECRET` lo genera Render solo en el servicio web. **Anótalo: hace falta
copiarlo al cron en la fase 5.**

### Verificación

Cuando termine el primer despliegue, con la URL `*.onrender.com` que da Render:

```bash
curl -s https://<SERVICIO>.onrender.com/health
# esperado: {"ok":true}
```

Si devuelve `{"ok":false}` o 503, la app no está viendo la base: revisa
`DATABASE_URL`.

> **Ojo:** `/health` solo comprueba la base de datos. Puede responder `ok` con
> el frontend caído. Ver problema 2.

---

## 5. Fase 3 — Cloudflare (DNS de sebengroup.com)

Sigue la convención que ya existe en el dominio (`dalfistudionails.sebengroup.com`):
un subdominio por cliente.

### Paso 1 — Registro DNS, con la nube GRIS

Panel de `sebengroup.com` → **DNS → Records → Add record**:

| Campo | Valor |
|---|---|
| Type | `CNAME` |
| Name | `sanchezcontadores` |
| Target | el destino que muestre Render en *Custom Domains* |
| Proxy status | **DNS only (nube gris)** |

**El orden importa.** Con la nube naranja desde el principio, Render puede no
completar la verificación del dominio, porque el tráfico termina en Cloudflare y
no ve el origen que espera.

> Nota de honestidad: esta es la secuencia recomendada habitual, pero no se ha
> verificado contra el comportamiento actual de Render. Si Render verifica con
> el proxy encendido, mejor: sigue adelante.

### Paso 2 — Añadir el dominio en Render

En el servicio web → **Settings → Custom Domains** → añadir
`sanchezcontadores.sebengroup.com`. Esperar a que Render diga
**Certificate issued**.

### Paso 3 — Encender el proxy

Ahora sí, cambiar el registro a **Proxied (nube naranja)** si se quiere el CDN y
la protección de Cloudflare delante.

### Paso 4 — SSL/TLS

**Esto es lo que más despliegues tumba.** Panel de `sebengroup.com` →
**SSL/TLS → Overview**:

| Ajuste | Valor obligatorio |
|---|---|
| Modo de cifrado | **Full (strict)** |
| Always Use HTTPS | Activado |

En modo `Flexible`, Cloudflare habla con Render por HTTP mientras el navegador
cree que va por HTTPS. Render redirige a HTTPS, Cloudflare vuelve a pedirlo por
HTTP, y así infinitamente: `ERR_TOO_MANY_REDIRECTS` y página inservible.

Además, sin HTTPS la cookie de sesión (que sale con `Secure`) no viaja, y no
habría forma de entrar al panel.

### Verificación

```bash
curl -sI https://sanchezcontadores.sebengroup.com/health | head -1
curl -s  https://sanchezcontadores.sebengroup.com/health
# esperado: HTTP/2 200  y  {"ok":true}

# La URL de Render debe redirigir al dominio bueno
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' \
  https://<SERVICIO>.onrender.com/consulta
# esperado: 308 -> https://sanchezcontadores.sebengroup.com/consulta
```

Y abrir `https://sanchezcontadores.sebengroup.com` en el navegador: debe
aparecer el formulario de reserva, no una pantalla en blanco ni un 500.

---

## 6. Fase 4 — Resend (correo)

### Crear y verificar el dominio

En https://resend.com → **Domains → Add Domain**. Usar `sebengroup.com` o un
subdominio de envío.

Resend da tres registros DNS (SPF, DKIM y normalmente DMARC). **Hay que crearlos
en Cloudflare**, en el mismo panel de DNS de la fase 3. Estos registros van
siempre con la **nube gris**: son TXT y CNAME de correo, no tráfico web.

Esperar a que Resend marque el dominio como **Verified**. Puede tardar minutos.

> Hasta que esté verificado, los correos fallan o van directos a spam. Es la
> causa número uno de "la app funciona pero no llegan los correos".

### Clave de API

**API Keys → Create API Key**, permiso de envío. Copiarla a `RESEND_API_KEY` en
Render (fase 2) y redesplegar.

### Verificación

Hacer una reserva de prueba desde el sitio y comprobar dos cosas:

```sql
-- Debe haber dos filas: una al centro y la copia a la contadora
select tipo_evento, destinatario, resultado, detalle
from notificaciones_log
order by enviado_en desc limit 5;
```

`resultado` debe decir `enviado`. Si dice `fallido`, la columna `detalle` trae
el error de Resend recortado.

---

## 7. Fase 5 — Cron de recordatorios

Envía el aviso a las reservas que empiezan dentro de exactamente **3 días
laborables** y que aún no lo recibieron. Corre a las **13:00 UTC**, que son las
9:00 en República Dominicana (UTC-4, sin horario de verano).

### El punto crítico

`CRON_SECRET` debe ser **idéntico** en el servicio web y en el cron job.

El blueprint usa `generateValue` en el servicio web, lo que crea un valor
distinto por servicio. Hay que copiarlo a mano:

1. Servicio web → **Environment** → copiar el valor de `CRON_SECRET`
2. Servicio cron → **Environment** → pegarlo en `CRON_SECRET`
3. También poner `APP_URL` en el cron: `https://sanchezcontadores.sebengroup.com`

Si no coinciden, el cron recibe **401 y no se envía ningún recordatorio**, en
silencio.

### Verificación

Disparar el cron a mano desde el panel de Render (**Trigger Run**) y revisar el
log. Debe imprimir algo como:

```
{ ok: true, enviados: 0 }
```

`enviados: 0` es correcto si no hay ninguna reserva a 3 días laborables vista.
Lo que importa es `ok: true`; un 401 significa que los secretos no coinciden.

---

## 8. Fase 6 — Prueba de humo completa

Con la persona delante, recorrer el flujo real en el navegador:

### Público

- [ ] Abrir `https://sanchezcontadores.sebengroup.com`
- [ ] El desplegable muestra los centros cargados
- [ ] **El calendario muestra días verdes disponibles.** Si está todo gris, ver
      problema 1
- [ ] Al tocar un día se ve el rango completo que ocuparía
- [ ] Completar la reserva y recibir el código `SC-2027-XXXXXX`
- [ ] Llega el correo de confirmación al centro y la copia a la contadora
- [ ] En `/consulta`, el código encuentra la reserva
- [ ] Enviar una solicitud de cambio; la fecha original **no** cambia

### Panel

- [ ] `/admin/entrar` con las credenciales de la contadora
- [ ] Una contraseña incorrecta da error genérico, sin decir si el correo existe
- [ ] El calendario muestra la reserva y el contador `1/3`
- [ ] La bandeja de solicitudes muestra la del paso anterior
- [ ] Aprobarla mueve la reserva y llega el correo al centro
- [ ] Exportar a Excel descarga el archivo con las columnas correctas
- [ ] Crear un bloqueo que choque con la reserva: **avisa y la lista, sin
      cancelarla**
- [ ] Salir; volver a `/admin/reservas` redirige al login

### Comprobación de que las reglas siguen vivas en producción

- [ ] Un centro que ya reservó no puede reservar otra vez
- [ ] Una fecha fuera del 1-feb / 31-jul se rechaza
- [ ] El cuarto centro simultáneo el mismo día se rechaza

---

## 9. Catálogo de problemas conocidos

Los siete casos que ya se detectaron, con su causa. Los tres primeros están
**corregidos en el código**; los cuatro siguientes son configuración que hay que
acertar.

### Problema 1 — El calendario aparece todo gris, sin ningún error

**Síntoma.** La API responde 200, no hay excepciones en la consola, pero todos
los días salen como no laborables y nadie puede reservar.

**Causa.** `pg` convierte las columnas `date` de Postgres en objetos `Date` de
JavaScript, y `JSON.stringify` los emite como instantes UTC:

```
Postgres  2027-02-01  →  navegador  "2027-02-01T00:00:00.000Z"
```

El frontend guarda los días en un `Map` con la fecha como clave y busca
`'2027-02-01'`. La búsqueda falla, `esLaborable()` devuelve `false` para todo.

**Arreglo (ya aplicado).** En `server/db.ts`:

```ts
pg.types.setTypeParser(1082, (valor: string) => valor)
```

**Cómo confirmar que sigue bien:**

```bash
curl -s https://sanchezcontadores.sebengroup.com/api/publico/disponibilidad \
  | head -c 120
# La fecha debe ser "2027-02-01", NO "2027-02-01T00:00:00.000Z"
```

### Problema 2 — Toda URL del frontend da 500, pero `/health` dice que todo va bien

**Síntoma.** La API responde, el health check de Render está en verde, y el
sitio da 500 en `/`, `/consulta` y cualquier otra ruta.

**Causa.** La ruta al `dist/` se resolvía relativa al módulo, que queda a
distinta profundidad compilado (`dist-server/server/`) que en fuente
(`server/`), así que apuntaba a una carpeta inexistente.

**Arreglo (ya aplicado).** Se resuelve desde el directorio de trabajo:
`path.resolve(process.cwd(), 'dist')`.

**Si reaparece:** comprobar que `npm start` se ejecuta desde la raíz del
proyecto y que `dist/` existe tras el build. La variable `DIR_ESTATICO` permite
forzar la ruta.

### Problema 3 — El cron delataba su configuración

**Síntoma.** Llamar al endpoint del cron sin autorización devolvía
`500: "CRON_SECRET no configurado"`.

**Causa.** Se comprobaba la configuración antes que la autorización.

**Arreglo (ya aplicado).** Ahora devuelve 401 siempre —sin secreto, con secreto
malo o sin configurar— y el aviso de configuración va al log del servidor.

### Problema 4 — Los centros reciben "demasiados intentos" sin haber intentado nada

**Síntoma.** El formulario público empieza a rechazar reservas legítimas.

**Causa.** Con Cloudflare delante hay **dos** proxies encadenados:

```
visitante → Cloudflare → proxy de Render → la app
```

Cloudflare añade la IP del visitante a `X-Forwarded-For` y el proxy de Render le
añade encima la suya. Comprobado:

```
XFF: '190.80.1.1, 172.68.5.5'   (visitante, Cloudflare)
  trust proxy = 1  →  req.ip = 172.68.5.5   ← la de Cloudflare
  trust proxy = 2  →  req.ip = 190.80.1.1   ← la del visitante
```

Con un solo salto, **todo el tráfico comparte el mismo contador**: el límite de
8 reservas por 10 minutos se agota para todos.

**Arreglo (ya aplicado).** Se lee `CF-Connecting-IP`, más `SALTOS_DE_PROXY=2`
como respaldo.

**Si se quita Cloudflare de en medio (nube gris permanente):** bajar
`SALTOS_DE_PROXY` a `1` y quitar `DETRAS_DE_CLOUDFLARE`.

### Problema 5 — `ERR_TOO_MANY_REDIRECTS`

**Causa.** SSL/TLS de Cloudflare en modo `Flexible`.

**Arreglo.** Ponerlo en **Full (strict)**. Ver fase 3, paso 4.

### Problema 6 — Pantalla en blanco después de un despliegue

**Síntoma.** Quien ya había visitado el sitio ve una página vacía; quien entra
por primera vez lo ve bien.

**Causa.** Vite pone un hash en el nombre de cada asset. Al desplegar, los
archivos con los hashes viejos **dejan de existir**. Si Cloudflare cacheó el
`index.html` anterior, ese HTML pide assets que ahora dan 404.

**Arreglo (ya aplicado).** Cabeceras explícitas:

| Qué | `Cache-Control` |
|---|---|
| `/api/*` | `no-store` |
| `index.html` | `no-cache` |
| `/assets/*` | `public, max-age=31536000, immutable` |

**Si reaparece:** purgar la caché en Cloudflare (**Caching → Purge Everything**)
y revisar que no haya una Page Rule forzando el cacheo de HTML.

### Problema 7 — Render no verifica el dominio

**Causa probable.** El CNAME se creó con la nube naranja encendida.

**Arreglo.** Pasarlo a nube gris, esperar a que Render emita el certificado, y
encender el proxy después.

---

## 10. Lo que sigue abierto a propósito

### La URL de Render sigue siendo alcanzable

`DOMINIO_CANONICO` redirige al subdominio bueno lo que entre por
`*.onrender.com`, lo que basta para navegadores. **No impide que un script llame
a Render directamente e invente la cabecera `CF-Connecting-IP`** para saltarse
el rate limiting.

El daño posible se limita a saturar el formulario público. Las reglas de negocio
viven en SQL, así que ni así se puede sobrevender un cupo, reservar dos veces
con el mismo centro ni salirse de la ventana.

Dos formas de cerrarlo, cuando se quiera:

1. Restringir el servicio de Render a los rangos de IP de Cloudflare.
2. Exigir una cabecera secreta que solo Cloudflare añada (Transform Rule en el
   panel) y rechazar en el servidor lo que no la traiga.

### Fuera de alcance del producto

No implementado a propósito: la generación del reporte contable, pagos,
facturación, cobros, NCF, la integración con WhatsApp (existe solo la interfaz
abstracta `CanalNotificacion` y un marcador sin registrar) y el registro o login
para los centros educativos.

---

## 11. Inventario de variables de entorno

| Variable | Dónde | Valor |
|---|---|---|
| `DATABASE_URL` | Render web | Cadena **pooled** de Neon. El secreto más sensible |
| `NODE_ENV` | Render web | `production` |
| `PORT` | Render web | Lo inyecta Render |
| `PG_POOL_MAX` | Render web | `5` |
| `SALTOS_DE_PROXY` | Render web | `2` con Cloudflare; `1` sin él |
| `DETRAS_DE_CLOUDFLARE` | Render web | `1` |
| `DOMINIO_CANONICO` | Render web | `sanchezcontadores.sebengroup.com` |
| `APP_URL` | Render web **y cron** | `https://sanchezcontadores.sebengroup.com` |
| `RESEND_API_KEY` | Render web | De Resend |
| `CORREO_REMITENTE` | Render web | `Sánchez Contadores <reservas@sebengroup.com>` |
| `CORREO_CONTADORA` | Render web | Correo de las copias internas |
| `CRON_SECRET` | Render web **y cron** | **El mismo valor en los dos** |
| `DIR_ESTATICO` | opcional | Solo si hay que forzar la ruta del `dist/` |

El frontend **no necesita ninguna variable**: se sirve desde el mismo origen que
la API y usa rutas relativas.

---

## 12. Qué está probado y qué no

### Verificado

| Suite | Qué cubre |
|---|---|
| 40 pruebas unitarias (Vitest) | Fechas, calendario, plantillas de correo |
| 56 aserciones SQL | Las 9 reglas de negocio, contra PostgreSQL 16 real |
| Prueba de concurrencia | Dos sesiones peleando el último cupo: una gana, sin sobreventa |
| 45 aserciones de API | Flujo completo contra servidor y base reales |

Comandos:

```bash
npm test                                              # unitarias
PGURL="postgresql://..." RECREAR=1 npm run db:test    # reglas SQL
DATABASE_URL="postgresql://..." ./neon/tests/api.test.sh   # API completa
```

> `db:test` y `api.test.sh` **borran datos**. Usarlos solo contra una base de
> pruebas o una rama de Neon, nunca contra producción.

### No verificado

Dicho claramente, para que nadie se lleve una sorpresa:

- **Nunca se ha conectado a Neon real** — solo a PostgreSQL 16 local. Es el
  mismo motor, pero el TLS y el pooling de Neon son primera vez.
- **Nunca se ha desplegado en Render.**
- **Nunca se ha enviado un correo por Resend.** El canal está escrito y sus
  plantillas probadas, pero jamás ha hablado con la API real.
- **DNS y certificados no se pueden probar sin el dominio real.**
- **La interfaz no se ha abierto en un navegador.** Compila y los componentes
  están escritos, pero nadie ha hecho clic en el calendario.

La fase 6 (prueba de humo) existe precisamente para cubrir esta última.

---

## 13. Datos del negocio, para contexto

Reglas que la aplicación hace cumplir. Si alguna se contradice con lo que diga
la contadora, **pregunta antes de cambiar nada**:

1. Solo se reserva entre el **1 de febrero y el 31 de julio** del año activo
   (2027), y la fecha de fin tampoco puede excederlo.
2. Días laborables: sin sábados, domingos, feriados ni bloqueos. Duración por
   centro, 5 días por defecto.
3. Máximo **3 centros simultáneos** en cualquier día laborable del rango
   completo, no solo el día inicial.
4. Sin límite mensual de centros.
5. **Una reserva por centro por año.** Solo cancelarla libera el cupo; una
   reserva ya entregada no habilita otra.
6. Cambios y cancelaciones solo por solicitud. Nada se mueve hasta que la
   contadora aprueba, y al aprobar se revalidan todas las reglas.
7. Los bloqueos **advierten** sobre reservas afectadas; nunca las cancelan.
8. Seguimiento: `reservada → en_proceso → entregada`.
9. Dos centros no pueden quedarse con el mismo hueco (lock por año en SQL).

### Sobre los feriados

Están sembrados desde el texto literal de la **Ley No. 139-97** (G.O. 9957, 25
de junio de 1997), no de memoria:

- **Art. 1:** un feriado trasladable que cae martes o miércoles se celebra el
  lunes precedente; jueves o viernes, el lunes siguiente. Sábado, domingo o
  lunes no se trasladan.
- **Art. 4 (trasladables):** 6 y 26 de enero, 1 de mayo, 16 de agosto,
  6 de noviembre.
- **Art. 2 (fijos):** 1 y 21 de enero, 27 de febrero, 24 de septiembre,
  25 de diciembre; más el 16 de agosto solo en año de toma de posesión.
- **Art. 3 (fijos, religiosos de fecha variable):** Jueves Santo, Viernes Santo
  y Corpus Christi.

El algoritmo se validó contra el anuncio oficial del Ministerio de Trabajo para
2026: los tres traslados que produce (5 de enero, 4 de mayo y 9 de noviembre)
coinciden con los publicados. La contadora puede editar la tabla `feriados`
desde **Ajustes**.

### Un detalle del calendario 2027

El **31 de julio de 2027 cae sábado**, así que el último día hábil de la ventana
es el viernes 30. Con una duración de 5 días, el último inicio válido es el
**lunes 26 de julio**. Está cubierto por las pruebas; no es un error.
