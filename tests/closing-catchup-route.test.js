// El catch-up de cierres tiene que correr AUNQUE NADIE abra el ERP. Hasta el 2026-09-10 no
// era asi: ensureProvisionalClosings() (outputs/app.js) corre en el NAVEGADOR, la version
// servidor vivia en functions/api/run-closing-catchup.js -- una Pages Function que dejo de
// desplegarse cuando se borro dalfi-erp.pages.dev (2026-08-24) -- y el Worker que debia
// llamarla nunca se desplego. En los datos se ve el corte: el ultimo cierre firmado por el
// cron es del 2026-08-12; desde entonces los creaba el navegador de quien entrara.
//
// Estas pruebas cubren la ruta nueva (POST /api/run-closing-catchup) de punta a punta contra
// un servidor Express real, con un store falso en memoria.

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../server/app.mjs";

const SECRET = "secreto-de-prueba-inventado";

// Igual que tests/staff-spa-csp.test.js: el catch-all hace res.sendFile y necesita un
// staticDir real, si no el error-handler de Express se traga la respuesta.
const staticDir = mkdtempSync(path.join(tmpdir(), "closing-catchup-"));
writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>test</title>");

// Documento minimo: una cuenta de caja y una factura vieja en efectivo, para que haya un dia
// vencido que cerrar.
function documentoDePrueba() {
  return {
    schema: 1,
    meta: {},
    data: {
      cuentas: [{ cuentaID: "CTA-0001", nombreCuenta: "Caja registradora", tipoCuenta: "Efectivo", saldoActual: 0 }],
      facturas: [{ facturaID: "FAC-1", fechaHora: "2026-09-01T14:00:00", total: 1000, metodoPago: "Efectivo", estado: "Pagada" }],
      cierres: [],
      ingresos: [], egresos: [], transferencias: [], propinas: [], cuentasCobrar: [], colaboradores: [],
    },
  };
}

function fakeStore(document) {
  let updatedAt = "2026-09-10T00:00:00.000Z";
  let version = 1;
  const saves = [];
  return {
    saves,
    get document() { return document; },
    async read() { return { data: document, updatedAt, version }; },
    async save({ document: doc, expectedUpdatedAt, identity, changes }) {
      saves.push({ identity, changes });
      if (expectedUpdatedAt !== updatedAt) return { conflict: true, updatedAt };
      document = doc;
      updatedAt = new Date(Date.parse(updatedAt) + 1000).toISOString();
      version += 1;
      return { saved: true, updatedAt, version, previousDocument: doc };
    },
  };
}

async function withServer(store, env, fn) {
  const app = createApp({
    store,
    bookingStore: { async catalog() { return { services: [], staff: [] }; } },
    env: { CLOSING_CRON_SECRET: SECRET, ...env },
    staticDir,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
}

const post = (base, headers = {}) => fetch(`${base}/api/run-closing-catchup`, { method: "POST", headers });

test("sin el secreto correcto no corre nada (401) y no toca el documento", async () => {
  const store = fakeStore(documentoDePrueba());
  await withServer(store, {}, async (base) => {
    for (const headers of [{}, { "x-cron-secret": "otro" }, { "x-cron-secret": SECRET + "x" }]) {
      const r = await post(base, headers);
      assert.equal(r.status, 401, `deberia rechazar con ${JSON.stringify(headers)}`);
    }
    assert.equal(store.saves.length, 0, "no debe intentar guardar sin credencial valida");
    assert.equal(store.document.data.cierres.length, 0);
  });
});

// Si la variable no esta puesta, la ruta se apaga sola: mejor 503 que quedar abierta.
test("sin CLOSING_CRON_SECRET configurado la ruta responde 503, no queda abierta", async () => {
  const store = fakeStore(documentoDePrueba());
  await withServer(store, { CLOSING_CRON_SECRET: "" }, async (base) => {
    const r = await post(base, { "x-cron-secret": SECRET });
    assert.equal(r.status, 503);
    assert.equal(store.saves.length, 0);
  });
});

test("con el secreto correcto crea los cierres del dia vencido y los guarda", async () => {
  const store = fakeStore(documentoDePrueba());
  await withServer(store, {}, async (base) => {
    const r = await post(base, { "x-cron-secret": SECRET });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.ok(body.created > 0, "deberia crear al menos un cierre");
    const cierres = store.document.data.cierres;
    assert.ok(cierres.length > 0);
    // Dos por dia: uno de caja y uno de tesoreria, nunca uno por cuenta.
    assert.ok(cierres.some((c) => c.closingType === "register"));
    assert.ok(cierres.some((c) => c.closingType === "treasury"));
    // El sello es el ultimo minuto del dia cerrado, no la hora en que corrio el cron.
    for (const c of cierres) assert.match(c.fechaHoraCierre, /T23:59:00$/);
    // Quedan pendientes de que una persona los confirme.
    for (const c of cierres) assert.equal(c.estado, "Pendiente de confirmacion");
  });
});

// Que el cron corra dos veces (reintento de Cloudflare, dos disparos) no puede duplicar cierres.
test("es idempotente: la segunda pasada no crea nada ni vuelve a guardar", async () => {
  const store = fakeStore(documentoDePrueba());
  await withServer(store, {}, async (base) => {
    const primera = await (await post(base, { "x-cron-secret": SECRET })).json();
    const cuantos = store.document.data.cierres.length;
    const guardadosTrasPrimera = store.saves.length;

    const segunda = await (await post(base, { "x-cron-secret": SECRET })).json();
    assert.equal(segunda.created, 0);
    assert.equal(segunda.normalized, 0);
    assert.equal(store.document.data.cierres.length, cuantos, "no debe duplicar cierres");
    assert.equal(store.saves.length, guardadosTrasPrimera, "sin cambios no debe ni intentar guardar");
    assert.ok(primera.created > 0);
  });
});

// El cron no es una persona: queda en el audit log como sistema, no como el ultimo usuario.
test("el guardado queda firmado como cron, no como una usuaria del ERP", async () => {
  const store = fakeStore(documentoDePrueba());
  await withServer(store, {}, async (base) => {
    await post(base, { "x-cron-secret": SECRET });
    assert.equal(store.saves.length, 1);
    assert.deepEqual(store.saves[0].identity, { userId: null, email: "cron:closing-catchup", role: "system" });
    assert.deepEqual(store.saves[0].changes.tables, ["cierres"]);
  });
});
