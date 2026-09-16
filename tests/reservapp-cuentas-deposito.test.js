// Las cuentas para pagar el depósito. Estaban cerradas a usuarios con sesión, y eso creaba un
// círculo: para tener sesión hay que registrarse, registrarse pide un código por WhatsApp, y
// quien se quedaba esperando ese código no tenía forma de saber a dónde depositar. El 2026-09-16
// llegaron clientas reclamando exactamente eso.
//
// Va TODO lo que pide un banco para transferir, cédula del titular incluida. Se planteó dejarla
// fuera --una cédula publicada es material para suplantar a alguien-- y Roberto decidió que sí el
// 2026-09-16, con un motivo operativo: una transferencia INTERBANCARIA en República Dominicana
// exige el documento del beneficiario, así que sin ella quien no tenga cuenta en el mismo banco
// no puede depositar. Decisión del dueño sobre datos de su propio negocio, tomada sabiendo lo que
// implica; si alguien la revisa en el futuro, que sepa que no fue un descuido.

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
    // Forma REAL del documento del ERP: las tablas cuelgan de .data, no de la raíz. Con el
    // fixture plano estas pruebas pasaban en verde mientras en producción el endpoint devolvía
    // `accounts: []` para todo el mundo -- que es exactamente lo que pasó: los números de cuenta
    // no se vieron nunca, ni con sesión.
    store: { async read() { return { data: { schema: [], meta: {}, data: { cuentas: CUENTAS } }, updatedAt: "2026-09-16T00:00:00.000Z", version: 1 }; } },
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

test("CD00 — las cuentas se leen del documento ENVUELTO, que es como viene de verdad", async () => {
  // Sin desenvolver, `row.data.cuentas` es undefined y el endpoint devuelve [] sin fallar. No da
  // error, no deja rastro: simplemente nadie ve nunca un numero de cuenta.
  await conServidor(async (base) => {
    const { accounts } = await (await pedir(base)).json();
    assert.equal(accounts.length, 1, "devolver [] aquí es el fallo que dejó a las clientas sin poder pagar");
  });
});

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

test("CD02 — sin sesión viaja también la cédula: sin ella no se puede transferir entre bancos", async () => {
  await conServidor(async (base) => {
    const { accounts } = await (await pedir(base)).json();
    assert.equal(accounts[0].documento, "402-1234567-8");
    assert.equal(accounts[0].tipoDocumento, "Cédula");
    assert.equal(accounts[0].titular, "Dalfina Guzmán");
  });
});

test("CD03 — con sesión se ve exactamente lo mismo", async () => {
  await conServidor(async (base) => {
    const sin = await (await pedir(base)).json();
    const con = await (await pedir(base, `reservapp_session=${TOKEN}`)).json();
    assert.deepEqual(con.accounts, sin.accounts, "tener cuenta no da acceso a nada distinto aquí");
  });
});

// El otro endpoint de cuentas: el que consulta el bot de WhatsApp para decirle a la clienta a
// dónde transferir. Tenía el MISMO fallo de envoltura y también devolvía [] en producción, así
// que ningún canal --ni la app ni el bot-- podía dar un número de cuenta. La versión vieja de
// Cloudflare (functions/api/booking/bank-accounts.js, con su propia prueba) sí desenvolvía; se
// perdió al portarla a Express.
test("CD05 — el endpoint del bot de WhatsApp también encuentra las cuentas", async () => {
  const app = createApp({
    store: { async read() { return { data: { schema: [], meta: {}, data: { cuentas: CUENTAS } }, updatedAt: "2026-09-16T00:00:00.000Z", version: 1 }; } },
    bookingStore: { async sessionAccount() { return null; } },
    fetchImpl: async () => new Response("{}", { status: 200 }),
    env: {
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "k",
      SUPABASE_SERVICE_ROLE_KEY: "k", CHATBOT_SECRET: "secreto-de-maquina",
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/api/booking/bank-accounts`, { headers: { "x-chatbot-secret": "secreto-de-maquina" } });
    assert.equal(r.status, 200);
    const cuerpo = await r.json();
    assert.equal(cuerpo.accounts.length, 1, "con [] el bot no puede decirle a nadie a dónde depositar");
    assert.equal(cuerpo.accounts[0].numeroCuenta, "9601234567");
  } finally { server.close(); await once(server, "close"); }
});
