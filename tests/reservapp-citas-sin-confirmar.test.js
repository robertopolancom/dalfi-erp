import assert from "node:assert/strict";
import test from "node:test";
import { NeonBookingStore } from "../server/store.mjs";

// Dos reglas del negocio (Roberto, 2026-09-14) sobre las citas que nunca se confirmaron:
//   1. Si pasó la fecha y nadie la confirmó, queda como "No asistió" -- nunca fue una cita real,
//      porque sin confirmar no apartaba el horario.
//   2. Si el cliente vino igual y se le atendió, "Atendida" vale como confirmada: gana el horario
//      y desplaza a las que seguían compitiendo por él.

function fakePool({ expiradas = [], appointment } = {}) {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (["begin", "commit", "rollback"].includes(sql)) return {};
      if (sql.includes("set status='no_show'")) return { rows: expiradas };
      if (sql.includes("select document from app.erp_document")) return { rows: [{ document: { data: { reservas: [] } } }] };
      if (sql.includes("update app.appointments\n            set status = $2")) return { rows: appointment ? [appointment] : [] };
      if (sql.includes("update app.appointments")) return { rows: appointment ? [appointment] : [] };
      if (sql.includes("select id, legacy_id, starts_at, ends_at from app.appointments")) return { rows: [] };
      if (sql.includes("from app.business_settings")) return { rows: [{ timezone: "America/Santo_Domingo", settings: {} }] };
      throw new Error(`Consulta no simulada: ${sql}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client, query: client.query.bind(client) }, queries };
}

test("el barrido solo toca citas 'scheduled' ya pasadas, nunca las confirmadas", async () => {
  const { pool, queries } = fakePool({ expiradas: [{ id: "a1", legacy_id: null }, { id: "a2", legacy_id: null }] });
  const store = new NeonBookingStore(pool);

  const r = await store.expireUnconfirmedPastAppointments({ graceMinutes: 120 });

  assert.equal(r.expiredCount, 2);
  const update = queries.find((q) => q.sql.includes("set status='no_show'"));
  assert.match(update.sql, /where status='scheduled'/, "una cita confirmada la cierra una persona, no un cron");
  assert.match(update.sql, /ends_at </, "se compara con el FIN: una cita larga que empezó hace poco no ha pasado");
  assert.deepEqual(update.params, ["120"]);
});

test("el barrido corre en una transacción: el espejo al documento no se puede pisar", async () => {
  const { pool, queries } = fakePool({ expiradas: [{ id: "a1", legacy_id: "RES-1" }] });
  const store = new NeonBookingStore(pool);
  store.mirrorAppointmentToDocument = async () => {};

  await store.expireUnconfirmedPastAppointments();

  assert.equal(queries[0].sql, "begin");
  assert.equal(queries.at(-1).sql, "commit");
});

test("un margen negativo o absurdo no se cuela en la consulta", async () => {
  const { pool, queries } = fakePool({ expiradas: [] });
  const store = new NeonBookingStore(pool);
  for (const [entrada, esperado] of [[-30, "0"], ["hola", "0"], [undefined, "0"]]) {
    await store.expireUnconfirmedPastAppointments({ graceMinutes: entrada });
    assert.equal(queries.at(-2).params[0], esperado, `margen ${entrada}`);
  }
});

test("marcar 'Atendida' desplaza a las que competían, igual que confirmar", async () => {
  const { pool } = fakePool({ appointment: { id: "apt-1", status: "completed", legacy_id: null, staff_id: "staff-1", starts_at: "2026-09-16T18:00:00.000Z", ends_at: "2026-09-16T19:00:00.000Z" } });
  const store = new NeonBookingStore(pool);
  let desplazo = false;
  store.resolveDisplacedAppointments = async () => { desplazo = true; return { moved: [], stranded: [] }; };

  await store.setAppointmentStatus({ id: "apt-1", status: "completed" });

  assert.equal(desplazo, true, "si el cliente vino y se le atendió, esa cita se quedó el horario");
});

test("marcar 'No asistió' NO desplaza a nadie: esa cita nunca tuvo el horario", async () => {
  const { pool } = fakePool({ appointment: { id: "apt-1", status: "no_show", legacy_id: null, staff_id: "staff-1", starts_at: "2026-09-16T18:00:00.000Z", ends_at: "2026-09-16T19:00:00.000Z" } });
  const store = new NeonBookingStore(pool);
  let desplazo = false;
  store.resolveDisplacedAppointments = async () => { desplazo = true; return { moved: [], stranded: [] }; };

  await store.setAppointmentStatus({ id: "apt-1", status: "no_show" });

  assert.equal(desplazo, false);
});
