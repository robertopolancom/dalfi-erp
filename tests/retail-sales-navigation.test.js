const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");

test("venta de productos tiene una vista principal propia en el menú", () => {
  assert.match(html, /data-view="retail-sales"[^>]*>Venta de productos<\/button>/);
  assert.match(html, /<section id="retail-sales" class="view">[\s\S]*id="retail-sale-form"/);
  assert.equal((html.match(/id="retail-sale-form"/g) || []).length, 1);
  assert.equal((html.match(/id="retail-sale-line-list"/g) || []).length, 1);
  assert.equal((html.match(/id="retail-sale-payment-line-list"/g) || []).length, 1);
});

test("la vista conserva el flujo de cobro de productos y su historial", () => {
  assert.match(html, /id="retail-sale-submit"[^>]*>Confirmar venta/);
  assert.match(html, /id="retail-sale-list"/);
  assert.match(html, /id="retail-sale-grand-total"/);
});
