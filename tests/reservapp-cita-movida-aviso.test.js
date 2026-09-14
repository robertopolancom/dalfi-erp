import assert from "node:assert/strict";
import test from "node:test";
import { NeonBookingStore } from "../server/store.mjs";

// Quien pierde la carrera por un horario (otra cita confirmó primero) se entera, hasta ahora,
// solo si abre ReservApp por su cuenta. resolveDisplacedAppointments es el punto donde el sistema
// sabe lo que pasó, así que es el punto donde tiene que dejar lo necesario para avisar:
//   - a quien SÍ cupo en otro hueco del día, con la hora vieja y la nueva ya en hora local, que es
//     lo que lleva el mensaje de WhatsApp (ver sendMovedAppointmentWhatsApp en server/app.mjs);
//   - a quien NO cupo en ninguno, que antes se descartaba con un `continue` mudo y quedaba en
//     conflicto sin que nadie se enterara hasta chocar al intentar confirmarla.

function fakeClient({ losers = [] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("select id, legacy_id, starts_at, ends_at from app.appointments")) {
        return { rows: losers };
      }
      if (sql.includes("from app.business_settings")) {
        return { rows: [{ timezone: "America/Santo_Domingo", settings: {} }] };
      }
      if (sql.includes("update app.appointments")) return { rows: [] };
      throw new Error(`Consulta no simulada: ${sql}`);
    },
  };
}

// 14:30 hora local (UTC-4) del 16 de septiembre de 2026.
const PERDEDORA = {
  id: "apt-perdedora",
  legacy_id: "RES-9",
  starts_at: "2026-09-16T18:30:00.000Z",
  ends_at: "2026-09-16T19:30:00.000Z",
};

test("si no hay ningún hueco libre ese día, la cita sale en stranded en vez de desaparecer", async () => {
  const client = fakeClient({ losers: [PERDEDORA] });
  const store = new NeonBookingStore({});
  store.findNearestFreeSlotSameDay = async () => null;

  const { moved, stranded } = await store.resolveDisplacedAppointments(client, {
    winnerId: "apt-ganadora", staffId: "staff-1",
    startsAt: PERDEDORA.starts_at, endsAt: PERDEDORA.ends_at,
  });

  assert.equal(moved.length, 0);
  assert.equal(stranded.length, 1, "la cita que no cupo no puede perderse en silencio");
  assert.equal(stranded[0].legacyId, "RES-9");
  assert.equal(stranded[0].at.startsAt, "2026-09-16T18:30:00.000Z", "sigue a su hora original");
  assert.ok(
    !client.queries.some((q) => q.sql.includes("update app.appointments")),
    "no se toca la cita: se queda donde estaba para que una persona la reprograme",
  );
});

test("la cita movida lleva la hora vieja y la nueva en hora local, que es lo que dice el aviso", async () => {
  const client = fakeClient({ losers: [PERDEDORA] });
  const store = new NeonBookingStore({});
  store.mirrorAppointmentToDocument = async () => {};
  // 16:00 hora local del mismo día.
  store.findNearestFreeSlotSameDay = async () => ({
    start: new Date("2026-09-16T20:00:00.000Z"),
    end: new Date("2026-09-16T21:00:00.000Z"),
  });

  const { moved, stranded } = await store.resolveDisplacedAppointments(client, {
    winnerId: "apt-ganadora", staffId: "staff-1",
    startsAt: PERDEDORA.starts_at, endsAt: PERDEDORA.ends_at,
  });

  assert.equal(stranded.length, 0);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].date, "2026-09-16");
  assert.equal(moved[0].from.time, "14:30", "la hora que el cliente tenía apuntada");
  assert.equal(moved[0].to.time, "16:00", "la hora a la que se le movió");
});

test("sin legacy_id el aviso sigue teniendo las horas (antes solo se calculaban para el ERP legado)", async () => {
  const client = fakeClient({ losers: [{ ...PERDEDORA, legacy_id: null }] });
  const store = new NeonBookingStore({});
  store.mirrorAppointmentToDocument = async () => {
    throw new Error("no debe espejarse una cita sin legacy_id");
  };
  store.findNearestFreeSlotSameDay = async () => ({
    start: new Date("2026-09-16T20:00:00.000Z"),
    end: new Date("2026-09-16T21:00:00.000Z"),
  });

  const { moved } = await store.resolveDisplacedAppointments(client, {
    winnerId: "apt-ganadora", staffId: "staff-1",
    startsAt: PERDEDORA.starts_at, endsAt: PERDEDORA.ends_at,
  });

  assert.equal(moved[0].from.time, "14:30");
  assert.equal(moved[0].to.time, "16:00");
});

test("sin nadie compitiendo por el horario, devuelve las dos listas vacías (no un arreglo suelto)", async () => {
  const client = fakeClient({ losers: [] });
  const store = new NeonBookingStore({});

  const resultado = await store.resolveDisplacedAppointments(client, {
    winnerId: "apt-ganadora", staffId: "staff-1",
    startsAt: PERDEDORA.starts_at, endsAt: PERDEDORA.ends_at,
  });

  assert.deepEqual(resultado, { moved: [], stranded: [] });
});
