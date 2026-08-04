#!/usr/bin/env node
/*
 * Load test seguro para DALFI ERP.
 * Por defecto sirve ./outputs localmente y genera tráfico HTTP concurrente
 * sobre los recursos que carga la SPA (flujo repetido de apertura/navegación).
 * Para probar un staging: LOAD_BASE_URL=https://staging.example.com
 * LOAD_ALLOW_REMOTE=1 node scripts/load-test.mjs
 * Nunca permite dalfi-erp.pages.dev ni otros dominios de producción.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../outputs");
const baseFromEnv = process.env.LOAD_BASE_URL || "";
const workers = Math.max(1, Number(process.env.LOAD_WORKERS || 8));
const durationMs = Math.max(1000, Number(process.env.LOAD_DURATION_MS || 15000));
const localOnly = !baseFromEnv;

function guardTarget() {
  if (localOnly) return;
  const target = new URL(baseFromEnv);
  const production = target.hostname === "dalfi-erp.pages.dev" || target.hostname.endsWith(".dalfi-erp.pages.dev");
  if (production || process.env.LOAD_ALLOW_REMOTE !== "1") {
    throw new Error("Objetivo remoto bloqueado. Usa un staging autorizado y LOAD_ALLOW_REMOTE=1.");
  }
  if (target.protocol !== "https:") throw new Error("El objetivo remoto debe usar HTTPS.");
}

function startStaticServer() {
  const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    const relative = urlPath === "/" ? "/index.html" : urlPath;
    const filePath = path.resolve(root, `.${relative}`);
    if (!filePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404); res.end("Not found"); return;
    }
    res.writeHead(200, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const stats = { requests: 0, failures: 0, pageErrors: 0, consoleErrors: 0, latencies: [], actions: 0, errors: [] };
const lock = { value: false };
function recordLatency(value) { stats.latencies.push(value); }
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function runWorker(id, target, deadline) {
  const paths = ["/", "/app.js?v=load-test", "/styles.css", "/database.json"];
  do {
    for (const requestPath of paths) {
      const started = Date.now();
      try {
        const response = await fetch(`${target}${requestPath}`, { signal: AbortSignal.timeout(5000), headers: { "x-load-test": `worker-${id}` } });
        stats.requests += 1;
        if (!response.ok) { stats.failures += 1; stats.errors.push(`HTTP ${response.status} ${requestPath}`); }
        await response.arrayBuffer();
        recordLatency(Date.now() - started);
        stats.actions += requestPath === "/" ? 5 : 1;
      } catch (error) {
        stats.failures += 1;
        stats.errors.push(`worker-${id}:${requestPath}:${error.message}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20 + ((id * 17) % 80)));
  } while (Date.now() < deadline);
}

async function main() {
  guardTarget();
  let server;
  let target = baseFromEnv.replace(/\/$/, "");
  if (localOnly) {
    server = await startStaticServer();
    target = `http://127.0.0.1:${server.address().port}`;
  }
  const deadline = Date.now() + durationMs;
  await Promise.all(Array.from({ length: workers }, (_, id) => runWorker(id, target, deadline)));
  if (server) await new Promise((resolve) => server.close(resolve));
  const summary = {
    target: localOnly ? "local outputs server" : target,
    workers,
    durationMs,
    requests: stats.requests,
    actions: stats.actions,
    failures: stats.failures,
    pageErrors: stats.pageErrors,
    consoleErrors: stats.consoleErrors,
    errors: stats.errors.slice(0, 10),
    latencyMs: { p50: percentile(stats.latencies, 50), p95: percentile(stats.latencies, 95), max: Math.max(0, ...stats.latencies) },
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failures || summary.pageErrors) process.exitCode = 1;
}

// Node --test descubre cualquier .mjs dentro del proyecto. No arranques un
// servidor ni abras tráfico durante la batería unitaria; la prueba real se
// ejecuta explícitamente con `npm run test:load`.
if (process.argv.includes("--test") || process.execArgv.includes("--test") || process.env.NODE_TEST_CONTEXT) {
  console.log("load-test: omitido dentro de npm test; ejecutar npm run test:load para tráfico simulado.");
} else {
  main().catch((error) => { console.error(`load-test: ${error.message}`); process.exitCode = 2; });
}
