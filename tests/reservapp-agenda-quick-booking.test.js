// Panel de colaboradores (outputs/reservar/): click en zona vacía del calendario de una
// manicurista arranca el wizard de reserva para el personal, sin tocar la vista "Mis citas" de
// un cliente. outputs/reservar/app.js manipula el DOM directamente (document/$), así que --
// igual que tests/reservapp-identity-agenda.test.js -- son pruebas de caracterización por
// texto fuente, no de comportamiento en un DOM real.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readApp() {
  return readFile(new URL("../outputs/reservar/app.js", import.meta.url), "utf8");
}

test("el click en zona vacía del calendario solo se conecta cuando NO es la columna 'Mis citas' de un cliente (!group.client)", async () => {
  const app = await readApp();
  assert.match(app, /if \(!group\.client\) \{\s*body\.classList\.add\("agenda-cal-body-clickable"\);/);
});

test("el click en zona vacía ignora los bloques de citas existentes y arranca startAgendaQuickBooking con fecha/manicurista/hora aproximada", async () => {
  const app = await readApp();
  assert.match(app, /if \(event\.target\.closest\("\.agenda-cal-block"\)\) return;/);
  assert.match(app, /startAgendaQuickBooking\(\{ date: \$\("agenda-date"\)\.value, staffId: group\.id, staffName: group\.name, time \}\);/);
});

test("startAgendaQuickBooking limpia el estado del dispositivo, fija la fecha y lleva al paso 1 (servicios) del wizard existente", async () => {
  const app = await readApp();
  assert.match(app, /function startAgendaQuickBooking\(\{ date, staffId, staffName, time \}\) \{/);
  assert.match(app, /resetDeviceState\(\);\s*state\.preferredAgendaStaffId = staffId;\s*if \(date\) \$\("date"\)\.value = date;\s*showBooking\(\);\s*goToStep\(1\);/);
});

test("la manicurista preferida se resalta y se descarta como preferencia de un solo uso en el tablero de horarios del paso 3", async () => {
  const app = await readApp();
  assert.match(app, /column\.dataset\.staffId = staffId;/);
  assert.match(app, /if \(state\.preferredAgendaStaffId\) \{/);
  assert.match(app, /preferredColumn\.classList\.add\("preferred-staff-column"\);/);
  assert.match(app, /state\.preferredAgendaStaffId = null;/);
});

test("resetDeviceState también descarta preferredAgendaStaffId, para que no se filtre a una reserva no relacionada", async () => {
  const app = await readApp();
  assert.match(app, /state\.quickSetupPhone = null;\s*state\.preferredAgendaStaffId = null;\s*goToStep\(0\);/);
});

test("no quedó ningún 'clienta' fuera del shim de compatibilidad ya cubierto por reservapp-admin-delete.test.js", async () => {
  const app = await readApp();
  const stray = app
    .split("\n")
    .filter((line) => /\bclientas?\b/i.test(line))
    .filter((line) => !/isClientRole|migración 0016 del ERP renombró/.test(line));
  assert.deepEqual(stray, []);
});
