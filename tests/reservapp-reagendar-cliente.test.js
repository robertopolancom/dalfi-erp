import assert from "node:assert/strict";
import test from "node:test";
import { NeonBookingStore } from "../server/store.mjs";

// La regla que decide si un cliente puede mover su propia cita (Roberto, 2026-09-14):
//   se puede si NO está confirmada, o si faltan >= 90 minutos LABORABLES.
// O sea: lo único bloqueado es una cita confirmada que ya está encima. Lo que se protege aquí
// son las dos mitades de ese "o", porque confundirlas no se nota hasta que duele: bloquear de
// más deja a una clienta sin poder moverse y llamando al salón; bloquear de menos deja que le
// quiten el horario a una manicurista que ya lo tenía apartado.

const AHORA = Date.parse("2026-09-16T14:00:00.000Z"); // 10:00 hora local (UTC-4), miércoles
const HORARIO = {
  workdays: { 3: [{ start: "09:00", end: "18:00" }] }, // miércoles 9 a 18
};

function fakeClient({ appointment, onUpdate } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === "begin" || sql === "commit" || sql === "rollback") return {};
      if (sql.includes("from app.appointments where id=$1 for update")) {
        return { rows: appointment ? [appointment] : [] };
      }
      if (sql.includes("from app.business_settings")) {
        return { rows: [{ timezone: "America/Santo_Domingo", settings: HORARIO }] };
      }
      if (sql.includes("starts_at,") && sql.includes("::time")) {
        const [date, time] = params;
        const start = new Date(`${date}T${time}:00-04:00`);
        return { rows: [{ starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600000).toISOString() }] };
      }
      if (sql.includes("update app.appointments")) {
        if (onUpdate) onUpdate();
        return { rows: [{ id: "apt-1", legacy_id: "RES-1", staff_id: params[3], starts_at: params[1], ends_at: params[2], status: appointment.status, deposit_status: appointment.deposit_status }] };
      }
      throw new Error(`Consulta no simulada: ${sql}`);
    },
    release() {},
  };
}

function store(client) {
  const s = new NeonBookingStore({ connect: async () => client });
  s.mirrorAppointmentToDocument = async () => {};
  return s;
}

const cita = (extra = {}) => ({
  id: "apt-1", legacy_id: "RES-1", client_id: "cli-1", staff_id: "staff-1",
  status: "scheduled", deposit_status: "Verificado",
  starts_at: "2026-09-16T18:00:00.000Z", ends_at: "2026-09-16T19:00:00.000Z", // 14:00 local
  ...extra,
});

test("una cita SIN confirmar se puede mover aunque esté pegada a la hora", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: AHORA });
  // 10:10 local: faltan 10 minutos para las 10:20.
  const client = fakeClient({ appointment: cita({ starts_at: "2026-09-16T14:20:00.000Z", ends_at: "2026-09-16T15:20:00.000Z" }) });
  const resultado = await store(client).rescheduleOwnAppointment({
    appointmentId: "apt-1", clientId: "cli-1", date: "2026-09-16", time: "16:00",
  });
  assert.ok(resultado.appointment, "sin confirmar no aparta horario: moverla no le quita nada a nadie");
  assert.equal(resultado.blocked, undefined);
});

test("una cita CONFIRMADA y encima se bloquea, con un mensaje que dice qué hacer", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: AHORA });
  // Confirmada a las 10:20 local: 20 minutos laborables, menos de 90.
  const client = fakeClient({ appointment: cita({ status: "confirmed", starts_at: "2026-09-16T14:20:00.000Z", ends_at: "2026-09-16T15:20:00.000Z" }) });
  const resultado = await store(client).rescheduleOwnAppointment({
    appointmentId: "apt-1", clientId: "cli-1", date: "2026-09-16", time: "16:00",
  });
  assert.equal(resultado.blocked, "muy_encima");
  assert.match(resultado.message, /Escríbenos/, "no se le deja en un callejón sin salida");
  assert.ok(!client.queries.some((q) => q.sql.includes("update app.appointments")), "no se tocó la cita");
});

test("una cita CONFIRMADA con margen de sobra sí se puede mover", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: AHORA });
  // Confirmada a las 14:00 local: 4 horas laborables por delante.
  const client = fakeClient({ appointment: cita({ status: "confirmed" }) });
  const resultado = await store(client).rescheduleOwnAppointment({
    appointmentId: "apt-1", clientId: "cli-1", date: "2026-09-16", time: "16:00",
  });
  assert.ok(resultado.appointment);
});

test("el depósito viaja con la cita: el update nunca toca deposit_status", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: AHORA });
  const client = fakeClient({ appointment: cita({ status: "confirmed" }) });
  await store(client).rescheduleOwnAppointment({ appointmentId: "apt-1", clientId: "cli-1", date: "2026-09-16", time: "16:00" });
  const update = client.queries.find((q) => q.sql.includes("update app.appointments"));
  assert.doesNotMatch(update.sql, /deposit_status\s*=/, "mover la cita no puede costarle el depósito a nadie");
  assert.match(update.sql, /confirmation_status='Programada'/, "la hora cambió: lo confirmado antes ya no vale");
  assert.match(update.sql, /first_reminder_sent_at=null/, "el recordatorio se vuelve a armar para la hora nueva");
});

test("la cita de otro cliente responde 'no existe', sin confirmar que existe", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: AHORA });
  const client = fakeClient({ appointment: cita() });
  const resultado = await store(client).rescheduleOwnAppointment({
    appointmentId: "apt-1", clientId: "otro-cliente", date: "2026-09-16", time: "16:00",
  });
  assert.equal(resultado.notFound, true);
  assert.equal(resultado.blocked, undefined, "no se filtra por qué falló");
});

test("una cita cancelada o ya atendida no se mueve", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: AHORA });
  for (const status of ["cancelled", "replaced", "completed", "no_show"]) {
    const client = fakeClient({ appointment: cita({ status }) });
    const resultado = await store(client).rescheduleOwnAppointment({
      appointmentId: "apt-1", clientId: "cli-1", date: "2026-09-16", time: "16:00",
    });
    assert.equal(resultado.blocked, "estado", `estado ${status} debe bloquear`);
  }
});

test("si el horario se ocupó entre que lo vio y lo tocó, se le dice que elija otro", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: AHORA });
  const client = fakeClient({
    appointment: cita(),
    onUpdate: () => { throw Object.assign(new Error("conflicto"), { code: "23P01" }); },
  });
  const resultado = await store(client).rescheduleOwnAppointment({
    appointmentId: "apt-1", clientId: "cli-1", date: "2026-09-16", time: "16:00",
  });
  assert.equal(resultado.blocked, "ocupado");
  assert.match(resultado.message, /Elige otro/);
});

test("mover la cita a la hora que ya tiene no se cuenta como cambio", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: AHORA });
  const client = fakeClient({ appointment: cita() });
  const resultado = await store(client).rescheduleOwnAppointment({
    appointmentId: "apt-1", clientId: "cli-1", date: "2026-09-16", time: "14:00",
  });
  assert.equal(resultado.blocked, "sin_cambio");
});

// rescheduleOptions es lo que la pantalla consulta ANTES de enseñar horarios. Repite la misma
// regla que el movimiento a propósito: si no se puede mover, lo honesto es decirlo antes y no
// después de que el cliente haya elegido una hora.

function poolFake({ appointment, servicios = [{ service_id: "srv-1" }] }) {
  return {
    async query(sql, params) {
      if (sql.includes("from app.appointments where id=$1")) return { rows: appointment ? [appointment] : [] };
      if (sql.includes("from app.business_settings")) return { rows: [{ settings: HORARIO }] };
      if (sql.includes("from app.appointment_services")) return { rows: servicios };
      throw new Error(`Consulta no simulada: ${sql}`);
    },
  };
}

test("opciones: una cita confirmada y encima no enseña horarios, ofrece explicación", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: AHORA });
  const s = new NeonBookingStore(poolFake({ appointment: cita({ status: "confirmed", starts_at: "2026-09-16T14:20:00.000Z" }) }));
  const r = await s.rescheduleOptions({ appointmentId: "apt-1", clientId: "cli-1", date: "2026-09-16" });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "muy_encima");
});

test("opciones: una cita vieja sin service_id se deriva a una persona en vez de adivinar", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: AHORA });
  const s = new NeonBookingStore(poolFake({ appointment: cita(), servicios: [] }));
  const r = await s.rescheduleOptions({ appointmentId: "apt-1", clientId: "cli-1", date: "2026-09-16" });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "sin_servicios");
  assert.match(r.message, /Escríbenos/);
});

test("opciones: si se puede, devuelve los horarios que dé la agenda", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: AHORA });
  const s = new NeonBookingStore(poolFake({ appointment: cita() }));
  s.availability = async ({ serviceIds, date }) => {
    assert.deepEqual(serviceIds, ["srv-1"], "pregunta por los servicios de ESA cita");
    assert.equal(date, "2026-09-17");
    return { slots: [{ staffId: "staff-1", staffName: "Dalfina", time: "11:00" }], durationMinutes: 60 };
  };
  const r = await s.rescheduleOptions({ appointmentId: "apt-1", clientId: "cli-1", date: "2026-09-17" });
  assert.equal(r.allowed, true);
  assert.equal(r.slots.length, 1);
});

test("opciones: la cita de otro cliente no revela nada", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: AHORA });
  const s = new NeonBookingStore(poolFake({ appointment: cita() }));
  const r = await s.rescheduleOptions({ appointmentId: "apt-1", clientId: "otro", date: "2026-09-16" });
  assert.equal(r.notFound, true);
});
