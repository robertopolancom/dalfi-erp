// Cambio de estatus (Confirmar/Marcar atendida) desde el detalle de una cita en el Panel de
// colaboradores, y el cálculo derivado de "Retrasada". outputs/reservar/app.js manipula el DOM
// directamente (document/$), así que -- igual que otros tests de este archivo -- son pruebas de
// caracterización por texto fuente, no de comportamiento en un DOM real.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readApp() {
  return readFile(new URL("../outputs/reservar/app.js", import.meta.url), "utf8");
}
async function readHtml() {
  return readFile(new URL("../outputs/reservar/index.html", import.meta.url), "utf8");
}

test("el vocabulario de estatus usa las 4 etiquetas guardables nuevas (Retrasada nunca se guarda, es derivada)", async () => {
  const app = await readApp();
  assert.match(app, /const APPOINTMENT_STATUS_LABEL = \{ scheduled: "Programada", confirmed: "Confirmada", cancelled: "Cancelada", completed: "Atendida" \};/);
});

test("isAppointmentLate() solo aplica a Programada/Confirmada y compara contra la hora de inicio", async () => {
  const app = await readApp();
  assert.match(app, /function isAppointmentLate\(item, now = new Date\(\)\) \{/);
  assert.match(app, /if \(item\.status !== "scheduled" && item\.status !== "confirmed"\) return false;/);
  assert.match(app, /return now\.getTime\(\) > startsAt\.getTime\(\);/);
});

test("los botones de estatus en el detalle de la cita existen y están ocultos por defecto (solo se muestran a personal)", async () => {
  const html = await readHtml();
  assert.match(html, /<div class="hidden" id="appointment-status-actions">/);
  assert.match(html, /<button class="secondary" id="appointment-mark-confirmed" type="button">Confirmar asistencia<\/button>/);
  assert.match(html, /<button class="secondary" id="appointment-mark-attended" type="button">Marcar como atendida<\/button>/);
});

test("openAppointmentDetail() solo revela los botones de estatus para employeeRoles, nunca para el rol cliente", async () => {
  const app = await readApp();
  assert.match(app, /const isStaff = state\.account && employeeRoles\.has\(state\.account\.role\);/);
  assert.match(app, /\$\("appointment-status-actions"\)\.classList\.toggle\("hidden", !isStaff\);/);
});

test("setAppointmentDetailStatus() llama al endpoint compartido con ERP y refresca la agenda al terminar", async () => {
  const app = await readApp();
  assert.match(app, /async function setAppointmentDetailStatus\(status, button\) \{/);
  assert.match(app, /api\(`\/api\/reservapp\/agenda\/appointments\/\$\{state\.appointmentDetailId\}\/status`, \{\s*method: "POST", body: JSON\.stringify\(\{ status \}\),/);
  assert.match(app, /setAppointmentDetailStatus\("confirmed", event\.currentTarget\)/);
  assert.match(app, /setAppointmentDetailStatus\("completed", event\.currentTarget\)/);
});

test("las citas retrasadas en el calendario del día llevan la clase status-delayed y la nota 'Retrasada'", async () => {
  const app = await readApp();
  assert.match(app, /const late = isAppointmentLate\(item\);/);
  assert.match(app, /block\.className = `agenda-cal-block status-\$\{item\.status\}\$\{late \? " status-delayed" : ""\}`;/);
  const css = await readFile(new URL("../outputs/reservar/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.agenda-cal-block\.status-delayed\{/);
});
