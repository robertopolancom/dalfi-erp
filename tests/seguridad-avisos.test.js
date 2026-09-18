// Avisos de seguridad, secretos comparados en tiempo constante y 404 de las rutas /api.
//
// Lo que protegen estas pruebas:
//   - Que un ataque (muchos intentos seguidos) termine en un correo a administración, y que no
//     llene el buzón: un aviso por tipo y luego una hora de silencio.
//   - Que el aviso no se convierta en otra fuga: IP y ruta, nunca teléfonos ni contraseñas.
//   - Que ninguna ruta interna vuelva a comparar su secreto con `!==`.
//   - Que una /api/... que no existe diga 404, no 200 con la página de la aplicación.

import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { crearVigilante, TIPOS } from "../server/alertas-seguridad.mjs";
import { createApp } from "../server/app.mjs";

const silencio = { warn() {}, error() {} };

function vigilanteDePrueba({ env = {} } = {}) {
  const enviados = [];
  let t = Date.UTC(2026, 8, 18, 15, 0, 0);
  const v = crearVigilante({
    env,
    enviarCorreo: async (m) => { enviados.push(m); },
    logger: silencio,
    ahora: () => t,
  });
  return { v, enviados, avanzar: (ms) => { t += ms; } };
}

const esperarMicrotareas = () => new Promise((r) => setTimeout(r, 0));

test("SEG01 — por debajo del umbral no se avisa; al llegar, un solo correo", async () => {
  const { v, enviados } = vigilanteDePrueba();
  const umbral = TIPOS.login_fallido.umbral;
  for (let i = 0; i < umbral - 1; i++) v.registrar("login_fallido", { ip: "203.0.113.7", ruta: "/api/reservapp/auth/login" });
  await esperarMicrotareas();
  assert.equal(enviados.length, 0, "un par de contraseñas mal puestas es normal: no es un ataque");

  v.registrar("login_fallido", { ip: "203.0.113.7", ruta: "/api/reservapp/auth/login" });
  await esperarMicrotareas();
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].subject, /Aviso de seguridad/);
  assert.match(enviados[0].text, /203\.0\.113\.7/, "sin la IP no hay forma de saber si es una sola fuente");
});

test("SEG02 — tras avisar, ese tipo calla una hora; luego vuelve a avisar", async () => {
  const { v, enviados, avanzar } = vigilanteDePrueba();
  const umbral = TIPOS.intentos_bloqueados.umbral;
  for (let i = 0; i < umbral + 40; i++) v.registrar("intentos_bloqueados", { ip: "198.51.100.1" });
  await esperarMicrotareas();
  assert.equal(enviados.length, 1, "un ataque largo no puede llenar el buzón");

  avanzar(61 * 60 * 1000);
  for (let i = 0; i < umbral; i++) v.registrar("intentos_bloqueados", { ip: "198.51.100.1" });
  await esperarMicrotareas();
  assert.equal(enviados.length, 2, "pasada la hora, si sigue, hay que volver a saberlo");
});

test("SEG03 — los intentos viejos no cuentan: la ventana es de 10 minutos", async () => {
  const { v, enviados, avanzar } = vigilanteDePrueba();
  const umbral = TIPOS.codigo_fallido.umbral;
  for (let i = 0; i < umbral - 1; i++) v.registrar("codigo_fallido", { ip: "192.0.2.9" });
  avanzar(11 * 60 * 1000);
  v.registrar("codigo_fallido", { ip: "192.0.2.9" });
  await esperarMicrotareas();
  assert.equal(enviados.length, 0, "15 fallos repartidos en una tarde no son un ataque");
});

test("SEG04 — el aviso va a SECURITY_ALERT_EMAIL, o a ADMIN_EMAILS si no hay", async () => {
  const a = vigilanteDePrueba({ env: { SECURITY_ALERT_EMAIL: "seguridad@dalfi.test", ADMIN_EMAILS: "otro@dalfi.test" } });
  for (let i = 0; i < TIPOS.secreto_invalido.umbral; i++) a.v.registrar("secreto_invalido", { ip: "x" });
  await esperarMicrotareas();
  assert.deepEqual(a.enviados.map((m) => m.to), ["seguridad@dalfi.test"]);

  const b = vigilanteDePrueba({ env: { ADMIN_EMAILS: "uno@dalfi.test, dos@dalfi.test" } });
  for (let i = 0; i < TIPOS.secreto_invalido.umbral; i++) b.v.registrar("secreto_invalido", { ip: "x" });
  await esperarMicrotareas();
  assert.deepEqual(b.enviados.map((m) => m.to).sort(), ["dos@dalfi.test", "uno@dalfi.test"]);
});

test("SEG05 — el vigilante solo recibe IP y ruta: no puede filtrar datos personales", async () => {
  // La firma de registrar() no acepta teléfono, contraseña ni código. Esto fija que en app.mjs
  // nadie le pase el cuerpo de la petición "para tener más contexto".
  const fuente = await readFile(new URL("../server/app.mjs", import.meta.url), "utf8");
  const llamadas = fuente.match(/vigilante\.registrar\([^)]*\)/g) || [];
  assert.ok(llamadas.length >= 5, "login, código, bloqueo y secretos tienen que estar vigilados");
  for (const l of llamadas) {
    assert.doesNotMatch(l, /phone|password|code|body|secret\b/i, `demasiado contexto en: ${l}`);
  }
});

test("SEG06 — ninguna ruta interna compara su secreto con !== o ===", async () => {
  const fuente = await readFile(new URL("../server/app.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(fuente, /\) (!==|===) (expectedSecret|bridgeSecret)\b/,
    "una comparación normal se corta en el primer carácter distinto y deja medir el secreto");
  assert.match(fuente, /timingSafeEqual\(a, b\)/);
});

// --- De punta a punta, contra el servidor ------------------------------------------------------

async function conServidor(run) {
  const resend = [];
  const app = createApp({
    store: { async read() { return { data: {}, updatedAt: "2026-09-18T00:00:00.000Z", version: 1 }; } },
    chatStore: { async ingest() { return { ok: true, conversationId: "c1" }; }, async pushTargetsForConversation() { return []; } },
    fetchImpl: async (url, init) => {
      if (String(url).includes("resend.com")) { resend.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
      return new Response("{}", { status: 200 });
    },
    env: {
      CHATBOT_SECRET: "secreto-correcto",
      RESEND_API_KEY: "clave-de-prueba",
      RESEND_FROM: "Dalfi <avisos@dalfi.test>",
      SECURITY_ALERT_EMAIL: "seguridad@dalfi.test",
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`, resend); }
  finally { server.close(); await once(server, "close"); }
}

const ingest = (base, secreto) => fetch(`${base}/api/chat/ingest`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-chatbot-secret": secreto },
  body: JSON.stringify({ phone: "8095551234", direction: "out", senderType: "bot", body: "hola" }),
});

test("SEG07 — el secreto correcto sigue funcionando con la comparación nueva", async () => {
  await conServidor(async (base) => {
    assert.equal((await ingest(base, "secreto-correcto")).status, 200);
    assert.equal((await ingest(base, "secreto-correcto-casi")).status, 401);
    assert.equal((await ingest(base, "")).status, 401);
  });
});

test("SEG08 — cinco secretos equivocados seguidos terminan en un correo de aviso", async () => {
  await conServidor(async (base, resend) => {
    for (let i = 0; i < TIPOS.secreto_invalido.umbral; i++) {
      assert.equal((await ingest(base, `adivinando-${i}`)).status, 401);
    }
    for (let i = 0; i < 40 && resend.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(resend.length, 1, "el ataque tiene que llegar a alguien, no solo a los registros");
    assert.match(resend[0].subject, /secreto incorrecto/i);
    const destinos = [].concat(resend[0].to);
    assert.deepEqual(destinos, ["seguridad@dalfi.test"]);
    assert.doesNotMatch(JSON.stringify(resend[0]), /adivinando/, "el secreto probado no puede viajar en el aviso");
  });
});

test("SEG09 — una /api/... que no existe responde 404 en JSON, no la página", async () => {
  await conServidor(async (base) => {
    const r = await fetch(`${base}/api/esto-no-existe`);
    assert.equal(r.status, 404);
    assert.match(r.headers.get("content-type"), /json/);
    assert.deepEqual(await r.json(), { error: "Ruta no encontrada." });
  });
});
