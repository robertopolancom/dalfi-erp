// Horario del salón (Roberto, 2026-09-19): 9:00 a 18:00; almuerzo 12:00-13:00 sin citas de lunes a
// jueves; viernes y sábado corrido. Lo tienen que respetar las DOS disponibilidades: la del bot
// (calculateAvailableSlots, outputs/lib/booking-engine.js) y la de ReservApp/ERP (server/store.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { almuerzoDelNegocio, calculateAvailableSlots, DEFAULT_BUSINESS_SCHEDULE } from "../outputs/lib/booking-engine.js";

const servicio = [{ servicioID: "S60", duracionMin: 60 }];
const horas = (date, extra = {}) => calculateAvailableSlots({
  date, collaboratorId: "C1", serviceLines: [{ serviceId: "S60" }], services: servicio,
  businessSchedule: DEFAULT_BUSINESS_SCHEDULE, now: new Date("2026-09-30T12:00:00Z"), ...extra,
}).slots.map((s) => s.time);

test("HA01 — la regla: lunes a jueves 12:00-13:00; viernes, sábado y domingo sin almuerzo", () => {
  for (const d of [1, 2, 3, 4]) assert.deepEqual(almuerzoDelNegocio(d), { start: "12:00", end: "13:00" });
  for (const d of [0, 5, 6]) assert.equal(almuerzoDelNegocio(d), null);
  assert.deepEqual(almuerzoDelNegocio(5, { lunchByDay: { 5: { start: "12:30", end: "13:00" } } }), { start: "12:30", end: "13:00" }, "se puede cambiar desde la configuración");
});

test("HA02 — el bot: un jueves no ofrece nada que toque 12:00-13:00; ofrece 9:00 y 13:00", () => {
  const t = horas("2026-10-01"); // jueves
  assert.ok(t.includes("09:00"));
  assert.ok(!t.includes("11:30"), "de 11:30 a 12:30 pisa el almuerzo");
  assert.ok(!t.includes("12:00"));
  assert.ok(!t.includes("12:30"));
  assert.ok(t.includes("13:00"));
});

test("HA03 — el bot: viernes y sábado se trabaja corrido (12:00 disponible)", () => {
  for (const fecha of ["2026-10-02", "2026-10-03"]) {
    const t = horas(fecha);
    assert.ok(t.includes("11:30") && t.includes("12:00") && t.includes("12:30"), `${fecha} tiene que ofrecer el mediodía`);
  }
});

test("HA04 — ReservApp/ERP aplican el mismo almuerzo en la disponibilidad normal y en la alternativa", async () => {
  const store = await readFile(new URL("../server/store.mjs", import.meta.url), "utf8");
  assert.match(store, /import \{ almuerzoDelNegocio \} from "\.\.\/outputs\/lib\/booking-engine\.js";/);
  assert.equal((store.match(/conAlmuerzoDelNegocio\(\n/g) || []).length, 3, "availability + los dos niveles de availabilityFallback");
});
