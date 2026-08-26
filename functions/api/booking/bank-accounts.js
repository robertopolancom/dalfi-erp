// Endpoint para el Chatbot Bridge: cuentas bancarias activas para mostrar cuando una
// cliente elige "Enviar comprobante de pago -> Transferencia bancaria". Requiere
// x-chatbot-secret (igual que clients.js) porque expone número de cuenta y cédula/RNC del
// titular — más sensible que el catálogo de servicios/colaboradoras (services.js/staff.js),
// que son públicos sin secreto.

import { validateChatbotSecret } from "./_auth.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function serviceHeaders(env) {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
}

export async function onRequestGet({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Persistencia no configurada." }, 500);
  }

  if (!validateChatbotSecret(request, env)) {
    return json({ success: false, error: "No autorizado. Se requiere x-chatbot-secret o Bearer token dedicado del Chatbot Bridge." }, 401);
  }

  const safeFetch = env.fetch || fetch;

  try {
    const response = await safeFetch(
      `${env.SUPABASE_URL}/rest/v1/erp_records?table_name=eq.app&record_key=eq.database&select=data`,
      { headers: serviceHeaders(env) }
    );
    if (!response.ok) return json({ error: "No se pudo consultar las cuentas bancarias." }, 502);

    const rows = await response.json().catch(() => []);
    const doc = rows?.[0]?.data || {};
    const docData = doc.data || doc;
    const accountList = Array.isArray(docData.cuentas) ? docData.cuentas : [];

    const activeBankAccounts = accountList
      .filter((a) => String(a.tipoCuenta || "") === "Banco" && String(a.estado || "Activo").toLowerCase() === "activo")
      .map((a) => ({
        id: String(a.cuentaID || a.id),
        banco: a.entidad || "",
        tipoCuenta: a.tipoProducto || "",
        numeroCuenta: a.numeroCuenta || "",
        titular: a.titular || "",
        documento: a.documentoTitular || "",
        tipoDocumento: a.tipoDocumentoTitular || "Cedula",
      }))
      .filter((a) => a.banco && a.numeroCuenta);

    return json({ success: true, accounts: activeBankAccounts });
  } catch (error) {
    return json({ error: `Error al consultar cuentas bancarias: ${error.message}` }, 500);
  }
}
