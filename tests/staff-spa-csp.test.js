// Cobertura del hallazgo "Atención" de la auditoría de seguridad (2026-08-23): la SPA del
// personal en ssc.dalfistudio.com no tenía Content-Security-Policy ni frame-ancestors, a
// diferencia de ReservApp que ya lo tiene vía outputs/reservar/_headers.

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../server/app.mjs";

// res.sendFile del catch-all (server/app.mjs) exige un staticDir real -- sin uno, lanza y el
// error-handler por defecto de Express reemplaza cualquier header ya puesto (incluido nuestro
// CSP) con su propia página de error, que trae su propio "default-src 'none'". Un staticDir de
// verdad evita esa ruta de error y deja pasar la respuesta normal donde SÍ se ve nuestro CSP.
const staticDir = mkdtempSync(path.join(tmpdir(), "staff-spa-csp-"));
writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>test</title>");

async function withServer(env, fn) {
  const app = createApp({
    store: { async read() { return { data: {}, updatedAt: "2026-08-13T00:00:00.000Z", version: 1 }; } },
    bookingStore: { async catalog() { return { services: [], staff: [] }; } },
    env,
    staticDir,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
}

test("la SPA del personal recibe un CSP que permite jsdelivr (cliente de Supabase) y el proyecto real de Supabase", async () => {
  await withServer({ SUPABASE_URL: "https://miproyecto.supabase.co" }, async (base) => {
    const response = await fetch(`${base}/`);
    const csp = response.headers.get("content-security-policy");
    assert.ok(csp, "debe traer el header Content-Security-Policy");
    assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net/);
    assert.match(csp, /connect-src 'self' https:\/\/miproyecto\.supabase\.co wss:\/\/miproyecto\.supabase\.co/);
    assert.match(csp, /frame-ancestors 'none'/);
  });
});

test("las respuestas de /api/* no llevan CSP (no ejecutan nada en el navegador)", async () => {
  await withServer({ SUPABASE_URL: "https://miproyecto.supabase.co" }, async (base) => {
    const response = await fetch(`${base}/api/fast-booking/catalog`);
    assert.equal(response.headers.get("content-security-policy"), null);
  });
});

test("sin SUPABASE_URL configurado, el CSP sigue siendo válido (sin connect-src roto a medias)", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/`);
    const csp = response.headers.get("content-security-policy");
    assert.ok(csp);
    assert.match(csp, /connect-src 'self'/);
  });
});
