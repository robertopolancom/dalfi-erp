// Las imágenes que suben clientes y personal tienen que ser imágenes de verdad (2026-09-18: antes
// solo se miraba el tipo que declaraba el navegador y el contenido se pegaba en el ERP con innerHTML).

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validarImagenBase64 } from "../server/imagen-segura.mjs";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]).toString("base64");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]).toString("base64");
const MB = 1024 * 1024;

test("IS01 — JPEG, PNG y WebP reales pasan", () => {
  assert.equal(validarImagenBase64(JPEG, "image/jpeg", { maxBytes: MB }).ok, true);
  assert.equal(validarImagenBase64(PNG, "image/png", { maxBytes: MB }).ok, true);
  assert.equal(validarImagenBase64(WEBP, "image/webp", { maxBytes: MB }).ok, true);
});

test("IS02 — texto con comillas en vez de base64 se rechaza (era la puerta a meter HTML en el ERP)", () => {
  const r = validarImagenBase64('x" /><a href="https://falso.test">Aprobar</a><img src="', "image/jpeg", { maxBytes: MB });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test("IS03 — el tipo declarado tiene que coincidir con los bytes", () => {
  assert.equal(validarImagenBase64(PNG, "image/jpeg", { maxBytes: MB }).ok, false, "un PNG declarado como JPEG");
  const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
  assert.equal(validarImagenBase64(html, "image/png", { maxBytes: MB }).ok, false, "un HTML disfrazado");
  assert.equal(validarImagenBase64(JPEG, "image/svg+xml", { maxBytes: MB }).ok, false, "SVG puede llevar scripts: fuera");
});

test("IS04 — el tamaño se mide en bytes reales", () => {
  const grande = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * MB)]).toString("base64");
  const r = validarImagenBase64(grande, "image/jpeg", { maxBytes: MB });
  assert.equal(r.status, 413);
});

test("IS05 — las dos subidas usan el validador y el ERP escapa el dato al pintarlo", async () => {
  const app = await readFile(new URL("../server/app.mjs", import.meta.url), "utf8");
  assert.equal((app.match(/validarImagenBase64\(imageBase64, mimeType/g) || []).length, 2, "comprobante de depósito y fotos del sitio");
  const erp = await readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(erp, /base64,\$\{receipt\.image_data\}/);
  assert.match(erp, /base64,\$\{escapeHtml\(receipt\.image_data\)\}/);
});
