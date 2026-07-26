// E2E de navegador contra un servidor estático local.
// No usa producción, Supabase ni datos persistentes: valida navegación y
// controles visibles en modo local antes de conectar un entorno staging.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.join(__dirname, "..", "outputs");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function startStaticServer() {
  const server = http.createServer((request, response) => {
    const requestPath = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const relative = requestPath === "/" ? "/index.html" : requestPath;
    const filePath = path.resolve(root, `.${relative}`);
    if (!filePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath)) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(response);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("navegador local: recorre ventas, pagos, transferencias, reservas y cierres sin producción", { timeout: 30000 }, async (t) => {
  const server = await startStaticServer();
  t.after(() => server.close());
  const address = server.address();
  const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const blockedRequests = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(`http://127.0.0.1:${address.port}`) && !request.url().startsWith("https://cdn.jsdelivr.net")) blockedRequests.push(request.url());
  });

  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded", timeout: 10000 });
  await page.locator(".brand h1").waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator("#sync-status").innerText(), "Inicia sesión para usar el ERP");

  const flows = [
    ["billing", "Facturación", "#invoice-form"],
    ["receivables", "Cuentas por cobrar", "#payment-form"],
    ["pending-transfers", "Transferencias pendientes", "#pending-transfers"],
    ["reservations", "Citas", "#reservation-form"],
    ["cash", "Cierres de caja", "#cash-form"],
  ];
  for (const [view, title, selector] of flows) {
    await page.locator(`[data-view="${view}"]`).evaluate((element) => element.click());
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#view-title").innerText(), title);
    assert.equal(await page.locator(`#${view}`).evaluate((element) => element.classList.contains("active")), true);
    assert.equal(await page.locator(selector).count(), 1);
  }
  assert.deepEqual(blockedRequests, [], "el E2E local no debe llamar producción ni Supabase");
});

test("navegador local: el login permanece explícito y no se envían credenciales automáticamente", async (t) => {
  const server = await startStaticServer();
  t.after(() => server.close());
  const address = server.address();
  const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.locator("#auth-panel").isHidden(), false);
  assert.equal(await page.locator("#auth-email").inputValue(), "");
  assert.equal(await page.locator("#auth-password").inputValue(), "");
});
