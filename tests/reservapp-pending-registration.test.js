import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { NeonBookingStore } from "../server/store.mjs";
import { hashToken } from "../server/reservapp-auth.mjs";

// createPendingRegistration / verifyPendingRegistrationOtp / completePendingRegistration --
// el registro diferido: request-setup ya no crea ni la ficha en la ERP ni la cuenta de ReservApp
// de inmediato (ver server/app.mjs), solo guarda los datos aquí hasta que la persona de verdad
// confirme el código y ponga su contraseña. Estas pruebas exercitan la transacción real contra
// un pool falso, y stubbean createClient/resolveClient/ensureClientAccount (ya cubiertos por sus
// propias pruebas) igual que reservapp-confirm-attendance-store.test.js stubbea
// mirrorAppointmentToDocument -- lo que importa aquí es la orquestación, no esos métodos en sí.

function fakePool({ pendingRow, clientRow = undefined } = {}) {
  const queries = [];
  const handle = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === "begin" || sql === "commit") return {};
      if (sql === "rollback") return {};
      if (sql.includes("select app.normalize_phone")) return { rows: [{ value: "8095551234" }] };
      if (sql.includes("from app.reservapp_pending_registrations") && sql.includes("for update")) {
        return { rows: pendingRow ? [pendingRow] : [], rowCount: pendingRow ? 1 : 0 };
      }
      if (sql.startsWith("update app.reservapp_pending_registrations set consumed_at")) return { rowCount: 1 };
      if (sql.startsWith("insert into app.reservapp_pending_registrations")) return { rows: [{ id: "pending-new" }] };
      if (sql.startsWith("select id, full_name from app.clients where id=$1")) {
        return { rows: clientRow ? [clientRow] : [], rowCount: clientRow ? 1 : 0 };
      }
      if (sql.startsWith("update app.reservapp_accounts set password_hash")) return { rows: [{ id: params[0] }], rowCount: 1 };
      if (sql.startsWith("insert into app.reservapp_sessions")) return { rowCount: 1 };
      throw new Error(`Consulta no simulada: ${sql}`);
    },
    release() {},
  };
  return { pool: { connect: async () => handle, query: handle.query.bind(handle) }, queries };
}

const PENDING_NEW = {
  id: "pending-1", phone_normalized: "8095551234", phone_original: "809-555-1234",
  existing_client_id: null,
  registration: { firstName: "Ana", lastName: "Pérez", email: "", birthDate: "1995-05-20", sex: "Femenino", address: "", preferredService: "" },
  draft: null,
};

const PENDING_EXISTING = {
  id: "pending-2", phone_normalized: "8095551234", phone_original: "809-555-1234",
  existing_client_id: "client-existing", registration: null, draft: null,
};

test("createPendingRegistration(): inserta la fila e invalida cualquier registro pendiente anterior del mismo teléfono", async () => {
  const { pool, queries } = fakePool({});
  const store = new NeonBookingStore(pool);
  await store.createPendingRegistration({
    phone: "809-555-1234", existingClientId: null,
    registration: { firstName: "Ana" }, draft: null, tokenHash: "hash-1", expiresAt: "2026-09-01T00:00:00.000Z",
  });
  const sqls = queries.map((q) => q.sql);
  assert.ok(sqls.some((sql) => sql.startsWith("update app.reservapp_pending_registrations set consumed_at")), "debe invalidar el registro pendiente anterior");
  assert.ok(sqls.some((sql) => sql.startsWith("insert into app.reservapp_pending_registrations")));
});

test("completePendingRegistration(): registro nuevo -- crea la ficha en la ERP y la cuenta, activa con la contraseña", async () => {
  const { pool } = fakePool({ pendingRow: PENDING_NEW });
  const store = new NeonBookingStore(pool);
  const createClientCalls = [];
  store.createClient = async (input) => { createClientCalls.push(input); return { client: { id: "client-new", full_name: "Ana Pérez" } }; };
  const ensureCalls = [];
  store.ensureClientAccount = async (input) => { ensureCalls.push(input); return { id: "account-new" }; };

  const result = await store.completePendingRegistration({ tokenHash: "hash-1", passwordHash: "pw-hash", sessionTokenHash: "sess-hash", sessionExpiresAt: "2026-10-01T00:00:00.000Z" });

  assert.equal(createClientCalls.length, 1, "es de verdad nueva -- debe crear la ficha");
  assert.equal(createClientCalls[0].firstName, "Ana");
  assert.equal(createClientCalls[0].phone, "809-555-1234", "usa el teléfono tal como se escribió, no el normalizado");
  assert.deepEqual(ensureCalls, [{ clientId: "client-new", phone: "809-555-1234" }]);
  assert.deepEqual(result, {
    id: "account-new", account_id: "account-new", role: "cliente", client_id: "client-new",
    staff_id: null, full_name: "Ana Pérez", phone_normalized: "8095551234", draft: null,
  });
});

test("completePendingRegistration(): existing_client_id ya resuelto -- nunca llama a createClient", async () => {
  const { pool } = fakePool({ pendingRow: PENDING_EXISTING, clientRow: { id: "client-existing", full_name: "Dalfina Guzmán" } });
  const store = new NeonBookingStore(pool);
  let createClientCalled = false;
  store.createClient = async () => { createClientCalled = true; };
  store.ensureClientAccount = async ({ clientId }) => { assert.equal(clientId, "client-existing"); return { id: "account-existing" }; };

  const result = await store.completePendingRegistration({ tokenHash: "hash-2", passwordHash: "pw-hash", sessionTokenHash: "sess-hash", sessionExpiresAt: "2026-10-01T00:00:00.000Z" });

  assert.equal(createClientCalled, false, "ya existía -- no debe crear una ficha duplicada");
  assert.equal(result.client_id, "client-existing");
  assert.equal(result.full_name, "Dalfina Guzmán");
});

test("completePendingRegistration(): existing_client_id borrado mientras el OTP estaba en tránsito -- nunca se enlaza a una ficha muerta", async () => {
  // clientRow undefined => el SELECT ... status <> 'deleted' no encuentra nada (softDeleteClient
  // ya lo marcó 'deleted'). Como esta fila SÍ tenía registration guardado, cae a crear una nueva.
  const pendingConRegistro = { ...PENDING_EXISTING, registration: PENDING_NEW.registration };
  const { pool } = fakePool({ pendingRow: pendingConRegistro, clientRow: undefined });
  const store = new NeonBookingStore(pool);
  const createClientCalls = [];
  store.createClient = async (input) => { createClientCalls.push(input); return { client: { id: "client-recreated", full_name: "Ana Pérez" } }; };
  store.ensureClientAccount = async () => ({ id: "account-recreated" });

  const result = await store.completePendingRegistration({ tokenHash: "hash-3", passwordHash: "pw-hash", sessionTokenHash: "sess-hash", sessionExpiresAt: "2026-10-01T00:00:00.000Z" });

  assert.equal(createClientCalls.length, 1, "la ficha enlazada ya no existe -- debe crear una nueva con lo que se guardó");
  assert.equal(result.client_id, "client-recreated");
});

test("completePendingRegistration(): existing_client_id borrado y SIN registration guardado -- no inventa una ficha, pide volver a registrarse", async () => {
  const { pool } = fakePool({ pendingRow: PENDING_EXISTING, clientRow: undefined });
  const store = new NeonBookingStore(pool);
  store.createClient = async () => { throw new Error("no debía llamarse -- no hay datos con qué crear la ficha"); };

  await assert.rejects(
    () => store.completePendingRegistration({ tokenHash: "hash-4", passwordHash: "pw-hash", sessionTokenHash: "sess-hash", sessionExpiresAt: "2026-10-01T00:00:00.000Z" }),
    (error) => error.code === "PENDING_REGISTRATION_CLIENT_GONE",
  );
});

test("completePendingRegistration(): token no encontrado (vencido, ya consumido, o inexistente) devuelve null", async () => {
  const { pool } = fakePool({ pendingRow: null });
  const store = new NeonBookingStore(pool);
  const result = await store.completePendingRegistration({ tokenHash: "hash-nope", passwordHash: "pw-hash", sessionTokenHash: "sess-hash", sessionExpiresAt: "2026-10-01T00:00:00.000Z" });
  assert.equal(result, null);
});

test("completePendingRegistration(): createClient devuelve duplicate:true (condición de carrera real) -- cae a resolveClient", async () => {
  const { pool } = fakePool({ pendingRow: PENDING_NEW });
  const store = new NeonBookingStore(pool);
  store.createClient = async () => ({ duplicate: true, matchedBy: "phone" });
  let resolveClientCalled = false;
  store.resolveClient = async ({ phone }) => { resolveClientCalled = true; assert.equal(phone, "809-555-1234"); return { id: "client-race", full_name: "Ana Pérez" }; };
  store.ensureClientAccount = async () => ({ id: "account-race" });

  const result = await store.completePendingRegistration({ tokenHash: "hash-5", passwordHash: "pw-hash", sessionTokenHash: "sess-hash", sessionExpiresAt: "2026-10-01T00:00:00.000Z" });

  assert.equal(resolveClientCalled, true);
  assert.equal(result.client_id, "client-race");
});

test("completePendingRegistration(): createClient duplicate:true pero resolveClient tampoco encuentra nada -- error explícito, no una cuenta huérfana", async () => {
  const { pool } = fakePool({ pendingRow: PENDING_NEW });
  const store = new NeonBookingStore(pool);
  store.createClient = async () => ({ duplicate: true, matchedBy: "phone" });
  store.resolveClient = async () => null;

  await assert.rejects(
    () => store.completePendingRegistration({ tokenHash: "hash-6", passwordHash: "pw-hash", sessionTokenHash: "sess-hash", sessionExpiresAt: "2026-10-01T00:00:00.000Z" }),
    (error) => error.code === "PENDING_REGISTRATION_CLIENT_CONFLICT",
  );
});

test("completePendingRegistration(): con borrador de cita guardado, lo devuelve en el shape snake_case que espera complete-setup", async () => {
  const pendingConDraft = {
    ...PENDING_NEW,
    draft: { serviceIds: ["svc-1"], staffId: "staff-1", date: "2026-09-01", time: "10:00", notes: "Alergia a X", idempotencyKey: "idem-1" },
  };
  const { pool } = fakePool({ pendingRow: pendingConDraft });
  const store = new NeonBookingStore(pool);
  store.createClient = async () => ({ client: { id: "client-new", full_name: "Ana Pérez" } });
  store.ensureClientAccount = async () => ({ id: "account-new" });

  const result = await store.completePendingRegistration({ tokenHash: "hash-7", passwordHash: "pw-hash", sessionTokenHash: "sess-hash", sessionExpiresAt: "2026-10-01T00:00:00.000Z" });

  assert.deepEqual(result.draft, {
    service_ids: ["svc-1"], staff_id: "staff-1", appointment_date: "2026-09-01",
    appointment_time: "10:00", notes: "Alergia a X", idempotency_key: "idem-1",
  });
  assert.equal(result.draft.id, undefined, "a diferencia del draft de activateWithToken, este nunca tuvo fila propia en reservapp_booking_drafts");
});

// ---------- listClientsForAdmin(): solo clientes con cuenta de ReservApp ----------

test("listClientsForAdmin(): un cliente sin cuenta de ReservApp ya no aparece en el panel", async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [{ id: "client-1", full_name: "Con Cuenta", status: "active", email: null, client_phone: "8095551234", account_id: "acc-1", account_status: "active" }] };
    },
  };
  const rows = await new NeonBookingStore(pool).listClientsForAdmin({});
  assert.equal(queries[0].sql.includes("join app.reservapp_accounts ra"), true);
  assert.equal(queries[0].sql.includes("left join app.reservapp_accounts"), false, "debe ser join, no left join -- ya no debe listar la ERP completa");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].account_id, "acc-1");
});

test("GET /api/fast-booking/clients (búsqueda del personal para reservar): sigue mostrando cualquier cliente de la ERP, tenga o no cuenta de ReservApp -- consulta aparte, no la tocó este cambio", async () => {
  function documentStore() {
    return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
  }
  const MANICURISTA_TOKEN = "manicurista-session-token";
  const searchCalls = [];
  const store = {
    async sessionAccount(tokenHash) {
      return tokenHash === hashToken(MANICURISTA_TOKEN) ? { id: "mani-1", role: "manicurista" } : null;
    },
    async searchClients(query) {
      searchCalls.push(query);
      // Un cliente sin ninguna cuenta de ReservApp (account_id no forma parte de este shape en
      // absoluto) -- justo el tipo de fila que listClientsForAdmin ya NO devuelve, pero que esta
      // búsqueda sí debe seguir devolviendo.
      return [{ id: "client-sin-cuenta", full_name: "Cliente Sin Cuenta", email: null, phone: "8095551234" }];
    },
  };
  const app = createApp({
    store: documentStore(), bookingStore: store,
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test" },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/fast-booking/clients?q=Cliente`, {
      headers: { Cookie: `reservapp_session=${MANICURISTA_TOKEN}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.clients.length, 1);
    assert.equal(body.clients[0].id, "client-sin-cuenta");
    assert.deepEqual(searchCalls, ["Cliente"]);
  } finally { server.close(); await once(server, "close"); }
});

// ---------- POST /api/reservapp/auth/complete-setup: el fallback activateWithToken -> completePendingRegistration ----------

function completeSetupStore({ activateResult = null, pendingResult = null, pendingError = null } = {}) {
  return {
    async activateWithToken() { return activateResult; },
    async completePendingRegistration() {
      if (pendingError) throw pendingError;
      return pendingResult;
    },
  };
}

async function withCompleteSetupServer(store, run) {
  function documentStore() {
    return { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } };
  }
  const app = createApp({
    store: documentStore(), bookingStore: store,
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test" },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
}

test("complete-setup: activateWithToken no encuentra el token -- cae a completePendingRegistration", async () => {
  const store = completeSetupStore({
    activateResult: null,
    pendingResult: { id: "account-1", account_id: "account-1", role: "cliente", client_id: "client-1", staff_id: null, full_name: "Ana Pérez", phone_normalized: "8095551234", draft: null },
  });
  await withCompleteSetupServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/complete-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "activation-ticket", password: "Contrasena123" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.account.name, "Ana Pérez");
    assert.equal(body.account.clientId, "client-1");
  });
});

test("complete-setup: ninguno de los dos encuentra el token -- 410, no 500", async () => {
  const store = completeSetupStore({ activateResult: null, pendingResult: null });
  await withCompleteSetupServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/complete-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "token-vencido", password: "Contrasena123" }),
    });
    assert.equal(response.status, 410);
  });
});

test("complete-setup: PENDING_REGISTRATION_CLIENT_GONE se traduce a 410 con mensaje claro, no un 500 genérico", async () => {
  const store = completeSetupStore({
    activateResult: null,
    pendingError: Object.assign(new Error("Tu ficha ya no está disponible. Vuelve a registrarte desde el principio."), { code: "PENDING_REGISTRATION_CLIENT_GONE" }),
  });
  await withCompleteSetupServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/complete-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "activation-ticket", password: "Contrasena123" }),
    });
    assert.equal(response.status, 410);
    assert.match((await response.json()).error, /Vuelve a registrarte/);
  });
});

test("complete-setup: PHONE_ACCOUNT_CONFLICT se traduce a 409, no un 500 genérico", async () => {
  const store = completeSetupStore({
    activateResult: null,
    pendingError: Object.assign(new Error("El teléfono pertenece a otra cuenta."), { code: "PHONE_ACCOUNT_CONFLICT" }),
  });
  await withCompleteSetupServer(store, async (base) => {
    const response = await fetch(`${base}/api/reservapp/auth/complete-setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "activation-ticket", password: "Contrasena123" }),
    });
    assert.equal(response.status, 409);
  });
});
