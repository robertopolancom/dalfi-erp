// Tres piezas de la bandeja móvil que no se ven pero deciden si funciona:
//
//   * La reanudación automática: una conversación tomada y olvidada deja a la clienta sin bot Y
//     sin persona. Es el peor de los dos mundos y no da ningún error.
//   * El 304 del sondeo: varios móviles preguntando cada pocos segundos. Sin él, cada vuelta arma
//     la bandeja entera para devolver lo mismo.
//   * El borrado de suscripciones muertas: un teléfono que se reinstaló acumula fallos para
//     siempre si nadie las limpia.

import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { NeonChatStore } from "../server/store.mjs";
import { construirNotificacion, endpointCorto, pushConfigurado } from "../server/push.mjs";

// --- Reanudación automática -------------------------------------------------------------------

function poolDeIngesta({ sueltaFilas = 1 } = {}) {
  const consultas = [];
  const handle = {
    async query(sql, params) {
      consultas.push({ sql, params });
      if (sql === "begin" || sql === "commit" || sql === "rollback") return {};
      if (sql.includes("from app.client_phones")) return { rows: [] };
      if (sql.includes("insert into app.chat_conversations")) return { rows: [{ id: "conv-1" }] };
      if (sql.includes("set assigned_staff_id = null, bot_state = null")) {
        return { rowCount: sueltaFilas, rows: sueltaFilas ? [{ id: "conv-1" }] : [] };
      }
      if (sql.includes("insert into app.chat_messages")) return { rows: [{ id: "msg-1", created_at: new Date() }] };
      throw new Error(`Consulta no simulada: ${sql}`);
    },
    release() {},
  };
  return { consultas, pool: { connect: async () => handle, query: handle.query.bind(handle) } };
}

const ENTRANTE = { phone: "8095551234", direction: "in", senderType: "cliente", body: "hola" };

test("RES01 — con la ventana puesta, un mensaje entrante suelta la asignación olvidada", async () => {
  const { pool, consultas } = poolDeIngesta();
  const r = await new NeonChatStore(pool).ingest({ ...ENTRANTE, autoResumeMs: 30 * 60 * 1000 });
  assert.equal(r.reanudadaPorInactividad, true, "quien llama tiene que saberlo para reactivar el motor");
  const soltar = consultas.find((q) => q.sql.includes("set assigned_staff_id = null, bot_state = null"));
  assert.match(soltar.sql, /staff_last_read_at is null\s+or staff_last_read_at </,
    "la inactividad se mide por la última vez que el AGENTE la tocó, no por updated_at");
  assert.match(soltar.sql, /assigned_staff_id is not null/, "no hay nada que soltar si no la tiene nadie");
});

test("RES02 — updated_at NO sirve para medir la inactividad", async () => {
  // Si se midiera por updated_at, una clienta insistente mantendría viva para siempre una
  // asignación que nadie está atendiendo: cada mensaje suyo refrescaría la marca.
  const { pool, consultas } = poolDeIngesta();
  await new NeonChatStore(pool).ingest({ ...ENTRANTE, autoResumeMs: 60_000 });
  const soltar = consultas.find((q) => q.sql.includes("set assigned_staff_id = null, bot_state = null"));
  assert.doesNotMatch(soltar.sql, /updated_at <\s*now\(\)/);
});

test("RES03 — sin ventana configurada no se suelta nada", async () => {
  const { pool, consultas } = poolDeIngesta();
  const r = await new NeonChatStore(pool).ingest({ ...ENTRANTE, autoResumeMs: 0 });
  assert.equal(r.reanudadaPorInactividad, false);
  assert.equal(consultas.some((q) => q.sql.includes("bot_state = null")), false);
});

test("RES04 — un mensaje SALIENTE nunca reanuda: lo acaba de mandar la propia agente", async () => {
  const { pool, consultas } = poolDeIngesta();
  await new NeonChatStore(pool).ingest({ ...ENTRANTE, direction: "out", senderType: "bot", autoResumeMs: 60_000 });
  assert.equal(consultas.some((q) => q.sql.includes("bot_state = null")), false);
});

// --- Sondeo condicional -----------------------------------------------------------------------

const PERMISOS = { can_manage_reservations: true };

function servidorDeBandeja({ version = "v1", conversaciones = [] } = {}) {
  const llamadas = { versiones: 0, listas: 0 };
  return createApp({
    store: { async read() { return { data: {}, updatedAt: "2026-09-16T00:00:00.000Z", version: 1 }; } },
    chatStore: {
      async conversationsVersion() { llamadas.versiones += 1; return version; },
      async conversations() { llamadas.listas += 1; return conversaciones; },
    },
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes("/auth/v1/user")) return new Response(JSON.stringify({ id: "u1", email: "ana@dalfi.test" }), { status: 200 });
      if (u.includes("erp_user_profiles")) return new Response(JSON.stringify([{ user_id: "u1", email: "ana@dalfi.test", role: "administradora", is_active: true, ...PERMISOS }]), { status: 200 });
      return new Response("{}", { status: 200 });
    },
    env: { SUPABASE_URL: "https://x.supabase.co", SUPABASE_PUBLISHABLE_KEY: "k", SUPABASE_SERVICE_ROLE_KEY: "k" },
    _llamadas: llamadas,
  });
}

async function conBandeja(opciones, run) {
  const app = servidorDeBandeja(opciones);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
}

const AUTH = { Authorization: "Bearer t" };

test("SON01 — si nada cambió, 304 sin cuerpo y sin armar la lista", async () => {
  await conBandeja({ version: "v1", conversaciones: [{ id: "c1" }] }, async (base) => {
    const primera = await fetch(`${base}/api/chat/conversations`, { headers: AUTH });
    assert.equal(primera.status, 200);
    const etag = primera.headers.get("etag");
    assert.ok(etag, "sin ETag el cliente no puede preguntar condicionalmente");

    const segunda = await fetch(`${base}/api/chat/conversations`, { headers: { ...AUTH, "If-None-Match": etag } });
    assert.equal(segunda.status, 304);
    assert.equal((await segunda.text()).length, 0, "un 304 con cuerpo no ahorra nada");
  });
});

test("SON02 — si cambió, llega la lista y un ETag nuevo", async () => {
  await conBandeja({ version: "v2", conversaciones: [{ id: "c1" }] }, async (base) => {
    const r = await fetch(`${base}/api/chat/conversations`, { headers: { ...AUTH, "If-None-Match": 'W/"v1"' } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).conversations.length, 1);
    assert.equal(r.headers.get("etag"), 'W/"v2"');
  });
});

test("SON03 — un canal que no existe es 400, no 'todos'", async () => {
  // Pedir ?channel=instagram y recibir la bandeja entera sería mentirle a quien pregunta.
  await conBandeja({}, async (base) => {
    assert.equal((await fetch(`${base}/api/chat/conversations?channel=instagram`, { headers: AUTH })).status, 400);
    assert.equal((await fetch(`${base}/api/chat/conversations?channel=whatsapp`, { headers: AUTH })).status, 200);
    assert.equal((await fetch(`${base}/api/chat/conversations?channel=web`, { headers: AUTH })).status, 200);
  });
});

// --- Push -------------------------------------------------------------------------------------

test("PUSH01 — en los logs solo cabe el endpoint truncado, nunca el completo", () => {
  const largo = "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHqSecretoLargoQueNoDebeSalir";
  const corto = endpointCorto(largo);
  assert.match(corto, /^fcm\.googleapis\.com\/…/);
  assert.ok(!corto.includes("APA91bHqSecretoLargo"), "el endpoint completo permite mandarle avisos a esa persona");
});

test("PUSH02 — la notificación lleva lo justo para decidir si abrir", () => {
  const n = construirNotificacion({
    conversationId: "c1", name: "María Gómez", channel: "whatsapp",
    preview: "Hola, quería saber si tienen cupo mañana por la tarde porque ando con poco tiempo y necesito",
    needsHuman: true,
  });
  assert.match(n.title, /María Gómez/);
  assert.match(n.body, /WhatsApp/);
  assert.ok(n.body.length <= 100, "una notificación se lee en una pantalla bloqueada encima de una mesa");
  assert.equal(n.data.conversationId, "c1", "sin esto, tocar el aviso no abre la conversación");
});

test("PUSH03 — sin claves configuradas, el push está apagado y se sabe", () => {
  assert.equal(pushConfigurado({}), false);
  assert.equal(pushConfigurado({ VAPID_PUBLIC_KEY: "a" }), false, "hacen falta las dos");
  assert.equal(pushConfigurado({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b" }), true);
});

// --- Bandeja del ERP (Fase 1b) ----------------------------------------------------------------
//
// El ERP y la PWA comparten backend y reglas: quien tomó la conversación desde el móvil tiene que
// poder seguir contestando desde el ERP. Estas pruebas miran el cliente del ERP, que es HTML y JS
// servido tal cual, para que nadie lo "simplifique" quitando la comprobación que impide escribirle
// a una clienta que ya está atendiendo otra persona.

import { readFile } from "node:fs/promises";

const leerApp = () => readFile(new URL("../outputs/app.js", import.meta.url), "utf8");
const leerHtml = () => readFile(new URL("../outputs/index.html", import.meta.url), "utf8");

test("ERP01 — la bandeja tiene los tres botones y usan los endpoints compartidos", async () => {
  const html = await leerHtml();
  const app = await leerApp();
  for (const id of ["bandeja-tomar", "bandeja-soltar", "bandeja-cerrar-conv"]) {
    assert.match(html, new RegExp(`id="${id}"`), `falta el botón ${id}`);
  }
  assert.match(app, /accionDeBandeja\("claim"\)/);
  assert.match(app, /accionDeBandeja\("release"\)/);
  assert.match(app, /accionDeBandeja\("close"\)/);
  assert.match(app, /chat\/conversations\/\$\{bandejaConversacionAbierta\}\/\$\{accion\}/,
    "tienen que ser los mismos endpoints que usa la PWA, no unos propios del ERP");
});

test("ERP05 — dos botones no pueden llamarse igual, y menos estos dos", async () => {
  // El ERP tiene DOS caminos que reactivan el bot: cerrar (la tengo yo, he acabado) y la salida de
  // emergencia (funciona aunque la tenga otra persona, para cuando alguien la tomó y se fue). Si
  // los dos dicen "Devolver al bot", el segundo se pulsa por costumbre y le quita la conversación
  // a quien la esté atendiendo en ese momento.
  const html = await leerHtml();
  const etiqueta = (id) => (html.match(new RegExp(`id="${id}"[^>]*>([^<]+)<`)) || [])[1]?.trim();
  assert.equal(etiqueta("bandeja-tomar"), "Tomar conversación");
  assert.equal(etiqueta("bandeja-soltar"), "Dejar libre");
  assert.equal(etiqueta("bandeja-cerrar-conv"), "Devolver al bot");
  assert.notEqual(etiqueta("bandeja-al-bot"), etiqueta("bandeja-cerrar-conv"));
  assert.match(etiqueta("bandeja-al-bot"), /Forzar/);
});

test("ERP02 — cualquier asesor puede continuar; lo único que bloquea son las 24 h", async () => {
  // La asignación es información, no un candado: si quien empezó la conversación no está, el
  // cliente no tiene por qué esperar a que vuelva. No pisarse va por procedimiento interno.
  //
  // La ventana de 24 h sí bloquea, y no por decisión nuestra: fuera de ella WhatsApp descarta el
  // mensaje de forma asíncrona (131047) y el cliente no recibe nada, así que dejar escribir sería
  // dejar creer que se contestó.
  const app = await leerApp();
  assert.match(app, /const puedeResponder = !fueraDeVentana/);
  assert.match(app, /enviar\.disabled = !puedeResponder/);
  assert.match(app, /texto\.disabled = !puedeResponder/);
  // Y que otra persona esté encima se avisa, no se prohíbe.
  assert.match(app, /Puedes continuar tú, pero que no le lleguen dos respuestas distintas/);
});

test("ERP03 — fuera de la ventana de 24 h se dice el motivo, no solo se bloquea", async () => {
  const app = await leerApp();
  assert.match(app, /Pasaron más de 24 horas/);
  assert.match(app, /fuera de 24 h/, "y se ve también en la lista, sin tener que abrir el hilo");
});

test("ERP04 — si la tiene otra persona, se dice quién", async () => {
  const app = await leerApp();
  assert.match(app, /La está atendiendo \$\{hilo\.assignedStaffName/);
});

// --- CORS de la bandeja móvil -----------------------------------------------------------------
//
// La PWA se sirve desde inbox.dalfistudio.com y el API vive en ssc.dalfistudio.com: para el
// navegador son dos orígenes distintos. Sin estas cabeceras la bandeja móvil no funciona en
// absoluto, y falla de la peor manera posible -- el servidor responde 200, los logs no registran
// nada raro y el navegador tira la respuesta en silencio.

const ORIGEN_BANDEJA = "https://inbox.dalfistudio.com";

test("CORS01 — el preflight de la bandeja pasa sin token", async () => {
  // El preflight viaja SIN Authorization por definición. Si llegara a authenticate sería 401 y el
  // navegador ni intentaría la petición real.
  await conBandeja({}, async (base) => {
    const r = await fetch(`${base}/api/chat/conversations`, {
      method: "OPTIONS",
      headers: { Origin: ORIGEN_BANDEJA, "Access-Control-Request-Method": "GET" },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), ORIGEN_BANDEJA);
    assert.match(r.headers.get("access-control-allow-headers"), /If-None-Match/,
      "sin If-None-Match permitido el sondeo condicional no arranca");
    assert.match(r.headers.get("access-control-allow-methods"), /DELETE/, "quitar una suscripción de push");
  });
});

test("CORS02 — el ETag tiene que quedar LEGIBLE para el navegador", async () => {
  // Entre orígenes distintos el navegador oculta ETag salvo que se declare en Expose-Headers.
  // Sin eso el sondeo seguiría funcionando pero traería la lista completa en cada vuelta, que es
  // justo el coste que la bandeja está diseñada para no pagar.
  await conBandeja({ version: "v9", conversaciones: [{ id: "c1" }] }, async (base) => {
    const r = await fetch(`${base}/api/chat/conversations`, {
      headers: { ...AUTH, Origin: ORIGEN_BANDEJA },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), ORIGEN_BANDEJA);
    assert.match(r.headers.get("access-control-expose-headers"), /ETag/i);
  });
});

test("CORS03 — cualquier otro origen se queda fuera", async () => {
  // Nunca "*": con "*" cualquier página abierta en el móvil de quien atiende podría leer la
  // bandeja entera usando su sesión.
  await conBandeja({}, async (base) => {
    const r = await fetch(`${base}/api/chat/conversations`, {
      method: "OPTIONS",
      headers: { Origin: "https://otra-cosa.example", "Access-Control-Request-Method": "GET" },
    });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  });
});

test("CORS04 — el webhook del bridge NO acepta peticiones de navegador", async () => {
  // /api/chat/ingest lo llama un servidor con un secreto compartido. Darle CORS solo añadiría
  // superficie: nada en un navegador tiene por qué poder llamarlo.
  await conBandeja({}, async (base) => {
    const r = await fetch(`${base}/api/chat/ingest`, {
      method: "OPTIONS",
      headers: { Origin: ORIGEN_BANDEJA, "Access-Control-Request-Method": "POST" },
    });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  });
});

test("CORS05 — restablecer contraseña también se pide desde la bandeja", async () => {
  // Quien olvidó la contraseña no puede entrar al ERP a pedirla: la pantalla de acceso de la PWA
  // es exactamente donde se necesita.
  await conBandeja({}, async (base) => {
    const r = await fetch(`${base}/api/password-reset/request`, {
      method: "OPTIONS",
      headers: { Origin: ORIGEN_BANDEJA, "Access-Control-Request-Method": "POST" },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), ORIGEN_BANDEJA);
  });
});

// --- Nadie se queda sin atender ----------------------------------------------------------------
//
// Solo hay dos estados y no puede haber un tercero: la atiende un asesor o la atiende el bot.
// Soltar o cerrar SIN reanudar el motor produce el tercero -- una conversación muda, en la que el
// cliente escribe y no le contesta absolutamente nada. No da error en ninguna parte.

function servidorDeAcciones({ puenteOk = true, asignadaA = "staff-1" } = {}) {
  const hechos = { puente: 0, soltada: false, cerrada: false };
  const app = createApp({
    store: { async read() { return { data: {}, updatedAt: "2026-09-17T00:00:00.000Z", version: 1 }; } },
    chatStore: {
      async staffIdByEmail() { return "staff-1"; },
      async assignmentOf() { return { assignedStaffId: asignadaA, assignedStaffName: "Ana" }; },
      async destinoDe() { return { channel: "whatsapp", phone: "8095551234", webSessionId: null }; },
      async releaseConversation() { hechos.soltada = true; return { ok: true }; },
      async closeConversation() { hechos.cerrada = true; return { ok: true }; },
    },
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes("/auth/v1/user")) return new Response(JSON.stringify({ id: "u1", email: "ana@dalfi.test" }), { status: 200 });
      if (u.includes("erp_user_profiles")) return new Response(JSON.stringify([{ user_id: "u1", email: "ana@dalfi.test", role: "administradora", is_active: true, can_manage_reservations: true }]), { status: 200 });
      if (u.includes("erp-chat-control")) {
        hechos.puente += 1;
        return puenteOk
          ? new Response(JSON.stringify({ status: "OK" }), { status: 200 })
          : new Response("boom", { status: 503 });
      }
      return new Response("{}", { status: 200 });
    },
    env: {
      SUPABASE_URL: "https://x.supabase.co", SUPABASE_PUBLISHABLE_KEY: "k", SUPABASE_SERVICE_ROLE_KEY: "k",
      ERP_WEBHOOK_SECRET: "secreto-de-prueba", CHATBOT_BRIDGE_URL: "https://puente.test",
    },
  });
  return { app, hechos };
}

async function conAcciones(opciones, run) {
  const { app, hechos } = servidorDeAcciones(opciones);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`, hechos); }
  finally { server.close(); await once(server, "close"); }
}

for (const accion of ["release", "close"]) {
  test(`NADIE01/${accion} — el bot se reanuda ANTES de soltar la conversación`, async () => {
    await conAcciones({}, async (base, hechos) => {
      const r = await fetch(`${base}/api/chat/conversations/c1/${accion}`, { method: "POST", headers: AUTH });
      assert.equal(r.status, 200);
      assert.equal(hechos.puente, 1, "hay que avisar al motor: su pausa no vive en esta base");
      assert.equal(accion === "release" ? hechos.soltada : hechos.cerrada, true);
    });
  });

  test(`NADIE02/${accion} — si el puente no responde, NO se suelta`, async () => {
    // Es preferible que la conversación siga siendo tuya, y puedas seguir contestando, a que
    // quede en tierra de nadie con el motor callado.
    await conAcciones({ puenteOk: false }, async (base, hechos) => {
      const r = await fetch(`${base}/api/chat/conversations/c1/${accion}`, { method: "POST", headers: AUTH });
      assert.equal(r.status, 502);
      assert.match((await r.json()).error, /no la atendería nadie/);
      assert.equal(hechos.soltada, false, "no puede quedar sin dueño con el bot en pausa");
      assert.equal(hechos.cerrada, false);
    });
  });
}

test("NADIE03 — no se le reanuda el bot a una conversación que atiende otra persona", async () => {
  await conAcciones({ asignadaA: "staff-9" }, async (base, hechos) => {
    const r = await fetch(`${base}/api/chat/conversations/c1/release`, { method: "POST", headers: AUTH });
    assert.equal(r.status, 409);
    assert.equal(hechos.puente, 0, "comprobar de quién es va ANTES de tocar el motor");
  });
});

test("NADIE04 — si la reanudación automática no alcanza al motor, se vuelve a marcar la pausa", async () => {
  // La reanudación por inactividad suelta la asignación DENTRO de la transacción de ingesta, así
  // que no se puede deshacer ni hay nadie delante a quien avisar. Lo que sí se puede es dejar de
  // mentir: si el puente no contesta, se vuelve a marcar la pausa para que la bandeja enseñe
  // "nadie atiende". Sin esto la base diría "atiende el bot" con el motor callado -- el único
  // caso en el que el cliente se queda sin respuesta Y ninguna pantalla avisa.
  const hechos = { vueltaAPausar: 0 };
  const app = createApp({
    store: { async read() { return { data: {}, updatedAt: "2026-09-17T00:00:00.000Z", version: 1 }; } },
    chatStore: {
      async ingest() { return { ok: true, conversationId: "c1", reanudadaPorInactividad: true }; },
      async destinoDe() { return { channel: "whatsapp", phone: "8095551234", webSessionId: null }; },
      async marcarBotPausado() { hechos.vueltaAPausar += 1; },
      async pushTargetsForConversation() { return []; },
    },
    fetchImpl: async (url) => String(url).includes("erp-chat-control")
      ? new Response("no", { status: 503 })
      : new Response("{}", { status: 200 }),
    env: { CHATBOT_SECRET: "entrada", ERP_WEBHOOK_SECRET: "s", CHATBOT_BRIDGE_URL: "https://puente.test" },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/api/chat/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-chatbot-secret": "entrada" },
      body: JSON.stringify({ phone: "8095551234", direction: "in", senderType: "cliente", body: "hola" }),
    });
    assert.equal(r.status, 200, "la ingesta contesta 200 igualmente: Meta reintenta si no");
    // Lo de después de responder es asíncrono a propósito (el puente espera este 200).
    for (let i = 0; i < 40 && hechos.vueltaAPausar === 0; i += 1) await new Promise((r2) => setTimeout(r2, 25));
    assert.equal(hechos.vueltaAPausar, 1, "hay que volver a marcar la pausa para que la bandeja avise");
  } finally { server.close(); await once(server, "close"); }
});
