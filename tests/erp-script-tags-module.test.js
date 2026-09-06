import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";

// Un archivo con `export` cargado en un <script> clásico no falla a medias: el navegador no
// parsea NADA de ese archivo ("SyntaxError: Unexpected token 'export'"), así que ni siquiera
// corre el `globalThis.X = {...}` del final. Y como en app.js todos los usos están detrás de un
// `typeof X !== "undefined"`, no revienta ninguna pantalla: simplemente dejan de funcionar en
// silencio. Fue lo que pasó con lib/booking-engine.js -- "Nueva reserva" llevaba desde el
// 2026-08-06 diciendo "No hay manicuristas disponibles a esa hora" con el salón vacío, y la
// Matriz Consolidada Diaria no pintaba. Nadie vio un error porque no lo había.
const html = readFileSync(new URL("../outputs/index.html", import.meta.url), "utf8");

// <script src="ruta"> locales, con o sin type="module". Se ignoran los CDN (src absoluto).
function localScriptTags() {
  const tags = html.match(/<script\b[^>]*\bsrc=["'][^"':]+["'][^>]*>/g) || [];
  return tags.map((tag) => ({
    tag,
    src: tag.match(/src=["']([^"'?]+)/)[1],
    isModule: /\btype=["']module["']/.test(tag),
  }));
}

test("todo script local con `export` se carga con type=\"module\"", () => {
  const scripts = localScriptTags();
  assert.ok(scripts.length >= 3, "se esperaban varios <script> locales; ¿cambió el marcado?");
  for (const { src, isModule } of scripts) {
    const file = new URL(`../outputs/${src}`, import.meta.url);
    if (!existsSync(file)) continue;
    const esModule = /^\s*export\s/m.test(readFileSync(file, "utf8"));
    assert.equal(esModule, isModule,
      esModule
        ? `${src} usa \`export\` pero se carga como script clásico: el navegador no ejecutará nada de ese archivo`
        : `${src} no usa \`export\`, así que no necesita type="module"`);
  }
});

test("booking-engine.js sigue publicando su global para el ERP", () => {
  // El ERP no lo importa: lo lee de globalThis. Si algún día se quitan los `export` y deja de
  // ser módulo, la prueba de arriba avisa; ésta cubre el otro lado del trato.
  const engine = readFileSync(new URL("../outputs/lib/booking-engine.js", import.meta.url), "utf8");
  assert.match(engine, /globalThis\.DalfiBookingEngine\s*=/);
  for (const used of ["calculateAvailableSlots", "buildConsolidatedDailyMatrix", "normalizeBusinessSchedule",
                      "generateWhatsAppReceiptText", "checkPreapprovedConfirmationReminder"]) {
    assert.ok(engine.includes(used), `app.js llama a DalfiBookingEngine.${used}`);
  }
});
