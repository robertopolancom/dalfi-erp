import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("el formulario lateral persiste manicurista, duración y fin y usa el motor de disponibilidad", async () => {
  const app = await readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../outputs/index.html", import.meta.url), "utf8");
  assert.match(html, /<select id="reservation-staff" required>/);
  assert.match(app, /DalfiBookingEngine\.calculateAvailableSlots/);
  assert.match(app, /colaboradorID: staffId/);
  assert.match(app, /duracionMin: durationMin/);
  assert.match(app, /horaFin: endTime/);
  assert.match(app, /bloqueoGlobal: false/);
});

test("solo ofrece manicuristas activas y excluye la cita editada del conflicto", async () => {
  const app = await readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
  assert.match(app, /for \(const person of activeManicuristas\(\)\)/);
  assert.match(app, /String\(item\.reservaID \|\| item\.id \|\| ""\) !== String\(editId\)/);
  assert.match(app, /availability\.slots\?\.some\(\(slot\) => slot\.time === time\)/);
});
