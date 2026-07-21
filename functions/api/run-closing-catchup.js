import { insertAuditLog } from "./_lib/audit.js";

// Endpoint pensado para ser llamado por un Cloudflare Worker con Cron Trigger
// (ver CRON.md en la raiz del proyecto para el paso a paso de como crearlo).
// No depende de que ningun navegador tenga la app abierta: genera los cierres
// diarios "sin confirmar" que falten directamente contra Supabase, usando la
// llave de servicio.
//
// Modelo: por cada fecha vencida sin cierres se crean EXACTAMENTE dos
// registros — uno closingType:"register" (caja registradora) y uno
// closingType:"treasury" (consolidado de bancos, caja fuerte, caja chica y
// demas cuentas) — nunca uno por cuenta. Esto es un port reducido de
// ensureProvisionalClosings()/normalizeLegacyClosings() en outputs/app.js:
// cubre la generacion y la normalizacion de cierres antiguos sin closingType,
// pero no reproduce el resto de la logica de negocio del navegador
// (facturacion, nomina, confirmacion, etc.) porque este endpoint solo
// necesita esa parte.
//
// Seguridad: requiere un header "x-cron-secret" que coincida con la variable
// de entorno CLOSING_CRON_SECRET configurada en Cloudflare Pages. Sin ese
// secreto (o si no esta configurado), el endpoint rechaza la solicitud.

const TIME_ZONE = "America/Santo_Domingo";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function localDateStringInZone(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function nowPartsInZone(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { hour: Number(value.hour), minute: Number(value.minute) };
}

function isEligible(date, today, hour, minute) {
  if (!date || !today || date > today) return false;
  if (date < today) return true;
  return hour === 23 && minute >= 59;
}

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateOnly(value) {
  return String(value || "").slice(0, 10);
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function nextId(rows, field, prefix) {
  const next = (rows?.length || 0) + 1001;
  let id = `${prefix}-${next}`;
  let bump = next;
  const used = new Set(rows.map((row) => row[field]));
  while (used.has(id)) {
    bump += 1;
    id = `${prefix}-${bump}`;
  }
  return id;
}

function accountKey(account) {
  return account?.cuentaID || normalize(account?.nombreCuenta || "");
}

function recordMatchesAccount(row, account, nameFields, idFields) {
  const key = accountKey(account);
  const accountName = normalize(account?.nombreCuenta || "");
  if (!key && !accountName) return false;
  return idFields.some((field) => row[field] && row[field] === key) || nameFields.some((field) => accountName && normalize(row[field]) === accountName);
}

function isCashAccountName(account) {
  const text = normalize(`${account?.tipoCuenta || ""} ${account?.tipoProducto || ""} ${account?.nombreCuenta || ""}`);
  return text.includes("caja") || text.includes("efectivo");
}

function isBankAccountName(account) {
  const text = normalize(`${account?.tipoCuenta || ""} ${account?.tipoProducto || ""} ${account?.nombreCuenta || ""}`);
  return !isCashAccountName(account) && (text.includes("banco") || Boolean(account?.numeroCuenta));
}

function registerAccountFor(data) {
  const active = (data.cuentas || []).filter((account) => normalize(account.estado || "Activo") === "activo");
  const named = active.find((account) => normalize(account.nombreCuenta).includes("registradora"));
  if (named) return named;
  const cash = active.find(isCashAccountName);
  return cash || active[0] || null;
}

function treasuryAccountsFor(data, register) {
  const active = (data.cuentas || []).filter((account) => normalize(account.estado || "Activo") === "activo");
  const registerKey = register ? accountKey(register) : null;
  return active.filter((account) => accountKey(account) !== registerKey);
}

function accountActivityForDate(data, date, account) {
  const income = (data.ingresos || [])
    .filter((row) => dateOnly(row.fechaHora) === date && normalize(row.estado || "Confirmado") === "confirmado")
    .filter((row) => recordMatchesAccount(row, account, ["cuentaDestino"], ["cuentaDestinoID"]))
    .reduce((sum, row) => sum + (Number(row.montoNeto) || Number(row.montoBruto) || 0), 0);
  // Debe mantenerse en sincronia con accountActivityForDate() en
  // outputs/app.js: un egreso tipo "transferencia" ya tiene su propia fila
  // en "transferencias" (contada abajo en transferOut) y no debe sumarse
  // tambien aqui, o la misma salida de efectivo se cuenta dos veces.
  const expenses = (data.egresos || [])
    .filter((row) => dateOnly(row.fechaHora) === date)
    .filter((row) => recordMatchesAccount(row, account, ["cuentaOrigen"], ["cuentaOrigenID"]))
    .filter((row) => normalize(row.estado || "Registrado") !== "anulado")
    .filter((row) => normalize(row.tipoEgreso) !== "transferencia")
    .reduce((sum, row) => sum + (Number(row.monto) || 0), 0);
  const transferIn = (data.transferencias || [])
    .filter((row) => dateOnly(row.fechaHora) === date && normalize(row.estado || "Confirmada") === "confirmada")
    .filter((row) => recordMatchesAccount(row, account, ["cuentaDestino"], ["cuentaDestinoID"]))
    .reduce((sum, row) => sum + (Number(row.monto) || 0), 0);
  const transferOut = (data.transferencias || [])
    .filter((row) => dateOnly(row.fechaHora) === date && normalize(row.estado || "Confirmada") === "confirmada")
    .filter((row) => recordMatchesAccount(row, account, ["cuentaOrigen"], ["cuentaOrigenID"]))
    .reduce((sum, row) => sum + (Number(row.monto) || 0), 0);
  return { income, expenses, transferIn, transferOut, expected: income + transferIn - expenses - transferOut };
}

function dailyIncomeSummary(data, date) {
  const income = (data.ingresos || []).filter((row) => dateOnly(row.fechaHora) === date && normalize(row.estado || "Confirmado") === "confirmado");
  const receivables = (data.cuentasCobrar || []).filter((row) => dateOnly(row.fechaOrigen) === date && Number(row.balancePendiente) > 0);
  const byMethod = income.reduce(
    (summary, row) => {
      const method = normalize(row.metodoPago || "");
      if (method === "efectivo") summary.cash += Number(row.montoNeto) || 0;
      if (method === "tarjeta") summary.card += Number(row.montoBruto) || 0;
      if (method.includes("transferencia")) summary.transfer += Number(row.montoNeto) || 0;
      return summary;
    },
    { cash: 0, card: 0, transfer: 0, credit: 0 },
  );
  byMethod.credit = receivables
    .filter((row) => row.deudorTipo === "Cliente" && !String(row.concepto || "").includes("procesador"))
    .reduce((sum, row) => sum + (Number(row.balancePendiente) || 0), 0);
  return byMethod;
}

function closingCollaboratorSummary(data, date) {
  const grouped = new Map();
  const ensureRow = (id, name) => {
    const key = id || name || "sin-colaboradora";
    if (!grouped.has(key)) grouped.set(key, { id: key, name: name || "Sin colaboradora", services: 0, billing: 0, commissionable: 0, extras: 0, discounts: 0, tips: 0, invoiceIds: [] });
    return grouped.get(key);
  };
  (data.facturaDetalle || []).forEach((detail) => {
    const invoice = (data.facturas || []).find((row) => row.facturaID === detail.facturaID);
    if (!invoice || dateOnly(invoice.fechaHora) !== date || normalize(invoice.estado) === "anulada") return;
    const row = ensureRow(detail.colaboradorID, detail.colaboradorNombre);
    row.services += 1;
    row.billing += Number(detail.subtotalAntesDescuentoGeneral ?? detail.subtotal) || 0;
    row.commissionable += Number(detail.montoComisionable ?? detail.subtotal) || 0;
    row.extras += Number(detail.extraMonto) || 0;
    row.discounts += (Number(detail.deduccionMonto) || 0) + (Number(detail.deduccionGeneralMonto) || 0);
    if (detail.facturaID && !row.invoiceIds.includes(detail.facturaID)) row.invoiceIds.push(detail.facturaID);
  });
  (data.propinas || []).forEach((tip) => {
    if (dateOnly(tip.fechaHora) !== date) return;
    const row = ensureRow(tip.colaboradorID, tip.colaboradorNombre);
    row.tips += Number(tip.montoNetoPagar ?? tip.montoBruto ?? tip.monto) || 0;
  });
  return Array.from(grouped.values())
    .map((row) => ({ ...row, total: row.billing - row.discounts + row.extras + row.tips }))
    .sort((a, b) => normalize(a.name).localeCompare(normalize(b.name)));
}

function isClosingPendingConfirmation(closing) {
  const status = normalize(closing?.estado);
  return Boolean(closing?.requiereConfirmacion) || status.includes("abierto") || status.includes("provisional") || status.includes("pendiente");
}

function closingBusinessDate(closing) {
  return closing?.businessDate || dateOnly(closing?.fechaHoraCierre);
}

function isRegisterAccountName(name, register) {
  if (!name) return false;
  if (register && normalize(name) === normalize(register.nombreCuenta || "")) return true;
  return normalize(name).includes("registradora");
}

// Igual que normalizeLegacyClosings() en outputs/app.js: a los cierres
// antiguos sin closingType se les asigna uno sin borrar ni fusionar nada. Si
// ya hay otro cierre normalizado del mismo tipo para esa fecha, se marca
// needsReview en vez de perder el registro.
function normalizeLegacyClosings(data, register) {
  const rows = data.cierres || [];
  const legacy = rows.filter((closing) => !closing.closingType);
  if (!legacy.length) return 0;
  const sorted = legacy.slice().sort((a, b) => String(a.fechaCreacion || a.fechaHoraCierre || "").localeCompare(String(b.fechaCreacion || b.fechaHoraCierre || "")));
  let normalized = 0;
  sorted.forEach((closing) => {
    const businessDate = closingBusinessDate(closing);
    const inferred = isRegisterAccountName(closing.cuentaCaja, register) ? "register" : "treasury";
    const occupied = rows.some((other) => other !== closing && other.closingType === inferred && closingBusinessDate(other) === businessDate);
    closing.closingType = inferred;
    closing.businessDate = businessDate;
    if (occupied) closing.needsReview = true;
    closing.actualizadoPor = "cron:closing-catchup";
    closing.fechaActualizacion = new Date().toISOString();
    normalized += 1;
  });
  return normalized;
}

function registerClosingForDate(data, date) {
  return (data.cierres || []).find((c) => !c.needsReview && c.closingType === "register" && closingBusinessDate(c) === date);
}

function treasuryClosingForDate(data, date) {
  return (data.cierres || []).find((c) => !c.needsReview && c.closingType === "treasury" && closingBusinessDate(c) === date);
}

// Debe mantenerse en sincronia con previousTreasurySaldoFor() en
// outputs/app.js: si no hay cierre de tesoreria confirmado anterior para
// esta cuenta, usa el balance de apertura configurado de la cuenta en vez
// de asumir 0 a ciegas.
function previousTreasurySaldoFor(data, account, beforeDate) {
  const key = accountKey(account);
  const previous = (data.cierres || [])
    .filter((c) => c.closingType === "treasury" && !c.needsReview)
    .filter((c) => closingBusinessDate(c) < beforeDate)
    .filter((c) => !isClosingPendingConfirmation(c))
    .sort((a, b) => String(b.businessDate || "").localeCompare(String(a.businessDate || "")))[0];
  const row = previous?.cuentas?.find((item) => accountKey({ cuentaID: item.cuentaID, nombreCuenta: item.nombreCuenta }) === key);
  if (row) {
    const num = Number(row.saldoReal);
    return Number.isFinite(num) ? num : 0;
  }
  const opening = Number(account?.balanceInicial);
  return Number.isFinite(opening) ? opening : 0;
}

function buildTreasuryAccountDetail(data, date, account) {
  const activity = accountActivityForDate(data, date, account);
  const saldoInicial = previousTreasurySaldoFor(data, account, date);
  const saldoEsperado = saldoInicial + activity.income + activity.transferIn - activity.expenses - activity.transferOut;
  return {
    cuentaID: account.cuentaID || "",
    nombreCuenta: account.nombreCuenta || "",
    tipoCuenta: account.tipoCuenta || (isBankAccountName(account) ? "Banco" : "Custodia"),
    saldoInicial,
    ingresos: activity.income,
    egresos: activity.expenses,
    transferenciasRecibidas: activity.transferIn,
    transferenciasEnviadas: activity.transferOut,
    ajustes: 0,
    saldoEsperado,
    saldoReal: saldoEsperado,
    diferencia: 0,
    observaciones: "",
  };
}

function buildTreasuryTotals(cuentas) {
  return (cuentas || []).reduce(
    (totals, row) => ({
      saldoInicial: totals.saldoInicial + (Number(row.saldoInicial) || 0),
      ingresos: totals.ingresos + (Number(row.ingresos) || 0),
      egresos: totals.egresos + (Number(row.egresos) || 0),
      transferenciasRecibidas: totals.transferenciasRecibidas + (Number(row.transferenciasRecibidas) || 0),
      transferenciasEnviadas: totals.transferenciasEnviadas + (Number(row.transferenciasEnviadas) || 0),
      saldoEsperado: totals.saldoEsperado + (Number(row.saldoEsperado) || 0),
      saldoReal: totals.saldoReal + (Number(row.saldoReal) || 0),
      diferencia: totals.diferencia + (Number(row.diferencia) || 0),
    }),
    { saldoInicial: 0, ingresos: 0, egresos: 0, transferenciasRecibidas: 0, transferenciasEnviadas: 0, saldoEsperado: 0, saldoReal: 0, diferencia: 0 },
  );
}

// Debe mantenerse en sincronia con defaultInitialCashFor() en outputs/app.js
// (que a su vez delega en DalfiClosingMath.resolveRegisterOpeningCash): si
// no hay cierre confirmado anterior, el fondo de caja del cierre provisional
// generado por el cron usa el balance de apertura configurado de la cuenta
// en vez de asumir 0 a ciegas.
function defaultInitialCashFor(data, account, beforeDate) {
  const previous = (data.cierres || [])
    .filter((c) => dateOnly(c.fechaHoraCierre) < beforeDate)
    .filter((c) => recordMatchesAccount(c, account, ["cuentaCaja"], ["cuentaID"]))
    .filter((c) => !isClosingPendingConfirmation(c))
    .sort((a, b) => String(b.fechaHoraCierre || "").localeCompare(String(a.fechaHoraCierre || "")))[0];
  if (previous) return Number(previous.balanceContado) || 0;
  return Number(account?.balanceInicial) || 0;
}

function stamp(record) {
  const now = new Date().toISOString();
  record.creadoPor = "cron:closing-catchup";
  record.fechaCreacion = now;
  record.actualizadoPor = "cron:closing-catchup";
  record.fechaActualizacion = now;
  return record;
}

async function loadDocument(supabaseUrl, serviceRoleKey) {
  const response = await fetch(`${supabaseUrl}/rest/v1/erp_records?table_name=eq.app&record_key=eq.database&select=data`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!response.ok) throw new Error(`No se pudo leer erp_records (HTTP ${response.status}).`);
  const rows = await response.json().catch(() => []);
  const document = rows?.[0]?.data;
  if (!document?.data) throw new Error("erp_records no tiene un documento 'app/database' valido.");
  return document;
}

async function saveDocument(supabaseUrl, serviceRoleKey, document) {
  const response = await fetch(`${supabaseUrl}/rest/v1/erp_records?on_conflict=table_name,record_key`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ table_name: "app", record_key: "database", data: document }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`No se pudo guardar erp_records (HTTP ${response.status}): ${body}`);
  }
}

export async function onRequestPost({ request, env }) {
  const expectedSecret = env.CLOSING_CRON_SECRET;
  if (!expectedSecret) return json({ error: "Falta configurar CLOSING_CRON_SECRET en Cloudflare Pages." }, 500);
  const providedSecret = request.headers.get("x-cron-secret") || "";
  if (providedSecret !== expectedSecret) return json({ error: "Secreto de cron invalido." }, 401);

  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Faltan variables privadas de Supabase en Cloudflare Pages." }, 500);

  let document;
  try {
    document = await loadDocument(supabaseUrl, serviceRoleKey);
  } catch (error) {
    return json({ error: error.message }, 500);
  }

  const data = document.data;
  data.cierres = data.cierres || [];
  const today = localDateStringInZone(new Date());
  const { hour, minute } = nowPartsInZone(new Date());

  const normalized = normalizeLegacyClosings(data, registerAccountFor(data));

  const existingDates = new Set(data.cierres.map((closing) => closingBusinessDate(closing)).filter(Boolean));
  const transactionDates = new Set();
  [
    ["facturas", "fechaHora"],
    ["ingresos", "fechaHora"],
    ["egresos", "fechaHora"],
    ["transferencias", "fechaHora"],
    ["propinas", "fechaHora"],
    ["cuentasCobrar", "fechaOrigen"],
  ].forEach(([table, field]) => {
    (data[table] || []).forEach((row) => {
      const date = dateOnly(row[field]);
      if (isEligible(date, today, hour, minute)) transactionDates.add(date);
    });
  });
  const candidateDates = new Set([...existingDates, ...transactionDates]);
  const sorted = [...candidateDates].filter(Boolean).sort();
  const eligibleEnd = isEligible(today, today, hour, minute) ? today : addDays(today, -1);
  let cursor = sorted[0] || eligibleEnd;
  let guard = 0;
  while (cursor && eligibleEnd && cursor <= eligibleEnd && guard < 370) {
    if (isEligible(cursor, today, hour, minute)) candidateDates.add(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }

  let created = 0;
  const register = registerAccountFor(data);
  const treasuryAccounts = treasuryAccountsFor(data, register);
  [...candidateDates].sort().forEach((date) => {
    if (!isEligible(date, today, hour, minute)) return;
    const summary = dailyIncomeSummary(data, date);
    if (register?.nombreCuenta && !registerClosingForDate(data, date)) {
      const activity = accountActivityForDate(data, date, register);
      const montoInicial = defaultInitialCashFor(data, register, date);
      const expected = montoInicial + activity.income + activity.transferIn - activity.expenses - activity.transferOut;
      data.cierres.push(stamp({
        cierreID: nextId(data.cierres, "cierreID", "CIE"),
        closingType: "register",
        businessDate: date,
        fechaHoraCierre: `${date}T23:59:00`,
        cajero: "Cierre provisional automatico (cron Cloudflare)",
        cuentaCaja: register.nombreCuenta || "Caja registradora",
        cuentaID: register.cuentaID || "",
        balanceInicial: montoInicial,
        ingresosConfirmados: activity.income + activity.transferIn,
        egresos: activity.expenses + activity.transferOut,
        balanceTeorico: expected,
        balanceContado: 0,
        conteoInicial: 0,
        balanceContadoRectificado: 0,
        diferenciaInicial: -expected,
        diferencia: -expected,
        cuadreFaltante: Math.max(0, expected),
        cuadreFaltanteInicial: Math.max(0, expected),
        sobranteCaja: 0,
        tarjetaContada: 0,
        tarjetaEsperada: summary.card,
        transferenciaContada: 0,
        transferenciaEsperada: summary.transfer,
        creditoGenerado: summary.credit,
        detalleColaboradores: closingCollaboratorSummary(data, date),
        estado: "Pendiente de confirmacion",
        requiereConfirmacion: true,
        provisional: true,
        observaciones: "Generado automaticamente por el cron de Cloudflare porque el dia quedo pendiente de cierre.",
      }));
      created += 1;
    }
    if (!treasuryClosingForDate(data, date)) {
      const cuentas = treasuryAccounts.map((account) => buildTreasuryAccountDetail(data, date, account));
      data.cierres.push(stamp({
        cierreID: nextId(data.cierres, "cierreID", "CIE"),
        closingType: "treasury",
        businessDate: date,
        fechaHoraCierre: `${date}T23:59:00`,
        registerClosingID: registerClosingForDate(data, date)?.cierreID || "",
        cuentas,
        totales: buildTreasuryTotals(cuentas),
        estado: "Pendiente de confirmacion",
        requiereConfirmacion: true,
        provisional: true,
        observaciones: "Generado automaticamente por el cron de Cloudflare porque el dia quedo pendiente de cierre.",
      }));
      created += 1;
    }
  });

  if (created > 0 || normalized > 0) {
    try {
      await saveDocument(supabaseUrl, serviceRoleKey, document);
    } catch (error) {
      return json({ error: error.message }, 500);
    }
  }

  await insertAuditLog(env, {
    tableName: "cierres",
    entityId: today,
    action: "closing_catchup_run",
    newData: { created, normalized, date: today },
    userId: null,
    userEmail: "cron:closing-catchup",
    userRole: "system",
    success: true,
    note: `Ejecucion automatica via cron. Cierres creados: ${created}. Cierres antiguos normalizados: ${normalized}.`,
  }).catch(() => null);

  return json({ ok: true, created, normalized });
}

export async function onRequest() {
  return json({ error: "Metodo no permitido." }, 405);
}
