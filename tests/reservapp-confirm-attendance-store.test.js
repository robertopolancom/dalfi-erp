import assert from "node:assert/strict";
import test from "node:test";
import { NeonBookingStore } from "../server/store.mjs";

// confirmAppointmentAttendance() en sí (no la ruta HTTP con bookingStore mockeado, ver
// tests/reservapp-confirmation-reminders.test.js) -- exercita la transacción real contra un pool
// falso. Esta función confirma ASISTENCIA (confirmation_status), nunca aparta el horario
// (status) -- apartar el horario es exclusivo de reviewDepositReceipt (depósito aprobado) y
// setAppointmentStatus (autorización manual de administración). Antes esta función también
// ponía status='confirmed' cuando la clienta respondía por WhatsApp que iba a asistir; eso se
// quitó porque una clienta confirmando su propia asistencia no es ni un depósito aprobado ni una
// autorización de administración.
function fakePool({ appointment, updateError = null }) {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === "begin" || sql === "commit") return {};
      if (sql === "rollback") return {};
      if (sql.includes("for update")) return { rows: appointment ? [appointment] : [] };
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

const APT = { id: "apt-1", legacy_id: "RES-1", client_id: "CLI-1", status: "scheduled" };

test("confirmAppointmentAttendance(): camino feliz, solo confirma asistencia (nunca toca status)", async () => {
  const { pool, queries } = fakePool({ appointment: APT });
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
  assert.deepEqual(updateQuery.params, ["apt-1"]);
  assert.equal(mirrored[0].doc.estadoConfirmacion, "HoraConfirmada");
  assert.equal(mirrored[0].doc.estado, undefined); // nunca toca "estado" -- eso lo maneja el depósito/administración
});

test("confirmAppointmentAttendance(): funciona igual sin importar el status actual de la cita (scheduled, confirmed o completed)", async () => {
  for (const status of ["scheduled", "confirmed", "completed"]) {
    const { pool, queries } = fakePool({ appointment: { ...APT, status } });
    const store = new NeonBookingStore(pool);
    store.mirrorAppointmentToDocument = async () => {};
    const result = await store.confirmAppointmentAttendance({ legacyId: "RES-1" });
    assert.deepEqual(result, { confirmed: true });
    const updateQuery = queries.find((q) => q.sql.includes("confirmation_status='HoraConfirmada'"));
    assert.deepEqual(updateQuery.params, ["apt-1"]);
  }
});

test("confirmAppointmentAttendance(): cita cancelada o reasignada responde alreadyReassigned sin intentar el update", async () => {
  for (const status of ["cancelled", "replaced"]) {
    const { pool, queries } = fakePool({ appointment: { ...APT, status } });
    const store = new NeonBookingStore(pool);
    const result = await store.confirmAppointmentAttendance({ legacyId: "RES-1" });
    assert.deepEqual(result, { alreadyReassigned: true, status });
    assert.equal(queries.some((q) => q.sql.includes("confirmation_status='HoraConfirmada'")), false);
  }
});

test("confirmAppointmentAttendance(): un error de Postgres en el update sigue propagándose (no se traga errores reales)", async () => {
  const dbError = Object.assign(new Error("connection lost"), { code: "08006" });
  const { pool } = fakePool({ appointment: APT, updateError: dbError });
  const store = new NeonBookingStore(pool);
  await assert.rejects(() => store.confirmAppointmentAttendance({ legacyId: "RES-1" }), /connection lost/);
});

test("confirmAppointmentAttendance(): reserva inexistente responde missing", async () => {
  const { pool } = fakePool({ appointment: null });
  const store = new NeonBookingStore(pool);
  const result = await store.confirmAppointmentAttendance({ legacyId: "RES-NOPE" });
  assert.deepEqual(result, { missing: true });
});

test("confirmAppointmentAttendance(): clientId de una clienta distinta nunca ve/confirma la cita ajena", async () => {
  const { pool } = fakePool({ appointment: APT });
  const store = new NeonBookingStore(pool);
  const result = await store.confirmAppointmentAttendance({ legacyId: "RES-1", clientId: "CLI-OTHER" });
  assert.deepEqual(result, { missing: true });
});
