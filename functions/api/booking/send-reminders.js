// Endpoint pensado para ser llamado por un Cloudflare Worker con Cron Trigger
// (ver CRON.md en la raiz del proyecto). Envia por WhatsApp, via el Chatbot
// Bridge, los recordatorios horarios de citas "Preaprobadas" del chatbot que
// estan dentro de la ventana de 4h antes de la cita, y escala a un agente
// humano las que llegaron a su hora sin haber sido confirmadas en el salon.
//
// No depende de que ningun navegador tenga la app abierta (antes este
// recordatorio solo existia como un banner visual en la Matriz Consolidada,
// que no dispara nada si nadie mira esa pantalla) — es un port del mismo
// criterio de checkPreapprovedConfirmationReminder() usado ahi.
//
// Seguridad: requiere un header "x-cron-secret" que coincida con
// BOOKING_REMINDER_CRON_SECRET (Cloudflare Pages, variable secreta). El envio
// al bridge se autentica con ERP_WEBHOOK_SECRET (x-webhook-secret), el mismo
// secreto compartido que usa notify-invoice-sent.js.

import { insertAuditLog } from "../_lib/audit.js";
import { checkPreapprovedConfirmationReminder, generateWhatsAppReceiptText } from "../../../outputs/lib/booking-engine.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Estados en los que una reserva ya no necesita recordatorio ni escalacion.
// "No confirmada" ya fue escalada una vez (por eso llegó a este estado) y su
// horario quedó liberado — seguir mandando recordatorios sobre ella no tiene
// sentido; su resolución depende de que el salón la confirme a mano o de que
// otra reserva tome el horario (ver confirm.js), no de este cron.
const CLOSED_STATUSES = new Set(["Confirmada", "Cancelada", "Anulada", "Completada", "No asistió", "No asistio", "No confirmada"]);

async function loadDocument(supabaseUrl, serviceRoleKey) {
  const response = await fetch(`${supabaseUrl}/rest/v1/erp_records?table_name=eq.app&record_key=eq.database&select=data,updated_at`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!response.ok) throw new Error(`No se pudo leer erp_records (HTTP ${response.status}).`);
  const rows = await response.json().catch(() => []);
  const document = rows?.[0]?.data;
  if (!document?.data) throw new Error("erp_records no tiene un documento 'app/database' valido.");
  return { document, updatedAt: rows?.[0]?.updated_at || null };
}

async function saveDocument(supabaseUrl, serviceRoleKey, document, expectedUpdatedAt) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/save_erp_record_if_current`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    body: JSON.stringify({ p_table_name: "app", p_record_key: "database", p_data: document, p_expected_updated_at: expectedUpdatedAt }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`No se pudo guardar erp_records (HTTP ${response.status}): ${body}`);
  }
  const result = (await response.json().catch(() => []))?.[0];
  if (!result?.saved) {
    const error = new Error("Conflicto de concurrencia: otra sesion actualizo erp_records antes que este cron. No se sobrescribio ningun dato.");
    error.status = 409;
    throw error;
  }
  return result.new_updated_at || null;
}

async function sendToBridge(bridgeUrl, webhookSecret, body) {
  const response = await fetch(bridgeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-webhook-secret": webhookSecret },
    body: JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body: responseBody };
}

export async function onRequestPost({ request, env }) {
  const expectedSecret = env.BOOKING_REMINDER_CRON_SECRET;
  if (!expectedSecret) return json({ error: "Falta configurar BOOKING_REMINDER_CRON_SECRET en Cloudflare Pages." }, 500);
  if ((request.headers.get("x-cron-secret") || "") !== expectedSecret) return json({ error: "Secreto de cron invalido." }, 401);

  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Faltan variables privadas de Supabase en Cloudflare Pages." }, 500);
  if (!env.ERP_WEBHOOK_SECRET) return json({ error: "Falta configurar ERP_WEBHOOK_SECRET en Cloudflare Pages." }, 500);

  const bridgeBase = (env.CHATBOT_BRIDGE_URL || "https://bot.sebengroup.com").replace(/\/$/, "");
  const bridgeUrl = `${bridgeBase}/webhook/overdue-reminders`;

  let document;
  let documentUpdatedAt;
  try {
    const loaded = await loadDocument(supabaseUrl, serviceRoleKey);
    document = loaded.document;
    documentUpdatedAt = loaded.updatedAt;
  } catch (error) {
    return json({ error: error.message }, 500);
  }

  const data = document.data;
  const appointments = Array.isArray(data.reservas) ? data.reservas : [];
  const businessSchedule = data.businessSchedule || {};
  const nowIso = new Date().toISOString();

  let remindersSent = 0;
  let escalationsSent = 0;
  const failures = [];

  for (const apt of appointments) {
    const status = String(apt.estado || "").trim();
    if (CLOSED_STATUSES.has(status)) continue;

    const check = checkPreapprovedConfirmationReminder(apt, nowIso, businessSchedule);
    if (!check.requiresConfirmationAlert) continue;

    const phoneDigits = String(apt.telefono || apt.phone || "").replace(/[^\d]/g, "");
    if (!phoneDigits) continue;

    const shouldEscalate = check.hoursUntilAppointment <= 0 && !apt.escalatedAt;
    const shouldRemind = !shouldEscalate && apt.lastReminderCycleSent !== check.hourlyCycle;
    if (!shouldEscalate && !shouldRemind) continue;

    const eventType = shouldEscalate ? "booking.preapproved_escalation" : "booking.preapproved_reminder";
    const receiptText = generateWhatsAppReceiptText({
      eventType,
      clientName: apt.clienteNombre || "Cliente",
      date: apt.fecha,
      time: apt.hora,
      serviceName: apt.servicio,
      staffName: apt.colaboradorNombre,
    });

    try {
      const result = await sendToBridge(bridgeUrl, env.ERP_WEBHOOK_SECRET, {
        event: eventType,
        actionRequired: shouldEscalate ? "escalate_to_human_agent" : "send_customer_reminder",
        reservationId: apt.reservaID,
        recipientPhone: phoneDigits,
        whatsappFormattedText: receiptText,
      });
      if (!result.ok) {
        failures.push({ reservaID: apt.reservaID, status: result.status, body: result.body });
        continue;
      }
      if (shouldEscalate) {
        apt.escalatedAt = nowIso;
        // Nadie confirmó a tiempo: libera el horario (calculateAvailableSlots
        // trata "No confirmada" igual que una cancelación) en vez de dejarlo
        // bloqueado indefinidamente. Si el salón la confirma antes de que
        // alguien más tome ese horario, vuelve a "Confirmada" (ver la guarda
        // ALREADY_REASSIGNED en confirm.js); si alguien más lo toma primero,
        // esta cita queda "Reprogramada" automáticamente en ese mismo momento.
        apt.estado = "No confirmada";
        escalationsSent += 1;
      } else {
        apt.lastReminderCycleSent = check.hourlyCycle;
        apt.lastReminderSentAt = nowIso;
        remindersSent += 1;
      }
    } catch (error) {
      failures.push({ reservaID: apt.reservaID, error: error.message });
    }
  }

  if (remindersSent > 0 || escalationsSent > 0) {
    try {
      await saveDocument(supabaseUrl, serviceRoleKey, document, documentUpdatedAt);
    } catch (error) {
      return json({ error: error.message, remindersSent, escalationsSent, failures }, error.status || 500);
    }
  }

  await insertAuditLog(env, {
    tableName: "reservas",
    entityId: nowIso.slice(0, 10),
    action: "booking_reminder_cron_run",
    newData: { remindersSent, escalationsSent, failures },
    userId: null,
    userEmail: "cron:booking-reminders",
    userRole: "system",
    success: failures.length === 0,
    note: `Ejecucion automatica del cron de recordatorios de citas preaprobadas. Recordatorios: ${remindersSent}. Escalaciones: ${escalationsSent}. Fallos: ${failures.length}.`,
  }).catch(() => null);

  return json({ ok: true, remindersSent, escalationsSent, failures });
}

export async function onRequest() {
  return json({ error: "Metodo no permitido." }, 405);
}
