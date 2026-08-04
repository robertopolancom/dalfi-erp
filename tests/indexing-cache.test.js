import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("la estrategia de cache solo versiona recursos estáticos y no APIs", () => {
  const headers = fs.readFileSync(path.join(root, "outputs", "_headers"), "utf8");
  assert.match(headers, /\/app\.js[\s\S]*max-age=31536000/);
  assert.match(headers, /\/styles\.css[\s\S]*stale-while-revalidate/);
  assert.match(headers, /\/api\/\*[\s\S]*Cache-Control: no-store/);
});

test("el slice de inventario reutiliza la versión remota sin repetir la consulta mientras updatedAt no cambie", () => {
  const app = fs.readFileSync(path.join(root, "outputs", "app.js"), "utf8");
  assert.match(app, /inventoryDomainSliceCache\?\.updatedAt === cacheKey/);
  assert.match(app, /inventoryDomainSliceCache = \{ updatedAt: cacheKey, data: structuredClone\(payload\.data\) \}/);
  assert.match(app, /inventoryDomainSliceCache = null;/);
});

test("los reportes se encolan en segundo plano y liberan el botón mientras se procesan", () => {
  const app = fs.readFileSync(path.join(root, "outputs", "app.js"), "utf8");
  assert.match(app, /function enqueueBackgroundTask\(label, task\)/);
  assert.match(app, /window\.setTimeout\(async \(\) =>/);
  assert.match(app, /enqueueBackgroundTask\(`reporte:\$\{reportType\}`/);
  assert.match(app, /Reporte en segundo plano/);
});

test("la migración elimina índice redundante y agrega índices de auditoría", () => {
  const migration = fs.readFileSync(
    path.join(root, "supabase", "migrations", "20260803000000_optimize_indexes_and_cache.sql"),
    "utf8",
  );
  assert.match(migration, /drop index if exists public\.erp_records_table_name_idx/i);
  assert.match(migration, /erp_audit_log_action_created_at_idx/);
  assert.match(migration, /erp_audit_log_user_created_at_idx/);
});
