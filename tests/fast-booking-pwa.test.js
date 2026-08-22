import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { hashToken } from "../server/reservapp-auth.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
}

const MANICURISTA_TOKEN = "manicurista-session-token";
const ASISTENTE_TOKEN = "asistente-session-token";

function bookingStore() {
  const createdAppointments = [];
  return {
    createdAppointments,
    async catalog() {
      return { services: [{ id: "11111111-1111-4111-8111-111111111111", name: "Manicura", price: 900, durationMinutes: 60 }], staff: [{ id: "22222222-2222-4222-8222-222222222222", name: "Dalfina" }], schedule: { timezone: "America/Santo_Domingo", settings: {} } };
    },
    async availability() {
      return { durationMinutes: 60, slots: [{ staffId: "22222222-2222-4222-8222-222222222222", staffName: "Dalfina", time: "10:00" }] };
    },
    async resolveClient({ phone }) { return phone.includes("1111") ? { id: "33333333-3333-4333-8333-333333333333", full_name: "Ana Pérez" } : null; },
    async createClient({ phone }) {
      if (phone.includes("1111")) return { duplicate: true, matchedBy: "phone" };
      return { client: { id: "33333333-3333-4333-8333-333333333333", full_name: "Ana Pérez" }, previousDocument: {}, document: {} };
    },
    async searchClients() { return [{ id: "33333333-3333-4333-8333-333333333333", full_name: "Ana Pérez", phone: "8090002222" }]; },
    async sessionAccount(tokenHash) {
      if (tokenHash === hashToken(MANICURISTA_TOKEN)) return { id: "manicurista-1", role: "manicurista" };
      if (tokenHash === hashToken(ASISTENTE_TOKEN)) return { id: "asistente-1", role: "asistente" };
      return { id: "55555555-5555-4555-8555-555555555555", role: "clienta", client_id: "33333333-3333-4333-8333-333333333333", full_name: "Ana Pérez" };
    },
    async createAppointment(input) {
      createdAppointments.push(input);
      if (input.time === "11:00") return { conflict: true };
      return { appointment: { id: "44444444-4444-4444-8444-444444444444", legacy_id: "RES-TEST" }, previousDocument: {}, document: {} };
    },
  };
}

function staffFetch(url) {
  if (String(url).includes("/auth/v1/user")) {
    return Promise.resolve(new Response(JSON.stringify({ id: "staff-1", email: "staff@example.test" }), { status: 200 }));
  }
  if (String(url).includes("erp_user_profiles")) {
    return Promise.resolve(new Response(JSON.stringify([{ user_id: "staff-1", email: "staff@example.test", role: "administradora", is_active: true, can_manage_reservations: true }]), { status: 200 }));
  }
  return Promise.resolve(new Response("{}", { status: 401 }));
}

async function withServer(run, fetchImpl = async () => new Response("{}", { status: 401 }), store = bookingStore()) {
  const app = createApp({
    store: documentStore(), bookingStore: store, fetchImpl,
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test" },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
}

test("PWA publica catálogo y disponibilidad", async () => {
  await withServer(async (base) => {
    const catalog = await fetch(`${base}/api/fast-booking/catalog`);
    assert.equal(catalog.status, 200);
    assert.equal((await catalog.json()).services[0].name, "Manicura");
    const availability = await fetch(`${base}/api/fast-booking/availability?serviceId=11111111-1111-4111-8111-111111111111&staffId=22222222-2222-4222-8222-222222222222&date=2026-08-15`);
    assert.equal(availability.status, 200);
    assert.equal((await availability.json()).slots[0].time, "10:00");
  });
});

test("PWA evita cliente duplicado por teléfono (personal autorizado)", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/fast-booking/clients`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer staff-token" }, body: JSON.stringify({ firstName: "Ana", lastName: "Pérez", phone: "8090001111" }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).duplicate, true);
  }, staffFetch);
});

test("client/resolve y clients (POST) rechazan acceso anónimo — no se puede enumerar teléfonos ni crear fichas huérfanas sin autorización", async () => {
  await withServer(async (base) => {
    const resolve = await fetch(`${base}/api/fast-booking/client/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "8090001111" }) });
    assert.equal(resolve.status, 403);
    const create = await fetch(`${base}/api/fast-booking/clients`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ firstName: "Ana", lastName: "Pérez", phone: "8090009999" }) });
    assert.equal(create.status, 403);
  });
});

test("client/resolve funciona para personal autorizado", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/fast-booking/client/resolve`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer staff-token" }, body: JSON.stringify({ phone: "8090001111" }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).found, true);
  }, staffFetch);
});

test("PWA crea una cita autenticada idempotente y devuelve depósito", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/fast-booking/appointments`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "pwa-test-1", Cookie: "reservapp_session=test-session" }, body: JSON.stringify({ clientId: "33333333-3333-4333-8333-333333333333", serviceIds: ["11111111-1111-4111-8111-111111111111"], staffId: "22222222-2222-4222-8222-222222222222", date: "2026-08-15", time: "10:00" }) });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.appointment.reference, "RES-TEST");
    assert.equal(body.depositAmount, 500);
  });
});

test("POST /api/fast-booking/appointments creada por clienta registra canalOrigen y creadoPor", async () => {
  const store = bookingStore();
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/fast-booking/appointments`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "clienta-test-1", Cookie: "reservapp_session=test-session" }, body: JSON.stringify({ clientId: "33333333-3333-4333-8333-333333333333", serviceIds: ["11111111-1111-4111-8111-111111111111"], staffId: "22222222-2222-4222-8222-222222222222", date: "2026-08-15", time: "10:00" }) });
    assert.equal(response.status, 201);
    assert.equal(store.createdAppointments[0].source, "RESERVAPP_CLIENTE");
    assert.deepEqual(store.createdAppointments[0].createdBy, { role: "clienta", accountId: "55555555-5555-4555-8555-555555555555" });
  }, undefined, store);
});

test("POST /api/fast-booking/appointments creada por manicurista registra su rol en canalOrigen y creadoPor", async () => {
  const store = bookingStore();
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/fast-booking/appointments`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "manicurista-test-1", Cookie: `reservapp_session=${MANICURISTA_TOKEN}` }, body: JSON.stringify({ actorType: "employee", clientId: "33333333-3333-4333-8333-333333333333", serviceIds: ["11111111-1111-4111-8111-111111111111"], staffId: "22222222-2222-4222-8222-222222222222", date: "2026-08-15", time: "10:00" }) });
    assert.equal(response.status, 201);
    assert.equal(store.createdAppointments[0].source, "RESERVAPP_MANICURISTA");
    assert.deepEqual(store.createdAppointments[0].createdBy, { role: "manicurista", accountId: "manicurista-1" });
  }, undefined, store);
});

test("POST /api/fast-booking/appointments creada por asistente registra su rol en canalOrigen y creadoPor", async () => {
  const store = bookingStore();
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/fast-booking/appointments`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "asistente-test-1", Cookie: `reservapp_session=${ASISTENTE_TOKEN}` }, body: JSON.stringify({ actorType: "employee", clientId: "33333333-3333-4333-8333-333333333333", serviceIds: ["11111111-1111-4111-8111-111111111111"], staffId: "22222222-2222-4222-8222-222222222222", date: "2026-08-15", time: "10:00" }) });
    assert.equal(response.status, 201);
    assert.equal(store.createdAppointments[0].source, "RESERVAPP_ASISTENTE");
    assert.deepEqual(store.createdAppointments[0].createdBy, { role: "asistente", accountId: "asistente-1" });
  }, undefined, store);
});

test("POST /api/fast-booking/appointments creada por empleado ERP legado (sin sesión ReservApp) registra su rol", async () => {
  const store = bookingStore();
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/fast-booking/appointments`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "erp-staff-test-1", Authorization: "Bearer staff-token" }, body: JSON.stringify({ actorType: "employee", clientId: "33333333-3333-4333-8333-333333333333", serviceIds: ["11111111-1111-4111-8111-111111111111"], staffId: "22222222-2222-4222-8222-222222222222", date: "2026-08-15", time: "10:00" }) });
    assert.equal(response.status, 201);
    assert.equal(store.createdAppointments[0].source, "ERP_ADMINISTRADORA");
    assert.deepEqual(store.createdAppointments[0].createdBy, { role: "administradora", email: "staff@example.test" });
  }, staffFetch, store);
});

test("modo empleado exige sesión con permiso de reservas", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/fast-booking/appointments`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "pwa-test-employee" }, body: JSON.stringify({ actorType: "employee", clientId: "33333333-3333-4333-8333-333333333333", serviceId: "11111111-1111-4111-8111-111111111111", staffId: "22222222-2222-4222-8222-222222222222", date: "2026-08-15", time: "10:00" }) });
    assert.equal(response.status, 403);
  });
});

test("el subdominio reservapp abre directamente la PWA", async () => {
  await withServer(async (base) => {
    const url = new URL(base);
    const response = await new Promise((resolve, reject) => {
      const request = http.get({ hostname: url.hostname, port: url.port, path: "/", headers: { Host: "reservapp.sebengroup.com" } }, resolve);
      request.on("error", reject);
    });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, "/reservar/");
    response.resume();
  });
});

test("ssc.sebengroup.com conserva la portada ERP de Seben Suite Connect", async () => {
  await withServer(async (base) => {
    const url = new URL(base);
    const response = await new Promise((resolve, reject) => {
      const request = http.get({ hostname: url.hostname, port: url.port, path: "/", headers: { Host: "ssc.sebengroup.com" } }, resolve);
      request.on("error", reject);
    });
    assert.notEqual(response.statusCode, 302);
    assert.equal(response.headers["x-seben-application"], "Seben Suite Connect");
    response.resume();
  });
});

test("la API permite CORS solamente a ReservApp", async () => {
  await withServer(async (base) => {
    const allowed = await fetch(`${base}/api/fast-booking/catalog`, { headers: { Origin: "https://reservapp.sebengroup.com" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://reservapp.sebengroup.com");
    const denied = await fetch(`${base}/api/fast-booking/catalog`, { headers: { Origin: "https://malicioso.example" } });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    const preflight = await fetch(`${base}/api/fast-booking/appointments`, { method: "OPTIONS", headers: { Origin: "https://reservapp.sebengroup.com", "Access-Control-Request-Method": "POST" } });
    assert.equal(preflight.status, 204);
  });
});
