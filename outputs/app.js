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

function functionEndpoint(name) {
  const configuredBase = String(window.DALFI_FUNCTION_BASE || "").replace(/\/$/, "");
  if (configuredBase) return `${configuredBase}/${name}`;
  if (location.hostname.includes("netlify.app")) return `/.netlify/functions/${name}`;
  return `/api/${name}`;
}

const dateLabel = new Intl.DateTimeFormat("es-DO", {
  timeZone: "America/Santo_Domingo",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const birthdateLabelFormat = new Intl.DateTimeFormat("es-DO", { day: "numeric", month: "short" });

// Muestra la fecha de nacimiento como "15 mar" para las listas de clientes y
// colaboradores; util para promociones/felicitaciones de cumpleanos.
function birthdateLabel(value) {
  if (!value) return "";
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return "";
  return birthdateLabelFormat.format(parsed);
}

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
let incomePaymentLineCounter = 0;
// Identificador local unico (no persistido) para cada porcion de "balance a
// favor" aplicada a una CxC anterior: balance a favor no genera un pagoID
// real (no crea addConfirmedPayment), asi que este contador es lo que le da
// identidad estable a cada aplicacion para la idempotencia de propinas
// (ver applyClientReceivablesFirst/collectInvoiceTip).
let balanceApplicationCounter = 0;
let cashBalanceDraft = null;
let reportGenerated = false;
let activeReservationInvoiceId = "";
let supabaseClient = null;
let supabaseSession = null;
let remoteSaveTimer = null;
let remoteSaveInFlight = false;
let remoteRefreshTimer = null;
let isLoadingRemote = false;
// Ultimo updated_at conocido de erp_records: permite que el poll periodico
// pregunte solo por esta columna (unos bytes) antes de traer el documento
// jsonb completo, en vez de descargarlo entero cada 30s aunque nadie haya
// cambiado nada. Ver refreshRemoteDatabase().
let lastKnownRemoteUpdatedAt = null;
// Perfil y permisos efectivos segun el servidor (GET /api/me), fuente unica
// de autorizacion real desde la auditoria tecnica 2026-07-20/21. NUNCA usar
// supabaseSession.user.user_metadata.role para decidir si una accion esta
// permitida: eso es editable por el propio usuario y solo sirve como dato
// visual de respaldo (ver currentUserRole()). erpProfileLoaded distingue
// "todavia no se pidio /api/me" de "se pidio y fallo": mientras no este en
// true, las funciones can*() de mas abajo aplican minimo privilegio (false).
let erpProfile = null;
let erpProfileLoaded = false;
// Evita solicitudes superpuestas a /api/me: si ya hay una en curso (por
// ejemplo el poll de 30s dispara mientras el login todavia esta esperando
// la primera respuesta), las llamadas siguientes reutilizan esa misma
// promesa en vez de abrir un fetch nuevo en paralelo.
let erpProfileRefreshPromise = null;
// Throttle de logs: si /api/me falla varias veces seguidas (por ejemplo la
// red esta caida), solo se avisa una vez por racha de fallos, no cada 30s.
let erpProfileFailureLogged = false;

function refreshErpProfile() {
  if (erpProfileRefreshPromise) return erpProfileRefreshPromise;
  erpProfileRefreshPromise = performErpProfileRefresh().finally(() => {
    erpProfileRefreshPromise = null;
  });
  return erpProfileRefreshPromise;
}

async function performErpProfileRefresh() {
  if (!isSupabaseReady()) {
    erpProfile = null;
    erpProfileLoaded = false;
    return null;
  }
  try {
    const response = await fetch(functionEndpoint("me"), {
      headers: { Authorization: `Bearer ${supabaseSession.access_token}` },
    });
    // Cualquier respuesta que no sea 2xx (401 sesion invalida, 403 sin
    // perfil o inactivo, 5xx del servidor) aplica minimo privilegio por
    // igual: nunca se asume administrador ante un error.
    if (!response.ok) {
      erpProfile = null;
      erpProfileLoaded = true;
      return null;
    }
    erpProfile = await response.json();
    erpProfileLoaded = true;
    erpProfileFailureLogged = false;
    return erpProfile;
  } catch (error) {
    // Ante un error de RED (no una respuesta HTTP), tambien minimo
    // privilegio: nunca se asume administrador solo porque no se pudo
    // confirmar lo contrario.
    erpProfile = null;
    erpProfileLoaded = true;
    if (!erpProfileFailureLogged) {
      console.warn("No se pudo cargar el perfil seguro (/api/me). Se aplica minimo privilegio.", error);
      erpProfileFailureLogged = true;
    }
    return null;
  }
}

async function loadDatabase() {
  initSupabaseClient();
  if (supabaseClient) {
    try {
      const sessionResult = await supabaseClient.auth.getSession();
      supabaseSession = sessionResult.data.session;
      if (supabaseSession) {
        await refreshErpProfile();
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

// Consulta liviana (solo la columna updated_at, no el jsonb completo) para
// que el poll periodico pueda detectar "nadie cambio nada" sin pagar el
// costo de descargar el documento entero cada vez.
async function fetchRemoteUpdatedAt() {
  const { data, error } = await supabaseClient
    .from("erp_records")
    .select("updated_at")
    .eq("table_name", remoteTableName)
    .eq("record_key", remoteRecordKey)
    .maybeSingle();
  if (error) throw error;
  return data?.updated_at || null;
}

function isUserEditingForm() {
  const active = document.activeElement;
  return Boolean(active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName));
}

async function refreshRemoteDatabase({ force = false } = {}) {
  if (!isSupabaseReady() || !database || remoteSaveInFlight || isLoadingRemote) return false;
  if (!force && isUserEditingForm()) return false;
  try {
    if (!force && lastKnownRemoteUpdatedAt) {
      const remoteUpdatedAt = await fetchRemoteUpdatedAt();
      if (remoteUpdatedAt && remoteUpdatedAt === lastKnownRemoteUpdatedAt) return false;
    }
    isLoadingRemote = true;
    const { data: row, error } = await supabaseClient
      .from("erp_records")
      .select("data, updated_at")
      .eq("table_name", remoteTableName)
      .eq("record_key", remoteRecordKey)
      .maybeSingle();
    if (error) throw error;
    if (!row?.data) return false;
    database = row.data;
    lastKnownRemoteUpdatedAt = row.updated_at || lastKnownRemoteUpdatedAt;
    ensureDatabaseShape();
    state = stateFromDatabase(database);
    localStorage.setItem(dbStorageKey, JSON.stringify(database));
    localStorage.setItem(appStorageKey, JSON.stringify(state));
    renderAll();
    updateSyncStatus(`Conectado: ${supabaseSession.user.email}`, "online");
    return true;
  } catch (error) {
    console.warn("No se pudo refrescar Supabase.", error);
    updateSyncStatus("Error leyendo Supabase", "error");
    return false;
  } finally {
    isLoadingRemote = false;
  }
}

// El poll de fondo solo corre mientras la pestana esta visible: se detiene
// en visibilitychange (document.hidden) y se reinicia al volver, para no
// seguir descargando el documento completo cada 30s desde una pestana
// minimizada u olvidada de fondo toda la noche.
function startRemoteRefreshLoop() {
  if (remoteRefreshTimer || document.hidden) return;
  // Ademas del documento, refresca el perfil seguro (/api/me) en cada poll:
  // si un administrador cambia el rol o inactiva a este usuario mientras
  // tiene una sesion abierta, sus permisos efectivos se actualizan en un
  // maximo de 30s, no solo en el proximo login.
  remoteRefreshTimer = window.setInterval(() => {
    refreshRemoteDatabase();
    // updatePrivilegeVisibility() (no updateAuthUi()) a proposito: este poll
    // de fondo no debe cerrar un panel de login/cambio de contraseña que el
    // usuario tenga abierto en ese momento, solo actualizar que secciones
    // ".admin-only"/".accounts-review-only" se ven.
    refreshErpProfile().then(() => updatePrivilegeVisibility());
  }, 30000);
}

function stopRemoteRefreshLoop() {
  if (!remoteRefreshTimer) return;
  window.clearInterval(remoteRefreshTimer);
  remoteRefreshTimer = null;
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
    const { data: row, error } = await supabaseClient
      .from("erp_records")
      .upsert(payload, { onConflict: "table_name,record_key" })
      .select("updated_at")
      .maybeSingle();
    if (error) throw error;
    // Guarda el updated_at que acaba de fijar nuestro propio guardado para
    // que el proximo poll de 30s no se confunda y vuelva a traer el
    // documento completo solo porque nosotros mismos lo cambiamos.
    if (row?.updated_at) lastKnownRemoteUpdatedAt = row.updated_at;
    updateSyncStatus(`Conectado: ${supabaseSession.user.email}`, "online");
  } catch (error) {
    console.error("No se pudo guardar en Supabase.", error);
    updateSyncStatus("Error guardando Supabase", "error");
  } finally {
    remoteSaveInFlight = false;
  }
}

// Registra acciones sensibles en erp_audit_log a traves de la funcion server-side
// de Cloudflare (functions/api/audit-log.js), que revalida quien llama contra su
// JWT en vez de confiar en lo que mande el navegador. Si esa funcion no responde
// (por ejemplo, todavia no se desplego en este entorno), se guarda un respaldo
// persistente dentro del mismo documento (nunca solo en console.log) para no
// perder el rastro de la accion.
async function logAudit(action, { entity = "app", entityId = "", oldData = null, newData = null, note = "", success = true } = {}) {
  const entry = {
    action,
    entity,
    entityId: String(entityId || ""),
    oldData,
    newData,
    note: note ? String(note).slice(0, 500) : "",
    success,
  };
  if (isSupabaseReady()) {
    try {
      const response = await fetch(functionEndpoint("audit-log"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${supabaseSession.access_token}` },
        body: JSON.stringify(entry),
      });
      if (response.ok) return true;
      console.warn("La funcion de auditoria respondio con error, se guarda respaldo local.", await response.text().catch(() => ""));
    } catch (error) {
      console.warn("No se pudo registrar auditoria remota, se guarda respaldo local.", error);
    }
  }
  if (database) {
    database.data.auditLogLocal ||= [];
    database.data.auditLogLocal.push({
      id: uid("AUD", database.data.auditLogLocal),
      ...entry,
      usuario: currentUserEmail(),
      rol: currentRoleKey(),
      fecha: new Date().toISOString(),
    });
    if (database.data.auditLogLocal.length > 500) database.data.auditLogLocal = database.data.auditLogLocal.slice(-500);
    saveState();
  }
  return false;
}

function updateSyncStatus(message, mode = "") {
  const status = byId("sync-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("online", mode === "online");
  status.classList.toggle("error", mode === "error");
}

// Solo alterna la visibilidad de lo que depende de permisos (".admin-only",
// ".accounts-review-only"). A diferencia de updateAuthUi(), NUNCA toca los
// paneles de login/cambio de contraseña: existe para poder refrescar
// privilegios desde el poll de fondo de refreshErpProfile() (cada 30s) sin
// arriesgarse a cerrarle a alguien un formulario de cambio de contraseña
// que tenga abierto voluntariamente en ese momento (updateAuthUi() completo
// sí lo cerraría — ver el bloque "else if (connected)" mas abajo).
function updatePrivilegeVisibility() {
  const canManage = canManageInvoices();
  document.querySelectorAll(".admin-only").forEach((item) => item.classList.toggle("hidden", !canManage));
  document.querySelectorAll(".accounts-review-only").forEach((item) => item.classList.toggle("hidden", !canReviewAccountsUser()));
}

function updateAuthUi() {
  const connected = isSupabaseReady();
  const passwordChangeRequired = connected && isPasswordResetRequired();
  document.body.classList.toggle("auth-required", !connected);
  document.body.classList.toggle("password-change-required", passwordChangeRequired);
  updatePrivilegeVisibility();
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
  if (!database.data.auditLogLocal) database.data.auditLogLocal = [];
  if (!database.data.cierreIntentos) database.data.cierreIntentos = [];
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
  // Un egreso Revertido (ver revertPayrollPayment) ya no debe restar del
  // disponible: es la unica forma segura de deshacer una salida de dinero
  // sin borrar el registro historico ni inventar un ingreso nuevo. Todo
  // egreso existente antes de esta politica sigue en estado "Registrado" (el
  // unico valor que se usaba hasta ahora), asi que este filtro no cambia el
  // saldo de ninguna cuenta historica.
  const expenses = dbTable("egresos").reduce((sum, row) => {
    const matchesAccount = idsMatch(row.cuentaOrigenID) || namesMatch(row.cuentaOrigen);
    return matchesAccount && normalize(row.estado || "Registrado") !== "revertido" ? sum + (Number(row.monto) || 0) : sum;
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

function activeStaffNames() {
  return dbTable("colaboradores")
    .filter((staff) => normalize(staff.estado || "Activo") === "activo")
    .map((staff) => staff.nombreCompleto)
    .filter(Boolean);
}

function accountForPayment(method) {
  const normalized = normalizePayment(method);
  const accounts = dbTable("cuentas");
  if (normalized === "efectivo") return cashRegisterAccount() || cashAccounts()[0] || accounts[0] || {};
  return bankAccounts()[0] || accounts[0] || {};
}

function accountForPaymentLine(method, accountName = "") {
  const normalized = normalizePayment(method);
  if (normalized === "efectivo") return accountForPayment("efectivo");
  if (normalized.includes("transferencia")) return findBankAccountByName(accountName) || {};
  if (normalized === "tarjeta") return {};
  return findAccountByName(accountName) || accountForPayment(method);
}

function activeAccounts() {
  return dbTable("cuentas").filter((account) => normalize(account.estado || "Activo") === "activo");
}

function isBankAccount(account) {
  if (!account) return false;
  const text = normalize(
    `${account.tipoCuenta || ""} ${account.tipoProducto || ""} ${account.nombreCuenta || ""} ${account.entidad || ""} ${account.numeroCuenta || ""}`,
  );
  if (text.includes("caja") || text.includes("efectivo")) return false;
  return (
    text.includes("banco") ||
    text.includes("bancari") ||
    text.includes("cuenta banco") ||
    text.includes("cuenta bancaria") ||
    text.includes("ahorro") ||
    text.includes("corriente") ||
    text.includes("cta") ||
    text.includes("iban") ||
    text.includes("asociacion") ||
    text.includes("asociación") ||
    text.includes("banreservas") ||
    text.includes("reservas") ||
    text.includes("popular") ||
    text.includes("bhd") ||
    text.includes("scotia") ||
    Boolean(account.numeroCuenta && !String(account.numeroCuenta).toUpperCase().startsWith("CAJA"))
  );
}

function isCashAccount(account) {
  const text = normalize(`${account?.tipoCuenta || ""} ${account?.tipoProducto || ""} ${account?.nombreCuenta || ""}`);
  return text.includes("caja") || text.includes("efectivo");
}

function bankAccounts() {
  const banks = activeAccounts().filter(isBankAccount);
  if (banks.length) return banks;
  return activeAccounts().filter((account) => !isCashAccount(account));
}

function cashAccounts() {
  return activeAccounts().filter(isCashAccount);
}

function cashRegisterAccount() {
  return cashAccounts().find((account) => normalize(account.nombreCuenta).includes("registradora"));
}

// Modelo de cierres: por cada fecha existe como maximo un cierre "register"
// (la caja registradora / punto de venta) y un cierre "treasury" (todas las
// demas cuentas: bancos, caja fuerte, caja chica, otras). registerAccount()
// es siempre la MISMA cuenta unica; treasuryAccountList() es "todo lo demas".
function registerAccount() {
  return cashRegisterAccount() || cashAccounts()[0] || activeAccounts()[0] || null;
}

function treasuryAccountList() {
  const register = registerAccount();
  const registerKey = register ? accountKey(register) : null;
  return activeAccounts().filter((account) => accountKey(account) !== registerKey);
}

function isRegisterAccountName(name) {
  const register = registerAccount();
  if (!name) return false;
  if (register && normalize(name) === normalize(register.nombreCuenta || "")) return true;
  return normalize(name).includes("registradora");
}

function findBankAccountByName(name) {
  const account = findAccountByName(name);
  return isBankAccount(account) ? account : null;
}

function findCashAccountByName(name) {
  const account = findAccountByName(name);
  return isCashAccount(account) ? account : null;
}

function accountKey(account) {
  return account?.cuentaID || normalize(account?.nombreCuenta || "");
}

function recordMatchesAccount(row, account, nameFields = [], idFields = []) {
  const key = accountKey(account);
  const accountName = normalize(account?.nombreCuenta || "");
  if (!key && !accountName) return false;
  return idFields.some((field) => row[field] && row[field] === key) || nameFields.some((field) => accountName && normalize(row[field]) === accountName);
}

function accountActivityForDate(date, account) {
  const income = dbTable("ingresos")
    .filter((row) => dateOnly(row.fechaHora) === date && normalize(row.estado || "Confirmado") === "confirmado")
    .filter((row) => recordMatchesAccount(row, account, ["cuentaDestino"], ["cuentaDestinoID"]))
    .reduce((sum, row) => sum + (Number(row.montoNeto) || Number(row.montoBruto) || 0), 0);
  const expenses = dbTable("egresos")
    .filter((row) => dateOnly(row.fechaHora) === date)
    .filter((row) => recordMatchesAccount(row, account, ["cuentaOrigen"], ["cuentaOrigenID"]))
    // Un egreso "Anulado" o "Revertido" no debe sumar (revertPayrollPayment
    // es el primer flujo que marca un egreso "Revertido", al deshacer el
    // pago de una nomina). Un egreso tipo "transferencia" NUNCA se suma
    // aqui: ese mismo movimiento ya crea su propia fila en la coleccion
    // "transferencias" (ver el submit de #expense-form), que es la que se
    // suma abajo en transferOut. Sumarlo tambien aqui duplicaria la misma
    // salida de efectivo dos veces.
    .filter((row) => !["anulado", "revertido"].includes(normalize(row.estado || "Registrado")))
    .filter((row) => normalize(row.tipoEgreso) !== "transferencia")
    .reduce((sum, row) => sum + (Number(row.monto) || 0), 0);
  const transferIn = dbTable("transferencias")
    .filter((row) => dateOnly(row.fechaHora) === date && normalize(row.estado || "Confirmada") === "confirmada")
    .filter((row) => recordMatchesAccount(row, account, ["cuentaDestino"], ["cuentaDestinoID"]))
    .reduce((sum, row) => sum + (Number(row.monto) || 0), 0);
  const transferOut = dbTable("transferencias")
    .filter((row) => dateOnly(row.fechaHora) === date && normalize(row.estado || "Confirmada") === "confirmada")
    .filter((row) => recordMatchesAccount(row, account, ["cuentaOrigen"], ["cuentaOrigenID"]))
    .reduce((sum, row) => sum + (Number(row.monto) || 0), 0);
  return { income, expenses, transferIn, transferOut, expected: income + transferIn - expenses - transferOut };
}

// Listado detallado (no solo el total) de lo que compone las entradas y
// salidas de una cuenta en una fecha, para el boton "Ver detalle" del
// formulario de cierre.
function accountActivityDetailForDate(date, account) {
  const incomeRows = dbTable("ingresos")
    .filter((row) => dateOnly(row.fechaHora) === date && normalize(row.estado || "Confirmado") === "confirmado")
    .filter((row) => recordMatchesAccount(row, account, ["cuentaDestino"], ["cuentaDestinoID"]))
    .map((row) => ({ label: `${row.tipoIngreso || "Ingreso"} · ${row.metodoPago || ""} · ${row.clienteNombre || ""}`.trim(), amount: Number(row.montoNeto) || Number(row.montoBruto) || 0 }));
  const transferInRows = dbTable("transferencias")
    .filter((row) => dateOnly(row.fechaHora) === date && normalize(row.estado || "Confirmada") === "confirmada")
    .filter((row) => recordMatchesAccount(row, account, ["cuentaDestino"], ["cuentaDestinoID"]))
    .map((row) => ({ label: `Transferencia recibida de ${row.cuentaOrigen || "otra cuenta"}`, amount: Number(row.monto) || 0 }));
  const expenseRows = dbTable("egresos")
    .filter((row) => dateOnly(row.fechaHora) === date)
    .filter((row) => recordMatchesAccount(row, account, ["cuentaOrigen"], ["cuentaOrigenID"]))
    // Mismo criterio que accountActivityForDate(): un egreso tipo
    // "transferencia" ya aparece abajo como transferOutRows (su propia fila
    // en "transferencias"); listarlo tambien aqui duplicaria la fila.
    .filter((row) => normalize(row.estado || "Registrado") !== "anulado")
    .filter((row) => normalize(row.tipoEgreso) !== "transferencia")
    .map((row) => ({ label: `${row.tipoEgreso || "Egreso"} · ${row.concepto || ""}`.trim(), amount: Number(row.monto) || 0 }));
  const transferOutRows = dbTable("transferencias")
    .filter((row) => dateOnly(row.fechaHora) === date && normalize(row.estado || "Confirmada") === "confirmada")
    .filter((row) => recordMatchesAccount(row, account, ["cuentaOrigen"], ["cuentaOrigenID"]))
    .map((row) => ({ label: `Transferencia enviada a ${row.cuentaDestino || "otra cuenta"}`, amount: Number(row.monto) || 0 }));
  return { incomeRows: [...incomeRows, ...transferInRows], expenseRows: [...expenseRows, ...transferOutRows] };
}

function inputSingleOrBlank(input, values) {
  if (!input) return;
  input.value = values.length === 1 ? values[0] : "";
}

function currentUserEmail() {
  return supabaseSession?.user?.email || "local";
}

function currentUserRecord() {
  const email = normalize(currentUserEmail());
  if (!email || email === "local") return null;
  return dbTable("usuarios").find((row) => normalize(row.email || row.correo || row.correoElectronico) === email);
}

// Rol para MOSTRAR en pantalla (encabezados, respaldo local de auditoria,
// etc.). Nunca usar el valor de aqui para autorizar una accion: eso vive en
// erpProfile.permissions, resuelto por el servidor via /api/me
// (refreshErpProfile()). user_metadata.role solo se usa como ultimo
// fallback visual, antes de que /api/me responda por primera vez.
function currentUserRole() {
  if (erpProfile?.role) return erpProfile.role;
  const userRecord = currentUserRecord();
  return userRecord?.rol || userRecord?.role || userRecord?.perfil || supabaseSession?.user?.user_metadata?.role || "";
}

function currentRoleKey() {
  return normalize(currentUserRole());
}

// A partir de aqui, las funciones can*() son las que SI se usan para
// autorizar acciones en la interfaz. Todas dependen de erpProfile (el
// perfil que devolvio /api/me), nunca de user_metadata. Mientras el perfil
// seguro no se haya podido cargar (erpProfileLoaded === false) o si /api/me
// fallo (erpProfile === null), aplican minimo privilegio: false. La unica
// excepcion es cuando no hay Supabase configurado en absoluto (modo local
// sin autenticacion), que mantiene el comportamiento previo de la app.
function canManageInvoices() {
  if (!supabaseClient || !supabaseSession) return true;
  if (!erpProfileLoaded || !erpProfile) return false;
  return Boolean(erpProfile.isActive && erpProfile.permissions?.canManageInvoices);
}

function canConfirmClosings() {
  if (!supabaseClient || !supabaseSession) return true;
  if (!erpProfileLoaded || !erpProfile) return false;
  return Boolean(
    erpProfile.isActive && (erpProfile.permissions?.canConfirmRegisterClosings || erpProfile.permissions?.canConfirmTreasuryClosings),
  );
}

// Reabrir un cierre YA confirmado (permite editar facturas/transacciones de
// ese dia) es mas sensible que solo "administrar" cierres/facturas: existe
// una columna de permiso dedicada (can_reopen_closings) desde la migracion
// de erp_user_profiles, pensada exactamente para poder dar canManageInvoices
// a alguien sin darle la capacidad de reabrir cierres historicos ya
// confirmados. Antes esta funcion no existia y openClosingForEdit() usaba
// canManageInvoices() en su lugar, dejando esa columna sin ningun efecto.
function canReopenClosings() {
  if (!supabaseClient || !supabaseSession) return true;
  if (!erpProfileLoaded || !erpProfile) return false;
  return Boolean(erpProfile.isActive && erpProfile.permissions?.canReopenClosings);
}

// Acceso de solo lectura al modulo de Cuentas: el permiso efectivo
// (canReviewAccounts) ya viene resuelto por el servidor combinando rol +
// flag explicito de Usuarios, asi que aqui no hace falta re-derivarlo.
// Nunca habilita escritura: confirmar tesoreria, reabrir cierres, borrar
// movimientos, etc. siguen exigiendo canManageInvoices()/canConfirmClosings()
// por separado, en cada funcion de negocio, no solo aqui.
function canReviewAccountsUser() {
  if (!supabaseClient || !supabaseSession) return true;
  if (!erpProfileLoaded || !erpProfile) return false;
  return Boolean(erpProfile.isActive && erpProfile.permissions?.canReviewAccounts);
}

function closingBusinessDate(closing) {
  return closing?.businessDate || dateOnly(closing?.fechaHoraCierre);
}

function closingForDateAndAccount(date, account) {
  return dbTable("cierres")
    .filter((closing) => dateOnly(closing.fechaHoraCierre) === date)
    .find((closing) => recordMatchesAccount(closing, account, ["cuentaCaja"], ["cuentaID"]));
}

// Unica fuente confiable del "monto inicial" (fondo de caja) de un cierre de
// caja registradora. NUNCA debe leerse de un input del formulario: el fondo
// de caja de un dia es lo que quedo contado y CONFIRMADO el dia anterior
// para esa misma cuenta (un cierre pendiente/provisional no cuenta, ver el
// filtro isClosingPendingConfirmation de abajo). Si no hay ningun cierre
// confirmado previo (primera vez que se cierra esa cuenta), se usa el
// balance de apertura configurado en Base de datos > Cuentas
// (cuentas.balanceInicial); si tampoco existe, el resultado es 0 (regla
// existente, ahora documentada explicitamente en
// DalfiClosingMath.resolveRegisterOpeningCash).
function defaultInitialCashFor(account, beforeDate) {
  const previous = dbTable("cierres")
    .filter((closing) => dateOnly(closing.fechaHoraCierre) < beforeDate)
    .filter((closing) => recordMatchesAccount(closing, account, ["cuentaCaja"], ["cuentaID"]))
    .filter((closing) => !isClosingPendingConfirmation(closing))
    .sort((a, b) => String(b.fechaHoraCierre || "").localeCompare(String(a.fechaHoraCierre || "")))[0];
  return DalfiClosingMath.resolveRegisterOpeningCash({ previousClosing: previous, accountOpeningBalance: account?.balanceInicial });
}

// Cierre de caja registradora de una fecha (a lo sumo uno). Se usa para
// decidir si las facturas/ingresos de ese dia se pueden editar: la caja
// registradora es la unica que bloquea facturacion al confirmarse.
function registerClosingForDate(date) {
  return dbTable("cierres")
    .filter((closing) => !closing.needsReview && closingBusinessDate(closing) === date)
    .filter((closing) => closing.closingType === "register" || (!closing.closingType && isRegisterAccountName(closing.cuentaCaja)))
    .sort((a, b) => {
      const pendingDiff = Number(isClosingPendingConfirmation(a)) - Number(isClosingPendingConfirmation(b));
      if (pendingDiff) return pendingDiff;
      return String(b.fechaActualizacion || b.fechaHoraCierre).localeCompare(String(a.fechaActualizacion || a.fechaHoraCierre));
    })[0];
}

// Cierre consolidado de tesoreria de una fecha (a lo sumo uno).
function treasuryClosingForDate(date) {
  return dbTable("cierres")
    .filter((closing) => !closing.needsReview && closingBusinessDate(closing) === date)
    .filter((closing) => closing.closingType === "treasury" || (!closing.closingType && !isRegisterAccountName(closing.cuentaCaja)))
    .sort((a, b) => {
      const pendingDiff = Number(isClosingPendingConfirmation(a)) - Number(isClosingPendingConfirmation(b));
      if (pendingDiff) return pendingDiff;
      return String(b.fechaActualizacion || b.fechaHoraCierre).localeCompare(String(a.fechaActualizacion || a.fechaHoraCierre));
    })[0];
}

// closingForDate se usa unicamente para decidir si una factura/ingreso de esa
// fecha se puede editar, y esa regla siempre depende del cierre de caja
// registradora (nunca del consolidado de tesoreria).
function closingForDate(date) {
  return registerClosingForDate(date);
}

function isClosingOpenForEdits(closing) {
  return DalfiClosingMath.isClosingOpenForEdits(closing);
}

function isClosingPendingConfirmation(closing) {
  return DalfiClosingMath.isClosingPendingConfirmation(closing);
}

function invoiceOperationalDate(invoiceId) {
  const invoice = dbTable("facturas").find((item) => item.facturaID === invoiceId);
  return dateOnly(invoice?.fechaOperacion || invoice?.fechaHora);
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

function addConfirmedPayment(invoiceId, clientRecord, clientName, amount, method, note = "", processorName = "", accountName = "", cashDate = "", cxcId = "") {
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
    cxCID: cxcId,
    montoAplicado: amount,
    observaciones: cxcId ? "Aplicado a cuenta por cobrar" : "Aplicado a factura",
  }));
  state.payments.push({ id: paymentId, date: effectiveDate, invoiceId, client: clientName, amount: net, method: normalizePayment(method) });
  return paymentId;
}

function addReceivable(invoiceId, clientRecord, clientName, amount, concept, accountName = "", originDate = today, extra = {}) {
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
    ...extra,
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

// recordAsIncome=false es para "balance a favor" (credito interno del
// cliente, no dinero nuevo): consume CxC anteriores igual que cualquier otro
// medio confirmado, pero SIN crear un pagosFactura/ingreso nuevo (esa plata
// ya se conto como ingreso una vez, cuando se genero el balance a favor por
// un sobrepago anterior — volver a llamar addConfirmedPayment aqui
// duplicaria caja/banco con dinero que nunca volvio a entrar fisicamente).
function applyClientReceivablesFirst(clientRecord, clientName, amount, method, note = "Registro de ingreso aplicado a CxC", processorName = "", accountName = "", cashDate = "", { recordAsIncome = true } = {}) {
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
    stampRecord(cxc, "updated");
    // El pagoID real (cuando hay uno) identifica esta aplicacion de forma
    // unica; cxc.cxCID por si solo NO alcanza como "source" de idempotencia
    // porque la MISMA CxC puede recibir varios pagos distintos a lo largo
    // del tiempo. balanceApplicationCounter cubre el camino sin
    // addConfirmedPayment (balance a favor, que no genera pagoID).
    const paymentId = recordAsIncome ? addConfirmedPayment(cxc.facturaID || "", clientRecord, clientName, applied, method, note, processorName, accountName, cashDate) : `balance-${++balanceApplicationCounter}`;
    // Si la CxC anterior saldada era "Propina pendiente" de OTRA factura, el
    // dinero que llega hasta ahi tambien cuenta como propina cobrada de
    // ESA factura vieja: la propina se cobra de ultimo dentro de cada
    // factura, pero entre facturas distintas la prioridad sigue siendo
    // "CxC anteriores primero", y una CxC de propina pendiente es una CxC
    // anterior como cualquier otra.
    if (cxc.esPropinaPendiente) {
      const olderInvoice = dbTable("facturas").find((row) => row.facturaID === cxc.facturaID);
      if (olderInvoice) collectInvoiceTip(olderInvoice, applied, { source: `${cxc.cxCID || ""}:${paymentId}` });
    }
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

function safeRender(name, renderFn) {
  try {
    renderFn();
  } catch (error) {
    console.error(`Error renderizando ${name}`, error);
    const activeView = document.querySelector(".view.active");
    if (activeView && String(name).toLowerCase().includes("cierres")) {
      activeView.innerHTML = `
        <section class="panel">
          <div class="panel-head">
            <h3>No se pudo cargar ${escapeHtml(name)}</h3>
          </div>
          <p class="form-message error">${escapeHtml(error?.message || String(error))}</p>
        </section>
      `;
    }
  }
}

function ensureViewShell(viewId) {
  let view = byId(viewId);
  if (view) return view;
  const host = document.querySelector(".main") || document.querySelector("main") || document.body;
  if (!host) return null;
  view = document.createElement("section");
  view.id = viewId;
  view.className = "view";
  host.appendChild(view);
  return view;
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

// Las reservas antiguas no tienen un campo de estado explicito. Para no
// romperlas, se infiere: si ya tienen una factura asociada se consideran
// completadas; si no, programadas. Las reservas nuevas siempre guardan su
// propio estado explicitamente.
function reservationStatus(record) {
  if (!record) return "Programada";
  const explicit = record.status || record.estado;
  if (explicit) return explicit;
  return record.invoiceId || record.facturaID ? "Completada" : "Programada";
}

function resetReservationEditState(form = byId("reservation-form")) {
  if (!form) return;
  const editField = byId("reservation-edit-id");
  if (editField) editField.value = "";
  const title = form.querySelector(".panel-head h3");
  if (title) title.textContent = "Nueva reserva";
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton) submitButton.textContent = "Guardar reserva";
  const statusField = byId("reservation-status");
  if (statusField) statusField.value = "Programada";
}

function startReservationEdit(reservationId) {
  const { record } = reservationRecordById(reservationId);
  const form = byId("reservation-form");
  if (!record || !form) return;
  byId("reservation-edit-id").value = reservationId;
  form.dataset.clientId = record.clientId || record.clienteID || "";
  byId("reservation-client-search").value = record.client || record.clienteNombre || "";
  byId("reservation-client-phone").value = record.phone || record.telefono || "";
  byId("reservation-client-email").value = record.email || record.correo || "";
  byId("reservation-source").value = record.source || record.canalOrigen || "Presencial";
  byId("reservation-service-search").value = record.service || record.servicio || "";
  byId("reservation-date").value = record.date || record.fecha || today;
  byId("reservation-time").value = record.time || record.hora || "";
  byId("reservation-staff").value = record.staff || record.colaboradorNombre || "";
  byId("reservation-status").value = reservationStatus(record);
  byId("reservation-note").value = record.note || record.observaciones || "";
  const title = form.querySelector(".panel-head h3");
  if (title) title.textContent = "Editar reserva";
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton) submitButton.textContent = "Guardar cambios";
  const message = byId("reservation-form-message");
  if (message) {
    message.textContent = "";
    message.className = "form-message";
  }
  revealFormAtTop(form, { focusSelector: "#reservation-client-search" });
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
  const register = cashRegisterAccount() || cashAccounts()[0] || activeAccounts().find((account) => normalize(account.tipo).includes("caja"));
  if (!register) return 0;
  return accountActivityForDate(date, register).expected;
}

function dailyIncomeSummary(date) {
  const income = dbTable("ingresos").filter((row) => dateOnly(row.fechaHora) === date && normalize(row.estado || "Confirmado") === "confirmado");
  const receivables = dbTable("cuentasCobrar").filter((row) => dateOnly(row.fechaOrigen) === date && Number(row.balancePendiente) > 0);
  const byMethod = income.reduce(
    (summary, row) => {
      const rawMethod = normalize(row.metodoPago);
      const method = normalizePayment(row.metodoPago);
      if (rawMethod === "efectivo") summary.cash += Number(row.montoNeto) || 0;
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

function clientReceivablePaymentsOn(date) {
  return dbTable("ingresoAplicaciones")
    .map((application) => {
      if (!application.cxCID) return null;
      const income = dbTable("ingresos").find((row) => row.ingresoID === application.ingresoID);
      const cxc = dbTable("cuentasCobrar").find((row) => row.cxCID === application.cxCID);
      if (!income || !cxc) return null;
      if (dateOnly(income.fechaHora) !== date) return null;
      if (normalize(income.estado || "Confirmado") !== "confirmado") return null;
      if (normalize(cxc.deudorTipo || "Cliente") !== "cliente") return null;
      if (normalize(cxc.concepto || "").includes("procesador")) return null;
      return {
        client: income.clienteNombre || cxc.deudorNombre || "Cliente",
        amount: Number(application.montoAplicado) || 0,
        invoiceId: application.facturaID || cxc.facturaID || cxc.cxCID,
        method: income.metodoPago || "",
      };
    })
    .filter(Boolean);
}

function confirmedIncomeOn(date) {
  return dbTable("ingresos").filter((row) => dateOnly(row.fechaHora) === date && normalize(row.estado || "Confirmado") === "confirmado");
}

function automaticClosingEligible(date) {
  // Antes esto usaba new Date().getHours() en la hora local del dispositivo,
  // no en America/Santo_Domingo, por lo que el corte del "ultimo minuto del
  // dia" ocurria a una hora distinta segun donde estuviera cada navegador.
  const { hour, minute } = DalfiClosingMath.nowPartsInZone(new Date(), "America/Santo_Domingo");
  return DalfiClosingMath.isAutomaticClosingEligible({ date, today, hour, minute });
}

function removePrematureProvisionalClosings() {
  const rows = dbTable("cierres");
  const kept = rows.filter((closing) => {
    const closingDate = dateOnly(closing.fechaHoraCierre);
    const provisional = closing.provisional || normalize(closing.cajero).includes("cierre provisional automatico");
    return !(provisional && isClosingPendingConfirmation(closing) && !automaticClosingEligible(closingDate));
  });
  const removed = rows.length - kept.length;
  if (removed) database.data.cierres = kept;
  return removed;
}

// Cierres antiguos (de antes de este modelo) pueden no tener closingType.
// Esta funcion les asigna uno sin perder informacion: si el nombre de cuenta
// coincide con la caja registradora se marca "register", si no "treasury".
// Si esa fecha ya tiene otro cierre normalizado del mismo tipo, el registro
// se conserva integro pero se marca needsReview en vez de fusionarlo o
// sobreescribir el existente.
function normalizeLegacyClosings() {
  const rows = dbTable("cierres");
  const legacyRows = rows.filter((closing) => !closing.closingType);
  if (!legacyRows.length) return 0;
  const sorted = legacyRows
    .slice()
    .sort((a, b) => String(a.fechaCreacion || a.fechaHoraCierre || "").localeCompare(String(b.fechaCreacion || b.fechaHoraCierre || "")));
  let normalized = 0;
  sorted.forEach((closing) => {
    const businessDate = closingBusinessDate(closing);
    const result = DalfiClosingMath.normalizeLegacyClosingType(closing, {
      isRegisterAccountName,
      occupiedTypesForDate: (type) => rows.some((other) => other !== closing && other.closingType === type && closingBusinessDate(other) === businessDate),
    });
    closing.closingType = result.closingType;
    closing.businessDate = businessDate;
    if (result.needsReview) closing.needsReview = true;
    stampRecord(closing, "updated");
    normalized += 1;
  });
  return normalized;
}

// El saldo inicial de una cuenta de tesoreria en un dia es el saldo real que
// quedo confirmado el dia anterior para esa misma cuenta dentro del cierre
// consolidado. Si nunca se ha confirmado uno, arranca en 0.
// Unica fuente confiable del saldo inicial de UNA cuenta dentro de un
// cierre de tesoreria (banco, caja fuerte, caja chica, etc.). Busca el
// cierre de tesoreria mas reciente, CONFIRMADO (nunca pendiente/provisional
// ni needsReview), anterior a la fecha, que incluya un detalle para esta
// MISMA cuenta (por cuentaID o nombre — nunca mezcla el saldo de una cuenta
// con el de otra), y delega en DalfiClosingMath.resolveTreasuryOpeningBalance
// la decision final: saldo confirmado anterior, o balance de apertura
// configurado de la cuenta si no hay cierre anterior, o 0 si tampoco hay
// balance de apertura.
function previousTreasurySaldoFor(account, beforeDate) {
  const key = accountKey(account);
  const previous = dbTable("cierres")
    .filter((closing) => closing.closingType === "treasury" && !closing.needsReview)
    .filter((closing) => closingBusinessDate(closing) < beforeDate)
    .filter((closing) => !isClosingPendingConfirmation(closing))
    .sort((a, b) => String(b.businessDate || "").localeCompare(String(a.businessDate || "")))[0];
  const row = previous?.cuentas?.find((item) => accountKey({ cuentaID: item.cuentaID, nombreCuenta: item.nombreCuenta }) === key);
  return DalfiClosingMath.resolveTreasuryOpeningBalance({ previousConfirmedClosing: row, accountOpeningBalance: account?.balanceInicial });
}

function buildTreasuryAccountDetail(date, account) {
  const activity = accountActivityForDate(date, account);
  const saldoInicial = previousTreasurySaldoFor(account, date);
  const saldoEsperado = saldoInicial + activity.income + activity.transferIn - activity.expenses - activity.transferOut;
  return {
    cuentaID: account.cuentaID || "",
    nombreCuenta: account.nombreCuenta || "",
    tipoCuenta: account.tipoCuenta || (isBankAccount(account) ? "Banco" : "Custodia"),
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
  return DalfiClosingMath.buildTreasuryTotals(cuentas);
}

// Genera, por cada fecha vencida sin cierre, EXACTAMENTE los cierres que
// falten: uno "register" (caja registradora) y uno "treasury" (consolidado
// de tesoreria). Nunca crea mas de dos por dia ni uno por cada cuenta.
// Idempotente: si ya existen, no hace nada para esa fecha/tipo.
function ensureProvisionalClosings() {
  const removed = removePrematureProvisionalClosings();
  const normalized = normalizeLegacyClosings();
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
      if (automaticClosingEligible(date)) dates.add(date);
    });
  });
  dbTable("cierres").forEach((closing) => {
    const date = closingBusinessDate(closing);
    if (date) dates.add(date);
  });
  const sortedDates = [...dates].filter(Boolean).sort();
  const eligibleEnd = automaticClosingEligible(today) ? today : datePlusDaysFrom(today, -1);
  const startDate = sortedDates[0] || eligibleEnd;
  let cursor = startDate;
  let guard = 0;
  while (cursor && eligibleEnd && cursor <= eligibleEnd && guard < 370) {
    if (automaticClosingEligible(cursor)) dates.add(cursor);
    cursor = datePlusDaysFrom(cursor, 1);
    guard += 1;
  }
  let created = 0;
  const register = registerAccount();
  const treasuryList = treasuryAccountList();
  [...dates].sort().forEach((date) => {
    if (!automaticClosingEligible(date)) return;
    const summary = dailyIncomeSummary(date);
    if (register?.nombreCuenta && !registerClosingForDate(date)) {
      const activity = accountActivityForDate(date, register);
      const montoInicial = defaultInitialCashFor(register, date);
      const expected = DalfiClosingMath.computeExpectedCash({
        montoInicial,
        entradasEfectivo: activity.income + activity.transferIn,
        salidasEfectivo: activity.expenses + activity.transferOut,
      });
      dbTable("cierres").push(stampRecord({
        cierreID: nextDbId("cierres", "cierreID", "CIE"),
        closingType: "register",
        businessDate: date,
        fechaHoraCierre: `${date}T23:59:00`,
        cajero: "Cierre provisional automático",
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
        detalleColaboradores: closingCollaboratorSummary(date),
        estado: "Pendiente de confirmacion",
        requiereConfirmacion: true,
        provisional: true,
        observaciones: "Generado automaticamente porque el dia quedo pendiente de cierre.",
      }));
      created += 1;
    }
    if (!treasuryClosingForDate(date)) {
      const cuentas = treasuryList.map((account) => buildTreasuryAccountDetail(date, account));
      dbTable("cierres").push(stampRecord({
        cierreID: nextDbId("cierres", "cierreID", "CIE"),
        closingType: "treasury",
        businessDate: date,
        fechaHoraCierre: `${date}T23:59:00`,
        registerClosingID: registerClosingForDate(date)?.cierreID || "",
        cuentas,
        totales: buildTreasuryTotals(cuentas),
        estado: "Pendiente de confirmacion",
        requiereConfirmacion: true,
        provisional: true,
        observaciones: "Generado automaticamente porque el dia quedo pendiente de cierre.",
      }));
      created += 1;
    }
  });
  return created + removed + normalized;
}

// Los cierres sin confirmar guardan una fotografia de los totales del dia en
// el momento en que se crearon. Si despues se edita o registra una factura,
// egreso o transferencia de ese mismo dia, esa fotografia queda desactualizada.
// Esta funcion refresca el register y el treasury de ese dia si siguen
// pendientes; los cierres ya confirmados quedan congelados y no se tocan.
// Los valores manuales ya anotados en el detalle de tesoreria (ajustes,
// observaciones, saldo real) se conservan al recalcular.
function refreshPendingClosingsForDate(date) {
  if (!date) return 0;
  let refreshed = 0;
  const register = registerClosingForDate(date);
  if (register && isClosingPendingConfirmation(register)) {
    const account = findAccountByName(register.cuentaCaja) || registerAccount();
    const activity = accountActivityForDate(date, account);
    const summary = dailyIncomeSummary(date);
    const montoInicial = Number(register.balanceInicial) || 0;
    const expected = DalfiClosingMath.computeExpectedCash({
      montoInicial,
      entradasEfectivo: activity.income + activity.transferIn,
      salidasEfectivo: activity.expenses + activity.transferOut,
    });
    register.ingresosConfirmados = activity.income + activity.transferIn;
    register.egresos = activity.expenses + activity.transferOut;
    register.balanceTeorico = expected;
    register.tarjetaEsperada = summary.card;
    register.transferenciaEsperada = summary.transfer;
    register.creditoGenerado = summary.credit;
    register.detalleColaboradores = closingCollaboratorSummary(date);
    stampRecord(register, "updated");
    refreshed += 1;
  }
  const treasury = treasuryClosingForDate(date);
  if (treasury && isClosingPendingConfirmation(treasury)) {
    const cuentas = (treasury.cuentas || []).map((row) => {
      const account = findAccountByName(row.nombreCuenta) || { cuentaID: row.cuentaID, nombreCuenta: row.nombreCuenta };
      const fresh = buildTreasuryAccountDetail(date, account);
      return { ...fresh, ajustes: Number(row.ajustes) || 0, observaciones: row.observaciones || "", saldoReal: row.saldoReal ?? fresh.saldoReal };
    });
    treasury.cuentas = cuentas;
    treasury.totales = buildTreasuryTotals(cuentas);
    stampRecord(treasury, "updated");
    refreshed += 1;
  }
  return refreshed;
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

function renderCashActivityDetailList(target, rows) {
  if (!target) return;
  if (!rows.length) {
    target.innerHTML = `<p class="empty">Sin movimientos.</p>`;
    return;
  }
  target.innerHTML = rows
    .map((row) => `<div class="summary-row"><span>${escapeHtml(row.label || "-")}</span><strong>${money.format(row.amount)}</strong></div>`)
    .join("");
}

function updateCashBalancePreview() {
  const countedRaw = byId("cash-counted").value;
  const panel = byId("cash-balance-panel");
  if (countedRaw === "") {
    resetCashBalancePreview();
    return;
  }
  const date = byId("cash-date").value || today;
  const account = findAccountByName(byId("cash-account").value) || accountForPayment("efectivo");
  const activity = accountActivityForDate(date, account);
  // Fuente confiable, nunca el valor mostrado en el <output> (que es de solo
  // lectura y solo refleja este mismo calculo): ver defaultInitialCashFor().
  const montoInicial = defaultInitialCashFor(account, date);
  if (byId("cash-initial")) byId("cash-initial").textContent = money.format(montoInicial);
  const entradasEfectivo = activity.income + activity.transferIn;
  const salidasEfectivo = activity.expenses + activity.transferOut;
  // "Egresos del dia" tambien es siempre calculado (accountActivityForDate),
  // nunca leido de un input: se refleja aqui mismo en el elemento de solo
  // lectura, igual que "Monto inicial".
  if (byId("cash-expenses")) byId("cash-expenses").textContent = money.format(salidasEfectivo);
  const expected = DalfiClosingMath.computeExpectedCash({ montoInicial, entradasEfectivo, salidasEfectivo });
  const counted = Number(countedRaw) || 0;
  const { difference, shortage, surplus } = DalfiClosingMath.computeDifference(counted, expected);
  cashBalanceDraft = { date, account: account.nombreCuenta || "", montoInicial, expected, counted, expenses: salidasEfectivo, difference, shortage, surplus, generatedAt: new Date().toISOString() };

  byId("cash-initial-preview").textContent = money.format(montoInicial);
  byId("cash-income-preview").textContent = money.format(entradasEfectivo);
  byId("cash-expenses-preview").textContent = money.format(salidasEfectivo);
  byId("cash-expected-preview").textContent = money.format(expected);
  byId("cash-difference-preview").textContent = money.format(difference);
  byId("cash-shortage-preview").textContent = money.format(shortage);
  byId("cash-surplus-preview").textContent = money.format(surplus);
  byId("cash-user-preview").textContent = currentUserEmail();
  const editingClosing = dbTable("cierres").find((row) => row.cierreID === byId("cash-edit-id").value);
  byId("cash-confirmed-at-preview").textContent = editingClosing?.fechaConfirmacion ? new Date(editingClosing.fechaConfirmacion).toLocaleString("es-DO") : "Sin confirmar";

  const detail = accountActivityDetailForDate(date, account);
  renderCashActivityDetailList(byId("cash-income-detail"), detail.incomeRows);
  renderCashActivityDetailList(byId("cash-expense-detail"), detail.expenseRows);

  panel.classList.remove("hidden");
  byId("cash-shortage-label").classList.toggle("hidden", shortage <= 0);
  if (shortage > 0) byId("cash-rectified-counted").value = "";
}

function resetCashBalancePreview() {
  cashBalanceDraft = null;
  byId("cash-balance-panel")?.classList.add("hidden");
  byId("cash-shortage-label")?.classList.add("hidden");
  byId("cash-income-detail")?.classList.add("hidden");
  byId("cash-expense-detail")?.classList.add("hidden");
  if (byId("cash-shortage-note")) byId("cash-shortage-note").value = "";
  if (byId("cash-rectified-counted")) byId("cash-rectified-counted").value = "";
}

// Aggregation en si (sumas, deduplicado de facturas, total desglosado) vive
// en DalfiClosingMath.summarizeCollaborators para poder probarla con
// node:test; aqui solo se arman las filas de entrada a partir de la base de
// datos del navegador.
function closingCollaboratorSummary(date) {
  if (!date) return [];
  const detailRows = dbTable("facturaDetalle")
    .filter((detail) => {
      const invoice = dbTable("facturas").find((row) => row.facturaID === detail.facturaID);
      return invoice && dateOnly(invoice.fechaHora) === date && normalize(invoice.estado) !== "anulada";
    })
    .map((detail) => ({
      collaboratorId: detail.colaboradorID,
      collaboratorName: detail.colaboradorNombre,
      invoiceId: detail.facturaID,
      billing: Number(detail.subtotalAntesDescuentoGeneral ?? detail.subtotal) || 0,
      commissionable: Number(detail.montoComisionable ?? detail.subtotal) || 0,
      extra: Number(detail.extraMonto) || 0,
      discount: (Number(detail.deduccionMonto) || 0) + (Number(detail.deduccionGeneralMonto) || 0),
    }));
  const tipRows = dbTable("propinas")
    .filter((tip) => dateOnly(tip.fechaHora) === date)
    .map((tip) => ({
      collaboratorId: tip.colaboradorID,
      collaboratorName: tip.colaboradorNombre,
      amount: Number(tip.montoNetoPagar ?? tip.montoBruto ?? tip.monto) || 0,
    }));
  return DalfiClosingMath.summarizeCollaborators(detailRows, tipRows);
}

function updateClosingCollaboratorDetails(date) {
  const target = byId("cash-collaborator-detail");
  if (!target) return;
  const rows = closingCollaboratorSummary(date);
  target.classList.remove("hidden");
  if (!date) {
    target.innerHTML = `
      <div class="summary-row">
        <span>Detalle por colaboradora</span>
        <strong>Selecciona una fecha</strong>
      </div>
    `;
    return;
  }
  if (!rows.length) {
    target.innerHTML = `
      <div class="summary-row">
        <span>Detalle por colaboradora</span>
        <strong>Sin servicios o propinas para ${date}</strong>
      </div>
    `;
    return;
  }
  const totalGeneral = DalfiClosingMath.sumCollaboratorTotals(rows);
  target.innerHTML = `
    <div class="summary-row">
      <span>Detalle por colaboradora</span>
      <strong>${date}</strong>
    </div>
    <div class="table-wrap compact-table">
      <table>
        <thead>
          <tr>
            <th>Colaboradora</th>
            <th>Servicios</th>
            <th>Facturado</th>
            <th>Propina</th>
            <th>Total</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row, index) => `
                <tr>
                  <td>${escapeHtml(row.name)}</td>
                  <td>${row.services}</td>
                  <td>${money.format(row.billing)}</td>
                  <td>${money.format(row.tips)}</td>
                  <td>${money.format(row.total)}</td>
                  <td><button class="secondary-btn compact toggle-collaborator-detail" data-index="${index}" type="button">Ver detalle</button></td>
                </tr>
                <tr class="collaborator-detail-row hidden" data-detail-index="${index}">
                  <td colspan="6">
                    <div class="simple-list">
                      <div class="summary-row"><span>Facturas</span><strong>${row.invoiceIds.map(escapeHtml).join(", ") || "-"}</strong></div>
                      <div class="summary-row"><span>Comisionable</span><strong>${money.format(row.commissionable)}</strong></div>
                      <div class="summary-row"><span>Extras</span><strong>${money.format(row.extras)}</strong></div>
                      <div class="summary-row"><span>Descuentos</span><strong>${money.format(row.discounts)}</strong></div>
                    </div>
                  </td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
    <div class="summary-row total">
      <span>Total generado por todas las colaboradoras</span>
      <strong>${money.format(totalGeneral)}</strong>
    </div>
  `;
  target.querySelectorAll(".toggle-collaborator-detail").forEach((button) => {
    button.addEventListener("click", () => {
      const detailRow = target.querySelector(`.collaborator-detail-row[data-detail-index="${button.dataset.index}"]`);
      detailRow?.classList.toggle("hidden");
      button.textContent = detailRow?.classList.contains("hidden") ? "Ver detalle" : "Ocultar";
    });
  });
}

function ensureCashModuleMarkup() {
  const cashView = ensureViewShell("cash");
  if (!cashView) return null;
  if (cashView.querySelector("#cash-table") && cashView.querySelector("#new-cash-closing")) {
    ensureCashViewActionsMarkup();
    bindCashViewActionButtons();
    bindCashTableActions(cashView.querySelector("#cash-table"));
    return cashView;
  }
  cashView.innerHTML = `
    <section class="panel cash-module-head">
      <div class="panel-head">
        <div>
          <h3>Cierres</h3>
          <p class="panel-note">Exactamente dos cierres por día: caja registradora y consolidado de valores y tesorería (bancos, caja fuerte, caja chica y otras cuentas viven dentro del detalle del consolidado).</p>
        </div>
        <div class="panel-actions">
          <button class="secondary-btn compact" id="confirm-previous-closings" type="button">Crear cierres automáticos</button>
          <button class="primary-btn compact" id="new-cash-closing" type="button">Hacer cierre del día</button>
        </div>
      </div>
    </section>

    <div class="work-grid cash-form-grid">
      <form class="panel form-panel hidden" id="cash-form">
        <input id="cash-edit-id" type="hidden" />
        <input id="cash-confirm-after-save" type="hidden" />
        <div class="panel-head">
          <h3>Cierre de caja registradora</h3>
        </div>
        <input id="cash-account" type="hidden" />
        <label>
          Fecha
          <input id="cash-date" type="date" required />
        </label>
        <label>
          Monto real contado en caja
          <input id="cash-counted" type="number" min="0" step="0.01" required />
        </label>
        <div class="form-row">
          <label>
            Monto inicial (fondo de caja) — calculado, no editable
            <output id="cash-initial" class="calculated-value readonly-hint" aria-live="polite">RD$0.00</output>
          </label>
          <label>
            Egresos del día — calculado, no editable
            <output id="cash-expenses" class="calculated-value readonly-hint" aria-live="polite">RD$0.00</output>
          </label>
        </div>
        <button class="secondary-btn" id="cash-add-expense" type="button">Agregar egreso</button>
        <p class="panel-note hidden" id="cash-add-expense-closed-note">Este cierre ya está confirmado: no se pueden agregar egresos desde aquí. Reabre el cierre primero.</p>
        <button class="secondary-btn" id="generate-cash-balance" type="button">Generar cuadre de efectivo</button>
        <section class="invoice-summary hidden" id="cash-balance-panel">
          <div class="summary-row">
            <span>Monto inicial</span>
            <strong id="cash-initial-preview">RD$0.00</strong>
          </div>
          <div class="summary-row">
            <span>Ingresos totales en efectivo</span>
            <strong id="cash-income-preview">RD$0.00</strong>
            <button class="secondary-btn compact" id="toggle-cash-income-detail" type="button">Ver detalle</button>
          </div>
          <div class="simple-list hidden" id="cash-income-detail"></div>
          <div class="summary-row">
            <span>Egresos totales</span>
            <strong id="cash-expenses-preview">RD$0.00</strong>
            <button class="secondary-btn compact" id="toggle-cash-expense-detail" type="button">Ver detalle</button>
          </div>
          <div class="simple-list hidden" id="cash-expense-detail"></div>
          <div class="summary-row">
            <span>Efectivo esperado en caja</span>
            <strong id="cash-expected-preview">RD$0.00</strong>
          </div>
          <div class="summary-row">
            <span>Diferencia</span>
            <strong id="cash-difference-preview">RD$0.00</strong>
          </div>
          <div class="summary-row">
            <span>Cuadre faltante</span>
            <strong id="cash-shortage-preview">RD$0.00</strong>
          </div>
          <div class="summary-row">
            <span>Sobrante de caja</span>
            <strong id="cash-surplus-preview">RD$0.00</strong>
          </div>
          <div class="summary-row">
            <span>Usuario que realiza el cierre</span>
            <strong id="cash-user-preview">-</strong>
          </div>
          <div class="summary-row">
            <span>Fecha y hora de confirmación</span>
            <strong id="cash-confirmed-at-preview">Sin confirmar</strong>
          </div>
        </section>
        <section class="invoice-summary hidden" id="cash-collaborator-detail"></section>
        <label class="hidden" id="cash-shortage-label">
          Motivo del faltante
          <textarea id="cash-shortage-note" rows="3" placeholder="Documentar por qué faltó efectivo en caja"></textarea>
          <span>Monto contado rectificado</span>
          <input id="cash-rectified-counted" type="number" min="0" step="0.01" placeholder="Monto completivo luego de revisar caja" />
        </label>
        <div class="form-row">
          <label>
            Tarjeta cierre/lote
            <input id="cash-card-counted" type="number" min="0" step="0.01" value="0" />
          </label>
          <label>
            Compañía tarjeta
            <input id="cash-card-processor" list="processors-list" placeholder="Azul, CardNet..." />
          </label>
        </div>
        <div class="form-row">
          <label>
            Número de lote
            <input id="cash-card-batch" placeholder="Lote tarjeta" />
          </label>
          <label>
            Transferencias confirmadas
            <input id="cash-transfer-counted" type="number" min="0" step="0.01" value="0" />
          </label>
        </div>
        <label>
          Observación
          <textarea id="cash-note" rows="3"></textarea>
        </label>
        <div class="row-actions hidden" id="cash-view-actions">
          <button class="secondary-btn" id="cash-modify-closing" type="button">Modificar</button>
          <button class="primary-btn" id="cash-confirm-closing" type="button">Confirmar cierre</button>
          <button class="secondary-btn" id="cash-open-closing" type="button">Abrir cierre</button>
        </div>
        <button class="primary-btn" id="cash-submit" type="submit">Guardar cierre</button>
        <button class="secondary-btn" id="cancel-cash-closing" type="button">Cancelar</button>
      </form>
    </div>

    <section class="panel panel-wide cash-list-panel">
      <div class="panel-head">
        <h3>Historial de cierres</h3>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Tipo</th>
              <th>Esperado</th>
              <th>Contado</th>
              <th>Tarjeta</th>
              <th>Gastos</th>
              <th>Faltante</th>
              <th>Sobrante</th>
              <th>Diferencia</th>
              <th>Estado</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody id="cash-table"></tbody>
        </table>
      </div>
    </section>
  `;
  ensureCashViewActionsMarkup();
  bindCashViewActionButtons();
  bindCashTableActions(cashView.querySelector("#cash-table"));
  return cashView;
}

function cashTableTarget() {
  const cashView = ensureCashModuleMarkup() || ensureViewShell("cash");
  return cashView?.querySelector("#cash-table") || byId("cash-table");
}

function ensureCashViewActionsMarkup() {
  const form = byId("cash-form");
  if (!form || byId("cash-view-actions")) return;
  const submitButton = byId("cash-submit");
  if (!submitButton) return;
  const actions = document.createElement("div");
  actions.className = "row-actions hidden";
  actions.id = "cash-view-actions";
  actions.innerHTML = `
    <button class="secondary-btn" id="cash-modify-closing" type="button">Modificar</button>
    <button class="primary-btn" id="cash-confirm-closing" type="button">Confirmar cierre</button>
    <button class="secondary-btn" id="cash-open-closing" type="button">Abrir cierre</button>
  `;
  submitButton.before(actions);
}

function bindCashViewActionButtons() {
  const modifyButton = byId("cash-modify-closing");
  if (modifyButton && !modifyButton.dataset.bound) {
    modifyButton.dataset.bound = "true";
    modifyButton.addEventListener("click", (event) => {
      const closingId = event.currentTarget.dataset.closingId;
      if (closingId) startClosingEdit(closingId);
    });
  }
  const confirmButton = byId("cash-confirm-closing");
  if (confirmButton && !confirmButton.dataset.bound) {
    confirmButton.dataset.bound = "true";
    confirmButton.addEventListener("click", (event) => {
      const closingId = event.currentTarget.dataset.closingId;
      if (closingId) startClosingConfirmation(closingId);
    });
  }
  const openButton = byId("cash-open-closing");
  if (openButton && !openButton.dataset.bound) {
    openButton.dataset.bound = "true";
    openButton.addEventListener("click", (event) => {
      const closingId = event.currentTarget.dataset.closingId;
      if (closingId) openClosingForEdit(closingId);
    });
  }
}

function bindCashTableActions(table = byId("cash-table")) {
  if (!table || table.dataset.bound === "true") return;
  table.dataset.bound = "true";
  table.addEventListener("click", (event) => {
    const openButton = event.target.closest(".open-closing");
    const confirmButton = event.target.closest(".confirm-closing");
    const confirmTreasuryButton = event.target.closest(".confirm-treasury");
    const voidButton = event.target.closest(".void-closing");
    const viewButton = event.target.closest(".view-closing");
    const editButton = event.target.closest(".edit-closing");
    if (viewButton) viewClosingInForm(viewButton.dataset.closingId);
    if (editButton) startClosingEdit(editButton.dataset.closingId);
    if (openButton) openClosingForEdit(openButton.dataset.closingId);
    if (confirmButton) startClosingConfirmation(confirmButton.dataset.closingId);
    if (confirmTreasuryButton) confirmTreasuryRange(confirmTreasuryButton.dataset.closingId);
    if (voidButton) voidClosing(voidButton.dataset.closingId);
  });
}

function renderDatalists() {
  byId("clients-list").innerHTML = uniqueOptions(state.clients.map((client) => client.name));
  const staffNames = activeStaffNames();
  byId("people-list").innerHTML = uniqueOptions([...state.clients.map((client) => client.name), ...staffNames]);
  byId("advance-people-list").innerHTML = uniqueOptions([
    ...staffNames,
    ...dbTable("suplidores").map((supplier) => supplier.nombre || supplier.nombreCompleto || supplier.empresa || supplier.suplidorNombre),
  ]);
  byId("services-list").innerHTML = uniqueOptions(state.services.map((service) => service.name));
  byId("staff-list").innerHTML = uniqueOptions(staffNames);
  byId("accounts-list").innerHTML = uniqueOptions(activeAccounts().map((account) => account.nombreCuenta));
  byId("cash-accounts-list").innerHTML = uniqueOptions(cashAccounts().map((account) => account.nombreCuenta));
  byId("bank-accounts-list").innerHTML = uniqueOptions(bankAccounts().map((account) => account.nombreCuenta));
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

// Helper centralizado y reutilizable: cada vez que una accion de un listado
// (Nuevo/Editar/Ver/Confirmar/Reabrir/Hacer cierre...) abre un formulario, se
// debe mostrar arriba de la vista, hacer scroll suave hasta su inicio y poner
// el foco en su primer campo editable. Antes cada flujo repetia su propio
// scrollIntoView de forma inconsistente; ahora todos pasan por aqui.
function revealFormAtTop(form, { focusSelector = "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])", delayMs = 260 } = {}) {
  if (!form) return;
  form.classList.remove("hidden");
  form.scrollIntoView({ block: "start", behavior: "smooth" });
  if (focusSelector === null) return; // se pide explicitamente no enfocar (p.ej. vista de solo lectura)
  const focusTarget = focusSelector.startsWith("#") ? byId(focusSelector.slice(1)) : form.querySelector(focusSelector);
  if (!focusTarget) return;
  // Se espera a que el scroll suave termine para no "robar" el foco a mitad
  // de la animacion, lo que en movil hace que el teclado salte de golpe.
  window.setTimeout(() => focusTarget.focus(), delayMs);
}

function renderDashboard() {
  const todayInvoices = state.invoices.filter((invoice) => invoice.date === today);
  const todayPayments = clientReceivablePaymentsOn(today);
  const todayIncome = confirmedIncomeOn(today);
  const todayReservations = state.reservations.filter((reservation) => reservation.date === today).sort((a, b) => a.time.localeCompare(b.time));

  const invoiced = todayInvoices.reduce((sum, invoice) => sum + invoice.total, 0);
  const collectedAr = todayPayments.reduce((sum, payment) => sum + payment.amount, 0);
  const totalIncome = todayIncome.reduce((sum, income) => sum + (Number(income.montoNeto) || Number(income.montoBruto) || 0), 0);

  byId("metric-invoices").textContent = money.format(invoiced);
  byId("metric-ar").textContent = money.format(collectedAr);
  byId("metric-income").textContent = money.format(totalIncome);
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

// Todas las cuentasCobrar del CLIENTE (nunca del procesador de tarjeta, ni
// de nomina) todavia con saldo, sin importar a que factura pertenezcan:
// puede haber CxC de base y de "Propina pendiente factura X" mezcladas de
// varias facturas (ver la politica "la propina se cobra de ultimo").
// Reutiliza clientReceivablesFor() pasandole un objeto sintetico (nunca
// duplica el filtro): al no traer cxCID, el desempate "CxC seleccionada
// primero" de esa funcion no se activa, y el orden queda en FIFO puro por
// fechaOrigen (que allocateClientPaymentFIFO vuelve a ordenar de forma mas
// precisa de todas formas, asi que este orden aqui es solo informativo).
function clientAllReceivables(clientRecord) {
  if (!clientRecord?.clienteID) return [];
  return clientReceivablesFor({ deudorID: clientRecord.clienteID, deudorNombre: clientRecord.nombreCompleto || "" });
}

// Busca un cliente por nombre, telefono o identificador (en ese orden de
// coincidencia exacta, luego por coincidencia parcial de nombre/telefono).
function findClientBySearchTerm(term) {
  const raw = String(term || "").trim();
  if (!raw) return null;
  const query = normalize(raw);
  const clients = dbTable("clientes");
  return (
    clients.find((client) => normalize(client.nombreCompleto || "") === query) ||
    clients.find((client) => normalize(client.telefono || "") === query) ||
    clients.find((client) => client.clienteID === raw) ||
    clients.find((client) => normalize(client.nombreCompleto || "").includes(query)) ||
    clients.find((client) => normalize(client.telefono || "").includes(query)) ||
    null
  );
}

// Estado temporal (solo en memoria, nunca persistido) mientras el usuario
// esta en el formulario de "Registrar cobro" porque llego desde el boton
// general "Registrar cobro de cliente" de Facturacion. Simetrico a
// cashPendingExpenseReturn/openAddExpenseFromClosing en el modulo Cierres.
// Ya NO depende de una factura especifica (ver correccion de f548985: el
// flujo definitivo es un cobro general por cliente, aplicado FIFO a TODAS
// sus cuentas por cobrar, nunca atado a abrir primero una factura).
let clientPendingReceiptReturn = null;

function openClientReceiptFromBilling() {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede registrar cobros de cuentas por cobrar.");
    return;
  }
  clientPendingReceiptReturn = {
    originView: "billing",
    search: byId("invoice-search")?.value || "",
    scrollY: window.scrollY || 0,
  };
  switchToView("receivables");
  byId("payment-client-search").value = "";
  updatePaymentSummary();
  byId("payment-receipt-cancel")?.classList.remove("hidden");
  revealFormAtTop(byId("payment-form"), { focusSelector: "#payment-client-search" });
}

// Se llama tanto al cancelar (sin guardar nada) como despues de guardar el
// recibo con exito, igual que returnToClosingAfterExpense() en Cierres.
function returnToBillingAfterReceipt() {
  byId("payment-receipt-cancel")?.classList.add("hidden");
  if (!clientPendingReceiptReturn) {
    switchToView("receivables");
    return;
  }
  const snapshot = clientPendingReceiptReturn;
  clientPendingReceiptReturn = null;
  switchToView(snapshot.originView || "billing");
  if (byId("invoice-search")) byId("invoice-search").value = snapshot.search || "";
  renderInvoices();
  window.scrollTo(0, snapshot.scrollY || 0);
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

// Reconstruye el desglose claro de una factura YA GUARDADA (nueva o vieja) a
// partir de los campos persistidos, y lo pasa por la MISMA formula pura
// (DalfiClosingMath.computeInvoiceBreakdown) que usa la vista previa en vivo
// del formulario (updateInvoiceTotals). precioBase en facturaDetalle es un
// snapshot congelado al momento de facturar: si una factura vieja no tiene
// ese campo (dato previo a este snapshot), se usa subtotal como respaldo
// seguro para no mostrar 0 donde en realidad hubo un monto real.
function invoiceBreakdownForStoredInvoice(invoiceId) {
  const dbInvoice = dbTable("facturas").find((row) => row.facturaID === invoiceId);
  const details = dbTable("facturaDetalle").filter((row) => row.facturaID === invoiceId);
  const tips = dbTable("propinas").filter((row) => row.facturaID === invoiceId);
  const payments = dbTable("ingresos").filter((row) => row.facturaID === invoiceId);
  const precioListadoServicios = details.reduce((sum, line) => {
    const listed = line.precioBase !== undefined && line.precioBase !== null ? Number(line.precioBase) || 0 : Number(line.subtotal) || 0;
    return sum + listed * (Number(line.cantidad) || 1);
  }, 0);
  const lineExtras = details.reduce((sum, line) => sum + (Number(line.extraMonto) || 0), 0);
  const generalExtra = Number(dbInvoice?.adicionalGeneralMonto) || 0;
  const lineDiscounts = details.reduce((sum, line) => sum + (Number(line.deduccionMonto) || 0), 0);
  const generalDiscount = Number(dbInvoice?.descuentoGeneralMonto) || 0;
  const totalFacturado = Number(dbInvoice?.totalFacturado) || 0;
  const totalConPropina =
    dbInvoice?.totalConPropina !== undefined && dbInvoice?.totalConPropina !== null
      ? Number(dbInvoice.totalConPropina) || 0
      : totalFacturado + tips.reduce((sum, tip) => sum + (Number(tip.montoBruto) || 0), 0);
  const propina = Math.max(0, totalConPropina - totalFacturado);
  // totalPagadoConfirmado ya NO incluye la propina (queda separada en
  // propinaCobrada, ver la politica "la propina se cobra de ultimo"): si
  // aqui solo se sumara totalPagadoConfirmado, el desglose impreso
  // mostraria como "pendiente" propina que YA se cobro. Facturas historicas
  // sin propinaCobrada caen a 0 (equivalente al comportamiento anterior,
  // donde totalPagadoConfirmado ya incluia cualquier propina cobrada).
  const totalPagado = (Number(dbInvoice?.totalPagadoConfirmado) || 0) + (Number(dbInvoice?.propinaCobrada) || 0);
  const breakdown = DalfiClosingMath.computeInvoiceBreakdown({
    precioListadoServicios,
    totalAdicionales: lineExtras + generalExtra,
    totalDescuentos: lineDiscounts + generalDiscount,
    propina,
    totalPagado,
  });
  return { dbInvoice, details, tips, payments, breakdown, lineExtras, generalExtra, lineDiscounts, generalDiscount };
}

function invoiceReportHtml(invoiceId) {
  const { invoice, dbInvoice } = invoiceReportData(invoiceId);
  if (!invoice && !dbInvoice) return "<p>Factura no encontrada.</p>";
  const { details, tips, payments, breakdown, lineExtras, generalExtra, lineDiscounts, generalDiscount } = invoiceBreakdownForStoredInvoice(invoiceId);
  const client = invoice?.client || dbInvoice?.clienteNombre || "";
  const date = invoice?.date || dateOnly(dbInvoice?.fechaHora);
  const note = invoice?.note || dbInvoice?.observaciones || "";
  const lines = details.length
    ? details
    : [{ servicio: invoice?.service || "Servicio", colaboradorNombre: dbInvoice?.colaboradorNombre || "", precioBase: breakdown.precioListadoServicios }];
  const discountRows = [
    ...details
      .filter((line) => Number(line.deduccionMonto) > 0)
      .map((line) => ({
        motivo: line.deduccionConcepto_50 || "Descuento de línea",
        tipo: "Monto fijo",
        valor: Number(line.deduccionMonto) || 0,
        linea: line.servicio || "",
      })),
    ...(generalDiscount > 0
      ? [
          {
            motivo: "Descuento general de la factura",
            tipo: dbInvoice?.descuentoGeneralPorcentaje ? `Porcentaje (${dbInvoice.descuentoGeneralPorcentaje}%)` : "Monto fijo",
            valor: generalDiscount,
            linea: "Toda la factura",
          },
        ]
      : []),
  ];
  const extraRows = [
    ...details
      .filter((line) => Number(line.extraMonto) > 0)
      .map((line) => ({
        nombre: line.extraConcepto_50 || "Adicional de línea",
        valor: Number(line.extraMonto) || 0,
        linea: line.servicio || "",
        colaboradora: line.colaboradorNombre || "",
      })),
    ...(generalExtra > 0
      ? [{ nombre: dbInvoice?.adicionalGeneralDetalle || "Adicional general", valor: generalExtra, linea: "Toda la factura", colaboradora: "" }]
      : []),
  ];
  const estaPagada = breakdown.estaPagada;
  const paymentMethodLabel = { efectivo: "Efectivo", tarjeta: "Tarjeta", transferencia: "Transferencia", transferencia_confirmada: "Transferencia", balance: "Balance a favor", sobrante: "Sobrante" };
  return `
    <section class="invoice-report">
      <h1>Dalfi Studio Nails</h1>
      <p>SeBen ERP</p>
      <hr />
      <h2>Factura ${escapeHtml(invoiceId)}</h2>
      <p><strong>Fecha:</strong> ${escapeHtml(date || "")}</p>
      <p><strong>Cliente:</strong> ${escapeHtml(client)}</p>
      <h3>1. Servicios y precios listados</h3>
      <table>
        <thead><tr><th>Servicio</th><th>Colaborador/a</th><th>Precio listado</th></tr></thead>
        <tbody>
          ${lines
            .map(
              (line) =>
                `<tr><td>${escapeHtml(line.servicio || "")}</td><td>${escapeHtml(line.colaboradorNombre || "")}</td><td>${money.format(
                  line.precioBase !== undefined && line.precioBase !== null ? Number(line.precioBase) || 0 : Number(line.subtotal) || 0,
                )}</td></tr>`,
            )
            .join("")}
        </tbody>
      </table>
      <div class="invoice-totals">
        <p><strong>2. Total precio listado de servicios:</strong> ${money.format(breakdown.precioListadoServicios)}</p>
      </div>
      <h3>3. Adicionales</h3>
      ${
        extraRows.length
          ? `<table>
              <thead><tr><th>Adicional</th><th>Línea</th><th>Colaboradora</th><th>Monto</th></tr></thead>
              <tbody>${extraRows
                .map((row) => `<tr><td>${escapeHtml(row.nombre)}</td><td>${escapeHtml(row.linea)}</td><td>${escapeHtml(row.colaboradora)}</td><td>${money.format(row.valor)}</td></tr>`)
                .join("")}</tbody>
            </table>`
          : "<p>Sin adicionales.</p>"
      }
      <div class="invoice-totals"><p><strong>Total de adicionales:</strong> ${money.format(breakdown.totalAdicionales)}</p></div>
      <div class="invoice-totals"><p><strong>4. Subtotal antes de descuentos:</strong> ${money.format(breakdown.subtotalAntesDeDescuentos)}</p></div>
      <h3>5. Descuentos</h3>
      ${
        discountRows.length
          ? `<table>
              <thead><tr><th>Motivo</th><th>Tipo</th><th>Línea</th><th>Valor</th></tr></thead>
              <tbody>${discountRows
                .map((row) => `<tr><td>${escapeHtml(row.motivo)}</td><td>${escapeHtml(row.tipo)}</td><td>${escapeHtml(row.linea)}</td><td>${money.format(row.valor)}</td></tr>`)
                .join("")}</tbody>
            </table>`
          : "<p>Sin descuentos.</p>"
      }
      <div class="invoice-totals"><p><strong>Total de descuentos:</strong> ${money.format(breakdown.totalDescuentos)}</p></div>
      <div class="invoice-totals"><p><strong>6. Total de servicios (después de ajustes):</strong> ${money.format(breakdown.totalServiciosAjustado)}</p></div>
      <h3>8. Propina</h3>
      ${
        breakdown.propina > 0
          ? `<p><strong>Monto de propina:</strong> ${money.format(breakdown.propina)}</p>
             ${
               tips.length
                 ? `<table>
                      <thead><tr><th>Colaboradora</th><th>Método</th><th>Monto</th><th>Retención tarjeta</th><th>Neto a pagar</th></tr></thead>
                      <tbody>${tips
                        .map(
                          (tip) =>
                            `<tr><td>${escapeHtml(tip.colaboradorNombre || "")}</td><td>${escapeHtml(paymentMethodLabel[tip.metodoPago] || tip.metodoPago || "")}</td><td>${money.format(Number(tip.montoBruto) || 0)}</td><td>${money.format(Number(tip.retencion20Tarjeta) || 0)}</td><td>${money.format(Number(tip.montoNetoPagar) || 0)}</td></tr>`,
                        )
                        .join("")}</tbody>
                    </table>`
                 : `<p>Propina registrada en la factura, pendiente de cobro/distribución por colaboradora.</p>`
             }
             <p>Incluida en el total general.</p>`
          : `<p>Sin propina (propina = ${money.format(0)}).</p>`
      }
      <div class="invoice-totals">
        <p><strong>9. ${estaPagada ? "Total pagado" : "Total por pagar"}:</strong> ${money.format(breakdown.totalGeneral)}</p>
        <p><strong>10. Pagado:</strong> ${money.format(breakdown.totalPagado)}</p>
        ${!estaPagada ? `<p><strong>11. Pendiente:</strong> ${money.format(breakdown.montoPendiente)}</p>` : ""}
        ${breakdown.sobrepago > 0 ? `<p><strong>Sobrepago:</strong> ${money.format(breakdown.sobrepago)}</p>` : ""}
      </div>
      ${
        payments.length
          ? `<h3>12. Desglose por método de pago</h3><ul>${payments
              .map((payment) => `<li>${escapeHtml(paymentMethodLabel[payment.metodoPago] || payment.metodoPago || "")}: ${money.format(Number(payment.montoNeto) || Number(payment.montoBruto) || 0)}</li>`)
              .join("")}</ul>`
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
  if (!canManageInvoices()) {
    alert("Solo administradores y propietarios pueden ver el detalle de los cierres.");
    return;
  }
  const closing = dbTable("cierres").find((row) => row.cierreID === closingId);
  if (!closing) return;
  if (closing.closingType === "treasury") {
    const cuentas = closing.cuentas || [];
    const totales = closing.totales || buildTreasuryTotals(cuentas);
    openRecordReport(
      `Cierre consolidado ${closingId}`,
      `
        <h2>Cierre consolidado de tesorería ${escapeHtml(closingId)}</h2>
        <p><strong>Fecha:</strong> ${escapeHtml(closingBusinessDate(closing))}</p>
        <p><strong>Estado:</strong> ${escapeHtml(closing.estado || "")}</p>
        <p><strong>Confirmado por:</strong> ${escapeHtml(closing.confirmadoPor || "-")}</p>
        <p><strong>Fecha de confirmación:</strong> ${closing.fechaConfirmacion ? escapeHtml(new Date(closing.fechaConfirmacion).toLocaleString("es-DO")) : "Sin confirmar"}</p>
        ${closing.loteConfirmacionID ? `<p><strong>Lote de confirmación:</strong> ${escapeHtml(closing.loteConfirmacionID)}</p>` : ""}
        <table>
          <thead>
            <tr>
              <th>Cuenta</th><th>Tipo</th><th>Saldo inicial</th><th>Ingresos</th><th>Egresos</th>
              <th>Transf. recibidas</th><th>Transf. enviadas</th><th>Ajustes</th><th>Esperado</th>
              <th>Real</th><th>Diferencia</th><th>Observaciones</th>
            </tr>
          </thead>
          <tbody>
            ${cuentas
              .map(
                (row) => `
                  <tr>
                    <td>${escapeHtml(row.nombreCuenta)}</td>
                    <td>${escapeHtml(row.tipoCuenta || "")}</td>
                    <td>${money.format(Number(row.saldoInicial) || 0)}</td>
                    <td>${money.format(Number(row.ingresos) || 0)}</td>
                    <td>${money.format(Number(row.egresos) || 0)}</td>
                    <td>${money.format(Number(row.transferenciasRecibidas) || 0)}</td>
                    <td>${money.format(Number(row.transferenciasEnviadas) || 0)}</td>
                    <td>${money.format(Number(row.ajustes) || 0)}</td>
                    <td>${money.format(Number(row.saldoEsperado) || 0)}</td>
                    <td>${money.format(Number(row.saldoReal) || 0)}</td>
                    <td>${money.format(Number(row.diferencia) || 0)}</td>
                    <td>${escapeHtml(row.observaciones || "")}</td>
                  </tr>
                `,
              )
              .join("")}
            <tr>
              <td><strong>Total</strong></td><td></td>
              <td><strong>${money.format(totales.saldoInicial)}</strong></td>
              <td><strong>${money.format(totales.ingresos)}</strong></td>
              <td><strong>${money.format(totales.egresos)}</strong></td>
              <td><strong>${money.format(totales.transferenciasRecibidas)}</strong></td>
              <td><strong>${money.format(totales.transferenciasEnviadas)}</strong></td>
              <td></td>
              <td><strong>${money.format(totales.saldoEsperado)}</strong></td>
              <td><strong>${money.format(totales.saldoReal)}</strong></td>
              <td><strong>${money.format(totales.diferencia)}</strong></td>
              <td></td>
            </tr>
          </tbody>
        </table>
        ${closing.observaciones ? `<p><strong>Nota general:</strong> ${escapeHtml(closing.observaciones)}</p>` : ""}
      `,
    );
    return;
  }
  openRecordReport(
    `Cierre ${closingId}`,
    `
      <h2>Cierre de caja registradora ${escapeHtml(closingId)}</h2>
      <p><strong>Fecha:</strong> ${escapeHtml(closingBusinessDate(closing))}</p>
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
  // Solo deuda del CLIENTE: la CxC del procesador de tarjeta (deudorTipo:
  // "Procesador tarjeta") tiene su propio reporte dedicado
  // (renderCardReceivablesReport) y nunca debe mezclarse aqui con lo que un
  // cliente debe -ni siquiera para mostrarla, mucho menos para quedar
  // seleccionable en el <select> de "cobrar CxC" de abajo, que es
  // exclusivamente para clientes-.
  const rows = dbTable("cuentasCobrar")
    .filter((cxc) => cxc.deudorTipo === "Cliente")
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

  updatePaymentSummary();
}

function renderIncomeRecords() {
  const target = byId("income-table");
  if (!target) return;
  const query = byId("income-search")?.value || "";
  const rows = receivableReceiptRows(query).slice(0, 100);
  if (!rows.length) return renderEmpty(target, 7, "No hay recibos de cobros de cuentas por cobrar.");
  target.innerHTML = rows
    .map(
      (row) => {
        const editable = canManageReceivableReceipt(row.income);
        return `
        <tr>
          <td>${dateOnly(row.income.fechaHora)}</td>
          <td>${row.income.ingresoID}</td>
          <td>${row.application.facturaID || row.cxc?.facturaID || row.cxc?.cxCID || "-"}</td>
          <td>${row.income.clienteNombre || row.cxc?.deudorNombre || "Sin cliente"}</td>
          <td>${row.income.metodoPago || row.income.formaPago || "-"}</td>
          <td class="amount">${money.format(Number(row.application.montoAplicado) || Number(row.income.montoBruto) || 0)}</td>
          <td>
            <div class="row-actions">
              <button class="secondary-btn compact view-income" data-income-id="${escapeHtml(row.income.ingresoID)}" type="button">Ver</button>
              ${editable ? `<button class="secondary-btn compact edit-income-date" data-income-id="${escapeHtml(row.income.ingresoID)}" type="button">Editar fecha</button>` : ""}
              ${editable ? `<button class="secondary-btn compact void-income" data-income-id="${escapeHtml(row.income.ingresoID)}" type="button">Anular</button>` : ""}
            </div>
          </td>
        </tr>
      `;
      },
    )
    .join("");
}

function receivableReceiptRows(query = "") {
  const normalizedQuery = normalize(query);
  return dbTable("ingresoAplicaciones")
    .filter((application) => application.cxCID && normalize(application.estado || "Activo") !== "anulado")
    .map((application) => {
      const income = dbTable("ingresos").find((row) => row.ingresoID === application.ingresoID);
      const cxc = dbTable("cuentasCobrar").find((row) => row.cxCID === application.cxCID);
      if (!income || normalize(income.estado || "Confirmado") === "anulado") return null;
      return { application, income, cxc };
    })
    .filter(Boolean)
    .filter((row) => {
      if (!normalizedQuery) return true;
      return [
        row.income.ingresoID,
        row.income.facturaID,
        row.income.clienteNombre,
        row.income.metodoPago,
        row.cxc?.cxCID,
        row.cxc?.facturaID,
        row.cxc?.deudorNombre,
        row.cxc?.concepto,
      ].some((field) => normalize(field).includes(normalizedQuery));
    })
    .sort((a, b) => `${b.income.fechaHora || ""} ${b.income.ingresoID || ""}`.localeCompare(`${a.income.fechaHora || ""} ${a.income.ingresoID || ""}`));
}

function canManageReceivableReceipt(income) {
  if (!canManageInvoices() || !income) return false;
  return isClosingOpenForEdits(closingForDate(dateOnly(income.fechaHora)));
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

// La confirmacion de una transferencia pendiente pide la fecha real en que el
// dinero entro a la cuenta (accountEntryDate) mediante un dialogo, en vez de
// un prompt() del navegador. canConfirmTransfer se revisa dos veces: al abrir
// el dialogo y de nuevo justo antes de aplicar el cambio, para no confirmar
// dos veces la misma transferencia si otra sesion ya la proceso mientras el
// dialogo estaba abierto.
function openTransferConfirmDialog(cxcId) {
  const cxc = dbTable("cuentasCobrar").find((item) => item.cxCID === cxcId);
  const dialog = byId("transfer-confirm-dialog");
  if (!cxc || !dialog) return;
  if (!DalfiClosingMath.canConfirmTransfer(cxc)) {
    alert("Esta transferencia ya fue confirmada anteriormente.");
    renderAll();
    return;
  }
  dialog.dataset.cxcId = cxcId;
  byId("transfer-confirm-summary").textContent =
    `${cxc.deudorNombre || "Cliente"} · ${money.format(Number(cxc.balancePendiente) || 0)} · Factura ${cxc.facturaID || cxc.cxCID}`;
  byId("transfer-confirm-date").value = today;
  byId("transfer-confirm-message").textContent = "";
  byId("transfer-confirm-message").className = "form-message";
  dialog.showModal();
  byId("transfer-confirm-date").focus();
}

function confirmPendingTransfer(cxcId, depositDate) {
  const cxc = dbTable("cuentasCobrar").find((item) => item.cxCID === cxcId);
  if (!cxc) throw new Error("Esta transferencia ya no existe.");
  if (!DalfiClosingMath.canConfirmTransfer(cxc)) throw new Error("Esta transferencia ya fue confirmada.");
  if (!DalfiClosingMath.isValidIsoDate(depositDate)) throw new Error("Introduce una fecha valida.");
  const amount = Number(cxc.balancePendiente) || 0;
  const clientRecord = dbTable("clientes").find((client) => client.clienteID === cxc.deudorID) || findClientByName(cxc.deudorNombre);
  cxc.montoAplicado = (Number(cxc.montoAplicado) || 0) + amount;
  cxc.balancePendiente = 0;
  cxc.estado = "Saldada";
  cxc.fechaPago = depositDate;
  cxc.fechaEntradaCuenta = depositDate;
  cxc.accountEntryDate = depositDate;
  cxc.confirmadoPor = currentUserEmail();
  cxc.fechaConfirmacionTransferencia = new Date().toISOString();
  cxc.observaciones = `${cxc.observaciones || ""} Transferencia confirmada ${depositDate} por ${currentUserEmail()}.`.trim();
  stampRecord(cxc, "updated");
  addConfirmedPayment(cxc.facturaID || "", clientRecord, cxc.deudorNombre || "", amount, "transferencia_confirmada", "Transferencia confirmada desde cuentas por cobrar", "", cxc.cuentaDestino || "", depositDate, cxc.cxCID || "");
  refreshPendingClosingsForDate(depositDate);
  logAudit("transfer_confirm", {
    entity: "cuentasCobrar",
    entityId: cxcId,
    newData: { accountEntryDate: depositDate, monto: amount, cliente: cxc.deudorNombre },
    success: true,
  });
}

function handlePendingTransferAction(button, action) {
  const cxc = dbTable("cuentasCobrar").find((item) => item.cxCID === button.dataset.cxcId);
  if (!cxc) return;
  if (action === "confirm") {
    openTransferConfirmDialog(cxc.cxCID);
    return;
  }
  if (action === "decline") {
    cxc.tipoCxC = "Crédito cliente";
    cxc.concepto = "Transferencia declinada - cuenta por cobrar vencida";
    cxc.fechaVencimiento = today;
    cxc.estado = "Pendiente";
    cxc.observaciones = `${cxc.observaciones || ""} Transferencia declinada ${new Date().toISOString()}. No completada; deuda vencida inmediata.`.trim();
    stampRecord(cxc, "updated");
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
    .map((reservation) => {
      const status = reservationStatus(reservation);
      const statusClass = status === "Cancelada" || status === "No asistió" ? "danger" : status === "Completada" ? "success" : "warning";
      return `
        <article class="appointment">
          <time>${reservation.time}</time>
          <div>
            <strong>${reservation.client}</strong>
            <span>${reservation.service} con ${reservation.staff}</span>
            <span>${reservation.phone || ""} ${reservation.provisional ? "· Cliente provisional" : ""} ${reservation.source ? `· ${reservation.source}` : ""} ${reservation.note ? `· ${reservation.note}` : ""}</span>
          </div>
          <div class="row-actions">
            <span class="status-pill ${statusClass}">${escapeHtml(status)}</span>
            <span>${reservation.invoiceId ? `Factura ${reservation.invoiceId}` : reservation.date}</span>
            <button class="secondary-btn compact edit-reservation" data-reservation-id="${reservation.id}" type="button">Editar</button>
            ${reservation.invoiceId ? "" : `<button class="secondary-btn compact invoice-reservation" data-reservation-id="${reservation.id}" type="button">Facturar</button>`}
          </div>
        </article>
      `;
    })
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

// Propinas y comisiones se pagan COMPLETAS en la nomina del dia 30 (o "mes
// completo", que en este ERP es la unica nomina de ese mes y por lo tanto se
// comporta igual que la segunda quincena para este proposito), NUNCA en la
// del dia 15: DalfiClosingMath.computeTipCommissionPeriod() calcula el rango
// 21 del mes anterior -> 20 del mes actual, sin duplicar el dia 20.
function payrollCommissionTipRange(period, cut) {
  if (cut === "first") return null;
  const range = DalfiClosingMath.computeTipCommissionPeriod({ period });
  return range.valid ? range : null;
}

function dateInRange(value, start, end) {
  const current = dateOnly(value);
  return current >= start && current <= end;
}

// Unica configuracion de TSS efectiva para una fecha: la mas reciente cuyo
// fechaVigencia sea <= fecha, entre las activas. Sin configuracion vigente,
// devuelve null (nunca se inventa una tasa).
function activeTssConfig(date) {
  const target = date || today;
  return (
    dbTable("configuracionTSS")
      .filter((row) => normalize(row.estado || "Activo") === "activo")
      .filter((row) => !row.fechaVigencia || row.fechaVigencia <= target)
      .filter((row) => !row.fechaFin || row.fechaFin >= target)
      .sort((a, b) => String(b.fechaVigencia || "").localeCompare(String(a.fechaVigencia || "")))[0] || null
  );
}

// CxC pendientes de un colaborador, en orden FIFO real (la mas antigua
// primero): mismo criterio que applyCollaboratorReceivablesFIFO.
function collaboratorReceivablesSorted(staff, staffName) {
  return dbTable("cuentasCobrar")
    .filter((cxc) => {
      const sameStaff = cxc.deudorTipo === "Colaborador" && (cxc.deudorID === staff?.colaboradorID || normalize(cxc.deudorNombre) === normalize(staffName));
      return sameStaff && Number(cxc.balancePendiente) > 0;
    })
    .sort((a, b) => DalfiClosingMath.compareCollaboratorReceivablesFIFO({ id: a.cxCID, fechaOrigen: a.fechaOrigen, fechaVencimiento: a.fechaVencimiento }, { id: b.cxCID, fechaOrigen: b.fechaOrigen, fechaVencimiento: b.fechaVencimiento }));
}

// Cuanto de la cuota salarial ordinaria de este corte ya esta prepagado por
// vacaciones (para no pagar los mismos dias dos veces). Solo cuenta
// vacaciones en estado "Pagada anticipadamente" (nunca solicitadas o
// canceladas) del colaborador.
function collaboratorVacationOffsetForRange(staff, staffName, salaryRange) {
  if (!salaryRange) return 0;
  // "Disfrutada" es una anotacion POSTERIOR sobre unas vacaciones que ya
  // fueron pagadas anticipadamente (ver markVacationEnjoyed): el dinero
  // sigue habiendo salido una sola vez por adelantado, asi que el ajuste
  // salarial debe seguir aplicando igual que con "Pagada anticipadamente".
  // Si el filtro solo aceptara "Pagada anticipadamente", una nomina creada
  // DESPUES de marcar la vacacion como Disfrutada pagaria esos dias dos
  // veces (una vez en el anticipo, otra vez en el salario ordinario sin
  // descuento).
  const vacations = dbTable("vacaciones").filter((row) => {
    const sameStaff = row.colaboradorID ? row.colaboradorID === staff?.colaboradorID : normalize(row.colaboradorNombre) === normalize(staffName);
    const estado = normalize(row.estado || "");
    return sameStaff && (estado === "pagada anticipadamente" || estado === "disfrutada");
  });
  return vacations.reduce((sum, vac) => {
    const offset = DalfiClosingMath.computeVacationSalaryOffset({
      vacationStart: vac.fechaInicio,
      vacationDays: Number(vac.diasPagados) || 0,
      cutStart: salaryRange.start,
      cutEnd: salaryRange.end,
      dailyValue: Number(vac.valorDiario) || 0,
    });
    return sum + offset.offsetAmount;
  }, 0);
}

// No se puede crear una segunda nomina Borrador/Pagada para el mismo
// colaborador+periodo+corte (evita duplicar comision/propinas/salario).
// Una nomina Revertida SI permite generar una nueva.
function existingActivePayrollFor(colaboradorID, staffName, periodoInicio, periodoFin) {
  return dbTable("nomina").find((row) => {
    const sameStaff = colaboradorID ? row.colaboradorID === colaboradorID : normalize(row.colaboradorNombre) === normalize(staffName);
    if (!sameStaff || normalize(row.estado || "") === "revertida") return false;
    // Solapamiento de RANGO de fechas, no solo coincidencia exacta: una
    // nomina "Mes completo" cubre el mismo salario/TSS que "Primera" +
    // "Segunda" quincena juntas, asi que tambien deben bloquearse entre si
    // (si no, TSS o el salario del mes podrian pagarse dos veces sin que
    // ningun chequeo lo detecte). "Primera" (01-15) y "Segunda" (16-fin) no
    // se solapan entre si, por eso siguen pudiendo coexistir normalmente.
    return row.periodoInicio <= periodoFin && row.periodoFin >= periodoInicio;
  });
}

// Cargo interno a un colaborador (servicio consumido, u otro concepto
// autorizado) que NUNCA tuvo una salida real de dinero: a diferencia de un
// avance (egreso + CxC vinculados), esto crea UNICAMENTE la CxC. No
// disponible todavia desde ningun formulario (pendiente de una interfaz
// dedicada); queda como funcion de datos permiso-validada y probada para
// conectarse mas adelante sin duplicar esta logica.
function createCollaboratorInternalCharge({ staffRecord, staffName, amount, concept, tipoCxC = "Cargo interno" } = {}) {
  if (!canManageInvoices()) throw new Error("Solo administración o propietario puede crear cargos internos a colaboradores.");
  const safeAmount = Number(amount);
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) throw new Error("El monto del cargo debe ser mayor que cero.");
  if (!staffRecord && !staffName) throw new Error("Selecciona un colaborador.");
  if (!concept || !String(concept).trim()) throw new Error("Describe el concepto del cargo.");
  const cxcId = nextDbId("cuentasCobrar", "cxCID", "CXC");
  const record = stampRecord({
    cxCID: cxcId,
    fechaOrigen: new Date().toISOString(),
    tipoCxC,
    deudorTipo: "Colaborador",
    deudorID: staffRecord?.colaboradorID || "",
    deudorNombre: staffRecord?.nombreCompleto || staffName,
    facturaID: "",
    pagoID: "",
    egresoID: "",
    montoOriginal: safeAmount,
    montoAplicado: 0,
    balancePendiente: safeAmount,
    estado: "Pendiente",
    concepto: `${tipoCxC}: ${concept}`,
    fechaVencimiento: today,
  });
  dbTable("cuentasCobrar").push(record);
  logAudit("collaborator_receivable_created", {
    entity: "cuentasCobrar",
    entityId: cxcId,
    newData: { colaboradorID: staffRecord?.colaboradorID || "", monto: safeAmount, concepto: concept },
    note: `Cargo interno ${cxcId} creado por ${money.format(safeAmount)}, sin movimiento de caja/banco.`,
    success: true,
  });
  return record;
}

// ---------------------------------------------------------------------------
// Bonos de la nomina en curso: lista repetible dentro de #payroll-form,
// igual patron que income-payment-line-list/tip-allocation. No se
// pre-crean filas sueltas de "bonosNomina" antes de la nomina: se capturan
// aqui, en el momento de Guardar, evitando que un bono quede "flotando" sin
// nomina o se reutilice sin querer en una nomina futura.
// ---------------------------------------------------------------------------

function addPayrollBonusLine() {
  const row = document.createElement("article");
  row.className = "payroll-bonus-line list-item";
  // El checkbox arranca marcado o no segun la politica por defecto de la
  // configuracion TSS vigente (bonoSujeto), pero sigue siendo editable por
  // bono: la politica global es solo un punto de partida, no una regla fija.
  const defaultSubject = Boolean(activeTssConfig(today)?.bonoSujeto);
  row.innerHTML = `
    <input class="payroll-bonus-concept" placeholder="Concepto del bono" />
    <input class="payroll-bonus-amount" type="number" min="0" step="0.01" value="0" />
    <label class="payroll-bonus-tss-label"><input class="payroll-bonus-tss" type="checkbox" ${defaultSubject ? "checked" : ""} /> Sujeto a TSS</label>
    <button class="secondary-btn compact remove-payroll-bonus" type="button">Quitar</button>
  `;
  byId("payroll-bonus-list").appendChild(row);
}

function getPayrollBonusLines() {
  return [...document.querySelectorAll(".payroll-bonus-line")]
    .map((row) => ({
      concept: row.querySelector(".payroll-bonus-concept").value.trim(),
      amount: Number(row.querySelector(".payroll-bonus-amount").value) || 0,
      subjectToTss: row.querySelector(".payroll-bonus-tss").checked,
    }))
    .filter((line) => line.amount > 0);
}

// Aprueba UN borrador: unica transicion permitida antes de poder pagar
// (nunca Borrador -> Pagada directo). El snapshot ya quedo congelado al
// Guardar (umbral, propinas incluidas, CxC seleccionadas, TSS), asi que
// Aprobar no recalcula nada: solo exige permiso, exige que siga en
// Borrador, cambia el estado y audita.
function approvePayroll(payrollId) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede aprobar nómina.");
    return;
  }
  const payroll = dbTable("nomina").find((row) => row.nominaID === payrollId);
  if (!payroll) return;
  if (normalize(payroll.estado || "") !== "borrador") {
    alert("Solo un borrador puede aprobarse.");
    return;
  }
  payroll.estado = "Aprobada";
  stampRecord(payroll, "updated");
  logAudit("payroll_approved", {
    entity: "nomina",
    entityId: payrollId,
    newData: { colaboradorID: payroll.colaboradorID, neto: Number(payroll.totalAPagar) || 0 },
    note: `Nómina ${payrollId} aprobada para ${payroll.colaboradorNombre}.`,
    success: true,
  });
  saveState();
  renderAll();
}

// Reabre una nomina Aprobada de vuelta a Borrador: nunca desde Pagada.
// Como nada se consumio todavia en Aprobada (ni propinas, ni CxC, ni
// egreso), reabrir no necesita restaurar nada: es un simple cambio de
// estado con motivo obligatorio y auditoria.
function reopenPayroll(payrollId) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede reabrir una nómina aprobada.");
    return;
  }
  const payroll = dbTable("nomina").find((row) => row.nominaID === payrollId);
  if (!payroll) return;
  if (normalize(payroll.estado || "") !== "aprobada") {
    alert("Solo una nómina Aprobada puede reabrirse (una Pagada requiere Revertir, no Reabrir).");
    return;
  }
  const reason = prompt("Indica el motivo para reabrir esta nómina aprobada:");
  if (!reason || !reason.trim()) {
    alert("Reabrir requiere un motivo.");
    return;
  }
  payroll.estado = "Borrador";
  payroll.motivoReapertura = reason.trim();
  stampRecord(payroll, "updated");
  logAudit("payroll_reopened", {
    entity: "nomina",
    entityId: payrollId,
    newData: { motivo: reason.trim() },
    note: `Nómina ${payrollId} reabierta: ${reason.trim()}.`,
    success: true,
  });
  saveState();
  renderAll();
}

// Motivo por el que Pagar debe bloquearse por TSS, o "" si no aplica
// bloqueo. Se evalua sobre el snapshot ya congelado (tssConfigId), nunca
// recalculando en vivo: si al Guardar/Aprobar no habia configuracion
// vigente, Pagar debe seguir bloqueado hasta que se cree una nueva
// vigencia y esta nomina se re-guarde con ella.
function payrollTssBlockReason(payroll) {
  if (!payroll) return "";
  if (payroll.payrollType === "first") return "";
  if (payroll.tssConfigId) return "";
  return "No puede pagarse esta nómina porque falta la configuración TSS vigente del período.";
}

// Abre el panel "Pagar nomina" para un payrollId especifico (debe estar en
// estado Aprobada, nunca Borrador ni Pagada): precarga un resumen de solo
// lectura, deja el resto de la decision (cuenta, medio, fecha real) a
// quien va a confirmar el pago.
function openPayPayrollForm(payrollId) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede pagar nómina.");
    return;
  }
  const payroll = dbTable("nomina").find((row) => row.nominaID === payrollId);
  if (!payroll || normalize(payroll.estado || "") !== "aprobada") return;
  const blockReason = payrollTssBlockReason(payroll);
  if (blockReason) {
    alert(blockReason);
    return;
  }
  byId("pay-payroll-id").value = payrollId;
  byId("pay-payroll-summary").innerHTML = payPayrollSummaryHtml(payroll);
  byId("pay-payroll-date").value = today;
  const form = byId("pay-payroll-form");
  form.classList.remove("hidden");
  revealFormAtTop(form, { focusSelector: "#pay-payroll-account" });
}

// Resumen final antes de pagar (seccion 12): todos los componentes que
// forman el neto, en solo lectura, para que la confirmacion sea informada.
function payPayrollSummaryHtml(payroll) {
  const rows = [
    ["Colaborador/a", payroll.colaboradorNombre],
    ["Período", `${payroll.periodoInicio} a ${payroll.periodoFin}`],
    ["Quincena", payroll.quincena],
    ["Salario", money.format(Number(payroll.salarioQuincenal) || 0)],
    ["Comisión", money.format(Number(payroll.comisionGenerada) || 0)],
    ["Propinas", money.format(Number(payroll.propinaNetaMes) || 0)],
    ["Bonos", money.format((payroll.bonos || []).reduce((sum, line) => sum + (Number(line.amount) || 0), 0))],
    ["Ajuste vacaciones prepagadas", money.format(Number(payroll.vacationSalaryOffset) || 0)],
    ["TSS del colaborador", money.format(Number(payroll.tssEmployeeDeduction) || 0)],
    ["CxC descontada", money.format(Number(payroll.descuentoCxC) || 0)],
    ["Otros descuentos", money.format((Number(payroll.descuentoAFP) || 0) + (Number(payroll.descuentoSeguro) || 0) + (Number(payroll.descuentoOtros) || 0))],
    ["Neto a pagar", money.format(Number(payroll.totalAPagar) || 0)],
  ];
  return rows.map(([label, value]) => `<div class="summary-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join("");
}

// Reversa UNA nomina PAGADA: exige permiso, exige motivo, revierte el
// egreso (marcandolo Revertido, que accountAvailableBalance ya excluye),
// devuelve las propinas incluidas a Pendiente (si nadie mas las toco
// despues), restaura el saldo de las CxC de colaborador que se
// descontaron, y deja la nomina en estado Revertida (nunca se vuelve a
// pagar ni se vuelve a revertir).
function revertPayrollPayment(payrollId) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede revertir una nómina pagada.");
    return;
  }
  const payroll = dbTable("nomina").find((row) => row.nominaID === payrollId);
  if (!payroll) return;
  if (normalize(payroll.estado || "") !== "pagada") {
    alert("Solo se puede revertir una nómina que ya fue pagada.");
    return;
  }
  const reason = prompt("Indica el motivo de la reversión de esta nómina:");
  if (!reason || !reason.trim()) {
    alert("La reversión requiere un motivo.");
    return;
  }
  // Si alguna propina incluida ya fue usada por OTRA nomina distinta a esta
  // desde que se pago (no deberia poder pasar, pero se verifica), no se
  // revierte en silencio.
  const tipIds = new Set(Array.isArray(payroll.propinaIdsIncluidas) ? payroll.propinaIdsIncluidas : []);
  const blockedTip = dbTable("propinas").find((tip) => tipIds.has(tip.propinaID) && tip.nominaID && tip.nominaID !== payrollId);
  if (blockedTip) {
    alert(`No se puede revertir: la propina ${blockedTip.propinaID} ya quedó asociada a otra nómina (${blockedTip.nominaID}). Ajusta manualmente antes de continuar.`);
    return;
  }
  const expense = dbTable("egresos").find((row) => row.egresoID === payroll.egresoID);
  if (expense) {
    expense.estado = "Revertido";
    expense.observaciones = `${expense.observaciones || ""} Revertido por reversión de nómina ${payrollId}: ${reason.trim()}`.trim();
    stampRecord(expense, "updated");
  }
  dbTable("propinas").forEach((tip) => {
    if (!tipIds.has(tip.propinaID)) return;
    if (tip.nominaID !== payrollId) return;
    tip.estadoPagoNomina = "Pendiente";
    tip.nominaID = "";
    stampRecord(tip, "updated");
  });
  const cxcDetalle = Array.isArray(payroll.cxcDiscountDetalle) ? payroll.cxcDiscountDetalle : [];
  cxcDetalle.forEach((line) => {
    const cxc = dbTable("cuentasCobrar").find((row) => row.cxCID === line.cxcId);
    if (!cxc) return;
    const applied = Math.min(Number(line.amount) || 0, Number(cxc.montoAplicado) || 0);
    if (applied <= 0) return;
    cxc.montoAplicado = Math.max(0, (Number(cxc.montoAplicado) || 0) - applied);
    cxc.balancePendiente = (Number(cxc.balancePendiente) || 0) + applied;
    cxc.estado = "Pendiente";
    cxc.observaciones = `${cxc.observaciones || ""} Restaurado por reversión de nómina ${payrollId}.`.trim();
    stampRecord(cxc, "updated");
  });
  payroll.estado = "Revertida";
  payroll.motivoReversion = reason.trim();
  payroll.revertidoPor = erpProfile?.email || currentUserRecord()?.correo || "";
  payroll.fechaReversion = new Date().toISOString();
  stampRecord(payroll, "updated");
  refreshPendingClosingsForDate(dateOnly(payroll.fechaPagoNomina) || today);
  logAudit("payroll_reverted", {
    entity: "nomina",
    entityId: payrollId,
    newData: { motivo: reason.trim(), egresoID: payroll.egresoID },
    note: `Nómina ${payrollId} revertida: ${reason.trim()}.`,
    success: true,
  });
  saveState();
  renderAll();
}

// Abre el panel "Aprobar vacaciones" para una solicitud (debe estar
// Solicitada): aqui es donde se captura el valor diario, no en la
// solicitud original.
function openVacationApproveForm(vacationId) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede aprobar vacaciones.");
    return;
  }
  const vacation = dbTable("vacaciones").find((row) => row.vacationId === vacationId);
  if (!vacation || normalize(vacation.estado || "") !== "solicitada") return;
  byId("vacation-approve-id").value = vacationId;
  byId("vacation-approve-summary").textContent = `${vacation.colaboradorNombre} · ${vacation.fechaInicio} · ${vacation.diasPagados} días`;
  byId("vacation-approve-daily-value").value = "";
  byId("vacation-approve-amount").textContent = money.format(0);
  const form = byId("vacation-approve-form");
  form.classList.remove("hidden");
  revealFormAtTop(form, { focusSelector: "#vacation-approve-daily-value" });
}

// Abre el panel "Pagar anticipo" para una solicitud Aprobada.
function openVacationPayForm(vacationId) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede pagar el anticipo de vacaciones.");
    return;
  }
  const vacation = dbTable("vacaciones").find((row) => row.vacationId === vacationId);
  if (!vacation || normalize(vacation.estado || "") !== "aprobada") return;
  byId("vacation-pay-id").value = vacationId;
  byId("vacation-pay-summary").textContent = `${vacation.colaboradorNombre} · ${vacation.diasPagados} días · Monto ${money.format(Number(vacation.montoAnticipado) || 0)}`;
  byId("vacation-pay-date").value = today;
  const form = byId("vacation-pay-form");
  form.classList.remove("hidden");
  revealFormAtTop(form, { focusSelector: "#vacation-pay-account" });
}

// Marca disfrutadas unas vacaciones YA pagadas: simple cambio de estado,
// no mueve dinero (el anticipo ya se pago), solo documenta que el
// colaborador efectivamente tomo esos dias.
function markVacationEnjoyed(vacationId) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede marcar vacaciones como disfrutadas.");
    return;
  }
  const vacation = dbTable("vacaciones").find((row) => row.vacationId === vacationId);
  if (!vacation || normalize(vacation.estado || "") !== "pagada anticipadamente") return;
  vacation.estado = "Disfrutada";
  stampRecord(vacation, "updated");
  logAudit("vacation_enjoyed", {
    entity: "vacaciones",
    entityId: vacationId,
    newData: {},
    note: `Vacaciones de ${vacation.colaboradorNombre} marcadas como disfrutadas.`,
    success: true,
  });
  saveState();
  renderAll();
}

// Cancela una solicitud/aprobacion de vacaciones. Antes del pago: cambio de
// estado simple con motivo. Despues del pago: SEGUN LA POLITICA (seccion 8)
// nunca se borra ni se revierte en silencio el egreso ya hecho -aqui se
// bloquea explicitamente y se pide generar el ajuste (una CxC al
// colaborador) como una accion administrativa aparte, nunca automatica.
function cancelVacation(vacationId) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede cancelar vacaciones.");
    return;
  }
  const vacation = dbTable("vacaciones").find((row) => row.vacationId === vacationId);
  if (!vacation) return;
  const estado = normalize(vacation.estado || "");
  if (estado === "pagada anticipadamente" || estado === "disfrutada") {
    const createAdjustment = confirm(
      "Estas vacaciones ya fueron pagadas: no se puede cancelar ni revertir el anticipo automáticamente. ¿Deseas generar una CxC al colaborador por el monto ya anticipado, como ajuste administrativo explícito?",
    );
    if (!createAdjustment) return;
    const reason = prompt("Motivo del ajuste por cancelación después del pago:");
    if (!reason || !reason.trim()) {
      alert("El ajuste requiere un motivo.");
      return;
    }
    const staffRecord = dbTable("colaboradores").find((row) => row.colaboradorID === vacation.colaboradorID) || findStaffByName(vacation.colaboradorNombre);
    createCollaboratorInternalCharge({
      staffRecord,
      staffName: vacation.colaboradorNombre,
      amount: Number(vacation.montoAnticipado) || 0,
      concept: `Ajuste por cancelación de vacaciones ya pagadas (${vacationId}): ${reason.trim()}`,
      tipoCxC: "Ajuste vacaciones canceladas",
    });
    vacation.estado = "Cancelada";
    vacation.motivoCancelacion = reason.trim();
    stampRecord(vacation, "updated");
    logAudit("vacation_cancelled_after_payment", {
      entity: "vacaciones",
      entityId: vacationId,
      newData: { motivo: reason.trim() },
      note: `Vacaciones de ${vacation.colaboradorNombre} canceladas después de pagadas: ${reason.trim()}. Se generó CxC de ajuste.`,
      success: true,
    });
    saveState();
    renderAll();
    return;
  }
  if (estado === "cancelada" || estado === "revertida") {
    alert("Estas vacaciones ya están canceladas.");
    return;
  }
  const reason = prompt("Motivo de la cancelación:");
  if (!reason || !reason.trim()) {
    alert("La cancelación requiere un motivo.");
    return;
  }
  vacation.estado = "Cancelada";
  vacation.motivoCancelacion = reason.trim();
  stampRecord(vacation, "updated");
  logAudit("vacation_cancelled", {
    entity: "vacaciones",
    entityId: vacationId,
    newData: { motivo: reason.trim() },
    note: `Vacaciones de ${vacation.colaboradorNombre} canceladas antes del pago: ${reason.trim()}.`,
    success: true,
  });
  saveState();
  renderAll();
}

function renderVacations() {
  const target = byId("vacation-table");
  const query = byId("vacation-search")?.value || "";
  const rows = dbTable("vacaciones")
    .filter((row) => matches(row, query, ["colaboradorNombre"]))
    .sort((a, b) => String(b.fechaInicio || "").localeCompare(String(a.fechaInicio || "")));
  if (!rows.length) return renderEmpty(target, 6, "No hay vacaciones registradas.");
  target.innerHTML = rows
    .map((row) => {
      const estado = row.estado || "Solicitada";
      const normalized = normalize(estado);
      const canApprove = normalized === "solicitada";
      const canPay = normalized === "aprobada";
      const canMarkEnjoyed = normalized === "pagada anticipadamente";
      const canCancel = normalized !== "cancelada" && normalized !== "revertida";
      return `
        <tr data-vacation-id="${row.vacationId}">
          <td>${row.colaboradorNombre}</td>
          <td>${dateOnly(row.fechaInicio) || row.fechaInicio || ""}</td>
          <td>${row.diasPagados || 0}</td>
          <td>${money.format(Number(row.montoAnticipado) || 0)}</td>
          <td>${estado}</td>
          <td class="row-actions">
            ${canApprove ? `<button class="secondary-btn compact approve-vacation" type="button">Aprobar</button>` : ""}
            ${canPay ? `<button class="secondary-btn compact pay-vacation" type="button">Pagar anticipo</button>` : ""}
            ${canMarkEnjoyed ? `<button class="secondary-btn compact mark-vacation-enjoyed" type="button">Marcar disfrutada</button>` : ""}
            ${canCancel ? `<button class="secondary-btn compact cancel-vacation" type="button">Cancelar</button>` : ""}
          </td>
        </tr>
      `;
    })
    .join("");
}

// Listado de CxC de colaboradores (nunca mezclado con CxC de clientes: el
// filtro deudorTipo==="Colaborador" es el mismo usado por
// collaboratorReceivablesSorted). Filtro por estado + busqueda por
// colaborador/concepto.
function renderCollaboratorReceivables() {
  const target = byId("collaborator-receivable-table");
  if (!target) return;
  const query = byId("collaborator-receivable-search")?.value || "";
  const activeFilterButton = document.querySelector(".collaborator-receivable-filter.active");
  const filter = activeFilterButton?.dataset.filter || "pendientes";
  const rows = dbTable("cuentasCobrar")
    .filter((cxc) => cxc.deudorTipo === "Colaborador")
    .filter((cxc) => matches(cxc, query, ["deudorNombre", "concepto", "tipoCxC"]))
    .filter((cxc) => {
      const estado = normalize(cxc.estado || "Pendiente");
      const pending = Number(cxc.balancePendiente) || 0;
      if (filter === "todas") return true;
      if (filter === "anuladas") return estado === "anulada";
      if (filter === "pagadas") return pending <= 0 && estado !== "anulada";
      if (filter === "parciales") return pending > 0 && (Number(cxc.montoAplicado) || 0) > 0;
      return pending > 0 && (Number(cxc.montoAplicado) || 0) <= 0;
    })
    .sort((a, b) => String(b.fechaOrigen || "").localeCompare(String(a.fechaOrigen || "")));
  if (!rows.length) return renderEmpty(target, 9, "No hay cuentas por cobrar de colaboradores con ese filtro.");
  target.innerHTML = rows
    .map(
      (cxc) => `
        <tr>
          <td>${cxc.deudorNombre}</td>
          <td>${cxc.concepto || cxc.tipoCxC}</td>
          <td>${cxc.tipoCxC || ""}</td>
          <td>${dateOnly(cxc.fechaOrigen) || ""}</td>
          <td>${money.format(Number(cxc.montoOriginal) || 0)}</td>
          <td>${money.format(Number(cxc.montoAplicado) || 0)}</td>
          <td>${money.format(Number(cxc.balancePendiente) || 0)}</td>
          <td>${cxc.estado || "Pendiente"}</td>
          <td>${cxc.egresoID || "Sin salida de caja/banco"}</td>
        </tr>
      `,
    )
    .join("");
}

function payrollPreviewData() {
  const staffName = byId("payroll-staff").value.trim();
  const period = byId("payroll-period").value || month;
  const cut = byId("payroll-cut").value;
  const range = payrollPeriodRange(period, cut);
  const commissionTipRange = payrollCommissionTipRange(period, cut);
  const staff = findStaffByName(staffName);
  const monthlySalary = Number(staff?.salarioMensual) || 0;
  const installment = DalfiClosingMath.computeBiweeklySalaryInstallment({ monthlySalary, cut });
  const vacationOffset = collaboratorVacationOffsetForRange(staff, staffName, range);

  const details = commissionTipRange
    ? dbTable("facturaDetalle").filter((detail) => {
        const invoice = dbTable("facturas").find((row) => row.facturaID === detail.facturaID);
        const sameStaff = staff?.colaboradorID ? detail.colaboradorID === staff.colaboradorID : normalize(detail.colaboradorNombre) === normalize(staffName);
        return sameStaff && invoice && dateInRange(invoice.fechaHora, commissionTipRange.start, commissionTipRange.end);
      })
    : [];
  const sales = details.reduce((sum, detail) => sum + (Number(detail.subtotal) || 0), 0);
  const assignedThresholdIds = Array.isArray(staff?.umbralesComisionActivos)
    ? staff.umbralesComisionActivos
    : staff?.umbralComisionActivo
      ? [staff.umbralComisionActivo]
      : [];
  const thresholds = dbTable("umbralesComision").filter((row) => assignedThresholdIds.includes(row.escalaID));
  const commissionResult = DalfiClosingMath.selectCommissionThreshold({ eligibleSales: sales, thresholds, mode: "total_por_umbral" });

  const tipsRows = commissionTipRange
    ? dbTable("propinas").filter((tip) => {
        const sameStaff = staff?.colaboradorID ? tip.colaboradorID === staff.colaboradorID : normalize(tip.colaboradorNombre) === normalize(staffName);
        return sameStaff && normalize(tip.estadoPagoNomina || "Pendiente") === "pendiente" && dateInRange(tip.fechaHora, commissionTipRange.start, commissionTipRange.end);
      })
    : [];
  const tips = tipsRows.reduce((sum, tip) => sum + (Number(tip.montoNetoPagar) || 0), 0);

  const staffReceivables = collaboratorReceivablesSorted(staff, staffName);
  const cxcTotalInput = Number(byId("payroll-cxc-total")?.value) || 0;
  const explicitCxcDiscounts = [...document.querySelectorAll(".payroll-cxc-discount")].reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  const cxcDiscounts = explicitCxcDiscounts > 0 ? explicitCxcDiscounts : cxcTotalInput;

  const bonusLines = getPayrollBonusLines();
  const bonusAmount = bonusLines.reduce((sum, line) => sum + line.amount, 0);
  const bonusTssBase = bonusLines.filter((line) => line.subjectToTss).reduce((sum, line) => sum + line.amount, 0);

  const tssConfig = activeTssConfig(range.end);
  // TSS del colaborador se retiene UNA sola vez al mes: si el ERP no divide
  // explicitamente entre quincenas, se aplica en la nomina del dia 30 (o
  // "mes completo"), nunca en la del dia 15. Comisiones solo entran a la
  // base contributiva cuando la configuracion vigente lo marca
  // (tssConfig.comisionSujeta); los bonos entran solo por bono individual
  // (bonusTssBase), no por un switch global.
  const tssApplies = cut !== "first";
  const commissionTssBase = tssConfig?.comisionSujeta ? commissionResult.commissionAmount : 0;
  const tssContributiveBase = tssConfig ? Math.min(Number(tssConfig.baseContributiva) || 0, (Number(tssConfig.tope) || Infinity)) + bonusTssBase + commissionTssBase : 0;
  const tssEmployee = tssApplies && tssConfig ? Math.round(Math.min(tssContributiveBase, Number(tssConfig.tope) || tssContributiveBase) * (Number(tssConfig.tasaColaborador) || 0) / 100 * 100) / 100 : 0;
  const tssEmployer = tssApplies && tssConfig ? Math.round(Math.min(tssContributiveBase, Number(tssConfig.tope) || tssContributiveBase) * (Number(tssConfig.tasaEmpleador) || 0) / 100 * 100) / 100 : 0;

  const afp = Number(byId("payroll-afp")?.value) || 0;
  const insurance = Number(byId("payroll-insurance")?.value) || 0;
  const other = Number(byId("payroll-other-deductions")?.value) || 0;

  const settlement = DalfiClosingMath.calculatePayrollSettlement({
    monthlySalary,
    payrollType: cut,
    salaryInstallment: installment.installment,
    salaryProration: afp + insurance,
    vacationSalaryOffset: vacationOffset,
    commissions: commissionResult.commissionAmount,
    collectedTipsPayable: tips,
    bonuses: bonusAmount,
    employeeTssDeduction: tssEmployee,
    employeeReceivableDeduction: cxcDiscounts,
    otherDeductions: other,
    employerTssContribution: tssEmployer,
    allowNegativeNet: true,
  });

  const deductions = afp + insurance + other + cxcDiscounts + tssEmployee;
  const net = Math.max(0, settlement.netPayable);

  return {
    staff,
    staffName,
    period,
    cut,
    range,
    commissionTipRange,
    installment,
    vacationOffset,
    base: settlement.salaryPayable,
    sales,
    threshold: commissionResult,
    rate: commissionResult.rate,
    commission: commissionResult.commissionAmount,
    tips,
    tipsRows,
    staffReceivables,
    bonusLines,
    bonusAmount,
    afp,
    insurance,
    other,
    cxcDiscounts,
    tssConfig,
    tssEmployee,
    tssEmployer,
    deductions,
    net,
    settlement,
  };
}

function renderPayrollCxCList(rows) {
  const target = byId("payroll-cxc-list");
  if (!rows.length) {
    target.innerHTML = '<p class="empty">Este colaborador no tiene CxC pendiente.</p>';
    return;
  }
  const cxcTotal = Number(byId("payroll-cxc-total")?.value) || 0;
  const autoAllocation = cxcTotal > 0 ? DalfiClosingMath.applyCollaboratorReceivablesFIFO({ receivables: rows.map((cxc) => ({ id: cxc.cxCID, balance: cxc.balancePendiente, fechaOrigen: cxc.fechaOrigen, fechaVencimiento: cxc.fechaVencimiento })), amountToApply: cxcTotal }) : null;
  const autoById = new Map((autoAllocation?.allocations || []).map((row) => [row.id, row.amountApplied]));
  target.innerHTML = rows
    .map(
      (cxc) => `
        <article class="list-item payroll-cxc-row">
          <div>
            <strong>${cxc.cxCID} · ${cxc.concepto || cxc.tipoCxC}</strong>
            <span>Origen ${dateOnly(cxc.fechaOrigen) || "-"} · Pendiente ${money.format(Number(cxc.balancePendiente) || 0)}</span>
          </div>
          <input class="payroll-cxc-discount" data-cxc-id="${cxc.cxCID}" type="number" min="0" max="${Number(cxc.balancePendiente) || 0}" step="0.01" value="${autoById.get(cxc.cxCID) || 0}" />
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
  byId("payroll-vacation-offset").textContent = money.format(data.vacationOffset);
  byId("payroll-tss-preview").textContent = money.format(data.tssEmployee);
  byId("payroll-sales-preview").textContent = money.format(data.sales);
  byId("payroll-rate-preview").textContent = `${(data.rate * 100).toFixed(2)}%`;
  byId("payroll-deductions-preview").textContent = money.format(data.deductions);
  byId("payroll-net-preview").textContent = money.format(data.net);
  byId("payroll-tss-day15-note").classList.toggle("hidden", data.cut !== "first");
  byId("payroll-tss-missing-note").classList.toggle("hidden", data.cut === "first" || Boolean(data.tssConfig));
  return data;
}

function renderPayroll() {
  const target = byId("payroll-table");
  const query = byId("payroll-search").value;
  const rows = dbTable("nomina")
    .filter((row) => matches(row, query, ["periodoInicio", "colaboradorNombre", "quincena"]))
    .sort((a, b) => `${b.periodoInicio || ""} ${b.nominaID || ""}`.localeCompare(`${a.periodoInicio || ""} ${a.nominaID || ""}`));
  if (!rows.length) return renderEmpty(target, 10, "No hay nóminas registradas.");
  target.innerHTML = rows
    .map((row) => {
      // Compatibilidad historica: registros creados antes de este cambio
      // solo pudieron quedar en Borrador/Pagada/Revertida (nunca hubo
      // Aprobada todavia); nunca se reinterpretan como Aprobadas sin
      // evidencia, asi que una Borrador antigua sigue exigiendo el mismo
      // paso explicito de Aprobar antes de poder pagarse.
      const estado = row.estado || "Borrador";
      const normalizedEstado = normalize(estado);
      const canApprove = normalizedEstado === "borrador";
      const canReopen = normalizedEstado === "aprobada";
      const canPay = normalizedEstado === "aprobada";
      const canRevert = normalizedEstado === "pagada";
      const tssBlock = canPay ? payrollTssBlockReason(row) : "";
      return `
        <tr data-payroll-id="${row.nominaID}">
          <td>${row.periodoInicio || ""}</td>
          <td>${row.quincena || "Mes completo"}</td>
          <td>${row.colaboradorNombre}</td>
          <td>${money.format(Number(row.salarioQuincenal) || 0)}</td>
          <td>${money.format(Number(row.comisionGenerada) || 0)}</td>
          <td>${money.format(Number(row.propinaNetaMes) || 0)}</td>
          <td>${money.format((Number(row.anticipos) || 0) + (Number(row.descuentoAFP) || 0) + (Number(row.descuentoSeguro) || 0) + (Number(row.descuentoOtros) || 0) + (Number(row.descuentoCxC) || 0))}</td>
          <td class="amount">${money.format(Number(row.totalAPagar) || 0)}</td>
          <td>${estado}${tssBlock ? ` <span class="danger">· sin TSS</span>` : ""}</td>
          <td class="row-actions">
            ${canApprove ? `<button class="secondary-btn compact approve-payroll" type="button">Aprobar</button>` : ""}
            ${canReopen ? `<button class="secondary-btn compact reopen-payroll" type="button">Reabrir</button>` : ""}
            ${canPay ? `<button class="secondary-btn compact pay-payroll" type="button" ${tssBlock ? `disabled title="${escapeHtml(tssBlock)}"` : ""}>Pagar</button>` : ""}
            ${canRevert ? `<button class="secondary-btn compact revert-payroll" type="button">Revertir</button>` : ""}
          </td>
        </tr>
      `;
    })
    .join("");
}

// Fila de tabla para un cierre de caja registradora. Los totales ya estan
// congelados en el registro (o recien recalculados por refreshPendingClosingsForDate).
function registerClosingRowHtml(closing) {
  const date = closingBusinessDate(closing);
  const expected = Number(closing.balanceTeorico) || 0;
  const counted = Number(closing.balanceContado) || 0;
  const cardCounted = Number(closing.tarjetaContada) || 0;
  const expenses = Number(closing.egresos) || 0;
  const shortage = Number(closing.cuadreFaltante) || 0;
  const surplus = Number(closing.sobranteCaja) || 0;
  const difference = Number(closing.diferencia) || 0;
  const status = closing.estado || "Pendiente de confirmacion";
  const pending = isClosingPendingConfirmation(closing);
  const actions = [
    `<button class="secondary-btn compact view-closing" data-closing-id="${escapeHtml(closing.cierreID || "")}" type="button">Ver</button>`,
    pending && canConfirmClosings() ? `<button class="secondary-btn compact edit-closing" data-closing-id="${escapeHtml(closing.cierreID || "")}" type="button">Editar</button>` : "",
    pending && canConfirmClosings() ? `<button class="secondary-btn compact confirm-closing" data-closing-id="${escapeHtml(closing.cierreID || "")}" type="button">Confirmar</button>` : "",
    !pending && canReopenClosings() ? `<button class="secondary-btn compact open-closing" data-closing-id="${escapeHtml(closing.cierreID || "")}" type="button">Reabrir</button>` : "",
  ].filter(Boolean).join("");
  return `
    <tr>
      <td>${date}</td>
      <td>Caja registradora</td>
      <td>${money.format(expected)}</td>
      <td>${money.format(counted)}</td>
      <td>${money.format(cardCounted)}</td>
      <td>${money.format(expenses)}</td>
      <td class="amount danger">${money.format(shortage)}</td>
      <td class="amount gold">${money.format(surplus)}</td>
      <td class="amount ${difference < 0 ? "danger" : "gold"}">${money.format(difference)}</td>
      <td>${escapeHtml(status)}${closing.confirmadoPor ? `<br /><span class="panel-note">${escapeHtml(closing.confirmadoPor)}</span>` : ""}</td>
      <td><div class="row-actions">${actions}</div></td>
    </tr>
  `;
}

// Fila de tabla para el cierre consolidado de tesoreria. "Contado tarjeta" no
// aplica aqui (esa cuenta se cuadra en el cierre de caja registradora), y
// "Confirmar" dispara la confirmacion en rango, no una individual.
function treasuryClosingRowHtml(closing) {
  const date = closingBusinessDate(closing);
  const totales = closing.totales || buildTreasuryTotals(closing.cuentas);
  const shortage = Math.max(0, -totales.diferencia);
  const surplus = Math.max(0, totales.diferencia);
  const status = closing.estado || "Pendiente de confirmacion";
  const pending = isClosingPendingConfirmation(closing);
  const accountCount = (closing.cuentas || []).length;
  const actions = [
    `<button class="secondary-btn compact view-closing" data-closing-id="${escapeHtml(closing.cierreID || "")}" type="button">Ver detalle (${accountCount})</button>`,
    pending && canConfirmClosings() ? `<button class="secondary-btn compact confirm-treasury" data-closing-id="${escapeHtml(closing.cierreID || "")}" type="button">Confirmar rango</button>` : "",
    !pending && canReopenClosings() ? `<button class="secondary-btn compact open-closing" data-closing-id="${escapeHtml(closing.cierreID || "")}" type="button">Reabrir</button>` : "",
  ].filter(Boolean).join("");
  return `
    <tr>
      <td>${date}</td>
      <td>Consolidado tesorería</td>
      <td>${money.format(totales.saldoEsperado)}</td>
      <td>${money.format(totales.saldoReal)}</td>
      <td>-</td>
      <td>${money.format(totales.egresos)}</td>
      <td class="amount danger">${money.format(shortage)}</td>
      <td class="amount gold">${money.format(surplus)}</td>
      <td class="amount ${totales.diferencia < 0 ? "danger" : "gold"}">${money.format(totales.diferencia)}</td>
      <td>${escapeHtml(status)}${closing.confirmadoPor ? `<br /><span class="panel-note">${escapeHtml(closing.confirmadoPor)}</span>` : ""}</td>
      <td><div class="row-actions">${actions}</div></td>
    </tr>
  `;
}

function needsReviewRowHtml(closing) {
  const date = closingBusinessDate(closing);
  return `
    <tr class="needs-review">
      <td>${date}</td>
      <td>${escapeHtml(closing.cuentaCaja || closing.closingType || "Sin clasificar")}</td>
      <td colspan="6">Cierre antiguo duplicado para este día — no se perdió, pero necesita revisión manual porque ya existía otro cierre del mismo tipo.</td>
      <td><span class="status-pill warning">Necesita revisión</span></td>
      <td><div class="row-actions"><button class="secondary-btn compact view-closing" data-closing-id="${escapeHtml(closing.cierreID || "")}" type="button">Ver</button></div></td>
    </tr>
  `;
}

// Agrupa por fecha y muestra EXACTAMENTE dos filas por dia: caja registradora
// y consolidado de tesoreria. Ninguna cuenta bancaria, caja fuerte o caja
// chica aparece como fila propia: viven dentro del detalle del consolidado.
function renderCash() {
  let target = null;
  try {
    target = cashTableTarget();
    if (!target) {
      const cashView = ensureViewShell("cash");
      if (cashView) {
        cashView.innerHTML = `
          <section class="panel panel-wide">
            <div class="panel-head">
              <h3>Cierres diarios</h3>
            </div>
            <p class="form-message error">No se pudo inicializar el listado de cierres. Recarga la pantalla y vuelve a entrar a Cierres de caja.</p>
          </section>
        `;
      }
      return;
    }
    bindCashTableActions(target);
    renderEmpty(target, 11, "Cargando cierres...");
    if (supabaseClient && supabaseSession && !canManageInvoices()) {
      renderEmpty(target, 11, "Solo administradores y propietarios pueden ver los cierres.");
      return;
    }
    const created = ensureProvisionalClosings();
    if (created) {
      state = stateFromDatabase(database);
      saveState();
    }
    const allClosings = dbTable("cierres");
    const reviewClosings = allClosings.filter((closing) => closing.needsReview);
    const byDate = new Map();
    allClosings
      .filter((closing) => !closing.needsReview)
      .forEach((closing) => {
        const date = closingBusinessDate(closing);
        if (!date) return;
        if (!byDate.has(date)) byDate.set(date, {});
        if (closing.closingType === "register") byDate.get(date).register = closing;
        else if (closing.closingType === "treasury") byDate.get(date).treasury = closing;
      });
    const dates = [...byDate.keys()].sort().reverse();
    if (!dates.length && !reviewClosings.length) {
      return renderEmpty(target, 11, "No hay cierres registrados. Usa Crear cierres automaticos para generarlos desde los registros existentes.");
    }
    const rowsHtml = [];
    dates.forEach((date) => {
      const entry = byDate.get(date);
      if (entry.register) rowsHtml.push(registerClosingRowHtml(entry.register));
      if (entry.treasury) rowsHtml.push(treasuryClosingRowHtml(entry.treasury));
    });
    if (reviewClosings.length) {
      rowsHtml.push(`<tr><td colspan="11" class="panel-note">Cierres antiguos por revisar (${reviewClosings.length})</td></tr>`);
      reviewClosings
        .sort((a, b) => String(closingBusinessDate(b)).localeCompare(String(closingBusinessDate(a))))
        .forEach((closing) => rowsHtml.push(needsReviewRowHtml(closing)));
    }
    target.innerHTML = rowsHtml.join("");
  } catch (error) {
    console.error("Error cargando cierres", error);
    if (target) {
      renderEmpty(target, 11, `No se pudo cargar el listado de cierres: ${escapeHtml(error?.message || String(error))}`);
    } else {
      const cashView = ensureViewShell("cash");
      if (cashView) {
        cashView.innerHTML = `
          <section class="panel panel-wide">
            <div class="panel-head">
              <h3>Cierres diarios</h3>
            </div>
            <p class="form-message error">No se pudo cargar el modulo de cierres: ${escapeHtml(error?.message || String(error))}</p>
          </section>
        `;
      }
    }
  }
}

function openClosingForEdit(closingId) {
  if (!canReopenClosings()) {
    alert("Solo administración o propietario con permiso para reabrir cierres puede hacerlo.");
    return;
  }
  const closing = dbTable("cierres").find((row) => row.cierreID === closingId);
  if (!closing) return;
  if (isClosingPendingConfirmation(closing)) {
    alert("Este cierre ya está sin confirmar; no hace falta reabrirlo.");
    return;
  }
  const reason = prompt(`¿Por qué reabres el cierre de ${dateOnly(closing.fechaHoraCierre)}? Esto permitirá editar facturas de ese día.`, "");
  if (reason === null) return;
  if (!reason.trim()) {
    alert("Debes indicar el motivo de la reapertura.");
    return;
  }
  const previousConfirmation = {
    tipo: "confirmacion",
    por: closing.confirmadoPor || "",
    fecha: closing.fechaConfirmacion || "",
  };
  const reopening = {
    tipo: "reapertura",
    por: currentUserEmail(),
    fecha: new Date().toISOString(),
    motivo: reason.trim(),
  };
  closing.historialCierre = Array.isArray(closing.historialCierre) ? closing.historialCierre : [];
  if (closing.confirmadoPor && !closing.historialCierre.some((entry) => entry.tipo === "confirmacion" && entry.fecha === closing.fechaConfirmacion)) {
    closing.historialCierre.push(previousConfirmation);
  }
  closing.historialCierre.push(reopening);
  closing.estado = "Abierto para edición";
  closing.requiereConfirmacion = true;
  closing.abiertoPor = currentUserEmail();
  closing.fechaApertura = reopening.fecha;
  closing.motivoReapertura = reason.trim();
  stampRecord(closing, "updated");
  logAudit("closing_reopen", {
    entity: "cierres",
    entityId: closingId,
    oldData: previousConfirmation,
    newData: reopening,
    note: reason.trim(),
    success: true,
  });
  state = stateFromDatabase(database);
  saveState();
  renderAll();
  if (closing.closingType === "treasury") return;
  startClosingEdit(closingId);
}

// Confirma UN SOLO cierre de caja registradora. A diferencia del modelo
// anterior, esto nunca confirma en cascada otros dias pendientes: cada
// cierre de caja registradora se abre, revisa y confirma por separado.
function confirmSingleRegisterClosing(closing) {
  if (!canConfirmClosings() || !closing) return;
  closing.estado = "Cerrado";
  closing.requiereConfirmacion = false;
  closing.confirmadoPor = currentUserEmail();
  closing.fechaConfirmacion = new Date().toISOString();
  closing.historialCierre = Array.isArray(closing.historialCierre) ? closing.historialCierre : [];
  closing.historialCierre.push({ tipo: "confirmacion", por: closing.confirmadoPor, fecha: closing.fechaConfirmacion });
  stampRecord(closing, "updated");
  logAudit("closing_register_confirm", {
    entity: "cierres",
    entityId: closing.cierreID,
    newData: { businessDate: closingBusinessDate(closing), confirmadoPor: closing.confirmadoPor, fechaConfirmacion: closing.fechaConfirmacion, cuadreFaltante: closing.cuadreFaltante, sobranteCaja: closing.sobranteCaja },
    success: true,
  });
}

function startClosingConfirmation(closingId) {
  if (!canConfirmClosings()) {
    alert("Solo administracion o propietario pueden confirmar cierres.");
    return;
  }
  const closing = dbTable("cierres").find((row) => row.cierreID === closingId);
  if (!closing) return;
  if (closing.closingType === "treasury") {
    confirmTreasuryRange(closingId);
    return;
  }
  if (!isClosingPendingConfirmation(closing)) {
    alert("Este cierre ya está confirmado.");
    return;
  }
  loadClosingIntoCashForm(closing, { readOnly: false, confirmAfterSave: true, submitText: "Confirmar y cerrar" });
  byId("cash-counted").focus();
}

// Confirmacion en rango de cierres consolidados de tesoreria: certifica de
// una vez todos los cierres de tesoreria pendientes desde el dia siguiente al
// ultimo confirmado hasta la fecha del cierre seleccionado. Requisito previo
// obligatorio: todos los cierres de caja registradora de esas fechas deben
// estar confirmados individualmente; si falta alguno, bloquea la operacion
// completa (no confirma parcialmente) y muestra que fechas faltan.
function confirmTreasuryRange(closingId) {
  if (!canConfirmClosings()) {
    alert("Solo administracion o propietario pueden confirmar cierres.");
    return;
  }
  const target = dbTable("cierres").find((row) => row.cierreID === closingId && row.closingType === "treasury");
  if (!target) return;
  if (!isClosingPendingConfirmation(target)) {
    alert("Este cierre consolidado ya está confirmado.");
    return;
  }
  const targetDate = closingBusinessDate(target);
  const closingsForMath = dbTable("cierres")
    .filter((row) => row.closingType === "treasury" && !row.needsReview)
    .map((row) => ({ businessDate: closingBusinessDate(row), pending: isClosingPendingConfirmation(row) }));
  const range = DalfiClosingMath.pendingTreasuryRange(closingsForMath, targetDate);
  if (!range.length) {
    alert("No hay cierres consolidados pendientes en ese rango.");
    return;
  }
  const missingRegister = DalfiClosingMath.missingRegisterDatesForRange(range, (date) => {
    const reg = registerClosingForDate(date);
    if (!reg) return "missing";
    return isClosingPendingConfirmation(reg) ? "pending" : "confirmed";
  });
  if (missingRegister.length) {
    alert(
      `No se puede confirmar el rango consolidado (${range[0]} a ${range[range.length - 1]}) porque falta confirmar el cierre de caja registradora de: ${missingRegister.join(", ")}.\n\nAbre y confirma primero esos cierres de caja registradora individualmente desde esta misma pantalla.`,
    );
    logAudit("closing_treasury_confirm_blocked", {
      entity: "cierres",
      entityId: closingId,
      newData: { rango: range, faltantes: missingRegister },
      success: false,
      note: `Bloqueado: faltan cierres de caja registradora confirmados en ${missingRegister.join(", ")}.`,
    });
    renderAll();
    return;
  }
  const dateList = range.join(", ");
  if (!confirm(`Esto confirmará los cierres consolidados de tesorería del ${range[0]} al ${range[range.length - 1]} (${dateList}). ¿Continuar?`)) return;
  const loteConfirmacionID = `LOTE-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  const now = new Date().toISOString();
  const confirmedDates = [];
  range.forEach((date) => {
    const closing = treasuryClosingForDate(date);
    if (!closing || !isClosingPendingConfirmation(closing)) return; // idempotente: nunca reconfirma uno ya cerrado
    // Recalcula el saldo inicial (y todo lo derivado) de cada cuenta desde
    // la fuente confiable justo antes de confirmar, nunca desde lo que haya
    // quedado guardado: dentro de este mismo rango, confirmar una fecha
    // anterior cambia cual es "el cierre anterior confirmado" de la
    // siguiente fecha, asi que cada una se recalcula en el momento y en
    // orden (range ya viene ordenado de mas antigua a mas reciente).
    const refreshedCuentas = (closing.cuentas || []).map((row) => {
      const account = findAccountByName(row.nombreCuenta) || { cuentaID: row.cuentaID, nombreCuenta: row.nombreCuenta };
      const fresh = buildTreasuryAccountDetail(date, account);
      return { ...fresh, ajustes: Number(row.ajustes) || 0, observaciones: row.observaciones || "", saldoReal: row.saldoReal ?? fresh.saldoReal };
    });
    closing.cuentas = refreshedCuentas;
    closing.totales = buildTreasuryTotals(refreshedCuentas);
    closing.estado = "Cerrado";
    closing.requiereConfirmacion = false;
    closing.confirmadoPor = currentUserEmail();
    closing.fechaConfirmacion = now;
    closing.loteConfirmacionID = loteConfirmacionID;
    closing.historialCierre = Array.isArray(closing.historialCierre) ? closing.historialCierre : [];
    closing.historialCierre.push({ tipo: "confirmacion", por: closing.confirmadoPor, fecha: now, lote: loteConfirmacionID });
    stampRecord(closing, "updated");
    confirmedDates.push(date);
    logAudit("closing_treasury_confirm_range", {
      entity: "cierres",
      entityId: closing.cierreID,
      newData: { businessDate: date, loteConfirmacionID },
      note: `Confirmacion en lote ${loteConfirmacionID}.`,
      success: true,
    });
  });
  state = stateFromDatabase(database);
  saveState();
  renderAll();
  alert(`Se confirmaron ${confirmedDates.length} cierre(s) consolidados de tesorería (${dateList}). Referencia de lote: ${loteConfirmacionID}.`);
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
    alert("Solo administración o propietario pueden crear cierres pendientes.");
    return;
  }
  const created = ensureProvisionalClosings();
  state = stateFromDatabase(database);
  saveState();
  renderAll();
  alert(created ? `Se generaron/actualizaron ${created} cierre(s) pendiente(s) (caja registradora y consolidado de tesorería, maximo dos por día).` : "Todos los días pendientes ya tienen sus dos cierres creados.");
}

function showNewCashClosing() {
  if (!canManageInvoices()) {
    alert("Solo administradores y propietarios pueden hacer cierres de caja.");
    return;
  }
  const created = ensureProvisionalClosings();
  state = stateFromDatabase(database);
  if (created) saveState();
  const defaultAccount = registerAccount();
  const existingClosing = registerClosingForDate(today);
  if (existingClosing) {
    loadClosingIntoCashForm(existingClosing, {
      readOnly: !isClosingPendingConfirmation(existingClosing),
      confirmAfterSave: false,
      submitText: isClosingPendingConfirmation(existingClosing) ? "Actualizar cierre" : "Guardar cierre",
    });
    if (!isClosingPendingConfirmation(existingClosing)) setClosingViewActions(existingClosing);
    return;
  }
  byId("cash-form").classList.remove("hidden");
  byId("cash-form").reset();
  delete byId("cash-form").dataset.recordVersion;
  setCashFormReadOnly(false);
  setClosingViewActions(null);
  byId("cash-edit-id").value = "";
  byId("cash-confirm-after-save").value = "";
  byId("cash-submit").textContent = "Guardar cierre";
  byId("cash-submit").classList.remove("hidden");
  byId("cash-date").value = today;
  byId("cash-account").value = defaultAccount?.nombreCuenta || "";
  byId("cash-initial").textContent = money.format(defaultInitialCashFor(defaultAccount, today));
  byId("cash-expenses").textContent = money.format(0);
  byId("cash-card-counted").value = 0;
  byId("cash-transfer-counted").value = 0;
  resetCashBalancePreview();
  updateClosingCollaboratorDetails(today);
  updateAddExpenseButtonState(null);
  revealFormAtTop(byId("cash-form"), { focusSelector: "#cash-counted" });
}

function hideCashClosingForm() {
  byId("cash-form").classList.add("hidden");
  byId("cash-form").reset();
  setCashFormReadOnly(false);
  setClosingViewActions(null);
  byId("cash-edit-id").value = "";
  byId("cash-confirm-after-save").value = "";
  byId("cash-submit").textContent = "Guardar cierre";
  byId("cash-submit").classList.remove("hidden");
  byId("cash-date").value = today;
  byId("cash-account").value = "";
  byId("cash-initial").textContent = money.format(0);
  if (byId("cash-expenses")) byId("cash-expenses").textContent = money.format(0);
  resetCashBalancePreview();
  byId("cash-collaborator-detail")?.classList.add("hidden");
  cashPendingExpenseReturn = null;
  updateAddExpenseButtonState(null);
}

function cashFormFieldIds() {
  return [
    "cash-date",
    "cash-account",
    "cash-counted",
    // "cash-initial" y "cash-expenses" ya no estan aqui: ambos son <output>
    // (Monto inicial / Egresos del dia), no controles de formulario con
    // .disabled — siempre son de solo lectura, calculados.
    "generate-cash-balance",
    "cash-shortage-note",
    "cash-rectified-counted",
    "cash-card-counted",
    "cash-card-processor",
    "cash-card-batch",
    "cash-transfer-counted",
    "cash-note",
  ];
}

function setCashFormReadOnly(readOnly) {
  cashFormFieldIds().forEach((id) => {
    const field = byId(id);
    if (field) field.disabled = readOnly;
  });
}

function setClosingViewActions(closing) {
  const actions = byId("cash-view-actions");
  if (!actions) return;
  const pending = isClosingPendingConfirmation(closing);
  const canConfirm = canConfirmClosings();
  const canReopen = canReopenClosings();
  actions.classList.toggle("hidden", !closing);
  byId("cash-modify-closing").classList.toggle("hidden", !(closing && pending && canConfirm));
  byId("cash-confirm-closing").classList.toggle("hidden", !(closing && pending && canConfirm));
  byId("cash-open-closing").classList.toggle("hidden", !(closing && !pending && canReopen));
  byId("cash-modify-closing").dataset.closingId = closing?.cierreID || "";
  byId("cash-confirm-closing").dataset.closingId = closing?.cierreID || "";
  byId("cash-open-closing").dataset.closingId = closing?.cierreID || "";
}

// "Agregar egreso" reutiliza el permiso operativo mas cercano ya existente
// (canManageInvoices: el mismo que ya exige crear/editar cierres de caja).
// No existia un permiso especifico de "registrar egresos" en erp_user_profiles
// para esta fase; documentado aqui la decision de reutilizar este en vez de
// inventar uno nuevo. El boton nunca aparece para un cierre ya CONFIRMADO
// (ahi se muestra la nota explicativa en su lugar), sin importar el permiso.
function updateAddExpenseButtonState(closing) {
  const button = byId("cash-add-expense");
  const note = byId("cash-add-expense-closed-note");
  if (!button) return;
  const hasPermission = canManageInvoices();
  const confirmed = Boolean(closing) && !isClosingPendingConfirmation(closing);
  const canAdd = hasPermission && !confirmed;
  button.classList.toggle("hidden", !canAdd);
  button.disabled = !canAdd;
  note?.classList.toggle("hidden", !(hasPermission && confirmed));
}

// Estado temporal (solo en memoria, nunca persistido) del formulario de
// cierre mientras el usuario esta en el formulario normal de egresos porque
// pulso "Agregar egreso". Permite volver exactamente a donde estaba: fecha,
// caja, monto real contado y notas ya escritas, sin haber guardado el
// cierre solo por haber abierto el formulario de egreso (ver seccion 8 de
// la mejora: abrir el formulario de egreso NUNCA debe guardar el cierre).
let cashPendingExpenseReturn = null;

function openAddExpenseFromClosing() {
  if (!canManageInvoices()) return;
  const closingId = byId("cash-edit-id").value;
  const closing = closingId ? dbTable("cierres").find((row) => row.cierreID === closingId) : null;
  if (closing && !isClosingPendingConfirmation(closing)) return; // cierre confirmado: no permitido

  cashPendingExpenseReturn = {
    date: byId("cash-date").value,
    account: byId("cash-account").value,
    counted: byId("cash-counted").value,
    note: byId("cash-note")?.value || "",
    shortageNote: byId("cash-shortage-note")?.value || "",
    rectifiedCounted: byId("cash-rectified-counted")?.value || "",
    editId: byId("cash-edit-id").value,
    confirmAfterSave: byId("cash-confirm-after-save").value,
    submitText: byId("cash-submit").textContent,
  };

  // Formulario NORMAL de egresos: mismo elemento (#expense-form), mismas
  // validaciones y funcion de guardado que usa el modulo Egresos. Solo se
  // precargan fecha y cuenta de origen; el resto queda en blanco para un
  // egreso nuevo (nunca arrastra datos de una edicion anterior).
  byId("expense-form").reset();
  byId("expense-edit-id").value = "";
  byId("expense-submit").textContent = "Guardar egreso";
  byId("expense-date").value = cashPendingExpenseReturn.date || today;
  byId("expense-source").value = cashPendingExpenseReturn.account || "";
  updateExpenseOptionalFields();
  updateExpenseBalancePreview();

  switchToView("expenses");
  byId("cash-add-expense-banner")?.classList.remove("hidden");
  // El boton vive junto a "Guardar egreso" al final del formulario (ver
  // #expense-form-actions), no dentro del banner de arriba: se muestra/oculta
  // por separado del texto informativo.
  byId("cash-add-expense-cancel")?.classList.remove("hidden");
  revealFormAtTop(byId("expense-form"), { focusSelector: "#expense-amount" });
}

// Se llama tanto al cancelar (sin guardar nada) como despues de guardar el
// egreso con exito (enganchado en los dos caminos de exito del submit de
// #expense-form). En ambos casos vuelve al MISMO cierre con exactamente los
// mismos valores que tenia, y si habia un monto contado escrito, recalcula
// el cuadre (Monto inicial/Egresos del dia/Monto esperado ya son siempre
// calculados, nunca leidos del DOM).
function returnToClosingAfterExpense() {
  byId("cash-add-expense-banner")?.classList.add("hidden");
  byId("cash-add-expense-cancel")?.classList.add("hidden");
  if (!cashPendingExpenseReturn) {
    switchToView("cash");
    return;
  }
  const snapshot = cashPendingExpenseReturn;
  cashPendingExpenseReturn = null;
  switchToView("cash");
  byId("cash-form").classList.remove("hidden");
  byId("cash-date").value = snapshot.date;
  byId("cash-account").value = snapshot.account;
  byId("cash-counted").value = snapshot.counted;
  if (byId("cash-note")) byId("cash-note").value = snapshot.note;
  if (byId("cash-shortage-note")) byId("cash-shortage-note").value = snapshot.shortageNote;
  if (byId("cash-rectified-counted")) byId("cash-rectified-counted").value = snapshot.rectifiedCounted;
  byId("cash-edit-id").value = snapshot.editId;
  byId("cash-confirm-after-save").value = snapshot.confirmAfterSave;
  byId("cash-submit").textContent = snapshot.submitText;
  const account = findAccountByName(snapshot.account) || registerAccount();
  byId("cash-initial").textContent = money.format(defaultInitialCashFor(account, snapshot.date));
  updateCashBalancePreview();
  const closing = snapshot.editId ? dbTable("cierres").find((row) => row.cierreID === snapshot.editId) : registerClosingForDate(snapshot.date);
  updateAddExpenseButtonState(closing);
  revealFormAtTop(byId("cash-form"), { focusSelector: null });
}

function loadClosingIntoCashForm(closing, { readOnly = false, confirmAfterSave = false, submitText = "Actualizar cierre" } = {}) {
  const date = dateOnly(closing.fechaHoraCierre);
  const account = findAccountByName(closing.cuentaCaja) || accountForPayment("efectivo");
  const activity = accountActivityForDate(date, account);
  const summary = dailyIncomeSummary(date);
  byId("cash-form").classList.remove("hidden");
  byId("cash-form").dataset.recordVersion = closing.fechaActualizacion || closing.fechaCreacion || "";
  byId("cash-edit-id").value = closing.cierreID;
  byId("cash-confirm-after-save").value = confirmAfterSave ? "true" : "";
  byId("cash-submit").textContent = submitText;
  byId("cash-submit").classList.toggle("hidden", readOnly);
  byId("cash-date").value = date;
  byId("cash-account").value = closing.cuentaCaja || account.nombreCuenta || "";
  // Si el cierre esta abierto para edicion (nuevo, pendiente, o reabierto),
  // Monto inicial y Egresos del dia SIEMPRE se recalculan desde la fuente
  // confiable, nunca desde closing.balanceInicial/closing.egresos ya
  // guardados (que pudieron quedar desactualizados si aparecio un cierre
  // anterior nuevo, o si se agrego/edito/anulo un egreso). Solo al ver un
  // cierre YA CONFIRMADO en modo de solo lectura se muestran los valores
  // historicos congelados tal cual quedaron, sin recalcularlos ni
  // reescribirlos (nunca se alteran cierres confirmados, ni siquiera solo
  // con abrirlos para verlos: por eso aqui abajo NO se llama a
  // updateCashBalancePreview() cuando readOnly, que si recalcularia todo).
  const montoInicialForForm = readOnly ? Number(closing.balanceInicial) || 0 : defaultInitialCashFor(account, date);
  const egresosForForm = readOnly ? Number(closing.egresos) || 0 : activity.expenses + activity.transferOut;
  byId("cash-initial").textContent = money.format(montoInicialForForm);
  byId("cash-expenses").textContent = money.format(egresosForForm);
  const expectedForPrefill = DalfiClosingMath.computeExpectedCash({ montoInicial: montoInicialForForm, entradasEfectivo: activity.income + activity.transferIn, salidasEfectivo: egresosForForm });
  byId("cash-counted").value = Number(closing.conteoInicial) || Number(closing.balanceContado) || (confirmAfterSave ? expectedForPrefill : 0);
  byId("cash-card-counted").value = Number(closing.tarjetaContada) || (confirmAfterSave ? summary.card : 0);
  byId("cash-card-processor").value = closing.procesadorTarjeta || "";
  byId("cash-card-batch").value = closing.loteTarjeta || "";
  byId("cash-transfer-counted").value = Number(closing.transferenciaContada) || (confirmAfterSave ? summary.transfer : 0);
  byId("cash-note").value = closing.observaciones || "";
  byId("cash-shortage-note").value = closing.motivoFaltante || "";
  byId("cash-rectified-counted").value = Number(closing.balanceContadoRectificado) || "";
  setCashFormReadOnly(readOnly);
  if (readOnly) {
    byId("cash-balance-panel")?.classList.remove("hidden");
    byId("cash-initial-preview").textContent = money.format(montoInicialForForm);
    byId("cash-income-preview").textContent = money.format(Number(closing.ingresosConfirmados) || 0);
    byId("cash-expenses-preview").textContent = money.format(egresosForForm);
    byId("cash-expected-preview").textContent = money.format(Number(closing.balanceTeorico) || 0);
    byId("cash-difference-preview").textContent = money.format(Number(closing.diferencia) || 0);
    byId("cash-shortage-preview").textContent = money.format(Number(closing.cuadreFaltante) || 0);
    byId("cash-surplus-preview").textContent = money.format(Number(closing.sobranteCaja) || 0);
    byId("cash-user-preview").textContent = closing.confirmadoPor || "";
    byId("cash-confirmed-at-preview").textContent = closing.fechaConfirmacion ? new Date(closing.fechaConfirmacion).toLocaleString("es-DO") : "Sin confirmar";
    byId("cash-shortage-label")?.classList.toggle("hidden", (Number(closing.cuadreFaltante) || 0) <= 0);
    const detail = accountActivityDetailForDate(date, account);
    renderCashActivityDetailList(byId("cash-income-detail"), detail.incomeRows);
    renderCashActivityDetailList(byId("cash-expense-detail"), detail.expenseRows);
  } else {
    updateCashBalancePreview();
  }
  updateClosingCollaboratorDetails(date);
  setClosingViewActions(readOnly ? closing : null);
  updateAddExpenseButtonState(closing);
  revealFormAtTop(byId("cash-form"), { focusSelector: readOnly ? null : "#cash-counted" });
}

function viewClosingInForm(closingId) {
  if (!canManageInvoices()) {
    alert("Solo administradores y propietarios pueden ver los cierres.");
    return;
  }
  const closing = dbTable("cierres").find((row) => row.cierreID === closingId);
  if (!closing) return;
  if (closing.closingType === "treasury") {
    openClosingReport(closingId);
    return;
  }
  loadClosingIntoCashForm(closing, { readOnly: true, submitText: "Guardar cierre" });
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
  if (closing.closingType === "treasury") {
    openClosingReport(closingId);
    return;
  }
  loadClosingIntoCashForm(closing, { readOnly: false, submitText: "Actualizar cierre" });
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
              ${editable ? '<button class="secondary-btn compact edit-expense" type="button">Editar</button>' : ""}
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

function voidReceivableReceipt(incomeId) {
  if (!canManageInvoices()) {
    alert("Solo administración o propietario puede anular recibos de cobros.");
    return;
  }
  const income = dbTable("ingresos").find((row) => row.ingresoID === incomeId);
  if (!income) return;
  if (!canManageReceivableReceipt(income)) {
    alert("Este recibo pertenece a un día con cierre confirmado. Primero administración debe abrir o quitar el cierre.");
    return;
  }
  const applications = dbTable("ingresoAplicaciones").filter((row) => row.ingresoID === incomeId && row.cxCID);
  if (!applications.length) {
    alert("Este ingreso no tiene aplicaciones de cuenta por cobrar para anular.");
    return;
  }
  // Bloqueo previo (antes de tocar nada y antes del confirm): si alguna
  // porcion de propina financiada por este recibo ya se pago en nomina, no
  // se puede reversar en silencio. Se revisa TODO el recibo antes de
  // mutar cualquier fila, para no dejar una reversion a medias.
  const blockedReason = applications.map((application) => invoiceTipReversalBlockedReason(dbTable("cuentasCobrar").find((row) => row.cxCID === application.cxCID))).find(Boolean);
  if (blockedReason) {
    alert(blockedReason);
    return;
  }
  if (!confirm(`Anular el recibo ${incomeId} devolverá el balance a la cuenta por cobrar. ¿Continuar?`)) return;
  const totalReversed = applications.reduce((sum, application) => sum + (Number(application.montoAplicado) || 0), 0);
  const affectedInvoiceIds = [...new Set(applications.map((application) => application.facturaID).filter(Boolean))];
  applications.forEach((application) => {
    const amount = Number(application.montoAplicado) || 0;
    const cxc = dbTable("cuentasCobrar").find((row) => row.cxCID === application.cxCID);
    if (cxc) {
      cxc.montoAplicado = Math.max(0, (Number(cxc.montoAplicado) || 0) - amount);
      cxc.balancePendiente = Math.max(0, (Number(cxc.balancePendiente) || 0) + amount);
      cxc.estado = cxc.balancePendiente > 0 && cxc.montoAplicado > 0 ? "Parcial" : "Pendiente";
      stampRecord(cxc, "updated");
    }
    if (application.facturaID) {
      const invoice = state.invoices.find((item) => item.id === application.facturaID);
      if (invoice) invoice.paid = Math.max(0, (Number(invoice.paid) || 0) - amount);
      const dbInvoice = dbTable("facturas").find((item) => item.facturaID === application.facturaID);
      if (dbInvoice) {
        // Una CxC de "Propina pendiente" nunca debe revertirse como si fuera
        // saldo BASE: reverseInvoiceTipCollection() deshace exactamente la
        // porcion de propina que este cobro financio en cada colaboradora.
        if (cxc?.esPropinaPendiente) {
          reverseInvoiceTipCollection(dbInvoice, cxc);
        } else {
          dbInvoice.totalPagadoConfirmado = Math.max(0, (Number(dbInvoice.totalPagadoConfirmado) || 0) - amount);
          dbInvoice.totalCxC = Math.max(0, (Number(dbInvoice.totalCxC) || 0) + amount);
        }
        dbInvoice.estadoFactura = dbInvoice.totalCxC > 0 || (Number(dbInvoice.propinaPendiente) || 0) > 0 ? "Parcial" : "Crédito";
        stampRecord(dbInvoice, "updated");
      }
    }
    application.estado = "Anulado";
    application.observaciones = `${application.observaciones || ""} Anulado por ${currentUserEmail()} ${new Date().toISOString()}`.trim();
    stampRecord(application, "updated");
    if (application.pagoID) {
      const payment = dbTable("pagosFactura").find((row) => row.pagoID === application.pagoID);
      if (payment) {
        payment.estado = "Anulado";
        payment.montoBruto = 0;
        payment.montoNeto = 0;
        payment.observaciones = `${payment.observaciones || ""} Anulado junto al recibo ${incomeId}`.trim();
        stampRecord(payment, "updated");
      }
    }
  });
  income.estado = "Anulado";
  income.montoBrutoOriginal = income.montoBrutoOriginal || income.montoBruto;
  income.montoNetoOriginal = income.montoNetoOriginal || income.montoNeto;
  income.montoBruto = 0;
  income.montoNeto = 0;
  income.retencion = 0;
  income.observaciones = `${income.observaciones || ""} Recibo anulado por ${currentUserEmail()} ${new Date().toISOString()}`.trim();
  stampRecord(income, "updated");
  // Reversar un cobro es una accion financiera sensible (devuelve balance a
  // CxC, reduce lo confirmado de la factura): antes solo quedaba el rastro
  // implicito de stampRecord(...,"updated") en cada fila tocada, sin una
  // entrada explicita en auditoria como SI la tienen otras acciones de
  // reversion equivalentes (p. ej. closing_reopen en Cierres).
  logAudit("void_receivable_receipt", {
    entity: "ingresos",
    entityId: incomeId,
    oldData: { montoBruto: income.montoBrutoOriginal, montoNeto: income.montoNetoOriginal, aplicaciones: applications.length },
    newData: { totalReversado: totalReversed, facturasAfectadas: affectedInvoiceIds },
    note: `Recibo ${incomeId} anulado: se devolvió ${money.format(totalReversed)} a cuentas por cobrar.`,
    success: true,
  });
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
  byId("expense-destination-type").value = findBankAccountByName(expense.cuentaDestino) ? "bank" : "cash";
  byId("expense-amount").value = Number(expense.monto) || 0;
  byId("expense-concept").value = expense.concepto || "";
  byId("expense-note").value = expense.observaciones || "";
  byId("expense-submit").textContent = "Actualizar egreso";
  updateExpenseOptionalFields();
  updateExpenseBalancePreview();
  revealFormAtTop(byId("expense-form"), { focusSelector: "#expense-source" });
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

// ---------------------------------------------------------------------------
// Modulo "Cuentas": resumen de balances y movimientos, de solo lectura.
// Reutiliza el mismo modelo de datos y las mismas funciones de balance que
// ya usan cierres/reportes (accountAvailableBalance, accountActivityForDate,
// accountTransactions/accountOpeningBalance/accountPeriodSummary,
// defaultInitialCashFor, previousTreasurySaldoFor) en vez de duplicarlas.
// ---------------------------------------------------------------------------

function accountCategory(account) {
  if (isRegisterAccountName(account?.nombreCuenta)) return "registradora";
  const tipo = normalize(account?.tipoCuenta || "");
  if (tipo.includes("fuerte")) return "cajaFuerte";
  if (tipo.includes("chica")) return "cajaChica";
  if (isBankAccount(account)) return "banco";
  return isCashAccount(account) ? "otraCaja" : "otro";
}

function accountCategoryLabel(category) {
  return (
    {
      registradora: "Caja registradora",
      cajaChica: "Caja chica",
      cajaFuerte: "Caja fuerte",
      banco: "Banco",
      otraCaja: "Otra caja",
      otro: "Otra cuenta",
    }[category] || "Otra cuenta"
  );
}

function accountsConsolidatedSummary() {
  const totals = { registradora: 0, cajaChica: 0, cajaFuerte: 0, banco: 0, otros: 0 };
  activeAccounts().forEach((account) => {
    const balance = accountAvailableBalance(account.nombreCuenta);
    const category = accountCategory(account);
    if (category === "registradora") totals.registradora += balance;
    else if (category === "cajaChica") totals.cajaChica += balance;
    else if (category === "cajaFuerte") totals.cajaFuerte += balance;
    else if (category === "banco") totals.banco += balance;
    else totals.otros += balance;
  });
  const total = totals.registradora + totals.cajaChica + totals.cajaFuerte + totals.banco + totals.otros;
  return { ...totals, total };
}

function lastMovementForAccount(account) {
  const rows = accountTransactions(account, "0001-01-01", "9999-12-31", true);
  return rows.length ? rows[rows.length - 1] : null;
}

// Cierre CONFIRMADO mas reciente que incluye esta cuenta: el de caja
// registradora si es esa cuenta, o el detalle de esta cuenta dentro del
// consolidado de tesoreria mas reciente. No mira cierres pendientes/needsReview:
// esos todavia no son una conciliacion real.
function lastReconciliationForAccount(account) {
  if (isRegisterAccountName(account.nombreCuenta)) {
    const closing = dbTable("cierres")
      .filter((row) => row.closingType === "register" && !row.needsReview && row.confirmadoPor)
      .sort((a, b) => String(b.businessDate || "").localeCompare(String(a.businessDate || "")))[0];
    if (!closing) return null;
    return { date: closing.businessDate, diferencia: Number(closing.diferencia) || 0 };
  }
  const closings = dbTable("cierres")
    .filter((row) => row.closingType === "treasury" && !row.needsReview && row.confirmadoPor)
    .sort((a, b) => String(b.businessDate || "").localeCompare(String(a.businessDate || "")));
  for (const closing of closings) {
    const detail = (closing.cuentas || []).find((row) => accountKey({ cuentaID: row.cuentaID, nombreCuenta: row.nombreCuenta }) === accountKey(account));
    if (detail) return { date: closing.businessDate, diferencia: Number(detail.diferencia) || 0 };
  }
  return null;
}

function accountsOverviewFilters() {
  return {
    accountName: byId("accounts-filter-account")?.value.trim() || "",
    type: byId("accounts-filter-type")?.value || "",
    movement: byId("accounts-filter-movement")?.value || "",
    start: byId("accounts-filter-start")?.value || today,
    end: byId("accounts-filter-end")?.value || today,
  };
}

function filteredAccountsForOverview(filters) {
  return activeAccounts()
    .filter((account) => !filters.accountName || normalize(account.nombreCuenta).includes(normalize(filters.accountName)))
    .filter((account) => !filters.type || accountCategory(account) === filters.type);
}

function renderAccountsDailyBalancePanel(filters, accounts) {
  const hint = byId("accounts-daily-balance-hint");
  const summary = byId("accounts-daily-balance-summary");
  const singleAccount = accounts.length === 1 ? accounts[0] : null;
  if (filters.start !== filters.end || !singleAccount) {
    hint.classList.remove("hidden");
    summary.innerHTML = "";
    return;
  }
  hint.classList.add("hidden");
  const date = filters.start;
  const activity = accountActivityForDate(date, singleAccount);
  const balanceInicial = isRegisterAccountName(singleAccount.nombreCuenta)
    ? defaultInitialCashFor(singleAccount, date)
    : previousTreasurySaldoFor(singleAccount, date);
  const daily = DalfiClosingMath.computeAccountDailyBalance({
    balanceInicial,
    ingresos: activity.income,
    egresos: activity.expenses,
    transferenciasEntrantes: activity.transferIn,
    transferenciasSalientes: activity.transferOut,
    ajustesNetos: 0,
  });
  const closingForDateValue = isRegisterAccountName(singleAccount.nombreCuenta) ? registerClosingForDate(date) : treasuryClosingForDate(date);
  const confirmedDetail =
    closingForDateValue?.closingType === "treasury"
      ? (closingForDateValue.cuentas || []).find((row) => accountKey({ cuentaID: row.cuentaID, nombreCuenta: row.nombreCuenta }) === accountKey(singleAccount))
      : closingForDateValue;
  const isConfirmed = Boolean(closingForDateValue) && !isClosingPendingConfirmation(closingForDateValue);
  const balanceReal = isConfirmed ? Number(confirmedDetail?.saldoReal ?? confirmedDetail?.balanceContado) || 0 : null;
  const rows = [
    ["1. Balance inicial del día", daily.balanceInicial],
    ["2. Total de ingresos del día", daily.ingresos],
    ["3. Total de egresos del día", daily.egresos],
    ["4. Transferencias entrantes", daily.transferenciasEntrantes],
    ["5. Transferencias salientes", daily.transferenciasSalientes],
    ["6. Ajustes", daily.ajustesNetos],
    ["7. Balance final calculado", daily.balanceFinalCalculado],
  ];
  if (balanceReal !== null) {
    rows.push(["8. Balance real/conciliado", balanceReal]);
    rows.push(["9. Diferencia", balanceReal - daily.balanceFinalCalculado]);
  }
  summary.innerHTML =
    rows.map(([label, value]) => `<div class="summary-row"><span>${escapeHtml(label)}</span><strong>${money.format(value)}</strong></div>`).join("") +
    `<div class="summary-row"><span>10. Estado del cierre</span><strong>${escapeHtml(
      !closingForDateValue ? "Sin cierre generado" : isConfirmed ? "Confirmado" : "Pendiente de confirmación",
    )}</strong></div>`;
}

function renderAccountsMovementsTable(filters, accounts) {
  let rows = [];
  accounts.forEach((account) => {
    const opening = accountOpeningBalance(account, filters.start);
    const movements = accountTransactions(account, filters.start, filters.end)
      .filter((row) => !filters.movement || row.type === filters.movement)
      .map((row) => ({ ...row, income: row.credit, expense: row.debit, id: `${accountKey(account)}-${row.reference}-${row.date}` }));
    rows = rows.concat(DalfiClosingMath.buildRunningBalance(movements, opening).map((row) => ({ ...row, accountName: account.nombreCuenta })));
  });
  rows = DalfiClosingMath.sortMovementsDeterministically(rows);
  byId("accounts-movements-table").innerHTML = rows.length
    ? rows
        .map(
          (row) => `
            <tr>
              <td>${escapeHtml(row.date)}</td>
              <td>${escapeHtml(row.accountName)}</td>
              <td>${escapeHtml(row.type)}</td>
              <td>${escapeHtml(row.description)}</td>
              <td>${escapeHtml(row.reference)}</td>
              <td class="amount">${row.credit ? money.format(row.credit) : "-"}</td>
              <td class="amount danger">${row.debit ? money.format(row.debit) : "-"}</td>
              <td class="amount">${money.format(row.runningBalance)}</td>
            </tr>
          `,
        )
        .join("")
    : '<tr><td class="empty" colspan="8">Sin movimientos en el rango o filtro elegido.</td></tr>';
}

function renderAccountsView() {
  const section = byId("accounts-overview");
  if (!section) return;
  const cardsTarget = byId("accounts-cards");
  const consolidatedTarget = byId("accounts-consolidated");
  if (!canReviewAccountsUser()) {
    consolidatedTarget.innerHTML = "";
    cardsTarget.innerHTML = '<p class="empty">No tienes permiso para ver el módulo de Cuentas.</p>';
    byId("accounts-movements-table").innerHTML = "";
    byId("accounts-daily-balance-summary").innerHTML = "";
    byId("accounts-daily-balance-hint").classList.remove("hidden");
    return;
  }
  const consolidated = accountsConsolidatedSummary();
  consolidatedTarget.innerHTML = [
    ["Efectivo caja registradora", consolidated.registradora],
    ["Efectivo caja chica", consolidated.cajaChica],
    ["Efectivo caja fuerte", consolidated.cajaFuerte],
    ["Saldo en bancos", consolidated.banco],
    ["Total general de valores", consolidated.total],
  ]
    .map(([label, value]) => `<article class="metric"><span>${escapeHtml(label)}</span><strong>${money.format(value)}</strong></article>`)
    .join("");

  const filters = accountsOverviewFilters();
  const accounts = filteredAccountsForOverview(filters);
  cardsTarget.innerHTML = accounts.length
    ? accounts
        .map((account) => {
          const balance = accountAvailableBalance(account.nombreCuenta);
          const lastMovement = lastMovementForAccount(account);
          const reconciliation = lastReconciliationForAccount(account);
          const hasDifference = reconciliation && Math.abs(reconciliation.diferencia) > 0.009;
          return `
            <article class="panel account-card">
              <h4>${escapeHtml(account.nombreCuenta)}</h4>
              <span class="account-meta">${escapeHtml(accountCategoryLabel(accountCategory(account)))} · ${escapeHtml(account.estado || "Activo")}</span>
              <span class="account-balance">${money.format(balance)}</span>
              <span class="account-meta">Último movimiento: ${lastMovement ? `${escapeHtml(lastMovement.date)} · ${escapeHtml(lastMovement.type)}` : "Sin movimientos"}</span>
              <span class="account-meta">Última conciliación: ${reconciliation ? escapeHtml(reconciliation.date) : "Sin cierre confirmado"}</span>
              ${hasDifference ? `<span class="account-meta danger">Diferencia pendiente: ${money.format(reconciliation.diferencia)}</span>` : ""}
            </article>
          `;
        })
        .join("")
    : '<p class="empty">No hay cuentas activas que coincidan con el filtro.</p>';

  renderAccountsDailyBalancePanel(filters, accounts);
  renderAccountsMovementsTable(filters, accounts);
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
                <span>${client.telefono || "Sin teléfono"} · ${client.correo || "Sin correo"} · ${client.estado || "Activo"}${client.fechaNacimiento ? ` · Cumpleaños ${birthdateLabel(client.fechaNacimiento)}` : ""}</span>
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
                <span>${staff.funcion || "Sin función"} · ${staff.telefono || "Sin teléfono"} · ${money.format(Number(staff.salarioMensual) || 0)} · Umbrales ${(staff.umbralesComisionActivos || []).length || 0} · ${staff.estado || "Activo"}${staff.fechaNacimiento ? ` · Cumpleaños ${birthdateLabel(staff.fechaNacimiento)}` : ""}</span>
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

  const tssRows = dbTable("configuracionTSS").slice().sort((a, b) => String(b.fechaVigencia || "").localeCompare(String(a.fechaVigencia || "")));
  byId("tss-config-list").innerHTML = tssRows.length
    ? tssRows
        .map(
          (row) => `
            <article class="list-item">
              <div>
                <strong>Vigente ${dateOnly(row.fechaVigencia) || "-"} ${row.fechaFin ? `a ${dateOnly(row.fechaFin)}` : "en adelante"}</strong>
                <span>Colaborador ${(Number(row.tasaColaborador) || 0).toFixed(2)}% · Empleador ${(Number(row.tasaEmpleador) || 0).toFixed(2)}% · Tope ${money.format(Number(row.tope) || 0)} · Base ${money.format(Number(row.baseContributiva) || 0)} · Bonos ${row.bonoSujeto ? "sujetos" : "no sujetos"} · Comisiones ${row.comisionSujeta ? "sujetas" : "no sujetas"} · ${row.estado || "Activo"}</span>
              </div>
              <div class="row-actions">
                <button class="secondary-btn compact edit-record" data-type="tss" data-id="${row.tssID}" type="button">Editar</button>
                <button class="secondary-btn compact toggle-record-status" data-table="configuracionTSS" data-id-field="tssID" data-id="${row.tssID}" type="button">${row.estado === "Inactivo" ? "Activar" : "Inactivar"}</button>
              </div>
            </article>
          `,
        )
        .join("")
    : '<p class="empty">No hay configuraciones de TSS registradas.</p>';
}

function renderAll() {
  safeRender("datalists", renderDatalists);
  safeRender("dashboard", renderDashboard);
  safeRender("facturacion", renderInvoices);
  safeRender("administracion de facturas", renderInvoiceAdmin);
  safeRender("cuentas por cobrar", renderReceivables);
  safeRender("registros de ingresos", renderIncomeRecords);
  safeRender("transferencias pendientes", renderPendingTransfers);
  safeRender("citas", renderReservations);
  safeRender("nomina", renderPayroll);
  safeRender("vacaciones", renderVacations);
  safeRender("cxc de colaboradores", renderCollaboratorReceivables);
  safeRender("cierres de caja", renderCash);
  safeRender("conciliacion de tarjetas", renderCardReconciliation);
  safeRender("egresos", renderExpenses);
  safeRender("cuentas balance", renderAccountsView);
  safeRender("inventario", renderInventory);
  safeRender("activos fijos", renderFixedAssets);
  safeRender("reportes", renderReports);
  safeRender("base de datos", renderSettings);
}

function lookupValuesFor(listId) {
  if (listId === "clients-list") return state.clients.map((client) => client.name).filter(Boolean);
  if (listId === "people-list") return [...state.clients.map((client) => client.name), ...activeStaffNames()].filter(Boolean);
  if (listId === "advance-people-list") {
    return [
      ...activeStaffNames(),
      ...dbTable("suplidores").map((supplier) => supplier.nombre || supplier.nombreCompleto || supplier.empresa || supplier.suplidorNombre),
    ].filter(Boolean);
  }
  if (listId === "services-list") return state.services.map((service) => service.name).filter(Boolean);
  if (listId === "staff-list") return activeStaffNames();
  if (listId === "accounts-list") return activeAccounts().map((account) => account.nombreCuenta).filter(Boolean);
  if (listId === "cash-accounts-list") return cashAccounts().map((account) => account.nombreCuenta).filter(Boolean);
  if (listId === "bank-accounts-list") return bankAccounts().map((account) => account.nombreCuenta).filter(Boolean);
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

function datalistValuesFor(listId) {
  const list = listId ? byId(listId) : null;
  if (!list) return [];
  return Array.from(list.options).map((option) => option.value).filter(Boolean);
}

function attachSearchableLookups() {
  document.querySelectorAll("input[list]").forEach((input) => {
    if (input.dataset.lookupReady) return;
    input.dataset.lookupReady = "true";
    input.setAttribute("autocomplete", "off");
    const wrapper = document.createElement("div");
    wrapper.className = "lookup-wrap";
    const menu = document.createElement("div");
    menu.className = "lookup-menu";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    wrapper.appendChild(menu);

    const showMatches = () => {
      const query = normalize(input.value);
      const listId = input.getAttribute("list");
      const sourceValues = lookupValuesFor(listId);
      const values = [...new Set((sourceValues.length ? sourceValues : datalistValuesFor(listId)))]
        .filter((value) => !query || normalize(value).includes(query))
        .slice(0, 8);
      menu.innerHTML = values
        .map((value) => `<button class="lookup-option" type="button" data-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`)
        .join("");
      menu.classList.toggle("active", values.length > 0);
    };

    input.addEventListener("focus", showMatches);
    input.addEventListener("click", showMatches);
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
      input.dispatchEvent(new Event("change", { bubbles: true }));
      menu.classList.remove("active");
    });
    document.addEventListener("click", (event) => {
      if (!wrapper.contains(event.target)) menu.classList.remove("active");
    });
  });
}

// Extraida de wireNavigation() para poder cambiar de vista programaticamente
// (por ejemplo, el boton "Agregar egreso" del cierre) sin duplicar la logica
// de activar/desactivar nav-item y view. Cambiar de vista NUNCA destruye el
// DOM de la vista anterior (solo le quita la clase "active"), asi que un
// formulario abierto en otra vista (p. ej. #cash-form) conserva sus valores
// aunque el usuario navegue a otra vista y vuelva.
function switchToView(viewId) {
  const view = byId(viewId);
  const button = document.querySelector(`.nav-item[data-view="${viewId}"]`);
  if (!view) {
    console.error(`No existe la vista ${viewId}`);
    return false;
  }
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  document.querySelectorAll(".view").forEach((item) => item.classList.remove("active"));
  button?.classList.add("active");
  view.classList.add("active");
  if (button) byId("view-title").textContent = button.textContent;
  if (viewId === "cash") safeRender("cierres de caja", renderCash);
  if (viewId === "accounts-overview") safeRender("cuentas balance", renderAccountsView);
  return true;
}

function wireNavigation() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => switchToView(button.dataset.view));
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
    // Detiene el poll de fondo de 30s: sin esto seguiria llamando a
    // refreshRemoteDatabase()/refreshErpProfile() cada 30s con la sesion ya
    // cerrada (ambas funciones no harian nada util por dentro, pero es
    // trabajo de red innecesario y no es "detenerse al cerrar sesion").
    stopRemoteRefreshLoop();
    // Limpia el perfil seguro de la sesion que se va: evita que, si otro
    // usuario inicia sesion despues en la misma pestana antes de que
    // refreshErpProfile() termine, alcance a ver (aunque sea un instante)
    // permisos de la sesion anterior.
    erpProfile = null;
    erpProfileLoaded = false;
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
  // "Olvide mi contrasena" ya NO llama a /api/password-reset-status: ese
  // endpoint ahora exige sesion de administrador (ver
  // functions/api/password-reset-status.js) porque, sin autenticacion,
  // devolver "ese correo existe" / "ese correo tiene un reset pendiente"
  // es un oraculo de enumeracion de usuarios. En su lugar, este formulario
  // siempre muestra el mismo mensaje generico y abre el formulario de
  // cambio de contrasena sin importar si el correo existe o no: la
  // verificacion real ocurre en signInWithPassword() mas abajo, que solo
  // tiene exito si la contrasena temporal es correcta.
  byId("forgot-password-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const email = byId("forgot-email").value.trim();
    const message = byId("forgot-password-message");
    message.textContent = "Si tu correo esta registrado y un administrador ya generó una contraseña temporal, continúa a continuación.";
    resetPasswordPanel("forgot");
    byId("password-change-email").value = email;
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
    await refreshErpProfile();
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
    await refreshErpProfile();
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
    startRemoteRefreshLoop();
    updateAuthUi();
    renderAll();
    if (isPasswordResetRequired()) {
      resetPasswordPanel("forced");
    }
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
      const response = await fetch(functionEndpoint("users"), {
        headers: { Authorization: `Bearer ${supabaseSession.access_token}` },
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "No se pudo cargar usuarios.");
      renderUsersList(result.users || []);
      listMessage.textContent = "Usuarios cargados.";
      listMessage.className = "form-message success";
    } catch (error) {
      listTarget.innerHTML = '<tr><td class="empty" colspan="8">No se pudo cargar usuarios.</td></tr>';
      listMessage.textContent = error.message;
      listMessage.className = "form-message error";
    }
  };

  const renderUsersList = (users) => {
    if (!users.length) {
      listTarget.innerHTML = '<tr><td class="empty" colspan="8">No hay usuarios registrados.</td></tr>';
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
                <option value="administrador" ${user.role === "administrador" ? "selected" : ""}>Administrador</option>
                <option value="propietaria" ${user.role === "propietaria" ? "selected" : ""}>Propietaria</option>
                <option value="propietario" ${user.role === "propietario" ? "selected" : ""}>Propietario</option>
                <option value="contador" ${user.role === "contador" ? "selected" : ""}>Contador</option>
                <option value="contadora" ${user.role === "contadora" ? "selected" : ""}>Contadora</option>
                <option value="asistente_contable" ${user.role === "asistente_contable" ? "selected" : ""}>Asistente contable</option>
                <option value="asistenta_contable" ${user.role === "asistenta_contable" ? "selected" : ""}>Asistenta contable</option>
              </select>
            </td>
            <td><span class="status-pill ${inactive ? "danger" : "success"}">${escapeHtml(user.estado || "Activo")}</span></td>
            <td><span class="status-pill ${pendingPassword ? "warning" : "success"}">${pendingPassword ? "Debe cambiar" : "Definitiva"}</span></td>
            <td><input class="user-password-input compact-input" type="password" minlength="6" placeholder="Opcional" /></td>
            <td>
              <label title="Ver Cuentas sin ser rol privilegiado ni contador/a">
                <input type="checkbox" class="user-review-accounts-input" ${user.canReviewAccounts ? "checked" : ""} />
                Revisar cuentas
              </label>
              <label title="Ver la bitácora de auditoría sin ser rol privilegiado ni contador/a (por ejemplo, asistente contable)">
                <input type="checkbox" class="user-review-audit-input" ${user.canReviewAudit ? "checked" : ""} />
                Revisar auditoría
              </label>
            </td>
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
      canReviewAccounts: row.querySelector(".user-review-accounts-input").checked,
      canReviewAudit: row.querySelector(".user-review-audit-input").checked,
    };
    if (estado) payload.estado = estado;

    listMessage.textContent = "Guardando usuario...";
    listMessage.className = "form-message";
    const response = await fetch(functionEndpoint("users"), {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "No se pudo actualizar el usuario.");
    const successText = result.temporaryPassword
      ? `Contraseña temporal generada: ${result.temporaryPassword}`
      : "Usuario actualizado.";
    await loadUsers();
    listMessage.textContent = successText;
    listMessage.className = "form-message success";
    if (result.temporaryPassword) alert(successText);
  };

  const setRowBusy = (row, busy) => {
    row.querySelectorAll("button").forEach((button) => {
      button.disabled = busy;
    });
    row.classList.toggle("row-busy", busy);
  };

  const resetUserPassword = async (row) => {
    const targetEmail = row.querySelector(".user-email-input").value.trim() || "este usuario";
    if (!confirm(`¿Confirmas resetear la contraseña de ${targetEmail}? Se generará una contraseña temporal y el usuario deberá cambiarla al entrar.`)) {
      return null;
    }
    const payload = {
      id: row.dataset.userId,
      fullName: row.querySelector(".user-name-input").value.trim(),
      email: row.querySelector(".user-email-input").value.trim(),
      role: row.querySelector(".user-role-input").value,
      resetPassword: true,
    };
    listMessage.textContent = "Generando contraseña temporal...";
    listMessage.className = "form-message";
    const response = await fetch(functionEndpoint("users"), {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "No se pudo resetear la contraseña.");
    if (!result.temporaryPassword) {
      throw new Error("La función respondió sin contraseña temporal. Revisa SUPABASE_SERVICE_ROLE_KEY en Cloudflare Pages y vuelve a desplegar.");
    }
    const successText = `Contraseña temporal generada: ${result.temporaryPassword}. El usuario debe salir, iniciar con esa clave temporal y crear su contraseña nueva.`;
    await loadUsers();
    listMessage.textContent = successText;
    listMessage.className = "form-message success";
    alert(successText);
    return result;
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
      const response = await fetch(functionEndpoint("create-user"), {
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
    if (row.classList.contains("row-busy")) return;
    setRowBusy(row, true);
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
      // El mensaje inline es facil de pasar por alto junto a la tabla, asi que
      // tambien se muestra con alert() para que un error real nunca parezca que
      // "no paso nada".
      listMessage.textContent = error.message;
      listMessage.className = "form-message error";
      alert(`No se pudo completar la accion: ${error.message}`);
    } finally {
      setRowBusy(row, false);
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
      openDataForm(button.dataset.formTarget);
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
  const form = byId(formId);
  // Punto unico de entrada a cualquier formulario de Base de datos (crear,
  // editar, o abrir desde Facturacion): siempre arranca sin el rastro de un
  // intento anterior de "Crear cliente desde Facturacion" que se haya
  // abandonado sin guardar. openSettingsFormFromInvoice() vuelve a marcar
  // dataset.returnToInvoice="true" DESPUES de llamar a esta funcion, cuando
  // en efecto corresponde. Sin este borrado centralizado, editar/crear
  // cualquier registro de Base de datos despues de un intento abandonado
  // desde una factura heredaba ese rastro y el guardado siguiente devolvia
  // a la persona a Facturacion sin que tuviera nada que ver con eso.
  delete form.dataset.returnToInvoice;
  form.classList.add("active");
  revealFormAtTop(form);
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
    byId("client-birthdate").value = client.fechaNacimiento || "";
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
    byId("staff-birthdate").value = staff.fechaNacimiento || "";
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
  if (type === "tss") {
    const row = dbTable("configuracionTSS").find((item) => item.tssID === id);
    if (!row) return;
    byId("tss-edit-id").value = row.tssID || "";
    byId("tss-employee-rate").value = Number(row.tasaColaborador) || 0;
    byId("tss-employer-rate").value = Number(row.tasaEmpleador) || 0;
    byId("tss-cap").value = Number(row.tope) || 0;
    byId("tss-base").value = Number(row.baseContributiva) || 0;
    byId("tss-effective-date").value = row.fechaVigencia || today;
    byId("tss-end-date").value = row.fechaFin || "";
    byId("tss-bonus-subject").checked = Boolean(row.bonoSujeto);
    byId("tss-commission-subject").checked = Boolean(row.comisionSujeta);
    byId("tss-note").value = row.observaciones || "";
    byId("tss-status").value = row.estado || "Activo";
    openDataForm("tss-config-form");
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
  return firstLineStaff || "";
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

function invoiceTotalsFromLines(lines, generalExtra = 0, generalDiscountPercent = 0) {
  const servicesTotal = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
  const extrasTotal = lines.reduce((sum, line) => sum + line.extra, 0);
  const lineDiscounts = lines.reduce((sum, line) => sum + line.discount, 0);
  const generalDiscountBase = Math.max(0, servicesTotal + extrasTotal - lineDiscounts);
  const generalDiscountAmount = Math.min(generalDiscountBase, generalDiscountBase * ((Number(generalDiscountPercent) || 0) / 100));
  const discountTotal = lineDiscounts + generalDiscountAmount;
  const grandTotal = Math.max(0, servicesTotal + extrasTotal + generalExtra - discountTotal);
  return { servicesTotal, extrasTotal, lineDiscounts, generalDiscountAmount, discountTotal, grandTotal };
}

function invoiceCommissionAllocations(lines, generalDiscountAmount = 0) {
  const bases = lines.map((line) => Math.max(0, line.qty * line.price + line.extra - line.discount));
  const totalBase = bases.reduce((sum, value) => sum + value, 0);
  return lines.map((line, index) => {
    const share = totalBase > 0 ? bases[index] / totalBase : 0;
    const generalDiscountShare = Math.min(bases[index], Number((generalDiscountAmount * share).toFixed(2)));
    return {
      lineNetBeforeGeneral: bases[index],
      generalDiscountShare,
      commissionableSubtotal: Math.max(0, bases[index] - generalDiscountShare),
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
  const lines = getInvoiceLines();
  const payments = getPaymentLines();
  const generalExtra = Number(byId("invoice-general-extra")?.value) || 0;
  const generalDiscountPercent = Number(byId("invoice-general-discount-percent")?.value) || 0;
  const tip = Number(byId("invoice-tip").value) || 0;
  const { servicesTotal, extrasTotal, discountTotal, grandTotal } = invoiceTotalsFromLines(lines, generalExtra, generalDiscountPercent);
  const paidTotal = payments.reduce((sum, payment) => sum + payment.amount, 0);
  // Misma formula central que usa la factura ya guardada al verla/imprimirla
  // (invoiceBreakdownForStoredInvoice -> DalfiClosingMath.computeInvoiceBreakdown),
  // para que la vista previa del formulario nunca difiera del resultado impreso.
  const breakdown = DalfiClosingMath.computeInvoiceBreakdown({
    precioListadoServicios: servicesTotal,
    totalAdicionales: extrasTotal + generalExtra,
    totalDescuentos: discountTotal,
    propina: tip,
    totalPagado: paidTotal,
  });
  const totalWithTip = breakdown.totalGeneral;
  const pendingTotal = breakdown.montoPendiente;
  const overpay = Math.max(0, paidTotal - grandTotal);
  const finalOverpay = breakdown.sobrepago;
  lines.forEach((line) => {
    line.element.querySelector(".line-subtotal").value = money.format(line.subtotal);
  });
  byId("invoice-services-total").textContent = money.format(servicesTotal);
  byId("invoice-extras-total").textContent = money.format(extrasTotal);
  byId("invoice-discounts-total").textContent = money.format(discountTotal);
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
  const clientRecord = findClientByName(byId("invoice-client-search")?.value.trim() || "");
  renderInvoicePriorDebtSummary(clientRecord, totalWithTip);
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
  delete byId("invoice-form").dataset.editVersion;
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
    alert("Esta factura no puede editarse porque pertenece a un cierre de caja confirmado.");
    logAudit("invoice_edit_blocked", {
      entity: "facturas",
      entityId: invoiceId,
      success: false,
      note: "Intento de abrir edición de una factura con cierre confirmado.",
    });
    return;
  }
  const invoice = dbTable("facturas").find((row) => row.facturaID === invoiceId);
  if (!invoice) return;
  const details = dbTable("facturaDetalle").filter((detail) => detail.facturaID === invoiceId);
  byId("invoice-form").dataset.editVersion = invoice.fechaActualizacion || invoice.fechaCreacion || "";
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
  revealFormAtTop(byId("invoice-form"), { focusSelector: "#invoice-client-search" });
}

function saveEditedInvoice(invoiceId, client, lines, totals, note) {
  const invoice = dbTable("facturas").find((row) => row.facturaID === invoiceId);
  if (!invoice) {
    alert("Esta factura ya no existe. Puede que otra persona la haya eliminado o movido. Actualiza la pantalla e intenta de nuevo.");
    return false;
  }
  const currentDate = dateOnly(invoice.fechaOperacion || invoice.fechaHora);
  if (!canEditInvoice(invoiceId)) {
    const closing = closingForDate(currentDate);
    const blockedByClosing = closing && !isClosingOpenForEdits(closing);
    alert(
      blockedByClosing
        ? "Esta factura no puede editarse porque pertenece a un cierre de caja confirmado."
        : "No se puede guardar. Tu usuario no tiene permisos administrativos.",
    );
    logAudit("invoice_edit_blocked", {
      entity: "facturas",
      entityId: invoiceId,
      success: false,
      note: blockedByClosing ? "Cierre de caja confirmado para esa fecha." : "Usuario sin permisos administrativos.",
    });
    return false;
  }
  const editVersion = byId("invoice-form").dataset.editVersion || "";
  const currentVersion = invoice.fechaActualizacion || invoice.fechaCreacion || "";
  if (editVersion && currentVersion && editVersion !== currentVersion) {
    const keepGoing = confirm(
      "Esta factura fue modificada por otra persona despues de que abriste este formulario. Si continuas, tus cambios reemplazaran los de esa otra edicion. ¿Deseas continuar de todas formas?",
    );
    if (!keepGoing) return false;
  }
  const oldSnapshot = {
    totalFacturado: invoice.totalFacturado,
    totalCxC: invoice.totalCxC,
    clienteNombre: invoice.clienteNombre,
    fechaOperacion: currentDate,
  };
  const targetDate = canManageInvoices() ? (byId("invoice-date")?.value || currentDate || today) : currentDate;
  if (targetDate !== currentDate) {
    if (!canEditRecordDate(currentDate) || !canEditRecordDate(targetDate)) {
      alert("No se puede cambiar la fecha. El cierre origen o destino está confirmado; administración debe abrirlo primero.");
      return false;
    }
    moveLinkedRecordsForInvoices([invoice], currentDate, targetDate);
  }
  invoice.fechaHora = withDateOnly(invoice.fechaHora || dateTimeForOperationalDate(targetDate), targetDate);
  invoice.fechaOperacion = targetDate;
  const clientRecord = findClientByName(client) || ensureClient(client);
  const firstStaff = ensureStaffRecord(lines[0].staff);
  const allocations = invoiceCommissionAllocations(lines, totals.generalDiscountAmount || 0);
  database.data.facturaDetalle = dbTable("facturaDetalle").filter((detail) => detail.facturaID !== invoiceId);
  lines.forEach((line, index) => {
    ensureService(line.service, line.price);
    const serviceRecord = findServiceByName(line.service);
    const staffRecord = ensureStaffRecord(line.staff);
    const allocation = allocations[index] || {};
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
      deduccionGeneralMonto: allocation.generalDiscountShare || 0,
      subtotalAntesDescuentoGeneral: allocation.lineNetBeforeGeneral || line.subtotal,
      subtotal: allocation.commissionableSubtotal ?? line.subtotal,
      montoComisionable: allocation.commissionableSubtotal ?? line.subtotal,
    }));
  });
  invoice.clienteID = clientRecord?.clienteID || invoice.clienteID || "";
  invoice.clienteNombre = client;
  invoice.colaboradorID = firstStaff.colaboradorID || "";
  invoice.colaboradorNombre = firstStaff.nombreCompleto || "";
  // Fuente preferida: propinaCobrada/propinaPendiente explicitos (facturas
  // creadas desde esta politica). Facturas historicas sin esos campos
  // todavia (compatibilidad, ver seccion 11) caen al calculo derivado
  // anterior. Editar servicios/descuentos NUNCA debe reducir la propina
  // total por debajo de lo YA cobrado (propinaCobrada): este formulario hoy
  // no expone un campo para cambiar la propina, asi que en la practica
  // previousTip simplemente se preserva integro, pero el guard queda listo
  // por si en el futuro se agrega esa edicion.
  const hasExplicitTipFields = Number.isFinite(Number(invoice.propinaCobrada)) && invoice.propinaCobrada !== undefined;
  const tipCollectedSoFar = hasExplicitTipFields ? Math.max(0, Number(invoice.propinaCobrada) || 0) : 0;
  const previousTip = hasExplicitTipFields
    ? Math.max(0, (Number(invoice.propinaCobrada) || 0) + (Number(invoice.propinaPendiente) || 0))
    : Math.max(0, (Number(invoice.totalConPropina) || 0) - (Number(invoice.totalFacturado) || 0));
  if (previousTip < tipCollectedSoFar) {
    alert("No se puede guardar: la propina total no puede quedar por debajo de lo que ya se cobró de propina.");
    return false;
  }
  invoice.totalFacturado = totals.total;
  invoice.totalPagadoConfirmado = Number(invoice.totalPagadoConfirmado) || 0;
  invoice.totalCxC = Math.max(0, totals.total - invoice.totalPagadoConfirmado);
  if (hasExplicitTipFields) invoice.propinaPendiente = Math.max(0, previousTip - tipCollectedSoFar);
  invoice.estadoFactura = invoice.totalCxC > 0 || (Number(invoice.propinaPendiente) || 0) > 0 ? "Parcial" : "Pagada";
  invoice.adicionalGeneralMonto = totals.generalExtra;
  invoice.adicionalGeneralDetalle = totals.generalExtraNote;
  invoice.descuentoGeneralPorcentaje = totals.generalDiscountPercent;
  invoice.descuentoGeneralMonto = totals.generalDiscountAmount || 0;
  invoice.totalConPropina = totals.total + previousTip;
  invoice.observaciones = note;
  stampRecord(invoice, "updated");
  refreshPendingClosingsForDate(currentDate);
  if (targetDate !== currentDate) refreshPendingClosingsForDate(targetDate);
  logAudit("invoice_edit", {
    entity: "facturas",
    entityId: invoiceId,
    oldData: oldSnapshot,
    newData: { totalFacturado: invoice.totalFacturado, totalCxC: invoice.totalCxC, clienteNombre: invoice.clienteNombre, fechaOperacion: targetDate },
    success: true,
  });
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
  revealFormAtTop(byId("invoice-form"), { focusSelector: "#invoice-client-search" });
}

function openSettingsFormFromInvoice(formId) {
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === "settings"));
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  byId("settings").classList.add("active");
  byId("view-title").textContent = "Base de datos";
  // openDataForm() SIEMPRE borra dataset.returnToInvoice al abrir un
  // formulario (ver su comentario): por eso aqui se marca DESPUES de
  // llamarla, nunca antes.
  openDataForm(formId); // ya hace scroll + foco de forma centralizada
  byId(formId).dataset.returnToInvoice = "true";
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
  revealFormAtTop(byId("invoice-form"), { focusSelector: null });
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
        <input class="payment-account" list="bank-accounts-list" placeholder="Buscar cuenta bancaria" />
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
    account.placeholder = "Buscar cuenta bancaria";
    if (!findBankAccountByName(account.value)) inputSingleOrBlank(account, lookupValuesFor("bank-accounts-list"));
    line.querySelector(".payment-reference-field")?.classList.remove("hidden");
  } else if (method === "credito") {
    state.value = "Crédito";
    if (!due.value) due.value = datePlusDays(7);
    line.querySelector(".payment-due-field")?.classList.remove("hidden");
  } else if (method === "tarjeta") {
    state.value = "Contado / CxC procesador";
    line.querySelector(".payment-processor-field")?.classList.remove("hidden");
    line.querySelector(".payment-reference-field")?.classList.remove("hidden");
    if (!findProcessorByName(processor.value)) inputSingleOrBlank(processor, lookupValuesFor("processors-list"));
  } else if (method === "balance") {
    state.value = "Balance a favor";
  } else {
    state.value = "Confirmado";
    if (method === "transferencia_confirmada") {
      line.querySelector(".payment-account-field")?.classList.remove("hidden");
      account.setAttribute("list", "bank-accounts-list");
      account.placeholder = "Buscar cuenta bancaria";
      if (!findBankAccountByName(account.value)) inputSingleOrBlank(account, lookupValuesFor("bank-accounts-list"));
      line.querySelector(".payment-reference-field")?.classList.remove("hidden");
    }
  }
  if (method === "efectivo") {
    account.value = cashRegisterAccount()?.nombreCuenta || "Caja Registradora";
    account.removeAttribute("list");
  }
  if (!method.includes("transferencia")) account.value = method === "efectivo" ? cashRegisterAccount()?.nombreCuenta || "Caja Registradora" : "";
  if (method !== "tarjeta") processor.value = "";
}

function updateIncomePaymentFields() {
  const method = byId("payment-method").value;
  const accountInput = byId("payment-account");
  const processorInput = byId("payment-processor");
  byId("payment-account-label").classList.toggle("hidden", method !== "transferencia");
  byId("payment-processor-label").classList.toggle("hidden", method !== "tarjeta");
  accountInput.required = method === "transferencia";
  processorInput.required = method === "tarjeta";
  if (method === "efectivo") {
    accountInput.value = cashRegisterAccount()?.nombreCuenta || "Caja Registradora";
    accountInput.removeAttribute("list");
    processorInput.value = "";
    return;
  }
  if (method === "transferencia") {
    accountInput.setAttribute("list", "bank-accounts-list");
    accountInput.placeholder = "Buscar cuenta bancaria";
    if (!findBankAccountByName(accountInput.value)) inputSingleOrBlank(accountInput, lookupValuesFor("bank-accounts-list"));
    processorInput.value = "";
    return;
  }
  if (method === "tarjeta") {
    if (!findProcessorByName(processorInput.value)) inputSingleOrBlank(processorInput, lookupValuesFor("processors-list"));
    accountInput.value = "";
    accountInput.removeAttribute("list");
  }
}

function addIncomePaymentLine() {
  const line = document.createElement("article");
  line.className = "invoice-line income-payment-line";
  line.dataset.lineId = `income-payment-${++incomePaymentLineCounter}`;
  line.innerHTML = `
    <div class="line-head">
      <strong>Forma de pago adicional</strong>
      <button class="secondary-btn compact remove-income-payment-line" type="button">Quitar</button>
    </div>
    <div class="line-grid">
      <label>
        Monto
        <input class="income-payment-amount" type="number" min="0" step="0.01" value="0" />
      </label>
      <label>
        Método
        <select class="income-payment-method">
          <option value="efectivo">Efectivo</option>
          <option value="tarjeta">Tarjeta</option>
          <option value="transferencia">Transferencia</option>
        </select>
      </label>
      <label class="income-payment-account-label hidden">
        Cuenta bancaria
        <input class="income-payment-account" list="bank-accounts-list" placeholder="Buscar cuenta bancaria" />
      </label>
      <label class="income-payment-processor-label hidden">
        Compañía tarjeta
        <input class="income-payment-processor" list="processors-list" placeholder="Buscar compañía" />
      </label>
    </div>
  `;
  byId("income-payment-line-list").appendChild(line);
  updateIncomePaymentLineState(line);
  attachSearchableLookups();
}

function updateIncomePaymentLineState(line) {
  const method = line.querySelector(".income-payment-method").value;
  const accountInput = line.querySelector(".income-payment-account");
  const processorInput = line.querySelector(".income-payment-processor");
  line.querySelector(".income-payment-account-label")?.classList.toggle("hidden", method !== "transferencia");
  line.querySelector(".income-payment-processor-label")?.classList.toggle("hidden", method !== "tarjeta");
  accountInput.required = method === "transferencia";
  processorInput.required = method === "tarjeta";
  if (method === "efectivo") {
    accountInput.value = cashRegisterAccount()?.nombreCuenta || "Caja Registradora";
    accountInput.removeAttribute("list");
    processorInput.value = "";
    return;
  }
  if (method === "transferencia") {
    accountInput.setAttribute("list", "bank-accounts-list");
    accountInput.placeholder = "Buscar cuenta bancaria";
    if (!findBankAccountByName(accountInput.value)) inputSingleOrBlank(accountInput, lookupValuesFor("bank-accounts-list"));
    processorInput.value = "";
    return;
  }
  if (method === "tarjeta") {
    if (!findProcessorByName(processorInput.value)) inputSingleOrBlank(processorInput, lookupValuesFor("processors-list"));
    accountInput.value = "";
    accountInput.removeAttribute("list");
  }
}

function getIncomePaymentLines() {
  const mainMethod = byId("payment-method")?.value || "efectivo";
  const mainAmountInput = byId("payment-method-amount") || byId("payment-amount");
  const mainAccount = mainMethod === "efectivo" ? cashRegisterAccount()?.nombreCuenta || "Caja Registradora" : byId("payment-account")?.value.trim() || "";
  const rows = [
    {
      amount: Number(mainAmountInput?.value) || 0,
      method: mainMethod,
      account: mainAccount,
      processor: byId("payment-processor")?.value.trim() || "",
      accountInput: byId("payment-account"),
      processorInput: byId("payment-processor"),
    },
  ];
  document.querySelectorAll(".income-payment-line").forEach((line) => {
    const method = line.querySelector(".income-payment-method").value;
    rows.push({
      amount: Number(line.querySelector(".income-payment-amount").value) || 0,
      method,
      account: method === "efectivo" ? cashRegisterAccount()?.nombreCuenta || "Caja Registradora" : line.querySelector(".income-payment-account").value.trim(),
      processor: line.querySelector(".income-payment-processor").value.trim(),
      accountInput: line.querySelector(".income-payment-account"),
      processorInput: line.querySelector(".income-payment-processor"),
    });
  });
  return rows.filter((row) => row.amount > 0);
}

// Convierte filas reales de cuentasCobrar al formato que espera
// DalfiClosingMath.allocateClientPaymentFIFO(). Compartida por la
// previsualizacion en vivo y por el submit (que SIEMPRE la vuelve a calcular
// fresca, nunca confia en lo que quedo pintado en pantalla).
function mapReceivablesForAllocation(receivables) {
  return receivables.map((cxc) => ({
    id: cxc.cxCID,
    invoiceId: cxc.facturaID || "",
    kind: cxc.esPropinaPendiente ? "tip" : "base",
    amount: Number(cxc.balancePendiente) || 0,
    fechaOrigen: cxc.fechaOrigen || "",
  }));
}

// Bloque informativo de Facturacion (factura nueva): muestra por separado el
// total de ESTA factura, la deuda anterior del cliente (misma lista que usa
// el cobro general, clientAllReceivables) y la suma de ambos como "total
// general a pagar hoy". Puramente informativo -nunca se escribe en
// facturaDetalle/subtotal/servicios/adicionales/descuentos/propina/total ni
// en el totalCxC de la factura nueva-, por eso vive fuera de invoiceTotals.
function renderInvoicePriorDebtSummary(clientRecord, currentInvoiceTotal) {
  const container = byId("invoice-prior-debt-summary");
  const rowsTarget = byId("invoice-prior-debt-rows");
  if (!container || !rowsTarget) return;
  if (!clientRecord) {
    container.classList.add("hidden");
    rowsTarget.innerHTML = "";
    return;
  }
  const receivables = clientAllReceivables(clientRecord);
  const priorDebtTotal = receivables.reduce((sum, row) => sum + (Number(row.balancePendiente) || 0), 0);
  container.classList.remove("hidden");
  byId("invoice-current-total-preview").textContent = money.format(currentInvoiceTotal);
  byId("invoice-prior-debt-total").textContent = money.format(priorDebtTotal);
  byId("invoice-grand-total-with-prior-debt").textContent = money.format(priorDebtTotal + currentInvoiceTotal);
  rowsTarget.innerHTML = receivables
    .map((cxc) => {
      const label = cxc.esPropinaPendiente ? `Propina — factura ${cxc.facturaID || cxc.cxCID}` : `Factura ${cxc.facturaID || cxc.cxCID}`;
      return `<div class="list-item"><span>${escapeHtml(label)} · ${dateOnly(cxc.fechaOrigen) || "-"}</span><span>${money.format(Number(cxc.balancePendiente) || 0)}</span></div>`;
    })
    .join("");
}

// Medios de pago validos DESDE ESTE FORMULARIO (distinto del formulario de
// facturas: aqui todas las lineas ya representan dinero CONFIRMADO, nunca
// credito ni transferencia pendiente sin confirmar -esas se gestionan por
// separado, ver pendingTransferRows()/confirmPendingTransfer()-). Tarjeta
// sigue al final para que solo financie propina cuando los demas no
// alcancen, igual que en facturacion.
const PAYMENT_FORM_METHOD_PRIORITY = ["efectivo", "transferencia", "tarjeta"];

function clientReceivablesFor(cxc) {
  if (!cxc) return [];
  return dbTable("cuentasCobrar")
    .filter((item) => Number(item.balancePendiente) > 0)
    .filter((item) => item.deudorTipo === "Cliente")
    .filter((item) => {
      if (cxc.deudorID) return item.deudorID === cxc.deudorID;
      return normalize(item.deudorNombre) === normalize(cxc.deudorNombre);
    })
    .sort((a, b) => {
      if (a.cxCID === cxc.cxCID) return -1;
      if (b.cxCID === cxc.cxCID) return 1;
      return String(a.fechaOrigen || "").localeCompare(String(b.fechaOrigen || ""));
    });
}

// Resuelve el cliente actualmente escrito en #payment-client-search. Fuente
// unica de verdad para saber "que cliente esta seleccionado" en este
// formulario (nunca un <select> de una sola CxC: el flujo definitivo es
// cliente -> TODAS sus CxC en FIFO, no factura por factura).
function selectedPaymentClient() {
  return findClientBySearchTerm(byId("payment-client-search")?.value || "");
}

function updatePaymentSummary() {
  if (!byId("payment-client-search") || !byId("payment-amount")) return;
  const clientRecord = selectedPaymentClient();
  const receivables = clientAllReceivables(clientRecord);
  const clientDebt = receivables.reduce((sum, row) => sum + (Number(row.balancePendiente) || 0), 0);
  const paymentGoal = Number(byId("payment-amount")?.value) || 0;
  const paymentLines = getIncomePaymentLines();
  const linesTotal = paymentLines.reduce((sum, line) => sum + line.amount, 0);
  const difference = linesTotal - paymentGoal;

  if (byId("payment-client-name")) byId("payment-client-name").textContent = clientRecord?.nombreCompleto || "-";
  if (byId("payment-invoice-count")) byId("payment-invoice-count").textContent = String(new Set(receivables.map((row) => row.facturaID).filter(Boolean)).size);
  if (byId("payment-client-debt")) byId("payment-client-debt").textContent = money.format(clientDebt);
  renderPaymentAllocationPreview(clientRecord, receivables, paymentLines);
  if (byId("payment-lines-total")) byId("payment-lines-total").textContent = money.format(linesTotal);
  if (byId("payment-lines-difference")) {
    byId("payment-lines-difference").textContent = money.format(difference);
    byId("payment-lines-difference").classList.toggle("danger", difference < 0);
    byId("payment-lines-difference").classList.toggle("gold", difference > 0);
  }
  if (byId("payment-overpay-label")) {
    byId("payment-overpay-label").classList.toggle("hidden", difference <= 0);
    if (difference > 0 && byId("payment-overpay-policy")?.value === "cxc" && clientDebt <= paymentGoal) {
      byId("payment-overpay-policy").value = "sobrante";
    }
  }
}

// Previsualizacion EN VIVO del reparto FIFO (seccion 7 del encargo): se
// recalcula fresca en cada cambio de cliente/monto/medio/cuenta con la
// MISMA funcion pura que ejecuta el submit real -nunca se persiste, nunca
// se usa como fuente de verdad al guardar-.
function renderPaymentAllocationPreview(clientRecord, receivables, paymentLines) {
  const container = byId("payment-allocation-preview");
  const rowsTarget = byId("payment-allocation-rows");
  if (!container || !rowsTarget) return;
  if (!clientRecord || !receivables.length) {
    container.classList.add("hidden");
    rowsTarget.innerHTML = "";
    return;
  }
  container.classList.remove("hidden");
  const confirmedLines = paymentLines.filter((line) => line.amount > 0).map((line) => ({ method: line.method, amount: line.amount }));
  const allocation = DalfiClosingMath.allocateClientPaymentFIFO({
    confirmedPaymentLines: confirmedLines,
    priorClientReceivables: mapReceivablesForAllocation(receivables),
    methodPriority: PAYMENT_FORM_METHOD_PRIORITY,
  });
  rowsTarget.innerHTML = allocation.resultingBalances
    .map((row) => {
      const cxc = receivables.find((item) => item.cxCID === row.id);
      const label = row.kind === "tip" ? `Propina — factura ${row.invoiceId || row.id}` : `Factura ${row.invoiceId || row.id}`;
      const estado = row.remainingBalance <= 0 ? "Saldada" : row.amountApplied > 0 ? "Parcial" : "Sin cambio";
      return `
        <div class="list-item">
          <span>${escapeHtml(label)} · ${dateOnly(cxc?.fechaOrigen) || "-"}</span>
          <span>${money.format(row.previousBalance)} → ${money.format(row.remainingBalance)} (aplicado ${money.format(row.amountApplied)}) · ${estado}</span>
        </div>
      `;
    })
    .join("");
}

// Precarga el monto recibido con la deuda TOTAL del cliente (editable, para
// permitir un pago parcial): mismo patron que fillPaymentGoalFromSelection
// usaba con una sola CxC, ahora con el total de todas.
function fillPaymentGoalFromClient() {
  const clientRecord = selectedPaymentClient();
  const receivables = clientAllReceivables(clientRecord);
  const clientDebt = receivables.reduce((sum, row) => sum + (Number(row.balancePendiente) || 0), 0);
  const amountInput = byId("payment-amount");
  const methodAmountInput = byId("payment-method-amount");
  amountInput.value = clientDebt ? String(clientDebt) : "";
  methodAmountInput.value = clientDebt ? String(clientDebt) : "";
  updatePaymentSummary();
}

// La propina se cobra y se registra DE ULTIMO (politica vigente desde julio
// 2026): esta funcion es el UNICO lugar que reconoce propina como cobrada
// -crea o actualiza la cuenta por pagar de nomina de cada colaboradora-, sea
// que la propina se cubra al crear la factura o mas tarde, cuando un pago
// posterior (aplicado sobre la CxC de "Propina pendiente factura X") llega a
// esa porcion. Nunca crea un segundo ingreso: el dinero ya quedo registrado
// en caja/banco por addConfirmedPayment() al recibirse; esto solo
// reclasifica una parte de ese dinero como obligacion con las colaboradoras.
// sourceKey = facturaID:colaboradorID hace esto idempotente: llamarlo varias
// veces para la misma factura+colaboradora ACTUALIZA la misma fila de
// propinas (nunca crea una segunda), y nunca puede superar invoiceTipTotal
// porque toCollect esta acotado por dbInvoice.propinaPendiente.
function collectInvoiceTip(dbInvoice, amount, { cardPortion = 0, source = "" } = {}) {
  if (!dbInvoice) return { collected: 0, allocations: [] };
  // Idempotencia por "source" (paymentId/cxCID/invoiceId que financio esta
  // cobranza): si YA existe una entrada en pagosAplicados con este mismo
  // source para esta factura, no se vuelve a procesar -sin importar cuantas
  // veces se llame esta funcion con los mismos argumentos (doble submit,
  // reintento, confirmacion repetida de la misma transferencia, re-render).
  // Cada paymentId/receiptId aparece una sola vez dentro de pagosAplicados[].
  if (source) {
    const alreadyApplied = dbTable("propinas").some(
      (row) => row.facturaID === dbInvoice.facturaID && Array.isArray(row.pagosAplicados) && row.pagosAplicados.some((entry) => entry.source === source),
    );
    if (alreadyApplied) return { collected: 0, allocations: [] };
  }
  const pendingBefore = Math.max(0, Number(dbInvoice.propinaPendiente) || 0);
  const toCollect = Math.min(pendingBefore, Math.max(0, Number(amount) || 0));
  if (toCollect <= 0) return { collected: 0, allocations: [] };
  const distribution = Array.isArray(dbInvoice.distribucionPropina) ? dbInvoice.distribucionPropina : [];
  const declaredTotal = distribution.reduce((sum, entry) => sum + (Number(entry.monto) || 0), 0);
  const safeCardPortion = Math.max(0, Math.min(toCollect, Number(cardPortion) || 0));

  // Reparto proporcional a la distribucion historica ya declarada en la
  // factura (nunca se inventa un responsable nuevo): igual patron de
  // redondeo que renderTipAllocation (piso a centavos, el resto a la
  // ultima entrada para que la suma cierre EXACTO en toCollect).
  const allocations = [];
  if (declaredTotal > 0 && distribution.length) {
    let remaining = toCollect;
    distribution.forEach((entry, index) => {
      const share = (Number(entry.monto) || 0) / declaredTotal;
      const isLast = index === distribution.length - 1;
      const raw = isLast ? remaining : Math.floor(toCollect * share * 100) / 100;
      const amountForEntry = Math.min(remaining, Math.max(0, raw));
      remaining = Math.max(0, remaining - amountForEntry);
      if (amountForEntry > 0) {
        allocations.push({ colaboradorID: entry.colaboradorID, colaboradorNombre: entry.colaboradorNombre, amount: amountForEntry });
      }
    });
  }

  allocations.forEach((allocation) => {
    const shareOfCollection = toCollect > 0 ? allocation.amount / toCollect : 0;
    const cardAmount = safeCardPortion * shareOfCollection;
    const retention = cardAmount * 0.05;
    const sourceKey = `${dbInvoice.facturaID}:${allocation.colaboradorID}`;
    // Solo se reutiliza una obligacion TODAVIA pendiente de nomina. Si la
    // unica fila para esta factura+colaboradora ya se pago (nomina Pagada),
    // NO se le suma dinero nuevo a esa fila -quedaria oculta para siempre,
    // porque una fila Pagada nunca vuelve a calificar para una nomina
    // futura-: se crea una fila nueva (mismo sourceKey, otro propinaID) que
    // si puede incluirse en la proxima nomina. invoiceTipReversalBlockedReason/
    // reverseInvoiceTipCollection ya filtran por facturaID y por el "source"
    // dentro de pagosAplicados, nunca por sourceKey unico, asi que soportan
    // varias filas para la misma factura+colaboradora sin cambios.
    let payable = dbTable("propinas").find((row) => row.sourceKey === sourceKey && normalize(row.estadoPagoNomina || "Pendiente") === "pendiente");
    if (!payable) {
      payable = stampRecord({
        propinaID: nextDbId("propinas", "propinaID", "PRO"),
        sourceKey,
        fechaHora: new Date().toISOString(),
        facturaID: dbInvoice.facturaID,
        detalleID: "",
        colaboradorID: allocation.colaboradorID,
        colaboradorNombre: allocation.colaboradorNombre,
        montoBruto: 0,
        metodoPago: "mixto",
        retencion20Tarjeta: 0,
        montoNetoPagar: 0,
        estadoPagoNomina: "Pendiente",
        pagosAplicados: [],
      });
      dbTable("propinas").push(payable);
    }
    payable.montoBruto = Number((Number(payable.montoBruto) || 0) + allocation.amount);
    payable.retencion20Tarjeta = Number(((Number(payable.retencion20Tarjeta) || 0) + retention).toFixed(2));
    payable.montoNetoPagar = Number((payable.montoBruto - payable.retencion20Tarjeta).toFixed(2));
    payable.pagosAplicados = Array.isArray(payable.pagosAplicados) ? payable.pagosAplicados : [];
    payable.pagosAplicados.push({ source, amount: allocation.amount, retencion: Number(retention.toFixed(2)), fecha: new Date().toISOString() });
    stampRecord(payable, "updated");
  });

  dbInvoice.propinaCobrada = Number(((Number(dbInvoice.propinaCobrada) || 0) + toCollect).toFixed(2));
  dbInvoice.propinaPendiente = Number(Math.max(0, pendingBefore - toCollect).toFixed(2));
  return { collected: toCollect, allocations };
}

// Antes de reversar un cobro que financio (total o parcialmente) una CxC de
// "Propina pendiente", hay que verificar que NINGUNA cuenta por pagar de
// nomina que se financio con ESE cobro especifico (source === cxc.cxCID) ya
// haya sido pagada a la colaboradora: la propina cobrada al cliente y la
// propina pagada en nomina son eventos distintos, y no se puede deshacer en
// silencio un pago de nomina que ya salio.
function invoiceTipReversalBlockedReason(cxc) {
  if (!cxc?.esPropinaPendiente) return "";
  const affectedPayables = dbTable("propinas").filter(
    (row) => row.facturaID === cxc.facturaID && Array.isArray(row.pagosAplicados) && row.pagosAplicados.some((entry) => entry.source === cxc.cxCID),
  );
  const alreadyPaid = affectedPayables.find((row) => normalize(row.estadoPagoNomina || "Pendiente") !== "pendiente");
  if (!alreadyPaid) return "";
  return `La propina de ${alreadyPaid.colaboradorNombre || "una colaboradora"} financiada por este cobro ya fue pagada en nómina (estado: ${alreadyPaid.estadoPagoNomina}). No se puede revertir automáticamente: ajusta la nómina manualmente primero.`;
}

// Reversa EXACTAMENTE la porcion de propina que este cobro (cxc.cxCID)
// financio en cada colaboradora (busca la entrada de pagosAplicados con ese
// source, nunca reversa un monto adivinado/proporcional). Debe llamarse solo
// despues de confirmar con invoiceTipReversalBlockedReason() que ninguna de
// esas obligaciones ya fue pagada en nomina.
function reverseInvoiceTipCollection(dbInvoice, cxc) {
  if (!dbInvoice || !cxc?.esPropinaPendiente) return 0;
  let totalReversed = 0;
  dbTable("propinas")
    .filter((row) => row.facturaID === cxc.facturaID)
    .forEach((row) => {
      if (!Array.isArray(row.pagosAplicados)) return;
      const entry = row.pagosAplicados.find((item) => item.source === cxc.cxCID);
      if (!entry) return;
      row.montoBruto = Number(Math.max(0, (Number(row.montoBruto) || 0) - entry.amount).toFixed(2));
      row.retencion20Tarjeta = Number(Math.max(0, (Number(row.retencion20Tarjeta) || 0) - (Number(entry.retencion) || 0)).toFixed(2));
      row.montoNetoPagar = Number(Math.max(0, row.montoBruto - row.retencion20Tarjeta).toFixed(2));
      row.pagosAplicados = row.pagosAplicados.filter((item) => item !== entry);
      stampRecord(row, "updated");
      totalReversed += entry.amount;
    });
  if (totalReversed > 0) {
    dbInvoice.propinaCobrada = Number(Math.max(0, (Number(dbInvoice.propinaCobrada) || 0) - totalReversed).toFixed(2));
    dbInvoice.propinaPendiente = Number(((Number(dbInvoice.propinaPendiente) || 0) + totalReversed).toFixed(2));
  }
  return totalReversed;
}

// paymentId (el pagoID que YA se genero para este cobro especifico, ver
// applyReceivablePaymentLines/applyClientReceivablesFirst) identifica de
// forma UNICA cada aplicacion: cxc.cxCID por si solo NO alcanza como
// "source" de idempotencia porque una misma CxC de propina pendiente puede
// recibir varios pagos parciales distintos a lo largo del tiempo (todos
// comparten el mismo cxCID). Sin paymentId, un segundo pago legitimo contra
// la misma CxC se confundiria con un reintento del primero y se ignoraria.
function syncInvoicePaymentFromReceivable(cxc, applied, paymentId = "") {
  if (!cxc?.facturaID || applied <= 0) return;
  const invoice = state.invoices.find((item) => item.id === cxc.facturaID);
  if (invoice) invoice.paid = Math.min(invoice.total, (Number(invoice.paid) || 0) + applied);
  const dbInvoice = dbTable("facturas").find((item) => item.facturaID === cxc.facturaID);
  if (!dbInvoice) return;
  // Una CxC de "Propina pendiente factura X" nunca debe tratarse como saldo
  // BASE: tiene su propio flujo (collectInvoiceTip), separado de
  // totalPagadoConfirmado/totalCxC, que siguen representando solo la base
  // de la factura (servicios + adicionales - descuentos), nunca la propina.
  if (cxc.esPropinaPendiente) {
    collectInvoiceTip(dbInvoice, applied, { source: paymentId || cxc.cxCID || "" });
    stampRecord(dbInvoice, "updated");
    return;
  }
  dbInvoice.totalPagadoConfirmado = (Number(dbInvoice.totalPagadoConfirmado) || 0) + applied;
  const previousCxC = Number(dbInvoice.totalCxC);
  dbInvoice.totalCxC = Number.isFinite(previousCxC) ? Math.max(0, previousCxC - applied) : Math.max(0, Number(cxc.balancePendiente) || 0);
  dbInvoice.estadoFactura = dbInvoice.totalCxC <= 0 && (Number(dbInvoice.propinaPendiente) || 0) <= 0 ? "Pagada" : "Parcial";
  stampRecord(dbInvoice, "updated");
}

function createExtraIncome(line, amount, clientRecord, clientName, cashDate, type, note) {
  if (amount <= 0) return;
  const account = accountForPaymentLine(line.method, line.account);
  const processor = findProcessorByName(line.processor) || processorForPayment(line.method);
  const retention = normalizePayment(line.method) === "tarjeta" ? amount * processorFeeRate(processor) : 0;
  const net = amount - retention;
  dbTable("ingresos").push(stampRecord({
    ingresoID: nextDbId("ingresos", "ingresoID", "ING"),
    fechaHora: dateTimeForOperationalDate(cashDate),
    fechaEntradaCaja: cashDate,
    tipoIngreso: type,
    facturaID: "",
    clienteID: clientRecord?.clienteID || "",
    clienteNombre: clientName,
    metodoPago: line.method,
    cuentaDestinoID: account.cuentaID || "",
    cuentaDestino: account.nombreCuenta || "",
    montoBruto: amount,
    retencion: retention,
    montoNeto: net,
    estado: "Confirmado",
    observaciones: note,
  }));
}

function applyReceivablePaymentLines(receivables, amountToApply, paymentLines, cashDate) {
  const mutableLines = paymentLines.map((line) => ({ ...line, remaining: line.amount }));
  let remainingToApply = amountToApply;
  for (const cxc of receivables) {
    let pending = Number(cxc.balancePendiente) || 0;
    while (pending > 0 && remainingToApply > 0) {
      const line = mutableLines.find((item) => item.remaining > 0);
      if (!line) return mutableLines;
      const applied = Math.min(line.remaining, pending, remainingToApply);
      const clientRecord = dbTable("clientes").find((client) => client.clienteID === cxc.deudorID) || findClientByName(cxc.deudorNombre);
      cxc.montoAplicado = (Number(cxc.montoAplicado) || 0) + applied;
      cxc.balancePendiente = Math.max(0, (Number(cxc.balancePendiente) || 0) - applied);
      cxc.estado = cxc.balancePendiente <= 0 ? "Saldada" : "Parcial";
      stampRecord(cxc, "updated");
      // addConfirmedPayment() ANTES: su pagoID identifica de forma unica
      // esta aplicacion especifica (ver comentario de
      // syncInvoicePaymentFromReceivable), necesario para que dos pagos
      // parciales distintos contra la MISMA CxC (mismo cxCID) no se
      // confundan como si fueran el mismo evento.
      const paymentId = addConfirmedPayment(cxc.facturaID || "", clientRecord, cxc.deudorNombre || "", applied, line.method, "Cobro cuenta por cobrar", line.processor, line.account, cashDate, cxc.cxCID);
      syncInvoicePaymentFromReceivable(cxc, applied, paymentId);
      line.remaining -= applied;
      pending -= applied;
      remainingToApply -= applied;
    }
  }
  return mutableLines;
}

function updateExpenseDestinationLookup() {
  const type = byId("expense-type").value;
  const destinationInput = byId("expense-destination");
  if (type !== "transferencia") {
    destinationInput.value = "";
    destinationInput.setAttribute("list", "accounts-list");
    return;
  }
  const destinationType = byId("expense-destination-type").value;
  const listId = destinationType === "bank" ? "bank-accounts-list" : "cash-accounts-list";
  destinationInput.setAttribute("list", listId);
  destinationInput.placeholder = destinationType === "bank" ? "Buscar cuenta bancaria destino" : "Buscar caja destino";
  const valid = destinationType === "bank" ? findBankAccountByName(destinationInput.value) : findCashAccountByName(destinationInput.value);
  if (!valid) inputSingleOrBlank(destinationInput, lookupValuesFor(listId));
}

function updateExpenseOptionalFields() {
  const type = byId("expense-type").value;
  byId("expense-destination-label").classList.toggle("hidden", type !== "transferencia");
  byId("expense-destination-type-label").classList.toggle("hidden", type !== "transferencia");
  byId("expense-receivable-label").classList.toggle("hidden", type !== "avance");
  byId("expense-advance-type-label").classList.toggle("hidden", type !== "avance" || !findStaffByName(byId("expense-receivable-person").value.trim()));
  updateExpenseDestinationLookup();
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
    const wasNew = !client;
    if (!client) {
      client = {
        clienteID: nextDbId("clientes", "clienteID", "CLI"),
        nombreCompleto: fullName,
        nombre: firstName,
        apellido: lastName,
        telefono: byId("client-phone").value.trim(),
        sexo: byId("client-sex").value,
        fechaNacimiento: byId("client-birthdate").value || "",
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
      client.fechaNacimiento = byId("client-birthdate").value || client.fechaNacimiento || "";
      client.correo = byId("client-email").value.trim() || client.correo;
      client.direccion = byId("client-address").value.trim() || client.direccion;
      client.observaciones = byId("client-notes").value.trim() || client.observaciones;
    }
    byId("client-form").reset();
    const shouldReturnToInvoice = byId("client-form").dataset.returnToInvoice === "true";
    delete byId("client-form").dataset.returnToInvoice;
    if (shouldReturnToInvoice) {
      byId("invoice-client-search").value = client.nombreCompleto || fullName;
      updateInvoiceTotals();
    }
    closeDataForms();
    let clientAuditAction = "edit_client";
    let clientAuditNote = "Cliente editado.";
    if (wasNew && shouldReturnToInvoice) {
      clientAuditAction = "create_client_from_invoice";
      clientAuditNote = "Cliente creado desde el formulario completo abierto desde Facturación.";
    } else if (wasNew) {
      clientAuditAction = "create_client";
      clientAuditNote = "Cliente creado.";
    }
    logAudit(clientAuditAction, {
      entity: "clientes",
      entityId: client.clienteID,
      newData: { nombreCompleto: client.nombreCompleto, telefono: client.telefono, correo: client.correo },
      note: clientAuditNote,
      success: true,
    });
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
    updateInvoiceTotals();
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
  // El monto total re-dispara el render de la lista (renderPayrollCxCList
  // vuelve a calcular el reparto FIFO y precarga cada input individual), no
  // solo el resumen: por eso pasa renderCxC:true, a diferencia de los demas
  // inputs de este formulario.
  byId("payroll-cxc-total").addEventListener("input", () => updatePayrollPreview(true));
  byId("add-payroll-bonus").addEventListener("click", () => {
    addPayrollBonusLine();
    updatePayrollPreview(false);
  });
  byId("payroll-bonus-list").addEventListener("input", () => updatePayrollPreview(false));
  byId("payroll-bonus-list").addEventListener("click", (event) => {
    if (!event.target.classList.contains("remove-payroll-bonus")) return;
    event.target.closest(".payroll-bonus-line")?.remove();
    updatePayrollPreview(false);
  });

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

  let invoiceSubmitInFlight = false;
  byId("invoice-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (invoiceSubmitInFlight) return;
    const client = byId("invoice-client-search").value.trim();
    const lines = getInvoiceLines().filter((line) => line.service && line.staff && line.qty > 0);
    const editId = byId("invoice-edit-id").value;
    if (!client || !lines.length) return;
    const payments = getPaymentLines().filter((payment) => payment.amount > 0);
    const invoiceDate = canManageInvoices() ? (byId("invoice-date")?.value || today) : today;
    if (!editId && !isClosingOpenForEdits(closingForDate(invoiceDate))) {
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
    const missingTransferAccount = payments.find((payment) => payment.method.includes("transferencia") && !findBankAccountByName(payment.account));
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
    const totals = invoiceTotalsFromLines(lines, generalExtra, generalDiscountPercent);
    const { servicesTotal, extrasTotal, discountTotal: discount, grandTotal: total } = totals;
    const totalWithTip = total + tip;
    // A partir de aqui empiezan las mutaciones reales (crear/editar la
    // factura, aplicar pagos, generar CxC y propinas): se marca
    // invoiceSubmitInFlight para que un doble clic/doble submit mientras
    // esto corre no vuelva a entrar, con el mismo patron try/finally que
    // cashSubmitInFlight/expenseSubmitInFlight en el modulo Cierres.
    invoiceSubmitInFlight = true;
    byId("invoice-submit-button").disabled = true;
    try {
    if (editId) {
      saveEditedInvoice(editId, client, lines, { total, generalExtra, generalExtraNote, generalDiscountPercent, generalDiscountAmount: totals.generalDiscountAmount }, note);
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
    const allocations = invoiceCommissionAllocations(lines, totals.generalDiscountAmount);

    lines.forEach((line, index) => {
      ensureService(line.service, line.price);
      const serviceRecord = findServiceByName(line.service);
      const staffRecord = ensureStaffRecord(line.staff);
      const detailId = nextDbId("facturaDetalle", "detalleID", "DET");
      const allocation = allocations[index] || {};
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
        deduccionGeneralMonto: allocation.generalDiscountShare || 0,
        subtotalAntesDescuentoGeneral: allocation.lineNetBeforeGeneral || line.subtotal,
        subtotal: allocation.commissionableSubtotal ?? line.subtotal,
        montoComisionable: allocation.commissionableSubtotal ?? line.subtotal,
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
    // Distribucion DECLARADA de la propina (proporciones), guardada en la
    // factura desde su creacion: collectInvoiceTip() la usa para repartir
    // proporcionalmente cada porcion de propina que se cobre, sea ahora o
    // mas adelante con un pago posterior. No es lo mismo que "propina YA
    // cobrada": una factura puede declarar 200 de propina y arrancar sin
    // haber cobrado nada de eso todavia (Ejemplo 4).
    const tipDistributionDeclared = getTipAllocations().map((allocation) => {
      const staffRecord = ensureStaffRecord(allocation.staff);
      return { colaboradorID: staffRecord.colaboradorID || "", colaboradorNombre: staffRecord.nombreCompleto || allocation.staff, monto: allocation.amount };
    });
    const invoiceRecord = stampRecord({
      facturaID: invoiceId,
      fechaHora: dateTimeForOperationalDate(invoiceDate),
      clienteID: clientRecord?.clienteID || "",
      clienteNombre: client,
      colaboradorID: firstStaff.colaboradorID || "",
      colaboradorNombre: firstStaff.nombreCompleto || "",
      estadoFactura: status,
      totalFacturado: total,
      totalPagadoConfirmado: 0,
      totalCxC: total,
      balanceFavorCliente: 0,
      adicionalGeneralMonto: generalExtra,
      adicionalGeneralDetalle: generalExtraNote,
      descuentoGeneralPorcentaje: generalDiscountPercent,
      descuentoGeneralMonto: totals.generalDiscountAmount,
      totalConPropina: totalWithTip,
      // La propina se cobra DE ULTIMO: al crear la factura todavia no se ha
      // aplicado ningun pago, asi que arranca en 0 cobrada / tip completo
      // pendiente. El bloque de abajo (allocateConfirmedPayment +
      // collectInvoiceTip) ajusta estos dos campos al valor real segun
      // cuanto dinero confirmado alcanzo a cubrir CxC anteriores + base +
      // propina, en ese orden.
      propinaCobrada: 0,
      propinaPendiente: tip,
      distribucionPropina: tipDistributionDeclared,
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

    // Politica vigente desde julio 2026: LA PROPINA SE COBRA Y SE REGISTRA
    // DE ULTIMO. El dinero confirmado se aplica siempre en este orden:
    // 1) CxC anteriores del cliente (de la mas antigua a la mas nueva, base
    // antes que propina pendiente dentro de cada factura), 2) base de esta
    // factura (servicios + adicionales - descuentos), 3) propina de esta
    // factura. Mientras quede pendiente 1 o 2, nunca se reconoce propina
    // cobrada. Solo cuentan lineas CONFIRMADAS (nunca credito, nunca
    // transferencia pendiente, nunca "balance" por encima de lo que el
    // cliente realmente tiene). Se usa el MISMO algoritmo puro que el cobro
    // general de cliente desde Facturacion (DalfiClosingMath.allocateClientPaymentFIFO,
    // ver openClientReceiptFromBilling): nunca dos algoritmos financieros
    // distintos para el mismo reparto.
    const priorReceivables = clientAllReceivables(clientRecord);
    const priorDebtBeforePayment = priorReceivables.reduce((sum, row) => sum + (Number(row.balancePendiente) || 0), 0);
    const priorBalancesBeforePayment = new Map(priorReceivables.map((row) => [row.cxCID, Number(row.balancePendiente) || 0]));
    const availableBalance = clientBalance(clientRecord?.clienteID);
    const confirmedPayments = payments.filter((paymentLine) => isConfirmedPaymentMethod(paymentLine.method));
    const allocation = DalfiClosingMath.allocateClientPaymentFIFO({
      confirmedPaymentLines: confirmedPayments.map((paymentLine) => ({
        method: paymentLine.method,
        amount: paymentLine.method === "balance" ? Math.min(paymentLine.amount, availableBalance) : paymentLine.amount,
      })),
      priorClientReceivables: mapReceivablesForAllocation(priorReceivables),
      currentInvoiceBase: total,
      currentInvoiceTip: tip,
      currentInvoiceTipCollected: 0,
    });

    confirmedPayments.forEach((paymentLine, index) => {
      const lineAllocation = allocation.lineAllocations[index];
      if (!lineAllocation) return;
      const olderPortion = lineAllocation.olderReceivables;
      const invoicePortion = lineAllocation.currentBase + lineAllocation.tip;
      if (paymentLine.method === "balance") {
        // "balance a favor" es credito interno del cliente, no dinero nuevo:
        // recordAsIncome:false evita crear un ingreso/pagosFactura que
        // duplicaria caja (ese dinero ya se conto una vez, cuando se generó
        // el balance por un sobrepago anterior).
        if (olderPortion > 0) applyClientReceivablesFirst(clientRecord, client, olderPortion, "balance", "Balance a favor aplicado a CxC previa", "", "", invoiceDate, { recordAsIncome: false });
        adjustClientBalance(clientRecord?.clienteID, -(olderPortion + invoicePortion));
        return;
      }
      if (olderPortion > 0) applyClientReceivablesFirst(clientRecord, client, olderPortion, paymentLine.method, "Pago aplicado primero a CxC previa", paymentLine.processor, paymentLine.account, invoiceDate);
      if (invoicePortion > 0) {
        addConfirmedPayment(invoiceId, clientRecord, client, invoicePortion, paymentLine.method, paymentLine.reference || "Cobro factura", paymentLine.processor, paymentLine.account, invoiceDate);
      }
      if (paymentLine.method === "tarjeta") {
        const processor = findProcessorByName(paymentLine.processor) || processorForPayment("tarjeta");
        // El procesador siempre debe el monto COMPLETO de la tarjeta,
        // independientemente de como se repartio internamente ese dinero
        // entre CxC anteriores/base/propina.
        addReceivable(invoiceId, { clienteID: processor.procesadorID || "" }, processor.nombre || "Procesador tarjeta", paymentLine.amount, "CxC procesador tarjeta", "", invoiceDate);
      }
    });
    paid = Math.min(total, allocation.amountAppliedToCurrentBase);
    invoiceRecord.totalPagadoConfirmado = paid;
    invoiceRecord.totalCxC = Math.max(0, total - paid);

    // Credito y transferencia pendiente NUNCA participan del reparto (no son
    // dinero confirmado), pero la CxC que generan debe representar la
    // deuda REAL restante (invoiceRecord.totalCxC), nunca ciegamente el
    // monto que la persona escribio en esa linea: si la base ya quedo
    // cubierta con dinero confirmado (o con una CxC anterior), declarar
    // credito/transferencia pendiente de mas no debe inventar una deuda
    // fantasma que despues no cuadre con invoiceRecord.totalCxC (sumar las
    // filas de cuentasCobrar de esta factura por "saldo base" SIEMPRE debe
    // dar exactamente invoiceRecord.totalCxC, ni un centavo mas). Se
    // procesan en el orden en que la persona las agrego, cada una tomando
    // solo lo que todavia falte.
    let baseShortfallRemaining = invoiceRecord.totalCxC;
    payments
      .filter((paymentLine) => paymentLine.method === "transferencia_pendiente" || paymentLine.method === "credito")
      .forEach((paymentLine) => {
        const amountForThisLine = Math.min(paymentLine.amount, baseShortfallRemaining);
        baseShortfallRemaining = Math.max(0, baseShortfallRemaining - amountForThisLine);
        if (amountForThisLine <= 0) return;
        if (paymentLine.method === "transferencia_pendiente") {
          addReceivable(invoiceId, clientRecord, client, amountForThisLine, "Transferencia pendiente por confirmar", paymentLine.account, invoiceDate);
        } else {
          addReceivable(invoiceId, clientRecord, client, amountForThisLine, `Crédito cliente vence ${paymentLine.dueDate || datePlusDaysFrom(invoiceDate, 7)}`, "", invoiceDate);
        }
      });

    const cardTipPortion = allocation.lineAllocations
      .filter((lineAllocation) => lineAllocation.method === "tarjeta")
      .reduce((sum, lineAllocation) => sum + lineAllocation.tip, 0);
    collectInvoiceTip(invoiceRecord, allocation.amountAppliedToCurrentTip, { cardPortion: cardTipPortion, source: invoiceId });
    // Pendiente: no se aplico NINGUN pago confirmado a esta factura todavia
    // (todo el dinero, si hubo, se fue a deuda anterior). Parcial: recibio
    // algo pero queda saldo (base o propina). Pagada: base y propina
    // completas. Mismo vocabulario que cuentasCobrar.estado (ver linea 4328).
    invoiceRecord.estadoFactura =
      invoiceRecord.totalPagadoConfirmado <= 0 && invoiceRecord.propinaCobrada <= 0
        ? "Pendiente"
        : invoiceRecord.totalCxC > 0 || invoiceRecord.propinaPendiente > 0
          ? "Parcial"
          : "Pagada";

    // Si queda propina pendiente, se registra como su PROPIA cuenta por
    // cobrar (separada de la CxC de base): asi un pago futuro puede
    // aplicarse especificamente a ella a traves del flujo normal de CxC
    // (ver syncInvoicePaymentFromReceivable), reconociendo la propina como
    // cobrada solo en ese momento, nunca antes.
    if (invoiceRecord.propinaPendiente > 0) {
      addReceivable(invoiceId, clientRecord, client, invoiceRecord.propinaPendiente, `Propina pendiente factura ${invoiceId}`, "", invoiceDate, { esPropinaPendiente: true });
    }

    const actualOverpay = allocation.unappliedAmount;
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
    stampRecord(invoiceRecord, "updated");
    // Una sola auditoria por factura creada (no una por cada CxC anterior
    // afectada): incluye cuanto de la deuda anterior se cubrio con este
    // mismo pago y que facturas anteriores quedaron afectadas, sin volcar
    // erp_records completo ni datos sensibles.
    const priorInvoicesAffected = [
      ...new Set(
        priorReceivables
          .filter((row) => (priorBalancesBeforePayment.get(row.cxCID) || 0) - (Number(row.balancePendiente) || 0) > 0)
          .map((row) => row.facturaID)
          .filter(Boolean),
      ),
    ];
    logAudit("invoice_created", {
      entity: "facturas",
      entityId: invoiceId,
      newData: {
        clienteID: clientRecord?.clienteID || "",
        totalFactura: totalWithTip,
        deudaAnteriorAgregada: priorDebtBeforePayment,
        pagoConfirmadoTotal: allocation.totalApplied + allocation.unappliedAmount,
        aplicadoACxCAnteriores: allocation.amountAppliedToPriorReceivables,
        facturasAnterioresAfectadas: priorInvoicesAffected,
        aplicadoABaseNueva: allocation.amountAppliedToCurrentBase,
        aplicadoAPropinaNueva: allocation.amountAppliedToCurrentTip,
        saldoBaseNuevo: invoiceRecord.totalCxC,
        saldoPropinaNuevo: invoiceRecord.propinaPendiente,
      },
      note: `Factura ${invoiceId} creada. Deuda anterior del cliente: ${money.format(priorDebtBeforePayment)}. Total general cobrado hoy: ${money.format(priorDebtBeforePayment + totalWithTip)}.`,
      success: true,
    });
    refreshPendingClosingsForDate(invoiceDate);
    state = stateFromDatabase(database);
    activeReservationInvoiceId = "";
    clearInvoiceFormAfterSubmit();
    saveState();
    renderAll();
    } finally {
      invoiceSubmitInFlight = false;
      byId("invoice-submit-button").disabled = false;
    }
  });

  byId("invoice-table").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-invoice-id]");
    if (!row) return;
    const invoiceId = row.dataset.invoiceId;
    if (event.target.closest(".view-invoice")) openInvoiceReport(invoiceId);
    if (event.target.closest(".edit-invoice")) startInvoiceEdit(invoiceId);
  });
  byId("open-client-receipt")?.addEventListener("click", openClientReceiptFromBilling);

  byId("invoice-admin-table").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-invoice-id]");
    if (!row) return;
    const invoiceId = row.dataset.invoiceId;
    if (event.target.closest(".view-invoice-admin")) openInvoiceReport(invoiceId);
    if (event.target.closest(".edit-invoice-admin")) openAdminInvoiceEditor(invoiceId);
  });
  byId("admin-new-invoice").addEventListener("click", () => openAdminInvoiceEditor());
  byId("move-july-9-invoices").addEventListener("click", moveBuggedJuly9InvoicesToJuly8);

  byId("payment-client-search").addEventListener("change", fillPaymentGoalFromClient);
  byId("payment-client-search").addEventListener("input", updatePaymentSummary);
  byId("payment-amount").addEventListener("input", updatePaymentSummary);
  byId("payment-method-amount").addEventListener("input", updatePaymentSummary);
  byId("payment-overpay-policy").addEventListener("change", updatePaymentSummary);
  byId("payment-method").addEventListener("change", () => {
    updateIncomePaymentFields();
    updatePaymentSummary();
  });
  byId("add-income-payment-line").addEventListener("click", () => {
    addIncomePaymentLine();
    updatePaymentSummary();
  });
  byId("income-payment-line-list").addEventListener("change", (event) => {
    const line = event.target.closest(".income-payment-line");
    if (line && event.target.matches(".income-payment-method")) updateIncomePaymentLineState(line);
    updatePaymentSummary();
  });
  byId("income-payment-line-list").addEventListener("input", (event) => {
    if (event.target.matches(".income-payment-amount")) updatePaymentSummary();
  });
  byId("income-payment-line-list").addEventListener("click", (event) => {
    const removeButton = event.target.closest(".remove-income-payment-line");
    if (!removeButton) return;
    removeButton.closest(".income-payment-line")?.remove();
    updatePaymentSummary();
  });
  let paymentSubmitInFlight = false;
  byId("payment-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (paymentSubmitInFlight) return;
    if (!canManageInvoices()) {
      alert("Solo administración o propietario puede registrar cobros de cuentas por cobrar.");
      return;
    }
    const clientRecord = selectedPaymentClient();
    const receivables = clientAllReceivables(clientRecord);
    if (!clientRecord || !receivables.length) {
      alert("Busca y selecciona un cliente con cuentas por cobrar pendientes.");
      byId("payment-client-search").focus();
      return;
    }
    const paymentLines = getIncomePaymentLines();
    if (!paymentLines.length) {
      alert("Agrega al menos una forma de pago con monto mayor que cero.");
      byId("payment-method-amount").focus();
      return;
    }
    const paymentGoal = Number(byId("payment-amount").value) || 0;
    if (paymentGoal <= 0) {
      alert("Indica el monto que el cliente va a pagar.");
      byId("payment-amount").focus();
      return;
    }
    const cashDate = byId("payment-cash-date").value || today;
    for (const line of paymentLines) {
      if (line.method === "transferencia" && !findBankAccountByName(line.account)) {
        alert("Selecciona una cuenta bancaria para registrar la transferencia.");
        line.accountInput?.focus();
        return;
      }
      if (line.method === "tarjeta" && !findProcessorByName(line.processor)) {
        alert("Selecciona la compañía de tarjeta para registrar el pago.");
        line.processorInput?.focus();
        return;
      }
    }
    const linesTotal = paymentLines.reduce((sum, line) => sum + line.amount, 0);
    if (linesTotal + 0.01 < paymentGoal) {
      alert("Las formas de pago no completan el monto a pagar. Agrega otra forma de pago o ajusta los montos.");
      byId("add-income-payment-line").focus();
      return;
    }
    // A partir de aqui empiezan las mutaciones reales (aplicar el cobro a
    // CxC, crear el recibo/ingreso, reconocer propina): se marca
    // paymentSubmitInFlight para que un doble clic/doble submit mientras
    // esto corre no vuelva a entrar, mismo patron try/finally que
    // invoiceSubmitInFlight/cashSubmitInFlight.
    paymentSubmitInFlight = true;
    byId("payment-submit").disabled = true;
    try {
    const clientDebt = receivables.reduce((sum, row) => sum + (Number(row.balancePendiente) || 0), 0);
    const overpayPolicy = byId("payment-overpay-policy").value;
    const extraPaid = Math.max(0, linesTotal - paymentGoal);
    const applyExtraToCxc = overpayPolicy === "cxc" ? extraPaid : 0;
    const amountToDebt = Math.min(clientDebt, paymentGoal + applyExtraToCxc);
    // Mismo orden de prioridad que el reparto de facturacion: tarjeta
    // financia de ultimo (asi solo paga CxC/propina cuando los demas
    // medios ya no alcanzan). applyReceivablePaymentLines() (y, dentro de
    // ella, addConfirmedPayment/syncInvoicePaymentFromReceivable) es el
    // UNICO flujo de reparto: CxC del cliente de la mas antigua a la mas
    // nueva, base antes que propina pendiente dentro de cada factura
    // (clientAllReceivables ya llega ordenada por fechaOrigen).
    const priorityRank = new Map(PAYMENT_FORM_METHOD_PRIORITY.map((method, rank) => [method, rank]));
    const orderedLines = paymentLines.slice().sort((a, b) => (priorityRank.get(a.method) ?? 99) - (priorityRank.get(b.method) ?? 99));
    const beforeBalances = new Map(receivables.map((row) => [row.cxCID, Number(row.balancePendiente) || 0]));
    const mutableLines = applyReceivablePaymentLines(receivables, amountToDebt, orderedLines, cashDate);
    const affected = receivables
      .map((row) => ({ id: row.cxCID, invoiceId: row.facturaID || "", applied: (beforeBalances.get(row.cxCID) || 0) - (Number(row.balancePendiente) || 0) }))
      .filter((row) => row.applied > 0);
    const affectedInvoiceIds = [...new Set(affected.map((row) => row.invoiceId).filter(Boolean))];
    const totalApplied = affected.reduce((sum, row) => sum + row.applied, 0);
    // El procesador de tarjeta siempre debe el monto COMPLETO de la linea,
    // sin importar entre cuantas facturas/CxC distintas se repartio ese
    // dinero: una sola CxC general (sin facturaID propio) por linea de
    // tarjeta, igual que en facturacion pero no atada a una factura.
    paymentLines
      .filter((line) => line.method === "tarjeta")
      .forEach((line) => {
        const processor = findProcessorByName(line.processor) || processorForPayment("tarjeta");
        addReceivable("", { clienteID: processor.procesadorID || "" }, processor.nombre || "Procesador tarjeta", line.amount, "CxC procesador tarjeta", "", cashDate);
      });
    const remainingExtra = mutableLines.reduce((sum, line) => sum + (Number(line.remaining) || 0), 0);
    if (remainingExtra > 0) {
      const finalPolicy = overpayPolicy === "balance" || overpayPolicy === "cxc" ? "balance" : "sobrante";
      mutableLines.forEach((line) => {
        if (line.remaining <= 0) return;
        if (finalPolicy === "balance") {
          adjustClientBalance(clientRecord?.clienteID, line.remaining);
          createExtraIncome(line, line.remaining, clientRecord, clientRecord.nombreCompleto || "", cashDate, "Balance a favor de cliente", "Excedente de cobro aplicado a balance a favor");
        } else {
          createExtraIncome(line, line.remaining, clientRecord, clientRecord.nombreCompleto || "", cashDate, "Sobrante de caja", "Excedente de cobro de cuenta por cobrar");
        }
      });
    }
    // Un solo recibo (este submit) para varias CxC/facturas: se audita una
    // vez, con la lista completa de facturas afectadas.
    logAudit("cxc_receipt_created", {
      entity: "cuentasCobrar",
      entityId: affected.map((row) => row.id).join(","),
      newData: { cliente: clientRecord.nombreCompleto || "", facturasAfectadas: affectedInvoiceIds, cuentasAfectadas: affected.map((row) => row.id), montoAplicado: totalApplied },
      note: `Cobro general de cliente aplicado a ${affected.length} cuenta(s) por cobrar por ${money.format(totalApplied)}.`,
      success: true,
    });
    event.target.reset();
    byId("income-payment-line-list").innerHTML = "";
    byId("payment-cash-date").value = today;
    byId("payment-method-amount").value = "";
    updateIncomePaymentFields();
    updatePaymentSummary();
    saveState();
    renderAll();
    returnToBillingAfterReceipt();
    } finally {
      paymentSubmitInFlight = false;
      byId("payment-submit").disabled = false;
    }
  });
  byId("payment-receipt-cancel")?.addEventListener("click", (event) => {
    event.preventDefault();
    returnToBillingAfterReceipt();
  });

  ensureCashModuleMarkup();
  bindCashTableActions();
  bindCashViewActionButtons();

  byId("new-cash-closing")?.addEventListener("click", showNewCashClosing);
  byId("cancel-cash-closing")?.addEventListener("click", hideCashClosingForm);
  byId("cash-add-expense")?.addEventListener("click", openAddExpenseFromClosing);
  byId("cash-add-expense-cancel")?.addEventListener("click", (event) => {
    event.preventDefault();
    returnToClosingAfterExpense();
  });
  byId("confirm-previous-closings")?.addEventListener("click", confirmPreviousPendingClosings);
  byId("toggle-cash-income-detail")?.addEventListener("click", () => byId("cash-income-detail")?.classList.toggle("hidden"));
  byId("toggle-cash-expense-detail")?.addEventListener("click", () => byId("cash-expense-detail")?.classList.toggle("hidden"));
  // "Monto inicial" es un <output>, no un control de formulario: no puede
  // recibir foco, teclado, pegado ni rueda del mouse, asi que ya no hace
  // falta bloquear esos eventos a mano (antes era un input readonly y estos
  // listeners eran defensa en profundidad ademas del atributo readonly). La
  // fuente de verdad real sigue siendo defaultInitialCashFor(): el submit y
  // el cuadre de efectivo recalculan el monto inicial de nuevo cada vez.

  byId("income-table").addEventListener("click", (event) => {
    const viewButton = event.target.closest(".view-income");
    const editButton = event.target.closest(".edit-income-date");
    const voidButton = event.target.closest(".void-income");
    if (viewButton) openIncomeReport(viewButton.dataset.incomeId);
    if (editButton) changeIncomeDate(editButton.dataset.incomeId);
    if (voidButton) voidReceivableReceipt(voidButton.dataset.incomeId);
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

  byId("transfer-confirm-cancel")?.addEventListener("click", () => {
    byId("transfer-confirm-dialog")?.close();
  });

  byId("transfer-confirm-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const dialog = byId("transfer-confirm-dialog");
    const cxcId = dialog?.dataset.cxcId || "";
    const depositDate = byId("transfer-confirm-date").value;
    const message = byId("transfer-confirm-message");
    try {
      confirmPendingTransfer(cxcId, depositDate);
      state = stateFromDatabase(database);
      saveState();
      dialog.close();
      renderAll();
    } catch (error) {
      message.textContent = error.message || "No se pudo confirmar la transferencia.";
      message.className = "form-message error";
    }
  });

  byId("card-reconciliation-table").addEventListener("click", (event) => {
    const button = event.target.closest(".select-card-closing");
    if (!button) return;
    selectCardClosing(button.dataset.closingId);
  });

  byId("generate-cash-balance")?.addEventListener("click", updateCashBalancePreview);

  // "cash-expenses" ya no esta en esta lista: es un <output> de solo
  // lectura, nunca dispara eventos "input" por interaccion del usuario.
  ["cash-counted", "cash-date", "cash-account"].forEach((id) => {
    byId(id)?.addEventListener("input", () => {
      resetCashBalancePreview();
      if (id === "cash-date") {
        updateClosingCollaboratorDetails(byId("cash-date").value);
        // Monto inicial y Egresos del dia dependen de la fecha (buscan el
        // cierre anterior / los egresos de esa fecha): si la fecha cambia,
        // ambos deben recalcularse para la nueva fecha, nunca quedarse con
        // el valor de la fecha anterior.
        const account = registerAccount();
        const newDate = byId("cash-date").value || today;
        byId("cash-initial").textContent = money.format(defaultInitialCashFor(account, newDate));
        const activity = accountActivityForDate(newDate, account);
        byId("cash-expenses").textContent = money.format(activity.expenses + activity.transferOut);
      }
    });
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
  byId("expense-receivable-person").addEventListener("input", updateExpenseOptionalFields);
  byId("expense-destination-type").addEventListener("change", updateExpenseDestinationLookup);
  ["expense-source", "expense-destination", "expense-amount"].forEach((id) => {
    byId(id).addEventListener("input", updateExpenseBalancePreview);
  });
  let expenseSubmitInFlight = false;
  byId("expense-form").addEventListener("submit", (event) => {
    event.preventDefault();
    // Evita doble registro por doble clic o doble submit mientras el guardado
    // anterior todavia esta en curso.
    if (expenseSubmitInFlight) return;
    const editId = byId("expense-edit-id").value;
    const type = byId("expense-type").value;
    const rawAmount = byId("expense-amount").value;
    const amount = Number(rawAmount);
    const source = byId("expense-source").value.trim();
    const destination = byId("expense-destination").value.trim();
    const destinationType = byId("expense-destination-type").value;
    const concept = byId("expense-concept").value.trim();
    const note = byId("expense-note").value.trim();
    const expenseDate = byId("expense-date").value;
    // Antes esta validacion era "if (!amount || !source || !concept) return;":
    // un return mudo, sin alert ni foco, indistinguible de un boton roto. Cada
    // caso ahora avisa exactamente que falta.
    if (rawAmount === "" || !Number.isFinite(amount) || amount <= 0) {
      alert("Ingresa un monto de egreso mayor que cero.");
      byId("expense-amount").focus();
      return;
    }
    if (!source) {
      alert("Selecciona la cuenta o caja de origen del egreso.");
      byId("expense-source").focus();
      return;
    }
    if (!concept) {
      alert("Describe el concepto del egreso.");
      byId("expense-concept").focus();
      return;
    }
    if (!DalfiClosingMath.isValidIsoDate(expenseDate)) {
      alert("La fecha del egreso no es válida.");
      byId("expense-date").focus();
      return;
    }
    const sourceAccountSelected = findAccountByName(source);
    if (!sourceAccountSelected) {
      alert("Selecciona una cuenta o caja origen válida.");
      byId("expense-source").focus();
      return;
    }
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
    const destinationAccountSelected = type === "transferencia"
      ? destinationType === "bank"
        ? findBankAccountByName(destination)
        : findCashAccountByName(destination)
      : null;
    if (type === "transferencia" && !destinationAccountSelected) {
      alert(destinationType === "bank" ? "Selecciona una cuenta bancaria destino." : "Selecciona una caja destino.");
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
    }
    const submitButton = byId("expense-submit");
    const originalSubmitLabel = submitButton.textContent;
    expenseSubmitInFlight = true;
    submitButton.disabled = true;
    submitButton.textContent = "Guardando...";
    try {
      if (existingExpense) {
        const targetDate = byId("expense-date").value;
        const sourceDate = dateOnly(existingExpense.fechaHora);
        const oldData = { ...existingExpense };
        Object.assign(existingExpense, {
          fechaHora: withDateOnly(existingExpense.fechaHora, targetDate),
          tipoEgreso: type,
          cuentaOrigenID: sourceAccountSelected?.cuentaID || "",
          cuentaOrigen: source,
          cuentaDestinoID: destinationAccountSelected?.cuentaID || "",
          cuentaDestino: destination,
          concepto: concept,
          monto: amount,
          observaciones: note,
        });
        stampRecord(existingExpense, "updated");
        refreshPendingClosingsForDate(sourceDate);
        refreshPendingClosingsForDate(targetDate);
        logAudit("expense_edit", {
          entity: "egresos",
          entityId: existingExpense.egresoID,
          oldData,
          newData: existingExpense,
          success: true,
        });
        event.target.reset();
        byId("expense-edit-id").value = "";
        submitButton.textContent = "Guardar egreso";
        byId("expense-date").value = today;
        updateExpenseOptionalFields();
        updateExpenseBalancePreview();
        state = stateFromDatabase(database);
        saveState();
        renderAll();
        if (cashPendingExpenseReturn) returnToClosingAfterExpense();
        return;
      }
      const expenseId = nextDbId("egresos", "egresoID", "EGR");
      const sourceAccount = sourceAccountSelected;
      const destinationAccount = destinationAccountSelected || findAccountByName(destination);
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
      const expenseRecord = stampRecord({
        egresoID: expenseId,
        fechaHora: `${row.date}T12:00:00`,
        tipoEgreso: type,
        cuentaOrigenID: sourceAccount?.cuentaID || "",
        cuentaOrigen: source,
        cuentaDestinoID: destinationAccount?.cuentaID || "",
        cuentaDestino: destination,
        concepto: concept,
        monto: amount,
        estado: "Registrado",
        observaciones: note,
      });
      dbTable("egresos").push(expenseRecord);
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
          // Efectivo/salario/propina son subtipos del mismo avance a
          // colaborador (todos generan un egreso real + una CxC por el
          // mismo monto): el concepto guardado distingue cual es, para que
          // el reporte de nomina pueda mostrarlos por separado.
          const advanceType = byId("expense-advance-type").value || "efectivo";
          const advanceLabel = { efectivo: "Avance de efectivo", salario: "Avance de salario", propina: "Avance de propina" }[advanceType] || "Avance de efectivo";
          const cxcId = nextDbId("cuentasCobrar", "cxCID", "CXC");
          dbTable("cuentasCobrar").push(stampRecord({
            cxCID: cxcId,
            fechaOrigen: new Date().toISOString(),
            tipoCxC: advanceLabel,
            deudorTipo: "Colaborador",
            deudorID: staffRecord.colaboradorID,
            deudorNombre: staffRecord.nombreCompleto,
            facturaID: "",
            pagoID: "",
            egresoID: expenseId,
            montoOriginal: amount,
            montoAplicado: 0,
            balancePendiente: amount,
            estado: "Pendiente",
            concepto: `${advanceLabel}: ${concept}`,
            fechaVencimiento: today,
          }));
          logAudit("collaborator_receivable_created", {
            entity: "cuentasCobrar",
            entityId: cxcId,
            newData: { colaboradorID: staffRecord.colaboradorID, tipo: advanceLabel, monto: amount, egresoID: expenseId },
            note: `${advanceLabel} de ${money.format(amount)} para ${staffRecord.nombreCompleto}, vinculado al egreso ${expenseId}.`,
            success: true,
          });
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
      refreshPendingClosingsForDate(row.date);
      logAudit("expense_create", {
        entity: "egresos",
        entityId: expenseId,
        newData: expenseRecord,
        success: true,
      });
      event.target.reset();
      byId("expense-edit-id").value = "";
      submitButton.textContent = "Guardar egreso";
      byId("expense-date").value = today;
      updateExpenseOptionalFields();
      updateExpenseBalancePreview();
      saveState();
      renderAll();
      if (cashPendingExpenseReturn) returnToClosingAfterExpense();
    } catch (error) {
      console.error("No se pudo guardar el egreso.", error);
      logAudit(existingExpense ? "expense_edit" : "expense_create", {
        entity: "egresos",
        entityId: editId || "",
        newData: { type, source, destination, concept, amount, date: byId("expense-date").value },
        success: false,
        note: error?.message || String(error),
      });
      alert(`No se pudo guardar el egreso: ${error?.message || "error inesperado"}. Intenta de nuevo.`);
    } finally {
      expenseSubmitInFlight = false;
      submitButton.disabled = false;
      // Los caminos de exito ya dejaron el texto correcto ("Guardar egreso");
      // si seguia en "Guardando..." es porque el catch interrumpio antes de
      // llegar ahi, asi que se restaura la etiqueta que tenia el boton al
      // entrar (por ejemplo "Guardar cambios" si se estaba editando).
      if (submitButton.textContent === "Guardando...") submitButton.textContent = originalSubmitLabel;
    }
  });

  byId("expense-table").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-expense-id]");
    if (!row) return;
    if (event.target.closest(".view-expense")) openExpenseReport(row.dataset.expenseId);
    if (event.target.closest(".edit-expense")) startExpenseEdit(row.dataset.expenseId);
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
    const editButton = event.target.closest(".edit-reservation");
    if (editButton) {
      startReservationEdit(editButton.dataset.reservationId);
      return;
    }
    const button = event.target.closest(".invoice-reservation");
    if (!button) return;
    populateInvoiceFromReservation(button.dataset.reservationId);
  });

  byId("reservation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const formMessage = byId("reservation-form-message");
    const setMessage = (text, kind = "") => {
      if (!formMessage) return;
      formMessage.textContent = text;
      formMessage.className = kind ? `form-message ${kind}` : "form-message";
    };
    let client = byId("reservation-client-search").value.trim();
    const service = byId("reservation-service-search").value.trim();
    const staff = byId("reservation-staff").value.trim();
    const phone = byId("reservation-client-phone").value.trim();
    const email = byId("reservation-client-email").value.trim();
    const source = byId("reservation-source").value;
    const status = byId("reservation-status")?.value || "Programada";
    const reservationDateValue = byId("reservation-date").value;
    const reservationTimeValue = byId("reservation-time").value;
    if (!client || !service || !staff || !reservationDateValue || !reservationTimeValue) {
      setMessage("Completa cliente, servicio, técnico/a, fecha y hora antes de guardar.", "error");
      return;
    }
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
    const editId = byId("reservation-edit-id")?.value || "";
    const currentReservation = editId ? reservationRecordById(editId) : null;
    if (editId && !currentReservation?.record) {
      setMessage("Esta cita ya no existe (puede que otra persona la haya eliminado). Se actualizó la agenda.", "error");
      resetReservationEditState(event.target);
      renderAll();
      return;
    }
    const reservationId = editId || nextDbId("reservas", "reservaID", "RES");
    const reservationDate = reservationDateValue;
    const reservationTime = reservationTimeValue;
    const reservationNote = byId("reservation-note").value.trim();
    const statePayload = {
      id: reservationId,
      date: reservationDate,
      time: reservationTime,
      clientId: clientRecord?.clienteID || "",
      client: clientRecord?.nombreCompleto || client,
      phone,
      email,
      provisional: isProvisional,
      source,
      serviceId: serviceRecord?.servicioID || "",
      service,
      staff,
      status,
      note: reservationNote,
      invoiceId: currentReservation?.record?.invoiceId || currentReservation?.record?.facturaID || "",
    };
    const dbPayload = {
      reservaID: reservationId,
      fecha: reservationDate,
      hora: reservationTime,
      clienteID: clientRecord?.clienteID || "",
      clienteNombre: clientRecord?.nombreCompleto || client,
      telefono: phone,
      correo: email,
      clienteProvisional: isProvisional,
      canalOrigen: source,
      servicioID: serviceRecord?.servicioID || "",
      servicio: service,
      colaboradorNombre: staff,
      estado: status,
      facturaID: currentReservation?.record?.facturaID || currentReservation?.record?.invoiceId || "",
      observaciones: reservationNote,
    };
    try {
      if (editId) {
        const stateIndex = state.reservations.findIndex((reservation) => reservation.id === editId);
        if (stateIndex >= 0) state.reservations[stateIndex] = statePayload;
        else state.reservations.push(statePayload);
        const existingDb = dbTable("reservas").find((row) => row.reservaID === editId);
        if (existingDb) {
          Object.assign(existingDb, dbPayload);
          stampRecord(existingDb, "updated");
        } else {
          dbTable("reservas").push(stampRecord(dbPayload));
        }
        logAudit("reservation_edit", { entity: "reservas", entityId: editId, newData: dbPayload, success: true });
      } else {
        state.reservations.push(statePayload);
        dbTable("reservas").push(stampRecord(dbPayload));
      }
      event.target.reset();
      resetReservationEditState(event.target);
      delete event.target.dataset.clientId;
      delete byId("reservation-client-phone").dataset.autofilled;
      delete byId("reservation-client-email").dataset.autofilled;
      byId("reservation-date").value = today;
      byId("reservation-source").value = "Presencial";
      saveState();
      renderAll();
      setMessage(editId ? "Cita actualizada correctamente." : "Cita guardada correctamente.", "success");
    } catch (error) {
      console.error("Error guardando la cita", error);
      setMessage(`No se pudo guardar la cita: ${error.message || error}`, "error");
    }
  });

  // Guardar SOLO calcula y congela un borrador (payrollId, snapshot de
  // umbral/TSS/vacaciones, que propinas/CxC quedarian incluidas): no marca
  // propinas ni comision pagadas, no descuenta CxC, no crea egreso ni CxP.
  // Ese lado real solo ocurre al Pagar (ver #pay-payroll-form), que ejecuta
  // exactamente lo que este snapshot describe, nunca recalcula "en vivo" con
  // datos que pudieron cambiar entre Guardar y Pagar.
  let payrollSubmitInFlight = false;
  byId("payroll-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (payrollSubmitInFlight) return;
    if (!canManageInvoices()) {
      alert("Solo administración o propietario puede guardar nómina.");
      return;
    }
    const data = updatePayrollPreview(false);
    if (!data.staffName) return;
    payrollSubmitInFlight = true;
    byId("payroll-submit").disabled = true;
    try {
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
          salarioMensual: data.installment.monthlyTotal || (data.cut === "month" ? data.base : data.base * 2),
          direccion: "",
          correo: "",
          estado: "Activo",
          fechaIngreso: today,
          umbralesComisionActivos: [],
        };
        dbTable("colaboradores").push(stampRecord(staffRecord));
      }
      if (existingActivePayrollFor(staffRecord?.colaboradorID, data.staffName, data.range.start, data.range.end)) {
        alert("Ya existe una nómina (borrador o pagada) para este colaborador en este período y corte. No se puede duplicar.");
        return;
      }
      const payrollId = nextDbId("nomina", "nominaID", "NOM");
      const otherConcept = byId("payroll-other-concept").value.trim();
      if (otherConcept && !dbTable("conceptosDescuentoNomina").some((row) => normalize(row.concepto) === normalize(otherConcept))) {
        dbTable("conceptosDescuentoNomina").push(stampRecord({ conceptoID: nextDbId("conceptosDescuentoNomina", "conceptoID", "DESC"), concepto: otherConcept, estado: "Activo" }));
      }
      const cxcDiscountDetalle = [...document.querySelectorAll(".payroll-cxc-discount")]
        .map((input) => ({ cxcId: input.dataset.cxcId, amount: Number(input.value) || 0 }))
        .filter((row) => row.amount > 0);
      dbTable("nomina").push(stampRecord({
        nominaID: payrollId,
        periodoInicio: data.range.start,
        periodoFin: data.range.end,
        quincena: data.range.label,
        payrollType: data.cut,
        colaboradorID: staffRecord?.colaboradorID || "",
        colaboradorNombre: data.staffName,
        salarioBaseMensual: Number(staffRecord?.salarioMensual) || data.installment.monthlyTotal || 0,
        salarioQuincenal: data.base,
        salarioInstallmentSnapshot: data.installment,
        vacationSalaryOffset: data.vacationOffset,
        commissionPeriodStart: data.commissionTipRange?.start || "",
        commissionPeriodEnd: data.commissionTipRange?.end || "",
        commissionRuleSnapshot: data.threshold,
        totalFacturadoMes: data.sales,
        porcentajeComision: data.rate,
        comisionGenerada: data.commission,
        propinaNetaMes: data.tips,
        propinaIdsIncluidas: data.tipsRows.map((tip) => tip.propinaID),
        bonos: data.bonusLines,
        anticipos: 0,
        descuentoAFP: data.afp,
        descuentoSeguro: data.insurance,
        descuentoOtros: data.other,
        descuentoCxC: data.cxcDiscounts,
        cxcDiscountDetalle,
        tssEmployeeDeduction: data.tssEmployee,
        employerTssContribution: data.tssEmployer,
        tssConfigId: data.tssConfig?.tssID || "",
        conceptoOtrosDescuentos: otherConcept,
        totalAPagar: data.net,
        estado: "Borrador",
      }));
      logAudit("payroll_draft_saved", {
        entity: "nomina",
        entityId: payrollId,
        newData: { colaboradorID: staffRecord?.colaboradorID || "", periodo: data.period, corte: data.cut, neto: data.net },
        note: `Borrador de nómina ${payrollId} guardado para ${data.staffName}, ${data.range.label} ${data.period}.`,
        success: true,
      });
      data.bonusLines.forEach((line) => {
        logAudit("payroll_bonus_added", {
          entity: "nomina",
          entityId: payrollId,
          newData: { concepto: line.concept, monto: line.amount, sujetoATss: line.subjectToTss },
          note: `Bono "${line.concept}" agregado al borrador ${payrollId} por ${money.format(line.amount)}.`,
          success: true,
        });
      });
      event.target.reset();
      byId("payroll-period").value = month;
      byId("payroll-cut").value = "month";
      byId("payroll-afp").value = 0;
      byId("payroll-insurance").value = 0;
      byId("payroll-other-deductions").value = 0;
      byId("payroll-cxc-total").value = 0;
      byId("payroll-bonus-list").innerHTML = "";
      renderPayrollCxCList([]);
      saveState();
      renderAll();
      updatePayrollPreview(true);
    } finally {
      payrollSubmitInFlight = false;
      byId("payroll-submit").disabled = false;
    }
  });

  // ---------------------------------------------------------------------
  // Vacaciones: Solicitada -> Aprobada -> Pagada anticipadamente -> Disfrutada,
  // con Cancelada como salida antes del pago. Cada transicion es una accion
  // separada, con su propio permiso y auditoria (nunca se salta un paso).
  // ---------------------------------------------------------------------

  let vacationSubmitInFlight = false;
  byId("vacation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (vacationSubmitInFlight) return;
    if (!canManageInvoices()) {
      alert("Solo administración o propietario puede solicitar vacaciones.");
      return;
    }
    const staffName = byId("vacation-staff").value.trim();
    const staffRecord = findStaffByName(staffName);
    if (!staffRecord) {
      alert("Selecciona un colaborador existente.");
      byId("vacation-staff").focus();
      return;
    }
    const startDate = byId("vacation-start").value;
    const days = Number(byId("vacation-days").value) || 0;
    if (!DalfiClosingMath.isValidIsoDate(startDate)) {
      alert("Indica una fecha de inicio válida.");
      byId("vacation-start").focus();
      return;
    }
    if (!(days > 0)) {
      alert("Los días deben ser mayores que cero.");
      byId("vacation-days").focus();
      return;
    }
    vacationSubmitInFlight = true;
    try {
      const vacationId = nextDbId("vacaciones", "vacationId", "VAC");
      dbTable("vacaciones").push(stampRecord({
        vacationId,
        colaboradorID: staffRecord.colaboradorID || "",
        colaboradorNombre: staffName,
        fechaInicio: startDate,
        fechaFin: DalfiClosingMath.addDaysToIsoDate(startDate, Math.max(0, days - 1)),
        diasPagados: days,
        valorDiario: 0,
        montoAnticipado: 0,
        estado: "Solicitada",
        observaciones: byId("vacation-note").value.trim(),
      }));
      logAudit("vacation_requested", {
        entity: "vacaciones",
        entityId: vacationId,
        newData: { colaboradorID: staffRecord.colaboradorID || "", fechaInicio: startDate, dias: days },
        note: `Vacaciones solicitadas para ${staffName}: ${days} días desde ${startDate}.`,
        success: true,
      });
      event.target.reset();
      saveState();
      renderAll();
    } finally {
      vacationSubmitInFlight = false;
    }
  });

  byId("cancel-vacation-approve").addEventListener("click", (event) => {
    event.preventDefault();
    byId("vacation-approve-form").classList.add("hidden");
  });

  byId("vacation-approve-daily-value").addEventListener("input", () => {
    const vacation = dbTable("vacaciones").find((row) => row.vacationId === byId("vacation-approve-id").value);
    const days = Number(vacation?.diasPagados) || 0;
    const dailyValue = Number(byId("vacation-approve-daily-value").value) || 0;
    byId("vacation-approve-amount").textContent = money.format(DalfiClosingMath.roundMoney(days * dailyValue));
  });

  byId("vacation-approve-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!canManageInvoices()) {
      alert("Solo administración o propietario puede aprobar vacaciones.");
      return;
    }
    const vacationId = byId("vacation-approve-id").value;
    const vacation = dbTable("vacaciones").find((row) => row.vacationId === vacationId);
    if (!vacation || normalize(vacation.estado || "") !== "solicitada") {
      alert("Esta solicitud ya no está pendiente de aprobación.");
      byId("vacation-approve-form").classList.add("hidden");
      return;
    }
    const dailyValue = Number(byId("vacation-approve-daily-value").value) || 0;
    if (!(dailyValue > 0)) {
      alert("Indica el valor diario a utilizar (política de valor diario configurada para el negocio).");
      byId("vacation-approve-daily-value").focus();
      return;
    }
    const days = Number(vacation.diasPagados) || 0;
    vacation.valorDiario = dailyValue;
    vacation.montoAnticipado = DalfiClosingMath.roundMoney(days * dailyValue);
    vacation.estado = "Aprobada";
    stampRecord(vacation, "updated");
    logAudit("vacation_approved", {
      entity: "vacaciones",
      entityId: vacationId,
      newData: { valorDiario: dailyValue, monto: vacation.montoAnticipado },
      note: `Vacaciones de ${vacation.colaboradorNombre} aprobadas por ${money.format(vacation.montoAnticipado)}.`,
      success: true,
    });
    byId("vacation-approve-form").classList.add("hidden");
    saveState();
    renderAll();
  });

  byId("cancel-vacation-pay").addEventListener("click", (event) => {
    event.preventDefault();
    byId("vacation-pay-form").classList.add("hidden");
  });

  let vacationPaySubmitInFlight = false;
  byId("vacation-pay-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (vacationPaySubmitInFlight) return;
    if (!canManageInvoices()) {
      alert("Solo administración o propietario puede pagar el anticipo de vacaciones.");
      return;
    }
    const vacationId = byId("vacation-pay-id").value;
    const vacation = dbTable("vacaciones").find((row) => row.vacationId === vacationId);
    if (!vacation || normalize(vacation.estado || "") !== "aprobada") {
      alert("Solo unas vacaciones Aprobadas pueden pagarse.");
      byId("vacation-pay-form").classList.add("hidden");
      return;
    }
    const accountName = byId("vacation-pay-account").value.trim();
    const account = findAccountByName(accountName);
    if (!account) {
      alert("Selecciona una cuenta o caja válida para pagar el anticipo.");
      byId("vacation-pay-account").focus();
      return;
    }
    const payDate = byId("vacation-pay-date").value || today;
    if (!DalfiClosingMath.isValidIsoDate(payDate)) {
      alert("Indica una fecha de pago válida.");
      return;
    }
    const amount = Number(vacation.montoAnticipado) || 0;
    const available = accountAvailableBalance(accountName);
    if (amount > available) {
      alert(`El anticipo supera el disponible en ${accountName}. Disponible: ${money.format(available)}.`);
      return;
    }
    vacationPaySubmitInFlight = true;
    try {
      const expenseId = nextDbId("egresos", "egresoID", "EGR");
      dbTable("egresos").push(stampRecord({
        egresoID: expenseId,
        fechaHora: `${payDate}T12:00:00`,
        tipoEgreso: "vacaciones",
        cuentaOrigenID: account.cuentaID || "",
        cuentaOrigen: accountName,
        cuentaDestinoID: "",
        cuentaDestino: "",
        concepto: `Vacaciones anticipadas ${vacation.colaboradorNombre} (${vacation.diasPagados} días)`,
        monto: amount,
        estado: "Registrado",
        observaciones: vacation.observaciones || "",
      }));
      vacation.fechaPagoAnticipado = payDate;
      vacation.cuentaID = account.cuentaID || "";
      vacation.cuenta = accountName;
      vacation.egresoID = expenseId;
      vacation.estado = "Pagada anticipadamente";
      stampRecord(vacation, "updated");
      refreshPendingClosingsForDate(payDate);
      logAudit("vacation_advance_paid", {
        entity: "vacaciones",
        entityId: vacationId,
        newData: { colaboradorID: vacation.colaboradorID, dias: vacation.diasPagados, monto: amount, cuenta: accountName, egresoID: expenseId },
        note: `Anticipo de vacaciones pagado a ${vacation.colaboradorNombre}: ${vacation.diasPagados} días por ${money.format(amount)}.`,
        success: true,
      });
      byId("vacation-pay-form").classList.add("hidden");
      saveState();
      renderAll();
    } finally {
      vacationPaySubmitInFlight = false;
    }
  });

  byId("vacation-table").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-vacation-id]");
    if (!row) return;
    const vacationId = row.dataset.vacationId;
    if (event.target.closest(".approve-vacation")) openVacationApproveForm(vacationId);
    if (event.target.closest(".pay-vacation")) openVacationPayForm(vacationId);
    if (event.target.closest(".mark-vacation-enjoyed")) markVacationEnjoyed(vacationId);
    if (event.target.closest(".cancel-vacation")) cancelVacation(vacationId);
  });

  byId("vacation-search").addEventListener("input", renderVacations);

  let collaboratorChargeSubmitInFlight = false;
  byId("collaborator-charge-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (collaboratorChargeSubmitInFlight) return;
    const staffName = byId("collaborator-charge-staff").value.trim();
    const staffRecord = findStaffByName(staffName);
    const amount = Number(byId("collaborator-charge-amount").value) || 0;
    const concept = byId("collaborator-charge-concept").value.trim();
    const tipoCxC = byId("collaborator-charge-type").value;
    collaboratorChargeSubmitInFlight = true;
    try {
      createCollaboratorInternalCharge({ staffRecord, staffName, amount, concept, tipoCxC });
      event.target.reset();
      saveState();
      renderAll();
    } catch (error) {
      alert(error?.message || "No se pudo registrar el cargo.");
    } finally {
      collaboratorChargeSubmitInFlight = false;
    }
  });

  byId("collaborator-receivable-search").addEventListener("input", renderCollaboratorReceivables);
  byId("collaborator-receivable-search").closest("section").querySelectorAll(".collaborator-receivable-filter").forEach((button) => {
    button.addEventListener("click", () => {
      button.parentElement.querySelectorAll(".collaborator-receivable-filter").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      renderCollaboratorReceivables();
    });
  });

  byId("payroll-table").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-payroll-id]");
    if (!row) return;
    const payrollId = row.dataset.payrollId;
    if (event.target.closest(".approve-payroll")) approvePayroll(payrollId);
    if (event.target.closest(".reopen-payroll")) reopenPayroll(payrollId);
    if (event.target.closest(".pay-payroll")) openPayPayrollForm(payrollId);
    if (event.target.closest(".revert-payroll")) revertPayrollPayment(payrollId);
  });

  byId("cancel-pay-payroll").addEventListener("click", (event) => {
    event.preventDefault();
    byId("pay-payroll-form").classList.add("hidden");
    byId("pay-payroll-id").value = "";
  });

  let payPayrollSubmitInFlight = false;
  byId("pay-payroll-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (payPayrollSubmitInFlight) return;
    if (!canManageInvoices()) {
      alert("Solo administración o propietario puede pagar nómina.");
      return;
    }
    const payrollId = byId("pay-payroll-id").value;
    const payroll = dbTable("nomina").find((row) => row.nominaID === payrollId);
    if (!payroll) {
      alert("Esta nómina ya no existe.");
      return;
    }
    if (normalize(payroll.estado || "") !== "aprobada") {
      alert("Esta nómina debe estar Aprobada antes de pagarse. No se puede pasar de Borrador directo a Pagada.");
      return;
    }
    // Bloqueo funcional (no solo visual): la funcion interna vuelve a
    // rechazar la operacion aunque alguien haya llegado hasta aqui sin
    // pasar por el boton Pagar (por ejemplo, un formulario que quedo
    // abierto de una nomina que dejo de tener TSS vigente).
    const tssBlockReason = payrollTssBlockReason(payroll);
    if (tssBlockReason) {
      alert(tssBlockReason);
      return;
    }
    const accountName = byId("pay-payroll-account").value.trim();
    const account = findAccountByName(accountName);
    if (!account) {
      alert("Selecciona una cuenta o caja válida.");
      byId("pay-payroll-account").focus();
      return;
    }
    if (normalize(account.estado || "Activo") !== "activo") {
      alert("Esta cuenta está inactiva. Selecciona una cuenta activa.");
      return;
    }
    const method = byId("pay-payroll-method").value;
    const payDate = byId("pay-payroll-date").value || today;
    if (!DalfiClosingMath.isValidIsoDate(payDate)) {
      alert("Indica una fecha de pago válida.");
      return;
    }
    const net = Number(payroll.totalAPagar) || 0;
    if (net <= 0) {
      alert("El neto a pagar debe ser mayor que cero.");
      return;
    }
    const available = accountAvailableBalance(accountName);
    if (net > available) {
      alert(`El neto supera el disponible en ${accountName}. Disponible: ${money.format(available)}.`);
      return;
    }
    payPayrollSubmitInFlight = true;
    try {
      const expenseId = nextDbId("egresos", "egresoID", "EGR");
      dbTable("egresos").push(stampRecord({
        egresoID: expenseId,
        fechaHora: `${payDate}T12:00:00`,
        tipoEgreso: "nomina",
        cuentaOrigenID: account.cuentaID || "",
        cuentaOrigen: accountName,
        cuentaDestinoID: "",
        cuentaDestino: "",
        concepto: `Pago de nómina ${payroll.quincena} ${payroll.periodoInicio?.slice(0, 7) || ""} - ${payroll.colaboradorNombre}`,
        monto: net,
        estado: "Registrado",
        observaciones: `Nómina ${payrollId}`,
      }));
      // Propinas incluidas en el snapshot del borrador: se marcan pagadas
      // EXACTAMENTE las que quedaron congeladas al Guardar (propinaIdsIncluidas),
      // nunca "todas las pendientes ahora mismo" (eso podria incluir propinas
      // cobradas DESPUES de crear el borrador, que le corresponden a la
      // proxima nomina, no a esta).
      const tipIds = new Set(Array.isArray(payroll.propinaIdsIncluidas) ? payroll.propinaIdsIncluidas : []);
      dbTable("propinas").forEach((tip) => {
        if (!tipIds.has(tip.propinaID)) return;
        if (normalize(tip.estadoPagoNomina || "Pendiente") === "pagada") return;
        tip.estadoPagoNomina = "Pagada";
        tip.nominaID = payrollId;
        stampRecord(tip, "updated");
      });
      // CxC del colaborador: se aplican EXACTAMENTE los montos que quedaron
      // en el snapshot (cxcDiscountDetalle), revalidando que el saldo
      // todavia alcance (si cambio entre Guardar y Pagar, se aplica lo que
      // quede disponible, nunca mas de lo que la CxC realmente tiene).
      const cxcDetalle = Array.isArray(payroll.cxcDiscountDetalle) ? payroll.cxcDiscountDetalle : [];
      let totalCxcApplied = 0;
      cxcDetalle.forEach((line) => {
        const cxc = dbTable("cuentasCobrar").find((row) => row.cxCID === line.cxcId);
        if (!cxc) return;
        const applied = Math.min(Number(line.amount) || 0, Number(cxc.balancePendiente) || 0);
        if (applied <= 0) return;
        cxc.montoAplicado = (Number(cxc.montoAplicado) || 0) + applied;
        cxc.balancePendiente = Math.max(0, (Number(cxc.balancePendiente) || 0) - applied);
        cxc.estado = cxc.balancePendiente <= 0 ? "Saldada" : "Parcial";
        cxc.observaciones = `${cxc.observaciones || ""} Descontado en nómina ${payrollId}`.trim();
        stampRecord(cxc, "updated");
        totalCxcApplied += applied;
        logAudit("collaborator_receivable_applied", {
          entity: "cuentasCobrar",
          entityId: cxc.cxCID,
          newData: { payrollId, amountApplied: applied, remainingBalance: cxc.balancePendiente },
          note: `CxC ${cxc.cxCID} descontada ${money.format(applied)} en la nómina ${payrollId}.`,
          success: true,
        });
      });
      payroll.estado = "Pagada";
      payroll.fechaPagoNomina = payDate;
      payroll.montoPagadoNomina = net;
      payroll.cuentaPagoID = account.cuentaID || "";
      payroll.cuentaPago = accountName;
      payroll.medioPago = method;
      payroll.egresoID = expenseId;
      payroll.descuentoCxC = totalCxcApplied;
      stampRecord(payroll, "updated");
      refreshPendingClosingsForDate(payDate);
      logAudit("payroll_paid", {
        entity: "nomina",
        entityId: payrollId,
        newData: { colaboradorID: payroll.colaboradorID, neto: net, cuenta: accountName, medioPago: method, fecha: payDate, egresoID: expenseId, propinasIncluidas: [...tipIds], cxcAplicada: totalCxcApplied },
        note: `Nómina ${payrollId} pagada a ${payroll.colaboradorNombre} por ${money.format(net)}.`,
        success: true,
      });
      byId("pay-payroll-form").classList.add("hidden");
      byId("pay-payroll-id").value = "";
      saveState();
      renderAll();
    } finally {
      payPayrollSubmitInFlight = false;
    }
  });

  // Igual que expenseSubmitInFlight en el formulario de egresos: evita
  // procesar dos veces el mismo guardado/confirmacion por doble clic o
  // doble submit mientras el anterior todavia esta en curso.
  let cashSubmitInFlight = false;
  byId("cash-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (cashSubmitInFlight) return;
    if (!canManageInvoices()) {
      alert("Solo administradores y propietarios pueden guardar cierres de caja.");
      return;
    }
    const editId = byId("cash-edit-id").value;
    const confirmAfterSave = byId("cash-confirm-after-save").value === "true";
    const date = byId("cash-date").value;
    // El cierre de caja siempre opera sobre la unica cuenta de registradora;
    // ya no se elige cuenta, para no volver a crear un cierre por cuenta.
    const account = registerAccount();
    if (!account) {
      alert("No hay ninguna cuenta de caja activa configurada en Base de datos.");
      return;
    }
    const summary = dailyIncomeSummary(date);
    const activity = accountActivityForDate(date, account);
    // NUNCA se lee de byId("cash-initial").textContent (es un <output> de
    // solo lectura, y aunque no lo fuera, no es una fuente confiable): se
    // recalcula aqui mismo, en el momento de guardar/confirmar, para no
    // depender de lo que haya quedado pintado en el formulario ni de un
    // valor manipulado desde el navegador.
    const montoInicial = defaultInitialCashFor(account, date);
    const entradasEfectivo = activity.income + activity.transferIn;
    const salidasEfectivo = activity.expenses + activity.transferOut;
    const expected = DalfiClosingMath.computeExpectedCash({ montoInicial, entradasEfectivo, salidasEfectivo });
    const initialCounted = Number(byId("cash-counted").value);
    const cardCounted = Number(byId("cash-card-counted").value) || 0;
    const cardProcessorName = byId("cash-card-processor").value.trim();
    const transferCounted = Number(byId("cash-transfer-counted").value) || 0;
    // "Egresos del dia" ya NO es un input: es siempre salidasEfectivo,
    // calculado arriba desde accountActivityForDate(). Nunca se lee de
    // byId("cash-expenses") como fuente (ese elemento es un <output>, solo
    // muestra este mismo valor).
    const sameDateRegisterClosing = registerClosingForDate(date);
    if (!editId && sameDateRegisterClosing && !isClosingPendingConfirmation(sameDateRegisterClosing)) {
      alert("Ya existe un cierre de caja registradora confirmado en esa fecha. Administración debe reabrirlo antes de editarlo.");
      return;
    }
    const existingClosing = editId ? dbTable("cierres").find((row) => row.cierreID === editId) : sameDateRegisterClosing || null;
    if (editId && !existingClosing) {
      alert("Este cierre ya no existe (puede que otra persona lo haya modificado). Se actualizó la lista de cierres.");
      hideCashClosingForm();
      renderAll();
      return;
    }
    const formVersion = byId("cash-form").dataset.recordVersion || "";
    if (existingClosing && formVersion && existingClosing.fechaActualizacion && formVersion !== existingClosing.fechaActualizacion) {
      const keepGoing = confirm("Este cierre fue modificado por otra persona después de que abriste este formulario. Si continúas, tus valores reemplazarán esa otra edición. ¿Deseas continuar?");
      if (!keepGoing) return;
    }
    const closingId = existingClosing?.cierreID || nextDbId("cierres", "cierreID", "CIE");
    if (cardCounted > 0 && !findProcessorByName(cardProcessorName)) {
      alert("Selecciona la compañía de tarjeta creada en Base de datos para poder calcular su comisión.");
      byId("cash-card-processor").focus();
      return;
    }
    // Monto inicial, ingresos del dia y egresos del dia son SIEMPRE
    // calculados (nunca leidos del DOM). Si el "expected" recien calculado
    // ya no coincide con el que se uso para generar el cuadre en pantalla,
    // es porque algo en la fuente confiable cambio despues de abrir este
    // formulario (se confirmo un cierre anterior, o se agrego/edito/anulo
    // un ingreso o un egreso, por ejemplo con el boton "Agregar egreso"):
    // no se confirma con un monto esperado desactualizado, se pide
    // regenerar el cuadre primero.
    if (cashBalanceDraft && cashBalanceDraft.expected !== expected) {
      alert(
        "Los datos del cierre cambiaron desde que generaste el cuadre en pantalla (por ejemplo, se agregó/editó/anuló un ingreso o egreso, o se confirmó un cierre anterior). Genera el cuadre de efectivo de nuevo antes de guardar o confirmar.",
      );
      resetCashBalancePreview();
      byId("cash-initial").textContent = money.format(montoInicial);
      byId("cash-expenses").textContent = money.format(salidasEfectivo);
      byId("generate-cash-balance").focus();
      return;
    }
    if (!cashBalanceDraft || cashBalanceDraft.date !== date || cashBalanceDraft.account !== account.nombreCuenta || cashBalanceDraft.counted !== initialCounted) {
      alert("Primero debes generar el cuadre de efectivo para documentar el intento.");
      byId("generate-cash-balance").focus();
      return;
    }
    const initialDifference = initialCounted - expected;
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
    const { difference, shortage, surplus } = DalfiClosingMath.computeDifference(counted, expected);
    const isRegisterClosing = true; // este formulario ahora solo maneja el cierre de caja registradora

    // A partir de aqui empiezan las mutaciones reales (crear/actualizar el
    // cierre, el intento de faltante, el ingreso de sobrante): se marca
    // cashSubmitInFlight para que un doble clic/doble submit mientras esto
    // corre no vuelva a entrar, y se garantiza el reset del flag pase lo
    // que pase con un try/finally (igual que expenseSubmitInFlight).
    cashSubmitInFlight = true;
    byId("cash-submit").disabled = true;
    try {
    // Si sigue faltando efectivo despues de documentar el motivo y rectificar
    // el conteo, el cierre NO se confirma, pero tampoco se descarta: se
    // guarda como pendiente con los valores tal cual quedaron, y se deja un
    // registro persistente del intento fallido (no solo en pantalla).
    if (shortage > 0) {
      const attempt = {
        intentoID: nextDbId("cierreIntentos", "intentoID", "INT"),
        cuenta: account.nombreCuenta || "",
        cuentaID: account.cuentaID || "",
        fecha: date,
        montoEsperado: expected,
        montoReal: counted,
        faltante: shortage,
        usuario: currentUserEmail(),
        fechaHora: new Date().toISOString(),
        observacion: shortageNote,
      };
      dbTable("cierreIntentos").push(attempt);
      logAudit("closing_attempt_shortage", {
        entity: "cierres",
        entityId: closingId,
        newData: attempt,
        success: false,
        note: `Intento de cierre con faltante de ${money.format(shortage)} en ${account.nombreCuenta}.`,
      });
    }

    // Solo se confirma cuando la persona pidio explicitamente confirmar
    // (boton "Confirmar cierre" / "Confirmar y cerrar"), no hay faltante
    // pendiente, y quien guarda todavia tiene permiso para confirmar (se
    // revalida aqui, no solo al pintar el boton, porque el valor real que
    // decide si el cierre nace "Cerrado" es este, no la visibilidad del
    // boton). Antes, un cierre NUEVO (sin editId todavia) con cuadre exacto
    // se guardaba como "Cerrado" de inmediato con solo hacer clic en
    // "Guardar cierre" -sin pasar por confirmSingleRegisterClosing, sin
    // confirmadoPor/fechaConfirmacion, sin auditoria de confirmacion y sin
    // verificar canConfirmClosings()-, porque la condicion original
    // ("editId && !confirmAfterSave") solo protegia cierres YA existentes.
    const willConfirmNow = confirmAfterSave && shortage <= 0 && canConfirmClosings();
    const closingPayload = {
      closingType: "register",
      businessDate: date,
      fechaHoraCierre: `${date}T23:59:00`,
      cajero: defaultStaffRecord().nombreCompleto || "",
      cuentaCaja: account.nombreCuenta || "Caja Operaciones",
      cuentaID: account.cuentaID || "",
      balanceInicial: montoInicial,
      ingresosConfirmados: entradasEfectivo,
      egresos: salidasEfectivo,
      balanceTeorico: expected,
      balanceContado: counted,
      conteoInicial: initialCounted,
      balanceContadoRectificado: rectifiedCounted,
      diferenciaInicial: initialDifference,
      diferencia: difference,
      cuadreFaltante: shortage,
      cuadreFaltanteInicial: initialShortage,
      sobranteCaja: surplus,
      estado: willConfirmNow ? "Cerrado" : "Pendiente de confirmacion",
      requiereConfirmacion: !willConfirmNow,
      loteTarjeta: byId("cash-card-batch").value.trim(),
      tarjetaContada: cardCounted,
      tarjetaEsperada: isRegisterClosing ? summary.card : 0,
      procesadorTarjeta: cardProcessorName,
      comisionTarjetaPorcentaje: processorFeeRate(findProcessorByName(cardProcessorName)),
      transferenciaContada: transferCounted,
      transferenciaEsperada: isRegisterClosing ? summary.transfer : 0,
      creditoGenerado: isRegisterClosing ? summary.credit : 0,
      motivoFaltante: shortageNote,
      detalleColaboradores: closingCollaboratorSummary(date),
      observaciones: byId("cash-note").value.trim(),
    };
    if (willConfirmNow) {
      closingPayload.confirmadoPor = currentUserEmail();
      closingPayload.fechaConfirmacion = new Date().toISOString();
    }

    // El sobrante se registra en un unico ingreso vinculado al ID del
    // cierre: si se vuelve a guardar el mismo cierre (todavia sin confirmar)
    // se actualiza ese mismo ingreso en vez de duplicarlo, y si el
    // recalculo ya no arroja sobrante, se anula.
    const existingSurplusIncome = dbTable("ingresos").find((row) => row.cierreID === closingId && row.tipoIngreso === "Sobrante en cierre de caja");
    if (surplus > 0) {
      if (existingSurplusIncome) {
        existingSurplusIncome.montoBruto = surplus;
        existingSurplusIncome.montoNeto = surplus;
        existingSurplusIncome.fechaEntradaCaja = date;
        existingSurplusIncome.estado = "Confirmado";
        stampRecord(existingSurplusIncome, "updated");
      } else {
        dbTable("ingresos").push(stampRecord({
          ingresoID: nextDbId("ingresos", "ingresoID", "ING"),
          fechaHora: new Date().toISOString(),
          fechaEntradaCaja: date,
          tipoIngreso: "Sobrante en cierre de caja",
          cierreID: closingId,
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
      logAudit("closing_surplus", {
        entity: "cierres",
        entityId: closingId,
        newData: { surplus, date, cuenta: account.nombreCuenta },
        success: true,
      });
    } else if (existingSurplusIncome) {
      existingSurplusIncome.montoBruto = 0;
      existingSurplusIncome.montoNeto = 0;
      existingSurplusIncome.estado = "Anulado";
      stampRecord(existingSurplusIncome, "updated");
    }

    if (existingClosing) {
      Object.assign(existingClosing, closingPayload);
      stampRecord(existingClosing, "updated");
      if (willConfirmNow) confirmSingleRegisterClosing(existingClosing);
    } else {
      const newClosing = stampRecord({ cierreID: closingId, ...closingPayload });
      dbTable("cierres").push(newClosing);
      if (willConfirmNow) confirmSingleRegisterClosing(newClosing);
    }
    state = stateFromDatabase(database);
    event.target.reset();
    delete byId("cash-form").dataset.recordVersion;
    byId("cash-edit-id").value = "";
    byId("cash-confirm-after-save").value = "";
    byId("cash-submit").textContent = "Guardar cierre";
    byId("cash-date").value = today;
    byId("cash-initial").textContent = money.format(0);
    byId("cash-expenses").textContent = money.format(0);
    byId("cash-card-counted").value = 0;
    byId("cash-transfer-counted").value = 0;
    resetCashBalancePreview();
    byId("cash-form").classList.add("hidden");
    updateAddExpenseButtonState(null);
    saveState();
    renderAll();
    if (shortage > 0) {
      alert(`El cierre quedó guardado SIN CONFIRMAR porque todavía falta ${money.format(shortage)} en caja. Queda registrado el intento para revisión.`);
    } else if (willConfirmNow) {
      alert("Cierre confirmado correctamente.");
    } else {
      alert("Cierre guardado sin confirmar. Usa \"Confirmar cierre\" cuando el cuadre esté correcto.");
    }
    } finally {
      cashSubmitInFlight = false;
      byId("cash-submit").disabled = false;
    }
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
    if (!canManageInvoices()) {
      alert("Solo administración o propietario puede configurar el salario o los umbrales de un colaborador.");
      return;
    }
    const fullName = byId("staff-full-name").value.trim();
    if (!fullName) return;
    const parts = splitName(fullName);
    const editId = byId("staff-edit-id").value;
    let staff = dbTable("colaboradores").find((row) => row.colaboradorID === editId) || findStaffByName(fullName);
    const newSalary = Number(byId("staff-salary").value) || 0;
    if (!staff) {
      staff = {
        colaboradorID: nextDbId("colaboradores", "colaboradorID", "COL"),
        nombreCompleto: fullName,
        nombre: byId("staff-first-name").value.trim() || parts.first,
        apellido: byId("staff-last-name").value.trim() || parts.last,
        funcion: byId("staff-role").value.trim(),
        telefono: byId("staff-phone").value.trim(),
        salarioMensual: newSalary,
        direccion: byId("staff-address").value.trim(),
        correo: byId("staff-email").value.trim(),
        estado: "Activo",
        fechaIngreso: byId("staff-start-date").value || today,
        fechaNacimiento: byId("staff-birthdate").value || "",
        umbralesComisionActivos: selectedStaffThresholdIds(),
      };
      dbTable("colaboradores").push(stampRecord(staff));
    } else {
      // Historico de salario: cada CAMBIO real de salarioMensual queda como
      // su propia fila (nunca se sobreescribe en silencio), asi una nomina
      // ya pagada sigue siendo trazable contra el salario vigente cuando se
      // calculo (el snapshot de esa nomina ya congelo el monto usado; esto
      // es solo para auditoria/consulta del historico salarial).
      const previousSalary = Number(staff.salarioMensual) || 0;
      if (newSalary > 0 && newSalary !== previousSalary) {
        dbTable("historialSalarial").push(stampRecord({
          historialID: nextDbId("historialSalarial", "historialID", "HSAL"),
          colaboradorID: staff.colaboradorID,
          colaboradorNombre: fullName,
          salarioAnterior: previousSalary,
          salarioNuevo: newSalary,
          fechaVigencia: today,
        }));
      }
      staff.nombreCompleto = fullName;
      staff.nombre = byId("staff-first-name").value.trim() || staff.nombre;
      staff.apellido = byId("staff-last-name").value.trim() || staff.apellido;
      staff.funcion = byId("staff-role").value.trim() || staff.funcion;
      staff.telefono = byId("staff-phone").value.trim() || staff.telefono;
      staff.salarioMensual = newSalary || staff.salarioMensual;
      staff.direccion = byId("staff-address").value.trim() || staff.direccion;
      staff.correo = byId("staff-email").value.trim() || staff.correo;
      staff.fechaIngreso = byId("staff-start-date").value || staff.fechaIngreso;
      staff.fechaNacimiento = byId("staff-birthdate").value || staff.fechaNacimiento || "";
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
    if (!canManageInvoices()) {
      alert("Solo administración o propietario puede configurar umbrales de comisión.");
      return;
    }
    const appliesTo = byId("commission-applies-to").value.trim();
    if (!appliesTo) {
      alert("Debes indicar el nombre del umbral de comisión.");
      byId("commission-applies-to").focus();
      return;
    }
    const from = Number(byId("commission-from").value);
    const to = Number(byId("commission-to").value) || 0;
    const rawRate = Number(byId("commission-rate").value);
    const editId = byId("commission-edit-id").value;
    const existing = dbTable("umbralesComision").find((row) => row.escalaID === editId);
    // Igual que TSS: un umbral ya usado por una nomina PAGADA no se edita en
    // silencio (el snapshot de esa nomina ya quedo congelado con el
    // porcentaje que aplico, pero editar aqui podria aparentar que la
    // historia cambio). Se pide crear un umbral nuevo.
    if (existing) {
      const usedByPaidPayroll = dbTable("nomina").some(
        (row) => row.commissionRuleSnapshot?.thresholdId === editId && normalize(row.estado || "") === "pagada",
      );
      if (usedByPaidPayroll) {
        alert("Este umbral ya fue usado por una nómina pagada y no puede editarse. Crea un umbral nuevo en su lugar.");
        return;
      }
    }
    // Validacion real (antes no existia ninguna): minimo finito no-negativo,
    // maximo mayor que minimo, porcentaje 0-100, y rangos que no se solapen
    // con otro umbral activo del mismo grupo ("aplicaA").
    const candidate = { escalaID: editId || "", aplicaA: appliesTo, desde: from, hasta: to, porcentajeComision: rawRate, estado: byId("commission-status").value };
    const otherRules = dbTable("umbralesComision").filter((row) => row.escalaID !== editId);
    const validation = DalfiClosingMath.validateCommissionThresholdRule(candidate, otherRules);
    if (!validation.valid) {
      alert(validation.errors.join("\n"));
      byId("commission-from").focus();
      return;
    }
    const rate = rawRate > 1 ? rawRate / 100 : rawRate;
    const payload = {
      aplicaA: appliesTo,
      desde: from,
      hasta: to,
      porcentajeComision: rate,
      estado: byId("commission-status").value,
    };
    if (existing) Object.assign(existing, payload);
    else dbTable("umbralesComision").push(stampRecord({ escalaID: nextDbId("umbralesComision", "escalaID", "COM"), ...payload }));
    logAudit("commission_threshold_changed", {
      entity: "umbralesComision",
      entityId: existing ? editId : "",
      newData: payload,
      success: true,
    });
    event.target.reset();
    renderStaffThresholdChoices([]);
    closeDataForms();
    state = stateFromDatabase(database);
    saveState();
    renderAll();
  });

  byId("tss-config-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!canManageInvoices()) {
      alert("Solo administración o propietario puede configurar TSS.");
      return;
    }
    const employeeRate = Number(byId("tss-employee-rate").value);
    const employerRate = Number(byId("tss-employer-rate").value);
    const cap = Number(byId("tss-cap").value);
    const base = Number(byId("tss-base").value);
    const effectiveDate = byId("tss-effective-date").value;
    const endDate = byId("tss-end-date").value;
    if (![employeeRate, employerRate, cap, base].every((value) => Number.isFinite(value) && value >= 0) || employeeRate > 100 || employerRate > 100) {
      alert("Las tasas deben estar entre 0 y 100, y el tope/base deben ser montos válidos mayores o iguales a 0.");
      return;
    }
    if (!DalfiClosingMath.isValidIsoDate(effectiveDate)) {
      alert("Indica una fecha de vigencia válida.");
      byId("tss-effective-date").focus();
      return;
    }
    if (endDate && (!DalfiClosingMath.isValidIsoDate(endDate) || endDate < effectiveDate)) {
      alert("La fecha final debe ser válida y posterior a la fecha de vigencia.");
      byId("tss-end-date").focus();
      return;
    }
    const editId = byId("tss-edit-id").value;
    const existing = dbTable("configuracionTSS").find((row) => row.tssID === editId);
    // Una configuracion ya usada por al menos una nomina PAGADA no se
    // modifica en silencio: el monto ya cobrado quedo congelado en esa
    // nomina (no cambiaria retroactivamente), pero editar aqui podria
    // aparentar que la historia cambio. Se pide crear una vigencia nueva.
    if (existing) {
      const usedByPaidPayroll = dbTable("nomina").some((row) => row.tssConfigId === editId && normalize(row.estado || "") === "pagada");
      if (usedByPaidPayroll) {
        alert("Esta configuración ya fue usada por una nómina pagada y no puede editarse. Crea una nueva vigencia en su lugar.");
        return;
      }
    }
    const payload = {
      tasaColaborador: employeeRate,
      tasaEmpleador: employerRate,
      tope: cap,
      baseContributiva: base,
      fechaVigencia: effectiveDate,
      fechaFin: endDate,
      bonoSujeto: byId("tss-bonus-subject").checked,
      comisionSujeta: byId("tss-commission-subject").checked,
      estado: byId("tss-status").value,
      observaciones: byId("tss-note").value.trim(),
    };
    if (existing) Object.assign(existing, payload);
    else dbTable("configuracionTSS").push(stampRecord({ tssID: nextDbId("configuracionTSS", "tssID", "TSS"), ...payload }));
    logAudit("tss_configuration_changed", {
      entity: "configuracionTSS",
      entityId: existing ? editId : "",
      newData: payload,
      success: true,
    });
    event.target.reset();
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
    "income-search",
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
  ensureCashModuleMarkup();
  const provisionalClosingChanges = ensureProvisionalClosings();
  state = loadState();
  if (provisionalClosingChanges) state = stateFromDatabase(database);
  saveState();
  byId("today-label").textContent = dateLabel.format(new Date(`${today}T12:00:00`));
  byId("invoice-date").value = today;
  byId("reservation-date").value = today;
  byId("payment-cash-date").value = today;
  byId("cash-date").value = today;
  byId("cash-account").value = cashRegisterAccount()?.nombreCuenta || cashAccounts()[0]?.nombreCuenta || activeAccounts()[0]?.nombreCuenta || "";
  byId("card-reconciliation-date").value = today;
  byId("expense-date").value = today;
  byId("inventory-entry-date").value = today;
  byId("asset-acquired-date").value = today;
  byId("report-start").value = `${month}-01`;
  byId("report-end").value = today;
  byId("accounts-filter-start").value = today;
  byId("accounts-filter-end").value = today;
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
  byId("accounts-filter-apply")?.addEventListener("click", renderAccountsView);
  window.addEventListener("focus", () => refreshRemoteDatabase());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopRemoteRefreshLoop();
    } else {
      refreshRemoteDatabase();
      startRemoteRefreshLoop();
    }
  });
  startRemoteRefreshLoop();
  attachSearchableLookups();
  if (!document.querySelector(".invoice-line")) addInvoiceLine();
  if (!document.querySelector(".payment-line")) addPaymentLine();
  updateIncomePaymentFields();
  updateExpenseOptionalFields();
  updatePayrollPreview(true);
  renderAll();
}

init();
