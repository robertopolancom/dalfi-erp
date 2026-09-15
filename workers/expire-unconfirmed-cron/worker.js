// Worker programado (Cloudflare Cron Trigger) para el backend real de Dalfi ERP.
//
// Responsabilidad UNICA: en cada disparo, llamar a POST /api/booking/expire-unconfirmed en
// server/app.mjs para que cierre como "No asistio" las citas que nadie confirmo y cuya hora ya
// paso. Este Worker NUNCA accede a Neon ni duplica la regla: que cuenta como "ya paso", que
// margen se da y que estados se tocan vive en server/store.mjs
// (expireUnconfirmedPastAppointments). Mismo patron que workers/deposit-receipt-purge-cron/.
//
// Por que existe: una cita sin confirmar no aparta el horario (migracion 0024). Si el cliente
// hubiera venido, alguien le habria puesto "Atendida". Dejarla en 'scheduled' para siempre hace
// que el calendario mienta sobre que paso ese dia, y ensucia la agenda del equipo.

const DEFAULT_TIMEOUT_MS = 20000;
// Margen por defecto: sin el, una cita que acaba de terminar se cerraria sola mientras la
// manicurista todavia esta cobrando y aun no le ha dado a "Atendida".
const DEFAULT_GRACE_MINUTES = 120;

function nowIso() {
  return new Date().toISOString();
}

// Registra unicamente datos no sensibles: nunca el secreto, nunca el cuerpo crudo.
function logResult({ ok, status, durationMs, outcome, expiredCount }) {
  const safeStatus = Number.isInteger(status) ? status : 0;
  console.log(
    JSON.stringify({
      job: "dalfi-erp-expire-unconfirmed-cron",
      at: nowIso(),
      ok,
      status: safeStatus,
      durationMs,
      outcome,
      ...(Number.isInteger(expiredCount) ? { expiredCount } : {}),
    }),
  );
}

// Nucleo testable: recibe env y un fetch inyectable (para pruebas con mocks, nunca red real).
async function runExpireUnconfirmedCron(env, fetchImpl = fetch) {
  const baseUrl = env.APP_BASE_URL;
  const secret = env.EXPIRE_UNCONFIRMED_CRON_SECRET;
  const timeoutMs = Number(env.REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const graceMinutes = Number.isFinite(Number(env.GRACE_MINUTES)) ? Number(env.GRACE_MINUTES) : DEFAULT_GRACE_MINUTES;

  if (!baseUrl) {
    throw new Error("Falta configurar APP_BASE_URL en el Worker.");
  }
  if (!secret) {
    throw new Error("Falta configurar el secret EXPIRE_UNCONFIRMED_CRON_SECRET en el Worker.");
  }

  // new URL(...) valida el formato de APP_BASE_URL antes de usarlo.
  const endpoint = new URL("/api/booking/expire-unconfirmed", baseUrl).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    // El secreto SIEMPRE va en una cabecera, nunca en la query string.
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "x-cron-secret": secret, "Content-Type": "application/json" },
      body: JSON.stringify({ graceMinutes }),
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      logResult({ ok: false, status: response.status, durationMs, outcome: "http_error" });
      throw new Error(`El cierre de citas sin confirmar respondio ${response.status}.`);
    }

    // Cuantas se cerraron es lo unico que interesa del cuerpo, y es un numero: si el JSON viene
    // roto no se rompe el Worker -- la llamada ya funciono, que es lo que importa.
    const body = await response.json().catch(() => ({}));
    const expiredCount = Number.isInteger(body?.expiredCount) ? body.expiredCount : undefined;
    logResult({ ok: true, status: response.status, durationMs, outcome: "success", expiredCount });
    return { ok: true, status: response.status, durationMs, expiredCount };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (error.name === "AbortError") {
      logResult({ ok: false, status: 0, durationMs, outcome: "timeout" });
      throw new Error(`El cierre de citas sin confirmar no respondio dentro de ${timeoutMs}ms (timeout).`);
    }
    if (!(error instanceof Error) || !/respondio \d+\./.test(error.message)) {
      logResult({ ok: false, status: 0, durationMs, outcome: "network_error" });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async scheduled(controllerEvent, env, ctx) {
    // Una sola solicitud por ejecucion: si falla, la del dia siguiente es la recuperacion
    // natural. El endpoint es idempotente por diseño (WHERE status='scheduled'): una ejecucion
    // de mas no vuelve a tocar nada ya cerrado.
    ctx.waitUntil(
      runExpireUnconfirmedCron(env).catch((error) => {
        console.error(`dalfi-erp-expire-unconfirmed-cron: ${error.message}`);
      }),
    );
  },
};

export { runExpireUnconfirmedCron };
