// Mensaje al cliente cuando el personal marca la cita (pedido del dueño, 2026-09-18): "Atendida"
// le pide la reseña y "No asistió" le dice que lamentamos que perdiera su cita, con el enlace para
// reservar. Lo que protegen estas pruebas: que salga una sola vez por cita, que solo lo dispare
// una persona (el cierre automático de citas sin confirmar no), y que quede anotado si salió.

import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createApp } from "../server/app.mjs";

function bookingStore({ yaEnviado = false, telefono = "809-555-1234" } = {}) {
  const marcas = [];
  const reservas = [];
  return {
    marcas, reservas,
    async sessionAccount() { return { id: "acc-staff", role: "administradora" }; },
    async resolveAppointmentId(id) { return id; },
    async setAppointmentStatus({ id, status }) { return { id, status, legacy_id: "CITA-7", displaced: [], stranded: [] }; },
    async appointmentSummary() { return { legacy_id: "CITA-7", client_name: "Ana María Pérez", client_phone: telefono }; },
    async reservarSeguimientoCita(input) { reservas.push(input); return yaEnviado ? null : { id: `outbox-${reservas.length}` }; },
    async markWhatsApp(input) { marcas.push(input); },
  };
}

async function marcar(status, storeOptions, { bridge = { status: "SENT", via: "template" } } = {}) {
  const store = bookingStore(storeOptions);
  const llamadas = [];
  const app = createApp({
    store: { async read() { return { data: {}, updatedAt: "2026-09-18T00:00:00.000Z", version: 1 }; } },
    bookingStore: store,
    fetchImpl: async (url, init) => {
      if (String(url).includes("/webhook/appointment-followup")) {
        llamadas.push(JSON.parse(init.body));
        return new Response(JSON.stringify(bridge), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
    env: { ERP_WEBHOOK_SECRET: "secreto", CHATBOT_BRIDGE_URL: "https://bridge.test", SUPABASE_URL: "https://x.supabase.co", SUPABASE_PUBLISHABLE_KEY: "t" },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/reservapp/agenda/appointments/cita-1/status`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie: "reservapp_session=tok" }, body: JSON.stringify({ status }),
    });
    assert.equal(r.status, 200);
    for (let i = 0; i < 40 && store.marcas.length === 0 && store.reservas.length === 0; i++) await new Promise((res) => setTimeout(res, 10));
    await new Promise((res) => setTimeout(res, 20));
  } finally { server.close(); await once(server, "close"); }
  return { llamadas, store };
}

test("SC01 — Atendida: gracias + reseña con dalfistudio.com/resena, al primer nombre, y queda anotado como enviado", async () => {
  const { llamadas, store } = await marcar("completed");
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].event, "booking.appointment_completed");
  assert.equal(llamadas[0].clientName, "Ana");
  assert.match(llamadas[0].whatsappFormattedText, /https:\/\/dalfistudio\.com\/resena/);
  assert.deepEqual(store.marcas, [{ outboxId: "outbox-1", status: "sent", error: null }]);
});

test("SC02 — No asistió: lamentamos + enlace para reservar de nuevo", async () => {
  const { llamadas } = await marcar("no_show");
  assert.equal(llamadas[0].event, "booking.appointment_no_show");
  assert.match(llamadas[0].whatsappFormattedText, /Lamentamos/);
  assert.match(llamadas[0].whatsappFormattedText, /https:\/\/reservapp\.dalfistudio\.com/);
});

test("SC03 — una cita recibe cada mensaje una sola vez", async () => {
  const { llamadas, store } = await marcar("completed", { yaEnviado: true });
  assert.equal(store.reservas.length, 1);
  assert.equal(llamadas.length, 0);
});

test("SC04 — Confirmar o volver a Programada no le escribe al cliente", async () => {
  for (const status of ["confirmed", "scheduled"]) {
    const { llamadas, store } = await marcar(status);
    assert.equal(llamadas.length, 0);
    assert.equal(store.reservas.length, 0);
  }
});

test("SC05 — si el bridge no confirma, queda anotado como fallido; sin teléfono no se intenta", async () => {
  const fallo = await marcar("completed", {}, { bridge: { status: "FAILED", error: "sin plantilla" } });
  assert.equal(fallo.store.marcas[0].status, "failed");
  assert.match(fallo.store.marcas[0].error, /sin plantilla/);
  const sinTel = await marcar("no_show", { telefono: null });
  assert.equal(sinTel.llamadas.length, 0);
  assert.equal(sinTel.store.reservas.length, 0);
});

test("SC06 — solo el cambio manual de estatus dispara el mensaje, nunca el cierre automático", async () => {
  const fuente = await readFile(new URL("../server/app.mjs", import.meta.url), "utf8");
  const usos = fuente.match(/enviarSeguimientoCita\(/g) || [];
  assert.equal(usos.length, 1, "un solo punto de disparo: POST /agenda/appointments/:id/status");
});
