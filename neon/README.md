# Migración de Dalfi ERP a Neon

La migración se ejecuta primero en la rama `migration-staging`. La rama `main`
no recibe datos reales hasta completar reconciliación, pruebas funcionales y un
corte final reversible.

## ⚠️ NO activar `reservapp.sebengroup.com` todavía

`server/app.mjs` (Render) hoy solo cubre `/api/reservapp/*` y
`/api/fast-booking/*` — el backend de ReservApp. NO tiene
`booking/availability`, `confirm`, `cancel`, `reschedule`, `clients`,
`staff`, `services`, `bank-accounts`, `POST /api/database` (lo que usa
`outputs/app.js`, la pantalla del personal), `users`/`create-user`,
`run-closing-catchup`, ni `audit-log`. Esas rutas siguen existiendo solo
en `functions/api/**` (Cloudflare Pages + Supabase), y el chatbot
(`ERP_BASE_URL` en `dalfi-chatbot-n8n`) las necesita para funcionar.

Neon (`app.appointments`) y Supabase (documento único vía `erp_records`)
**no se sincronizan entre sí**. Una cita creada en ReservApp hoy es
invisible para el personal que usa `dalfi-erp.pages.dev`, y viceversa.

Mientras esto no esté resuelto (portar los endpoints faltantes a Render),
NO apuntar el dominio público `reservapp.sebengroup.com` a este
servicio — solo `ssc.sebengroup.com` (sin difusión pública) para pruebas
controladas.

## Reglas

- Nunca guardar cadenas de conexión, contraseñas ni dumps en Git.
- Conservar un snapshot JSON inmutable de cada importación.
- Todos los importadores deben ser idempotentes.
- Comparar conteos de origen/destino y relaciones antes de aprobar el corte.
- Supabase permanece como fuente de verdad hasta el corte final.
- Google Calendar es de solo salida y nunca escribe en la ERP.

## Orden

1. `0001_migration_foundation.sql`: staging y núcleo de agenda/clientes.
2. Mapear desde la copia real las tablas financieras e inventario.
3. Ejecutar el importador en `migration-staging`.
4. Reconciliar y probar ERP, API, agenda y chatbot.
5. Repetir la importación final durante una ventana sin escrituras.

## Primera cuenta superadministrador de ReservApp

`POST /api/reservapp/admin/accounts` exige ya tener una sesión administradora/
superadministrador (o un admin ERP, que nunca puede crear un
superadministrador) — a propósito no hay bootstrap por HTTP. Con la
colaboradora ya creada en `app.staff` y `DATABASE_URL` apuntando a Neon:

```bash
DATABASE_URL=postgres://... node scripts/bootstrap-reservapp-admin.mjs \
  --staff-id <uuid-de-app.staff> --phone 8095551234
```

Imprime una contraseña temporal una sola vez si no se pasa `--password`.
