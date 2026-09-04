// Endpoint server-side que reenvia al Chatbot Bridge el aviso de factura enviada
// (dispara la solicitud de resena por WhatsApp). Existe para que el secreto
// compartido con el bridge (ERP_WEBHOOK_SECRET) nunca viaje al navegador: antes
// outputs/app.js llamaba directo al bridge desde el cliente, lo que exponia el
// secreto a cualquiera que abriera las herramientas de desarrollador.
//
// Requiere sesion valida de un usuario del ERP (misma validacion que el resto de
// functions/api/*.js) — no usa CHATBOT_SECRET porque quien llama es el navegador
// del ERP, no el Chatbot Bridge.

import { resolveRequester } from "../_lib/audit.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function onRequestPost({ request, env }) {
  const requester = await resolveRequester(request, env);
  if (!requester) return json({ error: "Sesion invalida. Vuelve a iniciar sesion." }, 401);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Solicitud JSON invalida." }, 400);
  }

  const { invoiceId, clientPhone, clientName, whatsappFormattedText } = payload || {};
  const phoneDigits = String(clientPhone || "").replace(/[^\d]/g, "");
  if (!phoneDigits || !whatsappFormattedText) {
    return json({ error: "Falta telefono o texto del recibo del cliente." }, 400);
  }

  if (!env.ERP_WEBHOOK_SECRET) {
    return json({ error: "Falta configurar ERP_WEBHOOK_SECRET en Cloudflare Pages." }, 500);
  }

  const bridgeBase = (env.CHATBOT_BRIDGE_URL || "https://bot.dalfistudio.com").replace(/\/$/, "");
  const safeFetch = env.fetch || fetch;

  let response;
  try {
    response = await safeFetch(`${bridgeBase}/webhook/invoice-sent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-secret": env.ERP_WEBHOOK_SECRET },
      body: JSON.stringify({
        event: "invoice.sent",
        actionRequired: "send_customer_review_request",
        recipientPhone: phoneDigits,
        clientName: clientName || "Cliente",
        invoiceId,
        whatsappFormattedText,
      }),
    });
  } catch (error) {
    return json({ error: `No se pudo contactar el bridge del chatbot: ${error.message}` }, 502);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return json({ error: `El bridge devolvio status ${response.status}: ${JSON.stringify(body)}` }, 502);
  }

  return json({ success: true, result: body });
}

export async function onRequest() {
  return json({ error: "Metodo no permitido." }, 405);
}
