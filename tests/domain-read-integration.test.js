import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const appJs = fs.readFileSync(path.join(process.cwd(), "outputs", "app.js"), "utf8");

test("la SPA valida el slice server-side de inventario durante la carga remota", () => {
  assert.match(appJs, /fetch\("\/api\/database-domain\?domain=inventario"/);
  assert.match(appJs, /Authorization: `Bearer \$\{supabaseSession\.access_token\}`/);
  assert.match(appJs, /loadInventoryDomainSlice\(remoteDatabase\)/);
  assert.match(appJs, /loadInventoryDomainSlice\(nextDatabase\)/);
});

test("la lectura de dominio es solo compatibilidad y conserva fallback ante error o divergencia", () => {
  assert.match(appJs, /se conserva el documento completo/);
  assert.match(appJs, /se usa el documento completo/);
  assert.match(appJs, /canonicalDomainValue\(payload\.data\) !== canonicalDomainValue\(expected\)/);
  assert.doesNotMatch(appJs, /fetch\("\/api\/database-domain\?domain=inventario"[\s\S]{0,500}method:\s*"PUT"/);
});
