#!/usr/bin/env bash
# concurrencia.test.sh — Regla 9
#
# Deja la capacidad del 1-feb-2027 en 2 de 3 y lanza DOS solicitudes de reserva
# simultáneas para el último hueco desde centros distintos. El lock consultivo
# por año dentro de crear_reserva() debe permitir exactamente una.
#
#   PGURL="postgresql://postgres@127.0.0.1:5433/scr" ./supabase/tests/concurrencia.test.sh
set -euo pipefail
PGURL="${PGURL:?define PGURL, p.ej. postgresql://postgres@127.0.0.1:5433/scr}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

q() { psql "$PGURL" -qtAX -v ON_ERROR_STOP=1 -c "$1"; }

echo "== Preparando escenario =="
q "delete from solicitudes_cambio;
   delete from reservas;
   delete from bloqueos;
   delete from centros where nombre like 'CC-%';
   insert into centros (nombre, correo_contacto, telefono) values
     ('CC-ocupa-1','o1@test.do','1'), ('CC-ocupa-2','o2@test.do','2'),
     ('CC-corre-A','a@test.do','3'),  ('CC-corre-B','b@test.do','4');" > /dev/null

for n in CC-ocupa-1 CC-ocupa-2; do
  q "select crear_reserva((select id from centros where nombre='$n'),'2027-02-01','x@test.do','1')->>'ok'" > /dev/null
done
echo "  2 de 3 cupos ocupados el 2027-02-01"

# Cada sesión abre transacción, espera a la barrera y llama a crear_reserva.
carrera() {
  local centro="$1" salida="$2"
  psql "$PGURL" -qtAX -v ON_ERROR_STOP=1 > "$salida" 2>&1 <<SQL
begin;
select pg_sleep(0.3);
select crear_reserva((select id from centros where nombre='$centro'),'2027-02-01','x@test.do','1');
commit;
SQL
}

echo "== Lanzando dos reservas simultáneas para el último cupo =="
carrera CC-corre-A "$TMP/a.out" &
PID_A=$!
carrera CC-corre-B "$TMP/b.out" &
PID_B=$!
wait $PID_A $PID_B

OK_A=$(grep -c '"ok": true' "$TMP/a.out" || true)
OK_B=$(grep -c '"ok": true' "$TMP/b.out" || true)
TOTAL=$(q "select count(*) from reservas where estado in ('reservada','en_proceso')
             and '2027-02-01' between fecha_inicio and fecha_fin")

echo "  sesión A ok=$OK_A"
echo "  sesión B ok=$OK_B"
echo "  reservas activas ese día: $TOTAL"

fallos=0
if [ "$((OK_A + OK_B))" -ne 1 ]; then
  echo "FALLA: debía triunfar exactamente una sesión, triunfaron $((OK_A + OK_B))"; fallos=1
else
  echo "  ok  exactamente una de las dos reservas simultáneas fue aceptada"
fi

if [ "$TOTAL" -ne 3 ]; then
  echo "FALLA: el día quedó con $TOTAL reservas activas, el máximo es 3"; fallos=1
else
  echo "  ok  el día quedó exactamente en el máximo de 3, sin sobreventa"
fi

if grep -q 'SIN_CUPO' "$TMP/a.out" "$TMP/b.out"; then
  echo "  ok  la sesión perdedora recibió SIN_CUPO"
else
  echo "FALLA: la sesión perdedora no informó SIN_CUPO"; fallos=1
fi

q "delete from reservas; delete from centros where nombre like 'CC-%';" > /dev/null
exit $fallos
