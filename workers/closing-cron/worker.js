// Worker programado (Cloudflare Cron Trigger) para dalfi-erp.
//
// Responsabilidad UNICA: en cada disparo, hacer una llamada HTTP autenticada
// a la Pages Function que ya existe en este repo
// (functions/api/run-closing-catchup.js) para que genere los cierres
// "sin confirmar" pendientes cuando nadie tiene el ERP abierto en el
// navegador. Este Worker NUNCA accede a Supabase directamente ni duplica
// ninguna regla de negocio de cierres (fecha comercial, filtros de
// transferencia/anulado, saldo inicial, etc.): toda esa logica sigue viviendo
// unicamente en functions/api/run-closing-catchup.js (y en su espejo de
// outputs/app.js), tal como documenta functions/CRON.md.
//
// Cloudflare Pages no soporta Cron Triggers directamente sobre sus Pages
// Functions; por eso este Worker vive en un proyecto Wrangler separado
// (workers/closing-cron/), con su propio wrangler.toml y su propio
// [triggers] crons, y solo se comunica con Pages por HTTP.

const DEFAULT_TIMEOUT_MS = 20000;

function nowIso() {
  return new Date().toISOString();
}

// Registra unicamente datos no sensibles: nunca el secreto, nunca la
// cabecera Authorization completa, nunca el cuerpo crudo de la respuesta.
// Ver seccion "Logs seguros" del encargo y workers/closing-cron/README.md.
function logResult({ ok, status, durationMs, outcome }) {
  const safeStatus = Number.isInteger(status) ? status : 0;
  console.log(
    JSON.stringify({
      job: "dalfi-erp-closing-cron",
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
async function runClosingCron(env, fetchImpl = fetch) {
  const baseUrl = env.APP_BASE_URL;
  const secret = env.CLOSING_CRON_SECRET;
  const timeoutMs = Number(env.REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  if (!baseUrl) {
    throw new Error("Falta configurar APP_BASE_URL en el Worker.");
  }
  if (!secret) {
    throw new Error("Falta configurar el secret CLOSING_CRON_SECRET en el Worker.");
  }

  // new URL(...) valida el formato de APP_BASE_URL antes de usarlo (evita
  // construir una URL invalida a partir de una variable mal configurada).
  const endpoint = new URL("/api/run-closing-catchup", baseUrl).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    // El secreto SIEMPRE va en una cabecera, nunca en la query string (no
    // queda registrado en logs de acceso/URL con tanta facilidad como una
    // query string lo haria).
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "x-cron-secret": secret },
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      logResult({ ok: false, status: response.status, durationMs, outcome: "http_error" });
      throw new Error(`El catch-up de cierres respondio ${response.status}.`);
    }

    logResult({ ok: true, status: response.status, durationMs, outcome: "success" });
    return { ok: true, status: response.status, durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (error.name === "AbortError") {
      logResult({ ok: false, status: 0, durationMs, outcome: "timeout" });
      throw new Error(`El catch-up de cierres no respondio dentro de ${timeoutMs}ms (timeout).`);
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
    // cron es la recuperacion natural. El endpoint ya es idempotente
    // (registerClosingForDate/treasuryClosingForDate no crean un cierre si ya
    // existe uno para esa fecha), asi que una ejecucion de mas nunca duplica
    // cierres.
    ctx.waitUntil(
      runClosingCron(env).catch((error) => {
        // No se relanza mas alla de aqui: Cloudflare ya registra que
        // scheduled() fallo via el log de arriba y las metricas del Worker;
        // relanzar solo agregaria un stack trace sin informacion nueva.
        console.error(`dalfi-erp-closing-cron: ${error.message}`);
      }),
    );
  },
};

export { runClosingCron };
