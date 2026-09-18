// El ERP reconstruye solo la pantalla visible; las demás quedan pendientes hasta que se abren
// (Lighthouse 2026-09-18: renderAll() reconstruía 41 piezas en cada guardado y sincronización).
// outputs/app.js manipula el DOM directamente, así que -- como otras pruebas del ERP -- se fija
// por el texto fuente que ninguna pieza se pierde y que toda forma de abrir una pantalla la construye.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../outputs/index.html", import.meta.url), "utf8");

test("RP01 — cada pieza del mapa apunta a una pantalla que existe", () => {
  const mapa = app.match(/const RENDER_POR_VISTA = \{([\s\S]*?)\n\};/)[1];
  const vistas = [...mapa.matchAll(/^  "([a-z-]+)": \[/gm)].map((m) => m[1]);
  assert.ok(vistas.length >= 15);
  for (const v of vistas) assert.match(html, new RegExp(`<section id="${v}" class="view`), `no existe la pantalla ${v}`);
  const piezas = [...mapa.matchAll(/\["[^"]+", (render\w+)\]/g)].map((m) => m[1]);
  assert.equal(piezas.length, 40, "las 40 piezas por pantalla (41 con las listas de autocompletar)");
  assert.equal(new Set(piezas).size, piezas.length, "ninguna pieza repetida");
  for (const p of piezas) assert.match(app, new RegExp(`^function ${p}\\(`, "m"), `${p} no existe`);
});

test("RP02 — renderAll sigue construyendo siempre las listas de autocompletar y la pantalla visible", () => {
  const cuerpo = app.match(/^function renderAll\(\) \{([\s\S]*?)^\}/m)[1];
  assert.match(cuerpo, /safeRender\("datalists", renderDatalists\)/);
  assert.match(cuerpo, /if \(viewId === activa\) renderVista\(viewId\);/);
  assert.match(cuerpo, /else vistasPendientes\.add\(viewId\);/);
});

test("RP03 — toda forma de activar una pantalla construye lo pendiente", () => {
  const activaciones = [...app.matchAll(/byId\("([a-z-]+)"\)\.classList\.add\("active"\);/g)].map((m) => m[1]);
  for (const v of activaciones) {
    assert.match(app, new RegExp(`if \\(vistasPendientes\\.has\\("${v}"\\)\\) renderVista\\("${v}"\\);`), `abrir ${v} a mano no la construye`);
  }
  assert.match(app, /if \(vistasPendientes\.has\(viewId\)\) renderVista\(viewId\);/, "switchToView");
});
