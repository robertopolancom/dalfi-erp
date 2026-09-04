# dalfi-erp-calendar-sync-cron — RETIRADO 2026-09-04

**Este Worker ya no existe en Cloudflare.** Se borró de la cuenta el 2026-09-04.
El código se conserva aquí, rescatado de Cloudflare porque no estaba en ningún
checkout local.

## Por qué se retiró

Llamaba a `POST /api/calendar/google-pull` sobre `APP_BASE_URL`, que apuntaba a
`https://dalfi-erp.pages.dev`. Ese proyecto de Cloudflare Pages se borró el
2026-08-24. La ruta tampoco existe en el backend vivo de Render: devuelve 404.

Disparaba **cada minuto** (`* * * * *`), así que llevaba unas 16.000
invocaciones fallidas acumuladas sin generar ningún efecto.

## Qué se pierde, y qué no

El sincronizado ERP → Google Calendar **no depende de este Worker**: lo hace el
backend en línea, llamando a `syncChangedAppointmentsToGoogleCalendar()` en cada
cita creada o modificada (ver `server/app.mjs`).

Lo que hacía este Worker era la dirección contraria — **Google → ERP**, traer al
ERP los cambios hechos directamente en Google Calendar. Esa dirección lleva sin
funcionar desde el 2026-08-24, con Worker o sin él. Si alguien edita una cita en
Google Calendar, el ERP no se entera.

## Para revivirlo

1. Escribir `POST /api/calendar/google-pull` en `server/app.mjs` (Neon), portando
   la lógica de `functions/api/_lib/google-calendar.js`, que fue escrita contra
   Supabase y hoy es código muerto.
2. Volver a desplegar este Worker con `APP_BASE_URL` apuntando a
   `sebensuiteconnect.dalfistudio.com` y un `GOOGLE_CALENDAR_SYNC_SECRET` nuevo.
3. Revisar la frecuencia: cada minuto es agresivo para un salón de uñas.
