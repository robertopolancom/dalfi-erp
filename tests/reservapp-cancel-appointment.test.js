import assert from "node:assert/strict";
import test from "node:test";
import { NeonBookingStore } from "../server/store.mjs";

// cancelAppointment() -- nuevo (antes solo se podía cancelar desde el ERP legado). Un solo
// UPDATE con `where status not in ('cancelled','replaced')`: idempotente a propósito, así que
// un doble clic o dos personas del equipo cancelando la misma cita casi a la vez nunca revierte
// nada ni pisa el motivo ya guardado -- la segunda llamada simplemente no afecta filas.
function fakePool({ rows = [] } = {}) {
  const queries = [];
  return {
    pool: {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows };
      },
    },
    queries,
  };
}

test("cancelAppointment(): camino feliz, devuelve id y status", async () => {
  const { pool, queries } = fakePool({ rows: [{ id: "apt-1", status: "cancelled" }] });
  const store = new NeonBookingStore(pool);
  const result = await store.cancelAppointment({ id: "apt-1", reason: "Cliente pidió cancelar" });
  assert.deepEqual(result, { id: "apt-1", status: "cancelled" });
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /update app\.appointments/);
  assert.match(queries[0].sql, /status not in \('cancelled','replaced'\)/);
  assert.deepEqual(queries[0].params, ["apt-1", "Cliente pidió cancelar"]);
});

test("cancelAppointment(): sin motivo, pasa null y no rompe", async () => {
  const { pool, queries } = fakePool({ rows: [{ id: "apt-2", status: "cancelled" }] });
  const store = new NeonBookingStore(pool);
  const result = await store.cancelAppointment({ id: "apt-2" });
  assert.deepEqual(result, { id: "apt-2", status: "cancelled" });
  assert.deepEqual(queries[0].params, ["apt-2", null]);
});

test("cancelAppointment(): ya estaba cancelada (o no existe) -- el UPDATE no afecta filas, devuelve null", async () => {
  const { pool } = fakePool({ rows: [] });
  const store = new NeonBookingStore(pool);
  const result = await store.cancelAppointment({ id: "apt-ya-cancelada", reason: "" });
  assert.equal(result, null);
});
