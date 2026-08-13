# Migración de Dalfi ERP a Neon

La migración se ejecuta primero en la rama `migration-staging`. La rama `main`
no recibe datos reales hasta completar reconciliación, pruebas funcionales y un
corte final reversible.

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
