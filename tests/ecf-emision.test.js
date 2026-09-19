// Fase C del e-CF: emisión con secuencia propia, reintentos cuando el PSFE falla, nota de crédito
// para anular, la cola del cron, y el bloqueo de anular en el ERP sin nota de crédito.

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { crearEmisionECF } from "../server/ecf/emision.mjs";
import { documentoDesdeVentaDirecta, emisorDesdeEntorno, notaDeCreditoTotal, documentoDesdeFactura } from "../server/ecf/documento.mjs";
import { adaptadorSimulado } from "../server/ecf/servicio.mjs";
import { createApp } from "../server/app.mjs";

function conVerificadorRNC(ocho) {
  const pesos = [7, 9, 8, 6, 5, 4, 3, 2];
  const resto = pesos.reduce((a, p, i) => a + p * Number(ocho[i]), 0) % 11;
  return ocho + String(resto === 0 ? 2 : resto === 1 ? 1 : 11 - resto);
}
const RNC = conVerificadorRNC("13123456");
const ENV_REAL = { ECF_EMISOR_RNC: RNC, ECF_PSFE: "simulado" };

const ERP = {
  facturas: [{ facturaID: "FAC-1", fechaOperacion: "2026-09-18", clienteNombre: "Ana" }],
  facturaDetalle: [{ facturaID: "FAC-1", servicio: "Manicura", cantidad: 1, precioBase: 1500, subtotal: 1500 }],
  pagosFactura: [{ facturaID: "FAC-1", metodoPago: "Efectivo", montoBruto: 1500 }, { facturaID: "VTA-1", metodoPago: "Tarjeta", montoBruto: 450 }],
  ventasDirectas: [{ saleId: "VTL-1", retailSaleId: "VTA-1", itemNombre: "Aceite de cutícula", cantidad: 1, precioUnitario: 450, total: 450, taxAmount: 68.64, taxCategory: "gravado", fecha: "2026-09-18", estado: "Confirmada" }],
};

// Base en memoria con el mismo contrato que NeonBookingStore (ecfCrear / ecfPorOrigen /
// ecfActualizar / ecfPendientes), incluida la secuencia atómica y el e-NCF único.
function storeEnMemoria({ secuencias = { "31": [1, 100], "32": [1, 100], "34": [1, 100] } } = {}) {
  const filas = [];
  const sec = Object.fromEntries(Object.entries(secuencias).map(([t, [s, h]]) => [t, { siguiente: s, hasta: h }]));
  return {
    filas,
    async ecfCrear({ origen, origenId, tipo, proveedor, documento, referenciaEncf = null }) {
      const s = sec[tipo];
      if (!s || s.siguiente > s.hasta) throw Object.assign(new Error(`No hay secuencia de e-NCF vigente para el tipo ${tipo}.`), { code: "ECF_SIN_SECUENCIA" });
      const encf = `E${tipo}${String(s.siguiente).padStart(10, "0")}`;
      s.siguiente += 1;
      const fila = { id: `id-${filas.length + 1}`, origen, origen_id: String(origenId), tipo, encf, proveedor, estado: "pendiente", documento: { ...documento, encf }, referencia_encf: referenciaEncf, intentos: 0, proximo_intento: new Date(0).toISOString() };
      filas.push(fila);
      return { ...fila };
    },
    async ecfPorOrigen(origen, origenId) {
      const propios = filas.filter((f) => f.origen === origen && f.origen_id === String(origenId));
      const encfs = new Set(propios.map((f) => f.encf));
      return filas.filter((f) => propios.includes(f) || (f.origen === "nota_credito" && encfs.has(f.referencia_encf))).map((f) => ({ ...f }));
    },
    async ecfActualizar(id, c) {
      const f = filas.find((x) => x.id === id);
      if (c.estado) f.estado = c.estado;
      if (c.trackId) f.track_id = c.trackId;
      if (c.codigoSeguridad) f.codigo_seguridad = c.codigoSeguridad;
      if (c.fechaFirma) f.fecha_firma = c.fechaFirma;
      if (c.documento) f.documento = c.documento;
      if (c.proximoIntento) f.proximo_intento = c.proximoIntento;
      f.ultimo_error = c.error || null;
      if (c.sumarIntento) f.intentos += 1;
      return { ...f };
    },
    async ecfPendientes() {
      return filas.filter((f) => ["pendiente", "en_proceso", "error"].includes(f.estado) && new Date(f.proximo_intento) <= new Date()).map((f) => ({ ...f }));
    },
  };
}

const emision = (store, extra = {}) => crearEmisionECF({ env: ENV_REAL, store, leerDocumentoERP: async () => ERP, ...extra });

test("EM01 — sin RNC del emisor no se emite ni se escribe nada", async () => {
  const store = storeEnMemoria();
  const e = crearEmisionECF({ env: {}, store, leerDocumentoERP: async () => ERP });
  await assert.rejects(e.emitir("factura", "FAC-1"), (err) => err.code === "ECF_SIN_EMISOR" && err.status === 409);
  assert.deepEqual(await e.procesarCola(), { procesados: 0, omitido: "sin_emisor" });
  assert.equal(store.filas.length, 0);
});

test("EM02 — emite con NUESTRA secuencia, guarda el resultado y es idempotente", async () => {
  const store = storeEnMemoria();
  const e = emision(store);
  const r = await e.emitir("factura", "FAC-1");
  assert.equal(r.encf, "E320000000001");
  assert.equal(r.estado, "aceptado");
  assert.match(r.codigo_seguridad, /^[A-Za-z0-9]{6}$/);
  const otra = await e.emitir("factura", "FAC-1");
  assert.equal(otra.encf, "E320000000001", "no se emite dos veces la misma factura");
  assert.equal(store.filas.length, 1);
});

test("EM03 — si el PSFE falla, queda en error con reintento y la cola lo termina", async () => {
  const store = storeEnMemoria();
  let caido = true;
  const adaptadores = { simulado: () => { const real = adaptadorSimulado(); return { ...real, emitir: async (d) => { if (caido) throw new Error("PSFE caído"); return real.emitir(d); } }; } };
  let t = Date.now();
  const e = emision(store, { adaptadores, ahora: () => t });
  const r = await e.emitir("factura", "FAC-1");
  assert.equal(r.estado, "error");
  assert.match(r.ultimo_error, /PSFE caído/);
  assert.ok(new Date(r.proximo_intento).getTime() > t, "se reintenta más tarde, no al instante");
  caido = false;
  store.filas[0].proximo_intento = new Date(0).toISOString();
  assert.deepEqual(await e.procesarCola(), { procesados: 1 });
  assert.equal(store.filas[0].estado, "aceptado");
  assert.equal(store.filas[0].encf, "E320000000001", "el reintento conserva el mismo e-NCF");
});

test("EM04 — sin secuencia autorizada no se inventa un e-NCF", async () => {
  const e = emision(storeEnMemoria({ secuencias: {} }));
  await assert.rejects(e.emitir("factura", "FAC-1"), /secuencia/);
});

test("EM05 — nota de crédito: solo sobre un e-CF aceptado, referencia al original, y una sola", async () => {
  const store = storeEnMemoria();
  const e = emision(store);
  await assert.rejects(e.notaDeCredito("factura", "FAC-1", { motivo: "Error" }), (err) => err.code === "ECF_SIN_ORIGINAL");
  await e.emitir("factura", "FAC-1");
  const nota = await e.notaDeCredito("factura", "FAC-1", { motivo: "Servicio no realizado" });
  assert.equal(nota.tipo, "34");
  assert.equal(nota.encf, "E340000000001");
  assert.equal(nota.referencia_encf, "E320000000001");
  assert.equal(nota.documento.referencia.razon, "Servicio no realizado");
  const otra = await e.notaDeCredito("factura", "FAC-1", { motivo: "Otra vez" });
  assert.equal(otra.encf, nota.encf, "no se anula dos veces");
});

test("EM06 — venta directa de productos: respeta la base e ITBIS que ya calculó el ERP", () => {
  const doc = documentoDesdeVentaDirecta(ERP, "VTA-1", { emisor: emisorDesdeEntorno(ENV_REAL) });
  assert.equal(doc.origen, "venta");
  assert.equal(doc.lineas[0].itbis, 68.64);
  assert.deepEqual(doc.totales, { montoGravado: 381.36, totalItbis: 68.64, montoExento: 0, montoTotal: 450 });
  assert.deepEqual(doc.formasPago, [{ codigo: 3, monto: 450 }]);
  const nota = notaDeCreditoTotal({ ...documentoDesdeFactura(ERP, "FAC-1", { emisor: emisorDesdeEntorno(ENV_REAL) }), encf: "E320000000009" }, { motivo: "x", fecha: "2026-09-19" });
  assert.equal(nota.referencia.encf, "E320000000009");
  assert.equal(nota.referencia.codigoModificacion, 1);
});

async function conServidor(env, bookingStore, run) {
  let documento = { data: structuredClone(ERP) };
  const store = {
    async read() { return { data: documento, updatedAt: "2026-09-18T00:00:00.000Z", version: 1 }; },
    async save({ document }) { documento = document; return { updatedAt: "2026-09-18T00:00:01.000Z", previousDocument: {} }; },
  };
  const app = createApp({ store, bookingStore, env, fetchImpl: async () => new Response("{}", { status: 200 }) });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`, () => documento); }
  finally { server.close(); await once(server, "close"); }
}

test("EM07 — /api/ecf/procesar-cola exige el secreto del cron; sin RNC responde sin tocar nada", async () => {
  await conServidor({ BOOKING_REMINDER_CRON_SECRET: "cron-prueba" }, storeEnMemoria(), async (base) => {
    assert.equal((await fetch(`${base}/api/ecf/procesar-cola`, { method: "POST" })).status, 401);
    const r = await fetch(`${base}/api/ecf/procesar-cola`, { method: "POST", headers: { "x-cron-secret": "cron-prueba" } });
    assert.deepEqual(await r.json(), { procesados: 0, omitido: "sin_emisor" });
  });
});

test("EM08 — emitir por la API sin sesión del personal: rechazado", async () => {
  await conServidor({ ...ENV_REAL, SUPABASE_URL: "https://x.supabase.co", SUPABASE_PUBLISHABLE_KEY: "t" }, storeEnMemoria(), async (base) => {
    const r = await fetch(`${base}/api/ecf/factura/FAC-1/emitir`, { method: "POST" });
    assert.ok([401, 403].includes(r.status), `respondió ${r.status}`);
  });
});

test("EM09 — la factura con e-CF aceptado se muestra con formato DGII y sin aviso de prueba de datos reales", async () => {
  const store = storeEnMemoria();
  await emision(store, { adaptadores: { simulado: () => ({ ...adaptadorSimulado() }) } }).emitir("factura", "FAC-1");
  store.filas[0].proveedor = "otro"; // como si lo hubiera emitido un PSFE real
  const env = { ...ENV_REAL, INVOICE_LINK_SECRET: "s" };
  const { invoiceToken } = await import("../server/invoice-link.mjs");
  await conServidor(env, store, async (base) => {
    const html = await (await fetch(`${base}/factura/${invoiceToken(env, "FAC-1")}`)).text();
    assert.match(html, /e-NCF: E320000000001/);
    assert.doesNotMatch(html, /VISTA DE PRUEBA/);
  });
});

test("EM10 — el servidor no deja anular una factura con e-CF aceptado sin nota de crédito", async () => {
  const fuente = await readFile(new URL("../server/app.mjs", import.meta.url), "utf8");
  const put = fuente.slice(fuente.indexOf('app.put("/api/database"'));
  assert.ok(put.indexOf("anulacionesSinNotaDeCredito") < put.indexOf("store.save("), "se comprueba antes de guardar");
  assert.match(fuente, /code: "ECF_REQUIERE_NOTA_CREDITO"/);
  const migracion = await readFile(new URL("../neon/migrations/0032_ecf_documentos.sql", import.meta.url), "utf8");
  assert.match(migracion, /encf text not null unique/);
  assert.match(migracion, /update|siguiente bigint not null/);
});
