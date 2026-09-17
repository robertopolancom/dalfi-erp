// La PWA del personal. Es HTML, CSS y JS servidos tal cual por un Worker de Cloudflare, sin
// compilación, así que lo que se prueba es el archivo que se va a publicar.
//
// Lo que protegen estas pruebas son las decisiones que no se ven y que alguien "simplificaría":
// que la API nunca se sirva de caché, que no se envíe sin red, que el sondeo pare en segundo
// plano, y que por aquí no viaje ningún secreto.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const leer = (nombre) => readFile(new URL(`../outputs/inbox/${nombre}`, import.meta.url), "utf8");

test("PWA01 — el service worker NUNCA sirve la API de caché", async () => {
  const sw = await leer("sw.js");
  assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\)\)\s*return;/,
    "una bandeja servida de caché oculta que alguien está esperando, que es lo único que no puede ocultar");
  assert.match(sw, /fetch\(event\.request\)/, "red primero");
  assert.match(sw, /catch\(\(\) => caches\.match\(event\.request\)\)/, "caché solo de respaldo");
});

test("PWA02 — no se envía sin conexión: se dice, no se encola", async () => {
  // Una respuesta en cola que sale sola media hora después, cuando la clienta ya se fue o la
  // atendió otra persona, es peor que no haberla mandado.
  const app = await leer("app.js");
  assert.match(app, /if \(!navigator\.onLine\)/);
  assert.match(app, /Sin conexión: no se puede enviar todavía/);
  assert.doesNotMatch(app, /SyncManager|background-sync/, "nada de cola de envío en esta versión");
});

test("PWA03 — el sondeo se detiene en segundo plano", async () => {
  const t = await leer("transporte.js");
  assert.match(t, /if \(!vivo \|\| document\.hidden\) return programar\(\)/,
    "una app olvidada abierta toda la noche costaría miles de peticiones para no traer nada");
  assert.match(t, /If-None-Match/, "sin peticiones condicionales el sondeo es caro");
  assert.match(t, /res\.status === 304/);
  assert.match(t, /MS_ERROR_MAXIMO/, "hace falta retroceso: si no, un servidor caído recibe una petición cada pocos segundos por móvil");
});

test("PWA04 — el ETag se olvida al cambiar de conversación", async () => {
  // Si no, el primer sondeo del hilo nuevo se compara con la versión del anterior, devuelve 304 y
  // la pantalla se queda con la conversación equivocada.
  const t = await leer("transporte.js");
  assert.match(t, /olvidar: function \(\) \{ etag = null; \}/);
  const app = await leer("app.js");
  assert.match(app, /cicloHilo\.olvidar\(\);\s*\n\s*cicloHilo\.arrancar\(\);/);
});

test("PWA05 — por la configuración pública no viaja ningún secreto", async () => {
  const config = await leer("config.js");
  // La clave publishable de Supabase está pensada para el navegador; el resto no puede estar aquí.
  assert.doesNotMatch(config, /VAPID_PRIVATE|service_role|sb_secret|ERP_WEBHOOK_SECRET|CHATBOT_SECRET/);
  const app = await leer("app.js");
  assert.match(app, /clavePublicaDePush/, "la clave de push se pide al servidor, no se incrusta");
  assert.doesNotMatch(app, /BF[A-Za-z0-9_-]{60,}/, "ninguna clave VAPID incrustada en el build");
});

test("PWA06 — el manifest permite instalar de verdad", async () => {
  const manifest = JSON.parse(await leer("manifest.webmanifest"));
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.length >= 2, "sin iconos, Android no ofrece instalarla");
  const tamanos = manifest.icons.map((i) => i.sizes);
  assert.ok(tamanos.includes("192x192") && tamanos.includes("512x512"));
  assert.ok(manifest.icons.some((i) => i.purpose === "maskable"),
    "sin maskable el icono sale recortado en Android");
  // Y los archivos tienen que existir de verdad, no solo estar listados.
  for (const icono of manifest.icons) {
    const datos = await readFile(new URL(`../outputs/inbox/${icono.src.replace("./", "")}`, import.meta.url));
    assert.ok(datos.length > 500, `${icono.src} parece vacío`);
    assert.equal(datos.subarray(1, 4).toString(), "PNG");
  }
});

test("PWA07 — responder está bloqueado salvo que la conversación sea mía y dentro de ventana", async () => {
  const app = await leer("app.js");
  assert.match(app, /var puede = mia && !fueraDeVentana/);
  assert.match(app, /\$\("texto"\)\.disabled = !puede/);
  assert.match(app, /\$\("boton-enviar"\)\.disabled = !puede/);
  // Y el motivo tiene que estar a la vista, no solo el bloqueo.
  assert.match(app, /Tómala para poder responder/);
  assert.match(app, /Fuera de la ventana de 24 h/);
});

test("PWA08 — todo lo que escribe otra persona se pinta como texto, nunca como HTML", async () => {
  const app = await leer("app.js");
  // Se miran solo las líneas de CÓDIGO: el archivo menciona innerHTML en un comentario que
  // explica justamente por qué no se usa, y prohibir la palabra prohibiría también explicarlo.
  const codigo = app
    .split("\n")
    .filter((linea) => !linea.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(codigo, /innerHTML/, "por aquí llegan nombres y mensajes escritos por terceros");
  assert.match(codigo, /textContent/);
});

test("PWA09 — se avisa de la limitación de iOS antes de que la pregunten", async () => {
  const html = await leer("index.html");
  assert.match(html, /pantalla de inicio/);
  const app = await leer("app.js");
  assert.match(app, /esIOS/);
  assert.match(app, /standalone/);
});

test("PWA10 — tocar la notificación abre SU conversación, no una pestaña nueva encima", async () => {
  const sw = await leer("sw.js");
  assert.match(sw, /notificationclick/);
  assert.match(sw, /cliente\.postMessage\(\{ tipo: "abrir-conversacion"/);
  assert.match(sw, /return cliente\.focus\(\)/);
  const app = await leer("app.js");
  assert.match(app, /tipo === "abrir-conversacion"/);
});

test("PWA11 — la cabecera de seguridad no abre la API a cualquiera", async () => {
  const headers = await leer("_headers");
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /frame-ancestors 'none'/, "esta app no debe poder embeberse en ningún sitio");
  assert.match(headers, /connect-src[^\n]*ssc\.dalfistudio\.com/);
  assert.match(headers, /\/sw\.js\n\s+Cache-Control: no-cache/,
    "un service worker cacheado deja la app vieja instalada para siempre");
});

test("PWA12 — se puede recuperar la contraseña desde la propia pantalla de acceso", async () => {
  // Sin esto, quien olvida la contraseña tiene que pedirle a otra persona que le abra el ERP en
  // una computadora. La bandeja es lo único que van a tener instalado.
  const html = await leer("index.html");
  assert.match(html, /id="boton-olvide"/);
  assert.match(html, /id="boton-olvide"[^>]*type="button"|type="button"[^>]*id="boton-olvide"/,
    "dentro de un <form>, un botón sin type envía el formulario");

  const t = await leer("transporte.js");
  assert.match(t, /\/api\/password-reset\/request/);
  assert.doesNotMatch(
    t.slice(t.indexOf("function restablecerClave")),
    /obtenerToken/,
    "quien pide esto no tiene sesión: pedirle token sería imposible de cumplir",
  );
  assert.match(t, /res\.status === 429/, "el limitador sí es un caso que la persona puede corregir");

  const app = await leer("app.js");
  assert.match(app, /Si esa cuenta existe/,
    "el servidor responde igual exista o no el correo; prometer un correo que no llega es peor");
  assert.match(app, /vuelve aquí/, "el enlace abre el ERP: hay que decirlo o creerán que se equivocaron de app");
});
