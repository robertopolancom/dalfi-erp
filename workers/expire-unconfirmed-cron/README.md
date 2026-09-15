# dalfi-erp-expire-unconfirmed-cron

Worker de Cloudflare que cada madrugada cierra como **"No asistió"** las citas que nadie confirmó
y cuya hora ya pasó.

## Por qué existe

Una cita en `scheduled` **no aparta el horario** (ver `neon/migrations/0024_*.sql`: el constraint
`appointments_no_staff_overlap` solo bloquea con `confirmed`/`completed`). Mientras nadie la
confirme, es como si el cliente no tuviera cita, y confirmarla o retirarla es responsabilidad del
salón.

Si esa cita nunca se confirma y su hora pasa, dejarla en `scheduled` para siempre hace dos daños:
el calendario miente sobre qué pasó ese día, y la agenda del equipo se llena de citas que ya no
significan nada.

Si el cliente **sí** vino, alguien le habrá puesto "Atendida" — y eso gana: `completed` cuenta
como confirmada (desplaza a las que competían por el horario, ver `setAppointmentStatus`).

## Qué NO hace

- No toca citas `confirmed`: esas sí apartaron el horario y merecen que una persona diga si el
  cliente vino o no.
- No toca nada terminal (`cancelled`, `replaced`, `completed`, `no_show`).
- No decide nada por su cuenta. Toda la regla vive en `expireUnconfirmedPastAppointments`
  (`server/store.mjs`); el Worker solo dispara la llamada.

Es **reversible**: si la cita se atiende tarde y alguien la marca después, pasa de `no_show` a
`completed` sin pelear.

## Configuración (no se ejecutó como parte de la tarea que creó este Worker)

El secreto tiene que existir en **los dos lados con exactamente el mismo valor**. Genera uno
nuevo, no reutilices otro:

```sh
openssl rand -hex 32
```

1. **En Cloud Run** (servicio `dalfi-erp`, us-east1): añade la variable de entorno
   `EXPIRE_UNCONFIRMED_CRON_SECRET` con ese valor y despliega la revisión.

2. **En el Worker**, desde esta carpeta:

```sh
npx wrangler secret put EXPIRE_UNCONFIRMED_CRON_SECRET
npx wrangler deploy
```

Mientras la variable no exista en Cloud Run, el endpoint responde **500** y no hace nada: el cron
falla sin romper nada, y las citas se quedan como están hasta que alguien las cierre a mano.

## Comprobar que funciona

```sh
npx wrangler tail dalfi-erp-expire-unconfirmed-cron
```

Cada ejecución deja una línea JSON con `ok`, `status`, `durationMs` y `expiredCount`. Nunca
registra el secreto ni el cuerpo de la respuesta.

## Horario

`0 7 * * *` → 07:00 UTC = **3:00 a.m. hora de Santo Domingo**. Una vez al día alcanza: lo que
decide qué cerrar es la hora de cada cita y el margen de `GRACE_MINUTES`, no cuándo pase el cron.
