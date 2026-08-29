// Crear cita al hacer click en una ranura "Disponible" de la Matriz Consolidada Diaria.
// outputs/app.js manipula el DOM directamente (document/byId) sin un framework, así que --
// igual que tests/reservation-side-form-availability.test.js -- estas son pruebas de
// caracterización por texto fuente, no de comportamiento en un DOM real.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("las ranuras 'Disponible' de la matriz llevan los data-attributes para el menú de acción al click", async () => {
  const app = await readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
  assert.match(app, /class="slot-cell-available" data-date="\$\{escapeHtml\(targetDate\)\}" data-time="\$\{escapeHtml\(row\.time\)\}" data-staff-id="\$\{escapeHtml\(col\.id\)\}" data-staff-name="\$\{escapeHtml\(col\.name\)\}"/);
});

test("los dos diálogos nuevos (menú de acción y selector de citas) existen en el HTML", async () => {
  const html = await readFile(new URL("../outputs/index.html", import.meta.url), "utf8");
  assert.match(html, /<dialog id="slot-action-dialog" class="app-dialog">/);
  assert.match(html, /<button class="primary-btn" id="slot-action-create" type="button">/);
  assert.match(html, /<button class="secondary-btn" id="slot-action-modify" type="button">/);
  assert.match(html, /<dialog id="slot-appointment-picker-dialog" class="app-dialog">/);
  assert.match(html, /<div id="slot-appointment-picker-list" class="appointments list">/);
});

test("el click en una ranura disponible NO crea nada directo -- abre el menú '¿Qué quieres hacer?' con la info de la celda", async () => {
  const app = await readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
  assert.match(app, /event\.target\.closest\("\.slot-cell-available"\)/);
  assert.match(app, /openSlotActionMenu\(\{\s*date: availableSlotCell\.dataset\.date,\s*time: availableSlotCell\.dataset\.time,\s*staffId: availableSlotCell\.dataset\.staffId,\s*staffName: availableSlotCell\.dataset\.staffName,\s*\}\);/);
});

test("openSlotActionMenu exige permiso, guarda el slot pendiente y abre #slot-action-dialog (no crea ni edita todavía)", async () => {
  const app = await readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
  assert.match(app, /function openSlotActionMenu\(\{ date, time, staffId, staffName \}\) \{/);
  assert.match(app, /if \(!canManageReservations\(\)\) \{/);
  assert.match(app, /pendingSlotAction = \{ date, time, staffId \};/);
  assert.match(app, /byId\("slot-action-dialog"\)\?\.showModal\(\);/);
});

test("el botón 'Crear nueva cita' del menú es el único que llama a startReservationFromSlot", async () => {
  const app = await readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
  assert.match(app, /byId\("slot-action-create"\)\?\.addEventListener\("click", \(\) => \{\s*byId\("slot-action-dialog"\)\?\.close\(\);\s*if \(pendingSlotAction\) startReservationFromSlot\(pendingSlotAction\);\s*pendingSlotAction = null;\s*\}\);/);
});

test("el botón 'Modificar una cita existente' abre el listado de citas abiertas ese día, no un formulario vacío", async () => {
  const app = await readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
  assert.match(app, /byId\("slot-action-modify"\)\?\.addEventListener\("click", \(\) => \{\s*byId\("slot-action-dialog"\)\?\.close\(\);\s*if \(pendingSlotAction\) openSlotAppointmentPicker\(pendingSlotAction\);\s*pendingSlotAction = null;\s*\}\);/);
  assert.match(app, /function openSlotAppointmentPicker\(\{ date \}\) \{/);
  assert.match(app, /OPEN_RESERVATION_STATUSES = new Set\(\["Programada", "Confirmada", "En proceso"\]\);/);
  assert.match(app, /reservation\.date === date && OPEN_RESERVATION_STATUSES\.has\(reservationStatus\(reservation\)\)/);
});

test("seleccionar una cita del listado cierra el picker, muestra la pestaña Agenda y abre esa cita en modo edición", async () => {
  const app = await readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
  assert.match(app, /byId\("slot-appointment-picker-list"\)\?\.addEventListener\("click", \(event\) => \{\s*const selectBtn = event\.target\.closest\("\.slot-picker-select"\);\s*if \(!selectBtn\) return;\s*byId\("slot-appointment-picker-dialog"\)\?\.close\(\);\s*byId\("booking-tab-agenda"\)\?\.click\(\);\s*startReservationEdit\(selectBtn\.dataset\.reservationId\);\s*\}\);/);
});

test("startReservationFromSlot exige permiso, resetea el form a modo creación (nunca edición) y fija fecha/hora", async () => {
  const app = await readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
  assert.match(app, /function startReservationFromSlot\(\{ date, time, staffId \}\) \{/);
  assert.match(app, /if \(!canManageReservations\(\)\) \{/);
  assert.match(app, /resetReservationEditState\(form\);/);
  assert.match(app, /byId\("reservation-date"\)\.value = date;/);
  assert.match(app, /byId\("reservation-time"\)\.value = time;/);
  assert.match(app, /form\.dataset\.preferredStaffId = staffId \|\| "";/);
  assert.match(app, /byId\("booking-tab-agenda"\)\?\.click\(\);/);
});

test("availableReservationStaff() aplica la manicurista preferida de la celda clickeada y la descarta tras evaluarla", async () => {
  const app = await readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
  assert.match(app, /const preferredStaffId = form\?\.dataset\.preferredStaffId \|\| "";/);
  assert.match(app, /options\.find\(\(person\) => person\.id === preferredStaffId\)/);
  assert.match(app, /if \(form && serviceRecord\) delete form\.dataset\.preferredStaffId;/);
});

test("la preferencia de manicurista nunca se filtra a un 'Nueva reserva' manual ni a editar una cita existente", async () => {
  const app = await readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
  assert.match(app, /function resetReservationEditState\(form = byId\("reservation-form"\)\) \{\s*if \(!form\) return;\s*delete form\.dataset\.preferredStaffId;/);
  assert.match(app, /if \(!record \|\| !form\) return;\s*delete form\.dataset\.preferredStaffId;\s*byId\("reservation-edit-id"\)\.value = reservationId;/);
});
