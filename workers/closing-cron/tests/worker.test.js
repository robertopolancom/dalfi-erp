// Pruebas del Worker de cron (workers/closing-cron/worker.js). Todas usan
// fetch() inyectado/mockeado en memoria: NUNCA hacen una peticion de red
// real, nunca llaman a produccion, nunca usan un secreto real (los valores
// de prueba son literales inventados, marcados como tales).
//
// Este archivo es ESM (workers/closing-cron/package.json tiene
// "type": "module", igual que necesita worker.js para que Wrangler lo trate
// como ES module): usa import/import.meta.url en vez de require/__dirname.
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
  return { APP_BASE_URL: FAKE_BASE_URL, CLOSING_CRON_SECRET: FAKE_SECRET, ...overrides };
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

// --- 1-3: forma del Worker ---

test("worker.js exporta un default con scheduled(controller, env, ctx)", () => {
  assert.match(workerSource, /export default \{\s*\n\s*async scheduled\(controllerEvent, env, ctx\) \{/);
});

test("scheduled() delega en runClosingCron(env) y usa ctx.waitUntil (patron correcto de Cloudflare Workers para trabajo async en cron)", () => {
  const fnMatch = /async scheduled\(controllerEvent, env, ctx\) \{[\s\S]*?\n  \},\s*\n\};/.exec(workerSource);
  assert.ok(fnMatch, "no se encontro scheduled()");
  assert.match(fnMatch[0], /ctx\.waitUntil\(/);
  assert.match(fnMatch[0], /runClosingCron\(env\)/);
});

test("runClosingCron(): usa env.APP_BASE_URL para construir el endpoint, nunca un dominio hardcodeado", () => {
  assert.match(workerSource, /const baseUrl = env\.APP_BASE_URL;/);
  assert.match(workerSource, /new URL\("\/api\/run-closing-catchup", baseUrl\)/);
});

test("runClosingCron(): usa env.CLOSING_CRON_SECRET (Secret de Wrangler), nunca un valor literal", () => {
  assert.match(workerSource, /const secret = env\.CLOSING_CRON_SECRET;/);
});

// --- 4-6: sin secretos reales, secreto solo en cabecera ---

test("no existe ningun secreto real (solo placeholders) en worker.js ni en wrangler.toml", () => {
  const forbiddenPattern = new RegExp(["service", "_", "role"].join(""), "i");
  assert.ok(!forbiddenPattern.test(workerSource + wranglerToml));
  assert.ok(!/CLOSING_CRON_SECRET\s*=\s*["'][^"'<][^"']*["']/.test(wranglerToml), "wrangler.toml no debe fijar CLOSING_CRON_SECRET como texto plano");
  assert.match(wranglerToml, /CLOSING_CRON_SECRET se configura por separado como Secret/);
});

test("el secreto SIEMPRE va en la cabecera x-cron-secret, nunca como parametro de query string", () => {
  assert.match(workerSource, /headers: \{ "x-cron-secret": secret \}/);
  assert.ok(!/[?&]secret=/.test(workerSource), "no debe construirse una URL con el secreto en query string");
});

test("runClosingCron(): usa metodo POST (igual que espera functions/api/run-closing-catchup.js)", () => {
  assert.match(workerSource, /method: "POST",/);
});

// --- 7-11: exito/fallo segun codigo HTTP ---

test("respuesta 200: runClosingCron() resuelve OK y hace exactamente UNA llamada fetch", async () => {
  const fetchMock = makeFetchMock(async () => new Response(JSON.stringify({ ok: true, created: 0 }), { status: 200 }));
  const result = await workerModule.runClosingCron(makeEnv(), fetchMock);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, 200);
  assert.strictEqual(fetchMock.calls.length, 1);
});

for (const status of [401, 403, 500]) {
  test(`respuesta ${status}: runClosingCron() lanza un error (no se trata como exito)`, async () => {
    const fetchMock = makeFetchMock(async () => new Response(JSON.stringify({ error: "no" }), { status }));
    await assert.rejects(() => workerModule.runClosingCron(makeEnv(), fetchMock), new RegExp(String(status)));
  });
}

// --- 12-13: red y timeout ---

test("error de red (fetch rechaza): runClosingCron() propaga el error sin intentarlo de nuevo dentro de la misma ejecucion", async () => {
  const fetchMock = async () => {
    throw new Error("getaddrinfo ENOTFOUND example-test.pages.dev");
  };
  await assert.rejects(() => workerModule.runClosingCron(makeEnv(), fetchMock), /ENOTFOUND/);
});

test("timeout: runClosingCron() usa AbortController con un limite explicito y lanza un error especifico de timeout", async () => {
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
    () => workerModule.runClosingCron(makeEnv({ REQUEST_TIMEOUT_MS: "10" }), fetchMock),
    /timeout/i,
  );
});

test("falta APP_BASE_URL o CLOSING_CRON_SECRET: runClosingCron() rechaza con un mensaje claro, sin llegar a hacer fetch", async () => {
  const fetchMock = makeFetchMock(async () => new Response("{}", { status: 200 }));
  await assert.rejects(() => workerModule.runClosingCron({ CLOSING_CRON_SECRET: FAKE_SECRET }, fetchMock), /APP_BASE_URL/);
  await assert.rejects(() => workerModule.runClosingCron({ APP_BASE_URL: FAKE_BASE_URL }, fetchMock), /CLOSING_CRON_SECRET/);
  assert.strictEqual(fetchMock.calls.length, 0, "no debe llamar a fetch si falta configuracion");
});

// --- 14: logs seguros ---

test("logResult()/console.log nunca incluyen el secreto ni la cabecera Authorization completa", () => {
  const logFnSource = /function logResult\([\s\S]*?\n\}/.exec(workerSource)[0];
  assert.ok(!/secret/i.test(logFnSource) || /outcome/.test(logFnSource), "logResult no debe recibir ni imprimir el secreto");
  assert.ok(!/console\.(log|error)\([^)]*secret/i.test(workerSource.replace(/\/\/.*$/gm, "")), "ningun console.log/error debe interpolar el secreto");
});

test("logResult() captura en runtime: al ejecutar runClosingCron con exito, lo que se loguea (JSON) no contiene el valor del secreto", async () => {
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(" "));
  try {
    const fetchMock = makeFetchMock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await workerModule.runClosingCron(makeEnv(), fetchMock);
  } finally {
    console.log = originalLog;
  }
  const allLogged = logged.join("\n");
  assert.ok(!allLogged.includes(FAKE_SECRET), "el secreto no debe aparecer en ningun log emitido");
});

// --- 15-19: el Worker no puede causar duplicados ni tocar reglas de negocio (por construccion) ---

test("runClosingCron(): hace EXACTAMENTE una llamada HTTP por ejecucion (sin bucles de reintento internos que pudieran duplicar la generacion de cierres)", async () => {
  const fetchMock = makeFetchMock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await workerModule.runClosingCron(makeEnv(), fetchMock);
  assert.strictEqual(fetchMock.calls.length, 1);
});

test("worker.js NO accede a Supabase directamente ni duplica ninguna regla de negocio de cierres (fecha comercial, tipos, filtros de transferencia, saldo inicial): solo hace fetch() al endpoint existente", () => {
  // Se revisa solo CODIGO real (se descartan las lineas de comentario que
  // EXPLICAN esta misma garantia, para no auto-fallar por mencionarla).
  const codeOnly = workerSource
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const forbidden = ["supabase", "erp_records", "cuentas", "closingType", "accountActivityForDate", "buildTreasuryAccountDetail", "isAutomaticClosingEligible"];
  forbidden.forEach((token) => {
    assert.ok(!new RegExp(token, "i").test(codeOnly), `worker.js no debe usar '${token}' como codigo real — esa logica vive solo en functions/api/run-closing-catchup.js`);
  });
  assert.match(workerSource, /\/api\/run-closing-catchup/);
});

test("la idempotencia de 'cierre existente no se recrea' / 'cierre confirmado no se modifica' sigue siendo responsabilidad exclusiva de functions/api/run-closing-catchup.js (ya cubierto por tests/closing-*-ui.test.js), no del Worker", () => {
  const cronSource = fs.readFileSync(path.join(__dirname, "..", "..", "..", "functions", "api", "run-closing-catchup.js"), "utf8");
  assert.match(cronSource, /function registerClosingForDate\(data, date\) \{/);
  assert.match(cronSource, /function treasuryClosingForDate\(data, date\) \{/);
  assert.match(cronSource, /if \(register\?\.nombreCuenta && !registerClosingForDate\(data, date\)\) \{/);
});

// --- 20: configuracion cron centralizada ---

test("la expresion cron activa vive UNICAMENTE en workers/closing-cron/wrangler.toml, no hardcodeada en worker.js", () => {
  assert.ok(!/\d+ \d+ \* \* \*/.test(workerSource), "worker.js no debe contener una expresion cron: la programacion es responsabilidad de wrangler.toml");
  assert.match(wranglerToml, /^\[triggers\]\s*\ncrons = \["59 3 \* \* \*"\]/m, "el Cron Trigger debe estar activo (sin comentar) con exactamente 59 3 * * * (23:59 hora de Santo Domingo, UTC-4 estable, sin horario de verano)");
});

test("APP_BASE_URL en wrangler.toml apunta al dominio productivo real de Cloudflare Pages, no a un placeholder", () => {
  assert.match(wranglerToml, /APP_BASE_URL = "https:\/\/dalfi-erp\.pages\.dev"/);
});

// --- 25: README sin secretos ---

test("workers/closing-cron/README.md no contiene ningun secreto real, solo placeholders", () => {
  const forbiddenPattern = new RegExp(["service", "_", "role"].join(""), "i");
  assert.ok(!forbiddenPattern.test(readmeSource));
  assert.ok(!/CLOSING_CRON_SECRET\s*=\s*[a-f0-9]{16,}/i.test(readmeSource), "no debe haber un valor de secreto ya generado en el README");
});

// --- 26-28: nada de esto toca produccion, RLS o migraciones ---

test("todas las pruebas de fetch de este archivo usan FAKE_BASE_URL/FAKE_SECRET inventados, nunca el dominio real de produccion ni un secreto real", () => {
  const thisFile = fs.readFileSync(__filename, "utf8");
  assert.match(thisFile, /FAKE_BASE_URL = "https:\/\/example-test\.pages\.dev"/);
  assert.match(thisFile, /FAKE_SECRET = "test-secret-not-real-0000"/);
  // makeEnv() es la UNICA forma en que las pruebas de arriba obtienen un env: siempre parte de estas constantes de prueba.
  assert.match(thisFile, /function makeEnv\(overrides = \{\}\) \{\s*\n\s*return \{ APP_BASE_URL: FAKE_BASE_URL, CLOSING_CRON_SECRET: FAKE_SECRET, \.\.\.overrides \};/);
});

// --- 29-30: la Fase A (mejoras visuales) sigue intacta ---

test("regresion cruzada: el boton 'Agregar egreso' y el reordenamiento del formulario de cierres (Fase A) siguen intactos — este Worker no los toca", () => {
  const appJs = fs.readFileSync(path.join(__dirname, "..", "..", "..", "outputs", "app.js"), "utf8");
  assert.match(appJs, /function openAddExpenseFromClosing\(\)/);
  const indexHtml = fs.readFileSync(path.join(__dirname, "..", "..", "..", "outputs", "index.html"), "utf8");
  const cashFormIdx = indexHtml.indexOf("cash-form-grid");
  const cashListIdx = indexHtml.indexOf("cash-list-panel");
  assert.ok(cashFormIdx > 0 && cashListIdx > cashFormIdx, "el formulario debe seguir apareciendo antes que el listado");
});
