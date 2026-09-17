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

test("ERP02 — no se puede escribir en una conversación que no es mía", async () => {
  const app = await leerApp();
  assert.match(app, /const mia = Boolean\(hilo\.assignedStaffId\) && hilo\.assignedStaffId === bandejaMiStaffId/);
  assert.match(app, /const puedeResponder = mia && !fueraDeVentana/);
  assert.match(app, /enviar\.disabled = !puedeResponder/);
  assert.match(app, /texto\.disabled = !puedeResponder/,
    "si la caja queda escribible, alguien redacta un párrafo para que se lo rechacen al enviar");
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
