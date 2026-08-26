// "Borrar credenciales" (DELETE /admin/accounts/:id) y "Borrar cliente" (DELETE
// /admin/clients/:id) del panel Configuración de usuarios. Los dos comparten los candados de
// resolveAdminAuthority con el resto del panel, así que lo que se prueba aquí es lo propio de
// borrar: quién puede, a quién no puede tocar, y que un cliente con citas futuras no se borre.

import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { NeonBookingStore } from "../server/store.mjs";
import { hashToken } from "../server/reservapp-auth.mjs";

function documentStore() {
  return { async read() { return { data: {}, updatedAt: "2026-08-26T00:00:00.000Z", version: 1 }; } };
}

const ADMIN_TOKEN = "admin-session-token";
const SUPERADMIN_TOKEN = "superadmin-session-token";
const MANICURISTA_TOKEN = "manicurista-session-token";

function bookingStore({ softDeleteResult = { id: "client-1", fullName: "Ana Pérez", deletedAccount: true } } = {}) {
  const deletedAccounts = [];
  const softDeleted = [];
  return {
    deletedAccounts, softDeleted,
    async sessionAccount(tokenHash) {
      if (tokenHash === hashToken(ADMIN_TOKEN)) return { id: "admin-1", role: "administradora" };
      if (tokenHash === hashToken(SUPERADMIN_TOKEN)) return { id: "super-1", role: "superadministrador" };
      if (tokenHash === hashToken(MANICURISTA_TOKEN)) return { id: "mani-1", role: "manicurista" };
      return null;
    },
    async listEmployeeAccounts() {
      return [
        { id: "acc-1", role: "manicurista", status: "active", staff_id: "staff-1", full_name: "Dalfina Guzman" },
        { id: "acc-2", role: "superadministrador", status: "active", staff_id: "staff-2", full_name: "Roberto Polanco" },
      ];
    },
    async deleteAccount({ id }) {
      deletedAccounts.push(id);
      // acc-3 es la cuenta de un cliente (no sale en listEmployeeAccounts); "acc-fantasma" no existe.
      if (!["acc-1", "acc-2", "acc-3", "admin-1"].includes(id)) return null;
      return { id, role: id === "acc-3" ? "cliente" : "manicurista", client_id: null, staff_id: "staff-1" };
    },
    async softDeleteClient({ id }) {
      softDeleted.push(id);
      if (id !== "client-1") return null;
      return softDeleteResult;
    },
  };
}

async function withServer(run, storeOptions) {
  const store = bookingStore(storeOptions);
  const app = createApp({
    store: documentStore(), bookingStore: store,
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test" },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`, store); }
  finally { server.close(); await once(server, "close"); }
}

const withCookie = (token) => ({ Cookie: `reservapp_session=${token}` });
const del = (base, path, token) =>
  fetch(`${base}${path}`, { method: "DELETE", headers: token ? withCookie(token) : {} });

// ---------- DELETE /admin/accounts/:id ----------

test("DELETE /admin/accounts/:id: una administradora borra las credenciales de una manicurista", async () => {
  await withServer(async (base, store) => {
    const response = await del(base, "/api/reservapp/admin/accounts/acc-1", ADMIN_TOKEN);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(store.deletedAccounts, ["acc-1"]);
  });
});

test("DELETE /admin/accounts/:id: sirve también para la cuenta de un cliente", async () => {
  await withServer(async (base, store) => {
    const response = await del(base, "/api/reservapp/admin/accounts/acc-3", ADMIN_TOKEN);
    assert.equal(response.status, 200);
    assert.deepEqual(store.deletedAccounts, ["acc-3"]);
  });
});

test("DELETE /admin/accounts/:id: una administradora NO puede borrar una cuenta superadministrador", async () => {
  await withServer(async (base, store) => {
    const response = await del(base, "/api/reservapp/admin/accounts/acc-2", ADMIN_TOKEN);
    assert.equal(response.status, 403);
    assert.deepEqual(store.deletedAccounts, [], "no debe llegar a tocar la base de datos");
  });
});

test("DELETE /admin/accounts/:id: un superadministrador SÍ puede borrar otra cuenta superadministrador", async () => {
  await withServer(async (base, store) => {
    const response = await del(base, "/api/reservapp/admin/accounts/acc-2", SUPERADMIN_TOKEN);
    assert.equal(response.status, 200);
    assert.deepEqual(store.deletedAccounts, ["acc-2"]);
  });
});

test("DELETE /admin/accounts/:id: nadie puede borrar sus propias credenciales", async () => {
  await withServer(async (base, store) => {
    const response = await del(base, "/api/reservapp/admin/accounts/admin-1", ADMIN_TOKEN);
    assert.equal(response.status, 400);
    assert.deepEqual(store.deletedAccounts, []);
  });
});

test("DELETE /admin/accounts/:id: una manicurista no puede borrar credenciales", async () => {
  await withServer(async (base, store) => {
    const response = await del(base, "/api/reservapp/admin/accounts/acc-1", MANICURISTA_TOKEN);
    assert.equal(response.status, 403);
    assert.deepEqual(store.deletedAccounts, []);
  });
});

test("DELETE /admin/accounts/:id: sin sesión responde 403, no 401 (mismo contrato que el resto del panel)", async () => {
  await withServer(async (base, store) => {
    const response = await del(base, "/api/reservapp/admin/accounts/acc-1");
    assert.equal(response.status, 403);
    assert.deepEqual(store.deletedAccounts, []);
  });
});

test("DELETE /admin/accounts/:id: una cuenta que ya no existe responde 404", async () => {
  await withServer(async (base) => {
    const response = await del(base, "/api/reservapp/admin/accounts/acc-fantasma", ADMIN_TOKEN);
    assert.equal(response.status, 404);
  });
});

// ---------- DELETE /admin/clients/:id ----------

test("DELETE /admin/clients/:id: una administradora borra un cliente y su cuenta de ReservApp", async () => {
  await withServer(async (base, store) => {
    const response = await del(base, "/api/reservapp/admin/clients/client-1", ADMIN_TOKEN);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, deletedAccount: true });
    assert.deepEqual(store.softDeleted, ["client-1"]);
  });
});

test("DELETE /admin/clients/:id: un cliente con citas futuras responde 409 y no se borra", async () => {
  await withServer(async (base) => {
    const response = await del(base, "/api/reservapp/admin/clients/client-1", ADMIN_TOKEN);
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.upcomingAppointments, 2);
    assert.match(body.error, /2 cita\(s\) futuras/);
  }, { softDeleteResult: { blocked: 2 } });
});

test("DELETE /admin/clients/:id: un cliente inexistente o ya borrado responde 404", async () => {
  await withServer(async (base) => {
    const response = await del(base, "/api/reservapp/admin/clients/client-fantasma", ADMIN_TOKEN);
    assert.equal(response.status, 404);
  });
});

test("DELETE /admin/clients/:id: una manicurista no puede borrar clientes", async () => {
  await withServer(async (base, store) => {
    const response = await del(base, "/api/reservapp/admin/clients/client-1", MANICURISTA_TOKEN);
    assert.equal(response.status, 403);
    assert.deepEqual(store.softDeleted, []);
  });
});

// ---------- softDeleteClient() contra un pool falso ----------

// La transacción real, no la ruta HTTP: lo que importa es que el borrado sea lógico (update a
// 'deleted', nunca un delete de app.clients), que arrastre la cuenta de ReservApp para liberar el
// teléfono, y que no toque nada si el cliente todavía tiene citas futuras.
function fakePool({ client: clientRow, upcoming = 0, deletedAccountRows = 1 }) {
  const queries = [];
  const handle = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (["begin", "commit", "rollback"].includes(sql)) return {};
      if (sql.includes("from app.clients") && sql.includes("for update")) {
        return { rows: clientRow ? [clientRow] : [], rowCount: clientRow ? 1 : 0 };
      }
      if (sql.includes("count(*)::int total from app.appointments")) return { rows: [{ total: upcoming }] };
      if (sql.startsWith("update app.clients set status='deleted'")) return { rowCount: 1 };
      if (sql.startsWith("delete from app.reservapp_accounts")) return { rowCount: deletedAccountRows };
      throw new Error(`Consulta no simulada: ${sql}`);
    },
    release() {},
  };
  return { pool: { connect: async () => handle, query: handle.query.bind(handle) }, queries };
}

const CLIENT_ROW = { id: "client-1", full_name: "Ana Pérez" };

test("softDeleteClient(): marca la ficha como 'deleted' y borra la cuenta, sin borrar nada de app.clients", async () => {
  const { pool, queries } = fakePool({ client: CLIENT_ROW });
  const result = await new NeonBookingStore(pool).softDeleteClient({ id: "client-1" });
  assert.deepEqual(result, { id: "client-1", fullName: "Ana Pérez", deletedAccount: true });
  const sqls = queries.map((q) => q.sql);
  assert.ok(sqls.some((sql) => sql.startsWith("update app.clients set status='deleted'")));
  assert.ok(sqls.some((sql) => sql.startsWith("delete from app.reservapp_accounts")));
  assert.ok(!sqls.some((sql) => sql.startsWith("delete from app.clients")), "el borrado es lógico, no físico");
  assert.equal(sqls.at(-1), "commit");
});

test("softDeleteClient(): con citas futuras no toca nada y devuelve cuántas lo impiden", async () => {
  const { pool, queries } = fakePool({ client: CLIENT_ROW, upcoming: 3 });
  const result = await new NeonBookingStore(pool).softDeleteClient({ id: "client-1" });
  assert.deepEqual(result, { blocked: 3 });
  const sqls = queries.map((q) => q.sql);
  assert.ok(!sqls.some((sql) => sql.startsWith("update app.clients")), "no debe marcar la ficha");
  assert.ok(!sqls.some((sql) => sql.startsWith("delete from")), "no debe borrar la cuenta");
  assert.equal(sqls.at(-1), "rollback");
});

test("softDeleteClient(): una ficha inexistente o ya borrada devuelve null sin escribir", async () => {
  const { pool, queries } = fakePool({ client: null });
  const result = await new NeonBookingStore(pool).softDeleteClient({ id: "client-1" });
  assert.equal(result, null);
  assert.equal(queries.map((q) => q.sql).at(-1), "rollback");
});

test("softDeleteClient(): un cliente que nunca tuvo cuenta de ReservApp también se borra", async () => {
  const { pool } = fakePool({ client: CLIENT_ROW, deletedAccountRows: 0 });
  const result = await new NeonBookingStore(pool).softDeleteClient({ id: "client-1" });
  assert.deepEqual(result, { id: "client-1", fullName: "Ana Pérez", deletedAccount: false });
});

// ---------- Panel (outputs/reservar) ----------

test("el panel ofrece 'Borrar credenciales' en Personal y en Clientes, y 'Borrar cliente' solo en Clientes", () => {
  const app = readFileSync(new URL("../outputs/reservar/app.js", import.meta.url), "utf8");
  assert.match(app, /method: "DELETE" \}\);[\s\S]*?admin\/accounts/);
  assert.match(app, /api\(`\/api\/reservapp\/admin\/accounts\/\$\{accountId\}`, \{ method: "DELETE" \}\)/);
  assert.match(app, /api\(`\/api\/reservapp\/admin\/clients\/\$\{client\.id\}`, \{ method: "DELETE" \}\)/);
  // Los dos botones confirman antes de disparar la petición -- son irreversibles desde el panel.
  assert.equal(app.match(/if \(!confirm\(/g).length, 2);
  // Personal: una sola vez. Clientes: la cuenta (dentro del if de account_id) y la ficha.
  assert.equal(app.match(/deleteAccountButton\(\{/g).length, 3, "definición + Personal + Clientes");
  assert.equal(app.match(/deleteClientButton\(\{/g).length, 2, "definición + Clientes");
});

test("ReservApp ya no dice 'clienta' en ninguna parte del panel ni del frontend", () => {
  for (const file of ["app.js", "index.html", "styles.css"]) {
    const content = readFileSync(new URL(`../outputs/reservar/${file}`, import.meta.url), "utf8");
    // \b para no confundirse con identificadores en inglés como showClientAppointments.
    assert.doesNotMatch(content, /\bclientas?\b/i, `${file} todavía dice "clienta"`);
  }
});
