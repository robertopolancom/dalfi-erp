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

## Qué se pierde: nada. Era contrario al diseño

**Google Calendar es un espejo de SOLO LECTURA**, por decisión de Roberto
(confirmada 2026-09-04). El calendario existe para *mirar* la agenda, no para
editarla.

El flujo correcto es de una sola dirección, y así debe quedarse:

    chatbot  ─┐
    ReservApp ┼──>  ERP  ──>  Google Calendar
    ERP (edición propia) ─┘        (solo lectura)

Las citas se crean y se modifican **únicamente** desde el ERP o desde la PWA de
ReservApp. El ERP es la única fuente de verdad: recoge las entradas del chatbot,
de ReservApp y de su propia edición de citas, y de ahí empuja a Google llamando
a `syncChangedAppointmentsToGoogleCalendar()` en cada cita creada o modificada
(ver `server/app.mjs`). Eso funciona y no depende de este Worker.

Lo que hacía este Worker era traer de vuelta a Google → ERP, que es exactamente
lo que el diseño NO quiere: convertiría al calendario en una segunda fuente de
verdad editable, con dos sistemas capaces de mover la misma cita.

## NO lo revivas

Si alguna vez alguien propone reactivarlo, la respuesta por defecto es no. El
código se conserva aquí solo como registro histórico de lo que existió, no como
una tarea pendiente. Reactivarlo exigiría además escribir
`POST /api/calendar/google-pull` en `server/app.mjs`, que hoy no existe —
pero antes de eso habría que revisar la decisión de diseño con Roberto.
