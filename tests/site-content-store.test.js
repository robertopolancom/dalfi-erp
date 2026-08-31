import assert from "node:assert/strict";
import test from "node:test";
import { NeonBookingStore } from "../server/store.mjs";

function fakePool({ existingRow = null } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("select site_key, content, updated_at, updated_by from app.site_content")) {
        return { rows: existingRow ? [existingRow] : [] };
      }
      if (sql.includes("insert into app.site_content")) {
        const [siteKey, content, updatedBy] = params;
        return { rows: [{ site_key: siteKey, content, updated_at: "now", updated_by: updatedBy }] };
      }
      throw new Error(`Consulta no simulada: ${sql}`);
    },
  };
}

test("getSiteContent(): devuelve null si no hay fila", async () => {
  const store = new NeonBookingStore(fakePool());
  assert.equal(await store.getSiteContent("dalfistudionails"), null);
});

test("getSiteContent(): devuelve la fila cuando existe", async () => {
  const row = { site_key: "dalfistudionails", content: { hero: {} }, updated_at: "x", updated_by: "y" };
  const store = new NeonBookingStore(fakePool({ existingRow: row }));
  assert.deepEqual(await store.getSiteContent("dalfistudionails"), row);
});

test("saveSiteContent(): hace upsert con los parámetros correctos", async () => {
  const pool = fakePool();
  const store = new NeonBookingStore(pool);
  const content = { hero: { kicker: "Baní" } };
  const saved = await store.saveSiteContent("dalfistudionails", content, "admin@ejemplo.test");
  assert.deepEqual(saved.content, content);
  assert.equal(saved.updated_by, "admin@ejemplo.test");
  const insertQuery = pool.queries.find((q) => q.sql.includes("insert into app.site_content"));
  assert.deepEqual(insertQuery.params, ["dalfistudionails", content, "admin@ejemplo.test"]);
});
