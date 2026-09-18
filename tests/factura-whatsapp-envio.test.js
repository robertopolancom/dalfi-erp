// Mandar la factura por WhatsApp al terminar de facturar. Lo que se protege aquí:
//
//   1. Que salga de verdad. El botón del ERP llamaba a /api/booking/notify-invoice-sent, una
//      Cloudflare Pages Function que nunca se portó a Cloud Run: desde la migración devolvía 404 y
//      no se enviaba nada, sin que nadie se enterara.
//   2. Que un 200 del bridge NO se lea como enviado. El bridge contesta 200 con
//      { status: 'FAILED' | 'INVALID' } cuando no mandó nada; mirar solo response.ok es el error que
//      ya costó mensajes marcados como enviados que nunca salieron.
//   3. Que del enlace viaje el TOKEN y no la URL completa: la base está congelada en la plantilla
//      aprobada por Meta, así que es lo único que el botón puede llevar.
//   4. Que un fallo no tire la información útil: el enlace y el wa.me de respaldo siguen en la
//      respuesta para que alguien lo mande a mano.

import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { invoiceToken } from "../server/invoice-link.mjs";

const PERMISOS = { can_manage_reservations: true, can_manage_configuration: true };
const SECRETO = "shared-secret";
const ENV = {
  SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "k", SUPABASE_SERVICE_ROLE_KEY: "k",
  ERP_WEBHOOK_SECRET: SECRETO, CHATBOT_BRIDGE_URL: "https://bridge.test",
};

// Con la forma REAL del documento del ERP: las tablas cuelgan de .data, no de la raíz. Este
// fixture estaba plano y por eso estas mismas pruebas pasaban en verde mientras en producción el
// endpoint devolvía 404 para cualquier factura. Si alguien lo vuelve a aplanar, se pierde otra vez
// lo único que distingue esta prueba de la realidad.
const DOCUMENTO = { schema: [], meta: {}, data: {
  facturas: [{ facturaID: "FAC-1024", clienteID: "CLI-7", clienteNombre: "María Gómez", fechaOperacion: "2026-09-15", totalFacturado: 1500 }],
  facturaDetalle: [{ facturaID: "FAC-1024", servicio: "Manicure", cantidad: 1, precioBase: 1500, subtotal: 1500 }],
  clientes: [{ clienteID: "CLI-7", nombreCompleto: "María Gómez", telefono: "8095551234", email: "maria@ejemplo.test" }],
} };

async function conServidor(respuestaDelPuente, run, { env = ENV } = {}) {
  const llamadas = [];
  const fetchImpl = async (url, options) => {
    const u = String(url);
    if (u.includes("/auth/v1/user")) return new Response(JSON.stringify({ id: "user-1", email: "ana@dalfi.test" }), { status: 200 });
    if (u.includes("erp_user_profiles")) {
      return new Response(JSON.stringify([{ user_id: "user-1", email: "ana@dalfi.test", role: "administradora", is_active: true, ...PERMISOS }]), { status: 200 });
    }
    llamadas.push({ url: u, options, cuerpo: JSON.parse(options.body) });
    if (respuestaDelPuente instanceof Error) throw respuestaDelPuente;
    return respuestaDelPuente;
  };
  const app = createApp({
    store: { async read() { return { data: DOCUMENTO, updatedAt: "2026-09-15T00:00:00.000Z", version: 1 }; } },
    fetchImpl, env,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`, llamadas); }
  finally { server.close(); await once(server, "close"); }
}

const AUTH = { Authorization: "Bearer t", "Content-Type": "application/json" };

const enviar = (base, cuerpo = { channel: "whatsapp" }) =>
  fetch(`${base}/api/factura/FAC-1024/enviar`, { method: "POST", headers: AUTH, body: JSON.stringify(cuerpo) });

test("FW01 — el envío sale por el bridge con el secreto, el token del enlace y el total ya formateado", async () => {
  const ok = new Response(JSON.stringify({ status: "SENT", deliveryStatus: "SENT_AS_TEMPLATE" }), { status: 200 });
  await conServidor(ok, async (base, llamadas) => {
    const r = await enviar(base);
    assert.equal(r.status, 200);
    const payload = await r.json();
    assert.equal(payload.whatsapp.sent, true);

    assert.equal(llamadas.length, 1);
    assert.match(llamadas[0].url, /\/webhook\/invoice-ready$/);
    assert.equal(llamadas[0].options.headers["x-webhook-secret"], SECRETO);
    const cuerpo = llamadas[0].cuerpo;
    assert.equal(cuerpo.event, "invoice.ready");
    assert.equal(cuerpo.invoiceId, "FAC-1024");
    assert.equal(cuerpo.clientName, "María Gómez");
    assert.equal(cuerpo.total, "RD$ 1,500.00");
    assert.equal(cuerpo.invoiceToken, invoiceToken(ENV, "FAC-1024"));
    assert.ok(!String(cuerpo.invoiceToken).includes("http"), "solo el token: la base la fija la plantilla de Meta");
  });
});

test("FW02 — un 200 del bridge que NO dice SENT no se da por enviado", async () => {
  const falló = new Response(JSON.stringify({ status: "FAILED", error: "WhatsApp API (plantilla) devolvió 400." }), { status: 200 });
  await conServidor(falló, async (base) => {
    const r = await enviar(base);
    assert.equal(r.status, 200, "el endpoint no falla: el enlace sigue siendo útil");
    const payload = await r.json();
    assert.equal(payload.whatsapp.sent, false);
    assert.match(payload.whatsapp.reason, /400/);
    // Y lo que hace falta para mandarlo a mano sigue ahí.
    assert.match(payload.url, /\/factura\//);
    assert.match(payload.whatsappUrl, /^https:\/\/wa\.me\/18095551234\?text=/);
  });
});

test("FW03 — si el bridge no contesta, tampoco se da por enviado", async () => {
  await conServidor(new Error("fetch failed"), async (base) => {
    const payload = await (await enviar(base)).json();
    assert.equal(payload.whatsapp.sent, false);
    assert.match(payload.whatsapp.reason, /fetch failed/);
  });
});

test("FW04 — sin teléfono en la ficha no se intenta nada y se dice por qué", async () => {
  const ok = new Response(JSON.stringify({ status: "SENT" }), { status: 200 });
  const sinTelefono = { ...DOCUMENTO, data: { ...DOCUMENTO.data, clientes: [{ clienteID: "CLI-7", nombreCompleto: "María Gómez" }] } };
  const llamadas = [];
  const app = createApp({
    store: { async read() { return { data: sinTelefono, updatedAt: "2026-09-15T00:00:00.000Z", version: 1 }; } },
    env: ENV,
    fetchImpl: async (url, options) => {
      const u = String(url);
      if (u.includes("/auth/v1/user")) return new Response(JSON.stringify({ id: "user-1", email: "ana@dalfi.test" }), { status: 200 });
      if (u.includes("erp_user_profiles")) return new Response(JSON.stringify([{ user_id: "user-1", email: "ana@dalfi.test", role: "administradora", is_active: true, ...PERMISOS }]), { status: 200 });
      llamadas.push(u);
      return ok;
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const r = await enviar(`http://127.0.0.1:${server.address().port}`);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /tel/i);
    assert.equal(llamadas.length, 0);
  } finally { server.close(); await once(server, "close"); }
});

test("FW05 — el teléfono que escriba quien factura manda sobre el de la ficha", async () => {
  const ok = new Response(JSON.stringify({ status: "SENT" }), { status: 200 });
  await conServidor(ok, async (base, llamadas) => {
    await enviar(base, { channel: "whatsapp", phone: "829 667 9289" });
    assert.equal(llamadas[0].cuerpo.recipientPhone, "18296679289");
  });
});

test("FW06 — channel:'link' no manda WhatsApp ni correo, solo devuelve el enlace", async () => {
  const ok = new Response(JSON.stringify({ status: "SENT" }), { status: 200 });
  await conServidor(ok, async (base, llamadas) => {
    const payload = await (await enviar(base, { channel: "link" })).json();
    assert.equal(payload.whatsapp.reason, "not_requested");
    assert.equal(payload.email.reason, "not_requested");
    assert.match(payload.url, /\/factura\//);
    assert.equal(llamadas.length, 0);
  });
});

test("FW07 — sin ERP_WEBHOOK_SECRET se dice que falta configurar, no se inventa un éxito", async () => {
  const ok = new Response(JSON.stringify({ status: "SENT" }), { status: 200 });
  const { ERP_WEBHOOK_SECRET, ...sinSecreto } = ENV;
  await conServidor(ok, async (base, llamadas) => {
    const payload = await (await enviar(base)).json();
    assert.equal(payload.whatsapp.sent, false);
    assert.equal(payload.whatsapp.reason, "pending_configuration");
    assert.equal(llamadas.length, 0);
  }, { env: { ...sinSecreto, INVOICE_LINK_SECRET: "otro-secreto-para-los-enlaces" } });
});

test("FW08 — /resena redirige a Google y se puede cambiar sin tocar la plantilla de Meta", async () => {
  const app = createApp({
    store: { async read() { return { data: DOCUMENTO, updatedAt: "2026-09-15T00:00:00.000Z", version: 1 }; } },
    env: { ...ENV, GOOGLE_REVIEW_URL: "https://ejemplo.test/resena-nueva" },
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/resena`, { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "https://ejemplo.test/resena-nueva");
  } finally { server.close(); await once(server, "close"); }
});

test("FW09 — sin GOOGLE_REVIEW_URL usa el enlace real del negocio, el mismo de ReservApp", async () => {
  const app = createApp({
    store: { async read() { return { data: DOCUMENTO, updatedAt: "2026-09-15T00:00:00.000Z", version: 1 }; } },
    env: ENV, fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/resena`, { redirect: "manual" });
    assert.equal(r.status, 302);
    // El enlace OFICIAL de "pedir opiniones" del Perfil de Negocio. El que habia antes
    // (maps/place//data=...!12e1) aterrizaba en la ficha y dejaba al cliente buscando el boton
    // de escribir resena ella sola -- comprobado en produccion el 2026-09-17. Esa friccion es
    // justo la que hace que no la dejen, y una resena que no se escribe no se recupera.
    assert.match(r.headers.get("location"), /^https:\/\/g\.page\/r\/[A-Za-z0-9_-]+\/review$/);
  } finally { server.close(); await once(server, "close"); }
});

test("FW11 — TODO enlace de reseña que ve un cliente es dalfistudio.com/resena", async () => {
  // La regla: solo el servidor sabe la direccion real de Google. Lo que ve el cliente es
  // dalfistudio.com/resena (pedido del dueño, 2026-09-18: el dominio de la marca), que rebota a
  // /resena del servidor.
  // Asi el destino se cambia en un sitio -- sin desplegar ReservApp, sin tocar el sitio publico,
  // sin desplegar el bot y sin volver a pedirle nada a Meta.
  //
  // Llego a hacer falta: habia TRES direcciones distintas repartidas, y una de ellas (la del bot)
  // ni siquiera abria el cuadro de escribir resena -- mandaba a la ficha.
  const { readFile } = await import("node:fs/promises");
  const clientes = ["../outputs/reservar/app.js", "../outputs/dalfistudionails/index.html"];
  for (const archivo of clientes) {
    const fuente = await readFile(new URL(archivo, import.meta.url), "utf8");
    const codigo = fuente.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.match(codigo, /https:\/\/dalfistudio\.com\/resena/, `${archivo} tiene que usar dalfistudio.com/resena`);
    assert.doesNotMatch(codigo, /ssc\.dalfistudio\.com\/resena/, `${archivo} todavía muestra el enlace largo`);
    assert.doesNotMatch(codigo, /g\.page\/r\//, `${archivo} no puede saltarse /resena`);
    assert.doesNotMatch(codigo, /maps\.app\.goo\.gl\/QNxpbs5Gt2H4Xryz7\?g_st/, `${archivo}: ese es el perfil, no el cuadro de escribir`);
  }
  // Y la factura, que es donde mas se pide: invitacion visible y apuntando al mismo sitio.
  const factura = await readFile(new URL("../server/invoice-link.mjs", import.meta.url), "utf8");
  assert.match(factura, /class="resena"/, "cada factura tiene que invitar a resenar");
  assert.match(factura, /href="https:\/\/dalfistudio\.com\/resena"/);
  // Y la página puente del sitio público: vista previa en español al compartir el enlace (con
  // una redirección directa WhatsApp mostraba la de Google, en inglés) y salto inmediato a
  // /resena del servidor.
  const puente = await readFile(new URL("../outputs/dalfistudionails/resena.html", import.meta.url), "utf8");
  assert.match(puente, /<html lang="es">/);
  assert.match(puente, /property="og:title" content="Déjanos tu reseña/);
  assert.match(puente, /property="og:description" content="[^"]*opinión/);
  assert.match(puente, /http-equiv="refresh" content="0; url=https:\/\/ssc\.dalfistudio\.com\/resena"/);
  assert.doesNotMatch(puente, /g\.page\/r\//, "la dirección de Google solo la sabe el servidor");
});

test("FW10 — ningún sitio se queda con el enlace de reseña viejo", async () => {
  // Habia CUATRO copias del enlace repartidas por el repo. Si una se queda atras, unas clientas
  // aterrizan en el cuadro de escribir resena y otras en la ficha, y nadie se entera de por que
  // unas dejan resena y otras no.
  const { readFile } = await import("node:fs/promises");
  for (const archivo of ["../server/app.mjs", "../outputs/reservar/app.js", "../outputs/dalfistudionails/index.html"]) {
    const fuente = await readFile(new URL(archivo, import.meta.url), "utf8");
    const codigo = fuente.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.doesNotMatch(codigo, /maps\/place\/\/data=/, `${archivo} sigue con el enlace viejo`);
  }
});
