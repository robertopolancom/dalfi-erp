import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { NeonBookingStore } from "../server/store.mjs";

// availabilityFallback() -- se llama solo cuando availability() (bloque continuo, una sola
// colaboradora) no encontró nada para 2+ servicios ese día. Mismo patrón de pool falso que
// tests/reservapp-schedule-availability.test.js (reconocimiento de texto de la consulta).
function fakePool({ staff = [], services = [], businessSettings = {}, weeklySchedules = [], exceptions = [], appointments = [], staffServices = [] } = {}) {
  return {
    async query(sql, params = []) {
      if (sql.includes("from app.services")) return { rows: services };
      if (sql.includes("from app.staff where status")) return { rows: staff };
      if (sql.includes("from app.business_settings")) return { rows: [{ timezone: "America/Santo_Domingo", settings: businessSettings }] };
      if (sql.includes("from app.staff_services")) return { rows: staffServices, rowCount: staffServices.length };
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
        return { rows: appointments.filter((row) => params[0].includes(row.staff_id)) };
      }
      throw new Error(`Consulta no simulada: ${sql}`);
    },
  };
}

const DATE = "2027-06-01"; // martes -- lejos de "hoy" (minNotice) y con maximumAdvanceBookingDays ampliado abajo
const FAR_FUTURE = { maximumAdvanceBookingDays: 400 };
const SRV_A = { id: "SRV-A", name: "Servicio A", category: "Uñas", base_price: 500, duration_minutes: 30 };
const SRV_B = { id: "SRV-B", name: "Servicio B", category: "Uñas", base_price: 700, duration_minutes: 45 };
const COL_1 = { id: "COL-1", full_name: "Ana" };
const COL_2 = { id: "COL-2", full_name: "Jaimely" };

test("availabilityFallback(): nivel 1 -- misma colaboradora, encuentra hueco con espera cuando ningún orden queda 100% continuo", async () => {
  const store = new NeonBookingStore(fakePool({
    staff: [COL_1],
    services: [SRV_A, SRV_B],
    businessSettings: FAR_FUTURE,
    appointments: [
      { staff_id: "COL-1", starts_at: "2027-06-01T13:30:00.000Z", ends_at: "2027-06-01T18:00:00.000Z" }, // 09:30-14:00 hora local
      { staff_id: "COL-1", starts_at: "2027-06-01T18:45:00.000Z", ends_at: "2027-06-01T22:00:00.000Z" }, // 14:45-18:00 hora local
    ],
  }));
  const result = await store.availabilityFallback({ serviceIds: ["SRV-A", "SRV-B"], date: DATE });
  assert.equal(result.tier, "same_staff_gap");
  assert.equal(result.segments.length, 2);
  assert.ok(result.segments.every((seg) => seg.staffId === "COL-1"), "las dos deben quedar con la misma colaboradora");
  assert.equal(result.totalGapMinutes, 270);
  assert.deepEqual(result.segments.map((s) => [s.serviceId, s.time, s.endTime]), [
    ["SRV-A", "09:00", "09:30"],
    ["SRV-B", "14:00", "14:45"],
  ]);
});

test("availabilityFallback(): nivel 2 -- sin nadie que haga los dos, reparte entre distintas colaboradoras y prueba reordenar para el mejor ajuste", async () => {
  const store = new NeonBookingStore(fakePool({
    staff: [COL_1, COL_2],
    services: [SRV_A, SRV_B],
    businessSettings: FAR_FUTURE,
    // COL-1 solo hace SRV-A, COL-2 solo hace SRV-B -- nadie elegible para los dos, nivel 1 no aplica.
    staffServices: [{ staff_id: "COL-1", service_id: "SRV-A" }, { staff_id: "COL-2", service_id: "SRV-B" }],
    appointments: [
      { staff_id: "COL-2", starts_at: "2027-06-01T13:00:00.000Z", ends_at: "2027-06-01T14:30:00.000Z" }, // 09:00-10:30 hora local
    ],
  }));
  const result = await store.availabilityFallback({ serviceIds: ["SRV-A", "SRV-B"], date: DATE });
  assert.equal(result.tier, "multi_staff");
  // El orden dado es [A,B] (deja un hueco de 60 min), pero probar [B,A] encuentra un empalme
  // perfectamente continuo (0 min de espera) -- debe quedarse con ese, no con el orden original.
  assert.equal(result.totalGapMinutes, 0);
  assert.deepEqual(result.segments.map((s) => [s.serviceId, s.staffId, s.time, s.endTime]), [
    ["SRV-B", "COL-2", "10:30", "11:15"],
    ["SRV-A", "COL-1", "11:15", "11:45"],
  ]);
});

test("availabilityFallback(): nivel 3 -- si nadie tiene ventana ese día (excepción sin disponibilidad), pide hablar con un agente", async () => {
  const store = new NeonBookingStore(fakePool({
    staff: [COL_1],
    services: [SRV_A, SRV_B],
    businessSettings: FAR_FUTURE,
    exceptions: [{ staff_id: "COL-1", exception_date: DATE, available: false, start_time: null, end_time: null }],
  }));
  const result = await store.availabilityFallback({ serviceIds: ["SRV-A", "SRV-B"], date: DATE });
  assert.deepEqual(result, { tier: "contact_agent" });
});

test("availabilityFallback(): con un solo servicio no hay nada que repartir -- responde contact_agent sin consultar la base", async () => {
  const store = new NeonBookingStore(fakePool({ staff: [COL_1], services: [SRV_A] }));
  const result = await store.availabilityFallback({ serviceIds: ["SRV-A"], date: DATE });
  assert.deepEqual(result, { tier: "contact_agent" });
});

test("availabilityFallback(): con más de 6 servicios no prueba permutaciones (crecerían factorial) -- va directo a contact_agent", async () => {
  const many = ["SRV-1", "SRV-2", "SRV-3", "SRV-4", "SRV-5", "SRV-6", "SRV-7"];
  const services = many.map((id, i) => ({ id, name: `Servicio ${i + 1}`, category: "Uñas", base_price: 100, duration_minutes: 15 }));
  const store = new NeonBookingStore(fakePool({ staff: [COL_1], services }));
  const result = await store.availabilityFallback({ serviceIds: many, date: DATE });
  assert.deepEqual(result, { tier: "contact_agent" });
});

test("availabilityFallback(): el negocio cerrado ese día responde contact_agent (no hay día que repartir)", async () => {
  const store = new NeonBookingStore(fakePool({
    staff: [COL_1],
    services: [SRV_A, SRV_B],
    businessSettings: { weekDays: [1, 2, 3, 4, 5, 6], weeklyHours: { "2": null } }, // martes cerrado
  }));
  const result = await store.availabilityFallback({ serviceIds: ["SRV-A", "SRV-B"], date: DATE });
  assert.deepEqual(result, { tier: "contact_agent" });
});

// ---------- GET /api/fast-booking/availability: cuándo la ruta llama a availabilityFallback ----------

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

function routeStore({ availabilityResult, fallbackResult } = {}) {
  const fallbackCalls = [];
  return {
    fallbackCalls,
    async availability() { return availabilityResult; },
    async availabilityFallback(input) { fallbackCalls.push(input); return fallbackResult; },
  };
}

async function withServer(store, run) {
  const app = createApp({
    store: documentStore(), bookingStore: store,
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test" },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
}

test("GET /api/fast-booking/availability: 2+ servicios sin staffId y sin slots -- llama a availabilityFallback y adjunta el resultado", async () => {
  const store = routeStore({
    availabilityResult: { date: DATE, durationMinutes: 75, slots: [] },
    fallbackResult: { tier: "same_staff_gap", totalGapMinutes: 270, segments: [] },
  });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/fast-booking/availability?serviceIds=SRV-A,SRV-B&date=${DATE}`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.fallback, { tier: "same_staff_gap", totalGapMinutes: 270, segments: [] });
    assert.equal(store.fallbackCalls.length, 1);
  });
});

test("GET /api/fast-booking/availability: un solo servicio sin slots -- NO llama a availabilityFallback", async () => {
  const store = routeStore({ availabilityResult: { date: DATE, durationMinutes: 30, slots: [] } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/fast-booking/availability?serviceIds=SRV-A&date=${DATE}`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.fallback, undefined);
    assert.equal(store.fallbackCalls.length, 0);
  });
});

test("GET /api/fast-booking/availability: con staffId puesto (una sola colaboradora en particular) -- NO llama a availabilityFallback", async () => {
  const store = routeStore({ availabilityResult: { date: DATE, durationMinutes: 75, slots: [] } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/fast-booking/availability?serviceIds=SRV-A,SRV-B&staffId=COL-1&date=${DATE}`);
    const body = await response.json();
    assert.equal(body.fallback, undefined);
    assert.equal(store.fallbackCalls.length, 0);
  });
});

test("GET /api/fast-booking/availability: si sí hay slots, no hace falta ninguna alternativa -- NO llama a availabilityFallback", async () => {
  const store = routeStore({ availabilityResult: { date: DATE, durationMinutes: 75, slots: [{ staffId: "COL-1", staffName: "Ana", time: "10:00" }] } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/fast-booking/availability?serviceIds=SRV-A,SRV-B&date=${DATE}`);
    const body = await response.json();
    assert.equal(body.fallback, undefined);
    assert.equal(store.fallbackCalls.length, 0);
  });
});

test("GET /api/fast-booking/availability: negocio cerrado ese día (closed:true) -- NO llama a availabilityFallback", async () => {
  const store = routeStore({ availabilityResult: { date: DATE, slots: [], closed: true } });
  await withServer(store, async (base) => {
    const response = await fetch(`${base}/api/fast-booking/availability?serviceIds=SRV-A,SRV-B&date=${DATE}`);
    const body = await response.json();
    assert.equal(body.fallback, undefined);
    assert.equal(store.fallbackCalls.length, 0);
  });
});
