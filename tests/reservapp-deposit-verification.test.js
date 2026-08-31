import assert from "node:assert/strict";
import test from "node:test";
import { NeonBookingStore } from "../server/store.mjs";

// Comprobante de depósito (RD$500, ya exigido desde la creación de la cita -- ver
// deposit_status/deposit_amount en el insert de fast-booking en server/store.mjs). Lo que faltaba
// era la escritura: submitDepositReceipt() (la clienta sube la foto) y reviewDepositReceipt() (el
// personal la aprueba/rechaza), ambos espejando estadoDeposito en app.erp_document igual que ya
// hacen setAppointmentStatus/cancelAppointment con estado.

function fakePool({ appointment, receiptRow, updatedAppointment } = {}) {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === "begin" || sql === "commit" || sql === "rollback") return {};
      if (sql.includes("select id, client_id, legacy_id, deposit_status from app.appointments")) {
        return { rows: appointment ? [appointment] : [] };
      }
      if (sql.includes("insert into app.appointment_deposit_receipts")) return { rows: [] };
      if (sql.includes("select appointment_id from app.appointment_deposit_receipts")) {
        return { rows: receiptRow ? [receiptRow] : [] };
      }
      if (sql.includes("update app.appointment_deposit_receipts")) return { rows: [] };
      if (sql.includes("update app.appointments set deposit_status")) {
        return { rows: updatedAppointment ? [updatedAppointment] : [] };
      }
      throw new Error(`Consulta no simulada: ${sql}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client, query: client.query.bind(client) }, queries };
}

test("submitDepositReceipt(): camino feliz, sube el comprobante y pasa a ComprobanteRecibido", async () => {
  const appointment = { id: "apt-1", client_id: "cli-1", legacy_id: "RES-1", deposit_status: "Pendiente" };
  const updatedAppointment = { id: "apt-1", deposit_status: "ComprobanteRecibido", legacy_id: "RES-1" };
  const { pool, queries } = fakePool({ appointment, updatedAppointment });
  const store = new NeonBookingStore(pool);
  const mirrored = [];
  store.mirrorAppointmentToDocument = async (client, legacyId, mutate) => {
    const doc = {};
    mutate(doc);
    mirrored.push({ legacyId, doc });
  };
  const result = await store.submitDepositReceipt({ appointmentId: "apt-1", clientId: "cli-1", imageBase64: "AAAA", mimeType: "image/jpeg" });
  assert.deepEqual(result, updatedAppointment);
  const insertQuery = queries.find((q) => q.sql.includes("insert into app.appointment_deposit_receipts"));
  assert.deepEqual(insertQuery.params, ["apt-1", "AAAA", "image/jpeg"]);
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0].legacyId, "RES-1");
  assert.equal(mirrored[0].doc.estadoDeposito, "ComprobanteRecibido");
});

test("submitDepositReceipt(): rechaza si la cita no le pertenece a esa clienta", async () => {
  const appointment = { id: "apt-1", client_id: "cli-OTRA", legacy_id: "RES-1", deposit_status: "Pendiente" };
  const { pool } = fakePool({ appointment });
  const store = new NeonBookingStore(pool);
  await assert.rejects(
    () => store.submitDepositReceipt({ appointmentId: "apt-1", clientId: "cli-1", imageBase64: "AAAA", mimeType: "image/jpeg" }),
    /no existe o no te pertenece/,
  );
});

test("submitDepositReceipt(): rechaza si el depósito ya está en revisión o confirmado", async () => {
  const appointment = { id: "apt-1", client_id: "cli-1", legacy_id: "RES-1", deposit_status: "ComprobanteRecibido" };
  const { pool } = fakePool({ appointment });
  const store = new NeonBookingStore(pool);
  await assert.rejects(
    () => store.submitDepositReceipt({ appointmentId: "apt-1", clientId: "cli-1", imageBase64: "AAAA", mimeType: "image/jpeg" }),
    /ya está en revisión o ya fue confirmado/,
  );
});

test("submitDepositReceipt(): tras un Rechazado, sí se puede volver a subir", async () => {
  const appointment = { id: "apt-1", client_id: "cli-1", legacy_id: "RES-1", deposit_status: "Rechazado" };
  const updatedAppointment = { id: "apt-1", deposit_status: "ComprobanteRecibido", legacy_id: "RES-1" };
  const { pool } = fakePool({ appointment, updatedAppointment });
  const store = new NeonBookingStore(pool);
  store.mirrorAppointmentToDocument = async () => {};
  const result = await store.submitDepositReceipt({ appointmentId: "apt-1", clientId: "cli-1", imageBase64: "BBBB", mimeType: "image/png" });
  assert.equal(result.deposit_status, "ComprobanteRecibido");
});

test("reviewDepositReceipt(): aprobar pasa a Verificado y espeja el documento del ERP", async () => {
  const receiptRow = { appointment_id: "apt-1" };
  const updatedAppointment = { id: "apt-1", deposit_status: "Verificado", legacy_id: "RES-1" };
  const { pool, queries } = fakePool({ receiptRow, updatedAppointment });
  const store = new NeonBookingStore(pool);
  const mirrored = [];
  store.mirrorAppointmentToDocument = async (client, legacyId, mutate) => {
    const doc = {};
    mutate(doc);
    mirrored.push({ legacyId, doc });
  };
  const result = await store.reviewDepositReceipt({ appointmentId: "apt-1", approve: true, reviewedBy: "administradora:acc-1" });
  assert.deepEqual(result, updatedAppointment);
  const statusUpdate = queries.find((q) => q.sql.includes("update app.appointments set deposit_status"));
  assert.deepEqual(statusUpdate.params, ["apt-1", "Verificado"]);
  const receiptUpdate = queries.find((q) => q.sql.includes("update app.appointment_deposit_receipts"));
  assert.deepEqual(receiptUpdate.params, ["apt-1", "administradora:acc-1", null]);
  assert.equal(mirrored[0].doc.estadoDeposito, "Verificado");
});

test("reviewDepositReceipt(): rechazar pasa a Rechazado y guarda la nota", async () => {
  const receiptRow = { appointment_id: "apt-1" };
  const updatedAppointment = { id: "apt-1", deposit_status: "Rechazado", legacy_id: "RES-1" };
  const { pool, queries } = fakePool({ receiptRow, updatedAppointment });
  const store = new NeonBookingStore(pool);
  store.mirrorAppointmentToDocument = async () => {};
  const result = await store.reviewDepositReceipt({ appointmentId: "apt-1", approve: false, reviewedBy: "administradora:acc-1", note: "Monto incompleto" });
  assert.equal(result.deposit_status, "Rechazado");
  const receiptUpdate = queries.find((q) => q.sql.includes("update app.appointment_deposit_receipts"));
  assert.deepEqual(receiptUpdate.params, ["apt-1", "administradora:acc-1", "Monto incompleto"]);
});

test("reviewDepositReceipt(): sin comprobante subido todavía, error claro", async () => {
  const { pool } = fakePool({ receiptRow: null });
  const store = new NeonBookingStore(pool);
  await assert.rejects(
    () => store.reviewDepositReceipt({ appointmentId: "apt-1", approve: true, reviewedBy: "administradora:acc-1" }),
    /Todavía no hay un comprobante subido/,
  );
});

test("getDepositReceipt(): trae la fila del comprobante para que el personal la vea", async () => {
  const row = { appointment_id: "apt-1", image_data: "AAAA", mime_type: "image/jpeg", uploaded_at: "2026-09-01T00:00:00.000Z", reviewed_by: null, reviewed_at: null, review_note: null };
  const pool = { query: async (sql, params) => { assert.deepEqual(params, ["apt-1"]); return { rows: [row] }; } };
  const store = new NeonBookingStore(pool);
  const result = await store.getDepositReceipt({ appointmentId: "apt-1" });
  assert.deepEqual(result, row);
});

test("getDepositReceipt(): sin fila, devuelve null", async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const store = new NeonBookingStore(pool);
  const result = await store.getDepositReceipt({ appointmentId: "apt-inexistente" });
  assert.equal(result, null);
});

// purgeExpiredDepositReceipts(): borra SOLO la foto (image_data/mime_type) de citas Atendidas o
// Canceladas hace 5+ dias -- nunca la fila (reviewed_by/reviewed_at/review_note sobreviven como
// auditoria) ni la cita. Ver workers/deposit-receipt-purge-cron/.
test("purgeExpiredDepositReceipts(): un solo UPDATE, filtra por status Atendida/Cancelada + 5 dias + solo filas con foto todavia", async () => {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rowCount: 3, rows: [{ appointment_id: "apt-1" }, { appointment_id: "apt-2" }, { appointment_id: "apt-3" }] };
    },
  };
  const store = new NeonBookingStore(pool);
  const result = await store.purgeExpiredDepositReceipts();
  assert.deepEqual(result, { purgedCount: 3 });
  assert.equal(queries.length, 1);
  const sql = queries[0].sql;
  assert.match(sql, /set image_data = null, mime_type = null/);
  assert.match(sql, /status in \('completed','cancelled'\)/);
  assert.match(sql, /updated_at <= now\(\) - interval '5 days'/);
  assert.match(sql, /r\.image_data is not null/);
});

test("purgeExpiredDepositReceipts(): nada que purgar, devuelve purgedCount 0", async () => {
  const pool = { query: async () => ({ rowCount: 0, rows: [] }) };
  const store = new NeonBookingStore(pool);
  const result = await store.purgeExpiredDepositReceipts();
  assert.deepEqual(result, { purgedCount: 0 });
});
