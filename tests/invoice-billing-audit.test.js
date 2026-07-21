// Aserciones estaticas (mismo patron que tests/closing-cash-confirm-state.test.js:
// sin DOM real en este runner) sobre los defectos reales encontrados en la
// auditoria integral de Facturacion, Cobros y Cuentas por Cobrar.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");

function extractFunction(name, source = appJs) {
  const pattern = new RegExp(`^\\s*(async )?function ${name}\\(`, "m");
  const match = pattern.exec(source);
  assert.ok(match, `no se encontro function ${name}`);
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
  let depth = 0;
  let end = source.indexOf("{", afterParams);
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
  return source.slice(match.index, end);
}

function extractStatementBlock(startMarker, throughMarker, source = appJs) {
  const startIdx = source.indexOf(startMarker);
  assert.ok(startIdx !== -1, `no se encontro el marcador: ${startMarker}`);
  const throughIdx = source.indexOf(throughMarker, startIdx);
  assert.ok(throughIdx !== -1, `no se encontro el marcador: ${throughMarker}`);
  const openIdx = source.indexOf("{", throughIdx);
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
  const semi = source.indexOf(";", end);
  return source.slice(startIdx, semi + 1);
}

const submitHandler = extractStatementBlock('let invoiceSubmitInFlight = false;', 'byId("invoice-form").addEventListener("submit"');

// ==================================================
// Defecto 1: invoiceRecord.totalCxC/estadoFactura se sobreescribian con un
// valor incorrecto (nonConfirmedCxC) inmediatamente despues de calcularse
// correctamente (total - paid). Se manifestaba cuando applyClientReceivablesFirst()
// redirige parte de un pago confirmado (efectivo/tarjeta/transferencia) hacia
// una CxC MAS ANTIGUA del mismo cliente: la factura NUEVA quedaba marcada
// "Pagada" con totalCxC=0 aunque no se le hubiera aplicado la totalidad del
// pago confirmado a ELLA.
// ==================================================

test("regresion: ya no existe la segunda asignacion que sobreescribia totalCxC/estadoFactura con nonConfirmedCxC", () => {
  assert.ok(!/nonConfirmedCxC/.test(appJs), "la variable nonConfirmedCxC (y su asignacion incorrecta) no debe reaparecer");
});

test("invoiceRecord.totalCxC/estadoFactura se calculan UNA SOLA VEZ, a partir de total - paid (allocation.amountAppliedToCurrentBase), y estadoFactura tambien considera propina pendiente", () => {
  const assignments = submitHandler.match(/invoiceRecord\.totalCxC\s*=/g) || [];
  assert.strictEqual(assignments.length, 1, "totalCxC debe asignarse exactamente una vez en el submit (fuera del bloque inicial en 0 del literal)");
  assert.match(submitHandler, /invoiceRecord\.totalCxC = Math\.max\(0, total - paid\);/);
  assert.match(
    submitHandler,
    /invoiceRecord\.estadoFactura =\s*invoiceRecord\.totalPagadoConfirmado <= 0 && invoiceRecord\.propinaCobrada <= 0\s*\? "Pendiente"\s*: invoiceRecord\.totalCxC > 0 \|\| invoiceRecord\.propinaPendiente > 0\s*\? "Parcial"\s*: "Pagada";/,
  );
});

test("totalPagadoConfirmado + totalCxC siempre suma exactamente 'total' (consistencia aritmetica de la factura recien creada, ahora con propina separada)", () => {
  // Formula real extraida del codigo, no una copia a mano.
  const paidMatch = /paid = Math\.min\(total, allocation\.amountAppliedToCurrentBase\);/.exec(submitHandler);
  const cxcMatch = /invoiceRecord\.totalCxC = Math\.max\(0, total - paid\);/.exec(submitHandler);
  assert.ok(paidMatch && cxcMatch, "no se encontraron las formulas de paid/totalCxC");

  function computeConsistency({ total, amountAppliedToCurrentBase }) {
    const sandbox = { total, allocation: { amountAppliedToCurrentBase }, Math };
    vm.createContext(sandbox);
    vm.runInContext("paid = Math.min(total, allocation.amountAppliedToCurrentBase);", sandbox);
    vm.runInContext("totalCxC = Math.max(0, total - paid);", sandbox);
    return sandbox.paid + sandbox.totalCxC;
  }

  // Caso del bug real (turno anterior): pago confirmado parcialmente redirigido a una CxC mas antigua (100 total, solo 70 aplicado a la BASE de esta factura).
  assert.strictEqual(computeConsistency({ total: 100, amountAppliedToCurrentBase: 70 }), 100);
  // Factura totalmente a credito (nada confirmado a la base).
  assert.strictEqual(computeConsistency({ total: 100, amountAppliedToCurrentBase: 0 }), 100);
  // Base completamente cubierta y de sobra (el exceso ya no cuenta aqui: allocateConfirmedPayment lo tope a "total" antes de pasar a propina).
  assert.strictEqual(computeConsistency({ total: 100, amountAppliedToCurrentBase: 100 }), 100);
});

test("regresion: syncInvoicePaymentFromReceivable() y voidReceivableReceipt() siguen tratando totalCxC como saldo vivo (decrementa/incrementa desde total - paid), consistente con como se inicializa ahora", () => {
  const syncFn = extractFunction("syncInvoicePaymentFromReceivable");
  assert.match(syncFn, /dbInvoice\.totalCxC = Number\.isFinite\(previousCxC\) \? Math\.max\(0, previousCxC - applied\) : Math\.max\(0, Number\(cxc\.balancePendiente\) \|\| 0\);/);
  const voidFn = extractFunction("voidReceivableReceipt");
  assert.match(voidFn, /dbInvoice\.totalCxC = Math\.max\(0, \(Number\(dbInvoice\.totalCxC\) \|\| 0\) \+ amount\);/);
});

// ==================================================
// Defecto 2: #invoice-form no tenia proteccion contra doble clic/doble
// submit (a diferencia de #cash-form/#expense-form en Cierres).
// ==================================================

test("invoice-form: declara invoiceSubmitInFlight y retorna de inmediato si ya esta activo", () => {
  assert.match(appJs, /let invoiceSubmitInFlight = false;\s*\n\s*byId\("invoice-form"\)\.addEventListener\("submit"/);
  const preventDefaultIdx = submitHandler.indexOf("event.preventDefault();");
  const guardIdx = submitHandler.indexOf("if (invoiceSubmitInFlight) return;");
  assert.ok(preventDefaultIdx >= 0 && guardIdx > preventDefaultIdx);
});

test("invoice-form: cubre TANTO crear factura nueva COMO editar (saveEditedInvoice) dentro del mismo try/finally", () => {
  const tryIdx = submitHandler.indexOf("try {");
  const editCallIdx = submitHandler.indexOf("saveEditedInvoice(editId,");
  const finallyIdx = submitHandler.indexOf("} finally {");
  assert.ok(tryIdx >= 0 && editCallIdx > tryIdx && finallyIdx > editCallIdx, "el camino de edicion debe quedar dentro del try/finally, no antes");
});

test("invoice-form: un finally garantiza que invoiceSubmitInFlight se reinicia y el boton se reactiva pase lo que pase", () => {
  assert.match(submitHandler, /}\s*finally\s*{\s*\n\s*invoiceSubmitInFlight = false;\s*\n\s*byId\("invoice-submit-button"\)\.disabled = false;\s*\n\s*}/);
});

test("invoice-form: las mutaciones reales (facturaDetalle, facturas, pagos) quedan dentro del try", () => {
  const tryIdx = submitHandler.indexOf("try {");
  const pushFacturaIdx = submitHandler.indexOf('dbTable("facturas").push(invoiceRecord);');
  assert.ok(tryIdx >= 0 && pushFacturaIdx > tryIdx);
});

// ==================================================
// Defecto 3: dataset.returnToInvoice quedaba pegado en #client-form (y
// cualquier otro data-entry-form) si el usuario abria "Crear cliente" desde
// una factura y navegaba a otro modulo SIN guardar ni cancelar: el
// SIGUIENTE guardado de ese formulario (aunque fuera un flujo normal, no
// desde una factura) heredaba el rastro y devolvia a la persona a
// Facturacion con el nombre de un cliente que no tenia nada que ver.
// ==================================================

test("openDataForm(): borra dataset.returnToInvoice al abrir CUALQUIER formulario (punto unico de entrada)", () => {
  const fnSource = extractFunction("openDataForm");
  assert.match(fnSource, /delete form\.dataset\.returnToInvoice;/);
});

test("openSettingsFormFromInvoice(): marca returnToInvoice DESPUES de llamar a openDataForm (no antes, o el borrado centralizado lo eliminaria de inmediato)", () => {
  const fnSource = extractFunction("openSettingsFormFromInvoice");
  const openDataFormIdx = fnSource.indexOf("openDataForm(formId)");
  const setFlagIdx = fnSource.indexOf("dataset.returnToInvoice = \"true\";");
  assert.ok(openDataFormIdx >= 0 && setFlagIdx > openDataFormIdx, "el flag debe marcarse DESPUES de abrir el formulario");
});

test("regresion: fillDataForm() (editar un registro existente) tambien pasa por openDataForm(), asi que tambien queda protegido contra el rastro heredado", () => {
  const fnSource = extractFunction("fillDataForm");
  assert.match(fnSource, /openDataForm\("client-form"\)/);
});

// ==================================================
// Defecto 4: voidReceivableReceipt() (la accion de reversion mas cercana a
// "anular" que existe hoy para cobros/CxC) no dejaba ninguna entrada
// explicita en auditoria, a diferencia de acciones de reversion equivalentes
// en otros modulos (p. ej. closing_reopen en Cierres).
// ==================================================

test("voidReceivableReceipt(): ahora registra una entrada explicita de auditoria (logAudit) con el monto total reversado y las facturas afectadas", () => {
  const fnSource = extractFunction("voidReceivableReceipt");
  assert.match(fnSource, /logAudit\("void_receivable_receipt", \{/);
  assert.match(fnSource, /entity: "ingresos",/);
  assert.match(fnSource, /entityId: incomeId,/);
  assert.match(fnSource, /newData: \{ totalReversado: totalReversed, facturasAfectadas: affectedInvoiceIds \},/);
});

test("voidReceivableReceipt(): sigue exigiendo permiso y exigiendo confirmacion explicita antes de reversar (sin cambios de comportamiento previo)", () => {
  const fnSource = extractFunction("voidReceivableReceipt");
  assert.match(fnSource, /if \(!canManageInvoices\(\)\) \{/);
  assert.match(fnSource, /if \(!confirm\(`Anular el recibo \$\{incomeId\}/);
});

// ==================================================
// Verificaciones adicionales (sin defecto encontrado, documentadas como
// regresion para que sigan siendo ciertas):
// ==================================================

test("ensureService(): nunca sobreescribe el precio de un servicio YA existente en el catalogo (precio historico de facturas pasadas no puede corromperse)", () => {
  const fnSource = extractFunction("ensureService");
  assert.match(fnSource, /if \(!existing\) \{/);
  assert.match(fnSource, /if \(!dbExisting\) \{/);
  assert.ok(!/existing\.price\s*=/.test(fnSource) && !/dbExisting\.precioBase\s*=/.test(fnSource), "no debe existir ninguna ruta que reescriba el precio de un servicio ya existente");
});

test("saveClientCatalog: buscar por nombre ANTES de crear evita duplicar un cliente por doble clic (segundo submit encuentra el mismo cliente y lo trata como edicion)", () => {
  const clientFormBlock = extractStatementBlock("const saveClientCatalog = (event) => {", "const saveClientCatalog = (event) => {");
  assert.match(clientFormBlock, /let client = dbTable\("clientes"\)\.find\(\(row\) => row\.clienteID === editId\) \|\| findClientByName\(fullName\);/);
});

test("invoiceTotalsFromLines/computeInvoiceBreakdown: el total nunca puede quedar negativo (Math.max(0, ...) en cada paso)", () => {
  const closingMath = fs.readFileSync(path.join(__dirname, "..", "outputs", "lib", "closing-math.js"), "utf8");
  const fnSource = extractFunction("computeInvoiceBreakdown", closingMath);
  assert.match(fnSource, /const totalServiciosAjustado = Math\.max\(0, subtotalAntesDeDescuentos - descuentos\);/);
  assert.match(fnSource, /const propinaNum = Math\.max\(0, Number\(propina\) \|\| 0\);/);
  assert.match(fnSource, /const montoPendiente = Math\.max\(0, totalGeneral - pagado\);/);
});

test("computeInvoiceBreakdown(): nunca produce NaN, incluso con entradas invalidas (strings vacios, undefined)", () => {
  const DalfiClosingMath = require("../outputs/lib/closing-math.js");
  const breakdown = DalfiClosingMath.computeInvoiceBreakdown({
    precioListadoServicios: undefined,
    totalAdicionales: "",
    totalDescuentos: NaN,
    propina: undefined,
    totalPagado: "",
  });
  Object.values(breakdown).forEach((value) => {
    if (typeof value === "number") assert.ok(Number.isFinite(value), `el campo no debe ser NaN/Infinito: ${value}`);
  });
  assert.strictEqual(breakdown.totalGeneral, 0);
  assert.strictEqual(breakdown.estaPagada, true);
});

test("permisos: la creacion/edicion de factura sigue exigiendo canManageInvoices() (nunca user_metadata) para la fecha administrativa", () => {
  assert.match(submitHandler, /const invoiceDate = canManageInvoices\(\) \? \(byId\("invoice-date"\)\?\.value \|\| today\) : today;/);
});

test("permisos: currentUserRole() documenta explicitamente que user_metadata.role es solo un respaldo VISUAL, nunca para autorizar", () => {
  const fnSource = extractFunction("currentUserRole");
  assert.match(fnSource, /supabaseSession\?\.user\?\.user_metadata\?\.role/);
  const commentBlock = appJs.slice(appJs.indexOf("// Rol para MOSTRAR en pantalla"), appJs.indexOf("function currentUserRole"));
  assert.match(commentBlock, /Nunca usar el valor de aqui para autorizar una accion/);
});
