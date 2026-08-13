import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../functions/api/calendar/google-pull.js";

test("Google Calendar nunca puede importar ni modificar citas de la ERP", async () => {
  const response = await onRequest();
  const body = await response.json();

  assert.equal(response.status, 410);
  assert.equal(body.success, false);
  assert.equal(body.code, "CALENDAR_IMPORT_DISABLED");
});
