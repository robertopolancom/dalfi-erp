import assert from "node:assert/strict";
import test from "node:test";
import { NeonBookingStore } from "../server/store.mjs";

// confirmAppointmentAttendance() en sí (no la ruta HTTP con bookingStore mockeado, ver
// tests/reservapp-confirmation-reminders.test.js) -- exercita la transacción real contra un pool
// falso para poder simular el error de Postgres 23P01 (violación de la restricción de exclusión
// appointments_no_staff_overlap) que la carrera descrita en el commit puede disparar.
function fakePool({ appointment, conflictRows = [], updateError = null }) {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === "begin" || sql === "commit") return {};
      if (sql === "rollback") return {};
      if (sql.includes("for update")) return { rows: appointment ? [appointment] : [] };
      if (sql.includes("select id from app.appointments")) return { rows: conflictRows, rowCount: conflictRows.length };
      if (sql.includes("confirmation_status='HoraConfirmada'")) {
        if (updateError) throw updateError;
        return { rowCount: 1 };
      }
      throw new Error(`Consulta no simulada: ${sql}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client, query: client.query.bind(client) }, queries };
}

const APT = {
  id: "apt-1", legacy_id: "RES-1", staff_id: "COL-1", client_id: "CLI-1",
  starts_at: "2026-09-01T13:00:00.000Z", ends_at: "2026-09-01T14:00:00.000Z",
  status: "scheduled", confirmation_status: "EspacioLiberado",
};

test("confirmAppointmentAttendance(): camino feliz, sin conflicto, confirma", async () => {
  const { pool } = fakePool({ appointment: APT, conflictRows: [] });
  const store = new NeonBookingStore(pool);
  store.mirrorAppointmentToDocument = async () => {}; // fuera de alcance de esta prueba
  const result = await store.confirmAppointmentAttendance({ legacyId: "RES-1" });
  assert.deepEqual(result, { confirmed: true });
});

// El bug real que motivó esta tarea: confirmar la hora por WhatsApp solo tocaba
// confirmation_status, dejando el estatus visible (status) en "scheduled" -- la cita seguía
// viéndose "Programada" en ambos lados aunque la clienta ya hubiera confirmado.
test("confirmAppointmentAttendance(): partiendo de 'scheduled', también pone status='confirmed' y espeja estado='Confirmada'", async () => {
  const { pool, queries } = fakePool({ appointment: APT, conflictRows: [] });
  const store = new NeonBookingStore(pool);
  const mirrored = [];
  store.mirrorAppointmentToDocument = async (client, legacyId, mutate) => {
    const doc = {};
    mutate(doc);
    mirrored.push({ legacyId, doc });
  };
  const result = await store.confirmAppointmentAttendance({ legacyId: "RES-1" });
  assert.deepEqual(result, { confirmed: true });
  const updateQuery = queries.find((q) => q.sql.includes("confirmation_status='HoraConfirmada'"));
  assert.deepEqual(updateQuery.params, ["apt-1", true]);
  assert.equal(mirrored[0].doc.estadoConfirmacion, "HoraConfirmada");
  assert.equal(mirrored[0].doc.estado, "Confirmada");
});

// Si ya se marcó "Atendida" (completed) antes de que llegara una confirmación tardía del
// cliente por WhatsApp, esa confirmación no debe regresarla a "Confirmada".
test("confirmAppointmentAttendance(): si ya estaba 'completed', NO regresa el estatus a 'confirmed'", async () => {
  const completedApt = { ...APT, status: "completed" };
  const { pool, queries } = fakePool({ appointment: completedApt, conflictRows: [] });
  const store = new NeonBookingStore(pool);
  const mirrored = [];
  store.mirrorAppointmentToDocument = async (client, legacyId, mutate) => {
    const doc = {};
    mutate(doc);
    mirrored.push({ legacyId, doc });
  };
  const result = await store.confirmAppointmentAttendance({ legacyId: "RES-1" });
  assert.deepEqual(result, { confirmed: true });
  const updateQuery = queries.find((q) => q.sql.includes("confirmation_status='HoraConfirmada'"));
  assert.deepEqual(updateQuery.params, ["apt-1", false]);
  assert.equal(mirrored[0].doc.estadoConfirmacion, "HoraConfirmada");
  assert.equal(mirrored[0].doc.estado, undefined);
});

test("confirmAppointmentAttendance(): conflicto detectado por el SELECT previo responde alreadyReassigned", async () => {
  const { pool } = fakePool({ appointment: APT, conflictRows: [{ id: "other-apt" }] });
  const store = new NeonBookingStore(pool);
  const result = await store.confirmAppointmentAttendance({ legacyId: "RES-1" });
  assert.deepEqual(result, { alreadyReassigned: true, status: "Reemplazada" });
});

// El bug real encontrado en auditoría: entre el SELECT de conflicto (no bloquea inserciones
// nuevas de otras sesiones) y este UPDATE, otra reserva pudo tomar exactamente ese horario --
// Postgres rechaza el UPDATE con 23P01 al reintroducir la fila a la restricción de exclusión.
// Sin el catch de este código, ese 23P01 se propagaba como error 500 genérico en vez del 409
// ALREADY_REASSIGNED que el frontend sabe manejar.
test("confirmAppointmentAttendance(): carrera real -- el UPDATE falla con 23P01 y se traduce a alreadyReassigned, no un 500", async () => {
  const raceError = Object.assign(new Error("exclusion violation"), { code: "23P01" });
  const { pool } = fakePool({ appointment: APT, conflictRows: [], updateError: raceError });
  const store = new NeonBookingStore(pool);
  const result = await store.confirmAppointmentAttendance({ legacyId: "RES-1" });
  assert.deepEqual(result, { alreadyReassigned: true, status: "Reemplazada" });
});

test("confirmAppointmentAttendance(): un error de Postgres distinto de 23P01 sigue propagándose (no se traga errores reales)", async () => {
  const dbError = Object.assign(new Error("connection lost"), { code: "08006" });
  const { pool } = fakePool({ appointment: APT, conflictRows: [], updateError: dbError });
  const store = new NeonBookingStore(pool);
  await assert.rejects(() => store.confirmAppointmentAttendance({ legacyId: "RES-1" }), /connection lost/);
});

test("confirmAppointmentAttendance(): reserva inexistente responde missing", async () => {
  const { pool } = fakePool({ appointment: null });
  const store = new NeonBookingStore(pool);
  const result = await store.confirmAppointmentAttendance({ legacyId: "RES-NOPE" });
  assert.deepEqual(result, { missing: true });
});

test("confirmAppointmentAttendance(): clientId de un cliente distinta nunca ve/confirma la cita ajena", async () => {
  const { pool } = fakePool({ appointment: APT });
  const store = new NeonBookingStore(pool);
  const result = await store.confirmAppointmentAttendance({ legacyId: "RES-1", clientId: "CLI-OTHER" });
  assert.deepEqual(result, { missing: true });
});
