// El enlace del adjunto se abre SIN sesion, a proposito.
//
// La primera version exigia sesion del ERP y no funcionaba: una etiqueta <img> del navegador
// hace una peticion normal y no manda cabeceras, asi que la foto nunca cargaba -- se veia el
// error, no la imagen. Y el personal necesita poder reenviar el enlace.
//
// Lo que sustituye a la sesion es la firma: nadie puede fabricar un enlace para el adjunto de
// otra persona ni cambiar un id en la URL.

import assert from "node:assert/strict";
import test from "node:test";
import { mediaToken, mediaUrl, verifyMediaToken } from "../server/media-link.mjs";
import { invoiceToken, verifyInvoiceToken } from "../server/invoice-link.mjs";

const ENV = { INVOICE_LINK_SECRET: "secreto-de-prueba-largo-y-aleatorio" };
const ID = "11111111-2222-3333-4444-555555555555";

test("un enlace firmado vuelve a dar el mismo mensaje", () => {
  const t = mediaToken(ENV, ID);
  assert.equal(verifyMediaToken(ENV, t), ID);
  assert.equal(mediaUrl(ENV, ID), `/chat/media/${t}`);
});

test("cambiar un solo caracter invalida el enlace", () => {
  // Es lo que impide pedir el adjunto de otra persona editando la URL.
  const t = mediaToken(ENV, ID);
  const roto = t.slice(0, -1) + (t.at(-1) === "a" ? "b" : "a");
  assert.equal(verifyMediaToken(ENV, roto), null);
});

test("sin el secreto correcto no vale", () => {
  const t = mediaToken(ENV, ID);
  assert.equal(verifyMediaToken({ INVOICE_LINK_SECRET: "otro-secreto-distinto" }, t), null);
});

test("un token de factura NO sirve como token de adjunto", () => {
  // Los dos usan el mismo secreto. Sin el prefijo "media:" dentro de lo firmado, una firma
  // valdria para las dos puertas y quien tuviera un enlace de factura podria pedir adjuntos.
  const deFactura = invoiceToken(ENV, ID);
  assert.equal(verifyMediaToken(ENV, deFactura), null);
  const deAdjunto = mediaToken(ENV, ID);
  assert.notEqual(verifyInvoiceToken(ENV, deAdjunto), ID);
});

test("sin secreto configurado no se emite enlace", () => {
  // Mejor no ofrecer la foto que ofrecer una puerta que cualquiera pueda falsificar.
  assert.equal(mediaToken({}, ID), null);
  assert.equal(mediaUrl({}, ID), null);
});

test("solo se aceptan identificadores con forma de uuid", () => {
  // Defensa en profundidad: aunque la firma ya impide fabricarlos, no se lleva a la consulta
  // cualquier cosa que venga dentro del token.
  assert.equal(verifyMediaToken(ENV, mediaToken(ENV, "no-es-un-uuid")), null);
});

test("los enlaces de factura siguen funcionando igual que antes", () => {
  // La firma se movio a signed-links.mjs, compartida. Si el formato hubiera cambiado, las
  // facturas ya enviadas a clientes dejarian de abrir.
  const t = invoiceToken(ENV, "FAC-2026-0001");
  assert.equal(verifyInvoiceToken(ENV, t), "FAC-2026-0001");
});
