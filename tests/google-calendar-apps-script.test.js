import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const codePath = new URL("../integrations/google-calendar-apps-script/Code.gs", import.meta.url);
const manifestPath = new URL("../integrations/google-calendar-apps-script/appsscript.json", import.meta.url);

test("Apps Script implementa POST autenticado y nunca contiene un secreto literal", async () => {
  const source = await readFile(codePath, "utf8");
  assert.match(source, /function doPost\(e\)/);
  assert.match(source, /PropertiesService\.getScriptProperties\(\)/);
  assert.match(source, /DALFI_WEBHOOK_SECRET/);
  assert.match(source, /safeEquals_/);
  assert.doesNotMatch(source, /fake-webhook-secret|AIza|BEGIN PRIVATE KEY/);
});

test("Apps Script crea, actualiza y elimina el mismo evento mediante un mapeo estable", async () => {
  const source = await readFile(codePath, "utf8");
  assert.match(source, /mappingKey_\(input\.appointmentId\)/);
  assert.match(source, /calendar\.getEventById\(storedEventId\)/);
  assert.match(source, /calendar\.createEvent\(/);
  assert.match(source, /existingEvent\.deleteEvent\(\)/);
  assert.match(source, /existingEvent[\s\S]*\.setTime\(input\.start, input\.end\)/);
});

test("Apps Script soporta listar eventos externos y reclamar el evento importado", async () => {
  const source = await readFile(codePath, "utf8");
  assert.match(source, /\["upsert", "delete", "list", "claim"\]/);
  assert.match(source, /calendar\.getEvents\(input\.from, input\.to\)/);
  assert.match(source, /action === "claim"/);
  assert.match(source, /properties\.setProperty\(key \+ "_meta"/);
  assert.match(source, /Reserva ERP:/);
});

test("Apps Script no registra payloads ni datos personales", async () => {
  const source = await readFile(codePath, "utf8");
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*(?:payload|description|client|secret)/i);
  assert.match(source, /console\.error\("dalfi-calendar: "/);
});

test("el manifiesto fija Santo Domingo y solo solicita Calendar", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.timeZone, "America/Santo_Domingo");
  assert.deepEqual(manifest.oauthScopes, ["https://www.googleapis.com/auth/calendar"]);
});
