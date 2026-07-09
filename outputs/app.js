function localDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santo_Domingo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

const today = localDateString();
const month = today.slice(0, 7);

function dateTimeForOperationalDate(date, fallback = new Date()) {
  const safeDate = date || today;
  const time = fallback.toLocaleTimeString("en-GB", {
    timeZone: "America/Santo_Domingo",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${safeDate}T${time}`;
}

const money = new Intl.NumberFormat("es-DO", {
  style: "currency",
  currency: "DOP",
});
const dateLabel = new Intl.DateTimeFormat("es-DO", {
  timeZone: "America/Santo_Domingo",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const appStorageKey = "dalfi-erp-app-state-v1";
const dbStorageKey = "dalfi-erp-db-v2-june-test";
const legacyStorageKey = "nailunit-erp-state";
const supabaseConfig = window.DALFI_SUPABASE_CONFIG || {};
const supabaseUrl = supabaseConfig.url || "";
const supabasePublishableKey = supabaseConfig.publishableKey || "";
const remoteTableName = "app";
const remoteRecordKey = "database";

const fallbackSeed = {
  clients: [
    { id: "c1", name: "María López", phone: "809-555-0101" },
    { id: "c2", name: "Carolina Pérez", phone: "809-555-0102" },
    { id: "c3", name: "Ana Martínez", phone: "809-555-0103" },
    { id: "c4", name: "Laura Gómez", phone: "809-555-0104" },
  ],
  services: [
    { id: "s1", name: "Manicure gel", price: 950 },
    { id: "s2", name: "Pedicure spa", price: 1250 },
    { id: "s3", name: "Acrílico completo", price: 1800 },
    { id: "s4", name: "Relleno acrílico", price: 1100 },
    { id: "s5", name: "Diseño por uña", price: 150 },
  ],
  staff: ["Rosa Jiménez", "Paola Reyes", "Karla Núñez"],
  invoices: [
    {
      id: "F-1001",
      date: today,
      client: "María López",
      service: "Manicure gel",
      qty: 1,
      price: 950,
      discount: 0,
      total: 950,
      payment: "efectivo",
      paid: 950,
      note: "",
    },
    {
      id: "F-1002",
      date: today,
      client: "Carolina Pérez",
      service: "Acrílico completo",
      qty: 1,
      price: 1800,
      discount: 200,
      total: 1600,
      payment: "credito",
      paid: 600,
      note: "Abono inicial",
    },
  ],
  payments: [
    { id: "P-7001", date: today, invoiceId: "F-1002", client: "Carolina Pérez", amount: 600, method: "transferencia" },
  ],
  reservations: [
    { id: "R-3001", date: today, time: "10:00", client: "Ana Martínez", service: "Pedicure spa", staff: "Paola Reyes" },
    { id: "R-3002", date: today, time: "14:30", client: "Laura Gómez", service: "Relleno acrílico", staff: "Karla Núñez" },
  ],
  payroll: [
    { id: "N-5001", period: month, staff: "Rosa Jiménez", base: 18000, commission: 4200, deductions: 950, net: 21250 },
  ],
  cashClosings: [],
  expenses: [],
};

let database = null;
let state = structuredClone(fallbackSeed);
let invoiceLineCounter = 0;
let paymentLineCounter = 0;
let cashBalanceDraft = null;
let reportGenerated = false;
let activeReservationInvoiceId = "";
let supabaseClient = null;
let supabaseSession = null;
let remoteSaveTimer = null;
let remoteSaveInFlight = false;
let isLoadingRemote = false;

async function loadDatabase() {
  initSupabaseClient();
  if (supabaseClient) {
    try {
      const sessionResult = await supabaseClient.auth.getSession();
      supabaseSession = sessionResult.data.session;
      if (supabaseSession) {
        const remoteDatabase = await loadRemoteDatabase();
        if (remoteDatabase) {
          database = remoteDatabase;
          ensureDatabaseShape();
          localStorage.setItem(dbStorageKey, JSON.stringify(database));
          return;
        }
      }
    } catch (error) {
      console.warn("No se pudo cargar Supabase. Se usa respaldo local.", error);
    }
  }

  const saved = localStorage.getItem(dbStorageKey);
  if (saved) {
    try {
      database = JSON.parse(saved);
      ensureDatabaseShape();
      return;
    } catch {
      localStorage.removeItem(dbStorageKey);
    }
  }

  try {
    const response = await fetch("database.json", { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo cargar database.json");
    database = await response.json();
    ensureDatabaseShape();
    localStorage.setItem(dbStorageKey, JSON.stringify(database));
  } catch {
    database = createDatabaseFromState(structuredClone(fallbackSeed));
    ensureDatabaseShape();
  }
}

function loadState() {
  const saved = localStorage.getItem(appStorageKey);
  if (!saved) {
    const legacy = localStorage.getItem(legacyStorageKey);
    if (legacy && !database) {
      try {
        return { ...structuredClone(fallbackSeed), ...JSON.parse(legacy) };
      } catch {
        return structuredClone(fallbackSeed);
      }
    }
    return database ? stateFromDatabase(database) : structuredClone(fallbackSeed);
  }
  try {
    if (database) return stateFromDatabase(database);
    return { ...structuredClone(fallbackSeed), ...JSON.parse(saved) };
  } catch {
    return database ? stateFromDatabase(database) : structuredClone(fallbackSeed);
  }
}

function saveState() {
  localStorage.setItem(appStorageKey, JSON.stringify(state));
  if (database) localStorage.setItem(dbStorageKey, JSON.stringify(database));
  scheduleRemoteSave();
}

function initSupabaseClient() {
  if (supabaseClient || !supabaseUrl || !supabasePublishableKey || !window.supabase?.createClient) return;
  supabaseClient = window.supabase.createClient(supabaseUrl, supabasePublishableKey);
}

function isSupabaseReady() {
  return Boolean(supabaseClient && supabaseSession?.user);
}

function isPasswordResetRequired() {
  return Boolean(supabaseSession?.user?.user_metadata?.password_reset_required);
}

async function loadRemoteDatabase() {
  if (!isSupabaseReady()) return null;
  isLoadingRemote = true;
  try {
    const { data, error } = await supabaseClient
      .from("erp_records")
      .select("data")
      .eq("table_name", remoteTableName)
      .eq("record_key", remoteRecordKey)
      .maybeSingle();
    if (error) throw error;
    return data?.data || null;
  } finally {
    isLoadingRemote = false;
  }
}

function scheduleRemoteSave() {
  if (!isSupabaseReady() || isLoadingRemote || !database) return;
  window.clearTimeout(remoteSaveTimer);
  remoteSaveTimer = window.setTimeout(saveRemoteDatabase, 700);
}

async function saveRemoteDatabase() {
  if (!isSupabaseReady() || !database || remoteSaveInFlight) return;
  remoteSaveInFlight = true;
  updateSyncStatus("Guardando en Supabase...", "online");
  try {
    const payload = {
      table_name: remoteTableName,
      record_key: remoteRecordKey,
      data: database,
    };
    const { error } = await supabaseClient.from("erp_records").upsert(payload, { onConflict: "table_name,record_key" });
    if (error) throw error;
    updateSyncStatus(`Conectado: ${supabaseSession.user.email}`, "online");
  } catch (error) {
    console.error("No se pudo guardar en Supabase.", error);
    updateSyncStatus("Error guardando Supabase", "error");
  } finally {
    remoteSaveInFlight = false;
  }
}

function updateSyncStatus(message, mode = "") {
  const status = byId("sync-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("online", mode === "online");
  status.classList.toggle("error", mode === "error");
}

function updateAuthUi() {
  const connected = isSupabaseReady();
  const passwordChangeRequired = connected && isPasswordResetRequired();
  const canManage = canManageInvoices();
  document.body.classList.toggle("auth-required", !connected);
  document.body.classList.toggle("password-change-required", passwordChangeRequired);
  document.querySelectorAll(".admin-only").forEach((item) => item.classList.toggle("hidden", !canManage));
  byId("open-login").classList.toggle("hidden", connected);
  byId("open-password-change").classList.toggle("hidden", !connected);
  byId("logout-button").classList.toggle("hidden", !connected);
  if (passwordChangeRequired) {
    byId("auth-panel").classList.add("hidden");
    byId("forgot-password-panel")?.classList.add("hidden");
    byId("password-change-panel")?.classList.remove("hidden");
    byId("password-change-title").textContent = "Cambia tu contraseña temporal";
    byId("password-change-message").textContent = "Debes crear una contraseña propia antes de usar el ERP.";
    byId("password-change-email-label").classList.add("hidden");
    byId("password-current").placeholder = "Contraseña temporal";
    updateSyncStatus("Cambia tu contraseña para continuar", "error");
  } else if (connected) {
    byId("auth-panel").classList.add("hidden");
    byId("forgot-password-panel")?.classList.add("hidden");
    byId("password-change-panel")?.classList.add("hidden");
    updateSyncStatus(`Conectado: ${supabaseSession.user.email}`, "online");
  } else {
    byId("auth-panel").classList.remove("hidden");
    byId("forgot-password-panel")?.classList.add("hidden");
    byId("password-change-panel")?.classList.add("hidden");
    updateSyncStatus("Inicia sesión para usar el ERP", "");
  }
}

function ensureDatabaseShape() {
  database.data ||= {};
  database.schema ||= [];
  if (!database.data.reservas) database.data.reservas = [];
  if (!database.data.cuentasPagar) database.data.cuentasPagar = [];
  if (!database.data.suplidores) database.data.suplidores = [];
  if (!database.data.procesadores) database.data.procesadores = [];
  if (!database.data.inventario) database.data.inventario = [];
  if (!database.data.inventarioMovimientos) database.data.inventarioMovimientos = [];
  if (!database.data.activosFijos) database.data.activosFijos = [];
  database.data.procesadores.forEach((processor) => {
    if (processor.comisionPorcentaje === undefined) processor.comisionPorcentaje = 0.028;
    if (!processor.estado) processor.estado = "Activo";
  });
  const processorSchema = database.schema.find((table) => table.key === "procesadores");
  if (processorSchema) {
    processorSchema.columns = ["ProcesadorID", "Nombre", "Tipo", "ComisionPorcentaje", "Estado", "Observaciones"];
    processorSchema.ref = "A1:F4";
  }
  if (!database.data.conceptosDescuentoNomina) {
    database.data.conceptosDescuentoNomina = [
      { conceptoID: "DESC-0001", concepto: "AFP", estado: "Activo" },
      { conceptoID: "DESC-0002", concepto: "Seguro", estado: "Activo" },
      { conceptoID: "DESC-0003", concepto: "Otros", estado: "Activo" },
    ];
  }
  if (!database.schema.some((table) => table.key === "reservas")) {
    database.schema.push({
      sheet: "21_Reservas",
      table: "T_Reservas",
      key: "reservas",
      ref: "A1:L1",
      columns: ["ReservaID", "Fecha", "Hora", "ClienteID", "ClienteNombre", "Telefono", "Correo", "ClienteProvisional", "CanalOrigen", "ServicioID", "Servicio", "ColaboradorNombre", "FacturaID", "Observaciones"],
    });
  }
  if (!database.schema.some((table) => table.key === "cuentasPagar")) {
    database.schema.push({
      sheet: "22_Cuentas_Pagar",
      table: "T_CuentasPagar",
      key: "cuentasPagar",
      ref: "A1:M1",
      columns: ["CxPID", "FechaOrigen", "TipoCxP", "AcreedorTipo", "AcreedorID", "AcreedorNombre", "NominaID", "MontoOriginal", "MontoPagado", "BalancePendiente", "Estado", "Concepto", "FechaVencimiento"],
    });
  }
  if (!database.schema.some((table) => table.key === "inventario")) {
    database.schema.push({
      sheet: "23_Inventario",
      table: "T_Inventario",
      key: "inventario",
      ref: "A1:O1",
      columns: ["ItemID", "SKU", "Nombre", "Categoria", "Tipo", "Costo", "PrecioVenta", "Existencia", "ExistenciaMinima", "Unidad", "Proveedor", "FechaEntrada", "Estado", "Observaciones", "ActualizadoEn"],
    });
  }
  if (!database.schema.some((table) => table.key === "inventarioMovimientos")) {
    database.schema.push({
      sheet: "24_Inventario_Movimientos",
      table: "T_InventarioMovimientos",
      key: "inventarioMovimientos",
      ref: "A1:J1",
      columns: ["MovimientoID", "ItemID", "FechaHora", "Tipo", "Cantidad", "CostoUnitario", "Referencia", "Motivo", "ExistenciaDespues", "Observaciones"],
    });
  }
  if (!database.schema.some((table) => table.key === "activosFijos")) {
    database.schema.push({
      sheet: "25_Activos_Fijos",
      table: "T_ActivosFijos",
      key: "activosFijos",
      ref: "A1:N1",
      columns: ["ActivoID", "Nombre", "Categoria", "FechaAdquisicion", "ValorAdquisicion", "VidaUtilMeses", "MetodoDepreciacion", "DepreciacionAcumulada", "ValorLibros", "Estado", "Ubicacion", "Responsable", "Observaciones", "ActualizadoEn"],
    });
  }
}

function stateFromDatabase(db) {
  const data = db?.data || {};
  const detailByInvoice = new Map();
  (data.facturaDetalle || []).forEach((detail) => {
    const list = detailByInvoice.get(detail.facturaID) || [];
    list.push(detail);
    detailByInvoice.set(detail.facturaID, list);
  });

  const paymentsByInvoice = new Map();
  (data.pagosFactura || []).forEach((payment) => {
    const list = paymentsByInvoice.get(payment.facturaID) || [];
    list.push(payment);
    paymentsByInvoice.set(payment.facturaID, list);
  });

  return {
    clients: (data.clientes || []).map((client) => ({
      id: client.clienteID,
      name: client.nombreCompleto || `${client.nombre || ""} ${client.apellido || ""}`.trim(),
      phone: client.telefono || "",
    })),
    services: (data.servicios || []).map((service) => ({
      id: service.servicioID,
      name: service.servicio,
      category: service.categoria || "",
      price: Number(service.precioBase) || 0,
      duration: Number(service.duracionMin) || 0,
    })),
    staff: (data.colaboradores || []).map((staff) => staff.nombreCompleto).filter(Boolean),
    invoices: (data.facturas || []).map((invoice) => {
      const details = detailByInvoice.get(invoice.facturaID) || [];
      const payments = paymentsByInvoice.get(invoice.facturaID) || [];
      const firstPayment = payments[0] || {};
      return {
        id: invoice.facturaID,
        date: dateOnly(invoice.fechaHora),
        clientId: invoice.clienteID,
        client: invoice.clienteNombre,
        service: details.map((detail) => detail.servicio).filter(Boolean).join(", ") || "Servicio",
        qty: details.reduce((sum, detail) => sum + (Number(detail.cantidad) || 0), 0) || 1,
        price: Number(invoice.totalFacturado) || 0,
        discount: 0,
        total: Number(invoice.totalFacturado) || 0,
        payment: normalizePayment(firstPayment.metodoPago || (Number(invoice.totalCxC) > 0 ? "Crédito" : "Efectivo")),
        paid: Number(invoice.totalPagadoConfirmado) || 0,
        note: invoice.observaciones || "",
      };
    }),
    payments: (data.pagosFactura || [])
      .filter((payment) => Number(payment.montoNetoConfirmado) > 0)
      .map((payment) => {
        const invoice = (data.facturas || []).find((item) => item.facturaID === payment.facturaID);
        return {
          id: payment.pagoID,
          date: dateOnly(payment.fechaHora),
          invoiceId: payment.facturaID,
          client: invoice?.clienteNombre || "",
          amount: Number(payment.montoNetoConfirmado) || 0,
          method: normalizePayment(payment.metodoPago),
        };
      }),
    reservations: (data.reservas || []).map((reservation) => ({
      id: reservation.reservaID,
      date: reservation.fecha,
      time: reservation.hora,
      clientId: reservation.clienteID,
      client: reservation.clienteNombre,
      phone: reservation.telefono || "",
      email: reservation.correo || "",
      provisional: Boolean(reservation.clienteProvisional),
      source: reservation.canalOrigen || "Presencial",
      serviceId: reservation.servicioID,
      service: reservation.servicio,
      staff: reservation.colaboradorNombre,
      invoiceId: reservation.facturaID || "",
      note: reservation.observaciones || "",
    })),
    payroll: (data.nomina || []).map((row) => ({
      id: row.nominaID,
      period: dateOnly(row.periodoInicio).slice(0, 7),
      staff: row.colaboradorNombre,
      base: Number(row.salarioBaseMensual) || 0,
      commission: Number(row.comisionGenerada) || 0,
      deductions: Number(row.anticipos) || 0,
      tips: Number(row.propinaNetaMes) || 0,
      cut: row.quincena || "Mes completo",
      sales: Number(row.totalFacturadoMes) || 0,
      net: Number(row.totalAPagar) || 0,
    })),
    cashClosings: (data.cierres || []).map((row) => ({
      id: row.cierreID,
      date: dateOnly(row.fechaHoraCierre),
      expected: Number(row.balanceTeorico) || 0,
      counted: Number(row.balanceContado) || 0,
      initialCounted: Number(row.conteoInicial) || Number(row.balanceContado) || 0,
      rectifiedCounted: Number(row.balanceContadoRectificado) || 0,
      cardCounted: Number(row.tarjetaContada) || 0,
      transferCounted: Number(row.transferenciaContada) || 0,
      expenses: Number(row.egresos) || 0,
      difference: Number(row.diferencia) || 0,
      shortage: Number(row.cuadreFaltante) || 0,
      initialShortage: Number(row.cuadreFaltanteInicial) || Number(row.cuadreFaltante) || 0,
      surplus: Number(row.sobranteCaja) || 0,
      note: row.observaciones || "",
    })),
    expenses: (data.egresos || []).map((row) => ({
      id: row.egresoID,
      date: dateOnly(row.fechaHora),
      type: row.tipoEgreso || "",
      source: row.cuentaOrigen || "",
      destination: row.cuentaDestino || "",
      concept: row.concepto || "",
      amount: Number(row.monto) || 0,
      note: row.observaciones || "",
    })),
  };
}

function createDatabaseFromState(source) {
  return {
    meta: {
      name: "Dalfi Studio Nail ERP Database",
      version: 1,
      sourceFile: "database.json fallback",
      generatedAt: new Date().toISOString(),
      storageKey: dbStorageKey,
    },
    schema: [],
    data: {
      clientes: source.clients.map((client, index) => ({
        clienteID: client.id || nextFormattedId("CLI", index + 1),
        nombreCompleto: client.name,
        nombre: client.name.split(" ")[0] || client.name,
        apellido: client.name.split(" ").slice(1).join(" "),
        telefono: client.phone,
        estado: "Activo",
        fechaRegistro: today,
        observaciones: "",
      })),
      colaboradores: source.staff.map((name, index) => ({ colaboradorID: nextFormattedId("COL", index + 1), nombreCompleto: name, estado: "Activo" })),
      servicios: source.services.map((service, index) => ({
        servicioID: service.id || nextFormattedId("SER", index + 1),
        servicio: service.name,
        categoria: "Uñas",
        precioBase: Number(service.price) || 0,
        duracionMin: 45,
        estado: "Activo",
      })),
      facturas: [],
      facturaDetalle: [],
      pagosFactura: [],
      cuentasCobrar: [],
      ingresos: [],
      ingresoAplicaciones: [],
      egresos: [],
      transferencias: [],
      cierres: [],
      propinas: [],
      umbralesComision: [],
      nomina: [],
      reservas: [],
    },
  };
}

function dateOnly(value) {
  if (!value) return today;
  return String(value).slice(0, 10);
}

function datePlusDaysFrom(baseDate, days) {
  const date = new Date(`${baseDate || today}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function withDateOnly(value, targetDate) {
  const text = String(value || "");
  const time = text.includes("T") ? text.slice(10) : "T12:00:00";
  return `${targetDate}${time || "T12:00:00"}`;
}

function normalizePayment(value) {
  const payment = normalize(value);
  if (payment.includes("tarjeta")) return "tarjeta";
  if (payment.includes("transferencia")) return "transferencia";
  if (payment.includes("credito") || payment.includes("credit")) return "credito";
  return "efectivo";
}

function dbTable(key) {
  ensureDatabaseShape();
  database.data[key] ||= [];
  return database.data[key];
}

function nextFormattedId(prefix, next) {
  return `${prefix}-${String(next).padStart(4, "0")}`;
}

function nextDbId(tableKey, field, prefix) {
  const rows = dbTable(tableKey);
  const max = rows.reduce((highest, row) => {
    const match = String(row[field] || "").match(/(\d+)$/);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return nextFormattedId(prefix, max + 1);
}

function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] || fullName, last: parts.slice(1).join(" ") };
}

function findClientByName(name) {
  return dbTable("clientes").find((client) => normalize(client.nombreCompleto) === normalize(name));
}

function findClientByPhone(phone) {
  const clean = normalize(phone).replace(/\D/g, "");
  if (!clean) return null;
  return dbTable("clientes").find((client) => normalize(client.telefono).replace(/\D/g, "") === clean) || null;
}

function findServiceByName(name) {
  return dbTable("servicios").find((service) => normalize(service.servicio) === normalize(name));
}

function findStaffByName(name) {
  return dbTable("colaboradores").find((staff) => normalize(staff.nombreCompleto) === normalize(name));
}

function findAccountByName(name) {
  return dbTable("cuentas").find((account) => normalize(account.nombreCuenta) === normalize(name));
}

function accountAvailableBalance(accountName) {
  const account = findAccountByName(accountName);
  if (!accountName || !account) return 0;
  const accountId = account.cuentaID || "";
  const namesMatch = (value) => normalize(value) === normalize(accountName);
  const idsMatch = (value) => accountId && value === accountId;
  const opening = Number(account.balanceInicial) || 0;
  const income = dbTable("ingresos").reduce((sum, row) => {
    const matchesAccount = idsMatch(row.cuentaDestinoID) || namesMatch(row.cuentaDestino);
    return matchesAccount && normalize(row.estado || "Confirmado") === "confirmado" ? sum + (Number(row.montoNeto) || Number(row.montoBruto) || 0) : sum;
  }, 0);
  const expenses = dbTable("egresos").reduce((sum, row) => {
    const matchesAccount = idsMatch(row.cuentaOrigenID) || namesMatch(row.cuentaOrigen);
    return matchesAccount ? sum + (Number(row.monto) || 0) : sum;
  }, 0);
  const transferIn = dbTable("transferencias").reduce((sum, row) => {
    const matchesAccount = idsMatch(row.cuentaDestinoID) || namesMatch(row.cuentaDestino);
    return matchesAccount && normalize(row.estado || "Confirmada") === "confirmada" ? sum + (Number(row.monto) || 0) : sum;
  }, 0);
  const transferOut = dbTable("transferencias").reduce((sum, row) => {
    const matchesAccount = idsMatch(row.cuentaOrigenID) || namesMatch(row.cuentaOrigen);
    return matchesAccount && normalize(row.estado || "Confirmada") === "confirmada" ? sum + (Number(row.monto) || 0) : sum;
  }, 0);
  return opening + income + transferIn - expenses - transferOut;
}

function findSupplierByName(name) {
  return dbTable("suplidores").find((supplier) =>
    [supplier.nombre, supplier.nombreCompleto, supplier.empresa, supplier.suplidorNombre].some((field) => normalize(field) === normalize(name)),
  );
}

function defaultStaffRecord() {
  return dbTable("colaboradores")[0] || { colaboradorID: "", nombreCompleto: state.staff[0] || "" };
}

function accountForPayment(method) {
  const normalized = normalizePayment(method);
  const accounts = dbTable("cuentas");
  if (normalized === "efectivo") return accounts.find((account) => normalize(account.tipoProducto).includes("efectivo")) || accounts[0] || {};
  return accounts.find((account) => normalize(account.tipoCuenta).includes("banco")) || accounts[0] || {};
}

function accountForPaymentLine(method, accountName = "") {
  const normalized = normalizePayment(method);
  if (normalized === "efectivo") return accountForPayment("efectivo");
  if (normalized.includes("transferencia")) return findAccountByName(accountName) || {};
  return findAccountByName(accountName) || accountForPayment(method);
}

function currentUserEmail() {
  return supabaseSession?.user?.email || "local";
}

function currentUserRole() {
  return supabaseSession?.user?.user_metadata?.role || "";
}

function currentRoleKey() {
  return normalize(currentUserRole());
}

function canManageInvoices() {
  if (!supabaseClient || !supabaseSession) return true;
  return ["administradora", "administrador", "propietario"].includes(currentRoleKey());
}

function canConfirmClosings() {
  if (!supabaseClient || !supabaseSession) return true;
  return ["operador", "operadora", "administradora", "administrador", "propietario"].includes(currentRoleKey());
}

function closingForDate(date) {
  return dbTable("cierres")
    .filter((closing) => dateOnly(closing.fechaHoraCierre) === date)
    .sort((a, b) => String(b.fechaActualizacion || b.fechaHoraCierre).localeCompare(String(a.fechaActualizacion || a.fechaHoraCierre)))[0];
}

function isClosingOpenForEdits(closing) {
  const status = normalize(closing?.estado);
  return !closing || closing?.requiereConfirmacion || status.includes("abierto") || status.includes("provisional") || status.includes("pendiente");
}

function isClosingPendingConfirmation(closing) {
  const status = normalize(closing?.estado);
  return Boolean(closing?.requiereConfirmacion) || status.includes("abierto") || status.includes("provisional") || status.includes("pendiente");
}

function invoiceOperationalDate(invoiceId) {
  const invoice = dbTable("facturas").find((item) => item.facturaID === invoiceId);
  return dateOnly(invoice?.fechaHora);
}

function canEditInvoice(invoiceId) {
  if (!canManageInvoices()) return false;
  return isClosingOpenForEdits(closingForDate(invoiceOperationalDate(invoiceId)));
}

function canEditRecordDate(date) {
  if (!canManageInvoices()) return false;
  return isClosingOpenForEdits(closingForDate(date));
}

function stampRecord(record, action = "created") {
  const now = new Date().toISOString();
  if (action === "created" && !record.creadoPor) {
    record.creadoPor = currentUserEmail();
    record.fechaCreacion = now;
  }
  record.actualizadoPor = currentUserEmail();
  record.fechaActualizacion = now;
  return record;
}

function processorForPayment(method) {
  if (normalizePayment(method) !== "tarjeta") return {};
  return dbTable("procesadores").find((processor) => normalize(processor.estado || "Activo") === "activo") || dbTable("procesadores")[0] || {};
}

function findProcessorByName(name) {
  return dbTable("procesadores").find((processor) => normalize(processor.nombre) === normalize(name));
}

function processorFeeRate(processor) {
  const value = Number(processor?.comisionPorcentaje);
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > 1 ? value / 100 : value;
}

function addConfirmedPayment(invoiceId, clientRecord, clientName, amount, method, note = "", processorName = "", accountName = "", cashDate = "") {
  const paymentId = nextDbId("pagosFactura", "pagoID", "PAG");
  const incomeId = nextDbId("ingresos", "ingresoID", "ING");
  const applicationId = nextDbId("ingresoAplicaciones", "aplicacionID", "APL");
  const account = accountForPaymentLine(method, accountName);
  const processor = findProcessorByName(processorName) || processorForPayment(method);
  const retention = normalizePayment(method) === "tarjeta" ? amount * processorFeeRate(processor) : 0;
  const net = amount - retention;
  const effectiveDate = cashDate || today;
  const effectiveDateTime = dateTimeForOperationalDate(effectiveDate);

  dbTable("pagosFactura").push(stampRecord({
    pagoID: paymentId,
    facturaID: invoiceId,
    fechaHora: effectiveDateTime,
    metodoPago: method,
    estadoPago: "Confirmado",
    cuentaDestinoID: account.cuentaID || "",
    cuentaDestino: account.nombreCuenta || "",
    procesadorTarjetaID: processor.procesadorID || "",
    montoBruto: amount,
    retencionTarjeta: retention,
    montoNetoConfirmado: net,
    deudorTipo: "Cliente",
    deudorID: clientRecord?.clienteID || "",
    observaciones: note,
  }));
  dbTable("ingresos").push(stampRecord({
    ingresoID: incomeId,
    fechaHora: effectiveDateTime,
    fechaEntradaCaja: effectiveDate,
    tipoIngreso: note || "Cobro factura",
    facturaID: invoiceId,
    clienteID: clientRecord?.clienteID || "",
    clienteNombre: clientName,
    metodoPago: method,
    cuentaDestinoID: account.cuentaID || "",
    cuentaDestino: account.nombreCuenta || "",
    montoBruto: amount,
    retencion: retention,
    montoNeto: net,
    estado: "Confirmado",
    observaciones: "",
  }));
  dbTable("ingresoAplicaciones").push(stampRecord({
    aplicacionID: applicationId,
    ingresoID: incomeId,
    facturaID: invoiceId,
    pagoID: paymentId,
    cxCID: "",
    montoAplicado: amount,
    observaciones: "Aplicado a factura",
  }));
  state.payments.push({ id: paymentId, date: effectiveDate, invoiceId, client: clientName, amount: net, method: normalizePayment(method) });
  return paymentId;
}

function addReceivable(invoiceId, clientRecord, clientName, amount, concept, accountName = "", originDate = today) {
  const cxcId = nextDbId("cuentasCobrar", "cxCID", "CXC");
  const dueDate = concept.includes("Transferencia pendiente") || concept.includes("Declinada") ? originDate : datePlusDaysFrom(originDate, 7);
  const isProcessorReceivable = normalize(concept).includes("procesador");
  const account = findAccountByName(accountName);
  dbTable("cuentasCobrar").push(stampRecord({
    cxCID: cxcId,
    fechaOrigen: dateTimeForOperationalDate(originDate),
    tipoCxC: concept,
    deudorTipo: isProcessorReceivable ? "Procesador tarjeta" : "Cliente",
    deudorID: clientRecord?.clienteID || "",
    deudorNombre: clientName,
    facturaID: invoiceId,
    pagoID: "",
    montoOriginal: amount,
    montoAplicado: 0,
    balancePendiente: amount,
    estado: "Pendiente",
    concepto: concept,
    fechaVencimiento: dueDate,
    cuentaDestinoID: account?.cuentaID || "",
    cuentaDestino: account?.nombreCuenta || accountName,
  }));
  return cxcId;
}

function datePlusDays(days) {
  const date = new Date(`${today}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function clientBalance(clientId) {
  return dbTable("clientes").find((client) => client.clienteID === clientId)?.balanceFavor || 0;
}

function adjustClientBalance(clientId, amount) {
  const client = dbTable("clientes").find((item) => item.clienteID === clientId);
  if (!client) return 0;
  client.balanceFavor = Math.max(0, (Number(client.balanceFavor) || 0) + amount);
  return client.balanceFavor;
}

function isConfirmedPaymentMethod(method) {
  return ["efectivo", "transferencia_confirmada", "tarjeta", "balance"].includes(method);
}

function applyClientReceivablesFirst(clientRecord, clientName, amount, method, note = "Registro de ingreso aplicado a CxC", processorName = "", accountName = "", cashDate = "") {
  let remaining = amount;
  const receivables = dbTable("cuentasCobrar")
    .filter((cxc) => cxc.deudorTipo === "Cliente" && cxc.deudorID === clientRecord?.clienteID && Number(cxc.balancePendiente) > 0)
    .sort((a, b) => String(a.fechaOrigen).localeCompare(String(b.fechaOrigen)));

  receivables.forEach((cxc) => {
    if (remaining <= 0) return;
    const pending = Number(cxc.balancePendiente) || 0;
    const applied = Math.min(remaining, pending);
    cxc.montoAplicado = (Number(cxc.montoAplicado) || 0) + applied;
    cxc.balancePendiente = Math.max(0, pending - applied);
    cxc.estado = cxc.balancePendiente <= 0 ? "Saldada" : "Parcial";
    addConfirmedPayment(cxc.facturaID || "", clientRecord, clientName, applied, method, note, processorName, accountName, cashDate);
    remaining -= applied;
  });

  return remaining;
}

function byId(id) {
  return document.getElementById(id);
}

function uid(prefix, collection) {
  const next = collection.length + 1001;
  return `${prefix}-${next}`;
}

function normalize(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function matches(row, query, fields) {
  const q = normalize(query);
  return !q || fields.some((field) => normalize(row[field]).includes(q));
}

function renderEmpty(target, colspan, message) {
  target.innerHTML = `<tr><td colspan="${colspan}" class="empty">${message}</td></tr>`;
}

function ensureClient(name, phone = "", options = {}) {
  const clean = name.trim();
  if (!clean) return null;
  const email = String(options.email || "").trim();
  const existing = state.clients.find((client) => normalize(client.name) === normalize(clean));
  const dbExisting = findClientByName(clean);
  const clientId = dbExisting?.clienteID || existing?.id || nextDbId("clientes", "clienteID", "CLI");
  if (!existing) {
    state.clients.push({ id: clientId, name: clean, phone: phone.trim() });
  } else if (phone.trim() && !existing.phone) {
    existing.phone = phone.trim();
  }
  if (!dbExisting) {
    const nameParts = splitName(clean);
    dbTable("clientes").push(stampRecord({
      clienteID: clientId,
      nombreCompleto: clean,
      nombre: nameParts.first,
      apellido: nameParts.last,
      telefono: phone.trim(),
      sexo: "",
      correo: email,
      direccion: "",
      estado: "Activo",
      fechaRegistro: today,
      observaciones: options.note || "Creado desde facturación",
    }));
    return findClientByName(clean);
  } else if (dbExisting && phone.trim() && !dbExisting.telefono) {
    dbExisting.telefono = phone.trim();
  }
  if (dbExisting && email && !dbExisting.correo) dbExisting.correo = email;
  return dbExisting || findClientByName(clean);
}

function ensureService(name, price) {
  const clean = name.trim();
  if (!clean) return;
  const existing = state.services.find((service) => normalize(service.name) === normalize(clean));
  const dbExisting = findServiceByName(clean);
  if (!existing) {
    const id = dbExisting?.servicioID || nextDbId("servicios", "servicioID", "SER");
    state.services.push({ id, name: clean, price: Number(price) || 0 });
  }
  if (!dbExisting) {
    dbTable("servicios").push(stampRecord({
      servicioID: state.services.find((service) => normalize(service.name) === normalize(clean))?.id || nextDbId("servicios", "servicioID", "SER"),
      servicio: clean,
      categoria: "Uñas",
      precioBase: Number(price) || 0,
      duracionMin: 45,
      estado: "Activo",
    }));
  }
}

function reservationRecordById(reservationId) {
  const stateRecord = state.reservations.find((item) => item.id === reservationId);
  const dbRecord = dbTable("reservas").find((item) => item.reservaID === reservationId);
  return { stateRecord, dbRecord, record: stateRecord || dbRecord };
}

function fillReservationClientFromRecord(client) {
  if (!client) return false;
  byId("reservation-form").dataset.clientId = client.clienteID || "";
  byId("reservation-client-search").value = client.nombreCompleto || "";
  byId("reservation-client-phone").value = client.telefono || "";
  byId("reservation-client-email").value = client.correo || "";
  byId("reservation-client-phone").dataset.autofilled = "true";
  byId("reservation-client-email").dataset.autofilled = "true";
  return true;
}

function clearAutofilledReservationClientFields() {
  delete byId("reservation-form").dataset.clientId;
  const phoneField = byId("reservation-client-phone");
  const emailField = byId("reservation-client-email");
  if (phoneField.dataset.autofilled === "true") phoneField.value = "";
  if (emailField.dataset.autofilled === "true") emailField.value = "";
  delete phoneField.dataset.autofilled;
  delete emailField.dataset.autofilled;
}

function ensureClientFromReservation(reservation) {
  if (!reservation) return null;
  const clientName = reservation.client || reservation.clienteNombre || "";
  const phone = reservation.phone || reservation.telefono || "";
  const email = reservation.email || reservation.correo || "";
  const source = reservation.source || reservation.canalOrigen || "Reserva";
  const clientRecord =
    (phone && findClientByPhone(phone)) ||
    findClientByName(clientName) ||
    ensureClient(clientName, phone, {
      email,
      note: `Cliente provisional convertido desde reserva (${source})`,
    });
  if (clientRecord) {
    if (email && !clientRecord.correo) clientRecord.correo = email;
    if (phone && !clientRecord.telefono) clientRecord.telefono = phone;
  }
  return clientRecord;
}

function servicePrice(name) {
  const service = state.services.find((item) => normalize(item.name) === normalize(name));
  return service ? service.price : "";
}

function outstanding(invoice) {
  return Math.max(0, invoice.total - invoice.paid);
}

function cashExpectedFor(date) {
  const invoiceCash = state.invoices
    .filter((invoice) => invoice.date === date && invoice.payment === "efectivo")
    .reduce((sum, invoice) => sum + invoice.paid, 0);
  const arCash = state.payments
    .filter((payment) => payment.date === date && payment.method === "efectivo")
    .reduce((sum, payment) => sum + payment.amount, 0);
  return invoiceCash + arCash;
}

function dailyIncomeSummary(date) {
  const income = dbTable("ingresos").filter((row) => dateOnly(row.fechaHora) === date && row.estado === "Confirmado");
  const receivables = dbTable("cuentasCobrar").filter((row) => dateOnly(row.fechaOrigen) === date && Number(row.balancePendiente) > 0);
  const byMethod = income.reduce(
    (summary, row) => {
      const method = normalizePayment(row.metodoPago);
      if (method === "efectivo") summary.cash += Number(row.montoNeto) || 0;
      if (method === "tarjeta") summary.card += Number(row.montoBruto) || 0;
      if (method === "transferencia") summary.transfer += Number(row.montoNeto) || 0;
      return summary;
    },
    { cash: 0, card: 0, transfer: 0, credit: 0 },
  );
  byMethod.credit = receivables
    .filter((row) => row.deudorTipo === "Cliente" && !String(row.concepto || "").includes("procesador"))
    .reduce((sum, row) => sum + (Number(row.balancePendiente) || 0), 0);
  return byMethod;
}

function ensureProvisionalClosings() {
  const dates = new Set();
  [
    ["facturas", "fechaHora"],
    ["ingresos", "fechaHora"],
    ["egresos", "fechaHora"],
    ["transferencias", "fechaHora"],
    ["propinas", "fechaHora"],
    ["cuentasCobrar", "fechaOrigen"],
  ].forEach(([tableName, field]) => {
    dbTable(tableName).forEach((row) => {
      const date = dateOnly(row[field]);
      if (date && date <= today) dates.add(date);
    });
  });
  let created = 0;
  [...dates].sort().forEach((date) => {
    if (closingForDate(date)) return;
    const summary = dailyIncomeSummary(date);
    const expenses = dbTable("egresos")
      .filter((expense) => dateOnly(expense.fechaHora) === date)
      .reduce((sum, expense) => sum + (Number(expense.monto) || 0), 0);
    const account = accountForPayment("efectivo");
    dbTable("cierres").push(stampRecord({
      cierreID: nextDbId("cierres", "cierreID", "CIE"),
      fechaHoraCierre: `${date}T23:59:00`,
      cajero: "Cierre provisional automático",
      cuentaCaja: account.nombreCuenta || "Caja registradora",
      cuentaID: account.cuentaID || "",
      balanceInicial: 0,
      ingresosConfirmados: summary.cash,
      egresos: expenses,
      balanceTeorico: summary.cash,
      balanceContado: 0,
      conteoInicial: 0,
      balanceContadoRectificado: 0,
      diferenciaInicial: -(summary.cash + expenses),
      diferencia: -(summary.cash + expenses),
      cuadreFaltante: summary.cash + expenses,
      cuadreFaltanteInicial: summary.cash + expenses,
      sobranteCaja: 0,
      tarjetaContada: 0,
      tarjetaEsperada: summary.card,
      transferenciaContada: 0,
      transferenciaEsperada: summary.transfer,
      creditoGenerado: summary.credit,
      estado: "Pendiente de confirmacion",
      requiereConfirmacion: true,
      provisional: true,
      observaciones: "Generado automáticamente porque el día tenía registros y no se confirmó cierre.",
    }));
    created += 1;
  });
  return created;
}

function moveInvoicesBetweenDates(sourceDate, targetDate) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede mover fechas de facturas.");
    return 0;
  }
  if (!sourceDate || !targetDate || sourceDate === targetDate) return 0;
  const invoices = dbTable("facturas").filter((invoice) => dateOnly(invoice.fechaHora) === sourceDate);
  moveLinkedRecordsForInvoices(invoices, sourceDate, targetDate);
  ensureProvisionalClosings();
  state = stateFromDatabase(database);
  saveState();
  renderAll();
  return invoices.length;
}

function moveLinkedRecordsForInvoices(invoices, sourceDate, targetDate) {
  const invoiceIds = new Set(invoices.map((invoice) => invoice.facturaID));
  invoices.forEach((invoice) => {
    invoice.fechaHora = withDateOnly(invoice.fechaHora, targetDate);
    stampRecord(invoice, "updated");
  });
  dbTable("pagosFactura")
    .filter((payment) => invoiceIds.has(payment.facturaID) && dateOnly(payment.fechaHora) === sourceDate)
    .forEach((payment) => {
      payment.fechaHora = withDateOnly(payment.fechaHora, targetDate);
      stampRecord(payment, "updated");
    });
  dbTable("ingresos")
    .filter((income) => invoiceIds.has(income.facturaID) && dateOnly(income.fechaHora) === sourceDate)
    .forEach((income) => {
      income.fechaHora = withDateOnly(income.fechaHora, targetDate);
      if (dateOnly(income.fechaEntradaCaja) === sourceDate) income.fechaEntradaCaja = targetDate;
      stampRecord(income, "updated");
    });
  dbTable("cuentasCobrar")
    .filter((receivable) => invoiceIds.has(receivable.facturaID) && dateOnly(receivable.fechaOrigen) === sourceDate)
    .forEach((receivable) => {
      receivable.fechaOrigen = withDateOnly(receivable.fechaOrigen, targetDate);
      if (receivable.fechaVencimiento === sourceDate) receivable.fechaVencimiento = targetDate;
      if (receivable.fechaVencimiento === datePlusDaysFrom(sourceDate, 7)) receivable.fechaVencimiento = datePlusDaysFrom(targetDate, 7);
      stampRecord(receivable, "updated");
    });
  dbTable("propinas")
    .filter((tip) => invoiceIds.has(tip.facturaID) && dateOnly(tip.fechaHora) === sourceDate)
    .forEach((tip) => {
      tip.fechaHora = withDateOnly(tip.fechaHora, targetDate);
      stampRecord(tip, "updated");
    });
}

function closingAllowsDateChange(sourceDate, targetDate) {
  const sourceClosing = closingForDate(sourceDate);
  const targetClosing = closingForDate(targetDate);
  if (!isClosingOpenForEdits(sourceClosing) || !isClosingOpenForEdits(targetClosing)) {
    alert("Para cambiar esa fecha, primero administración debe abrir o anular el cierre del día origen y del día destino si ya existen.");
    return false;
  }
  return true;
}

function changeInvoiceDate(invoiceId) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede cambiar fechas de facturas.");
    return;
  }
  const invoice = dbTable("facturas").find((item) => item.facturaID === invoiceId);
  if (!invoice) return;
  const sourceDate = dateOnly(invoice.fechaHora);
  const targetDate = prompt(`Nueva fecha operativa para la factura ${invoiceId}`, sourceDate);
  if (!targetDate || targetDate === sourceDate) return;
  if (!closingAllowsDateChange(sourceDate, targetDate)) return;
  if (!confirm(`Mover la factura ${invoiceId} de ${sourceDate} a ${targetDate}. También se moverán sus pagos, ingresos, propinas y CxC vinculadas. ¿Continuar?`)) return;
  moveLinkedRecordsForInvoices([invoice], sourceDate, targetDate);
  ensureProvisionalClosings();
  state = stateFromDatabase(database);
  saveState();
  renderAll();
}

function updateInvoiceDateFromAdmin(invoiceId, targetDate) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede cambiar fechas de facturas.");
    return;
  }
  const invoice = dbTable("facturas").find((item) => item.facturaID === invoiceId);
  if (!invoice) return;
  const sourceDate = dateOnly(invoice.fechaHora);
  if (!targetDate || targetDate === sourceDate) return;
  if (!closingAllowsDateChange(sourceDate, targetDate)) return;
  if (!confirm(`Cambiar la factura ${invoiceId} de ${sourceDate} a ${targetDate}. También se moverán pagos, ingresos, propinas y CxC vinculadas. ¿Continuar?`)) return;
  moveLinkedRecordsForInvoices([invoice], sourceDate, targetDate);
  ensureProvisionalClosings();
  state = stateFromDatabase(database);
  saveState();
  renderAll();
}

function moveBuggedJuly9InvoicesToJuly8() {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede mover fechas de facturas.");
    return;
  }
  const sourceDate = "2026-07-09";
  const targetDate = "2026-07-08";
  const invoices = dbTable("facturas").filter((invoice) => dateOnly(invoice.fechaHora) === sourceDate);
  const targetCount = dbTable("facturas").filter((invoice) => dateOnly(invoice.fechaHora) === targetDate).length;
  if (!invoices.length) {
    alert(
      targetCount
        ? `No hay facturas en ${sourceDate}. Ya existen ${targetCount} factura(s) en ${targetDate}; probablemente ya fueron corregidas.`
        : `No hay facturas en ${sourceDate} ni en ${targetDate}.`,
    );
    return;
  }
  if (!closingAllowsDateChange(sourceDate, targetDate)) return;
  if (!confirm(`Se encontraron ${invoices.length} factura(s) con fecha ${sourceDate}. Se moverán a ${targetDate} junto con pagos, ingresos, propinas y CxC vinculadas. ¿Continuar?`)) return;
  moveLinkedRecordsForInvoices(invoices, sourceDate, targetDate);
  ensureProvisionalClosings();
  state = stateFromDatabase(database);
  saveState();
  renderAll();
  alert(`Listo. Se movieron ${invoices.length} factura(s) de ${sourceDate} a ${targetDate}.`);
}

function moveTodayInvoicesToYesterday() {
  const defaultSource = datePlusDaysFrom(today, -1);
  const defaultTarget = datePlusDaysFrom(today, -2);
  const sourceDate = prompt("Fecha origen de las facturas a mover", defaultSource);
  if (!sourceDate) return;
  const targetDate = prompt("Fecha destino de esas facturas", defaultTarget);
  if (!targetDate) return;
  const sourceCount = dbTable("facturas").filter((invoice) => dateOnly(invoice.fechaHora) === sourceDate).length;
  const targetCount = dbTable("facturas").filter((invoice) => dateOnly(invoice.fechaHora) === targetDate).length;
  if (!sourceCount) {
    if (targetCount) {
      alert(`No hay facturas en ${sourceDate}. Sí hay ${targetCount} factura(s) en ${targetDate}; probablemente ya fueron movidas antes.`);
      return;
    }
    alert(`No hay facturas en ${sourceDate} ni en ${targetDate}. Revisa la fecha operativa antes de mover.`);
    return;
  }
  if (!confirm(`Se moverán ${sourceCount} factura(s) de ${sourceDate} a ${targetDate}. También se moverán ingresos, pagos, propinas y CxC ligados a esas facturas cuando tengan fecha origen. ¿Continuar?`)) return;
  const moved = moveInvoicesBetweenDates(sourceDate, targetDate);
  if (moved > 0) alert(`Listo. Se movieron ${moved} factura(s) de ${sourceDate} a ${targetDate}.`);
}

function updateCashBalancePreview() {
  const countedRaw = byId("cash-counted").value;
  const panel = byId("cash-balance-panel");
  if (countedRaw === "") {
    resetCashBalancePreview();
    return;
  }
  const date = byId("cash-date").value || today;
  const summary = dailyIncomeSummary(date);
  const expected = summary.cash;
  const counted = Number(countedRaw) || 0;
  const expenses = Number(byId("cash-expenses").value) || 0;
  const effectiveCounted = counted - expenses;
  const difference = effectiveCounted - expected;
  const shortage = Math.max(0, -difference);
  const surplus = Math.max(0, difference);
  cashBalanceDraft = { date, expected, counted, expenses, difference, shortage, surplus, generatedAt: new Date().toISOString() };

  byId("cash-expected-preview").textContent = money.format(expected);
  byId("cash-difference-preview").textContent = money.format(difference);
  byId("cash-shortage-preview").textContent = money.format(shortage);
  byId("cash-surplus-preview").textContent = money.format(surplus);
  panel.classList.remove("hidden");
  byId("cash-shortage-label").classList.toggle("hidden", shortage <= 0);
  if (shortage > 0) byId("cash-rectified-counted").value = "";
}

function resetCashBalancePreview() {
  cashBalanceDraft = null;
  byId("cash-balance-panel").classList.add("hidden");
  byId("cash-shortage-label").classList.add("hidden");
  byId("cash-shortage-note").value = "";
  byId("cash-rectified-counted").value = "";
}

function renderDatalists() {
  byId("clients-list").innerHTML = uniqueOptions(state.clients.map((client) => client.name));
  byId("people-list").innerHTML = uniqueOptions([...state.clients.map((client) => client.name), ...state.staff]);
  byId("advance-people-list").innerHTML = uniqueOptions([
    ...state.staff,
    ...dbTable("suplidores").map((supplier) => supplier.nombre || supplier.nombreCompleto || supplier.empresa || supplier.suplidorNombre),
  ]);
  byId("services-list").innerHTML = uniqueOptions(state.services.map((service) => service.name));
  byId("staff-list").innerHTML = uniqueOptions(state.staff);
  byId("accounts-list").innerHTML = uniqueOptions(dbTable("cuentas").map((account) => account.nombreCuenta));
  byId("bank-accounts-list").innerHTML = uniqueOptions(
    dbTable("cuentas")
      .filter((account) => normalize(account.tipoCuenta).includes("banco"))
      .map((account) => account.nombreCuenta),
  );
  byId("processors-list").innerHTML = uniqueOptions(
    dbTable("procesadores")
      .filter((processor) => normalize(processor.estado || "Activo") === "activo")
      .map((processor) => processor.nombre),
  );
  byId("expense-concept-list").innerHTML = uniqueOptions(dbTable("conceptosEgresos").map((concept) => concept.concepto || concept.nombreConcepto));
  byId("commission-threshold-list").innerHTML = uniqueOptions(dbTable("umbralesComision").map((row) => row.aplicaA || row.escalaID));
  byId("payroll-discount-concept-list").innerHTML = uniqueOptions([
    "AFP",
    "Seguro",
    "Otros",
    ...dbTable("conceptosDescuentoNomina").map((row) => row.concepto),
  ]);
}

function renderStaffThresholdChoices(selectedIds = []) {
  const target = byId("staff-commission-thresholds");
  const activeThresholds = dbTable("umbralesComision").filter((row) => normalize(row.estado || "Activo") === "activo");
  if (!activeThresholds.length) {
    target.innerHTML = '<p class="empty">No hay umbrales activos. Crea umbrales en el módulo Umbrales comisión.</p>';
    return;
  }
  const selected = new Set(selectedIds.filter(Boolean));
  target.innerHTML = activeThresholds
    .map(
      (row) => `
        <label>
          <input class="staff-threshold-option" type="checkbox" value="${row.escalaID}" ${selected.has(row.escalaID) ? "checked" : ""} />
          <span>${row.aplicaA || row.escalaID} · ${money.format(Number(row.desde) || 0)} a ${money.format(Number(row.hasta) || 0)} · ${((Number(row.porcentajeComision) || 0) * 100).toFixed(2)}%</span>
        </label>
      `,
    )
    .join("");
}

function selectedStaffThresholdIds() {
  return [...document.querySelectorAll(".staff-threshold-option:checked")].map((input) => input.value);
}

function uniqueOptions(values) {
  return [...new Set(values.filter(Boolean))].map((value) => `<option value="${escapeHtml(value)}"></option>`).join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderDashboard() {
  const todayInvoices = state.invoices.filter((invoice) => invoice.date === today);
  const todayPayments = state.payments.filter((payment) => payment.date === today);
  const todayReservations = state.reservations.filter((reservation) => reservation.date === today).sort((a, b) => a.time.localeCompare(b.time));

  const invoiced = todayInvoices.reduce((sum, invoice) => sum + invoice.total, 0);
  const collectedAr = todayPayments.reduce((sum, payment) => sum + payment.amount, 0);

  byId("metric-invoices").textContent = money.format(invoiced);
  byId("metric-ar").textContent = money.format(collectedAr);
  byId("metric-bookings").textContent = todayReservations.length;
  byId("metric-cash").textContent = money.format(cashExpectedFor(today));

  const invoiceTarget = byId("today-invoices");
  if (!todayInvoices.length) renderEmpty(invoiceTarget, 5, "No hay facturas registradas hoy.");
  else {
    invoiceTarget.innerHTML = todayInvoices
      .map(
        (invoice) => `
          <tr>
            <td>${invoice.id}</td>
            <td>${invoice.client}</td>
            <td>${invoice.service}</td>
            <td>${money.format(invoice.total)}</td>
            <td>${statusBadge(invoice)}</td>
          </tr>
        `,
      )
      .join("");
  }

  const paymentTarget = byId("today-payments");
  if (!todayPayments.length) renderEmpty(paymentTarget, 3, "No hay cobros de cuentas por cobrar hoy.");
  else {
    paymentTarget.innerHTML = todayPayments
      .map(
        (payment) => `
          <tr>
            <td>${payment.client}</td>
            <td>${money.format(payment.amount)}</td>
            <td>${payment.invoiceId}</td>
          </tr>
        `,
      )
      .join("");
  }

  renderAppointments(byId("today-appointments"), todayReservations, "No hay citas para hoy.");
}

function statusBadge(invoice) {
  if (outstanding(invoice) <= 0) return '<span class="badge paid">Pagada</span>';
  if (invoice.paid > 0) return '<span class="badge credit">Abonada</span>';
  return '<span class="badge pending">Pendiente</span>';
}

function renderInvoices() {
  const query = byId("invoice-search").value;
  const rows = state.invoices
    .filter((invoice) => matches(invoice, query, ["id", "client", "service", "payment"]))
    .sort((a, b) => `${b.date || ""} ${b.id || ""}`.localeCompare(`${a.date || ""} ${a.id || ""}`));
  const target = byId("invoice-table");
  if (!rows.length) return renderEmpty(target, 7, "No hay facturas con ese criterio.");
  target.innerHTML = rows
    .map((invoice) => {
      const editable = canEditInvoice(invoice.id);
      return `
        <tr data-invoice-id="${escapeHtml(invoice.id)}">
          <td>${invoice.id}</td>
          <td>${invoice.date}</td>
          <td>${invoice.client}</td>
          <td>${invoice.service}</td>
          <td>${money.format(invoice.total)}</td>
          <td>${invoice.payment}</td>
          <td>
            <div class="row-actions">
              <button class="secondary-btn compact view-invoice" type="button">Ver</button>
              ${editable ? '<button class="secondary-btn compact edit-invoice" type="button">Editar</button>' : ""}
              ${editable ? '<button class="secondary-btn compact date-invoice" type="button">Fecha</button>' : ""}
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderInvoiceAdmin() {
  const target = byId("invoice-admin-table");
  if (!target) return;
  if (!canManageInvoices()) {
    return renderEmpty(target, 6, "Solo administración o propietario puede usar este módulo.");
  }
  const query = normalize(byId("invoice-admin-search")?.value || "");
  const rows = dbTable("facturas")
    .filter((invoice) => {
      if (!query) return true;
      return [invoice.facturaID, invoice.clienteNombre, invoice.estadoFactura, dateOnly(invoice.fechaHora)].some((field) => normalize(field).includes(query));
    })
    .sort((a, b) => String(b.fechaHora || "").localeCompare(String(a.fechaHora || "")));
  if (!rows.length) return renderEmpty(target, 6, "No hay facturas registradas.");
  target.innerHTML = rows
    .map((invoice) => {
      const invoiceDate = dateOnly(invoice.fechaHora);
      const closing = closingForDate(invoiceDate);
      const editable = canEditRecordDate(invoiceDate);
      const closingStatus = closing ? closing.estado || "Cerrado" : "Sin cierre";
      return `
        <tr data-invoice-id="${escapeHtml(invoice.facturaID)}">
          <td>${invoice.facturaID}</td>
          <td>${invoiceDate}</td>
          <td>${invoice.clienteNombre || "-"}</td>
          <td class="amount">${money.format(Number(invoice.totalFacturado) || 0)}</td>
          <td>${escapeHtml(closingStatus)}</td>
          <td>
            <div class="row-actions">
              <button class="secondary-btn compact view-invoice-admin" type="button">Ver</button>
              ${editable ? '<button class="secondary-btn compact edit-invoice-admin" type="button">Editar factura</button>' : ""}
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function invoiceReportData(invoiceId) {
  const invoice = state.invoices.find((item) => item.id === invoiceId);
  const dbInvoice = dbTable("facturas").find((item) => item.facturaID === invoiceId);
  const details = dbTable("facturaDetalle").filter((item) => item.facturaID === invoiceId);
  const payments = dbTable("ingresos").filter((item) => item.facturaID === invoiceId);
  return { invoice, dbInvoice, details, payments };
}

function invoiceReportHtml(invoiceId) {
  const { invoice, dbInvoice, details, payments } = invoiceReportData(invoiceId);
  if (!invoice && !dbInvoice) return "<p>Factura no encontrada.</p>";
  const client = invoice?.client || dbInvoice?.clienteNombre || "";
  const date = invoice?.date || dateOnly(dbInvoice?.fechaHora);
  const total = Number(invoice?.total ?? dbInvoice?.totalFacturado) || 0;
  const paid = Number(invoice?.paid ?? dbInvoice?.totalPagadoConfirmado) || 0;
  const note = invoice?.note || dbInvoice?.observaciones || "";
  const lines = details.length
    ? details
    : [{ servicio: invoice?.service || "Servicio", colaboradorNombre: dbInvoice?.colaboradorNombre || "", subtotal: total }];
  return `
    <section class="invoice-report">
      <h1>Dalfi Studio Nails</h1>
      <p>SeBen ERP</p>
      <hr />
      <h2>Factura ${escapeHtml(invoiceId)}</h2>
      <p><strong>Fecha:</strong> ${escapeHtml(date || "")}</p>
      <p><strong>Cliente:</strong> ${escapeHtml(client)}</p>
      <table>
        <thead><tr><th>Servicio</th><th>Colaborador/a</th><th>Monto</th></tr></thead>
        <tbody>
          ${lines
            .map(
              (line) => `<tr><td>${escapeHtml(line.servicio || "")}</td><td>${escapeHtml(line.colaboradorNombre || "")}</td><td>${money.format(Number(line.subtotal) || 0)}</td></tr>`,
            )
            .join("")}
        </tbody>
      </table>
      <div class="invoice-totals">
        <p><strong>Total:</strong> ${money.format(total)}</p>
        <p><strong>Pagado confirmado:</strong> ${money.format(paid)}</p>
        <p><strong>Balance:</strong> ${money.format(Math.max(0, total - paid))}</p>
      </div>
      ${
        payments.length
          ? `<h3>Pagos</h3><ul>${payments.map((payment) => `<li>${escapeHtml(payment.metodoPago || "")}: ${money.format(Number(payment.montoBruto) || Number(payment.montoNeto) || 0)}</li>`).join("")}</ul>`
          : ""
      }
      ${note ? `<p><strong>Nota:</strong> ${escapeHtml(note)}</p>` : ""}
    </section>
  `;
}

function openInvoiceReport(invoiceId) {
  const popup = window.open("", "_blank");
  if (!popup) return;
  popup.document.write(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <title>Factura ${escapeHtml(invoiceId)}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 32px; color: #202225; }
          h1, h2, h3, p { margin: 0 0 10px; }
          table { width: 100%; border-collapse: collapse; margin: 18px 0; }
          th, td { border-bottom: 1px solid #ddd; padding: 10px; text-align: left; }
          th { background: #fbfaf7; }
          .invoice-report { max-width: 760px; margin: 0 auto; }
          .invoice-totals { margin-left: auto; max-width: 280px; }
          .report-actions { display: flex; gap: 10px; margin: 0 auto 18px; max-width: 760px; }
          button { border: 1px solid #d8d3c8; background: #fff; border-radius: 8px; padding: 10px 14px; font-weight: 700; cursor: pointer; }
          @media print { .report-actions { display: none; } body { margin: 18px; } }
        </style>
      </head>
      <body>
        <div class="report-actions">
          <button onclick="window.print()">Imprimir / guardar PDF</button>
          <button onclick="window.opener.downloadInvoiceImage('${escapeHtml(invoiceId)}')">Guardar imagen</button>
        </div>
        ${invoiceReportHtml(invoiceId)}
      </body>
    </html>
  `);
  popup.document.close();
}

function openRecordReport(title, bodyHtml) {
  const popup = window.open("", "_blank");
  if (!popup) return;
  popup.document.write(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(title)}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 32px; color: #202225; }
          h1, h2, h3, p { margin: 0 0 10px; }
          table { width: 100%; border-collapse: collapse; margin: 18px 0; }
          th, td { border-bottom: 1px solid #ddd; padding: 10px; text-align: left; }
          th { background: #fbfaf7; }
          .record-report { max-width: 760px; margin: 0 auto; }
          .report-actions { display: flex; gap: 10px; margin: 0 auto 18px; max-width: 760px; }
          button { border: 1px solid #d8d3c8; background: #fff; border-radius: 8px; padding: 10px 14px; font-weight: 700; cursor: pointer; }
          @media print { .report-actions { display: none; } body { margin: 18px; } }
        </style>
      </head>
      <body>
        <div class="report-actions">
          <button onclick="window.print()">Imprimir / guardar PDF</button>
        </div>
        <section class="record-report">
          <h1>Dalfi Studio Nails</h1>
          <p>SeBen ERP</p>
          <hr />
          ${bodyHtml}
        </section>
      </body>
    </html>
  `);
  popup.document.close();
}

function openIncomeReport(incomeId) {
  const income = dbTable("ingresos").find((row) => row.ingresoID === incomeId);
  if (!income) return;
  openRecordReport(
    `Ingreso ${incomeId}`,
    `
      <h2>Ingreso ${escapeHtml(incomeId)}</h2>
      <p><strong>Fecha:</strong> ${escapeHtml(dateOnly(income.fechaHora))}</p>
      <p><strong>Fecha entrada caja:</strong> ${escapeHtml(dateOnly(income.fechaEntradaCaja) || "")}</p>
      <p><strong>Factura:</strong> ${escapeHtml(income.facturaID || "-")}</p>
      <p><strong>Cliente:</strong> ${escapeHtml(income.clienteNombre || "-")}</p>
      <p><strong>Método:</strong> ${escapeHtml(income.metodoPago || "-")}</p>
      <p><strong>Cuenta destino:</strong> ${escapeHtml(income.cuentaDestino || "-")}</p>
      <p><strong>Monto bruto:</strong> ${money.format(Number(income.montoBruto) || 0)}</p>
      <p><strong>Retención:</strong> ${money.format(Number(income.retencion) || 0)}</p>
      <p><strong>Monto neto:</strong> ${money.format(Number(income.montoNeto) || 0)}</p>
      <p><strong>Estado:</strong> ${escapeHtml(income.estado || "")}</p>
      ${income.observaciones ? `<p><strong>Nota:</strong> ${escapeHtml(income.observaciones)}</p>` : ""}
    `,
  );
}

function openExpenseReport(expenseId) {
  const expense = dbTable("egresos").find((row) => row.egresoID === expenseId);
  if (!expense) return;
  openRecordReport(
    `Egreso ${expenseId}`,
    `
      <h2>Egreso ${escapeHtml(expenseId)}</h2>
      <p><strong>Fecha:</strong> ${escapeHtml(dateOnly(expense.fechaHora))}</p>
      <p><strong>Tipo:</strong> ${escapeHtml(expense.tipoEgreso || "")}</p>
      <p><strong>Origen:</strong> ${escapeHtml(expense.cuentaOrigen || "-")}</p>
      <p><strong>Destino:</strong> ${escapeHtml(expense.cuentaDestino || "-")}</p>
      <p><strong>Concepto:</strong> ${escapeHtml(expense.concepto || "")}</p>
      <p><strong>Monto:</strong> ${money.format(Number(expense.monto) || 0)}</p>
      <p><strong>Estado:</strong> ${escapeHtml(expense.estado || "")}</p>
      ${expense.observaciones ? `<p><strong>Nota:</strong> ${escapeHtml(expense.observaciones)}</p>` : ""}
    `,
  );
}

function openClosingReport(closingId) {
  const closing = dbTable("cierres").find((row) => row.cierreID === closingId);
  if (!closing) return;
  openRecordReport(
    `Cierre ${closingId}`,
    `
      <h2>Cierre ${escapeHtml(closingId)}</h2>
      <p><strong>Fecha:</strong> ${escapeHtml(dateOnly(closing.fechaHoraCierre))}</p>
      <p><strong>Cajero:</strong> ${escapeHtml(closing.cajero || "-")}</p>
      <p><strong>Caja:</strong> ${escapeHtml(closing.cuentaCaja || "-")}</p>
      <p><strong>Esperado efectivo:</strong> ${money.format(Number(closing.balanceTeorico) || 0)}</p>
      <p><strong>Contado:</strong> ${money.format(Number(closing.balanceContado) || 0)}</p>
      <p><strong>Diferencia:</strong> ${money.format(Number(closing.diferencia) || 0)}</p>
      <p><strong>Tarjeta contada:</strong> ${money.format(Number(closing.tarjetaContada) || 0)}</p>
      <p><strong>Transferencia contada:</strong> ${money.format(Number(closing.transferenciaContada) || 0)}</p>
      <p><strong>Estado:</strong> ${escapeHtml(closing.estado || "")}</p>
      ${closing.observaciones ? `<p><strong>Nota:</strong> ${escapeHtml(closing.observaciones)}</p>` : ""}
    `,
  );
}

function downloadInvoiceImage(invoiceId) {
  const { invoice, dbInvoice, details } = invoiceReportData(invoiceId);
  if (!invoice && !dbInvoice) return;
  const client = invoice?.client || dbInvoice?.clienteNombre || "";
  const total = Number(invoice?.total ?? dbInvoice?.totalFacturado) || 0;
  const lines = details.length ? details : [{ servicio: invoice?.service || "Servicio", subtotal: total }];
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 360 + lines.length * 38;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#202225";
  ctx.font = "bold 34px Arial";
  ctx.fillText("Dalfi Studio Nails", 40, 55);
  ctx.font = "18px Arial";
  ctx.fillText("SeBen ERP", 40, 84);
  ctx.font = "bold 26px Arial";
  ctx.fillText(`Factura ${invoiceId}`, 40, 130);
  ctx.font = "18px Arial";
  ctx.fillText(`Cliente: ${client}`, 40, 168);
  ctx.fillText(`Fecha: ${invoice?.date || dateOnly(dbInvoice?.fechaHora) || ""}`, 40, 198);
  let y = 250;
  ctx.font = "bold 18px Arial";
  ctx.fillText("Servicio", 40, y);
  ctx.fillText("Monto", 720, y);
  ctx.font = "18px Arial";
  lines.forEach((line) => {
    y += 38;
    ctx.fillText(String(line.servicio || "").slice(0, 58), 40, y);
    ctx.fillText(money.format(Number(line.subtotal) || 0), 720, y);
  });
  y += 55;
  ctx.font = "bold 24px Arial";
  ctx.fillText(`Total: ${money.format(total)}`, 580, y);
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = `${invoiceId}.png`;
  link.click();
}

function renderReceivables() {
  const query = byId("ar-search").value;
  const rows = dbTable("cuentasCobrar")
    .filter((cxc) => Number(cxc.balancePendiente) > 0)
    .filter((cxc) => matches(cxc, query, ["cxCID", "facturaID", "deudorNombre", "concepto", "tipoCxC"]))
    .sort((a, b) => `${dateOnly(b.fechaOrigen) || ""} ${b.cxCID || ""}`.localeCompare(`${dateOnly(a.fechaOrigen) || ""} ${a.cxCID || ""}`));
  const target = byId("ar-table");
  if (!rows.length) renderEmpty(target, 6, "No hay cuentas pendientes.");
  else {
    target.innerHTML = rows
      .map(
        (cxc) => {
          const isPendingTransfer = normalize(`${cxc.tipoCxC} ${cxc.concepto}`).includes("transferencia pendiente");
          return `
          <tr>
            <td>${cxc.facturaID || cxc.cxCID}</td>
            <td>${cxc.deudorNombre || "Sin cliente"}</td>
            <td>${money.format(Number(cxc.montoOriginal) || 0)}</td>
            <td>${money.format(Number(cxc.montoAplicado) || 0)}</td>
            <td class="amount danger">${money.format(Number(cxc.balancePendiente) || 0)}</td>
            <td>
              ${
                isPendingTransfer
                  ? `<button class="secondary-btn compact confirm-transfer" data-cxc-id="${cxc.cxCID}" type="button">Confirmar</button>
                     <button class="secondary-btn compact decline-transfer" data-cxc-id="${cxc.cxCID}" type="button">Declinar</button>`
                  : `<span class="muted">${cxc.estado || "Pendiente"}</span>`
              }
            </td>
          </tr>
        `;
        },
      )
      .join("");
  }

  const select = byId("payment-invoice");
  select.innerHTML = rows
    .map((cxc) => `<option value="${cxc.facturaID}">${cxc.facturaID || cxc.cxCID} - ${cxc.deudorNombre} - ${money.format(Number(cxc.balancePendiente) || 0)}</option>`)
    .join("");
  if (!rows.length) select.innerHTML = '<option value="">No hay facturas pendientes</option>';
}

function renderIncomeRecords() {
  const target = byId("income-table");
  if (!target) return;
  const rows = dbTable("ingresos").slice().sort((a, b) => String(b.fechaHora || "").localeCompare(String(a.fechaHora || ""))).slice(0, 100);
  if (!rows.length) return renderEmpty(target, 6, "No hay ingresos registrados.");
  target.innerHTML = rows
    .map(
      (income) => {
        const editable = canEditRecordDate(dateOnly(income.fechaHora));
        return `
        <tr>
          <td>${dateOnly(income.fechaHora)}</td>
          <td>${income.facturaID || income.ingresoID}</td>
          <td>${income.clienteNombre || income.deudorNombre || "Sin cliente"}</td>
          <td>${income.metodoPago || income.formaPago || "-"}</td>
          <td class="amount">${money.format(Number(income.montoBruto) || Number(income.montoNeto) || 0)}</td>
          <td>
            <div class="row-actions">
              <button class="secondary-btn compact view-income" data-income-id="${escapeHtml(income.ingresoID)}" type="button">Ver</button>
              ${editable ? `<button class="secondary-btn compact date-income" data-income-id="${escapeHtml(income.ingresoID)}" type="button">Fecha</button>` : ""}
            </div>
          </td>
        </tr>
      `;
      },
    )
    .join("");
}

function pendingTransferRows() {
  const query = byId("pending-transfer-search").value;
  return dbTable("cuentasCobrar")
    .filter((cxc) => Number(cxc.balancePendiente) > 0)
    .filter((cxc) => normalize(`${cxc.tipoCxC} ${cxc.concepto}`).includes("transferencia pendiente"))
    .filter((cxc) => matches(cxc, query, ["cxCID", "facturaID", "deudorNombre", "concepto", "observaciones"]))
    .sort((a, b) => `${dateOnly(b.fechaOrigen) || ""} ${b.cxCID || ""}`.localeCompare(`${dateOnly(a.fechaOrigen) || ""} ${a.cxCID || ""}`));
}

function renderPendingTransfers() {
  const rows = pendingTransferRows();
  const target = byId("pending-transfer-table");
  if (!rows.length) return renderEmpty(target, 7, "No hay transferencias pendientes de confirmar.");
  target.innerHTML = rows
    .map(
      (cxc) => `
        <tr>
          <td>${dateOnly(cxc.fechaOrigen)}</td>
          <td>${cxc.facturaID || cxc.cxCID}</td>
          <td>${cxc.deudorNombre || "Sin cliente"}</td>
          <td class="amount">${money.format(Number(cxc.balancePendiente) || 0)}</td>
          <td>${dateOnly(cxc.fechaVencimiento)}</td>
          <td>${cxc.observaciones || cxc.concepto || "-"}</td>
          <td>
            <button class="secondary-btn compact confirm-transfer" data-cxc-id="${cxc.cxCID}" type="button">Confirmar</button>
            <button class="secondary-btn compact decline-transfer" data-cxc-id="${cxc.cxCID}" type="button">Declinar</button>
          </td>
        </tr>
      `,
    )
    .join("");
}

function handlePendingTransferAction(button, action) {
  const cxc = dbTable("cuentasCobrar").find((item) => item.cxCID === button.dataset.cxcId);
  if (!cxc) return;
  if (action === "confirm") {
    const amount = Number(cxc.balancePendiente) || 0;
    const clientRecord = dbTable("clientes").find((client) => client.clienteID === cxc.deudorID) || findClientByName(cxc.deudorNombre);
    cxc.montoAplicado = (Number(cxc.montoAplicado) || 0) + amount;
    cxc.balancePendiente = 0;
    cxc.estado = "Saldada";
    cxc.observaciones = `${cxc.observaciones || ""} Transferencia confirmada ${new Date().toISOString()}`.trim();
    addConfirmedPayment(cxc.facturaID || "", clientRecord, cxc.deudorNombre || "", amount, "transferencia_confirmada", "Transferencia confirmada desde cuentas por cobrar", "", cxc.cuentaDestino || "");
  }
  if (action === "decline") {
    cxc.tipoCxC = "Crédito cliente";
    cxc.concepto = "Transferencia declinada - cuenta por cobrar vencida";
    cxc.fechaVencimiento = today;
    cxc.estado = "Pendiente";
    cxc.observaciones = `${cxc.observaciones || ""} Transferencia declinada ${new Date().toISOString()}. No completada; deuda vencida inmediata.`.trim();
  }
  state = stateFromDatabase(database);
  saveState();
  renderAll();
}

function renderAppointments(target, rows, emptyMessage) {
  if (!rows.length) {
    target.innerHTML = `<p class="empty">${emptyMessage}</p>`;
    return;
  }
  target.innerHTML = rows
    .map(
      (reservation) => `
        <article class="appointment">
          <time>${reservation.time}</time>
          <div>
            <strong>${reservation.client}</strong>
            <span>${reservation.service} con ${reservation.staff}</span>
            <span>${reservation.phone || ""} ${reservation.provisional ? "· Cliente provisional" : ""} ${reservation.source ? `· ${reservation.source}` : ""} ${reservation.note ? `· ${reservation.note}` : ""}</span>
          </div>
          <div class="row-actions">
            <span>${reservation.invoiceId ? `Factura ${reservation.invoiceId}` : reservation.date}</span>
            ${reservation.invoiceId ? "" : `<button class="secondary-btn compact invoice-reservation" data-reservation-id="${reservation.id}" type="button">Facturar</button>`}
          </div>
        </article>
      `,
    )
    .join("");
}

function renderReservations() {
  const query = byId("reservation-search").value;
  const rows = state.reservations
    .filter((reservation) => matches(reservation, query, ["client", "service", "staff", "time", "date"]))
    .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  renderAppointments(byId("reservation-list"), rows, "No hay citas con ese criterio.");
}

function payrollPeriodRange(period, cut) {
  const [year, monthNumber] = String(period || month).split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  if (cut === "first") return { start: `${period}-01`, end: `${period}-15`, label: "Primera quincena" };
  if (cut === "second") return { start: `${period}-16`, end: `${period}-${String(lastDay).padStart(2, "0")}`, label: "Segunda quincena" };
  return { start: `${period}-01`, end: `${period}-${String(lastDay).padStart(2, "0")}`, label: "Mes completo" };
}

function dateInRange(value, start, end) {
  const current = dateOnly(value);
  return current >= start && current <= end;
}

function payrollPreviewData() {
  const staffName = byId("payroll-staff").value.trim();
  const period = byId("payroll-period").value || month;
  const cut = byId("payroll-cut").value;
  const range = payrollPeriodRange(period, cut);
  const staff = findStaffByName(staffName);
  const monthlySalary = Number(staff?.salarioMensual) || 0;
  const base = cut === "month" ? monthlySalary : monthlySalary / 2;
  const details = dbTable("facturaDetalle").filter((detail) => {
    const invoice = dbTable("facturas").find((row) => row.facturaID === detail.facturaID);
    const sameStaff = staff?.colaboradorID ? detail.colaboradorID === staff.colaboradorID : normalize(detail.colaboradorNombre) === normalize(staffName);
    return sameStaff && invoice && dateInRange(invoice.fechaHora, range.start, range.end);
  });
  const sales = details.reduce((sum, detail) => sum + (Number(detail.subtotal) || 0), 0);
  const assignedThresholdIds = Array.isArray(staff?.umbralesComisionActivos)
    ? staff.umbralesComisionActivos
    : staff?.umbralComisionActivo
      ? [staff.umbralComisionActivo]
      : [];
  const thresholds = dbTable("umbralesComision")
    .filter((row) => normalize(row.estado || "Activo") === "activo")
    .filter((row) => assignedThresholdIds.includes(row.escalaID))
    .sort((a, b) => (Number(b.desde) || 0) - (Number(a.desde) || 0));
  const threshold = thresholds.find((row) => sales >= (Number(row.desde) || 0) && ((Number(row.hasta) || 0) <= 0 || sales <= Number(row.hasta))) || null;
  const rate = Number(threshold?.porcentajeComision) || 0;
  const commission = sales * rate;
  const tips = dbTable("propinas")
    .filter((tip) => {
      const sameStaff = staff?.colaboradorID ? tip.colaboradorID === staff.colaboradorID : normalize(tip.colaboradorNombre) === normalize(staffName);
      return sameStaff && normalize(tip.estadoPagoNomina || "Pendiente") !== "pagada" && dateInRange(tip.fechaHora, range.start, range.end);
    })
    .reduce((sum, tip) => sum + (Number(tip.montoNetoPagar) || 0), 0);
  const staffReceivables = dbTable("cuentasCobrar").filter((cxc) => {
    const sameStaff = cxc.deudorTipo === "Colaborador" && (cxc.deudorID === staff?.colaboradorID || normalize(cxc.deudorNombre) === normalize(staffName));
    return sameStaff && Number(cxc.balancePendiente) > 0;
  });
  const cxcDiscounts = [...document.querySelectorAll(".payroll-cxc-discount")].reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  const afp = Number(byId("payroll-afp").value) || 0;
  const insurance = Number(byId("payroll-insurance").value) || 0;
  const other = Number(byId("payroll-other-deductions").value) || 0;
  const deductions = afp + insurance + other + cxcDiscounts;
  const net = Math.max(0, base + commission + tips - deductions);
  return { staff, staffName, period, cut, range, base, sales, threshold, rate, commission, tips, staffReceivables, afp, insurance, other, cxcDiscounts, deductions, net };
}

function renderPayrollCxCList(rows) {
  const target = byId("payroll-cxc-list");
  if (!rows.length) {
    target.innerHTML = '<p class="empty">Este colaborador no tiene CxC pendiente.</p>';
    return;
  }
  target.innerHTML = rows
    .map(
      (cxc) => `
        <article class="list-item payroll-cxc-row">
          <div>
            <strong>${cxc.cxCID} · ${cxc.concepto || cxc.tipoCxC}</strong>
            <span>Pendiente ${money.format(Number(cxc.balancePendiente) || 0)}</span>
          </div>
          <input class="payroll-cxc-discount" data-cxc-id="${cxc.cxCID}" type="number" min="0" max="${Number(cxc.balancePendiente) || 0}" step="0.01" value="0" />
        </article>
      `,
    )
    .join("");
}

function updatePayrollPreview(renderCxC = false) {
  const data = payrollPreviewData();
  if (renderCxC) renderPayrollCxCList(data.staffReceivables);
  byId("payroll-base").value = data.base.toFixed(2);
  byId("payroll-commission").value = data.commission.toFixed(2);
  byId("payroll-tips").value = data.tips.toFixed(2);
  byId("payroll-sales-preview").textContent = money.format(data.sales);
  byId("payroll-rate-preview").textContent = `${(data.rate * 100).toFixed(2)}%`;
  byId("payroll-deductions-preview").textContent = money.format(data.deductions);
  byId("payroll-net-preview").textContent = money.format(data.net);
  return data;
}

function renderPayroll() {
  const target = byId("payroll-table");
  const query = byId("payroll-search").value;
  const rows = state.payroll
    .filter((row) => matches(row, query, ["period", "staff", "cut"]))
    .sort((a, b) => `${b.period || ""} ${b.id || ""}`.localeCompare(`${a.period || ""} ${a.id || ""}`));
  if (!rows.length) return renderEmpty(target, 8, "No hay nóminas registradas.");
  target.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${row.period}</td>
          <td>${row.cut || "Mes completo"}</td>
          <td>${row.staff}</td>
          <td>${money.format(row.base)}</td>
          <td>${money.format(row.commission)}</td>
          <td>${money.format(row.tips || 0)}</td>
          <td>${money.format(row.deductions)}</td>
          <td class="amount">${money.format(row.net)}</td>
        </tr>
      `,
    )
    .join("");
}

function renderCash() {
  const target = byId("cash-table");
  if (!state.cashClosings.length) return renderEmpty(target, 10, "No hay cierres registrados.");
  target.innerHTML = state.cashClosings
    .slice()
    .sort((a, b) => `${b.date || ""} ${b.id || ""}`.localeCompare(`${a.date || ""} ${a.id || ""}`))
    .map((row) => {
      const closing = dbTable("cierres").find((item) => item.cierreID === row.id || dateOnly(item.fechaHoraCierre) === row.date);
      const status = closing?.estado || "Cerrado";
      const isOpen = isClosingOpenForEdits(closing);
      const canManage = canManageInvoices();
      const canConfirm = canConfirmClosings();
      const pendingConfirmation = isClosingPendingConfirmation(closing);
      return `
        <tr>
          <td>${row.date}</td>
          <td>${money.format(row.expected)}</td>
          <td>${money.format(row.counted)}</td>
          <td>${money.format(row.cardCounted || 0)}</td>
          <td>${money.format(row.expenses)}</td>
          <td class="amount danger">${money.format(row.shortage || 0)}</td>
          <td class="amount gold">${money.format(row.surplus || 0)}</td>
          <td class="amount ${row.difference < 0 ? "danger" : "gold"}">${money.format(row.difference)}</td>
          <td>${escapeHtml(status)}</td>
          <td>
            <div class="row-actions">
              <button class="secondary-btn compact view-closing" data-closing-id="${escapeHtml(closing?.cierreID || "")}" type="button">Ver</button>
              ${canConfirm && pendingConfirmation ? `<button class="secondary-btn compact edit-closing" data-closing-id="${escapeHtml(closing?.cierreID || "")}" type="button">Editar</button>` : ""}
              ${canManage && !isOpen ? `<button class="secondary-btn compact open-closing" data-closing-id="${escapeHtml(closing?.cierreID || "")}" type="button">Abrir</button>` : ""}
              ${canConfirm && pendingConfirmation ? `<button class="secondary-btn compact confirm-closing" data-closing-id="${escapeHtml(closing?.cierreID || "")}" type="button">Confirmar</button>` : ""}
              ${canManage && !pendingConfirmation ? `<button class="secondary-btn compact void-closing" data-closing-id="${escapeHtml(closing?.cierreID || "")}" type="button">Quitar cierre</button>` : ""}
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function openClosingForEdit(closingId) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede abrir cierres.");
    return;
  }
  const closing = dbTable("cierres").find((row) => row.cierreID === closingId);
  if (!closing) return;
  if (!confirm(`Abrir el cierre de ${dateOnly(closing.fechaHoraCierre)} permitirá editar facturas de ese día. ¿Continuar?`)) return;
  closing.estado = "Abierto para edición";
  closing.requiereConfirmacion = true;
  closing.abiertoPor = currentUserEmail();
  closing.fechaApertura = new Date().toISOString();
  stampRecord(closing, "updated");
  state = stateFromDatabase(database);
  saveState();
  renderAll();
}

function confirmClosing(closingId) {
  if (!canConfirmClosings()) {
    alert("Solo operadores autorizados, administración o propietario pueden confirmar cierres.");
    return;
  }
  const closing = dbTable("cierres").find((row) => row.cierreID === closingId);
  if (!closing) return;
  if (!isClosingPendingConfirmation(closing)) {
    alert("Este cierre ya está confirmado.");
    return;
  }
  if (!confirm(`Confirmar el cierre de ${dateOnly(closing.fechaHoraCierre)} bloqueará la edición de facturas de ese día. ¿Continuar?`)) return;
  closing.estado = "Cerrado";
  closing.requiereConfirmacion = false;
  closing.confirmadoPor = currentUserEmail();
  closing.fechaConfirmacion = new Date().toISOString();
  stampRecord(closing, "updated");
  state = stateFromDatabase(database);
  saveState();
  renderAll();
}

function startClosingConfirmation(closingId) {
  if (!canConfirmClosings()) {
    alert("Solo operadores autorizados, administración o propietario pueden confirmar cierres.");
    return;
  }
  const closing = dbTable("cierres").find((row) => row.cierreID === closingId);
  if (!closing) return;
  if (!isClosingPendingConfirmation(closing)) {
    alert("Este cierre ya está confirmado.");
    return;
  }
  const date = dateOnly(closing.fechaHoraCierre);
  const summary = dailyIncomeSummary(date);
  const expenses = dbTable("egresos")
    .filter((expense) => dateOnly(expense.fechaHora) === date)
    .reduce((sum, expense) => sum + (Number(expense.monto) || 0), 0);
  byId("cash-form").classList.remove("hidden");
  byId("cash-edit-id").value = closing.cierreID;
  byId("cash-confirm-after-save").value = "true";
  byId("cash-submit").textContent = "Confirmar y cerrar";
  byId("cash-date").value = date;
  byId("cash-counted").value = Number(closing.conteoInicial) || Number(closing.balanceContado) || summary.cash + expenses;
  byId("cash-expenses").value = Number(closing.egresos) || expenses;
  byId("cash-card-counted").value = Number(closing.tarjetaContada) || summary.card;
  byId("cash-card-processor").value = closing.procesadorTarjeta || "";
  byId("cash-card-batch").value = closing.loteTarjeta || "";
  byId("cash-transfer-counted").value = Number(closing.transferenciaContada) || summary.transfer;
  byId("cash-note").value = closing.observaciones || "";
  byId("cash-shortage-note").value = closing.motivoFaltante || "";
  byId("cash-rectified-counted").value = Number(closing.balanceContadoRectificado) || "";
  resetCashBalancePreview();
  byId("cash-counted").focus();
  byId("cash-form").scrollIntoView({ block: "start", behavior: "smooth" });
}

function voidClosing(closingId) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede anular cierres.");
    return;
  }
  const closing = dbTable("cierres").find((row) => row.cierreID === closingId);
  if (!closing) return;
  if (!confirm(`Quitar el cierre de ${dateOnly(closing.fechaHoraCierre)} lo dejará pendiente de confirmación y permitirá corregir transacciones del día. ¿Continuar?`)) return;
  closing.estado = "Pendiente de confirmacion";
  closing.requiereConfirmacion = true;
  closing.anuladoPor = currentUserEmail();
  closing.fechaAnulacion = new Date().toISOString();
  closing.observaciones = `${closing.observaciones || ""} Cierre quitado para correcciones por ${currentUserEmail()}.`.trim();
  stampRecord(closing, "updated");
  state = stateFromDatabase(database);
  saveState();
  renderAll();
}

function confirmPreviousPendingClosings() {
  if (!canConfirmClosings()) {
    alert("Solo operadores autorizados, administración o propietario pueden crear cierres pendientes.");
    return;
  }
  const created = ensureProvisionalClosings();
  state = stateFromDatabase(database);
  saveState();
  renderAll();
  alert(created ? `Se crearon ${created} cierre(s) pendiente(s) para días con registros.` : "Todos los días con registros ya tienen cierre creado.");
}

function showNewCashClosing() {
  const currentClosing = closingForDate(today);
  if (currentClosing && !isClosingPendingConfirmation(currentClosing)) {
    alert("El cierre de hoy ya está confirmado. Administración debe quitar el cierre antes de editarlo.");
    return;
  }
  if (currentClosing && isClosingPendingConfirmation(currentClosing)) {
    startClosingEdit(currentClosing.cierreID);
    return;
  }
  byId("cash-form").classList.remove("hidden");
  byId("cash-form").reset();
  byId("cash-edit-id").value = "";
  byId("cash-confirm-after-save").value = "";
  byId("cash-submit").textContent = "Guardar cierre";
  byId("cash-date").value = today;
  byId("cash-expenses").value = 0;
  byId("cash-card-counted").value = 0;
  byId("cash-transfer-counted").value = 0;
  resetCashBalancePreview();
  byId("cash-counted").focus();
}

function hideCashClosingForm() {
  byId("cash-form").classList.add("hidden");
  byId("cash-form").reset();
  byId("cash-edit-id").value = "";
  byId("cash-confirm-after-save").value = "";
  byId("cash-submit").textContent = "Guardar cierre";
  byId("cash-date").value = today;
  resetCashBalancePreview();
}

function startClosingEdit(closingId) {
  if (!canConfirmClosings()) {
    alert("Solo usuarios autorizados pueden editar cierres pendientes.");
    return;
  }
  const closing = dbTable("cierres").find((row) => row.cierreID === closingId);
  if (!closing) return;
  if (!isClosingPendingConfirmation(closing)) {
    alert("Este cierre está confirmado. Administración debe quitar el cierre antes de editarlo.");
    return;
  }
  byId("cash-form").classList.remove("hidden");
  byId("cash-edit-id").value = closing.cierreID;
  byId("cash-confirm-after-save").value = "";
  byId("cash-submit").textContent = "Actualizar cierre";
  byId("cash-date").value = dateOnly(closing.fechaHoraCierre);
  byId("cash-counted").value = Number(closing.conteoInicial) || Number(closing.balanceContado) || 0;
  byId("cash-expenses").value = Number(closing.egresos) || 0;
  byId("cash-card-counted").value = Number(closing.tarjetaContada) || 0;
  byId("cash-card-processor").value = closing.procesadorTarjeta || "";
  byId("cash-card-batch").value = closing.loteTarjeta || "";
  byId("cash-transfer-counted").value = Number(closing.transferenciaContada) || 0;
  byId("cash-note").value = closing.observaciones || "";
  byId("cash-shortage-note").value = closing.motivoFaltante || "";
  byId("cash-rectified-counted").value = Number(closing.balanceContadoRectificado) || "";
  updateCashBalancePreview();
}

function cardReconciliationRows() {
  const query = normalize(byId("card-reconciliation-search").value);
  return dbTable("cierres")
    .filter((row) => Number(row.tarjetaContada) > 0)
    .filter((row) => normalize(row.estadoConciliacionTarjeta || "").indexOf("conciliada") === -1)
    .filter((row) => {
      if (!query) return true;
      return [row.fechaHoraCierre, row.procesadorTarjeta, row.loteTarjeta, row.cierreID].some((field) => normalize(field).includes(query));
    })
    .sort((a, b) => `${dateOnly(b.fechaHoraCierre) || ""} ${b.cierreID || ""}`.localeCompare(`${dateOnly(a.fechaHoraCierre) || ""} ${a.cierreID || ""}`));
}

function renderCardReconciliation() {
  const target = byId("card-reconciliation-table");
  const rows = cardReconciliationRows();
  if (!rows.length) return renderEmpty(target, 7, "No hay lotes de tarjeta pendientes.");
  target.innerHTML = rows
    .map((row) => {
      const amount = Number(row.tarjetaContada) || 0;
      const processor = findProcessorByName(row.procesadorTarjeta);
      const fee = amount * processorFeeRate(processor);
      return `
        <tr>
          <td>${dateOnly(row.fechaHoraCierre)}</td>
          <td>${row.procesadorTarjeta || "Procesador tarjeta"}</td>
          <td>${row.loteTarjeta || "Sin lote"}</td>
          <td class="amount">${money.format(amount)}</td>
          <td class="amount danger">${money.format(fee)}</td>
          <td class="amount">${money.format(amount - fee)}</td>
          <td><button class="secondary-btn compact select-card-closing" data-closing-id="${row.cierreID}" type="button">Seleccionar</button></td>
        </tr>
      `;
    })
    .join("");
}

function selectCardClosing(closingId) {
  const closing = dbTable("cierres").find((row) => row.cierreID === closingId);
  if (!closing) return;
  const amount = Number(closing.tarjetaContada) || 0;
  const processor = findProcessorByName(closing.procesadorTarjeta);
  const fee = amount * processorFeeRate(processor);
  byId("card-reconciliation-closing-id").value = closing.cierreID;
  byId("card-reconciliation-label").value = `${dateOnly(closing.fechaHoraCierre)} · ${closing.procesadorTarjeta || "Procesador"} · lote ${closing.loteTarjeta || "sin lote"}`;
  byId("card-reconciliation-fee").value = fee.toFixed(2);
  byId("card-reconciliation-net").value = Math.max(0, amount - fee).toFixed(2);
}

function renderExpenses() {
  const target = byId("expense-table");
  const query = byId("expense-search").value;
  const rows = state.expenses
    .filter((row) => matches(row, query, ["type", "source", "destination", "concept", "note"]))
    .sort((a, b) => `${b.date || ""} ${b.id || ""}`.localeCompare(`${a.date || ""} ${a.id || ""}`));
  if (!rows.length) return renderEmpty(target, 7, "No hay egresos registrados.");
  target.innerHTML = rows
    .map(
      (row) => {
        const editable = canEditRecordDate(row.date);
        return `
        <tr data-expense-id="${escapeHtml(row.id)}">
          <td>${row.date}</td>
          <td>${row.type}</td>
          <td>${row.source || "Sin origen"}</td>
          <td>${row.destination || "-"}</td>
          <td>${row.concept}</td>
          <td class="amount danger">${money.format(row.amount)}</td>
          <td>
            <div class="row-actions">
              <button class="secondary-btn compact view-expense" type="button">Ver</button>
              ${editable ? '<button class="secondary-btn compact edit-expense" type="button">Editar</button><button class="secondary-btn compact date-expense" type="button">Fecha</button>' : ""}
            </div>
          </td>
        </tr>
      `;
      },
    )
    .join("");
}

function changeIncomeDate(incomeId) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede cambiar fechas de ingresos.");
    return;
  }
  const income = dbTable("ingresos").find((row) => row.ingresoID === incomeId);
  if (!income) return;
  const sourceDate = dateOnly(income.fechaHora);
  const targetDate = prompt(`Nueva fecha operativa para el ingreso ${incomeId}`, sourceDate);
  if (!targetDate || targetDate === sourceDate) return;
  if (!closingAllowsDateChange(sourceDate, targetDate)) return;
  income.fechaHora = withDateOnly(income.fechaHora, targetDate);
  if (dateOnly(income.fechaEntradaCaja) === sourceDate) income.fechaEntradaCaja = targetDate;
  stampRecord(income, "updated");
  const payment = dbTable("pagosFactura").find((row) => row.facturaID === income.facturaID && dateOnly(row.fechaHora) === sourceDate);
  if (payment) {
    payment.fechaHora = withDateOnly(payment.fechaHora, targetDate);
    stampRecord(payment, "updated");
  }
  state = stateFromDatabase(database);
  saveState();
  renderAll();
}

function changeExpenseDate(expenseId) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede cambiar fechas de egresos.");
    return;
  }
  const expense = dbTable("egresos").find((row) => row.egresoID === expenseId);
  if (!expense) return;
  const sourceDate = dateOnly(expense.fechaHora);
  const targetDate = prompt(`Nueva fecha operativa para el egreso ${expenseId}`, sourceDate);
  if (!targetDate || targetDate === sourceDate) return;
  if (!closingAllowsDateChange(sourceDate, targetDate)) return;
  expense.fechaHora = withDateOnly(expense.fechaHora, targetDate);
  stampRecord(expense, "updated");
  dbTable("transferencias")
    .filter((transfer) => dateOnly(transfer.fechaHora) === sourceDate && normalize(transfer.cuentaOrigen) === normalize(expense.cuentaOrigen) && normalize(transfer.cuentaDestino) === normalize(expense.cuentaDestino) && Number(transfer.monto) === Number(expense.monto))
    .forEach((transfer) => {
      transfer.fechaHora = withDateOnly(transfer.fechaHora, targetDate);
      stampRecord(transfer, "updated");
    });
  state = stateFromDatabase(database);
  saveState();
  renderAll();
}

function startExpenseEdit(expenseId) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede editar egresos.");
    return;
  }
  const expense = dbTable("egresos").find((row) => row.egresoID === expenseId);
  if (!expense) return;
  byId("expense-edit-id").value = expense.egresoID;
  byId("expense-date").value = dateOnly(expense.fechaHora);
  byId("expense-type").value = expense.tipoEgreso || "gasto";
  byId("expense-source").value = expense.cuentaOrigen || "";
  byId("expense-destination").value = expense.cuentaDestino || "";
  byId("expense-amount").value = Number(expense.monto) || 0;
  byId("expense-concept").value = expense.concepto || "";
  byId("expense-note").value = expense.observaciones || "";
  byId("expense-submit").textContent = "Actualizar egreso";
  updateExpenseOptionalFields();
  updateExpenseBalancePreview();
}

function renderInventory() {
  const query = byId("inventory-search").value;
  const rows = dbTable("inventario").filter((item) => matches(item, query, ["sku", "nombre", "categoria", "tipo", "proveedor", "estado"]));
  const target = byId("inventory-table");
  if (!rows.length) return renderEmpty(target, 7, "No hay inventario registrado.");
  target.innerHTML = rows
    .map((item) => {
      const stock = Number(item.existencia) || 0;
      const min = Number(item.existenciaMinima) || 0;
      const low = min > 0 && stock <= min;
      return `
        <tr>
          <td>${item.sku || item.itemID}</td>
          <td>${item.nombre}</td>
          <td>${item.tipo || "-"}</td>
          <td class="amount ${low ? "danger" : ""}">${stock} ${item.unidad || ""}</td>
          <td>${min}</td>
          <td class="amount">${money.format(Number(item.costo) || 0)}</td>
          <td>${low ? "Bajo mínimo" : item.estado || "Activo"}</td>
        </tr>
      `;
    })
    .join("");
}

function monthsBetween(startDate, endDate) {
  if (!startDate) return 0;
  const start = new Date(`${dateOnly(startDate)}T12:00:00`);
  const end = new Date(`${dateOnly(endDate)}T12:00:00`);
  return Math.max(0, (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth());
}

function assetDepreciation(asset) {
  const value = Number(asset.valorAdquisicion) || 0;
  const life = Math.max(1, Number(asset.vidaUtilMeses) || 60);
  const elapsed = Math.min(life, monthsBetween(asset.fechaAdquisicion, today));
  const accumulated = asset.metodoDepreciacion === "Manual" ? Number(asset.depreciacionAcumulada) || 0 : (value / life) * elapsed;
  return { accumulated, book: Math.max(0, value - accumulated) };
}

function renderFixedAssets() {
  const query = byId("asset-search").value;
  const rows = dbTable("activosFijos").filter((asset) => matches(asset, query, ["nombre", "categoria", "estado", "ubicacion", "responsable"]));
  const target = byId("asset-table");
  if (!rows.length) return renderEmpty(target, 7, "No hay activos fijos registrados.");
  target.innerHTML = rows
    .map((asset) => {
      const depreciation = assetDepreciation(asset);
      return `
        <tr>
          <td>${asset.nombre}</td>
          <td>${asset.categoria || "-"}</td>
          <td class="amount">${money.format(Number(asset.valorAdquisicion) || 0)}</td>
          <td class="amount danger">${money.format(depreciation.accumulated)}</td>
          <td class="amount">${money.format(depreciation.book)}</td>
          <td>${asset.ubicacion || "-"}</td>
          <td>${asset.estado || "Activo"}</td>
        </tr>
      `;
    })
    .join("");
}

function reportRange() {
  return {
    start: byId("report-start").value || `${month}-01`,
    end: byId("report-end").value || today,
  };
}

function inRangeDate(value, start, end) {
  const current = dateOnly(value);
  return current >= start && current <= end;
}

function reportCards(items) {
  byId("report-summary").innerHTML = items
    .map(
      (item) => `
        <article class="report-card">
          <span>${item.label}</span>
          <strong>${item.value}</strong>
        </article>
      `,
    )
    .join("");
}

function renderReportTable(headers, rows, emptyMessage = "No hay datos para este período.") {
  byId("report-head").innerHTML = `<tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr>`;
  byId("report-body").innerHTML = rows.length ? rows.join("") : `<tr><td class="empty" colspan="${headers.length}">${emptyMessage}</td></tr>`;
}

function accountMatches(account, accountName) {
  if (!accountName) return true;
  return normalize(account?.nombreCuenta) === normalize(accountName);
}

function accountTransactions(account, start, end, includeBeforeStart = false) {
  const accountId = account.cuentaID || "";
  const name = account.nombreCuenta || "";
  const matchesAccount = (id, accountName) => (accountId && id === accountId) || normalize(accountName) === normalize(name);
  const rows = [];

  dbTable("ingresos").forEach((row) => {
    if (!matchesAccount(row.cuentaDestinoID, row.cuentaDestino)) return;
    const date = dateOnly(row.fechaHora);
    if (includeBeforeStart ? date >= start : !inRangeDate(row.fechaHora, start, end)) return;
    rows.push({
      date,
      type: "Ingreso",
      description: row.tipoIngreso || row.metodoPago || "Ingreso",
      reference: row.facturaID || row.ingresoID || "",
      debit: 0,
      credit: Number(row.montoNeto) || Number(row.montoBruto) || 0,
    });
  });

  dbTable("egresos").forEach((row) => {
    if (!matchesAccount(row.cuentaOrigenID, row.cuentaOrigen)) return;
    const date = dateOnly(row.fechaHora);
    if (includeBeforeStart ? date >= start : !inRangeDate(row.fechaHora, start, end)) return;
    rows.push({
      date,
      type: "Egreso",
      description: row.concepto || row.tipo || "Egreso",
      reference: row.egresoID || "",
      debit: Number(row.monto) || 0,
      credit: 0,
    });
  });

  dbTable("transferencias").forEach((row) => {
    const date = dateOnly(row.fechaHora);
    if (includeBeforeStart ? date >= start : !inRangeDate(row.fechaHora, start, end)) return;
    if (matchesAccount(row.cuentaOrigenID, row.cuentaOrigen)) {
      rows.push({
        date,
        type: "Transferencia salida",
        description: `A ${row.cuentaDestino || "destino"}`,
        reference: row.transferenciaID || "",
        debit: Number(row.monto) || 0,
        credit: 0,
      });
    }
    if (matchesAccount(row.cuentaDestinoID, row.cuentaDestino)) {
      rows.push({
        date,
        type: "Transferencia entrada",
        description: `Desde ${row.cuentaOrigen || "origen"}`,
        reference: row.transferenciaID || "",
        debit: 0,
        credit: Number(row.monto) || 0,
      });
    }
  });

  return rows.sort((a, b) => `${a.date}-${a.reference}`.localeCompare(`${b.date}-${b.reference}`));
}

function accountOpeningBalance(account, start) {
  const previousEnd = "9999-12-31";
  const transactions = accountTransactions(account, start, previousEnd, true).filter((row) => row.date < start);
  return transactions.reduce((balance, row) => balance + row.credit - row.debit, Number(account.balanceInicial) || 0);
}

function accountPeriodSummary(account, start, end) {
  const opening = accountOpeningBalance(account, start);
  const transactions = accountTransactions(account, start, end);
  const income = transactions.filter((row) => row.type === "Ingreso").reduce((sum, row) => sum + row.credit, 0);
  const expense = transactions.filter((row) => row.type === "Egreso").reduce((sum, row) => sum + row.debit, 0);
  const transferIn = transactions.filter((row) => row.type === "Transferencia entrada").reduce((sum, row) => sum + row.credit, 0);
  const transferOut = transactions.filter((row) => row.type === "Transferencia salida").reduce((sum, row) => sum + row.debit, 0);
  const closing = opening + income + transferIn - expense - transferOut;
  return { opening, income, expense, transferIn, transferOut, closing, transactions };
}

function renderExecutiveReport(start, end) {
  const invoices = dbTable("facturas").filter((row) => inRangeDate(row.fechaHora, start, end));
  const income = dbTable("ingresos").filter((row) => inRangeDate(row.fechaHora, start, end) && normalize(row.estado || "Confirmado") === "confirmado");
  const cxc = dbTable("cuentasCobrar").filter((row) => inRangeDate(row.fechaOrigen, start, end));
  const expenses = dbTable("egresos").filter((row) => inRangeDate(row.fechaHora, start, end));
  const payroll = dbTable("nomina").filter((row) => inRangeDate(row.periodoFin || row.periodoInicio, start, end));
  const closingBalance = dbTable("cuentas").reduce((sum, account) => sum + accountPeriodSummary(account, start, end).closing, 0);
  const totalBilled = invoices.reduce((sum, row) => sum + (Number(row.totalFacturado) || 0), 0);
  const totalIncome = income.reduce((sum, row) => sum + (Number(row.montoNeto) || Number(row.montoBruto) || 0), 0);
  const totalCxc = cxc.reduce((sum, row) => sum + (Number(row.balancePendiente) || 0), 0);
  const totalExpenses = expenses.reduce((sum, row) => sum + (Number(row.monto) || 0), 0);
  const totalPayroll = payroll.reduce((sum, row) => sum + (Number(row.totalAPagar) || 0), 0);

  reportCards([
    { label: "Facturado", value: money.format(totalBilled) },
    { label: "Ingresos netos", value: money.format(totalIncome) },
    { label: "CxC pendiente", value: money.format(totalCxc) },
    { label: "Balance cuentas", value: money.format(closingBalance) },
  ]);
  renderReportTable(
    ["Indicador", "Valor"],
    [
      `<tr><td>Facturas emitidas</td><td>${invoices.length}</td></tr>`,
      `<tr><td>Total egresos</td><td class="amount danger">${money.format(totalExpenses)}</td></tr>`,
      `<tr><td>Nómina generada</td><td class="amount">${money.format(totalPayroll)}</td></tr>`,
      `<tr><td>Cuentas por cobrar creadas</td><td>${cxc.length}</td></tr>`,
    ],
  );
}

function renderAccountBalancesReport(start, end) {
  const accountName = byId("report-account").value.trim();
  const rows = dbTable("cuentas").filter((account) => accountMatches(account, accountName)).map((account) => {
    const summary = accountPeriodSummary(account, start, end);
    return `
      <tr>
        <td>${account.nombreCuenta}</td>
        <td>${account.tipoCuenta || "-"}</td>
        <td class="amount">${money.format(summary.opening)}</td>
        <td class="amount">${money.format(summary.income + summary.transferIn)}</td>
        <td class="amount danger">${money.format(summary.expense + summary.transferOut)}</td>
        <td class="amount">${money.format(summary.closing)}</td>
      </tr>
    `;
  });
  const total = dbTable("cuentas").filter((account) => accountMatches(account, accountName)).reduce((sum, account) => sum + accountPeriodSummary(account, start, end).closing, 0);
  reportCards([{ label: "Balance cierre reporte", value: money.format(total) }]);
  renderReportTable(["Cuenta", "Tipo", "Balance inicial", "Entradas", "Salidas", "Balance final"], rows);
}

function renderAccountMovementsReport(start, end) {
  const accountName = byId("report-account").value.trim();
  const accounts = dbTable("cuentas").filter((account) => accountMatches(account, accountName));
  const rows = [];
  let finalBalance = 0;
  accounts.forEach((account) => {
    let balance = accountOpeningBalance(account, start);
    accountTransactions(account, start, end).forEach((row) => {
      balance += row.credit - row.debit;
      rows.push(`
        <tr>
          <td>${row.date}</td>
          <td>${account.nombreCuenta}</td>
          <td>${row.type}</td>
          <td>${row.description}</td>
          <td>${row.reference}</td>
          <td class="amount">${row.credit ? money.format(row.credit) : "-"}</td>
          <td class="amount danger">${row.debit ? money.format(row.debit) : "-"}</td>
          <td class="amount">${money.format(balance)}</td>
        </tr>
      `);
    });
    finalBalance += balance;
  });
  reportCards([{ label: "Balance al cierre del reporte", value: money.format(finalBalance) }, { label: "Transacciones", value: String(rows.length) }]);
  renderReportTable(["Fecha", "Cuenta", "Tipo", "Detalle", "Referencia", "Entrada", "Salida", "Balance"], rows);
}

function renderBillingReport(start, end) {
  const client = normalize(byId("report-client").value.trim());
  const invoices = dbTable("facturas").filter((row) => inRangeDate(row.fechaHora, start, end)).filter((row) => !client || normalize(row.clienteNombre).includes(client));
  const total = invoices.reduce((sum, row) => sum + (Number(row.totalFacturado) || 0), 0);
  const paid = invoices.reduce((sum, row) => sum + (Number(row.totalPagadoConfirmado) || 0), 0);
  const cxc = invoices.reduce((sum, row) => sum + (Number(row.totalCxC) || 0), 0);
  reportCards([
    { label: "Facturado", value: money.format(total) },
    { label: "Pagado confirmado", value: money.format(paid) },
    { label: "CxC generado", value: money.format(cxc) },
    { label: "Facturas", value: String(invoices.length) },
  ]);
  renderReportTable(
    ["Fecha", "Factura", "Cliente", "Estado", "Total", "Pagado", "CxC"],
    invoices.map(
      (row) => `
        <tr>
          <td>${dateOnly(row.fechaHora)}</td>
          <td>${row.facturaID}</td>
          <td>${row.clienteNombre}</td>
          <td>${row.estadoFactura}</td>
          <td class="amount">${money.format(Number(row.totalFacturado) || 0)}</td>
          <td class="amount">${money.format(Number(row.totalPagadoConfirmado) || 0)}</td>
          <td class="amount danger">${money.format(Number(row.totalCxC) || 0)}</td>
        </tr>
      `,
    ),
  );
}

function cxcLastPaymentDate(cxc) {
  const apps = dbTable("ingresoAplicaciones").filter((app) => app.cxCID === cxc.cxCID || (cxc.facturaID && app.facturaID === cxc.facturaID));
  const dates = apps
    .map((app) => dbTable("ingresos").find((income) => income.ingresoID === app.ingresoID))
    .filter(Boolean)
    .map((income) => dateOnly(income.fechaHora));
  return dates.sort().at(-1) || "";
}

function renderReceivablesReport(start, end) {
  const client = normalize(byId("report-client").value.trim());
  const rowsData = dbTable("cuentasCobrar").filter((row) => inRangeDate(row.fechaOrigen, start, end)).filter((row) => !client || normalize(row.deudorNombre).includes(client));
  const original = rowsData.reduce((sum, row) => sum + (Number(row.montoOriginal) || 0), 0);
  const paid = rowsData.reduce((sum, row) => sum + (Number(row.montoAplicado) || 0), 0);
  const pending = rowsData.reduce((sum, row) => sum + (Number(row.balancePendiente) || 0), 0);
  const overdue = rowsData.filter((row) => dateOnly(row.fechaVencimiento) < today && Number(row.balancePendiente) > 0).length;
  reportCards([
    { label: "Crédito generado", value: money.format(original) },
    { label: "Cobrado", value: money.format(paid) },
    { label: "Pendiente", value: money.format(pending) },
    { label: "Vencidas pendientes", value: String(overdue) },
  ]);
  renderReportTable(
    ["Origen", "Factura", "Cliente/deudor", "Tipo", "Vence", "Estado vencimiento", "Original", "Cobrado", "Pendiente"],
    rowsData.map((row) => {
      const due = dateOnly(row.fechaVencimiento);
      const lastPaid = cxcLastPaymentDate(row);
      const isPendingOverdue = due < today && Number(row.balancePendiente) > 0;
      const wasCollectedOverdue = lastPaid && due < lastPaid && Number(row.balancePendiente) <= 0;
      const dueStatus = isPendingOverdue ? "Vencida" : wasCollectedOverdue ? `Cobrada vencida ${lastPaid}` : "Al día";
      return `
        <tr>
          <td>${dateOnly(row.fechaOrigen)}</td>
          <td>${row.facturaID || "-"}</td>
          <td>${row.deudorNombre}</td>
          <td>${row.tipoCxC || row.concepto}</td>
          <td>${due}</td>
          <td>${dueStatus}</td>
          <td class="amount">${money.format(Number(row.montoOriginal) || 0)}</td>
          <td class="amount">${money.format(Number(row.montoAplicado) || 0)}</td>
          <td class="amount danger">${money.format(Number(row.balancePendiente) || 0)}</td>
        </tr>
      `;
    }),
  );
}

function renderPayrollReport(start, end) {
  const staff = normalize(byId("report-staff").value.trim());
  const rowsData = dbTable("nomina").filter((row) => inRangeDate(row.periodoFin || row.periodoInicio, start, end)).filter((row) => !staff || normalize(row.colaboradorNombre).includes(staff));
  const total = rowsData.reduce((sum, row) => sum + (Number(row.totalAPagar) || 0), 0);
  reportCards([{ label: "Total nómina", value: money.format(total) }, { label: "Registros", value: String(rowsData.length) }]);
  renderReportTable(
    ["Periodo", "Colaborador", "Salario", "Comisión", "Propinas", "Descuentos", "Total pagar", "Estado"],
    rowsData.map(
      (row) => `
        <tr>
          <td>${dateOnly(row.periodoInicio)} a ${dateOnly(row.periodoFin)}</td>
          <td>${row.colaboradorNombre}</td>
          <td class="amount">${money.format(Number(row.salarioQuincenal) || Number(row.salarioBaseMensual) || 0)}</td>
          <td class="amount">${money.format(Number(row.comisionGenerada) || 0)}</td>
          <td class="amount">${money.format(Number(row.propinaNetaMes) || 0)}</td>
          <td class="amount danger">${money.format((Number(row.descuentoAFP) || 0) + (Number(row.descuentoSeguro) || 0) + (Number(row.descuentoOtros) || 0) + (Number(row.descuentoCxC) || 0))}</td>
          <td class="amount">${money.format(Number(row.totalAPagar) || 0)}</td>
          <td>${row.estado || "Pendiente"}</td>
        </tr>
      `,
    ),
  );
}

function renderStaffBillingReport(start, end) {
  const staffFilter = normalize(byId("report-staff").value.trim());
  const includeTips = byId("report-include-tips").checked;
  const includeCommission = byId("report-include-commission").checked;
  const includeDeductions = byId("report-include-deductions").checked;
  const grouped = new Map();
  dbTable("facturaDetalle").forEach((detail) => {
    const invoice = dbTable("facturas").find((row) => row.facturaID === detail.facturaID);
    if (!invoice || !inRangeDate(invoice.fechaHora, start, end)) return;
    if (staffFilter && !normalize(detail.colaboradorNombre).includes(staffFilter)) return;
    const key = detail.colaboradorID || detail.colaboradorNombre;
    const row = grouped.get(key) || { name: detail.colaboradorNombre, services: 0, sales: 0, tips: 0, commission: 0, deductions: 0 };
    row.services += 1;
    row.sales += Number(detail.subtotal) || 0;
    grouped.set(key, row);
  });
  dbTable("nomina").forEach((payroll) => {
    if (!inRangeDate(payroll.periodoFin || payroll.periodoInicio, start, end)) return;
    if (staffFilter && !normalize(payroll.colaboradorNombre).includes(staffFilter)) return;
    const key = payroll.colaboradorID || payroll.colaboradorNombre;
    const row = grouped.get(key) || { name: payroll.colaboradorNombre, services: 0, sales: 0, tips: 0, commission: 0, deductions: 0 };
    row.tips += Number(payroll.propinaNetaMes) || 0;
    row.commission += Number(payroll.comisionGenerada) || 0;
    row.deductions += (Number(payroll.descuentoAFP) || 0) + (Number(payroll.descuentoSeguro) || 0) + (Number(payroll.descuentoOtros) || 0) + (Number(payroll.descuentoCxC) || 0);
    grouped.set(key, row);
  });
  const rowsData = [...grouped.values()];
  const totalSales = rowsData.reduce((sum, row) => sum + row.sales, 0);
  reportCards([{ label: "Facturado por colaboradores", value: money.format(totalSales) }, { label: "Colaboradores", value: String(rowsData.length) }]);
  renderReportTable(
    ["Colaborador", "Servicios", "Facturado", "Propinas", "Comisión", "Descuentos", "Total variables"],
    rowsData.map((row) => {
      const tips = includeTips ? row.tips : 0;
      const commission = includeCommission ? row.commission : 0;
      const deductions = includeDeductions ? row.deductions : 0;
      return `
        <tr>
          <td>${row.name}</td>
          <td>${row.services}</td>
          <td class="amount">${money.format(row.sales)}</td>
          <td class="amount">${includeTips ? money.format(tips) : "-"}</td>
          <td class="amount">${includeCommission ? money.format(commission) : "-"}</td>
          <td class="amount danger">${includeDeductions ? money.format(deductions) : "-"}</td>
          <td class="amount">${money.format(tips + commission - deductions)}</td>
        </tr>
      `;
    }),
  );
}

function renderCashClosingsReport(start, end) {
  const rowsData = dbTable("cierres").filter((row) => inRangeDate(row.fechaHoraCierre, start, end));
  const expected = rowsData.reduce((sum, row) => sum + (Number(row.balanceTeorico) || Number(row.ingresosConfirmados) || 0), 0);
  const counted = rowsData.reduce((sum, row) => sum + (Number(row.balanceContado) || 0), 0);
  const shortage = rowsData.reduce((sum, row) => sum + (Number(row.cuadreFaltante) || 0), 0);
  const surplus = rowsData.reduce((sum, row) => sum + (Number(row.sobranteCaja) || 0), 0);
  reportCards([
    { label: "Esperado", value: money.format(expected) },
    { label: "Contado", value: money.format(counted) },
    { label: "Faltantes", value: money.format(shortage) },
    { label: "Sobrantes", value: money.format(surplus) },
  ]);
  renderReportTable(
    ["Fecha", "Caja", "Esperado", "Contado", "Faltante", "Sobrante", "Tarjeta", "Transferencia", "Lote"],
    rowsData.map(
      (row) => `
        <tr>
          <td>${dateOnly(row.fechaHoraCierre)}</td>
          <td>${row.cuentaCaja || "-"}</td>
          <td class="amount">${money.format(Number(row.balanceTeorico) || Number(row.ingresosConfirmados) || 0)}</td>
          <td class="amount">${money.format(Number(row.balanceContado) || 0)}</td>
          <td class="amount danger">${money.format(Number(row.cuadreFaltante) || 0)}</td>
          <td class="amount gold">${money.format(Number(row.sobranteCaja) || 0)}</td>
          <td class="amount">${money.format(Number(row.tarjetaContada) || 0)}</td>
          <td class="amount">${money.format(Number(row.transferenciaContada) || 0)}</td>
          <td>${row.procesadorTarjeta || "-"} ${row.loteTarjeta || ""}</td>
        </tr>
      `,
    ),
  );
}

function renderIncomeMethodsReport(start, end) {
  const grouped = new Map();
  dbTable("ingresos")
    .filter((row) => inRangeDate(row.fechaHora, start, end) && normalize(row.estado || "Confirmado") === "confirmado")
    .forEach((row) => {
      const key = row.metodoPago || "Sin método";
      const data = grouped.get(key) || { count: 0, gross: 0, retention: 0, net: 0 };
      data.count += 1;
      data.gross += Number(row.montoBruto) || 0;
      data.retention += Number(row.retencion) || 0;
      data.net += Number(row.montoNeto) || Number(row.montoBruto) || 0;
      grouped.set(key, data);
    });
  const rows = [...grouped.entries()];
  reportCards([{ label: "Ingresos netos", value: money.format(rows.reduce((sum, [, row]) => sum + row.net, 0)) }, { label: "Métodos usados", value: String(rows.length) }]);
  renderReportTable(
    ["Forma de pago", "Transacciones", "Bruto", "Retención", "Neto"],
    rows.map(([method, row]) => `<tr><td>${method}</td><td>${row.count}</td><td class="amount">${money.format(row.gross)}</td><td class="amount danger">${money.format(row.retention)}</td><td class="amount">${money.format(row.net)}</td></tr>`),
  );
}

function renderCardReceivablesReport(start, end) {
  const rows = dbTable("cuentasCobrar")
    .filter((row) => inRangeDate(row.fechaOrigen, start, end))
    .filter((row) => normalize(`${row.deudorTipo} ${row.tipoCxC} ${row.concepto}`).includes("procesador") || normalize(`${row.deudorTipo} ${row.tipoCxC} ${row.concepto}`).includes("tarjeta"));
  reportCards([
    { label: "CxC adquirentes", value: money.format(rows.reduce((sum, row) => sum + (Number(row.montoOriginal) || 0), 0)) },
    { label: "Pendiente", value: money.format(rows.reduce((sum, row) => sum + (Number(row.balancePendiente) || 0), 0)) },
  ]);
  renderReportTable(
    ["Fecha", "Adquirente", "Factura", "Original", "Aplicado", "Pendiente", "Estado"],
    rows.map((row) => `<tr><td>${dateOnly(row.fechaOrigen)}</td><td>${row.deudorNombre}</td><td>${row.facturaID || "-"}</td><td class="amount">${money.format(Number(row.montoOriginal) || 0)}</td><td class="amount">${money.format(Number(row.montoAplicado) || 0)}</td><td class="amount danger">${money.format(Number(row.balancePendiente) || 0)}</td><td>${row.estado}</td></tr>`),
  );
}

function renderPendingTransfersReport(start, end) {
  const rows = dbTable("cuentasCobrar")
    .filter((row) => inRangeDate(row.fechaOrigen, start, end))
    .filter((row) => normalize(`${row.tipoCxC} ${row.concepto}`).includes("transferencia"));
  reportCards([{ label: "Transferencias", value: String(rows.length) }, { label: "Pendiente", value: money.format(rows.reduce((sum, row) => sum + (Number(row.balancePendiente) || 0), 0)) }]);
  renderReportTable(
    ["Fecha", "Factura", "Cliente", "Concepto", "Original", "Pendiente", "Estado"],
    rows.map((row) => `<tr><td>${dateOnly(row.fechaOrigen)}</td><td>${row.facturaID || "-"}</td><td>${row.deudorNombre}</td><td>${row.concepto}</td><td class="amount">${money.format(Number(row.montoOriginal) || 0)}</td><td class="amount danger">${money.format(Number(row.balancePendiente) || 0)}</td><td>${row.estado}</td></tr>`),
  );
}

function renderTipsReport(start, end) {
  const grouped = new Map();
  dbTable("propinas")
    .filter((row) => inRangeDate(row.fechaHora, start, end))
    .forEach((row) => {
      const key = row.colaboradorNombre || "Sin colaborador";
      const data = grouped.get(key) || { gross: 0, retention: 0, net: 0, count: 0 };
      data.gross += Number(row.montoBruto) || 0;
      data.retention += Number(row.retencion20Tarjeta) || 0;
      data.net += Number(row.montoNetoPagar) || 0;
      data.count += 1;
      grouped.set(key, data);
    });
  const rows = [...grouped.entries()];
  reportCards([{ label: "Propinas netas", value: money.format(rows.reduce((sum, [, row]) => sum + row.net, 0)) }]);
  renderReportTable(["Colaborador", "Registros", "Bruto", "Retención", "Neto"], rows.map(([name, row]) => `<tr><td>${name}</td><td>${row.count}</td><td class="amount">${money.format(row.gross)}</td><td class="amount danger">${money.format(row.retention)}</td><td class="amount">${money.format(row.net)}</td></tr>`));
}

function renderCommissionsReport(start, end) {
  const rows = dbTable("nomina").filter((row) => inRangeDate(row.periodoFin || row.periodoInicio, start, end));
  reportCards([{ label: "Comisiones", value: money.format(rows.reduce((sum, row) => sum + (Number(row.comisionGenerada) || 0), 0)) }]);
  renderReportTable(
    ["Periodo", "Colaborador", "Producción", "% Comisión", "Comisión"],
    rows.map((row) => `<tr><td>${dateOnly(row.periodoInicio)} a ${dateOnly(row.periodoFin)}</td><td>${row.colaboradorNombre}</td><td class="amount">${money.format(Number(row.totalFacturadoMes) || 0)}</td><td>${((Number(row.porcentajeComision) || 0) * 100).toFixed(2)}%</td><td class="amount">${money.format(Number(row.comisionGenerada) || 0)}</td></tr>`),
  );
}

function renderExpensesReport(start, end) {
  const grouped = new Map();
  dbTable("egresos")
    .filter((row) => inRangeDate(row.fechaHora, start, end))
    .forEach((row) => {
      const key = `${row.tipo || "Egreso"} · ${row.categoria || row.concepto || "Sin categoría"}`;
      grouped.set(key, (grouped.get(key) || 0) + (Number(row.monto) || 0));
    });
  const rows = [...grouped.entries()];
  reportCards([{ label: "Total egresos", value: money.format(rows.reduce((sum, [, amount]) => sum + amount, 0)) }]);
  renderReportTable(["Categoría", "Monto"], rows.map(([key, amount]) => `<tr><td>${key}</td><td class="amount danger">${money.format(amount)}</td></tr>`));
}

function renderServicesReport(start, end) {
  const grouped = new Map();
  dbTable("facturaDetalle").forEach((detail) => {
    const invoice = dbTable("facturas").find((row) => row.facturaID === detail.facturaID);
    if (!invoice || !inRangeDate(invoice.fechaHora, start, end)) return;
    const row = grouped.get(detail.servicio) || { count: 0, amount: 0 };
    row.count += 1;
    row.amount += Number(detail.subtotal) || 0;
    grouped.set(detail.servicio, row);
  });
  const rows = [...grouped.entries()].sort((a, b) => b[1].amount - a[1].amount);
  reportCards([{ label: "Servicios vendidos", value: String(rows.reduce((sum, [, row]) => sum + row.count, 0)) }]);
  renderReportTable(["Servicio", "Cantidad", "Facturado"], rows.map(([service, row]) => `<tr><td>${service}</td><td>${row.count}</td><td class="amount">${money.format(row.amount)}</td></tr>`));
}

function renderClientsReport(start, end) {
  const grouped = new Map();
  dbTable("facturas")
    .filter((row) => inRangeDate(row.fechaHora, start, end))
    .forEach((invoice) => {
      const row = grouped.get(invoice.clienteNombre) || { count: 0, amount: 0 };
      row.count += 1;
      row.amount += Number(invoice.totalFacturado) || 0;
      grouped.set(invoice.clienteNombre, row);
    });
  const rows = [...grouped.entries()].sort((a, b) => b[1].amount - a[1].amount);
  reportCards([{ label: "Clientes atendidos", value: String(rows.length) }]);
  renderReportTable(["Cliente", "Facturas", "Facturado"], rows.map(([client, row]) => `<tr><td>${client}</td><td>${row.count}</td><td class="amount">${money.format(row.amount)}</td></tr>`));
}

function renderInventoryReport() {
  const rows = dbTable("inventario");
  reportCards([{ label: "Items", value: String(rows.length) }, { label: "Valor costo", value: money.format(rows.reduce((sum, row) => sum + (Number(row.costo) || 0) * (Number(row.existencia) || 0), 0)) }]);
  renderReportTable(["SKU", "Producto", "Tipo", "Existencia", "Mínimo", "Valor costo"], rows.map((row) => `<tr><td>${row.sku}</td><td>${row.nombre}</td><td>${row.tipo}</td><td>${Number(row.existencia) || 0}</td><td>${Number(row.existenciaMinima) || 0}</td><td class="amount">${money.format((Number(row.costo) || 0) * (Number(row.existencia) || 0))}</td></tr>`));
}

function renderFixedAssetsReport() {
  const rows = dbTable("activosFijos");
  reportCards([{ label: "Activos", value: String(rows.length) }, { label: "Valor libros", value: money.format(rows.reduce((sum, row) => sum + assetDepreciation(row).book, 0)) }]);
  renderReportTable(["Activo", "Categoría", "Valor adquisición", "Depreciación", "Valor libros", "Estado"], rows.map((row) => {
    const dep = assetDepreciation(row);
    return `<tr><td>${row.nombre}</td><td>${row.categoria || "-"}</td><td class="amount">${money.format(Number(row.valorAdquisicion) || 0)}</td><td class="amount danger">${money.format(dep.accumulated)}</td><td class="amount">${money.format(dep.book)}</td><td>${row.estado}</td></tr>`;
  }));
}

function updateReportFilters() {
  const type = byId("report-type").value;
  byId("report-account-filter").classList.toggle("hidden", !["account-balances", "account-movements"].includes(type));
  byId("report-staff-filter").classList.toggle("hidden", !["payroll", "staff-billing"].includes(type));
  byId("report-client-filter").classList.toggle("hidden", !["billing", "receivables"].includes(type));
  byId("report-tips-filter").classList.toggle("hidden", type !== "staff-billing");
  byId("report-commission-filter").classList.toggle("hidden", type !== "staff-billing");
  byId("report-deductions-filter").classList.toggle("hidden", type !== "staff-billing");
}

function renderReports() {
  updateReportFilters();
  const { start, end } = reportRange();
  const type = byId("report-type").value;
  const titles = {
    executive: "Resumen gestión",
    "account-balances": "Balance general de cuentas",
    "account-movements": "Movimientos de cuenta",
    billing: "Reporte de facturación",
    receivables: "Reporte de cuentas por cobrar",
    payroll: "Reporte de nómina",
    "staff-billing": "Facturación por colaborador",
    "cash-closings": "Reporte de cierres de caja",
    "income-methods": "Ingresos por forma de pago",
    "card-receivables": "Cuentas por cobrar a adquirentes",
    "pending-transfers": "Transferencias no confirmadas",
    tips: "Propinas por colaborador",
    commissions: "Comisiones por colaborador",
    expenses: "Egresos por categoría",
    services: "Servicios más vendidos",
    clients: "Clientes frecuentes",
    inventory: "Reporte de inventario",
    "fixed-assets": "Reporte de activos fijos",
  };
  byId("report-title").textContent = `${titles[type]} · ${start} a ${end}`;
  if (!reportGenerated) {
    byId("report-summary").innerHTML = "";
    renderReportTable(["Reporte"], ['<tr><td class="empty">Selecciona los filtros y pulsa Generar reporte.</td></tr>']);
    return;
  }
  if (type === "account-balances") return renderAccountBalancesReport(start, end);
  if (type === "account-movements") return renderAccountMovementsReport(start, end);
  if (type === "billing") return renderBillingReport(start, end);
  if (type === "receivables") return renderReceivablesReport(start, end);
  if (type === "payroll") return renderPayrollReport(start, end);
  if (type === "staff-billing") return renderStaffBillingReport(start, end);
  if (type === "cash-closings") return renderCashClosingsReport(start, end);
  if (type === "income-methods") return renderIncomeMethodsReport(start, end);
  if (type === "card-receivables") return renderCardReceivablesReport(start, end);
  if (type === "pending-transfers") return renderPendingTransfersReport(start, end);
  if (type === "tips") return renderTipsReport(start, end);
  if (type === "commissions") return renderCommissionsReport(start, end);
  if (type === "expenses") return renderExpensesReport(start, end);
  if (type === "services") return renderServicesReport(start, end);
  if (type === "clients") return renderClientsReport(start, end);
  if (type === "inventory") return renderInventoryReport();
  if (type === "fixed-assets") return renderFixedAssetsReport();
  return renderExecutiveReport(start, end);
}

function renderSettings() {
  const clientQuery = byId("client-search").value;
  const serviceQuery = byId("service-search").value;
  const staffQuery = byId("staff-search").value;
  const accountQuery = byId("account-search").value;
  const processorQuery = byId("processor-search").value;
  const commissionQuery = byId("commission-search").value;
  const clients = dbTable("clientes").filter((client) => {
    const q = normalize(clientQuery);
    return !q || [client.nombreCompleto, client.telefono, client.correo, client.estado].some((field) => normalize(field).includes(q));
  });
  const services = dbTable("servicios").filter((service) => {
    const q = normalize(serviceQuery);
    return !q || [service.servicio, service.categoria, service.estado].some((field) => normalize(field).includes(q));
  });
  const staffRows = dbTable("colaboradores").filter((staff) => {
    const q = normalize(staffQuery);
    return !q || [staff.nombreCompleto, staff.funcion, staff.telefono, staff.correo].some((field) => normalize(field).includes(q));
  });
  const accountRows = dbTable("cuentas").filter((account) => {
    const q = normalize(accountQuery);
    return !q || [account.nombreCuenta, account.tipoCuenta, account.entidad, account.tipoProducto, account.numeroCuenta].some((field) => normalize(field).includes(q));
  });
  const processorRows = dbTable("procesadores").filter((processor) => {
    const q = normalize(processorQuery);
    return !q || [processor.procesadorID, processor.nombre, processor.tipo, processor.comisionPorcentaje, processor.estado].some((field) => normalize(field).includes(q));
  });
  const commissionRows = dbTable("umbralesComision").filter((row) => {
    const q = normalize(commissionQuery);
    return !q || [row.escalaID, row.aplicaA, row.desde, row.hasta, row.porcentajeComision, row.estado].some((field) => normalize(field).includes(q));
  });

  byId("client-list").innerHTML = clients.length
    ? clients
        .map(
          (client) => `
            <article class="list-item">
              <div>
                <strong>${client.nombreCompleto}</strong>
                <span>${client.telefono || "Sin teléfono"} · ${client.correo || "Sin correo"} · ${client.estado || "Activo"}</span>
              </div>
              <div class="row-actions">
                <button class="secondary-btn compact edit-record" data-type="client" data-id="${client.clienteID}" type="button">Editar</button>
                <button class="secondary-btn compact toggle-record-status" data-table="clientes" data-id-field="clienteID" data-id="${client.clienteID}" type="button">${client.estado === "Inactivo" ? "Activar" : "Inactivar"}</button>
              </div>
            </article>
          `,
        )
        .join("")
    : '<p class="empty">No hay clientes con ese criterio.</p>';

  byId("service-list").innerHTML = services.length
    ? services
        .map(
          (service) => `
            <article class="list-item">
              <div>
                <strong>${service.servicio}</strong>
                <span>${service.categoria || "Sin categoría"} · ${money.format(Number(service.precioBase) || 0)} · ${Number(service.duracionMin) || 0} min · ${service.estado || "Activo"}</span>
              </div>
              <div class="row-actions">
                <button class="secondary-btn compact edit-record" data-type="service" data-id="${service.servicioID}" type="button">Editar</button>
                <button class="secondary-btn compact toggle-record-status" data-table="servicios" data-id-field="servicioID" data-id="${service.servicioID}" type="button">${service.estado === "Inactivo" ? "Activar" : "Inactivar"}</button>
              </div>
            </article>
          `,
        )
        .join("")
    : '<p class="empty">No hay servicios con ese criterio.</p>';

  byId("staff-list-view").innerHTML = staffRows.length
    ? staffRows
        .map(
          (staff) => `
            <article class="list-item">
              <div>
                <strong>${staff.nombreCompleto}</strong>
                <span>${staff.funcion || "Sin función"} · ${staff.telefono || "Sin teléfono"} · ${money.format(Number(staff.salarioMensual) || 0)} · Umbrales ${(staff.umbralesComisionActivos || []).length || 0} · ${staff.estado || "Activo"}</span>
              </div>
              <div class="row-actions">
                <button class="secondary-btn compact edit-record" data-type="staff" data-id="${staff.colaboradorID}" type="button">Editar</button>
                <button class="secondary-btn compact toggle-record-status" data-table="colaboradores" data-id-field="colaboradorID" data-id="${staff.colaboradorID}" type="button">${staff.estado === "Inactivo" ? "Activar" : "Inactivar"}</button>
              </div>
            </article>
          `,
        )
        .join("")
    : '<p class="empty">No hay colaboradores con ese criterio.</p>';

  byId("account-list").innerHTML = accountRows.length
    ? accountRows
        .map(
          (account) => `
            <article class="list-item">
              <div>
                <strong>${account.nombreCuenta}</strong>
                <span>${account.tipoCuenta || "Cuenta"} · ${account.entidad || "Sin entidad"} · ${account.tipoProducto || "Sin producto"} · ${money.format(Number(account.balanceInicial) || 0)} · ${account.estado || "Activo"}</span>
              </div>
              <div class="row-actions">
                <button class="secondary-btn compact edit-record" data-type="account" data-id="${account.cuentaID}" type="button">Editar</button>
                <button class="secondary-btn compact toggle-record-status" data-table="cuentas" data-id-field="cuentaID" data-id="${account.cuentaID}" type="button">${account.estado === "Inactivo" ? "Activar" : "Inactivar"}</button>
              </div>
            </article>
          `,
        )
        .join("")
    : '<p class="empty">No hay cuentas o cajas con ese criterio.</p>';

  byId("processor-list").innerHTML = processorRows.length
    ? processorRows
        .map(
          (processor) => `
            <article class="list-item">
              <div>
                <strong>${processor.nombre}</strong>
                <span>${processor.tipo || "Compañía adquiriente"} · ${(processorFeeRate(processor) * 100).toFixed(2)}% · ${processor.estado || "Activo"}</span>
              </div>
              <div class="row-actions">
                <button class="secondary-btn compact edit-record" data-type="processor" data-id="${processor.procesadorID}" type="button">Editar</button>
                <button class="secondary-btn compact toggle-record-status" data-table="procesadores" data-id-field="procesadorID" data-id="${processor.procesadorID}" type="button">${processor.estado === "Inactivo" ? "Activar" : "Inactivar"}</button>
              </div>
            </article>
          `,
        )
        .join("")
    : '<p class="empty">No hay compañías con ese criterio.</p>';

  byId("commission-list").innerHTML = commissionRows.length
    ? commissionRows
        .map(
          (row) => `
            <article class="list-item">
              <div>
                <strong>${row.escalaID} · ${row.aplicaA || "Sin nombre"}</strong>
                <span>${money.format(Number(row.desde) || 0)} a ${money.format(Number(row.hasta) || 0)} · ${(Number(row.porcentajeComision) || 0) * 100}% · ${row.estado || "Activo"}</span>
              </div>
              <div class="row-actions">
                <button class="secondary-btn compact edit-record" data-type="commission" data-id="${row.escalaID}" type="button">Editar</button>
                <button class="secondary-btn compact toggle-record-status" data-table="umbralesComision" data-id-field="escalaID" data-id="${row.escalaID}" type="button">${row.estado === "Inactivo" ? "Activar" : "Inactivar"}</button>
              </div>
            </article>
          `,
        )
        .join("")
    : '<p class="empty">No hay umbrales con ese criterio.</p>';
}

function renderAll() {
  renderDatalists();
  renderDashboard();
  renderInvoices();
  renderInvoiceAdmin();
  renderReceivables();
  renderIncomeRecords();
  renderPendingTransfers();
  renderReservations();
  renderPayroll();
  renderCash();
  renderCardReconciliation();
  renderExpenses();
  renderInventory();
  renderFixedAssets();
  renderReports();
  renderSettings();
}

function lookupValuesFor(listId) {
  if (listId === "clients-list") return state.clients.map((client) => client.name).filter(Boolean);
  if (listId === "people-list") return [...state.clients.map((client) => client.name), ...state.staff].filter(Boolean);
  if (listId === "advance-people-list") {
    return [
      ...state.staff,
      ...dbTable("suplidores").map((supplier) => supplier.nombre || supplier.nombreCompleto || supplier.empresa || supplier.suplidorNombre),
    ].filter(Boolean);
  }
  if (listId === "services-list") return state.services.map((service) => service.name).filter(Boolean);
  if (listId === "staff-list") return state.staff.filter(Boolean);
  if (listId === "accounts-list") return dbTable("cuentas").map((account) => account.nombreCuenta).filter(Boolean);
  if (listId === "bank-accounts-list") {
    return dbTable("cuentas")
      .filter((account) => normalize(account.tipoCuenta).includes("banco"))
      .map((account) => account.nombreCuenta)
      .filter(Boolean);
  }
  if (listId === "processors-list") {
    return dbTable("procesadores")
      .filter((processor) => normalize(processor.estado || "Activo") === "activo")
      .map((processor) => processor.nombre)
      .filter(Boolean);
  }
  if (listId === "expense-concept-list") return dbTable("conceptosEgresos").map((concept) => concept.concepto || concept.nombreConcepto).filter(Boolean);
  if (listId === "commission-threshold-list") return dbTable("umbralesComision").map((row) => row.aplicaA || row.escalaID).filter(Boolean);
  if (listId === "payroll-discount-concept-list") return ["AFP", "Seguro", "Otros", ...dbTable("conceptosDescuentoNomina").map((row) => row.concepto).filter(Boolean)];
  return [];
}

function attachSearchableLookups() {
  document.querySelectorAll("input[list]").forEach((input) => {
    if (input.dataset.lookupReady) return;
    input.dataset.lookupReady = "true";
    const wrapper = document.createElement("div");
    wrapper.className = "lookup-wrap";
    const menu = document.createElement("div");
    menu.className = "lookup-menu";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    wrapper.appendChild(menu);

    const showMatches = () => {
      const query = normalize(input.value);
      const values = [...new Set(lookupValuesFor(input.getAttribute("list")))]
        .filter((value) => !query || normalize(value).includes(query))
        .slice(0, 8);
      menu.innerHTML = values
        .map((value) => `<button class="lookup-option" type="button" data-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`)
        .join("");
      menu.classList.toggle("active", values.length > 0);
    };

    input.addEventListener("focus", showMatches);
    input.addEventListener("input", showMatches);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") menu.classList.remove("active");
    });
    menu.addEventListener("mousedown", (event) => {
      const option = event.target.closest(".lookup-option");
      if (!option) return;
      event.preventDefault();
      input.value = option.dataset.value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      menu.classList.remove("active");
    });
    document.addEventListener("click", (event) => {
      if (!wrapper.contains(event.target)) menu.classList.remove("active");
    });
  });
}

function wireNavigation() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
      button.classList.add("active");
      byId(button.dataset.view).classList.add("active");
      byId("view-title").textContent = button.textContent;
    });
  });
}

function wireAuth() {
  const resetPasswordPanel = (mode = "own") => {
    byId("password-change-form").reset();
    byId("password-change-panel").classList.remove("hidden");
    byId("auth-panel").classList.add("hidden");
    byId("forgot-password-panel").classList.add("hidden");
    byId("password-change-form").dataset.mode = mode;
    byId("password-change-email-label").classList.toggle("hidden", mode !== "forgot");
    byId("cancel-password-change").classList.toggle("hidden", mode === "forced");
    byId("password-current").placeholder = mode === "forgot" || mode === "forced" ? "Contraseña temporal" : "Contraseña actual";
    byId("password-change-title").textContent = mode === "forgot" ? "Crear contraseña nueva" : "Cambiar contraseña";
    byId("password-change-message").textContent =
      mode === "forgot"
        ? "Usa la contraseña temporal que te entregó el administrador."
        : "La contraseña nueva será la que usarás para entrar al ERP.";
    byId(mode === "forgot" ? "password-change-email" : "password-current").focus();
  };

  byId("open-login").addEventListener("click", () => {
    byId("auth-panel").classList.remove("hidden");
    byId("forgot-password-panel").classList.add("hidden");
    byId("password-change-panel").classList.add("hidden");
    byId("auth-email").focus();
  });
  byId("open-password-change").addEventListener("click", () => resetPasswordPanel("own"));
  byId("close-login").addEventListener("click", () => {
    if (!isSupabaseReady()) return;
    byId("auth-panel").classList.add("hidden");
  });
  byId("logout-button").addEventListener("click", async () => {
    if (!supabaseClient) return;
    await saveRemoteDatabase();
    await supabaseClient.auth.signOut();
    supabaseSession = null;
    updateAuthUi();
  });
  byId("forgot-password").addEventListener("click", () => {
    byId("auth-panel").classList.add("hidden");
    byId("forgot-password-panel").classList.remove("hidden");
    byId("password-change-panel").classList.add("hidden");
    byId("forgot-email").value = byId("auth-email").value.trim();
    byId("forgot-email").focus();
  });
  byId("cancel-forgot-password").addEventListener("click", () => {
    byId("forgot-password-panel").classList.add("hidden");
    byId("auth-panel").classList.remove("hidden");
  });
  byId("cancel-password-change").addEventListener("click", () => {
    byId("password-change-panel").classList.add("hidden");
    if (!isSupabaseReady()) byId("auth-panel").classList.remove("hidden");
  });
  byId("forgot-password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = byId("forgot-email").value.trim();
    const message = byId("forgot-password-message");
    message.textContent = "Validando reset...";
    try {
      const response = await fetch("/.netlify/functions/password-reset-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "No se pudo validar el reset.");
      message.textContent = result.message;
      if (result.canReset) {
        resetPasswordPanel("forgot");
        byId("password-change-email").value = email;
      }
    } catch (error) {
      message.textContent = error.message;
    }
  });
  byId("password-change-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    initSupabaseClient();
    if (!supabaseClient) {
      updateSyncStatus("Falta configuración central de Supabase", "error");
      return;
    }
    const mode = event.currentTarget.dataset.mode || (isPasswordResetRequired() ? "forced" : "own");
    const email = mode === "forgot" ? byId("password-change-email").value.trim() : supabaseSession?.user?.email;
    const currentPassword = byId("password-current").value;
    const newPassword = byId("password-new").value;
    const confirmPassword = byId("password-confirm").value;
    const message = byId("password-change-message");
    if (!email) {
      message.textContent = "Falta el correo del usuario.";
      return;
    }
    if (newPassword !== confirmPassword) {
      message.textContent = "La confirmación no coincide con la contraseña nueva.";
      return;
    }
    if (newPassword.length < 6) {
      message.textContent = "La contraseña nueva debe tener al menos 6 caracteres.";
      return;
    }
    message.textContent = "Actualizando contraseña...";
    const signInResult = await supabaseClient.auth.signInWithPassword({ email, password: currentPassword });
    if (signInResult.error) {
      message.textContent = "La contraseña actual o temporal no es correcta.";
      return;
    }
    const { data, error } = await supabaseClient.auth.updateUser({
      password: newPassword,
      data: {
        ...(signInResult.data.user?.user_metadata || {}),
        password_reset_required: false,
        password_reset_reason: "",
        password_changed_at: new Date().toISOString(),
      },
    });
    if (error) {
      message.textContent = error.message || "No se pudo cambiar la contraseña.";
      return;
    }
    supabaseSession = { ...signInResult.data.session, user: data.user || signInResult.data.user };
    event.currentTarget.reset();
    byId("password-change-panel").classList.add("hidden");
    message.textContent = "Contraseña actualizada.";
    const remoteDatabase = await loadRemoteDatabase();
    if (remoteDatabase) {
      database = remoteDatabase;
      ensureDatabaseShape();
      state = stateFromDatabase(database);
      localStorage.setItem(dbStorageKey, JSON.stringify(database));
      localStorage.setItem(appStorageKey, JSON.stringify(state));
    }
    updateAuthUi();
    renderAll();
  });
  byId("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    initSupabaseClient();
    if (!supabaseClient) {
      updateSyncStatus("Falta configuración central de Supabase", "error");
      return;
    }
    const email = byId("auth-email").value.trim();
    const password = byId("auth-password").value;
    updateSyncStatus("Conectando Supabase...", "online");
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      updateSyncStatus("Usuario o contraseña incorrectos", "error");
      return;
    }
    supabaseSession = data.session;
    const remoteDatabase = await loadRemoteDatabase();
    if (remoteDatabase) {
      database = remoteDatabase;
      ensureDatabaseShape();
      state = stateFromDatabase(database);
      localStorage.setItem(dbStorageKey, JSON.stringify(database));
      localStorage.setItem(appStorageKey, JSON.stringify(state));
    } else {
      await saveRemoteDatabase();
    }
    if (isPasswordResetRequired()) {
      byId("password-change-form").dataset.mode = "forced";
    }
    updateAuthUi();
    renderAll();
  });
}

function wireUserAdmin() {
  const form = byId("user-create-form");
  if (!form) return;
  const message = byId("user-create-message");
  const listMessage = byId("users-list-message");
  const listTarget = byId("users-list");

  const authHeaders = () => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${supabaseSession.access_token}`,
  });

  const loadUsers = async () => {
    if (!isSupabaseReady()) {
      listMessage.textContent = "Debes iniciar sesión para cargar usuarios.";
      listMessage.className = "form-message error";
      return;
    }
    listMessage.textContent = "Cargando usuarios...";
    listMessage.className = "form-message";
    try {
      const response = await fetch("/.netlify/functions/users", {
        headers: { Authorization: `Bearer ${supabaseSession.access_token}` },
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "No se pudo cargar usuarios.");
      renderUsersList(result.users || []);
      listMessage.textContent = "Usuarios cargados.";
      listMessage.className = "form-message success";
    } catch (error) {
      listTarget.innerHTML = '<tr><td class="empty" colspan="7">No se pudo cargar usuarios.</td></tr>';
      listMessage.textContent = error.message;
      listMessage.className = "form-message error";
    }
  };

  const renderUsersList = (users) => {
    if (!users.length) {
      listTarget.innerHTML = '<tr><td class="empty" colspan="7">No hay usuarios registrados.</td></tr>';
      return;
    }
    listTarget.innerHTML = users
      .map((user) => {
        const inactive = user.estado === "Inactivo";
        const pendingPassword = Boolean(user.passwordResetRequired);
        return `
          <tr data-user-id="${escapeHtml(user.id)}">
            <td><input class="user-name-input compact-input" value="${escapeHtml(user.fullName || "")}" placeholder="Nombre" /></td>
            <td><input class="user-email-input compact-input" type="email" value="${escapeHtml(user.email || "")}" /></td>
            <td>
              <select class="user-role-input compact-input">
                <option value="operador" ${user.role === "operador" ? "selected" : ""}>Operador</option>
                <option value="administradora" ${user.role === "administradora" ? "selected" : ""}>Administradora</option>
                <option value="propietario" ${user.role === "propietario" ? "selected" : ""}>Propietario</option>
              </select>
            </td>
            <td><span class="status-pill ${inactive ? "danger" : "success"}">${escapeHtml(user.estado || "Activo")}</span></td>
            <td><span class="status-pill ${pendingPassword ? "warning" : "success"}">${pendingPassword ? "Debe cambiar" : "Definitiva"}</span></td>
            <td><input class="user-password-input compact-input" type="password" minlength="6" placeholder="Opcional" /></td>
            <td>
              <div class="row-actions">
                <button class="secondary-btn compact save-user" type="button">Guardar</button>
                <button class="secondary-btn compact reset-user-password" type="button">Resetear</button>
                <button class="secondary-btn compact toggle-user" data-next-state="${inactive ? "Activo" : "Inactivo"}" type="button">${inactive ? "Reactivar" : "Inactivar"}</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  };

  const saveUserRow = async (row, estado = null) => {
    if (!isSupabaseReady()) return;
    const payload = {
      id: row.dataset.userId,
      fullName: row.querySelector(".user-name-input").value.trim(),
      email: row.querySelector(".user-email-input").value.trim(),
      role: row.querySelector(".user-role-input").value,
      password: row.querySelector(".user-password-input").value,
    };
    if (estado) payload.estado = estado;

    listMessage.textContent = "Guardando usuario...";
    listMessage.className = "form-message";
    const response = await fetch("/.netlify/functions/users", {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "No se pudo actualizar el usuario.");
    listMessage.textContent = result.temporaryPassword
      ? `Contraseña temporal generada: ${result.temporaryPassword}`
      : "Usuario actualizado.";
    listMessage.className = "form-message success";
    await loadUsers();
  };

  const resetUserPassword = async (row) => {
    const payload = {
      id: row.dataset.userId,
      fullName: row.querySelector(".user-name-input").value.trim(),
      email: row.querySelector(".user-email-input").value.trim(),
      role: row.querySelector(".user-role-input").value,
      resetPassword: true,
    };
    listMessage.textContent = "Generando contraseña temporal...";
    listMessage.className = "form-message";
    const response = await fetch("/.netlify/functions/users", {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "No se pudo resetear la contraseña.");
    listMessage.textContent = `Contraseña temporal generada: ${result.temporaryPassword}. Entrégala al usuario para que cree su contraseña nueva.`;
    listMessage.className = "form-message success";
    await loadUsers();
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isSupabaseReady()) {
      message.textContent = "Debes iniciar sesión antes de crear usuarios.";
      message.className = "form-message error";
      return;
    }
    const email = byId("new-user-email").value.trim();
    const password = byId("new-user-password").value;
    const fullName = byId("new-user-name").value.trim();
    const role = byId("new-user-role").value;
    message.textContent = "Creando usuario...";
    message.className = "form-message";
    try {
      const response = await fetch("/.netlify/functions/create-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseSession.access_token}`,
        },
        body: JSON.stringify({ email, password, fullName, role }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "No se pudo crear el usuario.");
      form.reset();
      message.textContent = result.temporaryPassword
        ? `Usuario creado: ${result.email || email}. Contraseña temporal: ${result.temporaryPassword}`
        : `Usuario creado: ${result.email || email}`;
      message.className = "form-message success";
      await loadUsers();
    } catch (error) {
      message.textContent = error.message;
      message.className = "form-message error";
    }
  });

  byId("refresh-users")?.addEventListener("click", loadUsers);
  listTarget?.addEventListener("click", async (event) => {
    const row = event.target.closest("tr[data-user-id]");
    if (!row) return;
    try {
      if (event.target.closest(".save-user")) {
        await saveUserRow(row);
      }
      if (event.target.closest(".toggle-user")) {
        await saveUserRow(row, event.target.closest(".toggle-user").dataset.nextState);
      }
      if (event.target.closest(".reset-user-password")) {
        await resetUserPassword(row);
      }
    } catch (error) {
      listMessage.textContent = error.message;
      listMessage.className = "form-message error";
    }
  });

  byId("open-supabase-users")?.addEventListener("click", () => {
    window.open("https://supabase.com/dashboard/project/lcqxbhlkqtjlwsedarej/auth/users", "_blank", "noopener");
  });
}

function wireDataFormToggles() {
  const selectModule = (formId) => {
    document.querySelectorAll(".data-form-toggle").forEach((item) => item.classList.toggle("active", item.dataset.formTarget === formId));
    document.querySelectorAll(".data-list-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.listPanel === formId));
    document.querySelectorAll(".data-entry-form").forEach((form) => form.classList.remove("active"));
  };
  const openForm = (formId) => {
    selectModule(formId);
    byId(formId).classList.add("active");
    byId(formId).scrollIntoView({ block: "start", behavior: "smooth" });
  };
  document.querySelectorAll(".data-form-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      selectModule(button.dataset.formTarget);
    });
  });
  document.querySelectorAll(".open-data-form").forEach((button) => {
    button.addEventListener("click", () => {
      const form = byId(button.dataset.formTarget);
      form.reset();
      if (button.dataset.formTarget === "staff-form") byId("staff-start-date").value = today;
      if (button.dataset.formTarget === "service-form") {
        byId("service-category").value = "Uñas";
        byId("service-duration").value = 45;
      }
      if (button.dataset.formTarget === "processor-form") byId("processor-fee-rate").value = "";
      if (button.dataset.formTarget === "staff-form") renderStaffThresholdChoices([]);
      openForm(button.dataset.formTarget);
    });
  });
}

function wireInlineListToggles() {
  document.querySelectorAll(".work-grid").forEach((grid) => {
    const form = grid.querySelector(":scope > form.panel");
    const lists = [...grid.querySelectorAll(":scope > section.panel")];
    if (!form || !lists.length || form.dataset.listToggleReady) return;
    form.dataset.listToggleReady = "true";
    lists.forEach((panel) => panel.classList.add("toggle-list-panel", "hidden"));
    const head = form.querySelector(".panel-head");
    const button = document.createElement("button");
    button.className = "secondary-btn compact";
    button.type = "button";
    button.textContent = form.id === "invoice-form" ? "Lista de facturas" : "Ver listado";
    head?.appendChild(button);
    button.addEventListener("click", () => {
      const willShow = lists.some((panel) => panel.classList.contains("hidden"));
      lists.forEach((panel) => panel.classList.toggle("hidden", !willShow));
      button.textContent = willShow ? "Ocultar listado" : form.id === "invoice-form" ? "Lista de facturas" : "Ver listado";
      if (willShow) lists[0].scrollIntoView({ block: "start", behavior: "smooth" });
    });
  });
}

function openDataForm(formId) {
  document.querySelectorAll(".data-form-toggle").forEach((item) => item.classList.toggle("active", item.dataset.formTarget === formId));
  document.querySelectorAll(".data-list-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.listPanel === formId));
  document.querySelectorAll(".data-entry-form").forEach((form) => form.classList.remove("active"));
  byId(formId).classList.add("active");
  byId(formId).scrollIntoView({ block: "start", behavior: "smooth" });
}

function closeDataForms() {
  document.querySelectorAll(".data-entry-form").forEach((form) => form.classList.remove("active"));
}

function fillDataForm(type, id) {
  if (type === "client") {
    const client = dbTable("clientes").find((row) => row.clienteID === id);
    if (!client) return;
    const parts = splitName(client.nombreCompleto || "");
    byId("client-edit-id").value = client.clienteID || "";
    byId("client-full-name").value = client.nombreCompleto || "";
    byId("client-first-name").value = client.nombre || parts.first || "";
    byId("client-last-name").value = client.apellido || parts.last || "";
    byId("client-phone").value = client.telefono || "";
    byId("client-sex").value = client.sexo || "";
    byId("client-email").value = client.correo || "";
    byId("client-address").value = client.direccion || "";
    byId("client-notes").value = client.observaciones || "";
    openDataForm("client-form");
  }
  if (type === "service") {
    const service = dbTable("servicios").find((row) => row.servicioID === id);
    if (!service) return;
    byId("service-edit-id").value = service.servicioID || "";
    byId("service-name").value = service.servicio || "";
    byId("service-category").value = service.categoria || "";
    byId("service-status").value = service.estado || "Activo";
    byId("service-price").value = Number(service.precioBase) || 0;
    byId("service-duration").value = Number(service.duracionMin) || 0;
    openDataForm("service-form");
  }
  if (type === "staff") {
    const staff = dbTable("colaboradores").find((row) => row.colaboradorID === id);
    if (!staff) return;
    byId("staff-edit-id").value = staff.colaboradorID || "";
    byId("staff-full-name").value = staff.nombreCompleto || "";
    byId("staff-first-name").value = staff.nombre || "";
    byId("staff-last-name").value = staff.apellido || "";
    byId("staff-role").value = staff.funcion || "";
    byId("staff-phone").value = staff.telefono || "";
    byId("staff-salary").value = Number(staff.salarioMensual) || 0;
    byId("staff-start-date").value = staff.fechaIngreso || today;
    renderStaffThresholdChoices(Array.isArray(staff.umbralesComisionActivos) ? staff.umbralesComisionActivos : staff.umbralComisionActivo ? [staff.umbralComisionActivo] : []);
    byId("staff-email").value = staff.correo || "";
    byId("staff-address").value = staff.direccion || "";
    openDataForm("staff-form");
  }
  if (type === "account") {
    const account = dbTable("cuentas").find((row) => row.cuentaID === id);
    if (!account) return;
    byId("account-edit-id").value = account.cuentaID || "";
    byId("account-type").value = account.tipoCuenta || "Banco";
    byId("account-product").value = account.tipoProducto || "";
    byId("account-name").value = account.nombreCuenta || "";
    byId("account-entity").value = account.entidad || "";
    byId("account-number").value = account.numeroCuenta || "";
    byId("account-owner").value = account.titular || "";
    byId("account-owner-document").value = account.documentoTitular || "";
    byId("account-currency").value = account.moneda || "DOP";
    byId("account-status").value = account.estado || "Activo";
    byId("account-opening-balance").value = Number(account.balanceInicial) || 0;
    byId("account-min-balance").value = Number(account.balanceMinimo) || 0;
    openDataForm("account-form");
  }
  if (type === "processor") {
    const processor = dbTable("procesadores").find((row) => row.procesadorID === id);
    if (!processor) return;
    byId("processor-edit-id").value = processor.procesadorID || "";
    byId("processor-name").value = processor.nombre || "";
    byId("processor-fee-rate").value = (processorFeeRate(processor) * 100).toFixed(2);
    byId("processor-status").value = processor.estado || "Activo";
    byId("processor-note").value = processor.observaciones || "";
    openDataForm("processor-form");
  }
  if (type === "commission") {
    const row = dbTable("umbralesComision").find((item) => item.escalaID === id);
    if (!row) return;
    byId("commission-edit-id").value = row.escalaID || "";
    byId("commission-applies-to").value = row.aplicaA || "";
    byId("commission-from").value = Number(row.desde) || 0;
    byId("commission-to").value = Number(row.hasta) || 0;
    byId("commission-rate").value = (Number(row.porcentajeComision) || 0) * 100;
    byId("commission-status").value = row.estado || "Activo";
    openDataForm("commission-form");
  }
}

function addInvoiceLine(defaultStaff = "") {
  const lineId = `line-${++invoiceLineCounter}`;
  const staffValue = defaultStaff || currentDefaultInvoiceStaff();
  const line = document.createElement("article");
  line.className = "invoice-line";
  line.dataset.lineId = lineId;
  line.innerHTML = `
    <div class="line-head">
      <strong>Servicio</strong>
      <button class="secondary-btn compact remove-invoice-line" type="button">Quitar</button>
    </div>
    <div class="line-grid">
      <label>
        Servicio
        <input class="line-service" list="services-list" placeholder="Buscar servicio" required />
      </label>
      <label>
        Colaboradora
        <input class="line-staff" list="staff-list" value="${escapeHtml(staffValue)}" placeholder="Buscar colaboradora" required />
      </label>
      <label>
        Precio
        <input class="line-price" type="number" min="0" step="0.01" readonly required />
      </label>
      <label class="invoice-detail-field hidden">
        Adicional
        <input class="line-extra" type="number" min="0" step="0.01" value="0" />
      </label>
      <label class="extra-note-field hidden">
        Detalle adicional
        <input class="line-extra-note" maxlength="50" placeholder="Máximo 50 caracteres" />
      </label>
      <label class="invoice-detail-field hidden">
        Descuento
        <input class="line-discount" type="number" min="0" step="0.01" value="0" />
      </label>
      <label class="discount-note-field hidden">
        Detalle descuento
        <input class="line-discount-note" maxlength="50" placeholder="Máximo 50 caracteres" />
      </label>
      <label>
        Subtotal
        <input class="line-subtotal" type="text" readonly />
      </label>
    </div>
  `;
  byId("invoice-line-list").appendChild(line);
  updateInvoiceLineOptionalFields(line);
  attachSearchableLookups();
  updateInvoiceTotals();
}

function currentDefaultInvoiceStaff() {
  const firstLineStaff = document.querySelector(".line-staff")?.value.trim();
  return firstLineStaff || state.staff[0] || "";
}

function getInvoiceLines() {
  return [...document.querySelectorAll(".invoice-line:not(.payment-line)")].map((line) => {
    const qty = 1;
    const price = Number(line.querySelector(".line-price").value) || 0;
    const extra = Number(line.querySelector(".line-extra").value) || 0;
    const discount = Number(line.querySelector(".line-discount").value) || 0;
    const subtotal = Math.max(0, qty * price + extra - discount);
    return {
      element: line,
      service: line.querySelector(".line-service").value.trim(),
      staff: line.querySelector(".line-staff").value.trim(),
      qty,
      price,
      extra,
      extraNote: line.querySelector(".line-extra-note").value.trim().slice(0, 50),
      discount,
      discountNote: line.querySelector(".line-discount-note").value.trim().slice(0, 50),
      subtotal,
    };
  });
}

function applyGeneralDiscountPercent() {
  const percent = Number(byId("invoice-general-discount-percent")?.value) || 0;
  if (percent <= 0) return;
  document.querySelectorAll(".invoice-line:not(.payment-line)").forEach((line) => {
    const price = Number(line.querySelector(".line-price")?.value) || 0;
    const discount = Number((price * (percent / 100)).toFixed(2));
    line.querySelector(".line-discount").value = discount;
    line.querySelector(".line-discount-note").value = `Descuento general ${percent}%`;
  });
}

function updateInvoiceLineOptionalFields(line) {
  const extra = Number(line.querySelector(".line-extra")?.value) || 0;
  const discount = Number(line.querySelector(".line-discount")?.value) || 0;
  line.querySelector(".extra-note-field")?.classList.toggle("hidden", extra <= 0);
  line.querySelector(".discount-note-field")?.classList.toggle("hidden", discount <= 0);
  if (extra <= 0) line.querySelector(".line-extra-note").value = "";
  if (discount <= 0) line.querySelector(".line-discount-note").value = "";
}

function updateInvoiceTotals() {
  applyGeneralDiscountPercent();
  const lines = getInvoiceLines();
  const payments = getPaymentLines();
  const servicesTotal = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
  const extrasTotal = lines.reduce((sum, line) => sum + line.extra, 0);
  const discountsTotal = lines.reduce((sum, line) => sum + line.discount, 0);
  const generalExtra = Number(byId("invoice-general-extra")?.value) || 0;
  const tip = Number(byId("invoice-tip").value) || 0;
  const grandTotal = Math.max(0, servicesTotal + extrasTotal + generalExtra - discountsTotal);
  const totalWithTip = grandTotal + tip;
  const paidTotal = payments.reduce((sum, payment) => sum + payment.amount, 0);
  const pendingTotal = Math.max(0, grandTotal - paidTotal);
  const overpay = Math.max(0, paidTotal - grandTotal);
  const finalOverpay = Math.max(0, paidTotal - totalWithTip);
  lines.forEach((line) => {
    line.element.querySelector(".line-subtotal").value = money.format(line.subtotal);
  });
  byId("invoice-services-total").textContent = money.format(servicesTotal);
  byId("invoice-extras-total").textContent = money.format(extrasTotal);
  byId("invoice-discounts-total").textContent = money.format(discountsTotal);
  byId("invoice-general-extra-total").textContent = money.format(generalExtra);
  byId("invoice-base-total").textContent = money.format(grandTotal);
  byId("invoice-grand-total").textContent = money.format(grandTotal);
  byId("invoice-total-with-tip").textContent = money.format(totalWithTip);
  byId("invoice-paid-total").textContent = money.format(paidTotal);
  byId("invoice-pending-total").textContent = money.format(pendingTotal);
  byId("invoice-overpay-total").textContent = money.format(overpay);
  byId("invoice-final-overpay-total").textContent = money.format(finalOverpay);
  byId("overpay-policy-label").classList.toggle("hidden", finalOverpay <= 0);
  renderTipAllocation(lines, tip);
}

function renderTipAllocation(lines, tip) {
  const target = byId("tip-allocation");
  const staffNames = [...new Set(lines.map((line) => line.staff).filter(Boolean))];
  if (!tip || !staffNames.length) {
    target.innerHTML = "";
    target.dataset.signature = "";
    return;
  }
  const signature = `${staffNames.join("|")}:${tip}`;
  if (target.dataset.signature === signature && target.querySelectorAll(".tip-share").length === staffNames.length) return;
  target.dataset.signature = signature;
  const base = Math.floor((tip / staffNames.length) * 100) / 100;
  let remainder = Number((tip - base * staffNames.length).toFixed(2));
  target.innerHTML = staffNames
    .map((staff, index) => {
      const amount = index === 0 ? Number((base + remainder).toFixed(2)) : base;
      return `
        <label>
          Propina para ${escapeHtml(staff)}
          <input class="tip-share" data-staff="${escapeHtml(staff)}" type="number" min="0" step="0.01" value="${amount}" />
        </label>
      `;
    })
    .join("");
}

function getTipAllocations() {
  return [...document.querySelectorAll(".tip-share")]
    .map((input) => ({ staff: input.dataset.staff, amount: Number(input.value) || 0 }))
    .filter((item) => item.staff && item.amount > 0);
}

function rebalanceTipShares(changedInput) {
  const total = Number(byId("invoice-tip").value) || 0;
  const inputs = [...document.querySelectorAll(".tip-share")];
  if (!total || inputs.length < 2 || !changedInput) return;
  const fixed = Number(changedInput.value) || 0;
  const others = inputs.filter((input) => input !== changedInput);
  const remaining = Math.max(0, total - fixed);
  const base = Math.floor((remaining / others.length) * 100) / 100;
  let remainder = Number((remaining - base * others.length).toFixed(2));
  others.forEach((input, index) => {
    input.value = (index === 0 ? Number((base + remainder).toFixed(2)) : base).toFixed(2);
  });
}

function ensureStaffRecord(name) {
  if (!name) return { colaboradorID: "", nombreCompleto: "" };
  let staff = findStaffByName(name);
  if (!staff) {
    const parts = splitName(name);
    staff = {
      colaboradorID: nextDbId("colaboradores", "colaboradorID", "COL"),
      nombreCompleto: name,
      nombre: parts.first,
      apellido: parts.last,
      funcion: "Manicurista",
      telefono: "",
      salarioMensual: 0,
      direccion: "",
      correo: "",
      estado: "Activo",
      fechaIngreso: today,
    };
    dbTable("colaboradores").push(stampRecord(staff));
  }
  return staff;
}

function clearInvoiceFormAfterSubmit() {
  byId("invoice-form").reset();
  byId("invoice-edit-id").value = "";
  byId("invoice-date").value = today;
  byId("invoice-submit-button").textContent = "Crear factura";
  byId("cancel-invoice-edit").classList.add("hidden");
  byId("invoice-line-list").innerHTML = "";
  byId("payment-line-list").innerHTML = "";
  byId("tip-allocation").innerHTML = "";
  byId("invoice-tip").value = 0;
  byId("invoice-general-extra").value = 0;
  byId("invoice-general-extra-note").value = "";
  byId("invoice-general-discount-percent").value = 0;
  byId("invoice-client-summary").textContent = "Selecciona un cliente para ver nombre y teléfono.";
  addInvoiceLine();
  addPaymentLine();
  updateInvoiceTotals();
}

function fillInvoiceLine(lineElement, detail) {
  lineElement.querySelector(".line-service").value = detail.servicio || "";
  lineElement.querySelector(".line-staff").value = detail.colaboradorNombre || "";
  lineElement.querySelector(".line-price").value = Number(detail.precioBase) || Number(detail.subtotal) || 0;
  lineElement.querySelector(".line-extra").value = Number(detail.extraMonto) || 0;
  lineElement.querySelector(".line-extra-note").value = detail.extraConcepto_50 || "";
  lineElement.querySelector(".line-discount").value = Number(detail.deduccionMonto) || 0;
  lineElement.querySelector(".line-discount-note").value = detail.deduccionConcepto_50 || "";
  updateInvoiceLineOptionalFields(lineElement);
}

function startInvoiceEdit(invoiceId) {
  if (!canEditInvoice(invoiceId)) {
    alert("Esta factura no se puede editar. Si el día ya fue cerrado, primero abre el cierre desde Cierres de caja.");
    return;
  }
  const invoice = dbTable("facturas").find((row) => row.facturaID === invoiceId);
  if (!invoice) return;
  const details = dbTable("facturaDetalle").filter((detail) => detail.facturaID === invoiceId);
  byId("invoice-edit-id").value = invoiceId;
  byId("invoice-date").value = dateOnly(invoice.fechaHora) || today;
  byId("invoice-client-search").value = invoice.clienteNombre || "";
  byId("invoice-note").value = invoice.observaciones || "";
  byId("invoice-general-extra").value = Number(invoice.adicionalGeneralMonto) || 0;
  byId("invoice-general-extra-note").value = invoice.adicionalGeneralDetalle || "";
  byId("invoice-general-discount-percent").value = Number(invoice.descuentoGeneralPorcentaje) || 0;
  byId("invoice-tip").value = 0;
  byId("invoice-line-list").innerHTML = "";
  (details.length ? details : [{ servicio: "", colaboradorNombre: invoice.colaboradorNombre, precioBase: Number(invoice.totalFacturado) || 0 }]).forEach((detail) => {
    addInvoiceLine(detail.colaboradorNombre || invoice.colaboradorNombre || "");
    fillInvoiceLine(byId("invoice-line-list").lastElementChild, detail);
  });
  byId("payment-line-list").innerHTML = "";
  addPaymentLine();
  byId("invoice-submit-button").textContent = "Guardar cambios";
  byId("cancel-invoice-edit").classList.remove("hidden");
  updateInvoiceTotals();
  byId("invoice-form").scrollIntoView({ block: "start", behavior: "smooth" });
}

function saveEditedInvoice(invoiceId, client, lines, totals, note) {
  if (!canEditInvoice(invoiceId)) {
    alert("No se puede guardar. El día está cerrado o tu usuario no tiene permisos administrativos.");
    return false;
  }
  const invoice = dbTable("facturas").find((row) => row.facturaID === invoiceId);
  if (!invoice) return false;
  const currentDate = dateOnly(invoice.fechaHora);
  const targetDate = canManageInvoices() ? (byId("invoice-date")?.value || currentDate || today) : currentDate;
  if (targetDate !== currentDate) {
    if (!canEditRecordDate(currentDate) || !canEditRecordDate(targetDate)) {
      alert("No se puede cambiar la fecha. El cierre origen o destino está confirmado; administración debe abrirlo primero.");
      return false;
    }
    moveLinkedRecordsForInvoices([invoice], currentDate, targetDate);
  }
  const clientRecord = findClientByName(client) || ensureClient(client);
  const firstStaff = ensureStaffRecord(lines[0].staff);
  database.data.facturaDetalle = dbTable("facturaDetalle").filter((detail) => detail.facturaID !== invoiceId);
  lines.forEach((line) => {
    ensureService(line.service, line.price);
    const serviceRecord = findServiceByName(line.service);
    const staffRecord = ensureStaffRecord(line.staff);
    dbTable("facturaDetalle").push(stampRecord({
      detalleID: nextDbId("facturaDetalle", "detalleID", "DET"),
      facturaID: invoiceId,
      servicioID: serviceRecord?.servicioID || "",
      servicio: line.service,
      colaboradorID: staffRecord.colaboradorID || "",
      colaboradorNombre: staffRecord.nombreCompleto || line.staff,
      cantidad: line.qty,
      precioBase: line.price,
      extraMonto: line.extra,
      extraConcepto_50: line.extraNote,
      deduccionMonto: line.discount,
      deduccionConcepto_50: line.discountNote,
      subtotal: line.subtotal,
    }));
  });
  invoice.clienteID = clientRecord?.clienteID || invoice.clienteID || "";
  invoice.clienteNombre = client;
  invoice.colaboradorID = firstStaff.colaboradorID || "";
  invoice.colaboradorNombre = firstStaff.nombreCompleto || "";
  const previousTip = Math.max(0, (Number(invoice.totalConPropina) || 0) - (Number(invoice.totalFacturado) || 0));
  invoice.totalFacturado = totals.total;
  invoice.totalPagadoConfirmado = Number(invoice.totalPagadoConfirmado) || 0;
  invoice.totalCxC = Math.max(0, totals.total - invoice.totalPagadoConfirmado);
  invoice.estadoFactura = invoice.totalCxC > 0 ? "Parcial" : "Pagada";
  invoice.adicionalGeneralMonto = totals.generalExtra;
  invoice.adicionalGeneralDetalle = totals.generalExtraNote;
  invoice.descuentoGeneralPorcentaje = totals.generalDiscountPercent;
  invoice.totalConPropina = totals.total + previousTip;
  invoice.observaciones = note;
  stampRecord(invoice, "updated");
  state = stateFromDatabase(database);
  clearInvoiceFormAfterSubmit();
  saveState();
  renderAll();
  alert("Factura actualizada. Las formas de pago registradas se conservaron.");
  return true;
}

function openBillingView() {
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === "billing"));
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  byId("billing").classList.add("active");
  byId("view-title").textContent = "Facturación";
}

function openAdminInvoiceEditor(invoiceId = "") {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede usar edición especial de facturas.");
    return;
  }
  openBillingView();
  if (invoiceId) {
    startInvoiceEdit(invoiceId);
    return;
  }
  clearInvoiceFormAfterSubmit();
  byId("invoice-date").value = today;
  byId("invoice-submit-button").textContent = "Crear factura admin";
  byId("invoice-form").scrollIntoView({ block: "start", behavior: "smooth" });
}

function openSettingsFormFromInvoice(formId) {
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === "settings"));
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  byId("settings").classList.add("active");
  byId("view-title").textContent = "Base de datos";
  byId(formId).dataset.returnToInvoice = "true";
  openDataForm(formId);
  byId(formId).scrollIntoView({ block: "start", behavior: "smooth" });
}

function populateInvoiceFromReservation(reservationId) {
  const { record: reservation } = reservationRecordById(reservationId);
  if (!reservation) return;
  activeReservationInvoiceId = reservationId;
  const clientName = reservation.client || reservation.clienteNombre || "";
  const serviceName = reservation.service || reservation.servicio || "";
  const staffName = reservation.staff || reservation.colaboradorNombre || "";
  byId("invoice-client-search").value = clientName;
  byId("invoice-note").value = `Factura generada desde reserva ${reservationId}`;
  byId("invoice-line-list").innerHTML = "";
  addInvoiceLine(staffName);
  const line = document.querySelector(".invoice-line:not(.payment-line)");
  if (line) {
    line.querySelector(".line-service").value = serviceName;
    line.querySelector(".line-staff").value = staffName;
    const price = servicePrice(serviceName);
    if (price !== "") line.querySelector(".line-price").value = price;
    updateInvoiceTotals();
  }
  openBillingView();
  byId("invoice-form").scrollIntoView({ block: "start", behavior: "smooth" });
}

function addPaymentLine() {
  const lineId = `payment-${++paymentLineCounter}`;
  const line = document.createElement("article");
  line.className = "invoice-line payment-line";
  line.dataset.lineId = lineId;
  line.innerHTML = `
    <div class="line-head">
      <strong>Forma de pago</strong>
      <button class="secondary-btn compact remove-payment-line" type="button">Quitar</button>
    </div>
    <div class="line-grid">
      <label>
        Método
        <select class="payment-method">
          <option value="efectivo">Efectivo</option>
          <option value="tarjeta">Tarjeta</option>
          <option value="transferencia_confirmada">Transferencia confirmada</option>
          <option value="transferencia_pendiente">Transferencia pendiente</option>
          <option value="credito">Crédito</option>
          <option value="balance">Balance a favor</option>
        </select>
      </label>
      <label>
        Monto
        <input class="payment-amount" type="number" min="0" step="0.01" value="0" />
      </label>
      <label class="payment-account-field hidden">
        Cuenta destino
        <input class="payment-account" placeholder="Buscar cuenta" />
      </label>
      <label class="payment-processor-field hidden">
        Procesador tarjeta
        <input class="payment-processor" list="processors-list" placeholder="Azul, CardNet, Visanet" />
      </label>
      <label class="payment-reference-field hidden">
        Referencia
        <input class="payment-reference" placeholder="Lote, voucher o nota" />
      </label>
      <label class="payment-due-field hidden">
        Fecha pago crédito
        <input class="payment-due-date" type="date" value="${datePlusDays(7)}" />
      </label>
      <label class="payment-state-field">
        Estado
        <input class="payment-state" type="text" value="Confirmado" readonly />
      </label>
    </div>
  `;
  byId("payment-line-list").appendChild(line);
  updatePaymentLineState(line);
  attachSearchableLookups();
  updateInvoiceTotals();
}

function getPaymentLines() {
  return [...document.querySelectorAll(".payment-line")].map((line) => ({
    element: line,
    method: line.querySelector(".payment-method").value,
    amount: Number(line.querySelector(".payment-amount").value) || 0,
    account: line.querySelector(".payment-account")?.value.trim() || "",
    processor: line.querySelector(".payment-processor")?.value.trim() || "",
    reference: line.querySelector(".payment-reference")?.value.trim() || "",
    dueDate: line.querySelector(".payment-due-date")?.value || datePlusDays(7),
  }));
}

function updatePaymentLineState(line) {
  const method = line.querySelector(".payment-method").value;
  const due = line.querySelector(".payment-due-date");
  const state = line.querySelector(".payment-state");
  const account = line.querySelector(".payment-account");
  const processor = line.querySelector(".payment-processor");
  line.querySelector(".payment-account-field")?.classList.add("hidden");
  line.querySelector(".payment-processor-field")?.classList.add("hidden");
  line.querySelector(".payment-reference-field")?.classList.add("hidden");
  line.querySelector(".payment-due-field")?.classList.add("hidden");

  if (method === "transferencia_pendiente") {
    state.value = "Pendiente por confirmar";
    due.value = today;
    line.querySelector(".payment-account-field")?.classList.remove("hidden");
    account.setAttribute("list", "bank-accounts-list");
    account.placeholder = "Seleccionar banco";
    line.querySelector(".payment-reference-field")?.classList.remove("hidden");
  } else if (method === "credito") {
    state.value = "Crédito";
    if (!due.value) due.value = datePlusDays(7);
    line.querySelector(".payment-due-field")?.classList.remove("hidden");
  } else if (method === "tarjeta") {
    state.value = "Contado / CxC procesador";
    line.querySelector(".payment-processor-field")?.classList.remove("hidden");
    line.querySelector(".payment-reference-field")?.classList.remove("hidden");
  } else if (method === "balance") {
    state.value = "Balance a favor";
  } else {
    state.value = "Confirmado";
    if (method === "transferencia_confirmada") {
      line.querySelector(".payment-account-field")?.classList.remove("hidden");
      account.setAttribute("list", "bank-accounts-list");
      account.placeholder = "Seleccionar banco";
      line.querySelector(".payment-reference-field")?.classList.remove("hidden");
    }
  }
  if (method === "efectivo") {
    account.value = "Caja Registradora";
    account.removeAttribute("list");
  }
  if (!method.includes("transferencia")) account.value = method === "efectivo" ? "Caja Registradora" : "";
  if (method !== "tarjeta") processor.value = "";
}

function updateExpenseOptionalFields() {
  const type = byId("expense-type").value;
  byId("expense-destination-label").classList.toggle("hidden", type !== "transferencia");
  byId("expense-receivable-label").classList.toggle("hidden", type !== "avance");
  updateExpenseBalancePreview();
}

function updateExpenseBalancePreview() {
  const source = byId("expense-source").value.trim();
  const amount = Number(byId("expense-amount").value) || 0;
  const panel = byId("expense-balance-panel");
  if (!source || !findAccountByName(source)) {
    panel.classList.add("hidden");
    byId("expense-source-balance").textContent = money.format(0);
    byId("expense-source-after").textContent = money.format(0);
    return;
  }
  const available = accountAvailableBalance(source);
  const after = available - amount;
  byId("expense-source-balance").textContent = money.format(available);
  byId("expense-source-after").textContent = money.format(after);
  byId("expense-source-after").classList.toggle("danger", after < 0);
  panel.classList.remove("hidden");
}

function wireForms() {
  const saveClientCatalog = (event) => {
    event.preventDefault();
    const firstName = byId("client-first-name").value.trim();
    const lastName = byId("client-last-name").value.trim();
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
    if (!firstName || !fullName) return;
    const editId = byId("client-edit-id").value;
    let client = dbTable("clientes").find((row) => row.clienteID === editId) || findClientByName(fullName);
    if (!client) {
      client = {
        clienteID: nextDbId("clientes", "clienteID", "CLI"),
        nombreCompleto: fullName,
        nombre: firstName,
        apellido: lastName,
        telefono: byId("client-phone").value.trim(),
        sexo: byId("client-sex").value,
        correo: byId("client-email").value.trim(),
        direccion: byId("client-address").value.trim(),
        estado: "Activo",
        fechaRegistro: today,
        observaciones: byId("client-notes").value.trim(),
      };
      dbTable("clientes").push(stampRecord(client));
    } else {
      client.nombreCompleto = fullName;
      client.nombre = firstName;
      client.apellido = lastName;
      client.telefono = byId("client-phone").value.trim() || client.telefono;
      client.sexo = byId("client-sex").value || client.sexo;
      client.correo = byId("client-email").value.trim() || client.correo;
      client.direccion = byId("client-address").value.trim() || client.direccion;
      client.observaciones = byId("client-notes").value.trim() || client.observaciones;
    }
    byId("client-form").reset();
    const shouldReturnToInvoice = byId("client-form").dataset.returnToInvoice === "true";
    delete byId("client-form").dataset.returnToInvoice;
    if (shouldReturnToInvoice) byId("invoice-client-search").value = client.nombreCompleto || fullName;
    closeDataForms();
    state = stateFromDatabase(database);
    saveState();
    renderAll();
    if (shouldReturnToInvoice) openBillingView();
  };

  byId("generate-report").addEventListener("click", () => {
    reportGenerated = true;
    renderReports();
    byId("report-result-panel").scrollIntoView({ block: "start", behavior: "smooth" });
  });

  byId("move-today-invoices-yesterday").addEventListener("click", moveTodayInvoicesToYesterday);
  byId("cancel-invoice-edit").addEventListener("click", clearInvoiceFormAfterSubmit);

  byId("show-invoice-client-form").addEventListener("click", () => {
    const parts = splitName(byId("invoice-client-search").value.trim());
    byId("client-first-name").value = parts.first;
    byId("client-last-name").value = parts.last;
    openSettingsFormFromInvoice("client-form");
  });

  byId("create-service-from-invoice").addEventListener("click", () => {
    byId("service-name").value = document.querySelector(".line-service")?.value.trim() || "";
    openSettingsFormFromInvoice("service-form");
  });

  byId("cancel-invoice-client").addEventListener("click", () => {
    byId("invoice-client-create").classList.add("hidden");
  });

  byId("save-invoice-client").addEventListener("click", () => {
    const firstName = byId("quick-client-first-name").value.trim();
    const lastName = byId("quick-client-last-name").value.trim();
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
    if (!firstName || !fullName) return;
    const phone = byId("quick-client-phone").value.trim();
    let client = findClientByPhone(phone) || findClientByName(fullName);
    const payload = {
      nombreCompleto: client?.nombreCompleto || fullName,
      nombre: firstName,
      apellido: lastName,
      telefono: phone,
      sexo: byId("quick-client-sex").value,
      correo: byId("quick-client-email").value.trim(),
      direccion: byId("quick-client-address").value.trim(),
      estado: "Activo",
      fechaRegistro: today,
      observaciones: byId("quick-client-notes").value.trim(),
    };
    if (!client) {
      dbTable("clientes").push(stampRecord({ clienteID: nextDbId("clientes", "clienteID", "CLI"), ...payload }));
    } else {
      Object.assign(client, {
        ...payload,
        clienteID: client.clienteID,
        telefono: payload.telefono || client.telefono,
        sexo: payload.sexo || client.sexo,
        correo: payload.correo || client.correo,
        direccion: payload.direccion || client.direccion,
        observaciones: payload.observaciones || client.observaciones,
      });
    }
    state = stateFromDatabase(database);
    byId("invoice-client-search").value = client?.nombreCompleto || fullName;
    ["quick-client-first-name", "quick-client-last-name", "quick-client-phone", "quick-client-email", "quick-client-address", "quick-client-notes"].forEach((id) => {
      byId(id).value = "";
    });
    byId("quick-client-sex").value = "";
    byId("invoice-client-create").classList.add("hidden");
    saveState();
    renderAll();
  });

  byId("invoice-form").addEventListener("click", (event) => {
    if (event.target.id !== "add-invoice-line" && !event.target.classList.contains("add-invoice-line-action")) return;
    event.preventDefault();
    document.querySelectorAll(".lookup-menu.active").forEach((menu) => menu.classList.remove("active"));
    addInvoiceLine(currentDefaultInvoiceStaff());
  });

  byId("invoice-form").addEventListener("click", (event) => {
    if (event.target.id !== "add-payment-line" && !event.target.classList.contains("add-payment-line-action")) return;
    event.preventDefault();
    document.querySelectorAll(".lookup-menu.active").forEach((menu) => menu.classList.remove("active"));
    addPaymentLine();
  });

  byId("invoice-line-list").addEventListener("input", (event) => {
    const line = event.target.closest(".invoice-line");
    if (!line) return;
    if (event.target.classList.contains("line-service")) {
      const price = servicePrice(event.target.value);
      if (price !== "") line.querySelector(".line-price").value = price;
    }
    if (event.target.classList.contains("line-staff")) {
      byId("tip-allocation").dataset.signature = "";
    }
    if (event.target.classList.contains("line-extra") || event.target.classList.contains("line-discount")) {
      updateInvoiceLineOptionalFields(line);
    }
    updateInvoiceTotals();
  });

  byId("invoice-client-search").addEventListener("input", () => {
    const client = findClientByName(byId("invoice-client-search").value.trim());
    byId("invoice-client-summary").textContent = client
      ? `${client.nombreCompleto || ""} · ${client.telefono || "Sin teléfono"}`
      : "Cliente nuevo o no encontrado en base de datos.";
  });

  ["invoice-general-extra", "invoice-general-extra-note", "invoice-general-discount-percent"].forEach((id) => {
    byId(id).addEventListener("input", () => {
      if (id === "invoice-general-discount-percent") {
        document.querySelectorAll(".invoice-line:not(.payment-line)").forEach((line) => updateInvoiceLineOptionalFields(line));
      }
      updateInvoiceTotals();
    });
  });

  byId("toggle-invoice-details").addEventListener("click", () => {
    const detailsHidden = document.querySelector(".invoice-detail-field")?.classList.contains("hidden");
    document.querySelectorAll(".invoice-detail-field, .extra-note-field, .discount-note-field").forEach((field) => {
      field.classList.toggle("hidden", !detailsHidden);
    });
    byId("toggle-invoice-details").textContent = detailsHidden ? "Ocultar detalles" : "Expandir detalles";
  });

  byId("invoice-line-list").addEventListener("click", (event) => {
    if (!event.target.classList.contains("remove-invoice-line")) return;
    const lines = document.querySelectorAll(".invoice-line:not(.payment-line)");
    if (lines.length <= 1) return;
    event.target.closest(".invoice-line").remove();
    byId("tip-allocation").dataset.signature = "";
    updateInvoiceTotals();
  });

  byId("invoice-tip").addEventListener("input", () => {
    byId("tip-allocation").dataset.signature = "";
    updateInvoiceTotals();
  });

  byId("tip-allocation").addEventListener("input", (event) => {
    if (event.target.classList.contains("tip-share")) rebalanceTipShares(event.target);
    updateInvoiceTotals();
  });

  ["payroll-staff", "payroll-period", "payroll-cut", "payroll-afp", "payroll-insurance", "payroll-other-deductions"].forEach((id) => {
    byId(id).addEventListener("input", () => updatePayrollPreview(id === "payroll-staff" || id === "payroll-period" || id === "payroll-cut"));
  });
  byId("payroll-cut").addEventListener("change", () => updatePayrollPreview(true));
  byId("payroll-cxc-list").addEventListener("input", () => updatePayrollPreview(false));

  byId("payment-line-list").addEventListener("input", (event) => {
    const line = event.target.closest(".payment-line");
    if (!line) return;
    if (event.target.classList.contains("payment-method")) updatePaymentLineState(line);
    updateInvoiceTotals();
  });

  byId("payment-line-list").addEventListener("change", (event) => {
    const line = event.target.closest(".payment-line");
    if (!line || !event.target.classList.contains("payment-method")) return;
    updatePaymentLineState(line);
    updateInvoiceTotals();
  });

  byId("payment-line-list").addEventListener("click", (event) => {
    if (!event.target.classList.contains("remove-payment-line")) return;
    const lines = document.querySelectorAll(".payment-line");
    if (lines.length <= 1) return;
    event.target.closest(".payment-line").remove();
    updateInvoiceTotals();
  });

  byId("settings").addEventListener("click", (event) => {
    const editButton = event.target.closest(".edit-record");
    const statusButton = event.target.closest(".toggle-record-status");
    if (editButton) {
      fillDataForm(editButton.dataset.type, editButton.dataset.id);
      return;
    }
    if (statusButton) {
      const row = dbTable(statusButton.dataset.table).find((item) => item[statusButton.dataset.idField] === statusButton.dataset.id);
      if (!row) return;
      row.estado = row.estado === "Inactivo" ? "Activo" : "Inactivo";
      state = stateFromDatabase(database);
      saveState();
      renderAll();
    }
  });

  byId("invoice-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const client = byId("invoice-client-search").value.trim();
    const lines = getInvoiceLines().filter((line) => line.service && line.staff && line.qty > 0);
    const editId = byId("invoice-edit-id").value;
    if (!client || !lines.length) return;
    const payments = getPaymentLines().filter((payment) => payment.amount > 0);
    const invoiceDate = canManageInvoices() ? (byId("invoice-date")?.value || today) : today;
    if (!isClosingOpenForEdits(closingForDate(invoiceDate))) {
      alert("No se puede crear factura en esa fecha porque el cierre está confirmado. Administración debe abrir el cierre antes de registrar o editar.");
      byId("invoice-date")?.focus();
      return;
    }
    const missingProcessor = payments.find((payment) => payment.method === "tarjeta" && !findProcessorByName(payment.processor));
    if (missingProcessor) {
      alert("Selecciona una compañía de tarjeta válida creada en Base de datos.");
      missingProcessor.element.querySelector(".payment-processor")?.focus();
      return;
    }
    const missingTransferAccount = payments.find((payment) => payment.method.includes("transferencia") && !findAccountByName(payment.account));
    if (missingTransferAccount) {
      alert("Selecciona una cuenta bancaria válida para la transferencia.");
      missingTransferAccount.element.querySelector(".payment-account")?.focus();
      return;
    }
    const tip = Number(byId("invoice-tip").value) || 0;
    const generalExtra = Number(byId("invoice-general-extra").value) || 0;
    const generalExtraNote = byId("invoice-general-extra-note").value.trim();
    const generalDiscountPercent = Number(byId("invoice-general-discount-percent").value) || 0;
    const note = byId("invoice-note").value.trim();
    if (generalExtra > 0 && !generalExtraNote) {
      alert("Indica el detalle del adicional general.");
      byId("invoice-general-extra-note").focus();
      return;
    }
    const servicesTotal = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    const extrasTotal = lines.reduce((sum, line) => sum + line.extra, 0);
    const discount = lines.reduce((sum, line) => sum + line.discount, 0);
    const total = Math.max(0, servicesTotal + extrasTotal + generalExtra - discount);
    const totalWithTip = total + tip;
    if (editId) {
      saveEditedInvoice(editId, client, lines, { total, generalExtra, generalExtraNote, generalDiscountPercent }, note);
      return;
    }
    const confirmedPaid = payments.filter((payment) => isConfirmedPaymentMethod(payment.method)).reduce((sum, payment) => sum + payment.amount, 0);
    const paidTotal = payments.reduce((sum, payment) => sum + payment.amount, 0);
    if (paidTotal < total) {
      alert(`Falta registrar ${money.format(total - paidTotal)} en formas de pago. Agrega efectivo, tarjeta, transferencia confirmada, transferencia pendiente o crédito por ese monto.`);
      return;
    }
    if (tip > Math.max(0, paidTotal - total)) {
      alert("La propina debe salir del excedente pagado después de cubrir los servicios.");
      byId("invoice-tip").focus();
      return;
    }
    const overpayPolicy = byId("invoice-overpay-policy").value;
    let paid = Math.min(total, confirmedPaid);
    const status = payments.some((paymentLine) => paymentLine.method === "credito" || paymentLine.method === "transferencia_pendiente") ? "Parcial" : "Pagada";
    const payment = payments.map((item) => item.method).join(", ") || "sin pago";
    const reservationForInvoice = activeReservationInvoiceId ? reservationRecordById(activeReservationInvoiceId) : null;
    const reservationClientRecord = reservationForInvoice?.record ? ensureClientFromReservation(reservationForInvoice.record) : null;
    if (!reservationClientRecord) ensureClient(client);
    const invoiceId = nextDbId("facturas", "facturaID", "FAC");
    const clientRecord = reservationClientRecord || findClientByName(client);
    const firstStaff = ensureStaffRecord(lines[0].staff);
    const detailRecords = [];

    lines.forEach((line) => {
      ensureService(line.service, line.price);
      const serviceRecord = findServiceByName(line.service);
      const staffRecord = ensureStaffRecord(line.staff);
      const detailId = nextDbId("facturaDetalle", "detalleID", "DET");
      const detail = {
        detalleID: detailId,
        facturaID: invoiceId,
        servicioID: serviceRecord?.servicioID || "",
        servicio: line.service,
        colaboradorID: staffRecord.colaboradorID || "",
        colaboradorNombre: staffRecord.nombreCompleto || line.staff,
        cantidad: line.qty,
        precioBase: line.price,
        extraMonto: line.extra,
        extraConcepto_50: line.extraNote,
        deduccionMonto: line.discount,
        deduccionConcepto_50: line.discountNote,
        subtotal: line.subtotal,
      };
      detailRecords.push(detail);
      dbTable("facturaDetalle").push(stampRecord(detail));
    });

    state.invoices.push(stampRecord({
      id: invoiceId,
      date: invoiceDate,
      clientId: clientRecord?.clienteID || "",
      client,
      service: lines.map((line) => line.service).join(", "),
      qty: lines.reduce((sum, line) => sum + line.qty, 0),
      price: servicesTotal,
      discount,
      total,
      payment,
      paid,
      note,
    }));
    const invoiceRecord = stampRecord({
      facturaID: invoiceId,
      fechaHora: dateTimeForOperationalDate(invoiceDate),
      clienteID: clientRecord?.clienteID || "",
      clienteNombre: client,
      colaboradorID: firstStaff.colaboradorID || "",
      colaboradorNombre: firstStaff.nombreCompleto || "",
      estadoFactura: status,
      totalFacturado: total,
      totalPagadoConfirmado: paid,
      totalCxC: total - paid,
      balanceFavorCliente: 0,
      adicionalGeneralMonto: generalExtra,
      adicionalGeneralDetalle: generalExtraNote,
      descuentoGeneralPorcentaje: generalDiscountPercent,
      totalConPropina: totalWithTip,
      cierreID: "Cierre no creado",
      observaciones: note,
    });
    dbTable("facturas").push(invoiceRecord);
    if (activeReservationInvoiceId) {
      const { stateRecord, dbRecord } = reservationRecordById(activeReservationInvoiceId);
      if (dbRecord) {
        dbRecord.facturaID = invoiceId;
        dbRecord.clienteID = clientRecord?.clienteID || dbRecord.clienteID || "";
        dbRecord.clienteNombre = clientRecord?.nombreCompleto || dbRecord.clienteNombre || client;
        dbRecord.clienteProvisional = false;
      }
      if (stateRecord) {
        stateRecord.invoiceId = invoiceId;
        stateRecord.clientId = clientRecord?.clienteID || stateRecord.clientId || "";
        stateRecord.client = clientRecord?.nombreCompleto || stateRecord.client || client;
        stateRecord.provisional = false;
      }
    }

    let confirmedAppliedToInvoice = 0;
    let nonConfirmedCxC = 0;
    payments.forEach((paymentLine) => {
      if (paymentLine.method === "balance") {
        const available = clientBalance(clientRecord?.clienteID);
        const used = Math.min(available, paymentLine.amount);
        adjustClientBalance(clientRecord?.clienteID, -used);
        confirmedAppliedToInvoice += used;
      } else if (isConfirmedPaymentMethod(paymentLine.method)) {
        const remainingForInvoice = applyClientReceivablesFirst(clientRecord, client, paymentLine.amount, paymentLine.method, "Pago aplicado primero a CxC previa", paymentLine.processor, paymentLine.account);
        if (remainingForInvoice > 0) {
          addConfirmedPayment(invoiceId, clientRecord, client, remainingForInvoice, paymentLine.method, paymentLine.reference || "Cobro factura", paymentLine.processor, paymentLine.account, invoiceDate);
          confirmedAppliedToInvoice += remainingForInvoice;
        }
        if (paymentLine.method === "tarjeta") {
          const processor = findProcessorByName(paymentLine.processor) || processorForPayment("tarjeta");
          addReceivable(invoiceId, { clienteID: processor.procesadorID || "" }, processor.nombre || "Procesador tarjeta", remainingForInvoice || paymentLine.amount, "CxC procesador tarjeta", "", invoiceDate);
        }
      } else if (paymentLine.method === "transferencia_pendiente") {
        addReceivable(invoiceId, clientRecord, client, paymentLine.amount, "Transferencia pendiente por confirmar", paymentLine.account, invoiceDate);
        nonConfirmedCxC += paymentLine.amount;
      } else if (paymentLine.method === "credito") {
        addReceivable(invoiceId, clientRecord, client, paymentLine.amount, `Crédito cliente vence ${paymentLine.dueDate || datePlusDaysFrom(invoiceDate, 7)}`, "", invoiceDate);
        nonConfirmedCxC += paymentLine.amount;
      }
    });

    paid = Math.min(total, confirmedAppliedToInvoice);
    invoiceRecord.totalPagadoConfirmado = paid;
    invoiceRecord.totalCxC = Math.max(0, total - paid);
    invoiceRecord.estadoFactura = invoiceRecord.totalCxC > 0 ? "Parcial" : "Pagada";

    invoiceRecord.totalCxC = nonConfirmedCxC;
    invoiceRecord.estadoFactura = nonConfirmedCxC > 0 ? "Parcial" : "Pagada";

    const actualOverpay = Math.max(0, confirmedAppliedToInvoice - total - tip);
    if (actualOverpay > 0) {
      if (overpayPolicy === "balance") {
        adjustClientBalance(clientRecord?.clienteID, actualOverpay);
      } else {
        dbTable("ingresos").push(stampRecord({
          ingresoID: nextDbId("ingresos", "ingresoID", "ING"),
          fechaHora: dateTimeForOperationalDate(invoiceDate),
          fechaEntradaCaja: invoiceDate,
          tipoIngreso: "Sobrante de facturación",
          facturaID: invoiceId,
          clienteID: clientRecord?.clienteID || "",
          clienteNombre: client,
          metodoPago: "sobrante",
          cuentaDestinoID: "",
          cuentaDestino: "Cuenta de sobrante",
          montoBruto: actualOverpay,
          retencion: 0,
          montoNeto: actualOverpay,
          estado: "Confirmado",
          observaciones: "Cliente pagó por encima del total facturado",
        }));
      }
    }

    const confirmedCapacity = Math.max(0, confirmedAppliedToInvoice - total);
    getTipAllocations().forEach((allocation) => {
      if (confirmedCapacity <= 0) return;
      const staffRecord = ensureStaffRecord(allocation.staff);
      const matchingDetail = detailRecords.find((detail) => detail.colaboradorID === staffRecord.colaboradorID) || detailRecords[0];
      const cardPaid = payments.some((paymentLine) => paymentLine.method === "tarjeta");
      const retention = cardPaid ? allocation.amount * 0.05 : 0;
      dbTable("propinas").push(stampRecord({
        propinaID: nextDbId("propinas", "propinaID", "PRO"),
        fechaHora: dateTimeForOperationalDate(invoiceDate),
        facturaID: invoiceId,
        detalleID: matchingDetail?.detalleID || "",
        colaboradorID: staffRecord.colaboradorID || "",
        colaboradorNombre: staffRecord.nombreCompleto || allocation.staff,
        montoBruto: allocation.amount,
        metodoPago: cardPaid ? "tarjeta" : "contado",
        retencion20Tarjeta: retention,
        montoNetoPagar: allocation.amount - retention,
        estadoPagoNomina: "Pendiente",
      }));
    });
    state = stateFromDatabase(database);
    activeReservationInvoiceId = "";
    clearInvoiceFormAfterSubmit();
    saveState();
    renderAll();
  });

  byId("invoice-table").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-invoice-id]");
    if (!row) return;
    const invoiceId = row.dataset.invoiceId;
    if (event.target.closest(".view-invoice")) openInvoiceReport(invoiceId);
    if (event.target.closest(".edit-invoice")) startInvoiceEdit(invoiceId);
    if (event.target.closest(".date-invoice")) changeInvoiceDate(invoiceId);
  });

  byId("invoice-admin-table").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-invoice-id]");
    if (!row) return;
    const invoiceId = row.dataset.invoiceId;
    if (event.target.closest(".view-invoice-admin")) openInvoiceReport(invoiceId);
    if (event.target.closest(".edit-invoice-admin")) openAdminInvoiceEditor(invoiceId);
  });
  byId("admin-new-invoice").addEventListener("click", () => openAdminInvoiceEditor());
  byId("move-july-9-invoices").addEventListener("click", moveBuggedJuly9InvoicesToJuly8);

  byId("payment-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const invoice = state.invoices.find((item) => item.id === byId("payment-invoice").value);
    if (!invoice) return;
    const amount = Math.min(Number(byId("payment-amount").value), outstanding(invoice));
    const method = byId("payment-method").value;
    const cashDate = byId("payment-cash-date").value || today;
    invoice.paid += amount;
    invoice.payment = method;
    const dbInvoice = dbTable("facturas").find((item) => item.facturaID === invoice.id);
    if (dbInvoice) {
      dbInvoice.totalPagadoConfirmado = invoice.paid;
      dbInvoice.totalCxC = outstanding(invoice);
      dbInvoice.estadoFactura = outstanding(invoice) <= 0 ? "Pagada" : "Parcial";
    }
    const cxc = dbTable("cuentasCobrar").find((item) => item.facturaID === invoice.id && Number(item.balancePendiente) > 0);
    if (cxc) {
      cxc.montoAplicado = (Number(cxc.montoAplicado) || 0) + amount;
      cxc.balancePendiente = Math.max(0, (Number(cxc.montoOriginal) || 0) - (Number(cxc.montoAplicado) || 0));
      cxc.estado = cxc.balancePendiente <= 0 ? "Saldada" : "Parcial";
    }
    addConfirmedPayment(invoice.id, dbTable("clientes").find((client) => client.clienteID === invoice.clientId) || findClientByName(invoice.client), invoice.client, amount, method, "Cobro cuenta por cobrar", "", "", cashDate);
    event.target.reset();
    byId("payment-cash-date").value = today;
    saveState();
    renderAll();
  });

  byId("cash-table").addEventListener("click", (event) => {
    const openButton = event.target.closest(".open-closing");
    const confirmButton = event.target.closest(".confirm-closing");
    const voidButton = event.target.closest(".void-closing");
    const viewButton = event.target.closest(".view-closing");
    const editButton = event.target.closest(".edit-closing");
    if (viewButton) openClosingReport(viewButton.dataset.closingId);
    if (editButton) startClosingEdit(editButton.dataset.closingId);
    if (openButton) openClosingForEdit(openButton.dataset.closingId);
    if (confirmButton) startClosingConfirmation(confirmButton.dataset.closingId);
    if (voidButton) voidClosing(voidButton.dataset.closingId);
  });

  byId("new-cash-closing").addEventListener("click", showNewCashClosing);
  byId("cancel-cash-closing").addEventListener("click", hideCashClosingForm);
  byId("confirm-previous-closings").addEventListener("click", confirmPreviousPendingClosings);

  byId("income-table").addEventListener("click", (event) => {
    const viewButton = event.target.closest(".view-income");
    if (viewButton) {
      openIncomeReport(viewButton.dataset.incomeId);
      return;
    }
    const button = event.target.closest(".date-income");
    if (!button) return;
    changeIncomeDate(button.dataset.incomeId);
  });

  byId("ar-table").addEventListener("click", (event) => {
    const confirmButton = event.target.closest(".confirm-transfer");
    const declineButton = event.target.closest(".decline-transfer");
    const button = confirmButton || declineButton;
    if (!button) return;
    handlePendingTransferAction(button, confirmButton ? "confirm" : "decline");
  });

  byId("pending-transfer-table").addEventListener("click", (event) => {
    const confirmButton = event.target.closest(".confirm-transfer");
    const declineButton = event.target.closest(".decline-transfer");
    const button = confirmButton || declineButton;
    if (!button) return;
    handlePendingTransferAction(button, confirmButton ? "confirm" : "decline");
  });

  byId("card-reconciliation-table").addEventListener("click", (event) => {
    const button = event.target.closest(".select-card-closing");
    if (!button) return;
    selectCardClosing(button.dataset.closingId);
  });

  byId("generate-cash-balance").addEventListener("click", updateCashBalancePreview);

  ["cash-counted", "cash-expenses", "cash-date"].forEach((id) => {
    byId(id).addEventListener("input", resetCashBalancePreview);
  });

  byId("card-reconciliation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const closingId = byId("card-reconciliation-closing-id").value;
    const closing = dbTable("cierres").find((row) => row.cierreID === closingId);
    if (!closing) {
      alert("Selecciona primero un lote pendiente de la tabla.");
      return;
    }
    const bankName = byId("card-reconciliation-bank").value.trim();
    const bank = findAccountByName(bankName);
    if (!bank) {
      alert("Selecciona una cuenta bancaria válida para recibir el pago.");
      byId("card-reconciliation-bank").focus();
      return;
    }
    const gross = Number(closing.tarjetaContada) || 0;
    const fee = Number(byId("card-reconciliation-fee").value) || 0;
    const net = Number(byId("card-reconciliation-net").value) || 0;
    if (net <= 0) {
      alert("Indica el monto recibido por el banco.");
      byId("card-reconciliation-net").focus();
      return;
    }
    const processorName = closing.procesadorTarjeta || "Procesador tarjeta";
    const incomeId = nextDbId("ingresos", "ingresoID", "ING");
    dbTable("ingresos").push(stampRecord({
      ingresoID: incomeId,
      fechaHora: `${byId("card-reconciliation-date").value}T12:00:00`,
      fechaEntradaCaja: byId("card-reconciliation-date").value || today,
      tipoIngreso: "Conciliación pago tarjeta",
      facturaID: "",
      clienteID: "",
      clienteNombre: processorName,
      metodoPago: "tarjeta_conciliada",
      cuentaDestinoID: bank.cuentaID || "",
      cuentaDestino: bank.nombreCuenta || bankName,
      montoBruto: gross,
      retencion: fee,
      montoNeto: net,
      estado: "Confirmado",
      observaciones: `Cierre ${closing.cierreID} lote ${closing.loteTarjeta || "sin lote"}. ${byId("card-reconciliation-note").value.trim()}`.trim(),
    }));

    let remaining = gross;
    dbTable("cuentasCobrar")
      .filter((cxc) => Number(cxc.balancePendiente) > 0)
      .filter((cxc) => normalize(cxc.concepto || cxc.tipoCxC).includes("procesador"))
      .filter((cxc) => !closing.procesadorTarjeta || normalize(cxc.deudorNombre).includes(normalize(closing.procesadorTarjeta)) || normalize(closing.procesadorTarjeta).includes(normalize(cxc.deudorNombre)))
      .forEach((cxc) => {
        if (remaining <= 0) return;
        const applied = Math.min(remaining, Number(cxc.balancePendiente) || 0);
        cxc.montoAplicado = (Number(cxc.montoAplicado) || 0) + applied;
        cxc.balancePendiente = Math.max(0, (Number(cxc.balancePendiente) || 0) - applied);
        cxc.estado = cxc.balancePendiente <= 0 ? "Saldada" : "Parcial";
        remaining -= applied;
        dbTable("ingresoAplicaciones").push(stampRecord({
          aplicacionID: nextDbId("ingresoAplicaciones", "aplicacionID", "APL"),
          ingresoID: incomeId,
          facturaID: cxc.facturaID || "",
          pagoID: "",
          cxCID: cxc.cxCID,
          montoAplicado: applied,
          observaciones: "Conciliación de procesador de tarjeta",
        }));
      });

    if (fee > 0) {
      dbTable("cuentasPagar").push(stampRecord({
        cxPID: nextDbId("cuentasPagar", "cxPID", "CXP"),
        fechaOrigen: `${byId("card-reconciliation-date").value}T12:00:00`,
        tipoCxP: "Comisión tarjeta",
        acreedorTipo: "Procesador tarjeta",
        acreedorID: "",
        acreedorNombre: processorName,
        nominaID: "",
        montoOriginal: fee,
        montoPagado: fee,
        balancePendiente: 0,
        estado: "Pagada",
        concepto: `Comisión ${processorName} lote ${closing.loteTarjeta || ""}`.trim(),
        fechaVencimiento: byId("card-reconciliation-date").value,
      }));
    }

    closing.estadoConciliacionTarjeta = "Conciliada";
    closing.fechaConciliacionTarjeta = byId("card-reconciliation-date").value;
    closing.cuentaBancoConciliacion = bank.nombreCuenta || bankName;
    closing.montoTarjetaRecibido = net;
    closing.comisionTarjetaConciliada = fee;
    closing.observacionConciliacionTarjeta = byId("card-reconciliation-note").value.trim();
    event.target.reset();
    byId("card-reconciliation-date").value = today;
    state = stateFromDatabase(database);
    saveState();
    renderAll();
  });

  byId("expense-type").addEventListener("change", updateExpenseOptionalFields);
  ["expense-source", "expense-destination", "expense-amount"].forEach((id) => {
    byId(id).addEventListener("input", updateExpenseBalancePreview);
  });
  byId("expense-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const editId = byId("expense-edit-id").value;
    const type = byId("expense-type").value;
    const amount = Number(byId("expense-amount").value) || 0;
    const source = byId("expense-source").value.trim();
    const destination = byId("expense-destination").value.trim();
    const concept = byId("expense-concept").value.trim();
    const note = byId("expense-note").value.trim();
    if (!amount || !source || !concept) return;
    const existingExpense = dbTable("egresos").find((row) => row.egresoID === editId);
    const sourceCredit = existingExpense && normalize(existingExpense.cuentaOrigen) === normalize(source) ? Number(existingExpense.monto) || 0 : 0;
    const available = accountAvailableBalance(source) + sourceCredit;
    if (amount > available) {
      alert(`El monto supera el disponible en ${source}. Disponible: ${money.format(available)}.`);
      byId("expense-amount").focus();
      return;
    }
    if (type === "transferencia" && !destination) {
      alert("Selecciona la cuenta o caja destino para registrar la transferencia.");
      byId("expense-destination").focus();
      return;
    }
    const advancePerson = byId("expense-receivable-person").value.trim();
    const advanceStaff = type === "avance" ? findStaffByName(advancePerson) : null;
    const advanceSupplier = type === "avance" ? findSupplierByName(advancePerson) : null;
    if (type === "avance" && !advanceStaff && !advanceSupplier) {
      alert("Los avances de efectivo solo se permiten a colaboradores o suplidores de servicios/productos.");
      byId("expense-receivable-person").focus();
      return;
    }
    if (existingExpense) {
      const sourceDate = dateOnly(existingExpense.fechaHora);
      const targetDate = byId("expense-date").value;
      if (!closingAllowsDateChange(sourceDate, targetDate)) return;
      Object.assign(existingExpense, {
        fechaHora: withDateOnly(existingExpense.fechaHora, targetDate),
        tipoEgreso: type,
        cuentaOrigenID: findAccountByName(source)?.cuentaID || "",
        cuentaOrigen: source,
        cuentaDestinoID: findAccountByName(destination)?.cuentaID || "",
        cuentaDestino: destination,
        concepto,
        monto: amount,
        observaciones: note,
      });
      stampRecord(existingExpense, "updated");
      event.target.reset();
      byId("expense-edit-id").value = "";
      byId("expense-submit").textContent = "Guardar egreso";
      byId("expense-date").value = today;
      updateExpenseOptionalFields();
      updateExpenseBalancePreview();
      state = stateFromDatabase(database);
      saveState();
      renderAll();
      return;
    }
    const expenseId = nextDbId("egresos", "egresoID", "EGR");
    const sourceAccount = findAccountByName(source);
    const destinationAccount = findAccountByName(destination);
    const row = {
      id: expenseId,
      date: byId("expense-date").value,
      type,
      source,
      destination,
      concept,
      amount,
      note,
    };
    state.expenses.push(row);
    dbTable("egresos").push(stampRecord({
      egresoID: expenseId,
      fechaHora: `${row.date}T12:00:00`,
      tipoEgreso: type,
      cuentaOrigenID: sourceAccount?.cuentaID || "",
      cuentaOrigen: source,
      cuentaDestinoID: destinationAccount?.cuentaID || "",
      cuentaDestino: destination,
      concepto,
      monto: amount,
      estado: "Registrado",
      observaciones: note,
    }));
    if (type === "transferencia") {
      dbTable("transferencias").push(stampRecord({
        transferenciaID: nextDbId("transferencias", "transferenciaID", "TRF"),
        fechaHora: `${row.date}T12:00:00`,
        cuentaOrigenID: sourceAccount?.cuentaID || "",
        cuentaOrigen: source,
        cuentaDestinoID: destinationAccount?.cuentaID || "",
        cuentaDestino: destination,
        monto: amount,
        estado: "Confirmada",
        observaciones: note || concept,
      }));
    }
    if (type === "avance") {
      const staffRecord = advanceStaff;
      const supplierRecord = advanceSupplier;
      if (staffRecord) {
        const cxcId = nextDbId("cuentasCobrar", "cxCID", "CXC");
        dbTable("cuentasCobrar").push(stampRecord({
          cxCID: cxcId,
          fechaOrigen: new Date().toISOString(),
          tipoCxC: "Avance colaborador",
          deudorTipo: "Colaborador",
          deudorID: staffRecord.colaboradorID,
          deudorNombre: staffRecord.nombreCompleto,
          facturaID: "",
          pagoID: "",
          montoOriginal: amount,
          montoAplicado: 0,
          balancePendiente: amount,
          estado: "Pendiente",
          concepto: `Avance autorizado: ${concept}`,
          fechaVencimiento: today,
        }));
      }
      if (supplierRecord) {
        const supplierName = supplierRecord.nombre || supplierRecord.nombreCompleto || supplierRecord.empresa || supplierRecord.suplidorNombre;
        const cxcId = nextDbId("cuentasCobrar", "cxCID", "CXC");
        dbTable("cuentasCobrar").push(stampRecord({
          cxCID: cxcId,
          fechaOrigen: new Date().toISOString(),
          tipoCxC: "Avance suplidor",
          deudorTipo: "Suplidor",
          deudorID: supplierRecord.suplidorID || supplierRecord.proveedorID || "",
          deudorNombre: supplierName,
          facturaID: "",
          pagoID: "",
          montoOriginal: amount,
          montoAplicado: 0,
          balancePendiente: amount,
          estado: "Pendiente",
          concepto: `Avance a suplidor: ${concept}`,
          fechaVencimiento: today,
        }));
      }
    }
    event.target.reset();
    byId("expense-edit-id").value = "";
    byId("expense-submit").textContent = "Guardar egreso";
    byId("expense-date").value = today;
    updateExpenseOptionalFields();
    updateExpenseBalancePreview();
    saveState();
    renderAll();
  });

  byId("expense-table").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-expense-id]");
    if (!row) return;
    if (event.target.closest(".view-expense")) openExpenseReport(row.dataset.expenseId);
    if (event.target.closest(".edit-expense")) startExpenseEdit(row.dataset.expenseId);
    if (event.target.closest(".date-expense")) changeExpenseDate(row.dataset.expenseId);
  });

  byId("inventory-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const sku = byId("inventory-sku").value.trim();
    const name = byId("inventory-name").value.trim();
    if (!sku || !name) return;
    const editId = byId("inventory-edit-id").value;
    let item = dbTable("inventario").find((row) => row.itemID === editId || normalize(row.sku) === normalize(sku));
    const previousStock = Number(item?.existencia) || 0;
    const stock = Number(byId("inventory-stock").value) || 0;
    const payload = {
      sku,
      nombre: name,
      categoria: byId("inventory-category").value.trim(),
      tipo: byId("inventory-type").value,
      costo: Number(byId("inventory-cost").value) || 0,
      precioVenta: Number(byId("inventory-sale-price").value) || 0,
      existencia: stock,
      existenciaMinima: Number(byId("inventory-min-stock").value) || 0,
      unidad: byId("inventory-unit").value.trim(),
      proveedor: byId("inventory-supplier").value.trim(),
      fechaEntrada: byId("inventory-entry-date").value || today,
      estado: "Activo",
      observaciones: byId("inventory-note").value.trim(),
      actualizadoEn: new Date().toISOString(),
    };
    if (!item) {
      item = { itemID: nextDbId("inventario", "itemID", "INV"), ...payload };
      dbTable("inventario").push(stampRecord(item));
    } else {
      Object.assign(item, payload);
    }
    const delta = stock - previousStock;
    if (delta !== 0) {
      dbTable("inventarioMovimientos").push(stampRecord({
        movimientoID: nextDbId("inventarioMovimientos", "movimientoID", "MOV"),
        itemID: item.itemID,
        fechaHora: new Date().toISOString(),
        tipo: delta > 0 ? "Entrada/Ajuste" : "Salida/Ajuste",
        cantidad: delta,
        costoUnitario: payload.costo,
        referencia: "Inventario",
        motivo: editId ? "Ajuste manual" : "Registro inicial",
        existenciaDespues: stock,
        observaciones: payload.observaciones,
      }));
    }
    event.target.reset();
    byId("inventory-entry-date").value = today;
    saveState();
    renderAll();
  });

  byId("asset-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = byId("asset-name").value.trim();
    if (!name) return;
    const editId = byId("asset-edit-id").value;
    let asset = dbTable("activosFijos").find((row) => row.activoID === editId || normalize(row.nombre) === normalize(name));
    const payload = {
      nombre: name,
      categoria: byId("asset-category").value.trim(),
      fechaAdquisicion: byId("asset-acquired-date").value || today,
      valorAdquisicion: Number(byId("asset-value").value) || 0,
      vidaUtilMeses: Number(byId("asset-life").value) || 60,
      metodoDepreciacion: byId("asset-method").value,
      depreciacionAcumulada: 0,
      valorLibros: 0,
      estado: byId("asset-status").value,
      ubicacion: byId("asset-location").value.trim(),
      responsable: byId("asset-responsible").value.trim(),
      observaciones: byId("asset-note").value.trim(),
      actualizadoEn: new Date().toISOString(),
    };
    const depreciation = assetDepreciation(payload);
    payload.depreciacionAcumulada = depreciation.accumulated;
    payload.valorLibros = depreciation.book;
    if (!asset) dbTable("activosFijos").push(stampRecord({ activoID: nextDbId("activosFijos", "activoID", "ACT"), ...payload }));
    else Object.assign(asset, payload);
    event.target.reset();
    byId("asset-acquired-date").value = today;
    byId("asset-life").value = 60;
    saveState();
    renderAll();
  });

  byId("reservation-client-phone").addEventListener("input", () => {
    delete byId("reservation-client-phone").dataset.autofilled;
    const client = findClientByPhone(byId("reservation-client-phone").value);
    if (client) {
      fillReservationClientFromRecord(client);
    } else {
      delete byId("reservation-form").dataset.clientId;
      const emailField = byId("reservation-client-email");
      if (emailField.dataset.autofilled === "true") emailField.value = "";
      delete emailField.dataset.autofilled;
    }
  });

  byId("reservation-client-search").addEventListener("input", () => {
    const client = findClientByName(byId("reservation-client-search").value.trim());
    if (!fillReservationClientFromRecord(client)) clearAutofilledReservationClientFields();
  });

  byId("reservation-list").addEventListener("click", (event) => {
    const button = event.target.closest(".invoice-reservation");
    if (!button) return;
    populateInvoiceFromReservation(button.dataset.reservationId);
  });

  byId("reservation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    let client = byId("reservation-client-search").value.trim();
    const service = byId("reservation-service-search").value.trim();
    const staff = byId("reservation-staff").value.trim();
    const phone = byId("reservation-client-phone").value.trim();
    const email = byId("reservation-client-email").value.trim();
    const source = byId("reservation-source").value;
    const existingByPhone = findClientByPhone(phone);
    const existingByName = findClientByName(client);
    let clientRecord = existingByPhone || existingByName || null;
    if (phone && existingByPhone && normalize(existingByPhone.nombreCompleto) !== normalize(client)) {
      client = existingByPhone.nombreCompleto || client;
      byId("reservation-client-search").value = client;
    }
    if (clientRecord) {
      if (phone && !clientRecord.telefono) clientRecord.telefono = phone;
      if (email && !clientRecord.correo) clientRecord.correo = email;
    }
    ensureService(service, servicePrice(service));
    if (staff && !state.staff.includes(staff)) state.staff.push(staff);
    const isProvisional = !clientRecord;
    const serviceRecord = findServiceByName(service);
    const reservationId = nextDbId("reservas", "reservaID", "RES");
    state.reservations.push({
      id: reservationId,
      date: byId("reservation-date").value,
      time: byId("reservation-time").value,
      clientId: clientRecord?.clienteID || "",
      client: clientRecord?.nombreCompleto || client,
      phone,
      email,
      provisional: isProvisional,
      source,
      serviceId: serviceRecord?.servicioID || "",
      service,
      staff,
      note: byId("reservation-note").value.trim(),
    });
    dbTable("reservas").push(stampRecord({
      reservaID: reservationId,
      fecha: byId("reservation-date").value,
      hora: byId("reservation-time").value,
      clienteID: clientRecord?.clienteID || "",
      clienteNombre: clientRecord?.nombreCompleto || client,
      telefono: phone,
      correo: email,
      clienteProvisional: isProvisional,
      canalOrigen: source,
      servicioID: serviceRecord?.servicioID || "",
      servicio: service,
      colaboradorNombre: staff,
      facturaID: "",
      observaciones: byId("reservation-note").value.trim(),
    }));
    event.target.reset();
    delete event.target.dataset.clientId;
    delete byId("reservation-client-phone").dataset.autofilled;
    delete byId("reservation-client-email").dataset.autofilled;
    byId("reservation-date").value = today;
    byId("reservation-source").value = "Presencial";
    saveState();
    renderAll();
  });

  byId("payroll-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const data = updatePayrollPreview(false);
    if (!data.staffName) return;
    if (data.staffName && !state.staff.includes(data.staffName)) state.staff.push(data.staffName);
    let staffRecord = data.staff || findStaffByName(data.staffName);
    if (!staffRecord) {
      const parts = splitName(data.staffName);
      staffRecord = {
        colaboradorID: nextDbId("colaboradores", "colaboradorID", "COL"),
        nombreCompleto: data.staffName,
        nombre: parts.first,
        apellido: parts.last,
        funcion: "",
        telefono: "",
        salarioMensual: data.cut === "month" ? data.base : data.base * 2,
        direccion: "",
        correo: "",
        estado: "Activo",
        fechaIngreso: today,
        umbralesComisionActivos: [],
      };
      dbTable("colaboradores").push(stampRecord(staffRecord));
    }
    const payrollId = nextDbId("nomina", "nominaID", "NOM");
    [...document.querySelectorAll(".payroll-cxc-discount")].forEach((input) => {
      const amount = Number(input.value) || 0;
      if (amount <= 0) return;
      const cxc = dbTable("cuentasCobrar").find((row) => row.cxCID === input.dataset.cxcId);
      if (!cxc) return;
      const applied = Math.min(amount, Number(cxc.balancePendiente) || 0);
      cxc.montoAplicado = (Number(cxc.montoAplicado) || 0) + applied;
      cxc.balancePendiente = Math.max(0, (Number(cxc.balancePendiente) || 0) - applied);
      cxc.estado = cxc.balancePendiente <= 0 ? "Saldada por payroll" : "Parcial payroll";
      cxc.observaciones = `${cxc.observaciones || ""} Descontado en ${payrollId}`.trim();
    });
    dbTable("propinas").forEach((tip) => {
      const sameStaff = staffRecord?.colaboradorID ? tip.colaboradorID === staffRecord.colaboradorID : normalize(tip.colaboradorNombre) === normalize(data.staffName);
      if (sameStaff && normalize(tip.estadoPagoNomina || "Pendiente") !== "pagada" && dateInRange(tip.fechaHora, data.range.start, data.range.end)) {
        tip.estadoPagoNomina = "Pagada";
        tip.nominaID = payrollId;
      }
    });
    const otherConcept = byId("payroll-other-concept").value.trim();
    if (otherConcept && !dbTable("conceptosDescuentoNomina").some((row) => normalize(row.concepto) === normalize(otherConcept))) {
      dbTable("conceptosDescuentoNomina").push(stampRecord({ conceptoID: nextDbId("conceptosDescuentoNomina", "conceptoID", "DESC"), concepto: otherConcept, estado: "Activo" }));
    }
    state.payroll.push({
      id: payrollId,
      period: data.period,
      cut: data.range.label,
      staff: data.staffName,
      base: data.base,
      commission: data.commission,
      tips: data.tips,
      deductions: data.deductions,
      sales: data.sales,
      net: data.net,
    });
    dbTable("nomina").push(stampRecord({
      nominaID: payrollId,
      periodoInicio: data.range.start,
      periodoFin: data.range.end,
      quincena: data.range.label,
      colaboradorID: staffRecord?.colaboradorID || "",
      colaboradorNombre: data.staffName,
      salarioBaseMensual: Number(staffRecord?.salarioMensual) || (data.cut === "month" ? data.base : data.base * 2),
      salarioQuincenal: (Number(staffRecord?.salarioMensual) || 0) / 2,
      totalFacturadoMes: data.sales,
      porcentajeComision: data.rate,
      comisionGenerada: data.commission,
      propinaNetaMes: data.tips,
      anticipos: data.deductions,
      descuentoAFP: data.afp,
      descuentoSeguro: data.insurance,
      descuentoOtros: data.other,
      descuentoCxC: data.cxcDiscounts,
      conceptoOtrosDescuentos: otherConcept,
      totalAPagar: data.net,
      estado: "Pendiente",
    }));
    dbTable("cuentasPagar").push(stampRecord({
      cxPID: nextDbId("cuentasPagar", "cxPID", "CXP"),
      fechaOrigen: new Date().toISOString(),
      tipoCxP: "Nómina",
      acreedorTipo: "Colaborador",
      acreedorID: staffRecord?.colaboradorID || "",
      acreedorNombre: data.staffName,
      nominaID: payrollId,
      montoOriginal: data.net,
      montoPagado: 0,
      balancePendiente: data.net,
      estado: "Pendiente",
      concepto: `Payroll ${data.range.label} ${data.period}`,
      fechaVencimiento: data.range.end,
    }));
    event.target.reset();
    byId("payroll-period").value = month;
    byId("payroll-cut").value = "month";
    byId("payroll-afp").value = 0;
    byId("payroll-insurance").value = 0;
    byId("payroll-other-deductions").value = 0;
    renderPayrollCxCList([]);
    saveState();
    renderAll();
    updatePayrollPreview(true);
  });

  byId("cash-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const editId = byId("cash-edit-id").value;
    const confirmAfterSave = byId("cash-confirm-after-save").value === "true";
    const date = byId("cash-date").value;
    const summary = dailyIncomeSummary(date);
    const expected = summary.cash;
    const initialCounted = Number(byId("cash-counted").value);
    const cardCounted = Number(byId("cash-card-counted").value) || 0;
    const cardProcessorName = byId("cash-card-processor").value.trim();
    const transferCounted = Number(byId("cash-transfer-counted").value) || 0;
    const expenses = Number(byId("cash-expenses").value) || 0;
    const closingId = editId || nextDbId("cierres", "cierreID", "CIE");
    const existingClosing = editId ? dbTable("cierres").find((row) => row.cierreID === editId) : null;
    const account = accountForPayment("efectivo");
    if (cardCounted > 0 && !findProcessorByName(cardProcessorName)) {
      alert("Selecciona la compañía de tarjeta creada en Base de datos para poder calcular su comisión.");
      byId("cash-card-processor").focus();
      return;
    }
    if (
      !cashBalanceDraft ||
      cashBalanceDraft.date !== date ||
      cashBalanceDraft.counted !== initialCounted ||
      cashBalanceDraft.expenses !== expenses
    ) {
      alert("Primero debes generar el cuadre de efectivo para documentar el intento.");
      byId("generate-cash-balance").focus();
      return;
    }
    const initialDifference = initialCounted - expenses - expected;
    const initialShortage = Math.max(0, -initialDifference);
    const shortageNote = byId("cash-shortage-note").value.trim();
    const rectifiedRaw = byId("cash-rectified-counted").value;
    if (initialShortage > 0 && !shortageNote) {
      alert("Hay un cuadre faltante inicial. Debes documentar el motivo antes de guardar el cierre.");
      byId("cash-shortage-note").focus();
      return;
    }
    if (initialShortage > 0 && rectifiedRaw === "") {
      alert("Debes introducir el monto contado rectificado para dejar evidencia del cierre corregido.");
      byId("cash-rectified-counted").focus();
      return;
    }
    const rectifiedCounted = initialShortage > 0 ? Number(rectifiedRaw) || 0 : 0;
    const counted = initialShortage > 0 ? rectifiedCounted : initialCounted;
    const difference = counted - expenses - expected;
    const shortage = Math.max(0, -difference);
    const surplus = Math.max(0, difference);
    if (shortage > 0) {
      alert("El monto rectificado todavía queda por debajo del efectivo esperado. Debes introducir el monto completivo antes de guardar el cierre.");
      byId("cash-rectified-counted").focus();
      return;
    }
    const closingPayload = {
      fechaHoraCierre: `${date}T23:59:00`,
      cajero: defaultStaffRecord().nombreCompleto || "",
      cuentaCaja: account.nombreCuenta || "Caja Operaciones",
      cuentaID: account.cuentaID || "",
      balanceInicial: 0,
      ingresosConfirmados: expected,
      egresos: expenses,
      balanceTeorico: expected,
      balanceContado: counted,
      conteoInicial: initialCounted,
      balanceContadoRectificado: rectifiedCounted,
      diferenciaInicial: initialDifference,
      diferencia: difference,
      cuadreFaltante: shortage,
      cuadreFaltanteInicial: initialShortage,
      sobranteCaja: surplus,
      estado: editId && !confirmAfterSave ? "Pendiente de confirmacion" : "Cerrado",
      requiereConfirmacion: Boolean(editId && !confirmAfterSave),
      loteTarjeta: byId("cash-card-batch").value.trim(),
      tarjetaContada: cardCounted,
      tarjetaEsperada: summary.card,
      procesadorTarjeta: cardProcessorName,
      comisionTarjetaPorcentaje: processorFeeRate(findProcessorByName(cardProcessorName)),
      transferenciaContada: transferCounted,
      transferenciaEsperada: summary.transfer,
      creditoGenerado: summary.credit,
      motivoFaltante: shortageNote,
      observaciones: byId("cash-note").value.trim(),
    };
    if (!editId || confirmAfterSave) {
      closingPayload.confirmadoPor = currentUserEmail();
      closingPayload.fechaConfirmacion = new Date().toISOString();
    }
    if (surplus > 0 && !existingClosing) {
      dbTable("ingresos").push(stampRecord({
        ingresoID: nextDbId("ingresos", "ingresoID", "ING"),
        fechaHora: new Date().toISOString(),
        fechaEntradaCaja: date,
        tipoIngreso: "Sobrante en cierre de caja",
        facturaID: "",
        clienteID: "",
        clienteNombre: "",
        metodoPago: "efectivo",
        cuentaDestinoID: account.cuentaID || "",
        cuentaDestino: account.nombreCuenta || "Caja registradora",
        montoBruto: surplus,
        retencion: 0,
        montoNeto: surplus,
        estado: "Confirmado",
        observaciones: "Excedente contado en cierre",
      }));
    }
    if (existingClosing) {
      Object.assign(existingClosing, closingPayload);
      stampRecord(existingClosing, "updated");
    } else {
      dbTable("cierres").push(stampRecord({ cierreID: closingId, ...closingPayload }));
    }
    state = stateFromDatabase(database);
    event.target.reset();
    byId("cash-edit-id").value = "";
    byId("cash-confirm-after-save").value = "";
    byId("cash-submit").textContent = "Guardar cierre";
    byId("cash-date").value = today;
    byId("cash-expenses").value = 0;
    byId("cash-card-counted").value = 0;
    byId("cash-transfer-counted").value = 0;
    resetCashBalancePreview();
    byId("cash-form").classList.add("hidden");
    saveState();
    renderAll();
  });

  byId("client-form").addEventListener("submit", saveClientCatalog);

  byId("service-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = byId("service-name").value.trim();
    if (!name) return;
    const editId = byId("service-edit-id").value;
    let service = dbTable("servicios").find((row) => row.servicioID === editId) || findServiceByName(name);
    if (!service) {
      service = {
        servicioID: nextDbId("servicios", "servicioID", "SER"),
        servicio: name,
        categoria: byId("service-category").value.trim() || "Uñas",
        precioBase: Number(byId("service-price").value) || 0,
        duracionMin: Number(byId("service-duration").value) || 0,
        estado: byId("service-status").value,
      };
      dbTable("servicios").push(stampRecord(service));
    } else {
      service.servicio = name;
      service.categoria = byId("service-category").value.trim() || service.categoria;
      service.precioBase = Number(byId("service-price").value) || service.precioBase;
      service.duracionMin = Number(byId("service-duration").value) || service.duracionMin;
      service.estado = byId("service-status").value || service.estado;
    }
    event.target.reset();
    const shouldReturnToInvoice = event.target.dataset.returnToInvoice === "true";
    delete event.target.dataset.returnToInvoice;
    if (shouldReturnToInvoice) {
      const emptyLine = [...document.querySelectorAll(".invoice-line:not(.payment-line)")].find((line) => !line.querySelector(".line-service").value.trim());
      const line = emptyLine || document.querySelector(".invoice-line:not(.payment-line)");
      if (line) {
        line.querySelector(".line-service").value = service.servicio || name;
        line.querySelector(".line-price").value = Number(service.precioBase) || 0;
      }
    }
    byId("service-category").value = "Uñas";
    byId("service-duration").value = 45;
    closeDataForms();
    state = stateFromDatabase(database);
    saveState();
    renderAll();
    if (shouldReturnToInvoice) {
      openBillingView();
      updateInvoiceTotals();
    }
  });

  byId("staff-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const fullName = byId("staff-full-name").value.trim();
    if (!fullName) return;
    const parts = splitName(fullName);
    const editId = byId("staff-edit-id").value;
    let staff = dbTable("colaboradores").find((row) => row.colaboradorID === editId) || findStaffByName(fullName);
    if (!staff) {
      staff = {
        colaboradorID: nextDbId("colaboradores", "colaboradorID", "COL"),
        nombreCompleto: fullName,
        nombre: byId("staff-first-name").value.trim() || parts.first,
        apellido: byId("staff-last-name").value.trim() || parts.last,
        funcion: byId("staff-role").value.trim(),
        telefono: byId("staff-phone").value.trim(),
        salarioMensual: Number(byId("staff-salary").value) || 0,
        direccion: byId("staff-address").value.trim(),
        correo: byId("staff-email").value.trim(),
        estado: "Activo",
        fechaIngreso: byId("staff-start-date").value || today,
        umbralesComisionActivos: selectedStaffThresholdIds(),
      };
      dbTable("colaboradores").push(stampRecord(staff));
    } else {
      staff.nombreCompleto = fullName;
      staff.nombre = byId("staff-first-name").value.trim() || staff.nombre;
      staff.apellido = byId("staff-last-name").value.trim() || staff.apellido;
      staff.funcion = byId("staff-role").value.trim() || staff.funcion;
      staff.telefono = byId("staff-phone").value.trim() || staff.telefono;
      staff.salarioMensual = Number(byId("staff-salary").value) || staff.salarioMensual;
      staff.direccion = byId("staff-address").value.trim() || staff.direccion;
      staff.correo = byId("staff-email").value.trim() || staff.correo;
      staff.fechaIngreso = byId("staff-start-date").value || staff.fechaIngreso;
      staff.umbralesComisionActivos = selectedStaffThresholdIds();
      delete staff.umbralComisionActivo;
    }
    event.target.reset();
    byId("staff-start-date").value = today;
    closeDataForms();
    state = stateFromDatabase(database);
    saveState();
    renderAll();
  });

  byId("account-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = byId("account-name").value.trim();
    if (!name) return;
    const editId = byId("account-edit-id").value;
    let account = dbTable("cuentas").find((row) => row.cuentaID === editId) || findAccountByName(name);
    const payload = {
      tipoCuenta: byId("account-type").value,
      nombreCuenta: name,
      entidad: byId("account-entity").value.trim(),
      tipoProducto: byId("account-product").value.trim(),
      numeroCuenta: byId("account-number").value.trim(),
      titular: byId("account-owner").value.trim(),
      documentoTitular: byId("account-owner-document").value.trim(),
      moneda: byId("account-currency").value,
      balanceInicial: Number(byId("account-opening-balance").value) || 0,
      balanceMinimo: Number(byId("account-min-balance").value) || 0,
      estado: byId("account-status").value,
    };
    if (!account) {
      dbTable("cuentas").push(stampRecord({ cuentaID: nextDbId("cuentas", "cuentaID", "CTA"), ...payload }));
    } else {
      Object.assign(account, payload);
    }
    event.target.reset();
    byId("account-currency").value = "DOP";
    byId("account-opening-balance").value = 0;
    byId("account-min-balance").value = 0;
    closeDataForms();
    state = stateFromDatabase(database);
    saveState();
    renderAll();
  });

  byId("processor-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = byId("processor-name").value.trim();
    if (!name) return;
    const editId = byId("processor-edit-id").value;
    let processor = dbTable("procesadores").find((row) => row.procesadorID === editId) || findProcessorByName(name);
    const rawRate = Number(byId("processor-fee-rate").value) || 0;
    const payload = {
      nombre: name,
      tipo: "Procesador de tarjeta",
      comisionPorcentaje: rawRate > 1 ? rawRate / 100 : rawRate,
      estado: byId("processor-status").value,
      observaciones: byId("processor-note").value.trim(),
    };
    if (!processor) {
      dbTable("procesadores").push(stampRecord({ procesadorID: nextDbId("procesadores", "procesadorID", "PT"), ...payload }));
    } else {
      Object.assign(processor, payload);
    }
    event.target.reset();
    closeDataForms();
    state = stateFromDatabase(database);
    saveState();
    renderAll();
  });

  byId("commission-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const appliesTo = byId("commission-applies-to").value.trim();
    if (!appliesTo) {
      alert("Debes indicar el nombre del umbral de comisión.");
      byId("commission-applies-to").focus();
      return;
    }
    const from = Number(byId("commission-from").value) || 0;
    const to = Number(byId("commission-to").value) || 0;
    const rawRate = Number(byId("commission-rate").value) || 0;
    const rate = rawRate > 1 ? rawRate / 100 : rawRate;
    const editId = byId("commission-edit-id").value;
    const existing = dbTable("umbralesComision").find((row) => row.escalaID === editId);
    const payload = {
      aplicaA: appliesTo,
      desde: from,
      hasta: to,
      porcentajeComision: rate,
      estado: byId("commission-status").value,
    };
    if (existing) Object.assign(existing, payload);
    else dbTable("umbralesComision").push(stampRecord({ escalaID: nextDbId("umbralesComision", "escalaID", "COM"), ...payload }));
    event.target.reset();
    renderStaffThresholdChoices([]);
    closeDataForms();
    state = stateFromDatabase(database);
    saveState();
    renderAll();
  });
}

function wireSearches() {
  [
    "invoice-search",
    "invoice-admin-search",
    "ar-search",
    "pending-transfer-search",
    "reservation-search",
    "payroll-search",
    "card-reconciliation-search",
    "expense-search",
    "inventory-search",
    "asset-search",
    "client-search",
    "service-search",
    "staff-search",
    "account-search",
    "processor-search",
    "commission-search",
  ].forEach((id) => {
    byId(id).addEventListener("input", renderAll);
    byId(id).addEventListener("change", renderAll);
  });

  const markReportPending = () => {
    reportGenerated = false;
    renderReports();
  };
  [
    "report-type",
    "report-start",
    "report-end",
    "report-account",
    "report-staff",
    "report-client",
    "report-include-tips",
    "report-include-commission",
    "report-include-deductions",
  ].forEach((id) => {
    byId(id).addEventListener("input", markReportPending);
    byId(id).addEventListener("change", markReportPending);
  });
}

function wireNumberFieldFocus() {
  document.addEventListener("focusin", (event) => {
    if (event.target?.matches('input[type="number"]') && event.target.value === "0") {
      event.target.value = "";
    }
  });
  document.addEventListener("focusout", (event) => {
    if (event.target?.matches('input[type="number"]') && event.target.value === "") {
      event.target.value = event.target.min === "" || Number(event.target.min) <= 0 ? "0" : event.target.min;
    }
  });
}

async function init() {
  await loadDatabase();
  ensureProvisionalClosings();
  state = loadState();
  saveState();
  byId("today-label").textContent = dateLabel.format(new Date(`${today}T12:00:00`));
  byId("invoice-date").value = today;
  byId("reservation-date").value = today;
  byId("payment-cash-date").value = today;
  byId("cash-date").value = today;
  byId("card-reconciliation-date").value = today;
  byId("expense-date").value = today;
  byId("inventory-entry-date").value = today;
  byId("asset-acquired-date").value = today;
  byId("report-start").value = `${month}-01`;
  byId("report-end").value = today;
  byId("payroll-period").value = month;
  byId("staff-start-date").value = today;
  updateAuthUi();
  wireNavigation();
  wireAuth();
  wireUserAdmin();
  wireDataFormToggles();
  wireInlineListToggles();
  wireForms();
  wireSearches();
  wireNumberFieldFocus();
  attachSearchableLookups();
  if (!document.querySelector(".invoice-line")) addInvoiceLine();
  if (!document.querySelector(".payment-line")) addPaymentLine();
  updateExpenseOptionalFields();
  updatePayrollPreview(true);
  renderAll();
}

init();
