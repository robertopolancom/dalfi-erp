import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const appMjs = readFileSync(new URL("../server/app.mjs", import.meta.url), "utf8");
const erpJs = readFileSync(new URL("../outputs/app.js", import.meta.url), "utf8");

// syncReservationToPostgres() en el ERP llama a /cancel y a /status desde la MISMA función, con
// las MISMAS cabeceras (bookingAuthHeaders: un Bearer de Supabase, nunca la cookie de ReservApp).
// Mientras /cancel pidió requireReservapp, cancelar desde el ERP devolvía 401, y la respuesta se
// perdía en un `console.warn`: la cita quedaba "Cancelada" en el documento del ERP y seguía viva
// en Postgres, apartando el horario para siempre.
function routeBody(name) {
  const start = appMjs.indexOf(`app.post("/api/reservapp/agenda/appointments/:id/${name}"`);
  assert.ok(start !== -1, `no se encontró la ruta /${name}`);
  return appMjs.slice(start, start + 700);
}

test("/cancel y /status exigen exactamente la misma autoridad", () => {
  for (const name of ["cancel", "status"]) {
    const body = routeBody(name);
    assert.match(body, /requireBookingStaff\(req, res\)/, `/${name} debe aceptar la identidad del ERP`);
    assert.ok(!body.includes("requireReservapp"),
      `/${name} volvió a exigir cookie de ReservApp: el ERP no la manda y dejaría de sincronizar`);
  }
});

test("el ERP sigue mandando las mismas cabeceras a las dos rutas", () => {
  // Si algún día el ERP dejara de compartir bookingAuthHeaders() entre ambas, la prueba de arriba
  // dejaría de significar lo que dice.
  const sync = erpJs.slice(erpJs.indexOf("const isCancel = dbRow.estado"), erpJs.indexOf("function loadState"));
  assert.match(sync, /\/cancel/);
  assert.match(sync, /\/status/);
  assert.match(sync, /headers: bookingAuthHeaders\(\)/);
});
