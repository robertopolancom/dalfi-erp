import assert from "node:assert/strict";
import test from "node:test";
import { NeonBookingStore } from "../server/store.mjs";

// cancelAppointment() -- nuevo (antes solo se podía cancelar desde el ERP legado). Un solo
// UPDATE con `where status not in ('cancelled','replaced')`: idempotente a propósito, así que
// un doble clic o dos personas del equipo cancelando la misma cita casi a la vez nunca revierte
// nada ni pisa el motivo ya guardado -- la segunda llamada simplemente no afecta filas.
//
// Ahora corre dentro de una transacción (begin/update/mirror/commit) para poder espejar
// estado="Cancelada" en el documento del ERP en el mismo paso -- sin esto, cancelar una cita
// desde ReservApp la seguía dejando "Programada" en la matriz del ERP.
function fakePool({ rows = [] } = {}) {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === "begin" || sql === "commit" || sql === "rollback") return {};
      return { rows };
    },
    release() {},
  };
  return { pool: { connect: async () => client, query: client.query.bind(client) }, queries, client };
}

test("cancelAppointment(): camino feliz, devuelve id y status", async () => {
  const { pool, queries } = fakePool({ rows: [{ id: "apt-1", status: "cancelled" }] });
  const store = new NeonBookingStore(pool);
  store.mirrorAppointmentToDocument = async () => { throw new Error("no debería llamarse sin legacy_id"); };
  const result = await store.cancelAppointment({ id: "apt-1", reason: "Cliente pidió cancelar" });
  assert.deepEqual(result, { id: "apt-1", status: "cancelled" });
  const updateQuery = queries.find((q) => q.sql.includes("update app.appointments"));
  assert.match(updateQuery.sql, /status not in \('cancelled','replaced'\)/);
  assert.deepEqual(updateQuery.params, ["apt-1", "Cliente pidió cancelar"]);
  assert.equal(queries.length, 3);
  assert.equal(queries[0].sql, "begin");
  assert.equal(queries[2].sql, "commit");
});

test("cancelAppointment(): sin motivo, pasa null y no rompe", async () => {
  const { pool, queries } = fakePool({ rows: [{ id: "apt-2", status: "cancelled" }] });
  const store = new NeonBookingStore(pool);
  store.mirrorAppointmentToDocument = async () => { throw new Error("no debería llamarse sin legacy_id"); };
  const result = await store.cancelAppointment({ id: "apt-2" });
  assert.deepEqual(result, { id: "apt-2", status: "cancelled" });
  const updateQuery = queries.find((q) => q.sql.includes("update app.appointments"));
  assert.deepEqual(updateQuery.params, ["apt-2", null]);
});

test("cancelAppointment(): ya estaba cancelada (o no existe) -- el UPDATE no afecta filas, devuelve null", async () => {
  const { pool } = fakePool({ rows: [] });
  const store = new NeonBookingStore(pool);
  const result = await store.cancelAppointment({ id: "apt-ya-cancelada", reason: "" });
  assert.equal(result, null);
});

// Nuevo comportamiento: cuando el UPDATE sí devuelve legacy_id, se espeja estado="Cancelada" en
// el documento del ERP -- así una cita cancelada desde ReservApp deja de verse "Programada" ahí.
test("cancelAppointment(): con legacy_id, espeja estado='Cancelada' en el documento del ERP", async () => {
  const { pool } = fakePool({ rows: [{ id: "apt-3", status: "cancelled", legacy_id: "RES-3" }] });
  const store = new NeonBookingStore(pool);
  const mirrored = [];
  store.mirrorAppointmentToDocument = async (client, legacyId, mutate) => {
    const doc = {};
    mutate(doc);
    mirrored.push({ legacyId, doc });
  };
  const result = await store.cancelAppointment({ id: "apt-3", reason: "No puede asistir" });
  assert.deepEqual(result, { id: "apt-3", status: "cancelled", legacy_id: "RES-3" });
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0].legacyId, "RES-3");
  assert.equal(mirrored[0].doc.estado, "Cancelada");
});
