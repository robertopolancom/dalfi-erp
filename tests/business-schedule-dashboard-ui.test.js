// Aserciones estáticas sobre el formulario "Configuración General del
// Establecimiento" del Dashboard — mismo patrón ya usado en
// tests/closing-initial-cash-ui.test.js: no hay DOM real en este runner
// (node --test, sin jsdom), así que se revisa el texto fuente de
// outputs/index.html y outputs/app.js.
//
// Historial: el formulario existía en el HTML (business-schedule-form) pero
// outputs/app.js no tenía NINGUNA referencia a él — ni cargaba los valores
// actuales ni guardaba nada al enviarlo (HTML muerto). Esta tarea lo activa
// y lo extiende de un solo horario global a horario por día de semana +
// excepciones por fecha (ver outputs/lib/booking-engine.js weeklyHours /
// scheduleExceptions).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");

test("index.html: el formulario ya no tiene un solo horario global (biz-opening-time/biz-closing-time) — es por día de semana", () => {
  assert.ok(!/id="biz-opening-time"/.test(indexHtml), "el campo de apertura global debe haberse reemplazado por horario por día");
  assert.ok(!/id="biz-closing-time"/.test(indexHtml), "el campo de cierre global debe haberse reemplazado por horario por día");
  assert.match(indexHtml, /id="business-weekly-hours"/);
  assert.match(indexHtml, /id="business-exceptions-list"/);
  assert.match(indexHtml, /id="biz-exception-date"/);
  assert.match(indexHtml, /id="biz-exception-open"/);
  assert.match(indexHtml, /id="biz-exception-close"/);
  assert.match(indexHtml, /id="biz-exception-add-btn"/);
});

test("index.html: las demás reglas del formulario (aviso mínimo, máximo días, intervalo, buffer) se conservan con los mismos ids", () => {
  assert.match(indexHtml, /id="biz-notice-minutes"/);
  assert.match(indexHtml, /id="biz-max-days"/);
  assert.match(indexHtml, /id="biz-slot-interval"/);
  assert.match(indexHtml, /id="biz-buffer-after"/);
});

test("outputs/app.js: renderBusinessScheduleForm() lee database.data.businessSchedule normalizado (nunca crudo) para poblar el formulario", () => {
  const fnMatch = /function renderBusinessScheduleForm\(\) \{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(fnMatch, "no se encontró renderBusinessScheduleForm");
  assert.match(fnMatch[0], /DalfiBookingEngine\.normalizeBusinessSchedule\(database\.data\?\.businessSchedule/);
  assert.match(fnMatch[0], /renderBusinessWeeklyHours\(/);
  assert.match(fnMatch[0], /renderBusinessExceptionsList\(\)/);
});

test("outputs/app.js: la pestaña 'booking-panel-business' llama a renderBusinessScheduleForm() al abrirse (igual que la Matriz llama a renderConsolidatedMatrix)", () => {
  const tabBlock = /bookingTabsMap\.forEach\(\(\{ btn, panel \}\) => \{[\s\S]*?\n  \}\);/.exec(appJs);
  assert.ok(tabBlock, "no se encontró el wiring de pestañas de Reservas");
  assert.match(tabBlock[0], /if \(panel === "booking-panel-business"\) \{\s*\n\s*renderBusinessScheduleForm\(\);/);
});

test("outputs/app.js: saveBusinessSchedule() valida que el cierre sea posterior a la apertura antes de guardar cualquier día", () => {
  const fnMatch = /function saveBusinessSchedule\(event\) \{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(fnMatch, "no se encontró saveBusinessSchedule");
  assert.match(fnMatch[0], /if \(open >= close\)/);
});

test("outputs/app.js: saveBusinessSchedule() escribe weeklyHours y scheduleExceptions en database.data.businessSchedule y llama a saveState()", () => {
  const fnMatch = /function saveBusinessSchedule\(event\) \{[\s\S]*?\n\}/.exec(appJs);
  assert.match(fnMatch[0], /database\.data\.businessSchedule = \{/);
  assert.match(fnMatch[0], /weeklyHours,/);
  assert.match(fnMatch[0], /scheduleExceptions: pendingScheduleExceptions,/);
  assert.match(fnMatch[0], /saveState\(\);/);
  assert.match(fnMatch[0], /logAudit\("business_schedule_updated"/);
});

test("outputs/app.js: el submit del formulario está conectado a saveBusinessSchedule", () => {
  assert.match(appJs, /byId\("business-schedule-form"\)\?\.addEventListener\("submit", saveBusinessSchedule\)/);
});

test("outputs/app.js: agregar/eliminar excepciones están conectados (biz-exception-add-btn, .biz-exception-delete)", () => {
  assert.match(appJs, /byId\("biz-exception-add-btn"\)\?\.addEventListener\("click"/);
  assert.match(appJs, /event\.target\.closest\("\.biz-exception-delete"\)/);
});

test("outputs/app.js: marcar/desmarcar un día como abierto habilita o deshabilita sus campos de hora (delegación en 'change')", () => {
  const changeBlock = /document\.addEventListener\("change", \(event\) => \{[\s\S]*?\n  \}\);/.exec(appJs);
  assert.ok(changeBlock, "no se encontró el listener de 'change' para biz-day-enabled");
  assert.match(changeBlock[0], /biz-day-enabled/);
  assert.match(changeBlock[0], /toggleAttribute\("disabled", !enabled\)/);
});
