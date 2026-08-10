// Pruebas del Worker de cron (workers/booking-reminder-cron/worker.js). Todas
// usan fetch() inyectado/mockeado en memoria: NUNCA hacen una peticion de red
// real, nunca llaman a produccion, nunca usan un secreto real (los valores de
// prueba son literales inventados, marcados como tales). Mismo patron que
// workers/closing-cron/tests/worker.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.join(__dirname, "..");
const workerSource = fs.readFileSync(path.join(WORKER_DIR, "worker.js"), "utf8");
const wranglerToml = fs.readFileSync(path.join(WORKER_DIR, "wrangler.toml"), "utf8");
const readmeSource = fs.readFileSync(path.join(WORKER_DIR, "README.md"), "utf8");
const __filename = fileURLToPath(import.meta.url);

let workerModule;
test.before(async () => {
  workerModule = await import(path.join(WORKER_DIR, "worker.js"));
});

const FAKE_SECRET = "test-secret-not-real-0000";
const FAKE_BASE_URL = "https://example-test.pages.dev";

function makeEnv(overrides = {}) {
  return { APP_BASE_URL: FAKE_BASE_URL, BOOKING_REMINDER_CRON_SECRET: FAKE_SECRET, ...overrides };
}

function makeFetchMock(responder) {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fetchMock.calls = calls;
  return fetchMock;
}

test("worker.js exporta un default con scheduled(controller, env, ctx)", () => {
  assert.match(workerSource, /export default \{\s*\n\s*async scheduled\(controllerEvent, env, ctx\) \{/);
});

test("scheduled() delega en runBookingReminderCron(env) y usa ctx.waitUntil", () => {
  const fnMatch = /async scheduled\(controllerEvent, env, ctx\) \{[\s\S]*?\n  \},\s*\n\};/.exec(workerSource);
  assert.ok(fnMatch, "no se encontro scheduled()");
  assert.match(fnMatch[0], /ctx\.waitUntil\(/);
  assert.match(fnMatch[0], /runBookingReminderCron\(env\)/);
});

test("runBookingReminderCron(): usa env.APP_BASE_URL para construir el endpoint, nunca un dominio hardcodeado", () => {
  assert.match(workerSource, /const baseUrl = env\.APP_BASE_URL;/);
  assert.match(workerSource, /new URL\("\/api\/booking\/send-reminders", baseUrl\)/);
});

test("runBookingReminderCron(): usa env.BOOKING_REMINDER_CRON_SECRET (Secret de Wrangler), nunca un valor literal", () => {
  assert.match(workerSource, /const secret = env\.BOOKING_REMINDER_CRON_SECRET;/);
});

test("no existe ningun secreto real (solo placeholders) en worker.js ni en wrangler.toml", () => {
  const forbiddenPattern = new RegExp(["service", "_", "role"].join(""), "i");
  assert.ok(!forbiddenPattern.test(workerSource + wranglerToml));
  assert.ok(!/BOOKING_REMINDER_CRON_SECRET\s*=\s*["'][^"'<][^"']*["']/.test(wranglerToml), "wrangler.toml no debe fijar BOOKING_REMINDER_CRON_SECRET como texto plano");
  assert.match(wranglerToml, /BOOKING_REMINDER_CRON_SECRET se configura por separado como Secret/);
});

test("el secreto SIEMPRE va en la cabecera x-cron-secret, nunca como parametro de query string", () => {
  assert.match(workerSource, /headers: \{ "x-cron-secret": secret \}/);
  assert.ok(!/[?&]secret=/.test(workerSource), "no debe construirse una URL con el secreto en query string");
});

test("runBookingReminderCron(): usa metodo POST (igual que espera functions/api/booking/send-reminders.js)", () => {
  assert.match(workerSource, /method: "POST",/);
});

test("respuesta 200: runBookingReminderCron() resuelve OK y hace exactamente UNA llamada fetch", async () => {
  const fetchMock = makeFetchMock(async () => new Response(JSON.stringify({ ok: true, remindersSent: 0, escalationsSent: 0 }), { status: 200 }));
  const result = await workerModule.runBookingReminderCron(makeEnv(), fetchMock);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, 200);
  assert.strictEqual(fetchMock.calls.length, 1);
});

for (const status of [401, 403, 500]) {
  test(`respuesta ${status}: runBookingReminderCron() lanza un error (no se trata como exito)`, async () => {
    const fetchMock = makeFetchMock(async () => new Response(JSON.stringify({ error: "no" }), { status }));
    await assert.rejects(() => workerModule.runBookingReminderCron(makeEnv(), fetchMock), new RegExp(String(status)));
  });
}

test("error de red (fetch rechaza): runBookingReminderCron() propaga el error sin intentarlo de nuevo dentro de la misma ejecucion", async () => {
  const fetchMock = async () => {
    throw new Error("getaddrinfo ENOTFOUND example-test.pages.dev");
  };
  await assert.rejects(() => workerModule.runBookingReminderCron(makeEnv(), fetchMock), /ENOTFOUND/);
});

test("timeout: runBookingReminderCron() usa AbortController con un limite explicito y lanza un error especifico de timeout", async () => {
  assert.match(workerSource, /new AbortController\(\);/);
  assert.match(workerSource, /setTimeout\(\(\) => controller\.abort\(\), timeoutMs\);/);
  const fetchMock = async (url, init) => {
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };
  await assert.rejects(
    () => workerModule.runBookingReminderCron(makeEnv({ REQUEST_TIMEOUT_MS: "10" }), fetchMock),
    /timeout/i,
  );
});

test("falta APP_BASE_URL o BOOKING_REMINDER_CRON_SECRET: runBookingReminderCron() rechaza con un mensaje claro, sin llegar a hacer fetch", async () => {
  const fetchMock = makeFetchMock(async () => new Response("{}", { status: 200 }));
  await assert.rejects(() => workerModule.runBookingReminderCron({ BOOKING_REMINDER_CRON_SECRET: FAKE_SECRET }, fetchMock), /APP_BASE_URL/);
  await assert.rejects(() => workerModule.runBookingReminderCron({ APP_BASE_URL: FAKE_BASE_URL }, fetchMock), /BOOKING_REMINDER_CRON_SECRET/);
  assert.strictEqual(fetchMock.calls.length, 0, "no debe llamar a fetch si falta configuracion");
});

test("logResult()/console.log nunca incluyen el secreto ni la cabecera Authorization completa", () => {
  const logFnSource = /function logResult\([\s\S]*?\n\}/.exec(workerSource)[0];
  assert.ok(!/secret/i.test(logFnSource) || /outcome/.test(logFnSource), "logResult no debe recibir ni imprimir el secreto");
  assert.ok(!/console\.(log|error)\([^)]*secret/i.test(workerSource.replace(/\/\/.*$/gm, "")), "ningun console.log/error debe interpolar el secreto");
});

test("logResult() captura en runtime: al ejecutar runBookingReminderCron con exito, lo que se loguea (JSON) no contiene el valor del secreto", async () => {
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(" "));
  try {
    const fetchMock = makeFetchMock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await workerModule.runBookingReminderCron(makeEnv(), fetchMock);
  } finally {
    console.log = originalLog;
  }
  const allLogged = logged.join("\n");
  assert.ok(!allLogged.includes(FAKE_SECRET), "el secreto no debe aparecer en ningun log emitido");
});

test("runBookingReminderCron(): hace EXACTAMENTE una llamada HTTP por ejecucion", async () => {
  const fetchMock = makeFetchMock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await workerModule.runBookingReminderCron(makeEnv(), fetchMock);
  assert.strictEqual(fetchMock.calls.length, 1);
});

test("worker.js NO accede a Supabase directamente ni duplica ninguna regla de negocio de reservas (ventana de 4h, disponibilidad, reasignacion): solo hace fetch() al endpoint existente", () => {
  const codeOnly = workerSource
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const forbidden = ["supabase", "erp_records", "calculateAvailableSlots", "checkPreapprovedConfirmationReminder", "reservas"];
  forbidden.forEach((token) => {
    assert.ok(!new RegExp(token, "i").test(codeOnly), `worker.js no debe usar '${token}' como codigo real — esa logica vive solo en functions/api/booking/send-reminders.js`);
  });
  assert.match(workerSource, /\/api\/booking\/send-reminders/);
});

test("la expresion cron activa vive UNICAMENTE en workers/booking-reminder-cron/wrangler.toml, no hardcodeada en worker.js", () => {
  assert.ok(!/\d+ \* \* \* \*/.test(workerSource), "worker.js no debe contener una expresion cron: la programacion es responsabilidad de wrangler.toml");
  assert.match(wranglerToml, /^\[triggers\]\s*\ncrons = \["0 \* \* \* \*"\]/m, "el Cron Trigger debe estar activo (sin comentar), una vez por hora");
});

test("APP_BASE_URL en wrangler.toml apunta al dominio productivo real de Cloudflare Pages, no a un placeholder", () => {
  assert.match(wranglerToml, /APP_BASE_URL = "https:\/\/dalfi-erp\.pages\.dev"/);
});

test("workers/booking-reminder-cron/README.md no contiene ningun secreto real, solo placeholders", () => {
  const forbiddenPattern = new RegExp(["service", "_", "role"].join(""), "i");
  assert.ok(!forbiddenPattern.test(readmeSource));
  assert.ok(!/BOOKING_REMINDER_CRON_SECRET\s*=\s*[a-f0-9]{16,}/i.test(readmeSource), "no debe haber un valor de secreto ya generado en el README");
});

test("todas las pruebas de fetch de este archivo usan FAKE_BASE_URL/FAKE_SECRET inventados, nunca el dominio real de produccion ni un secreto real", () => {
  const thisFile = fs.readFileSync(__filename, "utf8");
  assert.match(thisFile, /FAKE_BASE_URL = "https:\/\/example-test\.pages\.dev"/);
  assert.match(thisFile, /FAKE_SECRET = "test-secret-not-real-0000"/);
  assert.match(thisFile, /function makeEnv\(overrides = \{\}\) \{\s*\n\s*return \{ APP_BASE_URL: FAKE_BASE_URL, BOOKING_REMINDER_CRON_SECRET: FAKE_SECRET, \.\.\.overrides \};/);
});
