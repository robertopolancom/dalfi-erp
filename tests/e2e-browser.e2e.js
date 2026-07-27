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

test("staging aislado: operador puede consultar pero no iniciar operaciones protegidas", { skip: !process.env.E2E_AUTH_LOCAL, timeout: 45000 }, async (t) => {
  const baseUrl = process.env.E2E_AUTH_BASE_URL || "http://127.0.0.1:8788";
  const email = process.env.E2E_AUTH_EMAIL;
  const password = process.env.E2E_AUTH_PASSWORD;
  assert.ok(email && password, "E2E_AUTH_EMAIL y E2E_AUTH_PASSWORD son obligatorios en modo autenticado");
  const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle", timeout: 20000 });
  await page.locator("#auth-email").fill(email);
  await page.locator("#auth-password").fill(password);
  await page.locator('#auth-form button[type="submit"]').click();
  await page.locator("#logout-button").waitFor({ state: "visible", timeout: 25000 });
  const accessToken = await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const value = localStorage.getItem(localStorage.key(index));
      if (!value) continue;
      try {
        const parsed = JSON.parse(value);
        if (parsed?.access_token) return parsed.access_token;
      } catch {
        // Otra entrada de localStorage no es una sesion Supabase.
      }
    }
    return "";
  });
  assert.ok(accessToken, "el login debe dejar un access_token de Supabase en la sesion del navegador");
  const profile = await page.evaluate(async (token) => {
    const response = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
    return response.json();
  }, accessToken);
  assert.equal(profile.role, "operador");
  assert.equal(profile.isActive, true);
  assert.equal(profile.permissions.canManageBilling, false);
  assert.equal(profile.permissions.canManageInventory, false);
  const currentDocument = await page.evaluate(async (token) => {
    const response = await fetch("/api/database", { headers: { Authorization: `Bearer ${token}` } });
    return response.json();
  }, accessToken);
  assert.ok(currentDocument.data && currentDocument.updatedAt, "el operador debe poder leer el documento y su version");
  const inventoryDomain = await page.evaluate(async (token) => {
    const response = await fetch("/api/database-domain?domain=inventario", { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() };
  }, accessToken);
  assert.equal(inventoryDomain.status, 200, "el operador activo debe poder consultar el slice de inventario");
  assert.equal(inventoryDomain.body.domain, "inventario");
  assert.ok(inventoryDomain.body.data && typeof inventoryDomain.body.data === "object");
  assert.equal(Object.prototype.hasOwnProperty.call(inventoryDomain.body.data, "facturas"), false, "el slice no debe exponer facturacion");
  const attemptedDocument = structuredClone(currentDocument.data);
  attemptedDocument.facturas = [...(attemptedDocument.facturas || []), { __e2e_permission_probe: true }];
  const blockedWrite = await page.evaluate(async ({ token, data, updatedAt }) => {
    const response = await fetch("/api/database", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data, expectedUpdatedAt: updatedAt }),
    });
    return { status: response.status, body: await response.text() };
  }, { token: accessToken, data: attemptedDocument, updatedAt: currentDocument.updatedAt });
  assert.equal(blockedWrite.status, 403, "la API debe rechazar la mutacion directa del operador");
  assert.doesNotMatch(blockedWrite.body, /secret|token|password/i);
  // El navegador puede registrar la respuesta 403 deliberadamente provocada
  // como "Failed to load resource"; no es un error de la aplicacion.
  errors.length = 0;
  for (const [view, submit] of [["billing", "#invoice-submit-button"], ["inventory", "#inventory-submit"], ["retail-sales", "#retail-sale-submit"]]) {
    await page.locator(`[data-view="${view}"]`).click();
    await page.waitForTimeout(250);
    assert.equal(await page.locator(submit).isDisabled(), true, `${view} debe quedar en solo lectura`);
  }
  assert.equal(errors.length, 0, `errores de consola: ${errors.join(" | ")}`);
});
