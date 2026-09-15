// Pruebas del Worker de cron (workers/expire-unconfirmed-cron/worker.js). Todas usan fetch()
// inyectado/mockeado en memoria: NUNCA hacen una peticion de red real, nunca llaman a produccion,
// nunca usan un secreto real. Mismo patron que workers/deposit-receipt-purge-cron/tests/.
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

let workerModule;
test.before(async () => {
  workerModule = await import(path.join(WORKER_DIR, "worker.js"));
});

const FAKE_SECRET = "test-secret-not-real-0000";
const FAKE_BASE_URL = "https://example-test.invalid";

const makeEnv = (overrides = {}) => ({ APP_BASE_URL: FAKE_BASE_URL, EXPIRE_UNCONFIRMED_CRON_SECRET: FAKE_SECRET, ...overrides });

function fetchMock(responder) {
  const calls = [];
  const impl = async (url, options) => { calls.push({ url, options }); return responder(url, options); };
  return { impl, calls };
}

const ok = (body = { ok: true, expiredCount: 3 }) => ({ ok: true, status: 200, json: async () => body });

test("EU01 — llama al endpoint correcto, por POST y con el secreto en cabecera", async () => {
  const { impl, calls } = fetchMock(() => ok());
  const r = await workerModule.runExpireUnconfirmedCron(makeEnv(), impl);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${FAKE_BASE_URL}/api/booking/expire-unconfirmed`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["x-cron-secret"], FAKE_SECRET);
  assert.doesNotMatch(calls[0].url, /secret/i, "el secreto nunca viaja en la URL");
  assert.equal(r.expiredCount, 3);
});

test("EU02 — manda el margen por defecto (2h) y respeta el configurado", async () => {
  const porDefecto = fetchMock(() => ok());
  await workerModule.runExpireUnconfirmedCron(makeEnv(), porDefecto.impl);
  assert.equal(JSON.parse(porDefecto.calls[0].options.body).graceMinutes, 120);

  const configurado = fetchMock(() => ok());
  await workerModule.runExpireUnconfirmedCron(makeEnv({ GRACE_MINUTES: "30" }), configurado.impl);
  assert.equal(JSON.parse(configurado.calls[0].options.body).graceMinutes, 30);
});

test("EU03 — sin secreto o sin URL base falla claro, y no llama a nadie", async () => {
  for (const env of [makeEnv({ EXPIRE_UNCONFIRMED_CRON_SECRET: "" }), makeEnv({ APP_BASE_URL: "" })]) {
    const { impl, calls } = fetchMock(() => ok());
    await assert.rejects(() => workerModule.runExpireUnconfirmedCron(env, impl), /Falta configurar/);
    assert.equal(calls.length, 0);
  }
});

test("EU04 — un error HTTP se propaga (no se traga como exito)", async () => {
  const { impl } = fetchMock(() => ({ ok: false, status: 401, json: async () => ({}) }));
  await assert.rejects(() => workerModule.runExpireUnconfirmedCron(makeEnv(), impl), /respondio 401/);
});

test("EU05 — un cuerpo JSON roto no rompe el Worker: la llamada ya funciono", async () => {
  const { impl } = fetchMock(() => ({ ok: true, status: 200, json: async () => { throw new Error("no es json"); } }));
  const r = await workerModule.runExpireUnconfirmedCron(makeEnv(), impl);
  assert.equal(r.ok, true);
  assert.equal(r.expiredCount, undefined);
});

test("EU06 — ni el codigo ni la config ni el README llevan un secreto o dominio real", () => {
  for (const [nombre, fuente] of [["worker.js", workerSource], ["wrangler.toml", wranglerToml], ["README.md", readmeSource]]) {
    assert.doesNotMatch(fuente, /EXPIRE_UNCONFIRMED_CRON_SECRET\s*=\s*["'][^"']+["']/, `${nombre} no puede traer el secreto escrito`);
  }
  // El dominio real SI puede aparecer en wrangler.toml/README (es publico y hace falta), pero
  // nunca acompañado de un valor de secreto.
  assert.match(wranglerToml, /APP_BASE_URL = "https:\/\/ssc\.dalfistudio\.com"/);
  assert.match(wranglerToml, /crons = \["0 7 \* \* \*"\]/, "3 a.m. hora de Santo Domingo");
});

test("EU07 — el cron vive UNICAMENTE en wrangler.toml, no incrustado en worker.js", () => {
  assert.doesNotMatch(workerSource, /crons\s*=/, "la expresion cron no se duplica en el codigo");
});
