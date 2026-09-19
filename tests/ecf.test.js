// Módulo e-CF (2026-09-18): de la factura del ERP al documento neutral, el QR de la DGII, la capa
// de PSFE con adaptadores y la representación impresa. Lo que protegen estas pruebas:
//   - Reglas fiscales de Dalfi: servicios exentos; productos con ITBIS 18 % incluido; sin propina.
//   - Los totales cuadran con la suma de líneas (así los valida la DGII).
//   - Nunca se manda a un PSFE real un documento sin RNC del emisor.
//   - Una vista de prueba nunca puede confundirse con un comprobante válido.

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { rncValido, cedulaValida, validarIdentificacionFiscal } from "../server/ecf/identificacion.mjs";
import { documentoDesdeFactura, emisorDesdeEntorno, INDICADOR } from "../server/ecf/documento.mjs";
import { urlConsultaDGII, qrSvg } from "../server/ecf/consulta-qr.mjs";
import { crearServicioECF, adaptadorSimulado } from "../server/ecf/servicio.mjs";
import { renderRepresentacionImpresa } from "../server/ecf/representacion.mjs";
import { createApp } from "../server/app.mjs";
import { invoiceToken } from "../server/invoice-link.mjs";

// Números construidos con el propio algoritmo (dígito verificador correcto), no de personas reales.
function conVerificadorRNC(ocho) {
  const pesos = [7, 9, 8, 6, 5, 4, 3, 2];
  const resto = pesos.reduce((a, p, i) => a + p * Number(ocho[i]), 0) % 11;
  return ocho + String(resto === 0 ? 2 : resto === 1 ? 1 : 11 - resto);
}
function conVerificadorCedula(diez) {
  let suma = 0;
  for (let i = 0; i < 10; i += 1) { let p = Number(diez[i]) * (i % 2 === 0 ? 1 : 2); if (p > 9) p -= 9; suma += p; }
  return diez + String((10 - (suma % 10)) % 10);
}
const RNC_OK = conVerificadorRNC("13123456");
const CEDULA_OK = conVerificadorCedula("0011234567");

const FACTURA = {
  data: {
    facturas: [
      { facturaID: "FAC-1", fechaOperacion: "2026-09-18", clienteNombre: "Ana Pérez", totalFacturado: 2300, propinaCobrada: 200 },
      { facturaID: "FAC-2", fechaOperacion: "2026-09-18", clienteNombre: "Ana Pérez", tipoComprobante: "31", compradorRNC: RNC_OK, compradorRazonSocial: "Pérez SRL" },
    ],
    facturaDetalle: [
      { facturaID: "FAC-1", servicio: "Manicura en gel", cantidad: 1, precioBase: 1500, subtotal: 1500 },
      { facturaID: "FAC-1", servicio: "Esmalte", cantidad: 1, precioBase: 800, subtotal: 800, gravado: true },
      { facturaID: "FAC-2", servicio: "Pedicura", cantidad: 1, precioBase: 1000, subtotal: 1000 },
    ],
    pagosFactura: [
      { facturaID: "FAC-1", metodoPago: "Efectivo", montoBruto: 1000, estadoPago: "Confirmado" },
      { facturaID: "FAC-1", metodoPago: "Tarjeta de crédito", montoBruto: 500, estadoPago: "Confirmado" },
      { facturaID: "FAC-2", metodoPago: "Transferencia", montoBruto: 1400, estadoPago: "Confirmado" },
    ],
  },
};
const EMISOR_PRUEBA = emisorDesdeEntorno({});
const EMISOR_REAL = emisorDesdeEntorno({ ECF_EMISOR_RNC: RNC_OK, ECF_EMISOR_RAZON_SOCIAL: "Dalfi Studio Nails EIRL" });

test("ECF01 — RNC y cédula: dígito verificador", () => {
  assert.equal(rncValido(RNC_OK), true);
  assert.equal(rncValido(RNC_OK.slice(0, 8) + ((Number(RNC_OK[8]) + 1) % 10)), false);
  assert.equal(cedulaValida(CEDULA_OK), true);
  assert.equal(cedulaValida(CEDULA_OK.slice(0, 10) + ((Number(CEDULA_OK[10]) + 1) % 10)), false);
  assert.deepEqual(validarIdentificacionFiscal(`${CEDULA_OK.slice(0, 3)}-${CEDULA_OK.slice(3, 10)}-${CEDULA_OK[10]}`), { ok: true, tipo: "Cedula", numero: CEDULA_OK });
  assert.equal(validarIdentificacionFiscal("123").ok, false);
});

test("ECF02 — servicios exentos, producto con ITBIS incluido, y los totales cuadran con las líneas", () => {
  const doc = documentoDesdeFactura(FACTURA, "FAC-1", { emisor: EMISOR_PRUEBA });
  assert.equal(doc.tipo, "32");
  assert.equal(doc.lineas[0].indicadorFacturacion, INDICADOR.EXENTO);
  assert.equal(doc.lineas[0].itbis, 0);
  assert.equal(doc.lineas[1].indicadorFacturacion, INDICADOR.ITBIS_18);
  assert.equal(doc.lineas[1].itbis, 122.03, "800 con ITBIS incluido: base 677,97 + ITBIS 122,03");
  assert.deepEqual(doc.totales, { montoGravado: 677.97, totalItbis: 122.03, montoExento: 1500, montoTotal: 2300 });
  assert.equal(doc.totales.montoTotal, doc.lineas.reduce((s, l) => s + l.montoItem, 0), "el total es la suma de líneas");
});

test("ECF03 — la propina no entra al e-CF; lo no cobrado se declara venta a crédito", () => {
  const doc = documentoDesdeFactura(FACTURA, "FAC-1", { emisor: EMISOR_PRUEBA });
  assert.equal(doc.totales.montoTotal, 2300, "la factura tenía 200 de propina: fuera");
  assert.deepEqual(doc.formasPago, [{ codigo: 1, monto: 1000 }, { codigo: 3, monto: 500 }, { codigo: 4, monto: 800 }]);
});

test("ECF04 — crédito fiscal con RNC del comprador; un cobro de más se recorta al total", () => {
  const doc = documentoDesdeFactura(FACTURA, "FAC-2", { emisor: EMISOR_REAL });
  assert.equal(doc.tipo, "31");
  assert.equal(doc.tipoNombre, "Factura de Crédito Fiscal Electrónica");
  assert.deepEqual(doc.comprador, { rnc: RNC_OK, razonSocial: "Pérez SRL" });
  assert.deepEqual(doc.formasPago, [{ codigo: 2, monto: 1000 }], "cobró 1.400 (abonos a deudas viejas): el e-CF declara 1.000");
});

test("ECF05 — URL de consulta: consumo menor de RD$250.000 usa la resumida; lo demás, la completa", () => {
  const consumo = { ...documentoDesdeFactura(FACTURA, "FAC-1", { emisor: EMISOR_REAL }), encf: "E320000000001", codigoSeguridad: "AbC123" };
  const u1 = new URL(urlConsultaDGII(consumo, { ambiente: "produccion" }));
  assert.equal(u1.hostname, "fc.dgii.gov.do");
  assert.deepEqual([...u1.searchParams.keys()], ["RncEmisor", "ENCF", "MontoTotal", "CodigoSeguridad"]);
  assert.equal(u1.searchParams.get("MontoTotal"), "2300.00");
  const credito = { ...documentoDesdeFactura(FACTURA, "FAC-2", { emisor: EMISOR_REAL }), encf: "E310000000001", codigoSeguridad: "AbC123", fechaFirma: "2026-09-18T19:30:00Z" };
  const u2 = new URL(urlConsultaDGII(credito, { ambiente: "prueba" }));
  assert.equal(u2.hostname, "ecf.dgii.gov.do");
  assert.match(u2.pathname, /^\/testecf\//, "el ambiente de pruebas no apunta a producción");
  assert.equal(u2.searchParams.get("RncComprador"), RNC_OK);
  assert.equal(u2.searchParams.get("FechaEmision"), "18-09-2026");
  assert.equal(u2.searchParams.get("FechaFirma"), "18-09-2026 15:30:00", "hora de RD");
});

test("ECF06 — QR: versión 8 cuando cabe, la siguiente que alcance cuando no, y SVG sin nada externo", () => {
  const corto = qrSvg("https://fc.dgii.gov.do/ecf/ConsultaTimbreFC?RncEmisor=131234567&ENCF=E320000000001&MontoTotal=1500.00&CodigoSeguridad=AbC123");
  assert.equal(corto.version, 8);
  assert.equal(corto.modulos, 49);
  const largo = qrSvg("https://ecf.dgii.gov.do/ecf/ConsultaTimbre?RncEmisor=131234567&RncComprador=131234567&ENCF=E310000000001&FechaEmision=18-09-2026&MontoTotal=1500.00&FechaFirma=18-09-2026+15%3A30%3A00&CodigoSeguridad=AbC123");
  assert.ok(largo.version > 8);
  assert.doesNotMatch(corto.svg, /https?:\/\/(?!www\.w3\.org)/, "ni imágenes ni scripts de fuera");
});

test("ECF07 — PSFE: el simulado emite con formato de e-NCF; uno real nunca recibe un documento sin RNC", async () => {
  const sim = crearServicioECF({ env: {} });
  const doc = documentoDesdeFactura(FACTURA, "FAC-1", { emisor: EMISOR_PRUEBA });
  const r = await sim.emitir(doc);
  assert.match(r.encf, /^E32\d{10}$/);
  assert.match(r.codigoSeguridad, /^[A-Za-z0-9]{6}$/);
  assert.equal(r.simulado, true);
  let llamado = false;
  const real = crearServicioECF({ env: { ECF_PSFE: "otro" }, adaptadores: { otro: () => ({ emitir: async () => { llamado = true; return {}; } }) } });
  await assert.rejects(real.emitir(doc), /no tiene RNC/);
  assert.equal(llamado, false);
  assert.throws(() => crearServicioECF({ env: { ECF_PSFE: "inexistente" } }), /No hay adaptador/);
});

test("ECF08 — representación impresa: QR abajo a la izquierda, código de seguridad debajo, y aviso de prueba", async () => {
  const doc = documentoDesdeFactura(FACTURA, "FAC-1", { emisor: EMISOR_PRUEBA });
  Object.assign(doc, await adaptadorSimulado().emitir(doc));
  const html = renderRepresentacionImpresa(doc, { ambiente: "prueba" });
  assert.match(html, /VISTA DE PRUEBA — NO VÁLIDA COMO COMPROBANTE FISCAL/);
  assert.match(html, /\.qr svg\{display:block;width:25mm;height:25mm\}/, "al menos 22 mm");
  const pie = html.slice(html.indexOf('<div class="pie">'));
  assert.ok(pie.indexOf('class="qr"') < pie.indexOf('class="totales"'), "el QR va primero (izquierda)");
  assert.ok(pie.indexOf("<svg") < pie.indexOf("Código de seguridad"), "el código va debajo del QR");
  assert.match(html, new RegExp(doc.codigoSeguridad));
  assert.match(html, /Consumidor final/);
  assert.match(html, /RNC: pendiente de constitución/);
});

test("ECF09 — /factura/:token?vista=fiscal muestra la hoja DGII; la vista normal del cliente no cambia", async () => {
  const env = { INVOICE_LINK_SECRET: "secreto-prueba" };
  const app = createApp({ store: { async read() { return { data: FACTURA, updatedAt: "2026-09-18T00:00:00Z", version: 1 }; } }, env });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}/factura/${invoiceToken(env, "FAC-1")}`;
    const fiscal = await (await fetch(`${base}?vista=fiscal`)).text();
    assert.match(fiscal, /Factura de Consumo Electrónica/);
    assert.match(fiscal, /e-NCF: E32\d{10}/);
    assert.match(fiscal, /VISTA DE PRUEBA/);
    const normal = await (await fetch(base)).text();
    assert.doesNotMatch(normal, /e-NCF|VISTA DE PRUEBA/);
  } finally { server.close(); await once(server, "close"); }
});

test("ECF10 — el formulario de factura del ERP guarda el comprobante fiscal y valida el RNC antes de cobrar", async () => {
  const app = await readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../outputs/index.html", import.meta.url), "utf8");
  assert.match(html, /<select id="invoice-fiscal-type">/);
  assert.match(html, /id="invoice-buyer-rnc"/);
  assert.match(app, /\.\.\.datosFiscalesFactura\(\),/, "al crear");
  assert.match(app, /Object\.assign\(invoice, datosFiscalesFactura\(\)\);/, "al editar");
  assert.match(app, /cargarDatosFiscalesFactura\(invoice\);/, "al abrir para editar");
  const submit = app.indexOf("const fiscal = datosFiscalesFactura();");
  assert.ok(submit > 0 && submit < app.indexOf("Agrega por lo menos un servicio con su colaboradora antes de continuar al cobro."), "se valida antes de cobrar");
});
