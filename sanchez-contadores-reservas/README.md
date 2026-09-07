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
6. [Pruebas](#pruebas)
7. [Despliegue](#despliegue)
8. [Guía de uso para la contadora](#guía-de-uso-para-la-contadora)
9. [Fuera de alcance](#fuera-de-alcance)

---

## Arquitectura

| Capa | Tecnología |
|---|---|
| Frontend | React 19 + TypeScript estricto + Vite + Tailwind CSS |
| Hospedaje | Cloudflare Pages |
| Base de datos | Supabase (PostgreSQL) |
| Autenticación | Supabase Auth, solo para la contadora |
| Lógica de servidor | Funciones SQL/PL-pgSQL + Edge Functions (Deno) |
| Correo | Resend, detrás de una interfaz `CanalNotificacion` |
| Excel | SheetJS (`xlsx`), generado en el navegador |

### Dónde vive cada regla

La fuente de verdad es **PostgreSQL**. Las reglas de disponibilidad, cupo
simultáneo, ventana de trabajo y bloqueos viven en funciones SQL
(`supabase/migrations/0003` y `0004`) y son lo único que decide si una reserva
existe.

El módulo `src/domain/` es un **espejo en cliente** cuyo único propósito es
pintar el calendario y dar respuesta inmediata. No duplica el conocimiento de
feriados ni de bloqueos: parte de la vista `disponibilidad_publica`, que ya trae
resuelto qué días son laborables. Si el usuario tarda y el hueco se llena, el
servidor rechaza la reserva y la interfaz recarga la disponibilidad.

Las pruebas del espejo corren contra un *fixture* generado por la vista real
(`supabase/tests/exportar_fixture.sql`), así que cliente y servidor no pueden
divergir en silencio.

### Superficie pública

El rol `anon` **no toca ninguna tabla**. Solo puede:

- leer tres vistas agregadas (`centros_publicos`, `disponibilidad_publica`,
  `configuracion_publica`), que nunca revelan qué centro ocupa qué día ni los
  datos de contacto de otros centros;
- ejecutar `consultar_reserva(codigo)`;
- llamar a dos Edge Functions (`crear-reserva`, `solicitar-cambio`), que validan
  la entrada con zod, aplican *rate limiting* y delegan en las funciones SQL.

Toda lectura y escritura administrativa exige sesión autenticada; las políticas
de RLS admiten sin cambios un segundo administrador de respaldo.

```
src/
  domain/       lógica pura y probada (fechas, calendario)  ← sin dependencias
  lib/          cliente de Supabase, tipos, llamadas, exportación a Excel
  components/   Calendario, SelectorCentro, avisos
  features/
    publico/    reservar · éxito · consulta por código
    admin/      login · calendario · reservas · solicitudes · bloqueos ·
                centros · ajustes
supabase/
  migrations/   esquema, feriados, motor de reglas, vistas y RLS  (0001–0006)
  functions/    Edge Functions + capa de notificaciones
  tests/        pruebas SQL, concurrencia y exportador del fixture
  seed/         plantilla para cargar la lista inicial de centros
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
único parcial en `supabase/migrations/0001_esquema_base.sql`.

### Feriados y Ley 139-97

`supabase/migrations/0002_feriados_seed.sql` precarga los feriados nacionales de
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

Requisitos: Node 20 o superior y una cuenta de Supabase.

```bash
npm install
cp .env.example .env.local   # y complétalo
npm run dev                  # http://localhost:5173
```

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

### Frontend (Cloudflare Pages)

| Variable | Para qué |
|---|---|
| `VITE_SUPABASE_URL` | URL del proyecto de Supabase |
| `VITE_SUPABASE_ANON_KEY` | Clave `anon`. Es pública por diseño: quien protege los datos es RLS |
| `VITE_APP_URL` | URL pública del sitio |

La clave `service_role` **nunca** debe aparecer en el frontend.

### Edge Functions (`supabase secrets set`)

| Variable | Para qué |
|---|---|
| `RESEND_API_KEY` | Clave de API de Resend |
| `CORREO_REMITENTE` | `Sánchez Contadores <reservas@tu-dominio.do>`, con el dominio verificado en Resend |
| `CORREO_CONTADORA` | Destino de las copias internas |
| `APP_URL` | Base de los enlaces de los correos |
| `CRON_SECRET` | Secreto compartido con el cron de recordatorios |
| `ORIGENES_PERMITIDOS` | Lista separada por comas de orígenes CORS. Por defecto `*` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` las inyecta
Supabase automáticamente en las Edge Functions.

---

## Base de datos y migraciones

Las migraciones son versionadas y **no idempotentes**: se aplican en orden sobre
una base limpia.

| Archivo | Contenido |
|---|---|
| `0001_esquema_base.sql` | Tablas, tipos, restricciones e índices |
| `0002_feriados_seed.sql` | Feriados 2026 y 2027 con la documentación de la Ley 139-97 |
| `0003_motor_dias_laborables.sql` | Días laborables, fecha fin, ventana, cupo, código de reserva |
| `0004_reglas_reservas.sql` | Validación, creación atómica, solicitudes y resolución |
| `0005_vistas_publicas_y_rls.sql` | Vistas públicas, consulta por código, RLS y permisos |
| `0006_rate_limit_y_recordatorios.sql` | Rate limiting y selección de recordatorios |

Con el CLI de Supabase:

```bash
supabase link --project-ref <ref>
supabase db push
```

O directamente:

```bash
for f in supabase/migrations/*.sql; do psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"; done
```

Después:

1. Crea la cuenta de la contadora en **Authentication → Users** (email +
   contraseña). Para el administrador de respaldo basta con crear una segunda
   cuenta: las políticas de RLS ya la cubren.
2. Carga los centros desde el panel o adapta
   `supabase/seed/centros.ejemplo.sql`.
3. Revisa **Ajustes**: año activo, ventana y máximo simultáneo.

### Edge Functions

```bash
supabase functions deploy crear-reserva
supabase functions deploy solicitar-cambio
supabase functions deploy resolver-solicitud
supabase functions deploy enviar-recordatorios
```

`crear-reserva` y `solicitar-cambio` son públicas; `resolver-solicitud` exige el
JWT de la contadora; `enviar-recordatorios` exige la cabecera `x-cron-secret`.

### Recordatorios

Programa una llamada diaria (pg_cron, Cron Trigger de Cloudflare o cualquier
programador):

```
POST https://<proyecto>.supabase.co/functions/v1/enviar-recordatorios
x-cron-secret: <CRON_SECRET>
```

Envía el aviso a las reservas que empiezan dentro de exactamente 3 días
laborables y que aún no lo recibieron, según `notificaciones_log`. Es seguro
llamarla más de una vez al día: no duplica envíos.

---

## Pruebas

```bash
npm test        # 40 pruebas unitarias (Vitest)
npm run build   # typecheck estricto + build de producción
```

Pruebas de las reglas de negocio contra un PostgreSQL real:

```bash
PGURL="postgresql://postgres@127.0.0.1:5433/scr" RECREAR=1 STUB=1 npm run db:test
```

Cubren, entre otros casos límite:

- una reserva que termina en el último día hábil de la ventana (el 31 de julio
  de 2027 cae sábado, así que el último inicio válido con 5 días de duración es
  el lunes 26 de julio);
- un feriado trasladado: el lunes 25 de enero de 2027 no es laborable y el
  martes 26, su fecha original, sí lo es;
- el tercer y el cuarto centro simultáneo, y un rango que solapa parcialmente;
- un bloqueo que parte un rango y lo estira sin cambiar su número de días
  laborables;
- concurrencia real: dos sesiones simultáneas peleando por el último cupo, con
  exactamente una ganadora y sin sobreventa.

`STUB=1` crea los roles y el esquema `auth` que Supabase ya trae de fábrica.
`RECREAR=1` borra y recrea la base: **nunca lo uses contra producción**.

---

## Despliegue

### Cloudflare Pages

| Ajuste | Valor |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | 20 o superior |

Define `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` y `VITE_APP_URL` en las
variables de entorno del proyecto, para *Production* y *Preview*.

`public/_redirects` ya envía cualquier ruta a `index.html` para que React Router
funcione al recargar una URL profunda, y `public/_headers` añade las cabeceras
de seguridad y el cacheo de los *assets*.

Una vez publicado, añade el dominio a `ORIGENES_PERMITIDOS` en los secretos de
Supabase para cerrar CORS.

---

## Guía de uso para la contadora

**Entrar.** `https://<tu-dominio>/admin/entrar` con tu correo y contraseña.

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
  `CanalNotificacion` y un marcador en
  `supabase/functions/_shared/notifications/whatsapp.ts`, sin registrar. Añadir
  el canal no obliga a tocar plantillas ni disparadores de eventos;
- registro o login para los centros educativos.
