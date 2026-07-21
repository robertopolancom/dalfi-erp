-- Migracion: corregir can_review_accounts para roles privilegiados
-- Fecha: 2026-07-21
--
-- Bug encontrado en la verificacion posterior a aplicar
-- 20260721000000_create_erp_user_profiles.sql: la formula SQL del backfill
-- calculo can_review_accounts como
--   (role in ('contador', 'contadora')) OR flag explicito de user_metadata
-- SIN incluir a administradora/administrador/propietaria/propietario. Esto
-- contradice:
--   (a) el comportamiento original antes de esta fase
--       (DalfiClosingMath.canReviewAccounts en outputs/lib/closing-math.js:
--       isPrivilegedRole(role) OR ACCOUNT_REVIEW_ROLES.has(role) OR
--       explicitFlag), y
--   (b) el mirror en JS de la propia fase 1
--       (defaultPermissionsForRole en functions/api/_lib/authz.js:
--       can_review_accounts: privileged || reviewer), que SI incluye a los
--       roles privilegiados y es el que usa upsertErpProfile() para toda
--       escritura posterior al backfill (creacion/edicion de usuarios).
--
-- Impacto real confirmado en produccion antes de esta migracion: los 2
-- perfiles administradora existentes quedaron con can_review_accounts=false
-- tras el backfill, lo que les oculta el boton "Cuentas" en la UI (marcado
-- solo con la clase "accounts-review-only" en outputs/index.html, no
-- tambien con "admin-only" — ver canReviewAccountsUser() en outputs/app.js).
-- Sus demas permisos administrativos (usuarios, facturas, cierres) no se
-- vieron afectados: el bug estaba unicamente en esta columna.
--
-- A proposito NO se edita 20260721000000_create_erp_user_profiles.sql (ya
-- aplicada): esta migracion nueva corrige los datos ya insertados y queda
-- como registro auditable del error y su correccion. Es idempotente (el
-- WHERE solo afecta filas que todavia no cumplen la condicion correcta) y
-- no toca ningun otro permiso ni ningun perfil no privilegiado.
update public.erp_user_profiles
set can_review_accounts = true
where role in ('administradora', 'administrador', 'propietaria', 'propietario')
  and can_review_accounts = false;

-- === Rollback documentado (NO se ejecuta como parte de esta migracion) =====
-- Revertir esta correccion no tiene sentido (dejaria el bug), pero si
-- alguna vez hiciera falta deshacerla especificamente para las filas que
-- esta migracion toco (no hay forma de distinguir cuales eran false antes
-- sin el respaldo previo a esta migracion), habria que restaurar desde el
-- respaldo correspondiente en .local-backups/.
