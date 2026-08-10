// Pruebas para GET /api/booking/bank-accounts — endpoint que el Chatbot Bridge consulta
// cuando la clienta elige "Enviar comprobante de pago -> Transferencia bancaria".

import test from "node:test";
import assert from "node:assert/strict";

import { onRequestGet as bankAccountsGet } from "../functions/api/booking/bank-accounts.js";

function createNestedMockEnv(innerData, extraEnv = {}) {
  const doc = { schema: "v1", meta: {}, data: JSON.parse(JSON.stringify(innerData)) };
  return {
    SUPABASE_URL: "https://mock.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "mock_service_key",
    ...extraEnv,
    fetch: async () => new Response(JSON.stringify([{ data: doc, updated_at: "2026-08-10T12:00:00.000Z" }]), { status: 200 }),
  };
}

const BASE_DOC = {
  cuentas: [
    {
      cuentaID: "CTA-0001", tipoCuenta: "Banco", tipoProducto: "Ahorro", nombreCuenta: "Banreservas Ahorro",
      entidad: "Banreservas", numeroCuenta: "000-000-000", titular: "Dalfina Guzman",
      documentoTitular: "000-0000000-0", tipoDocumentoTitular: "Cedula", estado: "Activo",
    },
    {
      cuentaID: "CTA-0002", tipoCuenta: "Banco", tipoProducto: "Corriente", nombreCuenta: "Popular Corriente",
      entidad: "Banco Popular", numeroCuenta: "111-111-111", titular: "Dalfi Studio SRL",
      documentoTitular: "1-01-00000-1", tipoDocumentoTitular: "RNC", estado: "Activo",
    },
    {
      cuentaID: "CTA-0003", tipoCuenta: "Banco", tipoProducto: "Ahorro", nombreCuenta: "Cuenta inactiva",
      entidad: "BHD", numeroCuenta: "222-222-222", titular: "Dalfina Guzman",
      documentoTitular: "000-0000000-0", tipoDocumentoTitular: "Cedula", estado: "Inactivo",
    },
    {
      cuentaID: "CTA-0004", tipoCuenta: "Caja Chica", tipoProducto: "", nombreCuenta: "Caja chica salón",
      entidad: "", numeroCuenta: "", titular: "", documentoTitular: "", estado: "Activo",
    },
  ],
};

test("GET /bank-accounts requiere x-chatbot-secret cuando CHATBOT_SECRET está configurado", async () => {
  const env = createNestedMockEnv(BASE_DOC, { CHATBOT_SECRET: "secreto-real" });
  const req = new Request("https://localhost/api/booking/bank-accounts");
  const res = await bankAccountsGet({ request: req, env });
  assert.equal(res.status, 401);
});

test("GET /bank-accounts devuelve solo cuentas tipo Banco y activas, con los 5 campos pedidos", async () => {
  const env = createNestedMockEnv(BASE_DOC, { CHATBOT_SECRET: "secreto-real" });
  const req = new Request("https://localhost/api/booking/bank-accounts", {
    headers: { "x-chatbot-secret": "secreto-real" },
  });
  const res = await bankAccountsGet({ request: req, env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  assert.equal(data.accounts.length, 2, "excluye la cuenta inactiva y la caja chica");

  const banreservas = data.accounts.find((a) => a.banco === "Banreservas");
  assert.deepEqual(banreservas, {
    id: "CTA-0001", banco: "Banreservas", tipoCuenta: "Ahorro", numeroCuenta: "000-000-000",
    titular: "Dalfina Guzman", documento: "000-0000000-0", tipoDocumento: "Cedula",
  });

  const popular = data.accounts.find((a) => a.banco === "Banco Popular");
  assert.equal(popular.tipoDocumento, "RNC", "una cuenta a nombre de una empresa reporta RNC, no Cédula");
  assert.equal(popular.titular, "Dalfi Studio SRL");

  assert.ok(!data.accounts.some((a) => a.banco === "BHD"), "la cuenta inactiva no aparece");
});

test("GET /bank-accounts funciona sin secreto cuando CHATBOT_SECRET no está configurado (modo local/dev)", async () => {
  const env = createNestedMockEnv(BASE_DOC);
  const req = new Request("https://localhost/api/booking/bank-accounts");
  const res = await bankAccountsGet({ request: req, env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.accounts.length, 2);
});
