# Respaldo, restauración y RLS

Procedimiento operativo para SeBen Service / Dalfi Studio Nails. Ningún paso
de este documento debe ejecutarse contra producción sin revisar el proyecto y
la referencia de Supabase enlazados.

## 1. Crear un respaldo

Usar la CLI autenticada de Supabase y guardar el esquema y los datos fuera del
repositorio, con permisos restringidos:

```sh
npx supabase db dump --linked --file /ruta/segura/seben-schema.sql
npx supabase db dump --linked --data-only --file /ruta/segura/seben-data.sql
chmod 600 /ruta/segura/seben-schema.sql /ruta/segura/seben-data.sql
shasum -a 256 /ruta/segura/seben-schema.sql /ruta/segura/seben-data.sql
```

Registrar en un manifiesto: proyecto, referencia, fecha UTC, tamaño, hash y
resultado de la restauración de prueba. Nunca guardar el respaldo en Git ni
publicar sus datos.

## 2. Validar restauración

Restaurar primero en una base temporal o proyecto aislado. La restauración
debe terminar con `ON_ERROR_STOP=1` y comprobar como mínimo:

- `erp_records`, `erp_user_profiles` y `erp_audit_log` legibles;
- perfiles sin usuarios Auth huérfanos;
- claves `(table_name, record_key)` sin duplicados;
- RPC `save_erp_record_if_current` presente;
- RLS habilitada en las tablas protegidas.

Eliminar la base temporal al terminar. No restaurar encima de producción como
prueba.

## 3. Aplicar una migración RLS

Antes de aplicar:

```sh
npx supabase migration list --linked
npx supabase db push --dry-run --linked
```

Después de revisar el dry-run:

```sh
npx supabase db push --linked
npx supabase migration list --linked
```

Las migraciones ya aplicadas son inmutables. Si se necesita revertir una
decisión RLS, crear una nueva migración forward; no editar ni borrar la
migración histórica.

## 4. Verificación posterior

Comprobar, sin escribir datos:

- `/api/database` autenticado devuelve `200`;
- lectura directa de `erp_records` por cliente devuelve `401/403`;
- escritura directa y RPC de guardado no están expuestos;
- auditoría solo es legible según la política RLS;
- Worker de cierres sin secreto devuelve `401`;
- el deployment y `CLOSING_CRON_SECRET` del Worker siguen presentes.

Si falla una verificación, detener el despliegue coordinado y conservar el
respaldo original para recuperación.

