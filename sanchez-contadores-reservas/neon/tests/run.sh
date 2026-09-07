#!/usr/bin/env bash
# run.sh — aplica las migraciones y ejecuta las pruebas SQL.
#
# Contra un Postgres local desechable:
#   PGURL="postgresql://postgres@127.0.0.1:5433/scr" RECREAR=1 ./neon/tests/run.sh
#
# Contra una rama de pruebas de Neon (NUNCA producción):
#   PGURL="$DATABASE_URL_TEST" ./neon/tests/run.sh
#
# RECREAR=1  borra y vuelve a crear la base antes de migrar. Las migraciones son
#            versionadas y no idempotentes, así que necesitan una base limpia.
#            NUNCA lo uses contra producción. En Neon lo natural es crear una
#            rama de la base para pruebas en vez de recrear nada.
set -euo pipefail
cd "$(dirname "$0")/../.."

PGURL="${PGURL:?define PGURL con la cadena de conexión}"
psql_run() { psql "$PGURL" -v ON_ERROR_STOP=1 -q "$@"; }

if [ "${RECREAR:-0}" = "1" ]; then
  BASE="$(basename "${PGURL%%\?*}")"
  ADMIN="${PGURL%/*}/postgres"
  echo "== Recreando la base '$BASE' =="
  psql "$ADMIN" -v ON_ERROR_STOP=1 -q \
    -c "drop database if exists \"$BASE\" with (force)" \
    -c "create database \"$BASE\""
fi

echo "== Migraciones =="
for f in neon/migrations/*.sql; do
  echo "   $f"
  psql_run -f "$f"
done

echo "== Pruebas de reglas de negocio =="
psql "$PGURL" -v ON_ERROR_STOP=1 -f neon/tests/reglas.test.sql 2>&1 \
  | grep -Ev '^(BEGIN|ROLLBACK|CREATE|INSERT|DO)' \
  | sed 's/^psql:[^ ]* NOTICE:  //'

echo "== Prueba de concurrencia =="
PGURL="$PGURL" ./neon/tests/concurrencia.test.sh

echo ""
echo "Todo en verde."
