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

test("el vocabulario de estatus usa las 5 etiquetas guardables (Retrasada nunca se guarda, es derivada)", async () => {
  const app = await readApp();
  assert.match(app, /const APPOINTMENT_STATUS_LABEL = \{ scheduled: "Programada", confirmed: "Confirmada", cancelled: "Cancelada", completed: "Atendida", no_show: "No asistió" \};/);
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
  assert.match(html, /<button class="secondary" id="appointment-mark-attended" type="button">Atendida<\/button>/);
  assert.match(html, /<button class="secondary" id="appointment-mark-no-show" type="button">No asistió<\/button>/);
});

test("openAppointmentDetail() solo revela los botones de estatus para employeeRoles, nunca para el rol cliente -- y 'Confirmar asistencia' solo para administración", async () => {
  const app = await readApp();
  assert.match(app, /const isStaff = state\.account && employeeRoles\.has\(state\.account\.role\);/);
  assert.match(app, /\$\("appointment-status-actions"\)\.classList\.toggle\("hidden", !isStaff\);/);
  assert.match(app, /const isAdmin = Boolean\(state\.account\) && ADMIN_ROLES\.has\(state\.account\.role\);/);
  assert.match(app, /\$\("appointment-mark-confirmed"\)\.classList\.toggle\("hidden", !isAdmin \|\| item\.status !== "scheduled"\);/);
});

test("manicurista/asistente solo ven Atendida y No asistió, nunca Confirmar asistencia ni Confirmar depósito", async () => {
  const app = await readApp();
  assert.match(app, /const ADMIN_ROLES = new Set\(\["administradora", "superadministrador"\]\);/);
  assert.match(app, /const canMarkOutcome = \["scheduled", "confirmed"\]\.includes\(item\.status\);/);
  assert.match(app, /\$\("appointment-mark-attended"\)\.classList\.toggle\("hidden", !canMarkOutcome\);/);
  assert.match(app, /\$\("appointment-mark-no-show"\)\.classList\.toggle\("hidden", !canMarkOutcome\);/);
  assert.match(app, /const shouldShow = isAdmin && DEPOSIT_REVIEWABLE_STATES\.has\(item\.deposit_status\);/);
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
  assert.match(app, /const pending = item\.status === "scheduled";/);
  assert.match(app, /const moved = Boolean\(item\.moved_from\);/);
  assert.match(app, /block\.className = `agenda-cal-block status-\$\{item\.status\}\$\{late \? " status-delayed" : ""\}\$\{pending \? " status-pending-confirm" : ""\}\$\{moved \? " status-moved" : ""\}`;/);
  const css = await readFile(new URL("../outputs/reservar/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.agenda-cal-block\.status-delayed\{/);
  assert.match(css, /\.agenda-cal-block\.status-pending-confirm\{/);
  assert.match(css, /\.agenda-cal-block\.status-moved\{/);
});

// Desde la migración 0024 (appointments_no_staff_overlap) una cita 'scheduled' ya no bloquea el
// horario de nadie más -- así que dos citas pueden compartir manicurista+horario mientras ninguna
// esté confirmada. El calendario del día las posiciona por top/height absolutos: sin repartir el
// ancho en carriles, la segunda queda tapada exactamente detrás de la primera y la administradora
// nunca se entera de que existe (ver caso real: dos citas de Dalfina Guzman a las 3pm, 2026-09-02).
test("layoutOverlappingItems() reparte en carriles las citas que se solapan en horario, para que ninguna quede tapada", async () => {
  const app = await readApp();
  assert.match(app, /function layoutOverlappingItems\(items\)/);
  assert.match(app, /if \(totalLanes > 1\) \{\s*block\.style\.left = `calc\(4px \+ \(100% - 8px\) \* \$\{lane\}\/\$\{totalLanes\}\)`;/);
  assert.match(app, /for \(const \{ item, start, end, lane, totalLanes \} of layoutOverlappingItems\(items\)\) \{/);
});
