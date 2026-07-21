// Cobro general FIFO por cliente desde Facturacion (julio 2026): corrige el
// diseno publicado en el commit anterior (f548985), que ataba el recibo a
// UNA factura especifica. El flujo definitivo es: boton general en
// Facturacion -> #payment-form EXISTENTE -> se busca un CLIENTE -> el dinero
// se aplica automaticamente a TODAS sus cuentas por cobrar, de la mas
// antigua a la mas nueva (base de cada factura antes que su propina
// pendiente). Cubre la funcion pura DalfiClosingMath.allocateClientPaymentFIFO()
// a fondo (sin DOM, sin mocks) y, con el mismo patron estatico usado en
// tests/tip-last-payroll-payable.test.js, verifica que outputs/app.js y
// outputs/index.html esten correctamente conectados a ese diseno.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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

function functionExists(name, source = appJs) {
  return new RegExp(`^\\s*(async )?function ${name}\\(`, "m").test(source);
}

function stripComments(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

// ---------------------------------------------------------------------------
// A. DalfiClosingMath.allocateClientPaymentFIFO / compareReceivablesFIFO
// ---------------------------------------------------------------------------

test("allocateClientPaymentFIFO existe y compareReceivablesFIFO existe en el modulo exportado", () => {
  assert.equal(typeof DalfiClosingMath.allocateClientPaymentFIFO, "function");
  assert.equal(typeof DalfiClosingMath.compareReceivablesFIFO, "function");
});

test("Ejemplo obligatorio (seccion 6): Factura A (base 300, propina 100) + Factura B (base 500), pago 600 -> 300 a A-base, 100 a A-propina, 200 a B-base", () => {
  const result = DalfiClosingMath.allocateClientPaymentFIFO({
    confirmedPaymentLines: [{ method: "efectivo", amount: 600 }],
    priorClientReceivables: [
      { id: "CXC-A-BASE", invoiceId: "FAC-A", kind: "base", amount: 300, fechaOrigen: "2026-07-01T10:00:00" },
      { id: "CXC-A-TIP", invoiceId: "FAC-A", kind: "tip", amount: 100, fechaOrigen: "2026-07-01T10:00:00" },
      { id: "CXC-B-BASE", invoiceId: "FAC-B", kind: "base", amount: 500, fechaOrigen: "2026-07-02T10:00:00" },
    ],
  });
  const byId = Object.fromEntries(result.resultingBalances.map((row) => [row.id, row]));
  assert.equal(byId["CXC-A-BASE"].amountApplied, 300);
  assert.equal(byId["CXC-A-TIP"].amountApplied, 100);
  assert.equal(byId["CXC-B-BASE"].amountApplied, 200);
  assert.equal(byId["CXC-B-BASE"].remainingBalance, 300);
  assert.equal(result.totalApplied, 600);
  assert.equal(result.unappliedAmount, 0);
  assert.deepEqual(result.affectedInvoiceIds.sort(), ["FAC-A", "FAC-B"]);
});

test("Ejemplo obligatorio (seccion 8): un solo recibo para 3 facturas -> A(500) saldada, B(800) recibe 500/300 restante, C(400) sin tocar", () => {
  const result = DalfiClosingMath.allocateClientPaymentFIFO({
    confirmedPaymentLines: [{ method: "efectivo", amount: 1000 }],
    priorClientReceivables: [
      { id: "CXC-A", invoiceId: "FAC-A", kind: "base", amount: 500, fechaOrigen: "2026-07-01" },
      { id: "CXC-B", invoiceId: "FAC-B", kind: "base", amount: 800, fechaOrigen: "2026-07-02" },
      { id: "CXC-C", invoiceId: "FAC-C", kind: "base", amount: 400, fechaOrigen: "2026-07-03" },
    ],
  });
  const byId = Object.fromEntries(result.resultingBalances.map((row) => [row.id, row]));
  assert.equal(byId["CXC-A"].amountApplied, 500);
  assert.equal(byId["CXC-A"].remainingBalance, 0);
  assert.equal(byId["CXC-B"].amountApplied, 500);
  assert.equal(byId["CXC-B"].remainingBalance, 300);
  assert.equal(byId["CXC-C"].amountApplied, 0);
  assert.equal(byId["CXC-C"].remainingBalance, 400);
  assert.equal(result.totalApplied, 1000);
  assert.deepEqual(result.affectedInvoiceIds, ["FAC-A", "FAC-B"]);
});

test("Ejemplo obligatorio (seccion 11): factura nueva con deuda anterior -> 500 a deuda previa, 700 a base actual (300 restante), propina actual sin tocar (200 restante)", () => {
  const result = DalfiClosingMath.allocateClientPaymentFIFO({
    confirmedPaymentLines: [{ method: "efectivo", amount: 1200 }],
    priorClientReceivables: [{ id: "CXC-OLD", invoiceId: "FAC-OLD", kind: "base", amount: 500, fechaOrigen: "2026-06-01" }],
    currentInvoiceBase: 1000,
    currentInvoiceTip: 200,
    currentInvoiceTipCollected: 0,
  });
  assert.equal(result.amountAppliedToPriorReceivables, 500);
  assert.equal(result.amountAppliedToCurrentBase, 700);
  assert.equal(result.currentBaseRemaining, 300);
  assert.equal(result.amountAppliedToCurrentTip, 0);
  assert.equal(result.currentTipRemaining, 200);
  assert.equal(result.totalApplied, 1200);
});

test("orden FIFO: fechaOrigen ascendente es la clave primaria", () => {
  const result = DalfiClosingMath.allocateClientPaymentFIFO({
    confirmedPaymentLines: [{ method: "efectivo", amount: 50 }],
    priorClientReceivables: [
      { id: "NUEVA", invoiceId: "FAC-2", kind: "base", amount: 100, fechaOrigen: "2026-07-10" },
      { id: "VIEJA", invoiceId: "FAC-1", kind: "base", amount: 100, fechaOrigen: "2026-07-01" },
    ],
  });
  const byId = Object.fromEntries(result.resultingBalances.map((row) => [row.id, row]));
  assert.equal(byId["VIEJA"].amountApplied, 50);
  assert.equal(byId["NUEVA"].amountApplied, 0);
});

test("orden FIFO: con la misma fechaOrigen, referencia de factura ascendente decide", () => {
  const result = DalfiClosingMath.allocateClientPaymentFIFO({
    confirmedPaymentLines: [{ method: "efectivo", amount: 10 }],
    priorClientReceivables: [
      { id: "X", invoiceId: "FAC-020", kind: "base", amount: 100, fechaOrigen: "2026-07-01" },
      { id: "Y", invoiceId: "FAC-010", kind: "base", amount: 100, fechaOrigen: "2026-07-01" },
    ],
  });
  const byId = Object.fromEntries(result.resultingBalances.map((row) => [row.id, row]));
  assert.equal(byId["Y"].amountApplied, 10, "FAC-010 ordena antes que FAC-020");
  assert.equal(byId["X"].amountApplied, 0);
});

test("orden FIFO: dentro de la MISMA factura y fecha, la base se cobra antes que la propina pendiente", () => {
  const result = DalfiClosingMath.allocateClientPaymentFIFO({
    confirmedPaymentLines: [{ method: "efectivo", amount: 10 }],
    priorClientReceivables: [
      { id: "TIP", invoiceId: "FAC-1", kind: "tip", amount: 100, fechaOrigen: "2026-07-01" },
      { id: "BASE", invoiceId: "FAC-1", kind: "base", amount: 100, fechaOrigen: "2026-07-01" },
    ],
  });
  const byId = Object.fromEntries(result.resultingBalances.map((row) => [row.id, row]));
  assert.equal(byId["BASE"].amountApplied, 10);
  assert.equal(byId["TIP"].amountApplied, 0);
});

test("orden FIFO: desempate final estable por id cuando fecha/factura/tipo son iguales", () => {
  const a = { fechaOrigen: "2026-07-01", invoiceId: "FAC-1", kind: "base", id: "A" };
  const b = { fechaOrigen: "2026-07-01", invoiceId: "FAC-1", kind: "base", id: "B" };
  assert.ok(DalfiClosingMath.compareReceivablesFIFO(a, b) < 0);
  assert.ok(DalfiClosingMath.compareReceivablesFIFO(b, a) > 0);
  assert.equal(DalfiClosingMath.compareReceivablesFIFO(a, a), 0);
});

test("excluye lineas de pago no confirmadas (credito, transferencia_pendiente, metodo desconocido)", () => {
  const result = DalfiClosingMath.allocateClientPaymentFIFO({
    confirmedPaymentLines: [
      { method: "credito", amount: 500 },
      { method: "transferencia_pendiente", amount: 500 },
      { method: "efectivo", amount: 50 },
    ],
    priorClientReceivables: [{ id: "A", invoiceId: "FAC-1", kind: "base", amount: 1000, fechaOrigen: "2026-07-01" }],
  });
  assert.equal(result.totalApplied, 50);
});

test("rechaza NaN/Infinity/negativos con normalizacion monetaria segura (nunca aplica montos invalidos)", () => {
  const result = DalfiClosingMath.allocateClientPaymentFIFO({
    confirmedPaymentLines: [{ method: "efectivo", amount: NaN }, { method: "efectivo", amount: Infinity }, { method: "efectivo", amount: -50 }],
    priorClientReceivables: [{ id: "A", invoiceId: "FAC-1", kind: "base", amount: -100, fechaOrigen: "2026-07-01" }],
  });
  assert.equal(Number.isFinite(result.totalApplied), true);
  assert.equal(result.totalApplied, 0);
  assert.equal(result.resultingBalances.length, 0, "una CxC con monto <= 0 se descarta, nunca se aplica un monto invalido");
});

test("es determinista: misma entrada produce siempre la misma salida", () => {
  const input = {
    confirmedPaymentLines: [{ method: "efectivo", amount: 300 }, { method: "tarjeta", amount: 200 }],
    priorClientReceivables: [
      { id: "A", invoiceId: "FAC-1", kind: "base", amount: 250, fechaOrigen: "2026-07-01" },
      { id: "B", invoiceId: "FAC-2", kind: "tip", amount: 400, fechaOrigen: "2026-07-05" },
    ],
    currentInvoiceBase: 100,
    currentInvoiceTip: 20,
  };
  const first = JSON.stringify(DalfiClosingMath.allocateClientPaymentFIFO(input));
  const second = JSON.stringify(DalfiClosingMath.allocateClientPaymentFIFO(input));
  assert.equal(first, second);
});

test("no muta las listas recibidas (paymentLines/priorClientReceivables originales quedan intactas)", () => {
  const paymentLines = [{ method: "efectivo", amount: 100 }];
  const priorClientReceivables = [{ id: "A", invoiceId: "FAC-1", kind: "base", amount: 500, fechaOrigen: "2026-07-01" }];
  const snapshotLines = JSON.stringify(paymentLines);
  const snapshotReceivables = JSON.stringify(priorClientReceivables);
  DalfiClosingMath.allocateClientPaymentFIFO({ confirmedPaymentLines: paymentLines, priorClientReceivables });
  assert.equal(JSON.stringify(paymentLines), snapshotLines);
  assert.equal(JSON.stringify(priorClientReceivables), snapshotReceivables);
});

test("no toca el DOM ni persiste nada: es una funcion pura (no referencia document/window/localStorage)", () => {
  const source = extractFunction("allocateClientPaymentFIFO", fs.readFileSync(path.join(__dirname, "..", "outputs", "lib", "closing-math.js"), "utf8"));
  assert.doesNotMatch(source, /document\.|window\.(?!DalfiClosingMath)|localStorage/);
});

test("allocationsToPriorReceivables solo incluye filas con amountApplied > 0 (no lista CxC no tocadas)", () => {
  const result = DalfiClosingMath.allocateClientPaymentFIFO({
    confirmedPaymentLines: [{ method: "efectivo", amount: 50 }],
    priorClientReceivables: [
      { id: "A", invoiceId: "FAC-1", kind: "base", amount: 50, fechaOrigen: "2026-07-01" },
      { id: "B", invoiceId: "FAC-2", kind: "base", amount: 50, fechaOrigen: "2026-07-02" },
    ],
  });
  assert.equal(result.allocationsToPriorReceivables.length, 1);
  assert.equal(result.allocationsToPriorReceivables[0].id, "A");
  assert.equal(result.resultingBalances.length, 2, "resultingBalances si incluye TODAS, incluso las no tocadas");
});

// ---------------------------------------------------------------------------
// B. outputs/index.html: boton general + #payment-form centrado en cliente
// ---------------------------------------------------------------------------

test("Facturacion tiene exactamente un boton general 'Registrar cobro de cliente' (#open-client-receipt), fuera de cualquier factura", () => {
  const matches = indexHtml.match(/id="open-client-receipt"/g) || [];
  assert.equal(matches.length, 1);
  assert.match(indexHtml, /<section id="billing" class="view">\s*<section class="panel billing-module-head">/);
});

test("#payment-form ya no tiene el <select id=\"payment-invoice\"> (dependiente de una factura elegida)", () => {
  assert.doesNotMatch(indexHtml, /id="payment-invoice"[^-]/);
});

test("#payment-form busca CLIENTE por nombre, telefono o ID (#payment-client-search)", () => {
  assert.match(indexHtml, /id="payment-client-search"[^>]*list="clients-list"/);
});

test("#payment-form muestra el saldo total del cliente y la cantidad de facturas pendientes (no un saldo de una sola factura)", () => {
  assert.match(indexHtml, /id="payment-client-debt"/);
  assert.match(indexHtml, /id="payment-invoice-count"/);
});

test("#payment-form incluye una previsualizacion de aplicacion FIFO (#payment-allocation-preview) que no existia en el diseno por-factura", () => {
  assert.match(indexHtml, /id="payment-allocation-preview"/);
  assert.match(indexHtml, /id="payment-allocation-rows"/);
});

test("ya no existe el boton .receipt-invoice por-factura en el listado ni en el popup de detalle", () => {
  assert.doesNotMatch(indexHtml, /receipt-invoice/);
});

// ---------------------------------------------------------------------------
// C. outputs/app.js: funciones viejas retiradas, funciones nuevas presentes
// ---------------------------------------------------------------------------

test("las funciones del diseno por-factura (f548985) ya no existen: no se revierte el commit, se reemplaza su uso", () => {
  ["canShowInvoiceReceiptButton", "invoiceClientReceivables", "preferredInvoiceReceivable", "openReceiptFromInvoice", "returnToInvoiceAfterReceipt", "selectedReceivable"].forEach((name) => {
    assert.equal(functionExists(name), false, `${name} deberia haber sido retirada de outputs/app.js`);
  });
  assert.doesNotMatch(stripComments(appJs), /invoicePendingReceiptReturn/);
});

test("las funciones nuevas del cobro general existen: openClientReceiptFromBilling, returnToBillingAfterReceipt, findClientBySearchTerm, clientAllReceivables, selectedPaymentClient, mapReceivablesForAllocation", () => {
  ["openClientReceiptFromBilling", "returnToBillingAfterReceipt", "findClientBySearchTerm", "clientAllReceivables", "selectedPaymentClient", "mapReceivablesForAllocation"].forEach((name) => {
    assert.equal(functionExists(name), true, `${name} deberia existir en outputs/app.js`);
  });
});

test("openClientReceiptFromBilling(): exige permiso via canManageInvoices() antes de abrir el formulario", () => {
  const source = extractFunction("openClientReceiptFromBilling");
  assert.match(source, /canManageInvoices\(\)/);
  assert.match(source, /alert\(/);
});

test("openClientReceiptFromBilling(): reutiliza #payment-form EXISTENTE (switchToView('receivables') + revealFormAtTop), no crea un modal ni formulario nuevo", () => {
  const source = extractFunction("openClientReceiptFromBilling");
  assert.match(source, /switchToView\("receivables"\)/);
  assert.match(source, /revealFormAtTop\(byId\("payment-form"\)/);
});

test("el boton #open-client-receipt esta conectado a openClientReceiptFromBilling", () => {
  assert.match(appJs, /byId\("open-client-receipt"\)\?\.addEventListener\("click", openClientReceiptFromBilling\)/);
});

test("findClientBySearchTerm(): busca por nombre exacto, telefono exacto o ID exacto antes de caer a coincidencia parcial", () => {
  const source = extractFunction("findClientBySearchTerm");
  assert.match(source, /nombreCompleto/);
  assert.match(source, /telefono/);
  assert.match(source, /clienteID/);
});

test("mapReceivablesForAllocation(): marca kind:'tip' solo cuando esPropinaPendiente es verdadero (compatibilidad historica: filas sin el campo son 'base' por defecto)", () => {
  const source = extractFunction("mapReceivablesForAllocation");
  assert.match(source, /esPropinaPendiente \? "tip" : "base"/);
});

test("updatePaymentSummary()/renderPaymentAllocationPreview() llaman a DalfiClosingMath.allocateClientPaymentFIFO para la previsualizacion en vivo", () => {
  const source = extractFunction("renderPaymentAllocationPreview");
  assert.match(source, /DalfiClosingMath\.allocateClientPaymentFIFO\(/);
});

test("renderPaymentAllocationPreview(): sin cliente o sin CxC pendientes, no muestra la previsualizacion (queda oculta)", () => {
  const source = extractFunction("renderPaymentAllocationPreview");
  assert.match(source, /container\.classList\.add\("hidden"\)/);
});

test("#payment-client-search dispara updatePaymentSummary() en cada input (previsualizacion en vivo)", () => {
  assert.match(appJs, /byId\("payment-client-search"\)\.addEventListener\("input", updatePaymentSummary\)/);
});

// ---------------------------------------------------------------------------
// D. Submit de #payment-form: permiso, guardia de doble-submit, reparto real,
//    un solo recibo, procesador de tarjeta general, auditoria, retorno.
// ---------------------------------------------------------------------------

function extractPaymentSubmitHandler() {
  return extractStatementBlock('byId("payment-form").addEventListener("submit"', "(event) => {", appJs);
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
  return source.slice(startIdx, end);
}

test("el submit de #payment-form usa canManageInvoices() (erpProfile.permissions), nunca user_metadata", () => {
  const source = extractPaymentSubmitHandler();
  assert.match(source, /canManageInvoices\(\)/);
  assert.doesNotMatch(source, /user_metadata/);
});

test("el submit de #payment-form resuelve el cliente con selectedPaymentClient() y valida que tenga CxC pendientes, ya no depende de una factura seleccionada", () => {
  const source = extractPaymentSubmitHandler();
  assert.match(source, /selectedPaymentClient\(\)/);
  assert.match(source, /clientAllReceivables\(clientRecord\)/);
  assert.doesNotMatch(source, /selectedReceivable\(\)/);
});

test("el submit de #payment-form tiene guardia de doble-submit (paymentSubmitInFlight) con el mismo patron try/finally que invoiceSubmitInFlight/cashSubmitInFlight", () => {
  assert.match(appJs, /let paymentSubmitInFlight = false;/);
  const source = extractPaymentSubmitHandler();
  assert.match(source, /if \(paymentSubmitInFlight\) return;/);
  assert.match(source, /paymentSubmitInFlight = true;/);
  assert.match(source, /finally \{\s*paymentSubmitInFlight = false;/);
});

test("el submit de #payment-form aplica el cobro con applyReceivablePaymentLines sobre TODAS las CxC del cliente (no un reparto distinto)", () => {
  const source = extractPaymentSubmitHandler();
  assert.match(source, /applyReceivablePaymentLines\(receivables, amountToDebt, orderedLines, cashDate\)/);
});

test("el submit de #payment-form genera UN SOLO logAudit('cxc_receipt_created', ...) por envio exitoso, con la lista de facturas afectadas", () => {
  const source = extractPaymentSubmitHandler();
  const matches = source.match(/logAudit\("cxc_receipt_created"/g) || [];
  assert.equal(matches.length, 1);
  assert.match(source, /facturasAfectadas: affectedInvoiceIds/);
});

test("el submit de #payment-form crea una CxC general del procesador de tarjeta (sin facturaID propio) por cada linea de tarjeta, por el monto COMPLETO de la linea", () => {
  const source = extractPaymentSubmitHandler();
  assert.match(source, /addReceivable\("", \{ clienteID: processor\.procesadorID \|\| "" \}, processor\.nombre \|\| "Procesador tarjeta", line\.amount, "CxC procesador tarjeta"/);
});

test("el submit de #payment-form llama a returnToBillingAfterReceipt() tras guardar (funciona igual si se abrio desde Facturacion o directamente desde Cuentas por Cobrar)", () => {
  const source = extractPaymentSubmitHandler();
  assert.match(source, /returnToBillingAfterReceipt\(\);/);
});

test("#payment-receipt-cancel llama DIRECTAMENTE a returnToBillingAfterReceipt(), sin pasar por el submit (no crea ni modifica nada)", () => {
  const source = extractStatementBlock('byId("payment-receipt-cancel")?.addEventListener("click"', "(event) => {", appJs);
  assert.match(source, /event\.preventDefault\(\);\s*returnToBillingAfterReceipt\(\);/);
});

test("returnToBillingAfterReceipt(): si no hay snapshot (formulario abierto normalmente desde Cuentas por Cobrar), no fuerza la vuelta a Facturacion", () => {
  const source = extractFunction("returnToBillingAfterReceipt");
  assert.match(source, /if \(!clientPendingReceiptReturn\)/);
});

test("returnToBillingAfterReceipt(): limpia clientPendingReceiptReturn ANTES de navegar (no puede quedar pegado)", () => {
  const source = extractFunction("returnToBillingAfterReceipt");
  const clearIdx = source.search(/clientPendingReceiptReturn = null;/);
  const navigateIdx = source.search(/switchToView\(snapshot\.originView/);
  assert.ok(clearIdx !== -1 && navigateIdx !== -1 && clearIdx < navigateIdx);
});

test("las mutaciones reales (applyReceivablePaymentLines, addReceivable, logAudit) del submit quedan dentro del try/finally de paymentSubmitInFlight", () => {
  const source = extractPaymentSubmitHandler();
  const tryIdx = source.indexOf("try {");
  const applyIdx = source.indexOf("applyReceivablePaymentLines(");
  const auditIdx = source.indexOf('logAudit("cxc_receipt_created"');
  const finallyIdx = source.indexOf("} finally {");
  assert.ok(tryIdx !== -1 && applyIdx > tryIdx && auditIdx > tryIdx && finallyIdx > auditIdx);
});

test("nunca registra un recibo como credito: getIncomePaymentLines/#payment-method solo ofrecen efectivo/tarjeta/transferencia (medios ya confirmados)", () => {
  assert.match(indexHtml, /<select id="payment-method">\s*<option value="efectivo">Efectivo<\/option>\s*<option value="tarjeta">Tarjeta<\/option>\s*<option value="transferencia">Transferencia<\/option>\s*<\/select>/);
});

test("PAYMENT_FORM_METHOD_PRIORITY deja tarjeta de ultimo (solo financia cuando efectivo/transferencia no alcanzan), igual politica que en facturacion", () => {
  assert.match(appJs, /const PAYMENT_FORM_METHOD_PRIORITY = \["efectivo", "transferencia", "tarjeta"\];/);
});
