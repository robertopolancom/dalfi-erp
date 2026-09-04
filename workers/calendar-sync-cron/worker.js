--6ba0b240d7ec1873beabca464ba8438b2a21e28ccdddd782a3bc3a8ad1b2
Content-Disposition: form-data; name="worker.js"

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var DEFAULT_TIMEOUT_MS = 2e4;
async function runCalendarPull(env, fetchImpl = fetch) {
  if (!env.APP_BASE_URL) throw new Error("MISSING_APP_BASE_URL");
  if (!env.GOOGLE_CALENDAR_SYNC_SECRET) throw new Error("MISSING_GOOGLE_CALENDAR_SYNC_SECRET");
  const endpoint = new URL("/api/calendar/google-pull", env.APP_BASE_URL).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env.REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "x-calendar-sync-secret": env.GOOGLE_CALENDAR_SYNC_SECRET },
      signal: controller.signal
    });
    const result = { ok: response.ok, status: response.status, durationMs: Date.now() - startedAt };
    console.log(JSON.stringify({ job: "dalfi-erp-calendar-pull", ...result, outcome: response.ok ? "success" : "http_error" }));
    if (!response.ok) throw new Error(`CALENDAR_PULL_HTTP_${response.status}`);
    return result;
  } catch (error) {
    if (error?.name === "AbortError") console.log(JSON.stringify({ job: "dalfi-erp-calendar-pull", ok: false, outcome: "timeout" }));
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
__name(runCalendarPull, "runCalendarPull");
var worker_default = {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCalendarPull(env).catch((error) => console.error(`dalfi-erp-calendar-pull: ${error.message}`)));
  }
};
export {
  worker_default as default,
  runCalendarPull
};
//# sourceMappingURL=worker.js.map

--6ba0b240d7ec1873beabca464ba8438b2a21e28ccdddd782a3bc3a8ad1b2--
