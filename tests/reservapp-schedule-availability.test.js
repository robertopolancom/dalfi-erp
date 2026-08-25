import assert from "node:assert/strict";
import test from "node:test";
import { NeonBookingStore } from "../server/store.mjs";

// Simula pool.query() por reconocimiento de texto de la consulta -- suficiente para exercitar
// availability() de punta a punta sin una base real. Cada prueba pasa sus propias filas para
// business_settings/staff/staff_weekly_schedules/staff_schedule_exceptions.
function fakePool({ staff = [], businessSettings = {}, weeklySchedules = [], exceptions = [], appointments = [], staffServices = [] } = {}) {
  return {
    async query(sql, params = []) {
      if (sql.includes("from app.services")) return { rows: [{ id: "SRV-1", name: "Manicura", category: "Uñas", base_price: 800, duration_minutes: 60 }] };
      if (sql.includes("from app.staff where status")) return { rows: staff };
      if (sql.includes("from app.business_settings")) return { rows: [{ timezone: "America/Santo_Domingo", settings: businessSettings }] };
      if (sql.includes("from app.staff_services")) return { rows: staffServices };
      if (sql.includes("select staff_id, start_time, end_time from app.staff_weekly_schedules") && sql.includes("weekday=$2")) {
        const weekday = params[1];
        return { rows: weeklySchedules.filter((row) => params[0].includes(row.staff_id) && row.weekday === weekday) };
      }
      if (sql.includes("select distinct staff_id from app.staff_weekly_schedules")) {
        return { rows: [...new Set(weeklySchedules.filter((row) => params[0].includes(row.staff_id)).map((row) => row.staff_id))].map((staff_id) => ({ staff_id })) };
      }
      if (sql.includes("from app.staff_schedule_exceptions")) {
        const date = params[1];
        return { rows: exceptions.filter((row) => params[0].includes(row.staff_id) && row.exception_date === date) };
      }
      if (sql.includes("from app.appointments")) {
        const rows = sql.includes("confirmation_status is distinct from 'EspacioLiberado'")
          ? appointments.filter((row) => row.confirmation_status !== "EspacioLiberado")
          : appointments;
        return { rows };
      }
      throw new Error(`Consulta no simulada: ${sql}`);
    },
  };
}

const STAFF = [{ id: "COL-1", full_name: "Ana Pérez" }, { id: "COL-2", full_name: "Jaimely Peña" }];

test("availability(): weeklyHours con hora distinta por día tiene prioridad sobre defaultOpeningTime/defaultClosingTime", async () => {
  // Lunes (weekday 1) abre a la 1pm en vez de las 9am de siempre.
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: { defaultOpeningTime: "09:00", defaultClosingTime: "18:00", weeklyHours: { "1": { open: "13:00", close: "18:00" } } },
  }));
  const monday = "2026-08-31"; // lunes
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: monday });
  assert.ok(result.slots.length > 0);
  assert.ok(result.slots.every((slot) => slot.time >= "13:00"), "ningún horario antes de la 1pm configurada para el lunes");
});

test("availability(): weeklyHours con null marca el día completo cerrado aunque weekDays lo incluya", async () => {
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: { weekDays: [0, 1, 2, 3, 4, 5, 6], weeklyHours: { "5": null } }, // viernes cerrado
  }));
  const friday = "2026-09-04";
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: friday });
  assert.equal(result.closed, true);
  assert.deepEqual(result.slots, []);
});

test("availability(): una colaboradora sin fila en staff_weekly_schedules sigue el horario general (compatibilidad)", async () => {
  const store = new NeonBookingStore(fakePool({ staff: STAFF, businessSettings: { maximumAdvanceBookingDays: 400 } }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: "2027-06-01" });
  assert.ok(result.slots.length > 0, "sin ninguna fila configurada, debe comportarse exactamente como antes de que existiera la tabla");
});

test("availability(): colaboradora con horario semanal propio queda libre el día que no tiene fila (opt-in)", async () => {
  // COL-1 solo trabaja martes (weekday 2) según su horario propio -- probamos un lunes.
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: {},
    weeklySchedules: [{ staff_id: "COL-1", weekday: 2, start_time: "09:00:00", end_time: "18:00:00" }],
  }));
  const monday = "2026-08-31";
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: monday });
  assert.equal(result.closed, true, "opt-in: sin fila para ese día de la semana, no trabaja");
});

test("availability(): colaboradora con horario semanal propio respeta su hora de inicio (empieza en la tarde)", async () => {
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: { defaultOpeningTime: "09:00", defaultClosingTime: "18:00" },
    weeklySchedules: [{ staff_id: "COL-1", weekday: 1, start_time: "14:00:00", end_time: "18:00:00" }],
  }));
  const monday = "2026-08-31";
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: monday });
  assert.ok(result.slots.length > 0);
  assert.ok(result.slots.every((slot) => slot.time >= "14:00"));
});

test("availability(): una excepción puntual (available:false) deja libre a la colaboradora ese día aunque su horario semanal diga que trabaja", async () => {
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: { maximumAdvanceBookingDays: 400 },
    exceptions: [{ staff_id: "COL-1", exception_date: "2027-06-01", start_time: null, end_time: null, available: false }],
  }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: "2027-06-01" });
  assert.equal(result.closed, true);
});

test("availability(): una excepción puntual con horas propias (medio día) limita los horarios de esa colaboradora ese día", async () => {
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: { defaultOpeningTime: "09:00", defaultClosingTime: "18:00", maximumAdvanceBookingDays: 400 },
    exceptions: [{ staff_id: "COL-1", exception_date: "2027-06-01", start_time: "09:00:00", end_time: "12:00:00", available: true }],
  }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: "2027-06-01" });
  assert.ok(result.slots.length > 0);
  assert.ok(result.slots.every((slot) => slot.time < "12:00"));
});

test("availability(): una colaboradora sin servicio elegible no se ve afectada por el horario de otra que sí lo tiene", async () => {
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: {},
    weeklySchedules: [{ staff_id: "COL-2", weekday: 1, start_time: "09:00:00", end_time: "18:00:00" }],
  }));
  const monday = "2026-08-31";
  const result = await store.availability({ serviceIds: ["SRV-1"], date: monday }); // sin staffId, las dos elegibles
  const staffIdsInSlots = new Set(result.slots.map((slot) => slot.staffId));
  assert.ok(staffIdsInSlots.has("COL-1"), "COL-1 no tiene horario propio, sigue el horario general");
  assert.ok(staffIdsInSlots.has("COL-2"), "COL-2 sí trabaja ese lunes según su horario propio");
});

test("availability(): scheduleExceptions con open/close vacíos cierra el negocio entero esa fecha (mismo formato del editor del ERP legado)", async () => {
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: { scheduleExceptions: [{ date: "2026-12-25", open: null, close: null, label: "Navidad" }] },
  }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: "2026-12-25" });
  assert.equal(result.closed, true);
});

test("availability(): una cita con confirmation_status EspacioLiberado no bloquea su horario (el espacio reaparece disponible)", async () => {
  const monday = "2026-08-31";
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: {},
    appointments: [{ staff_id: "COL-1", starts_at: `${monday}T13:00:00-04:00`, ends_at: `${monday}T14:00:00-04:00`, confirmation_status: "EspacioLiberado" }],
  }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: monday });
  assert.ok(result.slots.some((slot) => slot.time === "13:00"), "el horario liberado debe reaparecer como disponible");
});

test("availability(): una cita normal (sin EspacioLiberado) sigue bloqueando su horario", async () => {
  const monday = "2026-08-31";
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: {},
    appointments: [{ staff_id: "COL-1", starts_at: `${monday}T13:00:00-04:00`, ends_at: `${monday}T14:00:00-04:00`, confirmation_status: "Programada" }],
  }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: monday });
  assert.ok(!result.slots.some((slot) => slot.time === "13:00"), "una cita normal sigue ocupando su horario");
});

test("availability(): scheduleExceptions con open/close puntuales cambia el horario del negocio solo esa fecha", async () => {
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: {
      defaultOpeningTime: "09:00", defaultClosingTime: "18:00", maximumAdvanceBookingDays: 400,
      scheduleExceptions: [{ date: "2026-12-24", open: "09:00", close: "13:00", label: "Nochebuena, medio día" }],
    },
  }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: "2026-12-24" });
  assert.ok(result.slots.length > 0);
  assert.ok(result.slots.every((slot) => slot.time < "13:00"));
});
