#!/usr/bin/env bash
# migrar.sh — aplica las migraciones en orden sobre DATABASE_URL.
#
#   DATABASE_URL="postgresql://..." npm run db:migrar
#
# Las migraciones son versionadas y no idempotentes: se aplican una sola vez,
# en orden, sobre una base limpia. Para volver a probarlas desde cero usa una
# rama nueva de Neon en vez de recrear la base de producción.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?define DATABASE_URL}"

for f in neon/migrations/*.sql; do
  echo "--> $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo "Migraciones aplicadas."
