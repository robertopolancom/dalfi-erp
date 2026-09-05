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

// Las fechas de este archivo se calculan relativas a HOY, nunca a mano. availability()
// (server/store.mjs) descarta todo horario anterior a `now + minNotice`, así que una fecha fija
// se pudre en cuanto pasa: estas pruebas llevaban rojas desde el 2026-09-01 porque usaban el
// 2026-08-31 como "lunes". El día de la semana se deriva EXACTAMENTE igual que en store.mjs
// (mediodía en -04:00) para que no haya forma de que discrepen.
function nextWeekday(weekday, daysAhead = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  for (let i = 0; i < 8; i += 1) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (new Date(`${iso}T12:00:00-04:00`).getDay() === weekday) return iso;
    d.setDate(d.getDate() + 1);
  }
  throw new Error(`No se encontró el día de la semana ${weekday}`);
}

// Para las excepciones de calendario con etiqueta (Navidad, Nochebuena): la fecha concreta da
// igual, pero tiene que seguir en el futuro. Devuelve la próxima vez que llega ese 24/25 de
// diciembre. Ojo: queda a más de 60 días, o sea fuera de maximumAdvanceBookingDays por defecto,
// así que la prueba que espera horarios sube ese límite a propósito.
function nextDecember(day) {
  const now = new Date();
  const thisYear = new Date(`${now.getFullYear()}-12-${day}T12:00:00-04:00`);
  const year = thisYear.getTime() > now.getTime() ? now.getFullYear() : now.getFullYear() + 1;
  return `${year}-12-${day}`;
}


test("availability(): weeklyHours con hora distinta por día tiene prioridad sobre defaultOpeningTime/defaultClosingTime", async () => {
  // Lunes (weekday 1) abre a la 1pm en vez de las 9am de siempre.
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: { defaultOpeningTime: "09:00", defaultClosingTime: "18:00", weeklyHours: { "1": { open: "13:00", close: "18:00" } } },
  }));
  const monday = nextWeekday(1);
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: monday });
  assert.ok(result.slots.length > 0);
  assert.ok(result.slots.every((slot) => slot.time >= "13:00"), "ningún horario antes de la 1pm configurada para el lunes");
});

test("availability(): weeklyHours con null marca el día completo cerrado aunque weekDays lo incluya", async () => {
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: { weekDays: [0, 1, 2, 3, 4, 5, 6], weeklyHours: { "5": null } }, // viernes cerrado
  }));
  const friday = nextWeekday(5);
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: friday });
  assert.equal(result.closed, true);
  assert.deepEqual(result.slots, []);
});

test("availability(): una colaboradora sin fila en staff_weekly_schedules sigue el horario general (compatibilidad)", async () => {
  const store = new NeonBookingStore(fakePool({ staff: STAFF, businessSettings: {} }));
  const tuesday = nextWeekday(2);
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: tuesday });
  assert.ok(result.slots.length > 0, "sin ninguna fila configurada, debe comportarse exactamente como antes de que existiera la tabla");
});

test("availability(): colaboradora con horario semanal propio queda libre el día que no tiene fila (opt-in)", async () => {
  // COL-1 solo trabaja martes (weekday 2) según su horario propio -- probamos un lunes.
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: {},
    weeklySchedules: [{ staff_id: "COL-1", weekday: 2, start_time: "09:00:00", end_time: "18:00:00" }],
  }));
  const monday = nextWeekday(1);
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: monday });
  assert.equal(result.closed, true, "opt-in: sin fila para ese día de la semana, no trabaja");
});

test("availability(): colaboradora con horario semanal propio respeta su hora de inicio (empieza en la tarde)", async () => {
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: { defaultOpeningTime: "09:00", defaultClosingTime: "18:00" },
    weeklySchedules: [{ staff_id: "COL-1", weekday: 1, start_time: "14:00:00", end_time: "18:00:00" }],
  }));
  const monday = nextWeekday(1);
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: monday });
  assert.ok(result.slots.length > 0);
  assert.ok(result.slots.every((slot) => slot.time >= "14:00"));
});

test("availability(): una excepción puntual (available:false) deja libre a la colaboradora ese día aunque su horario semanal diga que trabaja", async () => {
  const tuesday = nextWeekday(2);
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: {},
    exceptions: [{ staff_id: "COL-1", exception_date: tuesday, start_time: null, end_time: null, available: false }],
  }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: tuesday });
  assert.equal(result.closed, true);
});

test("availability(): una excepción puntual con horas propias (medio día) limita los horarios de esa colaboradora ese día", async () => {
  const tuesday = nextWeekday(2);
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: { defaultOpeningTime: "09:00", defaultClosingTime: "18:00" },
    exceptions: [{ staff_id: "COL-1", exception_date: tuesday, start_time: "09:00:00", end_time: "12:00:00", available: true }],
  }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: tuesday });
  assert.ok(result.slots.length > 0);
  assert.ok(result.slots.every((slot) => slot.time < "12:00"));
});

test("availability(): una colaboradora sin servicio elegible no se ve afectada por el horario de otra que sí lo tiene", async () => {
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: {},
    weeklySchedules: [{ staff_id: "COL-2", weekday: 1, start_time: "09:00:00", end_time: "18:00:00" }],
  }));
  const monday = nextWeekday(1);
  const result = await store.availability({ serviceIds: ["SRV-1"], date: monday }); // sin staffId, las dos elegibles
  const staffIdsInSlots = new Set(result.slots.map((slot) => slot.staffId));
  assert.ok(staffIdsInSlots.has("COL-1"), "COL-1 no tiene horario propio, sigue el horario general");
  assert.ok(staffIdsInSlots.has("COL-2"), "COL-2 sí trabaja ese lunes según su horario propio");
});

test("availability(): scheduleExceptions con open/close vacíos cierra el negocio entero esa fecha (mismo formato del editor del ERP legado)", async () => {
  const navidad = nextDecember("25");
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: { scheduleExceptions: [{ date: navidad, open: null, close: null, label: "Navidad" }] },
  }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: navidad });
  assert.equal(result.closed, true);
});

test("availability(): una cita con confirmation_status EspacioLiberado no bloquea su horario (el espacio reaparece disponible)", async () => {
  const monday = nextWeekday(1);
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: {},
    appointments: [{ staff_id: "COL-1", starts_at: `${monday}T13:00:00-04:00`, ends_at: `${monday}T14:00:00-04:00`, confirmation_status: "EspacioLiberado" }],
  }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: monday });
  assert.ok(result.slots.some((slot) => slot.time === "13:00"), "el horario liberado debe reaparecer como disponible");
});

test("availability(): una cita normal (sin EspacioLiberado) sigue bloqueando su horario", async () => {
  const monday = nextWeekday(1);
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: {},
    appointments: [{ staff_id: "COL-1", starts_at: `${monday}T13:00:00-04:00`, ends_at: `${monday}T14:00:00-04:00`, confirmation_status: "Programada" }],
  }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: monday });
  assert.ok(!result.slots.some((slot) => slot.time === "13:00"), "una cita normal sigue ocupando su horario");
});

test("availability(): scheduleExceptions con open/close puntuales cambia el horario del negocio solo esa fecha", async () => {
  const nochebuena = nextDecember("24");
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: {
      defaultOpeningTime: "09:00", defaultClosingTime: "18:00", maximumAdvanceBookingDays: 400,
      scheduleExceptions: [{ date: nochebuena, open: "09:00", close: "13:00", label: "Nochebuena, medio día" }],
    },
  }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: nochebuena });
  assert.ok(result.slots.length > 0);
  assert.ok(result.slots.every((slot) => slot.time < "13:00"));
});

// Bug real encontrado en auditoría: el comentario de resolveBusinessDayWindow ya decía que
// scheduleExceptions manda sobre weekDays/holidayClosures, pero el código devolvía cerrado de
// todos modos si el día de la semana no estaba en weekDays -- así que "domingo con horario
// especial" (weekDays no incluye domingo por defecto) nunca podía abrir. Corregido: con open+close
// propios, la excepción sí abre un día normalmente cerrado.
test("availability(): scheduleExceptions con open/close propios abre un domingo aunque weekDays no lo incluya (disponibilidad especial)", async () => {
  const sunday = nextWeekday(0);
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: {
      defaultOpeningTime: "09:00", defaultClosingTime: "18:00", maximumAdvanceBookingDays: 400,
      scheduleExceptions: [{ date: sunday, open: "10:00", close: "14:00", label: "Domingo especial" }],
    },
  }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: sunday });
  assert.equal(result.closed, undefined);
  assert.ok(result.slots.length > 0, "el domingo con excepción especial debe tener horarios");
  assert.ok(result.slots.every((slot) => slot.time >= "10:00" && slot.time < "14:00"));
});

test("availability(): un domingo normal (sin excepción) sigue cerrado por defecto", async () => {
  const sunday = nextWeekday(0);
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    businessSettings: { defaultOpeningTime: "09:00", defaultClosingTime: "18:00", maximumAdvanceBookingDays: 400 },
  }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: sunday });
  assert.equal(result.closed, true);
});

// La última cita del día puede terminar después de la hora de cierre -- a diferencia de un
// banco, lo que importa es que la clienta haya entrado antes de que se cierre, no que el
// servicio completo quepa antes del cierre.
test("availability(): un servicio que empieza antes de cerrar se ofrece aunque termine después del cierre (no como un banco)", async () => {
  const store = new NeonBookingStore(fakePool({
    staff: STAFF,
    // SRV-1 dura 60 min (fakePool, línea 11); ventana de solo 30 min (09:00-09:30) -- antes de
    // este cambio, ningún horario cabía completo y result.slots quedaba vacío.
    businessSettings: { defaultOpeningTime: "09:00", defaultClosingTime: "09:30" },
  }));
  const result = await store.availability({ serviceIds: ["SRV-1"], staffId: "COL-1", date: nextWeekday(2) });
  assert.ok(result.slots.length > 0, "debe ofrecer horarios aunque el servicio termine después del cierre");
  assert.ok(result.slots.every((slot) => slot.time < "09:30"), "el horario de INICIO debe seguir siendo antes de cerrar");
  assert.ok(result.slots.some((slot) => slot.time === "09:15"), "09:15 empieza antes de cerrar (09:30) aunque el servicio de 60 min termine a las 10:15");
});
