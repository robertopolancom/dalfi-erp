// El detalle de la reserva en el ERP (outputs/app.js) debe avisar con claridad cuando el
// comprobante ya se purgo (ver purgeExpiredDepositReceipts en server/store.mjs y
// workers/deposit-receipt-purge-cron/), en vez de intentar pintar una <img> rota. Igual que otros
// tests de este archivo, es una prueba de caracterizacion por texto fuente.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readApp() {
  return readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
}

test("loadDepositReviewArea() avisa cuando la foto ya se purgo, antes de intentar pintar la imagen", async () => {
  const app = await readApp();
  const fn = /async function loadDepositReviewArea\(reservationId\) \{[\s\S]*?\n\}/.exec(app)?.[0];
  assert.ok(fn, "no se encontro loadDepositReviewArea()");
  assert.match(fn, /if \(!receipt\.image_data\) \{/);
  assert.match(fn, /se elimin.{1,3} autom.ticamente 5 d.as despu.s/i);
  // El chequeo de "ya se purgo" debe venir ANTES de construir el <img src="data:...">.
  const purgeCheckIndex = fn.indexOf("if (!receipt.image_data)");
  const imgIndex = fn.indexOf('<img class="deposit-receipt-image"');
  assert.ok(purgeCheckIndex > -1 && imgIndex > -1 && purgeCheckIndex < imgIndex);
});
