// Worker programado (Cloudflare Cron Trigger) para dalfi-erp.
//
// Responsabilidad UNICA: en cada disparo, hacer una llamada HTTP autenticada
// a la Pages Function que ya existe en este repo
// (functions/api/booking/send-reminders.js) para que envie los recordatorios
// horarios de citas "Preaprobadas" del chatbot y las escale (marcandolas
// "No confirmada" y liberando su horario) cuando llegan a su hora sin
// confirmarse. Este Worker NUNCA accede a Supabase directamente ni duplica
// ninguna regla de negocio de reservas (ventana de 4h, calculo de
// disponibilidad, reasignacion de horario, etc.): toda esa logica sigue
// viviendo unicamente en functions/api/booking/send-reminders.js y en
// outputs/lib/booking-engine.js, tal como documenta functions/CRON.md.
//
// Cloudflare Pages no soporta Cron Triggers directamente sobre sus Pages
// Functions; por eso este Worker vive en un proyecto Wrangler separado
// (workers/booking-reminder-cron/), con su propio wrangler.toml y su propio
// [triggers] crons, y solo se comunica con Pages por HTTP. Mismo patron que
// workers/closing-cron/.

const DEFAULT_TIMEOUT_MS = 20000;

function nowIso() {
  return new Date().toISOString();
}

// Registra unicamente datos no sensibles: nunca el secreto, nunca la
// cabecera Authorization completa, nunca el cuerpo crudo de la respuesta.
function logResult({ ok, status, durationMs, outcome }) {
  const safeStatus = Number.isInteger(status) ? status : 0;
  console.log(
    JSON.stringify({
      job: "dalfi-erp-booking-reminder-cron",
      at: nowIso(),
      ok,
      status: safeStatus,
      durationMs,
      outcome,
    }),
  );
}

// Nucleo testable: recibe env y un fetch inyectable (para pruebas con mocks,
// nunca red real) en vez de usar el global directamente.
async function runBookingReminderCron(env, fetchImpl = fetch) {
  const baseUrl = env.APP_BASE_URL;
  const secret = env.BOOKING_REMINDER_CRON_SECRET;
  const timeoutMs = Number(env.REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  if (!baseUrl) {
    throw new Error("Falta configurar APP_BASE_URL en el Worker.");
  }
  if (!secret) {
    throw new Error("Falta configurar el secret BOOKING_REMINDER_CRON_SECRET en el Worker.");
  }

  // new URL(...) valida el formato de APP_BASE_URL antes de usarlo (evita
  // construir una URL invalida a partir de una variable mal configurada).
  const endpoint = new URL("/api/booking/send-reminders", baseUrl).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    // El secreto SIEMPRE va en una cabecera, nunca en la query string.
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "x-cron-secret": secret },
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      logResult({ ok: false, status: response.status, durationMs, outcome: "http_error" });
      throw new Error(`El envio de recordatorios respondio ${response.status}.`);
    }

    logResult({ ok: true, status: response.status, durationMs, outcome: "success" });
    return { ok: true, status: response.status, durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (error.name === "AbortError") {
      logResult({ ok: false, status: 0, durationMs, outcome: "timeout" });
      throw new Error(`El envio de recordatorios no respondio dentro de ${timeoutMs}ms (timeout).`);
    }
    if (!(error instanceof Error) || !/respondio \d+\./.test(error.message)) {
      // Error de red (DNS, conexion rechazada, etc.), no un error HTTP ya logueado arriba.
      logResult({ ok: false, status: 0, durationMs, outcome: "network_error" });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async scheduled(controllerEvent, env, ctx) {
    // Una sola solicitud por ejecucion (sin reintentos agresivos dentro de la
    // misma ejecucion): si esta falla, la siguiente ejecucion programada del
    // cron (una hora despues) es la recuperacion natural. send-reminders.js
    // ya es idempotente por ciclo horario (apt.lastReminderCycleSent) y por
    // escalacion (apt.escalatedAt), asi que una ejecucion de mas nunca
    // duplica recordatorios ni vuelve a escalar/marcar "No confirmada" algo
    // que ya se proceso.
    ctx.waitUntil(
      runBookingReminderCron(env).catch((error) => {
        console.error(`dalfi-erp-booking-reminder-cron: ${error.message}`);
      }),
    );
  },
};

export { runBookingReminderCron };
