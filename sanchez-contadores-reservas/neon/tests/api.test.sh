#!/usr/bin/env bash
# api.test.sh — recorre la API completa contra un servidor y una base reales.
#
#   DATABASE_URL="postgresql://..." ./neon/tests/api.test.sh
#
# Levanta el servidor compilado, ejecuta el flujo entero (reservar, consultar,
# solicitar, entrar al panel, resolver, cron) y lo apaga. Usa una base de
# pruebas: BORRA reservas, centros y bloqueos al empezar.
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${DATABASE_URL:?define DATABASE_URL}"
PUERTO="${PUERTO:-3999}"
BASE="http://127.0.0.1:$PUERTO"
TMP="$(mktemp -d)"
COOKIES="$TMP/cookies.txt"
fallos=0

ok()    { echo "  ok  $1"; }
falla() { echo "  FALLA: $1"; fallos=1; }
comprobar() { if [ "$2" = "$3" ]; then ok "$1"; else falla "$1 (esperado '$3', obtenido '$2')"; fi }

jq_() { node -e "
  let e='';process.stdin.on('data',d=>e+=d).on('end',()=>{
    try{const o=JSON.parse(e);const v=process.argv[1].split('.').reduce((a,k)=>a?.[k],o);
    console.log(v===undefined?'':typeof v==='object'?JSON.stringify(v):v)}catch{console.log('')}})
" "$1"; }

echo "== Preparando base de pruebas =="
psql "$DATABASE_URL" -qtAX \
  -c "delete from notificaciones_log; delete from solicitudes_cambio; delete from reservas;
      delete from bloqueos; delete from centros; delete from rate_limit_publico;
      update configuracion set anio_activo = 2027, max_simultaneos = 3 where id = 1;
      insert into centros (nombre, correo_contacto, telefono) values
        ('Colegio API Uno','uno@test.do','809-000-0001'),
        ('Colegio API Dos','dos@test.do','809-000-0002');" > /dev/null

echo "== Levantando el servidor =="
# RESEND_API_KEY va con un valor falso a propósito: el escenario de prueba no
# tiene ninguna reserva en plazo de recordatorio, así que el notificador se
# construye pero nunca llega a llamar a Resend. Ningún correo sale de aquí.
PORT="$PUERTO" NODE_ENV=test CRON_SECRET=secreto-de-prueba \
  RESEND_API_KEY=clave-falsa-de-prueba \
  CORREO_REMITENTE='Pruebas <pruebas@ejemplo.invalid>' \
  node dist-server/server/index.js > "$TMP/servidor.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$TMP"' EXIT

for _ in $(seq 1 40); do
  if curl -sf "$BASE/health" > /dev/null 2>&1; then break; fi
  sleep 0.25
done
comprobar "el servidor responde /health" "$(curl -s "$BASE/health" | jq_ ok)" "true"

echo ""
echo "== Rutas públicas =="
comprobar "configuración pública expone el año activo" \
  "$(curl -s "$BASE/api/publico/configuracion" | jq_ anio_activo)" "2027"
comprobar "la ventana empieza el 1 de febrero" \
  "$(curl -s "$BASE/api/publico/configuracion" | jq_ ventana_inicio)" "2027-02-01"
comprobar "la disponibilidad trae los 181 días de la temporada" \
  "$(curl -s "$BASE/api/publico/disponibilidad" | node -e "let e='';process.stdin.on('data',d=>e+=d).on('end',()=>console.log(JSON.parse(e).length))")" "181"

CENTROS="$(curl -s "$BASE/api/publico/centros")"
comprobar "el desplegable trae los dos centros activos" \
  "$(echo "$CENTROS" | node -e "let e='';process.stdin.on('data',d=>e+=d).on('end',()=>console.log(JSON.parse(e).length))")" "2"

if echo "$CENTROS" | grep -q "correo_contacto"; then
  falla "la lista pública NO debe exponer correos de los centros"
else
  ok "la lista pública no expone datos de contacto de los centros"
fi

ID1="$(echo "$CENTROS" | node -e "let e='';process.stdin.on('data',d=>e+=d).on('end',()=>console.log(JSON.parse(e)[0].id))")"

echo ""
echo "== Reservar =="
RES="$(curl -s -X POST "$BASE/api/publico/reservas" -H 'Content-Type: application/json' \
  -d "{\"centro_id\":\"$ID1\",\"fecha_inicio\":\"2027-02-01\",\"correo_contacto\":\"uno@test.do\",\"telefono\":\"809-000-0001\"}")"
comprobar "la reserva se crea" "$(echo "$RES" | jq_ ok)" "true"
comprobar "termina el viernes 5 de febrero" "$(echo "$RES" | jq_ reserva.fecha_fin)" "2027-02-05"
CODIGO="$(echo "$RES" | jq_ reserva.codigo_reserva)"
ok "código emitido: $CODIGO"

comprobar "el mismo centro no puede reservar dos veces" \
  "$(curl -s -X POST "$BASE/api/publico/reservas" -H 'Content-Type: application/json' \
     -d "{\"centro_id\":\"$ID1\",\"fecha_inicio\":\"2027-03-01\",\"correo_contacto\":\"uno@test.do\",\"telefono\":\"809-000-0001\"}" \
     | jq_ codigo_error)" "CENTRO_YA_RESERVO"

comprobar "una fecha fuera de la ventana se rechaza" \
  "$(curl -s -X POST "$BASE/api/publico/reservas" -H 'Content-Type: application/json' \
     -d "{\"centro_id\":\"$ID1\",\"fecha_inicio\":\"2027-09-01\",\"correo_contacto\":\"uno@test.do\",\"telefono\":\"809-000-0001\"}" \
     | jq_ codigo_error)" "FUERA_DE_VENTANA"

comprobar "un correo inválido lo corta zod en el servidor" \
  "$(curl -s -X POST "$BASE/api/publico/reservas" -H 'Content-Type: application/json' \
     -d "{\"centro_id\":\"$ID1\",\"fecha_inicio\":\"2027-03-01\",\"correo_contacto\":\"no-es-correo\",\"telefono\":\"809-000-0001\"}" \
     | jq_ codigo_error)" "ENTRADA_INVALIDA"

echo ""
echo "== Consultar por código =="
comprobar "la consulta encuentra la reserva" \
  "$(curl -s "$BASE/api/publico/reservas/$CODIGO" | jq_ reserva.codigo_reserva)" "$CODIGO"
comprobar "un código inexistente da error claro" \
  "$(curl -s "$BASE/api/publico/reservas/SC-2027-NOEXIS" | jq_ codigo_error)" "RESERVA_NO_EXISTE"

echo ""
echo "== Solicitud de cambio =="
comprobar "la solicitud se registra" \
  "$(curl -s -X POST "$BASE/api/publico/solicitudes" -H 'Content-Type: application/json' \
     -d "{\"codigo_reserva\":\"$CODIGO\",\"tipo\":\"cambio\",\"nueva_fecha_inicio\":\"2027-03-08\",\"motivo\":\"Auditoría interna\"}" \
     | jq_ ok)" "true"
comprobar "la reserva NO se movió con la solicitud pendiente" \
  "$(curl -s "$BASE/api/publico/reservas/$CODIGO" | jq_ reserva.fecha_inicio)" "2027-02-01"

echo ""
echo "== El panel exige sesión =="
comprobar "sin cookie, /api/admin/reservas responde 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/reservas?anio=2027")" "401"
comprobar "sin cookie, /api/admin/centros responde 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/centros")" "401"
comprobar "credenciales incorrectas se rechazan" \
  "$(curl -s -X POST "$BASE/api/admin/sesion" -H 'Content-Type: application/json' \
     -d '{"correo":"contadora@sanchez.do","clave":"incorrecta"}' | jq_ codigo_error)" "CREDENCIALES_INVALIDAS"
comprobar "un correo inexistente da el MISMO mensaje" \
  "$(curl -s -X POST "$BASE/api/admin/sesion" -H 'Content-Type: application/json' \
     -d '{"correo":"nadie@sanchez.do","clave":"loquesea"}' | jq_ mensaje)" \
  "$(curl -s -X POST "$BASE/api/admin/sesion" -H 'Content-Type: application/json' \
     -d '{"correo":"contadora@sanchez.do","clave":"incorrecta"}' | jq_ mensaje)"

echo ""
echo "== Sesión de la contadora =="
LOGIN="$(curl -s -c "$COOKIES" -X POST "$BASE/api/admin/sesion" -H 'Content-Type: application/json' \
  -d '{"correo":"contadora@sanchez.do","clave":"clave-de-prueba-larga"}')"
comprobar "entra con las credenciales correctas" "$(echo "$LOGIN" | jq_ ok)" "true"

if grep -qi httponly "$COOKIES"; then
  ok "la cookie de sesión es HttpOnly"
else
  falla "la cookie de sesión debería ser HttpOnly"
fi

comprobar "ahora /api/admin/reservas responde" \
  "$(curl -s -b "$COOKIES" "$BASE/api/admin/reservas?anio=2027" \
     | node -e "let e='';process.stdin.on('data',d=>e+=d).on('end',()=>console.log(JSON.parse(e).length))")" "1"

echo ""
echo "== Resolver la solicitud =="
SOL="$(curl -s -b "$COOKIES" "$BASE/api/admin/solicitudes" \
  | node -e "let e='';process.stdin.on('data',d=>e+=d).on('end',()=>console.log(JSON.parse(e)[0].id))")"
comprobar "la contadora aprueba el cambio" \
  "$(curl -s -b "$COOKIES" -X POST "$BASE/api/admin/solicitudes/$SOL/resolver" \
     -H 'Content-Type: application/json' -d '{"aprobar":true,"nota":"De acuerdo"}' | jq_ accion)" "aprobada"
comprobar "la reserva se movió a la nueva fecha" \
  "$(curl -s "$BASE/api/publico/reservas/$CODIGO" | jq_ reserva.fecha_inicio)" "2027-03-08"

echo ""
echo "== Bloqueos advierten sin cancelar =="
comprobar "el bloqueo lista la reserva afectada" \
  "$(curl -s -b "$COOKIES" "$BASE/api/admin/bloqueos/afectadas?inicio=2027-03-09&fin=2027-03-09" \
     | node -e "let e='';process.stdin.on('data',d=>e+=d).on('end',()=>console.log(JSON.parse(e).length))")" "1"
curl -s -b "$COOKIES" -X POST "$BASE/api/admin/bloqueos" -H 'Content-Type: application/json' \
  -d '{"fecha_inicio":"2027-03-09","fecha_fin":"2027-03-10","tipo":"personal","descripcion":"Capacitación"}' > /dev/null
comprobar "tras crear el bloqueo, la reserva sigue viva" \
  "$(curl -s "$BASE/api/publico/reservas/$CODIGO" | jq_ reserva.estado)" "reservada"

echo ""
echo "== Estados de seguimiento =="
RID="$(curl -s -b "$COOKIES" "$BASE/api/admin/reservas?anio=2027" \
  | node -e "let e='';process.stdin.on('data',d=>e+=d).on('end',()=>console.log(JSON.parse(e)[0].id))")"
curl -s -b "$COOKIES" -X PATCH "$BASE/api/admin/reservas/$RID" -H 'Content-Type: application/json' \
  -d '{"estado":"en_proceso"}' > /dev/null
comprobar "la reserva pasa a en proceso" \
  "$(curl -s "$BASE/api/publico/reservas/$CODIGO" | jq_ reserva.estado)" "en_proceso"

echo ""
echo "== Cron de recordatorios =="
comprobar "sin el secreto, el cron responde 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/cron/recordatorios")" "401"
comprobar "con un secreto equivocado, también 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/cron/recordatorios" \
     -H 'x-cron-secret: incorrecto')" "401"
CRON="$(curl -s -X POST "$BASE/api/cron/recordatorios" -H 'x-cron-secret: secreto-de-prueba')"
comprobar "con el secreto correcto, el cron corre" "$(echo "$CRON" | jq_ ok)" "true"
# Las reservas de prueba son de 2027 y hoy no estamos a 3 días laborables de
# ninguna, así que no debe enviarse nada.
comprobar "no envía recordatorios fuera de plazo" "$(echo "$CRON" | jq_ enviados)" "0"

echo ""
echo "== Cerrar sesión =="
curl -s -b "$COOKIES" -c "$COOKIES" -X DELETE "$BASE/api/admin/sesion" > /dev/null
comprobar "tras salir, el panel vuelve a dar 401" \
  "$(curl -s -b "$COOKIES" -o /dev/null -w '%{http_code}' "$BASE/api/admin/reservas?anio=2027")" "401"

echo ""
echo "== SPA =="
comprobar "una ruta profunda devuelve el index.html" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/consulta")" "200"
comprobar "una ruta de API inexistente devuelve 404 JSON" \
  "$(curl -s "$BASE/api/no-existe" | jq_ codigo_error)" "NO_EXISTE"

echo ""
if [ "$fallos" -eq 0 ]; then echo "API completa en verde."; else echo "HAY FALLOS."; fi
exit $fallos
