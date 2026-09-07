# Reserva de fechas — Sánchez Contadores

Aplicación web *mobile-first* para que los centros educativos clientes de
Sánchez Contadores reserven la fecha en que se preparará y presentará su
reporte contable anual. Sustituye la coordinación manual por WhatsApp con un
calendario que aplica reglas de negocio y un panel para la contadora.

- **Público, sin login:** el centro se elige de una lista precargada, se toca un
  día del calendario, se confirman los datos de contacto y se recibe un código
  de reserva.
- **Contadora, con login:** calendario general, listado con filtros y
  exportación a Excel, bandeja de solicitudes, bloqueos, centros, feriados y
  configuración.

---

## Índice

1. [Arquitectura](#arquitectura)
2. [Reglas de negocio](#reglas-de-negocio)
3. [Instalación](#instalación)
4. [Variables de entorno](#variables-de-entorno)
5. [Base de datos y migraciones](#base-de-datos-y-migraciones)
6. [La API](#la-api)
7. [Pruebas](#pruebas)
8. [Despliegue](#despliegue)
9. [Guía de uso para la contadora](#guía-de-uso-para-la-contadora)
10. [Fuera de alcance](#fuera-de-alcance)

---

## Arquitectura

| Capa | Tecnología |
|---|---|
| Frontend | React 19 + TypeScript estricto + Vite + Tailwind CSS |
| Servidor | Express 5 sobre Node 22, en TypeScript compilado |
| Base de datos | Neon (PostgreSQL), vía `pg.Pool` y `DATABASE_URL` |
| Hospedaje | Render: un servicio web + un cron job |
| Dominio | `sanchezcontadores.sebengroup.com`, con DNS en Cloudflare |
| Autenticación | Propia: `scrypt` para la contraseña, tokens de sesión en cookie `HttpOnly` |
| Correo | Resend por API HTTP, detrás de una interfaz `CanalNotificacion` |
| Excel | SheetJS (`xlsx`), generado en el navegador |

**Un solo servicio sirve la API y el frontend compilado.** El `dist/` de Vite lo
entrega el mismo Express que responde `/api`, así que el navegador siempre habla
con un único origen: no hay CORS que configurar, ni una URL de API en variables
de entorno del frontend, ni dos despliegues que mantener sincronizados.

### Dónde vive cada regla

La fuente de verdad es **PostgreSQL**. Las reglas de disponibilidad, cupo
simultáneo, ventana de trabajo y bloqueos viven en funciones SQL
(`neon/migrations/0003` y `0004`) y son lo único que decide si una reserva
existe. El servidor Express valida la entrada y traduce respuestas; no reimplementa
ninguna regla.

El módulo `src/domain/` es un **espejo en cliente** cuyo único propósito es
pintar el calendario y dar respuesta inmediata. No duplica el conocimiento de
feriados ni de bloqueos: parte de la vista `disponibilidad_publica`, que ya trae
resuelto qué días son laborables. Si el usuario tarda y el hueco se llena, el
servidor rechaza la reserva y la interfaz recarga la disponibilidad.

Las pruebas del espejo corren contra un *fixture* generado por la vista real
(`neon/tests/exportar_fixture.sql`), así que cliente y servidor no pueden
divergir en silencio.

### Autorización

Neon no tiene roles por usuario final, así que **no hay Row Level Security**: la
base solo acepta la conexión del servicio, y `DATABASE_URL` nunca sale del
servidor. Los controles están donde sí pueden estar:

| Control | Dónde |
|---|---|
| Autenticación de la contadora | `server/auth.ts` — `scrypt`, comparación en tiempo constante |
| Sesiones | Cookie `HttpOnly` + `SameSite=Lax`; en la base solo se guarda el SHA-256 del token |
| Qué puede pedir el público | Las rutas de `server/rutas-publicas.ts` y tres vistas agregadas |
| Validación de entrada | `zod` en `server/validacion.ts`, antes de tocar la base |
| Abuso del formulario público | `consumir_rate_limit()` por IP y por tipo de operación |

Las vistas públicas (`centros_publicos`, `disponibilidad_publica`,
`configuracion_publica`) devuelven conteos agregados: nunca revelan qué centro
ocupa qué día ni los datos de contacto de otros centros.

```
src/
  domain/       lógica pura y probada (fechas, calendario)  ← sin dependencias
  lib/          cliente HTTP, tipos, llamadas, exportación a Excel
  components/   Calendario, SelectorCentro, avisos
  features/
    publico/    reservar · éxito · consulta por código
    admin/      login · calendario · reservas · solicitudes · bloqueos ·
                centros · ajustes
server/
  index.ts      arranque, pool, apagado limpio
  app.ts        Express, cabeceras, cron, servido de la SPA
  db.ts         pool de Neon, helpers de consulta, rate limit
  auth.ts       scrypt, sesiones
  validacion.ts esquemas zod
  rutas-*.ts    rutas públicas y de administración
  notificaciones/  CanalNotificacion, Resend, plantillas, marcador de WhatsApp
neon/
  migrations/   esquema, feriados, motor de reglas y vistas  (0001–0006)
  tests/        pruebas SQL, concurrencia, API completa y exportador del fixture
  seed/         plantilla para cargar la lista inicial de centros
  migrar.sh     aplica las migraciones sobre DATABASE_URL
scripts/
  crear-admin.ts  alta o cambio de contraseña de un administrador
```

---

## Reglas de negocio

| # | Regla | Dónde se aplica |
|---|---|---|
| 1 | Solo del 1 de febrero al 31 de julio del año activo; la fecha fin tampoco puede excederlo | `validar_reserva` |
| 2 | Días laborables: sin sábados, domingos, feriados ni bloqueos; duración por centro (5 por defecto) | `es_dia_laborable`, `calcular_fecha_fin` |
| 3 | Máximo 3 centros simultáneos en cualquier día laborable del **rango completo** | `primer_dia_sin_cupo` |
| 4 | Sin límite mensual de centros | — |
| 5 | Una reserva por centro por año | índice único parcial + `validar_reserva` |
| 6 | Cambios y cancelaciones solo por solicitud; nada se mueve hasta la aprobación, que revalida todo | `crear_solicitud`, `resolver_solicitud` |
| 7 | Los bloqueos los crea solo la contadora y **advierten** sobre reservas afectadas sin cancelarlas | `reservas_afectadas_por_rango` |
| 8 | Estados de seguimiento `reservada → en_proceso → entregada` | panel de reservas |
| 9 | Dos centros no pueden quedarse con el mismo hueco | `pg_advisory_xact_lock` dentro de `crear_reserva` |

### Sobre la regla 5

Solo el estado `cancelada` libera el cupo anual de un centro. Una reserva
`entregada` significa que el trabajo del año ya se hizo, así que tampoco
habilita una segunda reserva en el mismo año. Está implementado como índice
único parcial en `neon/migrations/0001_esquema_base.sql`.

### Feriados y Ley 139-97

`neon/migrations/0002_feriados_seed.sql` precarga los feriados nacionales de
**2026 y 2027** y documenta en comentarios qué se traslada y qué no, citando los
artículos de la Ley No. 139-97 (G.O. 9957, 25 de junio de 1997):

- **Artículo 1:** un feriado trasladable que cae martes o miércoles se celebra
  el lunes precedente; jueves o viernes, el lunes siguiente. Sábado, domingo o
  lunes no se trasladan.
- **Artículo 4 (trasladables):** 6 de enero, 26 de enero, 1 de mayo,
  16 de agosto y 6 de noviembre.
- **Artículo 2 (fijos):** 1 de enero, 21 de enero, 27 de febrero,
  24 de septiembre y 25 de diciembre; más el 16 de agosto **solo** cuando
  coincide con el inicio de un período constitucional.
- **Artículo 3 (fijos por ser religiosos de día variable):** Jueves Santo,
  Viernes Santo y Corpus Christi. Viernes Santo = Pascua − 2 días;
  Corpus Christi = Pascua + 60 días.

El listado sembrado se verificó contra el anuncio oficial del Ministerio de
Trabajo para 2026: los tres traslados que produce el algoritmo (5 de enero,
4 de mayo y 9 de noviembre de 2026) coinciden con los publicados.

La contadora puede editar la tabla `feriados` desde **Ajustes**; el motor lee
siempre la tabla, nunca constantes en el código.

---

## Instalación

Requisitos: Node 22 o superior, y un PostgreSQL (Neon en producción, uno local
para desarrollar).

```bash
npm install
cp .env.example .env          # y complétalo
npm run db:migrar             # aplica las migraciones sobre DATABASE_URL
npm run admin:crear -- contadora@dominio.do "Nombre" "contraseña-larga"

npm run dev:server            # API en :3000
npm run dev                   # frontend en :5173, con proxy de /api a :3000
```

En desarrollo hacen falta las dos: Vite sirve el frontend con recarga en
caliente y reenvía `/api` al servidor. En producción es un solo proceso.

### Nota sobre la dependencia `xlsx`

Se instala desde el CDN oficial de SheetJS y **no desde npm**:

```json
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

El paquete publicado en npm está congelado en la versión 0.18.5, afectada por
CVE-2023-30533 (contaminación de prototipo); las versiones corregidas solo se
distribuyen por el CDN de SheetJS. Si tu red bloquea `cdn.sheetjs.com`, replica
el tarball en un registro interno antes de cambiar la referencia.

---

## Variables de entorno

Ningún secreto va en el código ni en Git. `.env.example` está sin valores.

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Cadena de Neon. **El secreto más sensible**: con ella se lee y escribe todo |
| `PG_POOL_MAX` | Conexiones máximas del pool. 5 por defecto |
| `RESEND_API_KEY` | Clave de API de Resend |
| `CORREO_REMITENTE` | `Sánchez Contadores <reservas@tu-dominio.do>`, con el dominio verificado en Resend |
| `CORREO_CONTADORA` | Destino de las copias internas |
| `APP_URL` | Base de los enlaces de los correos |
| `CRON_SECRET` | Protege `POST /api/cron/recordatorios` |
| `PORT` | Puerto de escucha. Render lo inyecta |
| `DIR_ESTATICO` | Ruta del `dist/`. Solo para casos raros; por defecto `<raíz>/dist` |
| `SALTOS_DE_PROXY` | Proxies delante de la app. **2** con Cloudflare + Render; 1 sin Cloudflare |
| `DETRAS_DE_CLOUDFLARE` | `1` para leer la IP real de `CF-Connecting-IP` |
| `DOMINIO_CANONICO` | Redirige a este dominio lo que entre por otro (la URL de Render) |

**El frontend no necesita ninguna variable.** Se sirve desde el mismo origen que
la API y usa rutas relativas, así que no hay nada que inyectar en el bundle.

---

## Base de datos y migraciones

Las migraciones son versionadas y **no idempotentes**: se aplican en orden sobre
una base limpia.

| Archivo | Contenido |
|---|---|
| `0001_esquema_base.sql` | Tablas, tipos, restricciones e índices; administradores y sesiones |
| `0002_feriados_seed.sql` | Feriados 2026 y 2027 con la documentación de la Ley 139-97 |
| `0003_motor_dias_laborables.sql` | Días laborables, fecha fin, ventana, cupo, código de reserva |
| `0004_reglas_reservas.sql` | Validación, creación atómica, solicitudes y resolución |
| `0005_vistas_publicas.sql` | Vistas agregadas y consulta por código |
| `0006_rate_limit_y_recordatorios.sql` | Rate limiting y selección de recordatorios |

```bash
DATABASE_URL="postgresql://..." npm run db:migrar
```

Después:

1. Crea la cuenta de la contadora:
   ```bash
   npm run admin:crear -- contadora@dominio.do "Nombre" "contraseña-larga"
   ```
   Para el administrador de respaldo basta con volver a ejecutarlo con otro
   correo. El mismo comando cambia la contraseña de una cuenta existente.
2. Carga los centros desde el panel o adapta `neon/seed/centros.ejemplo.sql`.
3. Revisa **Ajustes**: año activo, ventana y máximo simultáneo.

Para probar migraciones sin tocar producción, crea una **rama de Neon** y apunta
`DATABASE_URL` a ella: es una copia instantánea que se descarta después.

### Un apunte sobre fechas

`server/db.ts` registra un parser para el tipo `date` de Postgres (OID 1082) que
devuelve la cadena `YYYY-MM-DD` tal cual. Sin él, `pg` entrega un `Date` de
JavaScript y `JSON.stringify` lo convierte en un instante UTC, lo que desalinea
el calendario entero. Todo el dominio trata las fechas como días de calendario,
nunca como instantes.

---

## La API

Todo cuelga de `/api`. Las respuestas de error tienen siempre la forma
`{ ok: false, codigo_error, mensaje }`, con el mensaje ya redactado para
mostrárselo a la persona.

### Público (sin sesión)

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/publico/centros` | Lista para el desplegable. Sin datos de contacto |
| `GET` | `/api/publico/disponibilidad` | Un registro por día de la temporada, con cupo agregado |
| `GET` | `/api/publico/configuracion` | Año activo, ventana y máximo simultáneo |
| `POST` | `/api/publico/reservas` | Crea la reserva. Limitado a 8 intentos por IP cada 10 min |
| `GET` | `/api/publico/reservas/:codigo` | Consulta por código. 30 intentos por IP cada 10 min |
| `POST` | `/api/publico/solicitudes` | Cambio o cancelación. 10 intentos por IP cada 10 min |

### Panel (cookie de sesión)

`POST /api/admin/sesion` para entrar, `DELETE` para salir, `GET /api/admin/yo`
para saber si hay sesión. Después: `reservas`, `solicitudes`, `centros`,
`bloqueos`, `feriados` y `configuracion`, con sus verbos habituales.

### Cron

`POST /api/cron/recordatorios` con la cabecera `x-cron-secret`. Envía el aviso a
las reservas que empiezan dentro de exactamente 3 días laborables y que aún no lo
recibieron, según `notificaciones_log`; de paso purga sesiones caducadas y
contadores de rate limit. Es seguro llamarlo más de una vez al día: no duplica
envíos.

---

## Pruebas

```bash
npm test         # 40 pruebas unitarias (Vitest)
npm run build    # typecheck estricto de los tres proyectos + build
```

Reglas de negocio contra un PostgreSQL real:

```bash
PGURL="postgresql://postgres@127.0.0.1:5433/scr" RECREAR=1 npm run db:test
```

La API completa contra un servidor y una base reales:

```bash
DATABASE_URL="postgresql://postgres@127.0.0.1:5433/scr_api" ./neon/tests/api.test.sh
```

Levanta el servidor compilado, recorre el flujo entero (reservar, consultar,
solicitar, entrar al panel, resolver, bloquear, cambiar estado, cron, salir) y lo
apaga. **Usa una base de pruebas: borra reservas, centros y bloqueos al empezar.**

Entre las tres suites se cubren, además de cada regla:

- una reserva que termina en el último día hábil de la ventana (el 31 de julio
  de 2027 cae sábado, así que el último inicio válido con 5 días de duración es
  el lunes 26 de julio);
- un feriado trasladado: el lunes 25 de enero de 2027 no es laborable y el
  martes 26, su fecha original, sí lo es;
- el tercer y el cuarto centro simultáneo, y un rango que solapa parcialmente;
- un bloqueo que parte un rango y lo estira sin cambiar su número de días
  laborables;
- concurrencia real: dos sesiones simultáneas peleando por el último cupo, con
  exactamente una ganadora y sin sobreventa;
- que el panel responde 401 sin sesión y vuelve a hacerlo tras salir;
- que un correo inexistente y una contraseña incorrecta dan el **mismo** mensaje,
  para no delatar qué cuentas existen;
- que la lista pública de centros no filtra correos ni teléfonos;
- que detrás de Cloudflare cada visitante tiene su propio contador de rate
  limiting y no hereda el bloqueo de otro;
- que la redirección al dominio canónico conserva la ruta y no se muerde la cola
  (una redirección mal hecha ahí es un bucle infinito en producción);
- que el `index.html` no se cachea y los assets con hash sí, para que Cloudflare
  no deje a nadie pegado a la versión anterior tras un despliegue.

---

## Despliegue

La app se publica en **`sanchezcontadores.sebengroup.com`**, siguiendo la misma
convención que `dalfistudionails.sebengroup.com`: un subdominio por cliente en
el dominio corporativo de SEBEN Group. El DNS de `sebengroup.com` está en
Cloudflare, y `render.yaml` es un blueprint con dos servicios: el web y el cron
diario.

### 1. Neon

Crea el proyecto y copia la cadena del endpoint **con pooling**. Aplica las
migraciones y crea la cuenta de la contadora:

```bash
DATABASE_URL="postgresql://..." npm run db:migrar
DATABASE_URL="postgresql://..." npm run admin:crear -- contadora@dominio.do "Nombre" "contraseña-larga"
```

### 2. Render

Conecta el repositorio. El blueprint define build (`npm ci && npm run build`),
arranque (`npm start`) y `healthCheckPath: /health`. En **Settings → Custom
Domains** añade `sanchezcontadores.sebengroup.com`; Render mostrará el destino
CNAME que hay que crear en Cloudflare.

Las variables marcadas `sync: false` se introducen a mano en el dashboard:
`DATABASE_URL`, `RESEND_API_KEY`, `CORREO_REMITENTE` y `CORREO_CONTADORA`.

### 3. Cloudflare (DNS de sebengroup.com)

En el panel de `sebengroup.com` → **DNS → Records**:

| Tipo | Nombre | Contenido | Proxy |
|---|---|---|---|
| `CNAME` | `sanchezcontadores` | el destino que dé Render (`*.onrender.com`) | ver abajo |

**El orden importa.** Crea el registro con el **proxy desactivado (nube gris)**
y espera a que Render marque el dominio como verificado y emita el certificado.
Con la nube naranja desde el principio, Render puede no completar la
verificación, porque no ve el origen que espera.

Cuando Render diga *Certificate issued*, enciende el proxy (nube naranja) si
quieres el CDN y la protección de Cloudflare delante.

**SSL/TLS → Overview: modo `Full (strict)`.** Este es el ajuste que más
problemas da: en modo `Flexible`, Cloudflare habla con Render por HTTP mientras
el navegador cree que va por HTTPS, y el resultado es un **bucle de
redirecciones** que deja la página inservible. Render sirve HTTPS válido, así
que `Full (strict)` es lo correcto.

Activa también **Always Use HTTPS**. La cookie de sesión sale con `Secure`
cuando `NODE_ENV=production`, así que sin HTTPS no habría manera de entrar al
panel.

### 4. Los dos saltos de proxy

Con Cloudflare encendido, el camino de una petición es:

```
visitante → Cloudflare → proxy de Render → la app
```

Son **dos** proxies, no uno. Por eso el blueprint pone `SALTOS_DE_PROXY=2` y
`DETRAS_DE_CLOUDFLARE=1`. Si se dejaran en la configuración de un solo proxy,
`req.ip` devolvería la IP de Cloudflare y **todo el tráfico del mundo
compartiría el mismo contador de rate limiting**: en cuanto entrara la novena
reserva del día, los centros legítimos quedarían bloqueados sin motivo. Hay
pruebas que cubren exactamente ese caso en `neon/tests/api.test.sh`.

Si algún día quitas Cloudflare de en medio (nube gris permanente), baja
`SALTOS_DE_PROXY` a 1 y quita `DETRAS_DE_CLOUDFLARE`.

### 5. Una puerta que queda entreabierta

El servicio de Render sigue siendo alcanzable por su URL `*.onrender.com`.
`DOMINIO_CANONICO` redirige esas visitas al subdominio bueno, lo que basta para
navegadores y para que la app no quede indexada dos veces, pero **no impide que
un script llame a Render directamente e invente la cabecera `CF-Connecting-IP`**
para saltarse el rate limiting.

El daño posible se limita a saturar el formulario público: las reglas de negocio
viven en SQL, así que ni con eso se puede sobrevender un cupo, reservar dos veces
con el mismo centro ni salirse de la ventana. Para cerrarlo del todo hay dos
caminos, cuando quieras:

- restringir el servicio de Render a los rangos de IP de Cloudflare, o
- exigir una cabecera secreta que solo Cloudflare añada, con una Transform Rule
  en el panel, y rechazar en el servidor lo que no la traiga.

### 6. Resend

Verifica **`sebengroup.com`** (o el subdominio que uses como remitente) en
Resend antes de esperar correos: hasta que los registros SPF y DKIM estén
publicados en Cloudflare, los envíos fallan o van directos a spam.

### 7. El cron

`CRON_SECRET` debe ser **idéntico** en el servicio web y en el cron. El
blueprint lo genera solo en el web; cópialo al cron a mano. Si no coinciden, los
recordatorios fallan con 401 y no se envía nada.

Corre a las 13:00 UTC, que son las 9:00 en República Dominicana (UTC-4, sin
horario de verano).

### Cambiar el subdominio

Si prefieres otro nombre, son tres sitios y un registro de DNS: el campo
`domains` de `render.yaml`, y las variables `DOMINIO_CANONICO` y `APP_URL`.
Nada en el código lo tiene escrito a mano.

---

## Guía de uso para la contadora

**Entrar.** `https://sanchezcontadores.sebengroup.com/admin/entrar` con tu
correo y contraseña. La sesión dura 14 días.

**Calendario.** Vista mensual de la temporada. Cada día muestra los centros que
lo ocupan y un contador `usados/máximo`; se pone en rojo cuando el día llegó al
tope. Los colores distinguen reservada, en proceso, entregada y cancelada.

**Reservas.** Filtra por estado y por mes. El botón **Marcar en proceso** y
luego **Marcar entregada** llevan el seguimiento del trabajo. **Exportar a
Excel** descarga el listado filtrado con centro, contacto, fechas, duración,
estado y código.

**Solicitudes.** Aquí llegan los cambios y cancelaciones que piden los centros.
Nada se modificó todavía: la reserva sigue en su fecha original hasta que
apruebes. Al aprobar un cambio se revalidan la ventana, los días laborables y el
cupo sobre la nueva fecha; si esa fecha ya no cumple alguna regla, verás el
motivo y la reserva se queda como estaba. Puedes escribir una nota que se
incluye en el correo de respuesta.

**Bloqueos.** Para vacaciones, capacitaciones o cualquier día que no quieras
trabajar. Al elegir el rango, el sistema te avisa si choca con reservas ya
hechas y te las lista. **No cancela nada por su cuenta**: la decisión de mover
esas reservas es tuya, y se hace pidiéndole al centro que envíe una solicitud de
cambio.

**Centros.** Alta, edición, duración personalizada en días laborables y
activar/desactivar. Un centro inactivo desaparece del formulario público pero
conserva su historial.

**Ajustes.** Año activo, máximo de centros simultáneos, ventana de reservas y
tabla de feriados. Cambiar el máximo simultáneo afecta a las reservas nuevas;
las ya confirmadas no se tocan.

### Qué recibe cada quien por correo

| Evento | Al centro | Copia a la contadora |
|---|---|---|
| Reserva creada | sí | sí |
| Solicitud recibida | sí | sí |
| Solicitud aprobada | sí | no |
| Solicitud rechazada | sí | no |
| Recordatorio 3 días laborables antes | sí | no |

Todos los envíos quedan registrados en `notificaciones_log` con canal,
destinatario, evento y resultado.

---

## Fuera de alcance

Deliberadamente **no** implementado:

- la generación del reporte contable en sí;
- pagos, facturación, cobros y NCF;
- la integración con WhatsApp: existe solo la interfaz abstracta
  `CanalNotificacion` y un marcador en `server/notificaciones/whatsapp.ts`, sin
  registrar. Añadir el canal no obliga a tocar plantillas ni disparadores de
  eventos;
- registro o login para los centros educativos.
