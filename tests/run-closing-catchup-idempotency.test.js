// Pruebas de comportamiento end-to-end de functions/api/run-closing-catchup.js
// (el endpoint que el Worker de Cloudflare Cron va a llamar cada noche).
// Todas usan fetch() mockeado en memoria (mismo patron que
// tests/users-patch-compensation.test.js): NUNCA hacen una peticion de red
// real, nunca usan un secreto real (el valor de prueba esta marcado como
// FAKE). El "documento" de erp_records se simula en memoria y se muta entre
// llamadas para poder probar dos ejecuciones consecutivas de verdad (la
// segunda lee lo que la primera "guardo"), que es exactamente el escenario
// que le preocupa al Cron: no duplicar cierres en ejecuciones repetidas.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const moduleUrl = pathToFileURL(path.join(__dirname, "..", "functions", "api", "run-closing-catchup.js")).href;
const closingMathSource = fs.readFileSync(path.join(__dirname, "..", "outputs", "lib", "closing-math.js"), "utf8");
const cronSource = fs.readFileSync(path.join(__dirname, "..", "functions", "api", "run-closing-catchup.js"), "utf8");

const FAKE_SECRET = "test-cron-secret-not-real-0000";
const BASE_ENV = {
  CLOSING_CRON_SECRET: FAKE_SECRET,
  SUPABASE_URL: "https://fake.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "fake-service-key",
};

function rdToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santo_Domingo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function addDaysStr(dateStr, days) {
  const date = new Date(`${dateStr}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function baseData() {
  return {
    cuentas: [
      { cuentaID: "CTA-1", nombreCuenta: "Caja Registradora", tipoCuenta: "Caja", estado: "Activo", balanceInicial: 1000 },
      { cuentaID: "CTA-2", nombreCuenta: "Banco Popular", tipoCuenta: "Banco", estado: "Activo", balanceInicial: 5000, numeroCuenta: "12345" },
    ],
    cierres: [],
    ingresos: [],
    egresos: [],
    transferencias: [],
    propinas: [],
    facturas: [],
    facturaDetalle: [],
    cuentasCobrar: [],
  };
}

// Servidor Supabase falso en memoria: guarda el documento actual en `state`
// y responde a las mismas rutas que loadDocument()/saveDocument()/
// insertAuditLog() usan de verdad, para poder invocar onRequestPost() dos
// veces seguidas y que la segunda vea lo que la primera "persistio".
function makeFakeSupabase(initialData) {
  const state = { document: { data: initialData } };
  const requests = [];
  const fetchMock = async (url, init) => {
    const urlStr = String(url);
    requests.push({ url: urlStr, method: init?.method || "GET" });
    if (urlStr.includes("/rest/v1/erp_records") && (!init || init.method === undefined || init.method === "GET")) {
      return new Response(JSON.stringify([{ data: state.document }]), { status: 200 });
    }
    if (urlStr.includes("/rest/v1/erp_records") && init?.method === "POST") {
      const body = JSON.parse(init.body);
      state.document = body.data;
      return new Response(null, { status: 201 });
    }
    if (urlStr.includes("/rest/v1/erp_audit_log")) {
      return new Response(null, { status: 201 });
    }
    throw new Error(`fetch mock: ruta no esperada ${urlStr}`);
  };
  return { fetchMock, state, requests };
}

async function withFakeFetch(fetchMock, fn) {
  const original = global.fetch;
  global.fetch = fetchMock;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

function postRequest(secret) {
  const headers = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-cron-secret"] = secret;
  return new Request("https://fake.supabase.co/api/run-closing-catchup", { method: "POST", headers });
}

// --- Regresion: isEligible() en este archivo debe seguir siendo la MISMA
// regla que isAutomaticClosingEligible() en closing-math.js (el comentario
// del propio archivo advierte "Debe mantenerse en sincronia"; esta prueba
// convierte esa advertencia en algo que falla automaticamente si un cambio
// futuro rompe la sincronia, en vez de depender de que alguien lea el
// comentario).
test("run-closing-catchup: isEligible() sigue byte-a-byte igual a isAutomaticClosingEligible() de closing-math.js (misma regla de elegibilidad de cierre automatico)", () => {
  const cronFn = /function isEligible\(date, today, hour, minute\) \{([\s\S]*?)\n\}/.exec(cronSource);
  const mathFn = /function isAutomaticClosingEligible\(\{ date, today, hour, minute \}\) \{([\s\S]*?)\n  \}/.exec(closingMathSource);
  assert.ok(cronFn, "no se encontro isEligible() en run-closing-catchup.js");
  assert.ok(mathFn, "no se encontro isAutomaticClosingEligible() en closing-math.js");
  const normalize = (body) => body.replace(/\s+/g, " ").trim();
  assert.equal(normalize(cronFn[1]), normalize(mathFn[1]), "isEligible() se desincronizo de isAutomaticClosingEligible(): revisa ambas copias.");
});

test("run-closing-catchup: sin x-cron-secret responde 500 sin ejecutar nada (nunca expone ni exige revelar el secreto)", async () => {
  const { onRequestPost } = await import(moduleUrl);
  const { fetchMock, requests } = makeFakeSupabase(baseData());
  await withFakeFetch(fetchMock, async () => {
    const res = await onRequestPost({ request: postRequest(undefined), env: { ...BASE_ENV, CLOSING_CRON_SECRET: "" } });
    assert.equal(res.status, 500);
    assert.equal(requests.length, 0, "no debe llamar a Supabase si falta configurar el secreto");
  });
});

test("run-closing-catchup: secreto incorrecto responde 401 sin ejecutar nada", async () => {
  const { onRequestPost } = await import(moduleUrl);
  const { fetchMock, requests } = makeFakeSupabase(baseData());
  await withFakeFetch(fetchMock, async () => {
    const res = await onRequestPost({ request: postRequest("secreto-equivocado"), env: BASE_ENV });
    assert.equal(res.status, 401);
    assert.equal(requests.length, 0, "no debe llamar a Supabase si el secreto no coincide");
  });
});

test("run-closing-catchup: GET/otros metodos responden 405", async () => {
  const { onRequest } = await import(moduleUrl);
  const res = await onRequest();
  assert.equal(res.status, 405);
});

test("run-closing-catchup: dos dias pendientes (sin cierres previos) crean exactamente un par register+treasury por dia, con montos correctos", async () => {
  const { onRequestPost } = await import(moduleUrl);
  const today = rdToday();
  const day1 = addDaysStr(today, -2);
  const day2 = addDaysStr(today, -1);
  const data = baseData();
  data.ingresos.push({ fechaHora: `${day1}T10:00:00`, estado: "Confirmado", cuentaDestinoID: "CTA-1", montoNeto: 500, metodoPago: "efectivo" });
  data.egresos.push({ fechaHora: `${day1}T12:00:00`, estado: "Registrado", cuentaOrigenID: "CTA-1", monto: 100, tipoEgreso: "gasto" });
  data.ingresos.push({ fechaHora: `${day2}T10:00:00`, estado: "Confirmado", cuentaDestinoID: "CTA-1", montoNeto: 300, metodoPago: "efectivo" });

  const { fetchMock, state } = makeFakeSupabase(data);
  await withFakeFetch(fetchMock, async () => {
    const res = await onRequestPost({ request: postRequest(FAKE_SECRET), env: BASE_ENV });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.created, 4, "2 dias x (register + treasury) = 4 cierres nuevos");
  });

  const cierres = state.document.data.cierres;
  const day1Register = cierres.find((c) => c.closingType === "register" && c.businessDate === day1);
  const day2Register = cierres.find((c) => c.closingType === "register" && c.businessDate === day2);
  assert.ok(day1Register, "falta el cierre de caja registradora del dia 1");
  assert.ok(day2Register, "falta el cierre de caja registradora del dia 2");
  assert.equal(day1Register.balanceInicial, 1000, "sin cierre anterior, usa el balance de apertura de la cuenta");
  assert.equal(day1Register.ingresosConfirmados, 500);
  assert.equal(day1Register.egresos, 100);
  assert.equal(day1Register.balanceTeorico, 1000 + 500 - 100);
  assert.equal(day1Register.estado, "Pendiente de confirmacion");
  assert.equal(day1Register.provisional, true);
  assert.equal(cierres.filter((c) => c.closingType === "treasury").length, 2);
});

test("run-closing-catchup: ejecutar dos veces seguidas NUNCA duplica cierres (idempotente) y la segunda vez no vuelve a escribir en Supabase", async () => {
  const { onRequestPost } = await import(moduleUrl);
  const today = rdToday();
  const day1 = addDaysStr(today, -1);
  const data = baseData();
  data.ingresos.push({ fechaHora: `${day1}T10:00:00`, estado: "Confirmado", cuentaDestinoID: "CTA-1", montoNeto: 200, metodoPago: "efectivo" });

  const { fetchMock, state, requests } = makeFakeSupabase(data);
  await withFakeFetch(fetchMock, async () => {
    const res1 = await onRequestPost({ request: postRequest(FAKE_SECRET), env: BASE_ENV });
    const body1 = await res1.json();
    assert.equal(body1.created, 2, "primera ejecucion: crea el par register+treasury del dia pendiente");
    const cierresAfterRun1 = state.document.data.cierres.length;

    requests.length = 0; // solo nos interesan las peticiones de la SEGUNDA ejecucion
    const res2 = await onRequestPost({ request: postRequest(FAKE_SECRET), env: BASE_ENV });
    const body2 = await res2.json();
    assert.equal(body2.created, 0, "segunda ejecucion consecutiva: no debe crear cierres nuevos (ya existen para ese dia)");
    assert.equal(body2.normalized, 0, "segunda ejecucion: nada legado que normalizar de nuevo");
    assert.equal(state.document.data.cierres.length, cierresAfterRun1, "el numero total de cierres no cambio entre la 1ra y la 2da ejecucion");

    const wroteToErpRecords = requests.some((r) => r.url.includes("/rest/v1/erp_records") && r.method === "POST");
    assert.equal(wroteToErpRecords, false, "si no hay nada que crear/normalizar, la 2da ejecucion NUNCA debe hacer POST a erp_records (evita el riesgo de pisar cambios concurrentes de un usuario real sin necesidad)");
  });
});

test("run-closing-catchup: un cierre ya existente para esa fecha (creado por un usuario real) NUNCA se recrea", async () => {
  const { onRequestPost } = await import(moduleUrl);
  const today = rdToday();
  const day1 = addDaysStr(today, -1);
  const data = baseData();
  data.ingresos.push({ fechaHora: `${day1}T10:00:00`, estado: "Confirmado", cuentaDestinoID: "CTA-1", montoNeto: 200, metodoPago: "efectivo" });
  data.cierres.push({
    cierreID: "CIE-MANUAL-1",
    closingType: "register",
    businessDate: day1,
    estado: "Confirmado",
    balanceContado: 1200,
    creadoPor: "usuario-real@dalfi.test",
  });

  const { fetchMock, state } = makeFakeSupabase(data);
  await withFakeFetch(fetchMock, async () => {
    const res = await onRequestPost({ request: postRequest(FAKE_SECRET), env: BASE_ENV });
    const body = await res.json();
    assert.equal(body.created, 1, "solo falta el cierre de tesoreria: el de caja registradora ya existia (creado por un usuario real) y no se toca");
  });
  const registerClosings = state.document.data.cierres.filter((c) => c.closingType === "register" && c.businessDate === day1);
  assert.equal(registerClosings.length, 1, "no se duplico el cierre de caja registradora existente");
  assert.equal(registerClosings[0].cierreID, "CIE-MANUAL-1", "el cierre real del usuario se preserva intacto, sin sobrescribirlo");
  assert.equal(registerClosings[0].balanceContado, 1200);
});

test("run-closing-catchup: normaliza cierres legados (sin closingType) UNA sola vez; una segunda ejecucion no los vuelve a tocar", async () => {
  const { onRequestPost } = await import(moduleUrl);
  const today = rdToday();
  const oldDay = addDaysStr(today, -30);
  const data = baseData();
  data.cierres.push({
    cierreID: "CIE-LEGACY-1",
    fechaHoraCierre: `${oldDay}T23:59:00`,
    cuentaCaja: "Caja Registradora",
    estado: "Confirmado",
  });

  const { fetchMock, state } = makeFakeSupabase(data);
  await withFakeFetch(fetchMock, async () => {
    const res1 = await onRequestPost({ request: postRequest(FAKE_SECRET), env: BASE_ENV });
    const body1 = await res1.json();
    assert.equal(body1.normalized, 1, "primera ejecucion: normaliza el cierre legado exactamente una vez");
    const legacyAfterRun1 = state.document.data.cierres.find((c) => c.cierreID === "CIE-LEGACY-1");
    assert.equal(legacyAfterRun1.closingType, "register");

    const res2 = await onRequestPost({ request: postRequest(FAKE_SECRET), env: BASE_ENV });
    const body2 = await res2.json();
    assert.equal(body2.normalized, 0, "segunda ejecucion: el cierre legado ya tiene closingType, no se vuelve a normalizar");
  });
});

test("run-closing-catchup: una transferencia interna con su egreso-espejo tipo 'transferencia' se cuenta UNA sola vez en 'egresos' (nunca 700+700=1400)", async () => {
  const { onRequestPost } = await import(moduleUrl);
  const today = rdToday();
  const day1 = addDaysStr(today, -1);
  const data = baseData();
  // Patron real de la app: una transferencia interna deja DOS rastros — una
  // fila en "egresos" (tipoEgreso: "transferencia", para que aparezca en el
  // historial de movimientos de la cuenta) y una fila en "transferencias"
  // (la que de verdad mueve el dinero entre cuentas). accountActivityForDate
  // debe sumar el monto UNA sola vez (via transferOut), nunca las dos.
  data.egresos.push({ fechaHora: `${day1}T09:00:00`, estado: "Registrado", cuentaOrigenID: "CTA-1", monto: 700, tipoEgreso: "transferencia" });
  data.transferencias.push({ fechaHora: `${day1}T09:00:00`, estado: "Confirmada", cuentaOrigenID: "CTA-1", cuentaDestinoID: "CTA-2", monto: 700 });

  const { fetchMock, state } = makeFakeSupabase(data);
  await withFakeFetch(fetchMock, async () => {
    await onRequestPost({ request: postRequest(FAKE_SECRET), env: BASE_ENV });
  });
  const registerClosing = state.document.data.cierres.find((c) => c.closingType === "register" && c.businessDate === day1);
  assert.equal(registerClosing.egresos, 700, "debe contarse una sola vez (700), nunca 1400 (el egreso-espejo tipo transferencia se excluye de 'expenses' y el monto real solo entra via transferOut)");
});

test("run-closing-catchup: varios dias sin ejecutar el cron se ponen al dia todos de una vez, cada uno con su propio par de cierres", async () => {
  const { onRequestPost } = await import(moduleUrl);
  const today = rdToday();
  const days = [addDaysStr(today, -5), addDaysStr(today, -4), addDaysStr(today, -3), addDaysStr(today, -2), addDaysStr(today, -1)];
  const data = baseData();
  data.ingresos.push({ fechaHora: `${days[0]}T10:00:00`, estado: "Confirmado", cuentaDestinoID: "CTA-1", montoNeto: 100, metodoPago: "efectivo" });
  data.ingresos.push({ fechaHora: `${days[4]}T10:00:00`, estado: "Confirmado", cuentaDestinoID: "CTA-1", montoNeto: 100, metodoPago: "efectivo" });

  const { fetchMock, state } = makeFakeSupabase(data);
  await withFakeFetch(fetchMock, async () => {
    const res = await onRequestPost({ request: postRequest(FAKE_SECRET), env: BASE_ENV });
    const body = await res.json();
    assert.equal(body.created, 10, "5 dias pendientes x (register + treasury) = 10 cierres, incluyendo los 3 dias intermedios sin ninguna transaccion");
  });
  days.forEach((day) => {
    const registerClosing = state.document.data.cierres.find((c) => c.closingType === "register" && c.businessDate === day);
    assert.ok(registerClosing, `falta el cierre de caja registradora del ${day}`);
  });
});
