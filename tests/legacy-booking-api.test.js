import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";

const FUTURE_DATE = new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString().slice(0, 10);
const CHATBOT_SECRET = "test-chatbot-secret";

function baseDoc() {
  return {
    servicios: [{ servicioID: "SRV-1", servicio: "Manicura Rusa", duracionMin: 60 }],
    colaboradores: [{ colaboradorID: "COL-1", nombreCompleto: "Ana Pérez", estado: "Activo" }],
    reservas: [],
    clientes: [{ clienteID: "CLI-EXISTENTE", nombreCompleto: "Rosa Existente", telefono: "8095551111", estado: "Activo" }],
    cuentas: [{ cuentaID: "ACC-1", tipoCuenta: "Banco", estado: "Activo", entidad: "Banreservas", tipoProducto: "Ahorros", numeroCuenta: "1234567890", titular: "Dalfi Studio", documentoTitular: "001-0000000-1" }],
  };
}

function fakeDocumentStore(initialDoc) {
  let envelope = JSON.parse(JSON.stringify(initialDoc));
  let updatedAt = "2026-08-03T12:00:00.000Z";
  let version = 1;
  return {
    async read() { return { data: JSON.parse(JSON.stringify(envelope)), updatedAt, version }; },
    async save({ document, expectedUpdatedAt }) {
      if (expectedUpdatedAt !== updatedAt) return { conflict: true, updatedAt };
      const previousDocument = envelope;
      envelope = JSON.parse(JSON.stringify(document));
      updatedAt = new Date().toISOString();
      version += 1;
      return { saved: true, updatedAt, version, previousDocument };
    },
  };
}

async function withServer(initialDoc, run, { chatbotSecret = CHATBOT_SECRET } = {}) {
  const app = createApp({
    store: fakeDocumentStore(initialDoc),
    env: {
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test",
      CHATBOT_SECRET: chatbotSecret,
    },
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
}

const chatbotHeaders = { "Content-Type": "application/json", "x-chatbot-secret": CHATBOT_SECRET };

test("GET /api/booking/services devuelve el catálogo activo sin necesitar secreto", async () => {
  await withServer(baseDoc(), async (base) => {
    const res = await fetch(`${base}/api/booking/services`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.services[0].name, "Manicura Rusa");
  });
});

test("GET /api/booking/staff devuelve colaboradoras activas sin necesitar secreto", async () => {
  await withServer(baseDoc(), async (base) => {
    const res = await fetch(`${base}/api/booking/staff`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.staff[0].displayName, "Ana Pérez");
  });
});

test("GET /api/booking/availability calcula slots reales para la colaboradora", async () => {
  await withServer(baseDoc(), async (base) => {
    const res = await fetch(`${base}/api/booking/availability?serviceId=SRV-1&date=${FUTURE_DATE}&collaboratorId=COL-1`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.ok(body.slots.length > 0);
  });
});

// Fecha de lunes a sábado, nunca domingo (el negocio cierra domingos por defecto) — a
// diferencia de FUTURE_DATE arriba, no puede ser flaky.
function nextOpenWeekday(daysAhead = 8) {
  let d = new Date(Date.now() + daysAhead * 24 * 3600 * 1000);
  while (d.getUTCDay() === 0) d = new Date(d.getTime() + 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

test("GET /api/booking/availability sin includeUnavailable no trae allSlots (comportamiento de siempre)", async () => {
  await withServer(baseDoc(), async (base) => {
    const res = await fetch(`${base}/api/booking/availability?serviceId=SRV-1&date=${nextOpenWeekday()}&collaboratorId=COL-1`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.allSlots, undefined);
  });
});

test("GET /api/booking/availability?includeUnavailable=true agrega allSlots con disponibles y ocupados/pasados", async () => {
  const doc = baseDoc();
  const date = nextOpenWeekday();
  doc.reservas = [{ reservaID: "RES-1", fecha: date, hora: "10:00", duracionMin: 60, colaboradorID: "COL-1", estado: "Confirmada" }];
  await withServer(doc, async (base) => {
    const res = await fetch(`${base}/api/booking/availability?serviceId=SRV-1&date=${date}&collaboratorId=COL-1&includeUnavailable=true`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.allSlots) && body.allSlots.length > 0);
    const occupied = body.allSlots.find((s) => s.time === "10:00");
    assert.equal(occupied.available, false);
    assert.equal(occupied.reason, "OCUPADO");
    const free = body.allSlots.find((s) => s.available === true);
    assert.ok(free, "debe haber al menos un horario libre en allSlots");
    // `slots` (comportamiento de siempre) sigue siendo solo los libres.
    assert.ok(body.slots.every((s) => s.time !== "10:00"));
  });
});

test("GET /api/booking/availability?includeUnavailable=true sin collaboratorId (auto-selección) también trae allSlots", async () => {
  const doc = baseDoc();
  const date = nextOpenWeekday();
  await withServer(doc, async (base) => {
    const res = await fetch(`${base}/api/booking/availability?serviceId=SRV-1&date=${date}&includeUnavailable=true`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.allSlots) && body.allSlots.length > 0);
  });
});

test("endpoints que exponen datos sensibles rechazan sin CHATBOT_SECRET configurado (falla cerrado)", async () => {
  await withServer(baseDoc(), async (base) => {
    const res = await fetch(`${base}/api/booking/bank-accounts`, { headers: { "x-chatbot-secret": "cualquiera" } });
    assert.equal(res.status, 503);
  }, { chatbotSecret: "" });
});

test("endpoints que exponen datos sensibles rechazan un secreto incorrecto", async () => {
  await withServer(baseDoc(), async (base) => {
    const res = await fetch(`${base}/api/booking/bank-accounts`, { headers: { "x-chatbot-secret": "incorrecto" } });
    assert.equal(res.status, 401);
  });
});

test("GET /api/booking/bank-accounts devuelve solo cuentas bancarias activas con secreto correcto", async () => {
  await withServer(baseDoc(), async (base) => {
    const res = await fetch(`${base}/api/booking/bank-accounts`, { headers: { "x-chatbot-secret": CHATBOT_SECRET } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.accounts[0].banco, "Banreservas");
  });
});

test("GET /api/booking/clients?phone= resuelve una clienta existente por teléfono", async () => {
  await withServer(baseDoc(), async (base) => {
    const res = await fetch(`${base}/api/booking/clients?phone=8095551111`, { headers: { "x-chatbot-secret": CHATBOT_SECRET } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.found, true);
    assert.equal(body.client.name, "Rosa Existente");
  });
});

test("POST /api/booking/clients crea una clienta nueva cuando el teléfono no existe", async () => {
  await withServer(baseDoc(), async (base) => {
    const res = await fetch(`${base}/api/booking/clients`, {
      method: "POST", headers: chatbotHeaders,
      body: JSON.stringify({ client: { name: "Nueva Clienta", phone: "8095559999" }, senderPhone: "8095559999" }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.isNew, true);
  });
});

test("POST /api/booking/confirm: la primera reserva tiene éxito y la segunda a la misma hora da 409 (anti doble-booking)", async () => {
  await withServer(baseDoc(), async (base) => {
    const payload = (idempotencyKey, clientId) => JSON.stringify({
      idempotencyKey, client: { id: clientId, name: "Maria Lopez" },
      serviceLines: [{ serviceId: "SRV-1", quantity: 1 }],
      requestedStartAt: `${FUTURE_DATE}T09:00:00`,
      collaboratorPreference: { mode: "specific", collaboratorId: "COL-1" },
    });
    const res1 = await fetch(`${base}/api/booking/confirm`, { method: "POST", headers: chatbotHeaders, body: payload("IDEM-101", "CLI-1") });
    const data1 = await res1.json();
    assert.equal(res1.status, 200);
    assert.equal(data1.appointment.status, "Confirmada");

    const res2 = await fetch(`${base}/api/booking/confirm`, { method: "POST", headers: chatbotHeaders, body: payload("IDEM-102", "CLI-2") });
    const data2 = await res2.json();
    assert.equal(res2.status, 409);
    assert.equal(data2.code, "SLOT_NO_LONGER_AVAILABLE");
  });
});

test("POST /api/booking/confirm: idempotencyKey repetida devuelve la misma cita, no duplica", async () => {
  await withServer(baseDoc(), async (base) => {
    const payload = JSON.stringify({
      idempotencyKey: "IDEM-201", client: { id: "CLI-1", name: "Maria Lopez" },
      serviceLines: [{ serviceId: "SRV-1", quantity: 1 }],
      requestedStartAt: `${FUTURE_DATE}T10:00:00`,
      collaboratorPreference: { mode: "specific", collaboratorId: "COL-1" },
    });
    const res1 = await fetch(`${base}/api/booking/confirm`, { method: "POST", headers: chatbotHeaders, body: payload });
    const data1 = await res1.json();
    const res2 = await fetch(`${base}/api/booking/confirm`, { method: "POST", headers: chatbotHeaders, body: payload });
    const data2 = await res2.json();
    assert.equal(res2.status, 200);
    assert.equal(data2.idempotent, true);
    assert.equal(data2.appointment.appointmentId, data1.appointment.appointmentId);
  });
});

test("POST /api/booking/cancel cancela una reserva existente y libera el horario", async () => {
  await withServer(baseDoc(), async (base) => {
    const confirmRes = await fetch(`${base}/api/booking/confirm`, {
      method: "POST", headers: chatbotHeaders,
      body: JSON.stringify({ idempotencyKey: "IDEM-301", client: { id: "CLI-1", name: "Maria Lopez" }, serviceLines: [{ serviceId: "SRV-1", quantity: 1 }], requestedStartAt: `${FUTURE_DATE}T11:00:00`, collaboratorPreference: { mode: "specific", collaboratorId: "COL-1" } }),
    });
    const confirmData = await confirmRes.json();
    const cancelRes = await fetch(`${base}/api/booking/cancel`, {
      method: "POST", headers: chatbotHeaders,
      body: JSON.stringify({ appointmentId: confirmData.appointment.appointmentId, reason: "Cliente no puede asistir" }),
    });
    const cancelData = await cancelRes.json();
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelData.status, "Cancelada");

    // El horario debe quedar libre otra vez para otra clienta.
    const retryRes = await fetch(`${base}/api/booking/confirm`, {
      method: "POST", headers: chatbotHeaders,
      body: JSON.stringify({ idempotencyKey: "IDEM-302", client: { id: "CLI-2", name: "Carmen" }, serviceLines: [{ serviceId: "SRV-1", quantity: 1 }], requestedStartAt: `${FUTURE_DATE}T11:00:00`, collaboratorPreference: { mode: "specific", collaboratorId: "COL-1" } }),
    });
    assert.equal(retryRes.status, 200);
  });
});

test("POST /api/booking/reschedule mueve una reserva a un horario libre nuevo", async () => {
  await withServer(baseDoc(), async (base) => {
    const confirmRes = await fetch(`${base}/api/booking/confirm`, {
      method: "POST", headers: chatbotHeaders,
      body: JSON.stringify({ idempotencyKey: "IDEM-401", client: { id: "CLI-1", name: "Maria Lopez" }, serviceLines: [{ serviceId: "SRV-1", quantity: 1 }], requestedStartAt: `${FUTURE_DATE}T09:00:00`, collaboratorPreference: { mode: "specific", collaboratorId: "COL-1" } }),
    });
    const confirmData = await confirmRes.json();
    const rescheduleRes = await fetch(`${base}/api/booking/reschedule`, {
      method: "POST", headers: chatbotHeaders,
      body: JSON.stringify({ appointmentId: confirmData.appointment.appointmentId, date: FUTURE_DATE, time: "09:30", reason: "Cambio de planes" }),
    });
    const rescheduleData = await rescheduleRes.json();
    assert.equal(rescheduleRes.status, 200);
    assert.equal(rescheduleData.appointment.startAt, `${FUTURE_DATE}T09:30:00`);
  });
});
