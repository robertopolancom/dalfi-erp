// Deuda anterior integrada en la creacion de factura nueva (julio 2026):
// completa lo que dejo pendiente el commit 9ac403c (cobro general FIFO por
// cliente). Ahora la creacion de una factura nueva tambien reparte el dinero
// confirmado con el MISMO algoritmo puro (DalfiClosingMath.allocateClientPaymentFIFO),
// nunca un segundo algoritmo financiero, y muestra por separado el total de
// la factura actual, la deuda anterior del cliente y el total general a
// pagar hoy (puramente informativo, nunca se suma al total legal de la
// factura). Mismo patron estatico (sin DOM real en este runner, ver
// tests/closing-cash-confirm-state.test.js) usado en todo el proyecto.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DalfiClosingMath = require("../outputs/lib/closing-math.js");
const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");

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

// Formula real extraida del codigo (no una copia a mano): la misma tecnica
// que ya usa tests/invoice-billing-audit.test.js para paid/totalCxC.
function extractEstadoFacturaFormula() {
  const startMarker = "invoiceRecord.estadoFactura =\n";
  const startIdx = submitHandler.indexOf(startMarker);
  assert.ok(startIdx !== -1, "no se encontro la asignacion de invoiceRecord.estadoFactura");
  const endIdx = submitHandler.indexOf(";", startIdx);
  const statement = submitHandler.slice(startIdx, endIdx);
  return statement.replace(/^invoiceRecord\.estadoFactura =\s*/, "");
}

function computeEstadoFactura(invoiceRecord) {
  const sandbox = { invoiceRecord };
  vm.createContext(sandbox);
  return vm.runInContext(extractEstadoFacturaFormula(), sandbox);
}

// ---------------------------------------------------------------------------
// A. Un solo algoritmo compartido: la creacion de factura usa
//    allocateClientPaymentFIFO(), nunca allocateConfirmedPayment directamente.
// ---------------------------------------------------------------------------

test("el submit de #invoice-form usa DalfiClosingMath.allocateClientPaymentFIFO(), no allocateConfirmedPayment directamente", () => {
  assert.match(submitHandler, /DalfiClosingMath\.allocateClientPaymentFIFO\(\{/);
  assert.doesNotMatch(submitHandler, /DalfiClosingMath\.allocateConfirmedPayment\(/);
});

test("allocateConfirmedPayment() sigue existiendo en closing-math.js (allocateClientPaymentFIFO es un envoltorio sobre ella, no una segunda copia de la logica)", () => {
  assert.equal(typeof DalfiClosingMath.allocateConfirmedPayment, "function");
  const wrapperSource = extractFunction("allocateClientPaymentFIFO", fs.readFileSync(path.join(__dirname, "..", "outputs", "lib", "closing-math.js"), "utf8"));
  assert.match(wrapperSource, /allocateConfirmedPayment\(\{/, "allocateClientPaymentFIFO debe delegar en allocateConfirmedPayment, no reimplementar el reparto");
});

test("el cobro general de cliente (previsualizacion de #payment-form) y la creacion de factura nueva llaman a la MISMA funcion allocateClientPaymentFIFO (nunca dos algoritmos distintos)", () => {
  // El submit de #payment-form ejecuta el reparto con applyReceivablePaymentLines
  // (mismas piezas ya probadas: applyClientReceivablesFirst/addConfirmedPayment/
  // syncInvoicePaymentFromReceivable), pero el calculo/previsualizacion de ESE
  // mismo reparto (renderPaymentAllocationPreview, ver tests/client-receipt-fifo.test.js)
  // y el submit de #invoice-form usan la misma DalfiClosingMath.allocateClientPaymentFIFO.
  const previewSource = extractFunction("renderPaymentAllocationPreview");
  assert.match(previewSource, /DalfiClosingMath\.allocateClientPaymentFIFO\(/);
  assert.match(submitHandler, /DalfiClosingMath\.allocateClientPaymentFIFO\(/);
});

test("la deuda anterior para la factura nueva se obtiene con clientAllReceivables (misma fuente que el cobro general), no una consulta distinta", () => {
  assert.match(submitHandler, /const priorReceivables = clientAllReceivables\(clientRecord\);/);
  assert.match(submitHandler, /priorClientReceivables: mapReceivablesForAllocation\(priorReceivables\),/);
});

test("saveEditedInvoice() (edicion) NUNCA llama a allocateClientPaymentFIFO ni reaplica deuda anterior", () => {
  const source = extractFunction("saveEditedInvoice");
  assert.doesNotMatch(source, /allocateClientPaymentFIFO/);
  assert.doesNotMatch(source, /applyClientReceivablesFirst/);
  assert.doesNotMatch(source, /clientAllReceivables/);
});

test("el submit de #invoice-form solo aplica deuda anterior en la rama de CREACION (antes del return temprano de edicion)", () => {
  const editReturnIdx = submitHandler.indexOf("if (editId) {");
  const allocateIdx = submitHandler.indexOf("DalfiClosingMath.allocateClientPaymentFIFO(");
  assert.ok(editReturnIdx !== -1 && allocateIdx > editReturnIdx, "el reparto FIFO debe ocurrir despues del branch de edicion, nunca antes ni dentro de el");
});

// ---------------------------------------------------------------------------
// B. Semantica financiera de la factura nueva: base/propina separadas de la
//    deuda anterior.
// ---------------------------------------------------------------------------

test("totalPagadoConfirmado = amountAppliedToCurrentBase (nunca incluye lo aplicado a deuda anterior)", () => {
  assert.match(submitHandler, /paid = Math\.min\(total, allocation\.amountAppliedToCurrentBase\);/);
  assert.match(submitHandler, /invoiceRecord\.totalPagadoConfirmado = paid;/);
});

test("propinaCobrada = amountAppliedToCurrentTip (collectInvoiceTip ya no recibe tipCollectedNow del algoritmo viejo)", () => {
  assert.match(submitHandler, /collectInvoiceTip\(invoiceRecord, allocation\.amountAppliedToCurrentTip, \{ cardPortion: cardTipPortion, source: invoiceId \}\);/);
});

test("totalCxC = saldo BASE pendiente de la factura nueva (total - paid), nunca incluye deuda anterior", () => {
  assert.match(submitHandler, /invoiceRecord\.totalCxC = Math\.max\(0, total - paid\);/);
});

test("amountAppliedToPriorReceivables jamas se usa para calcular totalPagadoConfirmado/totalCxC/propinaCobrada de la factura nueva", () => {
  const assignmentsBlock = submitHandler.slice(
    submitHandler.indexOf("paid = Math.min(total, allocation.amountAppliedToCurrentBase);"),
    submitHandler.indexOf("invoiceRecord.estadoFactura ="),
  );
  assert.doesNotMatch(assignmentsBlock.replace(/collectInvoiceTip[^;]*;/, ""), /amountAppliedToPriorReceivables/);
});

// ---------------------------------------------------------------------------
// C. estadoFactura: formula real (extraida del codigo) evaluada con los 7
//    casos explicitos pedidos, mas los 4 ejemplos obligatorios A-D.
// ---------------------------------------------------------------------------

test("1. Todo el pago fue a deuda anterior -> factura nueva Pendiente", () => {
  assert.equal(computeEstadoFactura({ totalPagadoConfirmado: 0, propinaCobrada: 0, totalCxC: 1000, propinaPendiente: 200 }), "Pendiente");
});

test("2. Pago alcanza parte de la base nueva -> Parcial", () => {
  assert.equal(computeEstadoFactura({ totalPagadoConfirmado: 300, propinaCobrada: 0, totalCxC: 700, propinaPendiente: 200 }), "Parcial");
});

test("3. Base completa y propina pendiente -> Parcial", () => {
  assert.equal(computeEstadoFactura({ totalPagadoConfirmado: 1000, propinaCobrada: 0, totalCxC: 0, propinaPendiente: 200 }), "Parcial");
});

test("4. Base completa y propina parcialmente cobrada -> Parcial", () => {
  assert.equal(computeEstadoFactura({ totalPagadoConfirmado: 1000, propinaCobrada: 100, totalCxC: 0, propinaPendiente: 100 }), "Parcial");
});

test("5. Base y propina completas -> Pagada", () => {
  assert.equal(computeEstadoFactura({ totalPagadoConfirmado: 1000, propinaCobrada: 200, totalCxC: 0, propinaPendiente: 0 }), "Pagada");
});

test("6. Sin deuda anterior y sin pago -> Pendiente", () => {
  assert.equal(computeEstadoFactura({ totalPagadoConfirmado: 0, propinaCobrada: 0, totalCxC: 500, propinaPendiente: 0 }), "Pendiente");
});

test("7. Sin deuda anterior con pago parcial -> Parcial", () => {
  assert.equal(computeEstadoFactura({ totalPagadoConfirmado: 300, propinaCobrada: 0, totalCxC: 200, propinaPendiente: 0 }), "Parcial");
});

test("Ejemplo A completo: deuda anterior 500, factura base 1000 + propina 200, pago 1200", () => {
  const allocation = DalfiClosingMath.allocateClientPaymentFIFO({
    confirmedPaymentLines: [{ method: "efectivo", amount: 1200 }],
    priorClientReceivables: [{ id: "CXC-OLD", invoiceId: "FAC-OLD", kind: "base", amount: 500, fechaOrigen: "2026-06-01" }],
    currentInvoiceBase: 1000,
    currentInvoiceTip: 200,
    currentInvoiceTipCollected: 0,
  });
  assert.equal(allocation.amountAppliedToPriorReceivables, 500);
  assert.equal(allocation.amountAppliedToCurrentBase, 700);
  assert.equal(allocation.currentBaseRemaining, 300);
  assert.equal(allocation.amountAppliedToCurrentTip, 0);
  assert.equal(allocation.currentTipRemaining, 200);
  const paid = Math.min(1000, allocation.amountAppliedToCurrentBase);
  const totalCxC = Math.max(0, 1000 - paid);
  const invoiceRecord = { totalPagadoConfirmado: paid, propinaCobrada: allocation.amountAppliedToCurrentTip, totalCxC, propinaPendiente: allocation.currentTipRemaining };
  assert.equal(invoiceRecord.totalCxC, 300);
  assert.equal(invoiceRecord.propinaPendiente, 200);
  assert.equal(computeEstadoFactura(invoiceRecord), "Parcial");
});

test("Ejemplo B completo: deuda anterior 500, factura base 1000 + propina 200, pago 1600", () => {
  const allocation = DalfiClosingMath.allocateClientPaymentFIFO({
    confirmedPaymentLines: [{ method: "efectivo", amount: 1600 }],
    priorClientReceivables: [{ id: "CXC-OLD", invoiceId: "FAC-OLD", kind: "base", amount: 500, fechaOrigen: "2026-06-01" }],
    currentInvoiceBase: 1000,
    currentInvoiceTip: 200,
    currentInvoiceTipCollected: 0,
  });
  assert.equal(allocation.amountAppliedToPriorReceivables, 500);
  assert.equal(allocation.amountAppliedToCurrentBase, 1000);
  assert.equal(allocation.currentBaseRemaining, 0);
  assert.equal(allocation.amountAppliedToCurrentTip, 100);
  assert.equal(allocation.currentTipRemaining, 100);
  const paid = Math.min(1000, allocation.amountAppliedToCurrentBase);
  const invoiceRecord = { totalPagadoConfirmado: paid, propinaCobrada: allocation.amountAppliedToCurrentTip, totalCxC: Math.max(0, 1000 - paid), propinaPendiente: allocation.currentTipRemaining };
  assert.equal(invoiceRecord.totalCxC, 0);
  assert.equal(invoiceRecord.propinaPendiente, 100);
  assert.equal(invoiceRecord.propinaCobrada, 100);
  assert.equal(computeEstadoFactura(invoiceRecord), "Parcial");
});

test("Ejemplo C completo: deuda anterior 800, factura total 1200 (base 1000 + propina 200), pago 500 -> factura nueva no recibe nada", () => {
  const allocation = DalfiClosingMath.allocateClientPaymentFIFO({
    confirmedPaymentLines: [{ method: "efectivo", amount: 500 }],
    priorClientReceivables: [{ id: "CXC-OLD", invoiceId: "FAC-OLD", kind: "base", amount: 800, fechaOrigen: "2026-06-01" }],
    currentInvoiceBase: 1000,
    currentInvoiceTip: 200,
    currentInvoiceTipCollected: 0,
  });
  assert.equal(allocation.amountAppliedToPriorReceivables, 500);
  assert.equal(allocation.amountAppliedToCurrentBase, 0);
  assert.equal(allocation.amountAppliedToCurrentTip, 0);
  const paid = Math.min(1000, allocation.amountAppliedToCurrentBase);
  const invoiceRecord = { totalPagadoConfirmado: paid, propinaCobrada: allocation.amountAppliedToCurrentTip, totalCxC: Math.max(0, 1000 - paid), propinaPendiente: allocation.currentTipRemaining };
  assert.equal(invoiceRecord.totalCxC, 1000);
  assert.equal(invoiceRecord.propinaPendiente, 200);
  assert.equal(computeEstadoFactura(invoiceRecord), "Pendiente");
});

test("Ejemplo D completo: sin deuda anterior, comportamiento equivalente al flujo aprobado (base antes que propina)", () => {
  const allocation = DalfiClosingMath.allocateClientPaymentFIFO({
    confirmedPaymentLines: [{ method: "efectivo", amount: 700 }],
    priorClientReceivables: [],
    currentInvoiceBase: 500,
    currentInvoiceTip: 300,
    currentInvoiceTipCollected: 0,
  });
  assert.equal(allocation.amountAppliedToPriorReceivables, 0);
  assert.equal(allocation.amountAppliedToCurrentBase, 500);
  assert.equal(allocation.amountAppliedToCurrentTip, 200);
  assert.equal(allocation.currentTipRemaining, 100);
});

// ---------------------------------------------------------------------------
// D. Resumen visual: Total factura actual / Deuda anterior / Total general.
// ---------------------------------------------------------------------------

test("el bloque #invoice-prior-debt-summary existe, empieza oculto y tiene aria-live", () => {
  assert.match(indexHtml, /<section class="invoice-summary compact-summary hidden" id="invoice-prior-debt-summary" aria-live="polite">/);
});

test("muestra Total de esta factura, Deuda anterior y Total general como <output> (no <input>, no editable)", () => {
  assert.match(indexHtml, /<output id="invoice-current-total-preview">RD\$0\.00<\/output>/);
  assert.match(indexHtml, /<output id="invoice-prior-debt-total">RD\$0\.00<\/output>/);
  assert.match(indexHtml, /<output id="invoice-grand-total-with-prior-debt">RD\$0\.00<\/output>/);
});

test("aclara explicitamente que la deuda anterior es informativa y no se suma al total legal de esta factura", () => {
  assert.match(indexHtml, /La deuda anterior es solo informativa: no se agrega al total legal de esta factura/);
});

test("renderInvoicePriorDebtSummary(): total general = deuda anterior + total de la factura actual (formula exacta de la seccion 4)", () => {
  const source = extractFunction("renderInvoicePriorDebtSummary");
  assert.match(source, /money\.format\(priorDebtTotal \+ currentInvoiceTotal\)/);
});

test("renderInvoicePriorDebtSummary(): sin cliente seleccionado, el bloque se oculta (nunca muestra deuda de un cliente anterior)", () => {
  const source = extractFunction("renderInvoicePriorDebtSummary");
  assert.match(source, /if \(!clientRecord\) \{\s*container\.classList\.add\("hidden"\);\s*rowsTarget\.innerHTML = "";\s*return;\s*\}/);
});

test("renderInvoicePriorDebtSummary(): con cliente seleccionado siempre se muestra (incluso con deuda 0, que queda en RD$0.00)", () => {
  const source = extractFunction("renderInvoicePriorDebtSummary");
  assert.match(source, /container\.classList\.remove\("hidden"\);/);
});

test("renderInvoicePriorDebtSummary() usa clientAllReceivables (misma fuente que el cobro general), no otra consulta de CxC", () => {
  const source = extractFunction("renderInvoicePriorDebtSummary");
  assert.match(source, /const receivables = clientAllReceivables\(clientRecord\);/);
});

test("updateInvoiceTotals() recalcula el resumen de deuda anterior en CADA cambio (mismo hook que servicios/pagos/propina)", () => {
  const source = extractFunction("updateInvoiceTotals");
  assert.match(source, /renderInvoicePriorDebtSummary\(clientRecord, totalWithTip\);/);
});

test("escribir en #invoice-client-search dispara updateInvoiceTotals() (recalcula deuda anterior al cambiar de cliente)", () => {
  const source = extractStatementBlock('byId("invoice-client-search").addEventListener("input"', "() => {", appJs);
  assert.match(source, /updateInvoiceTotals\(\);/);
});

test("crear cliente desde Facturacion y volver tambien recalcula el resumen (no se queda con la deuda del cliente anterior)", () => {
  assert.match(appJs, /byId\("invoice-client-search"\)\.value = client\.nombreCompleto \|\| fullName;\s*updateInvoiceTotals\(\);/);
});

test("clearInvoiceFormAfterSubmit() limpia el formulario y llama updateInvoiceTotals(), que oculta el resumen al no haber cliente", () => {
  const source = extractFunction("clearInvoiceFormAfterSubmit");
  assert.match(source, /byId\("invoice-form"\)\.reset\(\);/);
  assert.match(source, /updateInvoiceTotals\(\);/);
});

test("el detalle compacto de deuda anterior (#invoice-prior-debt-rows) muestra referencia de factura, fecha y saldo pendiente, sin datos sensibles", () => {
  const source = extractFunction("renderInvoicePriorDebtSummary");
  assert.match(source, /cxc\.facturaID \|\| cxc\.cxCID/);
  assert.match(source, /dateOnly\(cxc\.fechaOrigen\)/);
  assert.doesNotMatch(source, /telefono|correo|cedula/);
});

test("el detalle distingue base de propina pendiente (misma etiqueta que la previsualizacion del cobro general)", () => {
  const source = extractFunction("renderInvoicePriorDebtSummary");
  assert.match(source, /cxc\.esPropinaPendiente \? `Propina/);
});

// ---------------------------------------------------------------------------
// E. Aplicacion a CxC anteriores / nuevas CxC de la factura nueva / tarjeta /
//    transferencia pendiente: reutiliza exactamente el mismo bloque de
//    ejecucion probado en 9ac403c y en tip-last-payroll-payable.test.js.
// ---------------------------------------------------------------------------

test("cada linea de pago confirmado aplica su porcion 'olderReceivables' con applyClientReceivablesFirst (una sola vez por linea, no una vez por CxC anterior)", () => {
  assert.match(submitHandler, /if \(olderPortion > 0\) applyClientReceivablesFirst\(clientRecord, client, olderPortion, paymentLine\.method, "Pago aplicado primero a CxC previa", paymentLine\.processor, paymentLine\.account, invoiceDate\);/);
});

test("tarjeta: la CxC del procesador sigue usando el monto COMPLETO de la linea, sin importar cuanto se redirigio a deuda anterior", () => {
  assert.match(submitHandler, /addReceivable\(invoiceId, \{ clienteID: processor\.procesadorID \|\| "" \}, processor\.nombre \|\| "Procesador tarjeta", paymentLine\.amount, "CxC procesador tarjeta", "", invoiceDate\);/);
});

test("credito/transferencia_pendiente nunca entran al reparto FIFO (solo confirmedPayments, filtrado por isConfirmedPaymentMethod)", () => {
  assert.match(submitHandler, /const confirmedPayments = payments\.filter\(\(paymentLine\) => isConfirmedPaymentMethod\(paymentLine\.method\)\);/);
  assert.doesNotMatch(appJs, /isConfirmedPaymentMethod.*"transferencia_pendiente"/);
});

test("propina pendiente de la factura nueva se registra como CxC propia (esPropinaPendiente:true), igual que antes de este cambio", () => {
  assert.match(submitHandler, /addReceivable\(invoiceId, clientRecord, client, invoiceRecord\.propinaPendiente, `Propina pendiente factura \$\{invoiceId\}`, "", invoiceDate, \{ esPropinaPendiente: true \}\);/);
});

// ---------------------------------------------------------------------------
// F. Auditoria: una sola entrada por factura creada, con deuda anterior y
//    facturas afectadas, sin volcar erp_records completo.
// ---------------------------------------------------------------------------

test("se audita la factura creada con logAudit('invoice_created', ...) exactamente una vez", () => {
  const matches = submitHandler.match(/logAudit\("invoice_created"/g) || [];
  assert.equal(matches.length, 1);
});

test("la auditoria de creacion incluye deuda anterior agregada, facturas anteriores afectadas y el desglose base/propina de la factura nueva", () => {
  const auditBlock = submitHandler.slice(submitHandler.indexOf('logAudit("invoice_created"'), submitHandler.indexOf("refreshPendingClosingsForDate"));
  assert.match(auditBlock, /deudaAnteriorAgregada: priorDebtBeforePayment/);
  assert.match(auditBlock, /facturasAnterioresAfectadas: priorInvoicesAffected/);
  assert.match(auditBlock, /aplicadoABaseNueva: allocation\.amountAppliedToCurrentBase/);
  assert.match(auditBlock, /aplicadoAPropinaNueva: allocation\.amountAppliedToCurrentTip/);
});

test("la auditoria de creacion NO vuelca erp_records ni el objeto database completo", () => {
  const auditBlock = submitHandler.slice(submitHandler.indexOf('logAudit("invoice_created"'), submitHandler.indexOf("refreshPendingClosingsForDate"));
  assert.doesNotMatch(auditBlock, /database\.data|erp_records/);
});

test("priorDebtBeforePayment y priorBalancesBeforePayment se capturan ANTES de aplicar el pago (para auditar el estado real previo, no uno ya mutado)", () => {
  const captureIdx = submitHandler.indexOf("const priorDebtBeforePayment =");
  const applyIdx = submitHandler.indexOf("confirmedPayments.forEach((paymentLine, index) => {");
  assert.ok(captureIdx !== -1 && applyIdx > captureIdx);
});

// ---------------------------------------------------------------------------
// G. Compatibilidad historica / permisos (regresion, ya cubiertos en detalle
//    por tests/client-receipt-fifo.test.js, verificados aqui contra el flujo
//    de factura nueva especificamente).
// ---------------------------------------------------------------------------

test("mapReceivablesForAllocation (reutilizada aqui) usa defaults seguros: filas historicas sin esPropinaPendiente se tratan como 'base'", () => {
  const source = extractFunction("mapReceivablesForAllocation");
  assert.match(source, /cxc\.esPropinaPendiente \? "tip" : "base"/);
});

test("el submit de #invoice-form sigue exigiendo permisos de administracion para elegir la fecha (canManageInvoices), sin tocar user_metadata", () => {
  assert.match(submitHandler, /canManageInvoices\(\)/);
  assert.doesNotMatch(submitHandler, /user_metadata/);
});
