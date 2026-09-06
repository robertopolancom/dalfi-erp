import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NeonBookingStore } from "../server/store.mjs";

const appMjs = readFileSync(new URL("../server/app.mjs", import.meta.url), "utf8");

function fakePool(rows = []) {
  const queries = [];
  return {
    queries,
    pool: { query: async (sql, params) => { queries.push({ sql, params }); return { rows }; } },
  };
}

test("un uuid se acepta tal cual, sin consultar la base", async () => {
  const { pool, queries } = fakePool();
  const store = new NeonBookingStore(pool);
  const uuid = "944faf8c-976b-449b-bc0c-4ff41d742151";
  assert.equal(await store.resolveAppointmentId(uuid), uuid);
  assert.equal(queries.length, 0, "no hace falta ir a la base para algo que ya es el id");
});

test("un reservaID del ERP se resuelve por legacy_id", async () => {
  const { pool, queries } = fakePool([{ id: "944faf8c-976b-449b-bc0c-4ff41d742151" }]);
  const store = new NeonBookingStore(pool);
  const id = await store.resolveAppointmentId("RES-1788734398267-3a455de0");
  assert.equal(id, "944faf8c-976b-449b-bc0c-4ff41d742151");
  assert.match(queries[0].sql, /where legacy_id=\$1/);
  assert.deepEqual(queries[0].params, ["RES-1788734398267-3a455de0"]);
});

test("una referencia que no existe devuelve null, no revienta", async () => {
  const { pool } = fakePool([]);
  const store = new NeonBookingStore(pool);
  assert.equal(await store.resolveAppointmentId("RES-NO-EXISTE"), null);
  assert.equal(await store.resolveAppointmentId(""), null);
  assert.equal(await store.resolveAppointmentId(null), null);
});

test("/cancel y /status resuelven la referencia antes de tocar la cita", () => {
  for (const name of ["cancel", "status"]) {
    const start = appMjs.indexOf(`app.post("/api/reservapp/agenda/appointments/:id/${name}"`);
    const body = appMjs.slice(start, start + 1400);
    const resolve = body.indexOf("resolveAppointmentId");
    const uso = body.search(name === "cancel" ? /cancelAppointment\(/ : /setAppointmentStatus\(/);
    assert.ok(resolve !== -1 && resolve < uso, `/${name} debe resolver la referencia primero`);
    assert.ok(!/\{ id: req\.params\.id/.test(body),
      `/${name} no puede usar el parámetro crudo: puede ser un reservaID, no un uuid`);
  }
});

test("el correo de cancelación se arma con el id ya resuelto", () => {
  const start = appMjs.indexOf('app.post("/api/reservapp/agenda/appointments/:id/cancel"');
  const body = appMjs.slice(start, start + 1800);
  assert.match(body, /appointmentSummary\(appointmentId\)/,
    "con un reservaID, appointmentSummary(req.params.id) no encontraría nada");
});
