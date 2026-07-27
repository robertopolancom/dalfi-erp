import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const appJs = fs.readFileSync(path.join(root, "outputs", "app.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(root, "outputs", "index.html"), "utf8");

test("inventario muestra previsualizacion separada del guardado", () => {
  assert.match(indexHtml, /id="inventory-preview"/);
  assert.match(indexHtml, /id="inventory-preview-message"/);
  assert.match(appJs, /fetch\("\/api\/database-domain\?domain=inventario&dryRun=1"/);
  assert.match(appJs, /Cambio autorizado: listo para guardar/);
});

test("la previsualizacion exige permiso y nunca llama al endpoint de guardado", () => {
  const preview = appJs.slice(appJs.indexOf('byId("inventory-preview")'), appJs.indexOf('byId("inventory-form").addEventListener'));
  assert.match(preview, /canManageInventory\(\)/);
  assert.match(preview, /method: "POST"/);
  assert.doesNotMatch(preview, /fetch\("\/api\/database"/);
  assert.doesNotMatch(preview, /saveRemoteDatabase/);
});

test("el formulario de inventario usa el guardado server-side por dominio y revierte ante error", () => {
  assert.match(appJs, /fetch\("\/api\/database-domain\?domain=inventario&commit=1"/);
  assert.match(appJs, /saveState\(\{ skipRemote: true \}\)/);
  assert.match(appJs, /const previousDatabase = structuredClone\(database\)/);
  assert.match(appJs, /database = previousDatabase/);
  assert.match(appJs, /inventoryDomainTables\.forEach\(\(table\) =>/);
});

test("la previsualizacion muestra fallo de red sin mutar ni guardar", () => {
  assert.match(appJs, /No se pudo contactar el servidor\. Intenta de nuevo\./);
  assert.match(appJs, /No se pudo previsualizar inventario/);
});
