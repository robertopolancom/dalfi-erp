import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../outputs/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../outputs/index.html", import.meta.url), "utf8");

test("la agenda ofrece acciones separadas para ver, editar y facturar una reserva", () => {
  assert.match(app, /class="secondary-btn compact view-reservation"/);
  assert.match(app, /class="secondary-btn compact edit-reservation"/);
  assert.match(app, /class="secondary-btn compact invoice-reservation"/);
});

test("Ver reserva abre un dialogo de detalle sin modificar la reserva", () => {
  assert.match(html, /<dialog id="reservation-details-dialog"/);
  assert.match(app, /function showReservationDetails\(reservationId\)/);
  assert.match(app, /showReservationDetails\(viewButton\.dataset\.reservationId\)/);
  assert.doesNotMatch(app.match(/function showReservationDetails[\s\S]*?\n}\n/)?.[0] || "", /saveState|scheduleRemoteSave|fetch\(/);
});

test("el recurso principal usa un cache-buster de la capa segura y la SPA guarda por API", () => {
  assert.match(html, /app\.js\?v=20260724-permission-presets/);
  assert.doesNotMatch(html, /app\.js\?v=20260722-inventario-almacenes/);
  assert.match(app, /fetch\("\/api\/database"/);
});
