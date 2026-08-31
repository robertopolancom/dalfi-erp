// Worker programado (Cloudflare Cron Trigger) para el backend real de Dalfi ERP (Render + Neon).
//
// Responsabilidad UNICA: en cada disparo, hacer una llamada HTTP autenticada a
// POST /api/booking/purge-deposit-receipts en server/app.mjs (Render, dominio
// ssc.sebengroup.com) para que borre SOLO la foto (nunca la fila ni la cita) del comprobante de
// depósito de citas que llevan 5+ días Atendidas o Canceladas. Este Worker NUNCA accede a Neon
// directamente ni duplica ninguna regla de negocio (qué cuenta como "5 días", qué estados
// disparan la limpieza, etc.): toda esa lógica vive en server/store.mjs
// (purgeExpiredDepositReceipts). Mismo patrón que workers/booking-reminder-cron/.

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
      job: "dalfi-erp-deposit-receipt-purge-cron",
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
async function runDepositReceiptPurgeCron(env, fetchImpl = fetch) {
  const baseUrl = env.APP_BASE_URL;
  const secret = env.DEPOSIT_RECEIPT_PURGE_CRON_SECRET;
  const timeoutMs = Number(env.REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  if (!baseUrl) {
    throw new Error("Falta configurar APP_BASE_URL en el Worker.");
  }
  if (!secret) {
    throw new Error("Falta configurar el secret DEPOSIT_RECEIPT_PURGE_CRON_SECRET en el Worker.");
  }

  // new URL(...) valida el formato de APP_BASE_URL antes de usarlo (evita
  // construir una URL invalida a partir de una variable mal configurada).
  const endpoint = new URL("/api/booking/purge-deposit-receipts", baseUrl).toString();

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
      throw new Error(`La limpieza de comprobantes respondio ${response.status}.`);
    }

    logResult({ ok: true, status: response.status, durationMs, outcome: "success" });
    return { ok: true, status: response.status, durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (error.name === "AbortError") {
      logResult({ ok: false, status: 0, durationMs, outcome: "timeout" });
      throw new Error(`La limpieza de comprobantes no respondio dentro de ${timeoutMs}ms (timeout).`);
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
    // Una sola solicitud por ejecucion (sin reintentos agresivos dentro de la misma ejecucion):
    // si esta falla, la ejecucion programada del dia siguiente es la recuperacion natural. El
    // endpoint es idempotente por diseño (WHERE image_data IS NOT NULL): una ejecucion de mas
    // nunca falla ni vuelve a tocar un comprobante ya purgado.
    ctx.waitUntil(
      runDepositReceiptPurgeCron(env).catch((error) => {
        console.error(`dalfi-erp-deposit-receipt-purge-cron: ${error.message}`);
      }),
    );
  },
};

export { runDepositReceiptPurgeCron };
