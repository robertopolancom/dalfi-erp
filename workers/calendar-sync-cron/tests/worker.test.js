import test from "node:test";
import assert from "node:assert/strict";
import { runCalendarPull } from "../worker.js";

test("calendar worker llama al endpoint con secreto en cabecera y sin reintentos", async () => {
  let call;
  const result = await runCalendarPull({
    APP_BASE_URL: "https://dalfi-erp.pages.dev",
    GOOGLE_CALENDAR_SYNC_SECRET: "secret-ficticio",
  }, async (url, options) => {
    call = { url, options };
    return new Response("{}", { status: 200 });
  });
  assert.equal(result.ok, true);
  assert.equal(call.url, "https://dalfi-erp.pages.dev/api/calendar/google-pull");
  assert.equal(call.options.headers["x-calendar-sync-secret"], "secret-ficticio");
});

test("calendar worker exige configuración y no imprime el secreto", async () => {
  await assert.rejects(() => runCalendarPull({ APP_BASE_URL: "https://dalfi-erp.pages.dev" }, async () => new Response("{}")), /MISSING_GOOGLE_CALENDAR_SYNC_SECRET/);
});
