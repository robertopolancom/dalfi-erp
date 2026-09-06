// Responder desde la bandeja del ERP -- el reemplazo de contestar desde Chatwoot.
// Lo que se protege aquí es el ORDEN y la HONESTIDAD del registro: primero se intenta enviar
// y solo después se guarda, con el resultado real. Si esto se invirtiera, el hilo diría que
// se contestó cuando WhatsApp lo rechazó, y alguien creería haber atendido a un cliente que
// sigue esperando.

import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";

const PERMISOS = { can_manage_reservations: true, can_manage_configuration: true };

function chatStoreFalso() {
  const guardados = [];
  const devueltas = [];
  return {
    guardados,
    devueltas,
    async phoneOf(id) { return id === "conv-1" ? "18295590744" : null; },
    async staffIdByEmail() { return "staff-1"; },
    async recordStaffReply(args) { guardados.push(args); return { id: "msg-1" }; },
    async returnToBot(args) { devueltas.push(args); },
  };
}

async function conServidor(respuestaDelPuente, run) {
  const chatStore = chatStoreFalso();
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
    store: { async read() { return { data: {}, updatedAt: "2026-09-06T00:00:00.000Z", version: 1 }; } },
    chatStore, fetchImpl,
    env: {
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "k", SUPABASE_SERVICE_ROLE_KEY: "k",
      ERP_WEBHOOK_SECRET: "shared-secret", CHATBOT_BRIDGE_URL: "https://bridge.test",
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`, chatStore, llamadas); }
  finally { server.close(); await once(server, "close"); }
}

const AUTH = { Authorization: "Bearer t", "Content-Type": "application/json" };

test("una respuesta entregada se guarda como enviada y llega al puente con el secreto", async () => {
  const ok = new Response(JSON.stringify({ status: "OK", waMessageId: "wamid.out.9", viaPlantilla: false }), { status: 200 });
  await conServidor(ok, async (base, chatStore, llamadas) => {
    const r = await fetch(`${base}/api/chat/conversations/conv-1/reply`, {
      method: "POST", headers: AUTH, body: JSON.stringify({ body: "Ya voy contigo" }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, viaPlantilla: false });

    assert.match(llamadas[0].url, /\/webhook\/erp-chat-reply$/);
    assert.equal(llamadas[0].options.headers["x-webhook-secret"], "shared-secret");
    assert.equal(llamadas[0].cuerpo.recipientPhone, "18295590744");

    assert.equal(chatStore.guardados.length, 1);
    assert.equal(chatStore.guardados[0].deliveryStatus, "sent");
    assert.equal(chatStore.guardados[0].waMessageId, "wamid.out.9");
    assert.equal(chatStore.guardados[0].staffId, "staff-1");
  });
});

test("si WhatsApp no la entrega, el mensaje SIGUE en el hilo pero marcado como fallido", async () => {
  // Lo contrario --descartarlo-- dejaría a un cliente sin respuesta y sin rastro de que
  // alguien lo intentó. Un fallo visible se puede reintentar; uno invisible no.
  const fuera = new Response(JSON.stringify({ status: "OUTSIDE_24H_WINDOW", mensaje: "Han pasado más de 24 horas..." }), { status: 200 });
  await conServidor(fuera, async (base, chatStore) => {
    const r = await fetch(`${base}/api/chat/conversations/conv-1/reply`, {
      method: "POST", headers: AUTH, body: JSON.stringify({ body: "hola" }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /24 horas/);
    assert.equal(chatStore.guardados[0].deliveryStatus, "failed");
    assert.match(chatStore.guardados[0].deliveryError, /24 horas/);
  });
});

test("si el puente está caído tampoco se pierde lo que se escribió", async () => {
  await conServidor(new Error("ECONNREFUSED"), async (base, chatStore) => {
    const r = await fetch(`${base}/api/chat/conversations/conv-1/reply`, {
      method: "POST", headers: AUTH, body: JSON.stringify({ body: "hola" }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, false);
    assert.equal(chatStore.guardados[0].deliveryStatus, "failed");
    assert.match(chatStore.guardados[0].deliveryError, /ECONNREFUSED/);
  });
});

test("un mensaje vacío no llega a tocar el puente", async () => {
  await conServidor(new Response("{}", { status: 200 }), async (base, chatStore, llamadas) => {
    const r = await fetch(`${base}/api/chat/conversations/conv-1/reply`, {
      method: "POST", headers: AUTH, body: JSON.stringify({ body: "   " }),
    });
    assert.equal(r.status, 400);
    assert.equal(llamadas.length, 0);
    assert.equal(chatStore.guardados.length, 0);
  });
});

test("una conversación que no existe da 404 y no manda nada a WhatsApp", async () => {
  await conServidor(new Response("{}", { status: 200 }), async (base, chatStore, llamadas) => {
    const r = await fetch(`${base}/api/chat/conversations/no-existe/reply`, {
      method: "POST", headers: AUTH, body: JSON.stringify({ body: "hola" }),
    });
    assert.equal(r.status, 404);
    assert.equal(llamadas.length, 0);
  });
});

test("sin sesión del ERP no se puede responder", async () => {
  await conServidor(new Response("{}", { status: 200 }), async (base, chatStore, llamadas) => {
    const r = await fetch(`${base}/api/chat/conversations/conv-1/reply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "hola" }),
    });
    assert.equal(r.status, 401);
    assert.equal(llamadas.length, 0);
    assert.equal(chatStore.guardados.length, 0);
  });
});

test("devolver al bot marca la conversación aunque el puente falle, y lo avisa", async () => {
  // La bandeja tiene que dejar de mostrarla en espera igualmente: para el equipo ya está
  // atendida. Pero si el puente no se enteró, el bot puede seguir pausado del otro lado y eso
  // hay que decirlo en vez de dar un "listo" que no es verdad.
  await conServidor(new Error("timeout"), async (base, chatStore) => {
    const r = await fetch(`${base}/api/chat/conversations/conv-1/return-to-bot`, {
      method: "POST", headers: { Authorization: "Bearer t" },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.match(body.aviso, /timeout/);
    assert.equal(chatStore.devueltas.length, 1);
  });
});
