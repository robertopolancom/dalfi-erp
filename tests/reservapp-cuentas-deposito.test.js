// Las cuentas para pagar el depósito. Estaban cerradas a usuarios con sesión, y eso creaba un
// círculo: para tener sesión hay que registrarse, registrarse pide un código por WhatsApp, y
// quien se quedaba esperando ese código no tenía forma de saber a dónde depositar. El 2026-09-16
// llegaron clientas reclamando exactamente eso.
//
// Lo que estas pruebas protegen es la línea que se decidió al abrirlo: se abre lo que hace falta
// para transferir (banco, producto, número, titular) y NO la cédula del titular. Un número de
// cuenta publicado sirve para que te paguen; una cédula publicada sirve para suplantar a una
// persona, y no hace falta para hacer un depósito.

import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { hashToken } from "../server/reservapp-auth.mjs";

const CUENTAS = [
  {
    tipoCuenta: "Banco", estado: "Activo", entidad: "Banreservas", tipoProducto: "Ahorros",
    numeroCuenta: "9601234567", titular: "Dalfina Guzmán",
    documentoTitular: "402-1234567-8", tipoDocumentoTitular: "Cédula",
  },
  { tipoCuenta: "Banco", estado: "Inactivo", entidad: "Popular", numeroCuenta: "111", titular: "X" },
  { tipoCuenta: "Efectivo", estado: "Activo", entidad: "Caja chica", numeroCuenta: "222", titular: "Y" },
];

const TOKEN = "token-de-sesion-de-prueba";

async function conServidor(run) {
  const app = createApp({
    store: { async read() { return { data: { cuentas: CUENTAS }, updatedAt: "2026-09-16T00:00:00.000Z", version: 1 }; } },
    bookingStore: {
      async sessionAccount(hash) {
        return hash === hashToken(TOKEN) ? { id: "acc-1", role: "cliente", full_name: "Ana" } : null;
      },
    },
    fetchImpl: async () => new Response("{}", { status: 200 }),
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "k", SUPABASE_SERVICE_ROLE_KEY: "k" },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
}

const pedir = (base, cookie) =>
  fetch(`${base}/api/reservapp/bank-accounts`, cookie ? { headers: { cookie } } : undefined);

test("CD01 — sin sesión SÍ se ven las cuentas: es lo que hace falta para poder pagar", async () => {
  await conServidor(async (base) => {
    const r = await pedir(base);
    assert.equal(r.status, 200, "un 401 aquí deja a la clienta sin saber a dónde depositar");
    const { accounts } = await r.json();
    assert.equal(accounts.length, 1, "solo cuentas de banco activas");
    assert.equal(accounts[0].banco, "Banreservas");
    assert.equal(accounts[0].numeroCuenta, "9601234567");
    assert.equal(accounts[0].titular, "Dalfina Guzmán");
  });
});

test("CD02 — sin sesión NO viaja la cédula del titular", async () => {
  await conServidor(async (base) => {
    const { accounts } = await (await pedir(base)).json();
    assert.equal(accounts[0].documento, undefined, "una cédula publicada sirve para suplantar a alguien");
    assert.equal(accounts[0].tipoDocumento, undefined);
    // Y que no se cuele por otro nombre de campo.
    assert.doesNotMatch(JSON.stringify(accounts), /402-1234567-8/);
  });
});

test("CD03 — con sesión sí se incluye, que es donde tiene sentido", async () => {
  await conServidor(async (base) => {
    const { accounts } = await (await pedir(base, `reservapp_session=${TOKEN}`)).json();
    assert.equal(accounts[0].documento, "402-1234567-8");
    assert.equal(accounts[0].tipoDocumento, "Cédula");
  });
});

test("CD04 — una cookie de sesión inválida se trata como si no hubiera", async () => {
  await conServidor(async (base) => {
    const { accounts } = await (await pedir(base, "reservapp_session=inventado")).json();
    assert.equal(accounts[0].numeroCuenta, "9601234567");
    assert.equal(accounts[0].documento, undefined);
  });
});
