const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_JS_PATH = path.join(__dirname, "..", "outputs", "app.js");
const source = fs.readFileSync(APP_JS_PATH, "utf8");
const DalfiClosingMath = require("../outputs/lib/closing-math.js");

// Extraccion robusta a cambios de linea: ubica el marcador por NOMBRE/texto,
// no por numero de linea (que se desactualiza cada vez que el archivo crece),
// y hace balance de llaves para encontrar el fin real del bloque/funcion.
function extractBraceBlock(fromIndex) {
  const openIdx = source.indexOf("{", fromIndex);
  let depth = 0;
  let end = openIdx;
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  return end;
}

function extractFunction(name) {
  const pattern = new RegExp(`^(async )?function ${name}\\(`, "m");
  const match = pattern.exec(source);
  if (!match) throw new Error(`No se encontro function ${name} en outputs/app.js`);
  // Balancea PARENTESIS primero (no llaves): si un parametro usa
  // desestructuracion "{ a, b } = {}" no debe confundirse con el cuerpo.
  let parenDepth = 0;
  let afterParams = source.indexOf("(", match.index);
  for (; afterParams < source.length; afterParams++) {
    if (source[afterParams] === "(") parenDepth++;
    else if (source[afterParams] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        afterParams++;
        break;
      }
    }
  }
  const end = extractBraceBlock(afterParams);
  return source.slice(match.index, end);
}

function extractStatementBlock(startMarker, throughMarker) {
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`No se encontro el marcador: ${startMarker}`);
  const throughIdx = source.indexOf(throughMarker, startIdx);
  if (throughIdx === -1) throw new Error(`No se encontro el marcador: ${throughMarker}`);
  const braceEnd = extractBraceBlock(throughIdx);
  const semi = source.indexOf(";", braceEnd);
  return source.slice(startIdx, semi + 1);
}

const dependenciesSource = [
  "dateOnly",
  "withDateOnly",
  "dbTable",
  "nextFormattedId",
  "nextDbId",
  "findStaffByName",
  "findAccountByName",
  "accountAvailableBalance",
  "findSupplierByName",
  "activeAccounts",
  "isBankAccount",
  "isCashAccount",
  "findBankAccountByName",
  "findCashAccountByName",
  "currentUserEmail",
  "stampRecord",
  "normalize",
]
  .map(extractFunction)
  .join("\n\n");

// Regla dura: el bug real que impedia guardar egresos era una referencia a
// una variable "concepto" que nunca existia (solo existia "concept"), usada
// como shorthand de objeto ("concepto,"). Eso lanzaba un ReferenceError
// silencioso en CADA submit (nuevo o edicion), sin alert ni mensaje visible.
// Esta prueba falla si alguien reintroduce ese patron exacto.
test("regresion: el submit de egresos ya no referencia la variable inexistente 'concepto' como shorthand", () => {
  const handlerSource = extractStatementBlock('let expenseSubmitInFlight = false;', 'byId("expense-form").addEventListener("submit"');
  const bareShorthandPattern = /(?<![:\w])concepto,/g;
  const matches = handlerSource.match(bareShorthandPattern) || [];
  assert.strictEqual(matches.length, 0, `Se encontro 'concepto,' como shorthand de objeto (referencia a variable inexistente): ${matches.length} veces`);
  assert.match(handlerSource, /concepto: concept,/, "debe asignar concepto explicitamente desde la variable real 'concept'");
});

function buildExpenseFormSandbox({ existingExpenses = [] } = {}) {
  const elements = new Map();
  const makeInput = (value = "") => ({ value, focus() {}, reset() {}, addEventListener() {} });
  const fieldIds = [
    "expense-edit-id",
    "expense-type",
    "expense-amount",
    "expense-source",
    "expense-destination",
    "expense-destination-type",
    "expense-concept",
    "expense-note",
    "expense-date",
    "expense-receivable-person",
  ];
  fieldIds.forEach((id) => elements.set(id, makeInput("")));
  elements.get("expense-type").value = "gasto";
  elements.get("expense-destination-type").value = "cash";
  elements.get("expense-date").value = "2026-07-20";
  elements.set("expense-submit", { textContent: "Guardar egreso", disabled: false, focus() {} });

  const database = {
    data: {
      cuentas: [
        { cuentaID: "CTA-001", nombreCuenta: "Caja Registradora", tipoCuenta: "Caja Operativa", balanceInicial: 0, estado: "Activo" },
        { cuentaID: "CTA-002", nombreCuenta: "Banco Popular", tipoCuenta: "Banco", balanceInicial: 5000, estado: "Activo" },
      ],
      ingresos: [],
      egresos: existingExpenses,
      transferencias: [],
      cuentasCobrar: [],
      colaboradores: [],
      suplidores: [],
    },
  };

  const calls = { refreshPendingClosingsForDate: [], logAudit: [], alerts: [], renderAll: 0, saveState: 0 };

  const sandbox = {
    database,
    state: { expenses: [] },
    today: "2026-07-20",
    money: new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP" }),
    DalfiClosingMath,
    supabaseSession: null,
    byId: (id) => elements.get(id),
    alert: (message) => calls.alerts.push(message),
    console,
    ensureDatabaseShape: () => {},
    findServiceByName: () => null,
    closingAllowsDateChange: () => true,
    refreshPendingClosingsForDate: (date) => calls.refreshPendingClosingsForDate.push(date),
    logAudit: (action, payload) => calls.logAudit.push({ action, ...payload }),
    stateFromDatabase: (db) => ({ __fromDb: true, raw: db }),
    saveState: () => {
      calls.saveState += 1;
    },
    renderAll: () => {
      calls.renderAll += 1;
    },
    updateExpenseOptionalFields: () => {},
    updateExpenseBalancePreview: () => {},
    // El submit real de #expense-form (en outputs/app.js) llama a
    // returnToClosingAfterExpense() SOLO cuando cashPendingExpenseReturn
    // esta activo (el usuario llego desde el boton "Agregar egreso" del
    // cierre). En la app real ambos siempre existen (declarados a nivel de
    // modulo); aqui se estuban igual que en la app: null = no aplica, no
    // se llama a nada.
    cashPendingExpenseReturn: null,
    returnToClosingAfterExpense: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(dependenciesSource, sandbox);

  let submitHandler = null;
  const formElement = {
    addEventListener(type, handler) {
      if (type === "submit") submitHandler = handler;
    },
    reset() {},
  };
  elements.set("expense-form", formElement);

  const handlerBlockSource = extractStatementBlock('let expenseSubmitInFlight = false;', 'byId("expense-form").addEventListener("submit"');
  vm.runInContext(handlerBlockSource, sandbox);

  return { sandbox, elements, database, calls, submit: (fakeEvent = { preventDefault() {}, target: formElement }) => submitHandler(fakeEvent) };
}

test("12/16. guardado valido de un egreso: crea la fila en egresos con los campos correctos y descuenta el balance de la cuenta origen", () => {
  const { elements, database, submit } = buildExpenseFormSandbox();
  elements.get("expense-amount").value = "500";
  elements.get("expense-source").value = "Banco Popular";
  elements.get("expense-concept").value = "Compra de esmaltes";
  elements.get("expense-note").value = "Proveedor X";
  submit();
  assert.strictEqual(database.data.egresos.length, 1);
  const created = database.data.egresos[0];
  assert.strictEqual(created.monto, 500);
  assert.strictEqual(created.cuentaOrigen, "Banco Popular");
  assert.strictEqual(created.concepto, "Compra de esmaltes");
  assert.strictEqual(created.estado, "Registrado");
  assert.ok(created.egresoID, "debe tener un ID estable");
  assert.ok(created.fechaCreacion, "stampRecord debe fijar fechaCreacion");
  const balanceDespues = 5000 - database.data.egresos.reduce((sum, row) => sum + row.monto, 0);
  assert.strictEqual(balanceDespues, 4500);
});

test("13. validaciones: monto en 0 muestra alert y NO crea el egreso (antes era un return mudo)", () => {
  const { elements, database, calls, submit } = buildExpenseFormSandbox();
  elements.get("expense-amount").value = "0";
  elements.get("expense-source").value = "Banco Popular";
  elements.get("expense-concept").value = "Algo";
  submit();
  assert.strictEqual(database.data.egresos.length, 0);
  assert.strictEqual(calls.alerts.length, 1);
  assert.match(calls.alerts[0], /monto/i);
});

test("13b. validaciones: monto negativo tambien se rechaza con alert", () => {
  const { elements, database, calls, submit } = buildExpenseFormSandbox();
  elements.get("expense-amount").value = "-100";
  elements.get("expense-source").value = "Banco Popular";
  elements.get("expense-concept").value = "Algo";
  submit();
  assert.strictEqual(database.data.egresos.length, 0);
  assert.strictEqual(calls.alerts.length, 1);
});

test("13c. validaciones: sin concepto no guarda y avisa", () => {
  const { elements, database, calls, submit } = buildExpenseFormSandbox();
  elements.get("expense-amount").value = "100";
  elements.get("expense-source").value = "Banco Popular";
  elements.get("expense-concept").value = "";
  submit();
  assert.strictEqual(database.data.egresos.length, 0);
  assert.match(calls.alerts[0], /concepto/i);
});

test("14. dos submits legitimos y distintos crean dos egresos, cada uno con ID propio (nunca se pisan ni se duplica el mismo)", () => {
  const { elements, database, submit } = buildExpenseFormSandbox();
  elements.get("expense-amount").value = "200";
  elements.get("expense-source").value = "Banco Popular";
  elements.get("expense-concept").value = "Compra";
  submit();
  elements.get("expense-amount").value = "200";
  elements.get("expense-concept").value = "Compra";
  submit();
  assert.strictEqual(database.data.egresos.length, 2);
  assert.notStrictEqual(database.data.egresos[0].egresoID, database.data.egresos[1].egresoID);
});

test("15/18. crea exactamente un movimiento por egreso y refresca los cierres pendientes de esa fecha", () => {
  const { elements, database, calls, submit } = buildExpenseFormSandbox();
  elements.get("expense-amount").value = "300";
  elements.get("expense-source").value = "Banco Popular";
  elements.get("expense-concept").value = "Pago servicio";
  elements.get("expense-date").value = "2026-07-18";
  submit();
  assert.strictEqual(database.data.egresos.length, 1, "un solo movimiento financiero por egreso");
  assert.deepStrictEqual(calls.refreshPendingClosingsForDate, ["2026-07-18"], "debe refrescar el cierre pendiente de la fecha del egreso");
});

test("20. registra auditoria de creacion exitosa con la cuenta, monto y usuario", () => {
  const { elements, calls, submit } = buildExpenseFormSandbox();
  elements.get("expense-amount").value = "150";
  elements.get("expense-source").value = "Banco Popular";
  elements.get("expense-concept").value = "Papeleria";
  submit();
  assert.strictEqual(calls.logAudit.length, 1);
  assert.strictEqual(calls.logAudit[0].action, "expense_create");
  assert.strictEqual(calls.logAudit[0].success, true);
  assert.strictEqual(calls.logAudit[0].newData.monto, 150);
  assert.strictEqual(calls.logAudit[0].newData.cuentaOrigen, "Banco Popular");
});

test("21. si el guardado falla de verdad, muestra un error real (no silencioso) y registra el intento fallido", () => {
  const { elements, calls, sandbox, submit } = buildExpenseFormSandbox();
  elements.get("expense-amount").value = "150";
  elements.get("expense-source").value = "Banco Popular";
  elements.get("expense-concept").value = "Algo";
  vm.runInContext('stampRecord = () => { throw new Error("fallo simulado de guardado"); };', sandbox);
  submit();
  assert.strictEqual(sandbox.database.data.egresos.length, 0, "no debe quedar un egreso a medio guardar");
  assert.strictEqual(calls.alerts.length, 1);
  assert.match(calls.alerts[0], /no se pudo guardar el egreso/i);
  assert.strictEqual(calls.logAudit.length, 1);
  assert.strictEqual(calls.logAudit[0].success, false);
});
