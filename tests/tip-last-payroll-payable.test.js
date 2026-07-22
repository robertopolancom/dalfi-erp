// Pruebas de la politica "LA PROPINA SE COBRA Y SE REGISTRA DE ULTIMO"
// (julio 2026): dinero confirmado se aplica siempre CxC anteriores -> base
// de la factura actual -> propina, en ese orden. Cubre la funcion pura
// DalfiClosingMath.allocateConfirmedPayment() a fondo (sin DOM, sin mocks)
// y, con el mismo patron estatico usado en tests/closing-cash-confirm-state.test.js,
// verifica que outputs/app.js este correctamente conectado a esa funcion.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DalfiClosingMath = require("../outputs/lib/closing-math.js");
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

// ===================================================================
// PARTE A: allocateConfirmedPayment() — funcion pura, sin DOM, sin efectos.
// ===================================================================

// --- 1-4: factura simple sin CxC anteriores ---

test("1. factura sin propina: todo el pago confirmado va a la base, nada a propina", () => {
  const r = DalfiClosingMath.allocateConfirmedPayment({
    paymentLines: [{ method: "efectivo", amount: 1000 }],
    currentInvoiceBaseOutstanding: 1000,
    invoiceTipTotal: 0,
  });
  assert.strictEqual(r.amountAppliedToCurrentBase, 1000);
  assert.strictEqual(r.tipCollectedNow, 0);
  assert.strictEqual(r.unappliedAmount, 0);
});

test("2-3. base pagada parcialmente / completamente, sin propina cobrada mientras quede base", () => {
  let r = DalfiClosingMath.allocateConfirmedPayment({
    paymentLines: [{ method: "efectivo", amount: 800 }],
    currentInvoiceBaseOutstanding: 1000,
    invoiceTipTotal: 200,
  });
  assert.strictEqual(r.amountAppliedToCurrentBase, 800);
  assert.strictEqual(r.tipCollectedNow, 0, "4. propina no cobrada mientras quede base pendiente");
  assert.strictEqual(r.tipRemaining, 200);

  r = DalfiClosingMath.allocateConfirmedPayment({
    paymentLines: [{ method: "efectivo", amount: 1000 }],
    currentInvoiceBaseOutstanding: 1000,
    invoiceTipTotal: 200,
  });
  assert.strictEqual(r.amountAppliedToCurrentBase, 1000);
  assert.strictEqual(r.tipCollectedNow, 0);
  assert.strictEqual(r.tipRemaining, 200);
});

// --- 5-7: prioridad CxC anteriores -> base -> propina (Ejemplo 3 exacto) ---

test("5-7. Ejemplo 3 del encargo: CxC anterior 300, base 1000, propina 200, pago 1400", () => {
  const r = DalfiClosingMath.allocateConfirmedPayment({
    paymentLines: [{ method: "efectivo", amount: 1400 }],
    olderReceivablesOutstanding: 300,
    currentInvoiceBaseOutstanding: 1000,
    invoiceTipTotal: 200,
  });
  assert.strictEqual(r.amountAppliedToOlderReceivables, 300, "1. RD$300 a la CxC anterior");
  assert.strictEqual(r.amountAppliedToCurrentBase, 1000, "2. RD$1,000 a la base de la factura actual");
  assert.strictEqual(r.tipCollectedNow, 100, "3. RD$100 a la propina");
  assert.strictEqual(r.tipRemaining, 100, "4. Propina pendiente: RD$100");
});

// --- 8-10: pago menor/igual/mayor que la base ---

test("8-10. pago menor/igual/mayor que la base outstanding", () => {
  const menor = DalfiClosingMath.allocateConfirmedPayment({ paymentLines: [{ method: "efectivo", amount: 500 }], currentInvoiceBaseOutstanding: 1000, invoiceTipTotal: 0 });
  assert.strictEqual(menor.amountAppliedToCurrentBase, 500);
  const igual = DalfiClosingMath.allocateConfirmedPayment({ paymentLines: [{ method: "efectivo", amount: 1000 }], currentInvoiceBaseOutstanding: 1000, invoiceTipTotal: 0 });
  assert.strictEqual(igual.amountAppliedToCurrentBase, 1000);
  assert.strictEqual(igual.unappliedAmount, 0);
  const mayor = DalfiClosingMath.allocateConfirmedPayment({ paymentLines: [{ method: "efectivo", amount: 1500 }], currentInvoiceBaseOutstanding: 1000, invoiceTipTotal: 0 });
  assert.strictEqual(mayor.amountAppliedToCurrentBase, 1000);
  assert.strictEqual(mayor.unappliedAmount, 500, "el exceso sin propina que lo consuma queda sin aplicar (sobrepago)");
});

// --- 11-12: pago cubre parte/toda la propina (Ejemplos 1 y 2) ---

test("11-12. Ejemplo 1: pago 800 (base 1000, propina 200) -> propina cobrada 0. Ejemplo 2: pago 1100 -> propina cobrada 100", () => {
  const ej1 = DalfiClosingMath.allocateConfirmedPayment({ paymentLines: [{ method: "efectivo", amount: 800 }], currentInvoiceBaseOutstanding: 1000, invoiceTipTotal: 200 });
  assert.strictEqual(ej1.amountAppliedToCurrentBase, 800);
  assert.strictEqual(ej1.tipCollectedNow, 0);
  assert.strictEqual(ej1.tipRemaining, 200);

  const ej2 = DalfiClosingMath.allocateConfirmedPayment({ paymentLines: [{ method: "efectivo", amount: 1100 }], currentInvoiceBaseOutstanding: 1000, invoiceTipTotal: 200 });
  assert.strictEqual(ej2.amountAppliedToCurrentBase, 1000);
  assert.strictEqual(ej2.tipCollectedNow, 100);
  assert.strictEqual(ej2.tipRemaining, 100);
});

// --- 13-14: factura completamente a credito (Ejemplo 4) ---

test("13-14. Ejemplo 4: factura completamente a credito -> nada aplicado, propina pendiente completa, sin generar cuenta por pagar", () => {
  const r = DalfiClosingMath.allocateConfirmedPayment({
    paymentLines: [{ method: "credito", amount: 1200 }],
    currentInvoiceBaseOutstanding: 1000,
    invoiceTipTotal: 200,
  });
  assert.strictEqual(r.amountAppliedToCurrentBase, 0, "credito esta EXCLUIDO: no cuenta como dinero confirmado");
  assert.strictEqual(r.tipCollectedNow, 0);
  assert.strictEqual(r.tipRemaining, 200, "toda la propina queda pendiente");
  assert.strictEqual(r.unappliedAmount, 0, "credito nunca entra al pool, no genera 'sobrante' fantasma");
});

// --- 15-17: pago posterior / dos / tres pagos parciales (invoiceTipAlreadyCollected) ---

test("15-17. pagos posteriores encadenados: cada llamada solo cobra la porcion NUEVA de propina, nunca recobra lo ya reconocido", () => {
  // Primer pago: cubre toda la base, nada de propina.
  const p1 = DalfiClosingMath.allocateConfirmedPayment({ paymentLines: [{ method: "efectivo", amount: 1000 }], currentInvoiceBaseOutstanding: 1000, invoiceTipTotal: 200, invoiceTipAlreadyCollected: 0 });
  assert.strictEqual(p1.tipCollectedNow, 0);
  // Segundo pago (posterior): base ya en 0 (todo pagado), 100 de propina.
  const p2 = DalfiClosingMath.allocateConfirmedPayment({ paymentLines: [{ method: "efectivo", amount: 100 }], currentInvoiceBaseOutstanding: 0, invoiceTipTotal: 200, invoiceTipAlreadyCollected: p1.tipCollectedNow });
  assert.strictEqual(p2.tipCollectedNow, 100);
  // Tercer pago: cubre el resto de la propina.
  const p3 = DalfiClosingMath.allocateConfirmedPayment({ paymentLines: [{ method: "efectivo", amount: 100 }], currentInvoiceBaseOutstanding: 0, invoiceTipTotal: 200, invoiceTipAlreadyCollected: p1.tipCollectedNow + p2.tipCollectedNow });
  assert.strictEqual(p3.tipCollectedNow, 100);
  assert.strictEqual(p3.tipRemaining, 0);
  assert.strictEqual(p1.tipCollectedNow + p2.tipCollectedNow + p3.tipCollectedNow, 200, "la suma de las 3 cobranzas debe ser exactamente la propina total");
});

// --- 18-22: medios de pago y su orden ---

test("18-19. efectivo y transferencia confirmada cuentan como dinero disponible", () => {
  const r = DalfiClosingMath.allocateConfirmedPayment({
    paymentLines: [{ method: "efectivo", amount: 500 }, { method: "transferencia_confirmada", amount: 500 }],
    currentInvoiceBaseOutstanding: 1000,
    invoiceTipTotal: 0,
  });
  assert.strictEqual(r.amountAppliedToCurrentBase, 1000);
  assert.strictEqual(r.allocationByPaymentMethod.efectivo, 500);
  assert.strictEqual(r.allocationByPaymentMethod.transferencia_confirmada, 500);
});

test("20. transferencia pendiente (sin confirmar) queda EXCLUIDA por completo", () => {
  const r = DalfiClosingMath.allocateConfirmedPayment({
    paymentLines: [{ method: "transferencia_pendiente", amount: 1000 }],
    currentInvoiceBaseOutstanding: 1000,
    invoiceTipTotal: 200,
  });
  assert.strictEqual(r.amountAppliedToCurrentBase, 0);
  assert.strictEqual(r.tipCollectedNow, 0);
  assert.deepStrictEqual(r.allocationByPaymentMethod.transferencia_pendiente, undefined, "ni siquiera aparece como metodo valido");
});

test("21. confirmacion posterior de una transferencia: se vuelve a llamar con el metodo ya CONFIRMADO y ahora si cuenta", () => {
  const r = DalfiClosingMath.allocateConfirmedPayment({
    paymentLines: [{ method: "transferencia_confirmada", amount: 1000 }],
    currentInvoiceBaseOutstanding: 1000,
    invoiceTipTotal: 200,
    invoiceTipAlreadyCollected: 0,
  });
  assert.strictEqual(r.amountAppliedToCurrentBase, 1000);
});

test("23-24. tarjeta confirmada cuenta; una tarjeta pendiente/rechazada (metodo desconocido) queda excluida", () => {
  const confirmada = DalfiClosingMath.allocateConfirmedPayment({ paymentLines: [{ method: "tarjeta", amount: 1000 }], currentInvoiceBaseOutstanding: 1000, invoiceTipTotal: 0 });
  assert.strictEqual(confirmada.amountAppliedToCurrentBase, 1000);
  const pendiente = DalfiClosingMath.allocateConfirmedPayment({ paymentLines: [{ method: "tarjeta_pendiente", amount: 1000 }], currentInvoiceBaseOutstanding: 1000, invoiceTipTotal: 0 });
  assert.strictEqual(pendiente.amountAppliedToCurrentBase, 0, "un metodo que no esta en methodPriority nunca cuenta como confirmado");
});

test("25-27. efectivo y transferencia confirmada se consumen ANTES que tarjeta; tarjeta solo financia propina cuando los demas no alcanzan", () => {
  const r = DalfiClosingMath.allocateConfirmedPayment({
    paymentLines: [{ method: "tarjeta", amount: 500 }, { method: "efectivo", amount: 900 }],
    olderReceivablesOutstanding: 300,
    currentInvoiceBaseOutstanding: 1000,
    invoiceTipTotal: 200,
  });
  // efectivo (900) cubre los 300 de CxC + 600 de base; tarjeta cubre los 400 de base restantes + 100 de propina.
  assert.deepStrictEqual(r.lineAllocations[1], { index: 1, method: "efectivo", amount: 900, olderReceivables: 300, currentBase: 600, tip: 0, unapplied: 0 });
  assert.deepStrictEqual(r.lineAllocations[0], { index: 0, method: "tarjeta", amount: 500, olderReceivables: 0, currentBase: 400, tip: 100, unapplied: 0 });
});

test("28. pago mixto (efectivo + transferencia + tarjeta) reparte correctamente entre los tres cubos", () => {
  const r = DalfiClosingMath.allocateConfirmedPayment({
    paymentLines: [{ method: "tarjeta", amount: 100 }, { method: "transferencia_confirmada", amount: 100 }, { method: "efectivo", amount: 100 }],
    currentInvoiceBaseOutstanding: 250,
    invoiceTipTotal: 50,
  });
  assert.strictEqual(r.amountAppliedToCurrentBase, 250);
  assert.strictEqual(r.tipCollectedNow, 50);
  assert.strictEqual(r.unappliedAmount, 0);
});

test("29. credito nunca participa del reparto, ni siquiera mezclado con lineas confirmadas", () => {
  const r = DalfiClosingMath.allocateConfirmedPayment({
    paymentLines: [{ method: "efectivo", amount: 500 }, { method: "credito", amount: 5000 }],
    currentInvoiceBaseOutstanding: 1000,
    invoiceTipTotal: 200,
  });
  assert.strictEqual(r.totalConfirmed, 500, "el credito ni siquiera cuenta en el total confirmado");
});

test("30. la propina cobrada NUNCA puede superar invoiceTipTotal, sin importar cuanto dinero confirmado llegue", () => {
  const r = DalfiClosingMath.allocateConfirmedPayment({
    paymentLines: [{ method: "efectivo", amount: 100000 }],
    currentInvoiceBaseOutstanding: 1000,
    invoiceTipTotal: 200,
  });
  assert.strictEqual(r.tipCollectedNow, 200);
  assert.strictEqual(r.unappliedAmount, 100000 - 1000 - 200);
});

// --- 34: redondeo exacto ---

test("34. redondeo: la suma de amountAppliedToOlderReceivables + amountAppliedToCurrentBase + tipCollectedNow + unappliedAmount siempre es exactamente el total confirmado", () => {
  const cases = [
    { paymentLines: [{ method: "efectivo", amount: 33.33 }, { method: "tarjeta", amount: 33.33 }, { method: "transferencia_confirmada", amount: 33.34 }], olderReceivablesOutstanding: 10.01, currentInvoiceBaseOutstanding: 50.5, invoiceTipTotal: 20.15 },
    { paymentLines: [{ method: "efectivo", amount: 0.01 }], currentInvoiceBaseOutstanding: 0, invoiceTipTotal: 0.01 },
  ];
  cases.forEach((input) => {
    const r = DalfiClosingMath.allocateConfirmedPayment(input);
    const sum = Number((r.amountAppliedToOlderReceivables + r.amountAppliedToCurrentBase + r.tipCollectedNow + r.unappliedAmount).toFixed(8));
    assert.strictEqual(sum, Number(r.totalConfirmed.toFixed(8)));
  });
});

// --- 56-58: sin NaN, sin infinito, sin negativos ---

test("56-58. rechaza NaN/Infinito/negativos en cualquier entrada, sin propagarlos", () => {
  const r = DalfiClosingMath.allocateConfirmedPayment({
    paymentLines: [{ method: "efectivo", amount: NaN }, { method: "tarjeta", amount: Infinity }, { method: "transferencia_confirmada", amount: -500 }],
    olderReceivablesOutstanding: NaN,
    currentInvoiceBaseOutstanding: -100,
    invoiceTipTotal: Infinity,
    invoiceTipAlreadyCollected: -50,
  });
  Object.entries(r).forEach(([key, value]) => {
    if (typeof value === "number") assert.ok(Number.isFinite(value), `${key} no debe ser NaN/Infinito: ${value}`);
  });
  assert.strictEqual(r.amountAppliedToOlderReceivables, 0);
  assert.strictEqual(r.amountAppliedToCurrentBase, 0);
});

test("acepta cero en todas las entradas sin romperse", () => {
  const r = DalfiClosingMath.allocateConfirmedPayment({ paymentLines: [], olderReceivablesOutstanding: 0, currentInvoiceBaseOutstanding: 0, invoiceTipTotal: 0, invoiceTipAlreadyCollected: 0 });
  assert.strictEqual(r.amountAppliedToOlderReceivables, 0);
  assert.strictEqual(r.tipCollectedNow, 0);
  assert.strictEqual(r.unappliedAmount, 0);
});

test("es deterministica: la misma entrada siempre produce la misma salida", () => {
  const input = { paymentLines: [{ method: "efectivo", amount: 700 }, { method: "tarjeta", amount: 300 }], olderReceivablesOutstanding: 200, currentInvoiceBaseOutstanding: 500, invoiceTipTotal: 100 };
  const a = JSON.stringify(DalfiClosingMath.allocateConfirmedPayment(input));
  const b = JSON.stringify(DalfiClosingMath.allocateConfirmedPayment(input));
  assert.strictEqual(a, b);
});

test("no lee el DOM, no persiste, no crea registros: es una funcion pura de closing-math.js (mismo modulo que computeInvoiceBreakdown)", () => {
  const closingMath = fs.readFileSync(path.join(__dirname, "..", "outputs", "lib", "closing-math.js"), "utf8");
  const fnSource = extractFunction("allocateConfirmedPayment", closingMath);
  assert.ok(!/document\.|byId\(/.test(fnSource), "no debe leer el DOM");
  assert.ok(!/dbTable\(|stampRecord\(/.test(fnSource), "no debe crear ni persistir registros");
});

// ===================================================================
// PARTE B: wiring estatico en outputs/app.js (mismo patron que
// closing-cash-confirm-state.test.js — sin DOM real en este runner).
// ===================================================================

test("el submit de factura calcula la deuda anterior real del cliente (clientAllReceivables, misma lista que el cobro general) antes de repartir el pago", () => {
  assert.match(submitHandler, /const priorReceivables = clientAllReceivables\(clientRecord\);/);
});

test("el submit de factura llama a DalfiClosingMath.allocateClientPaymentFIFO con currentInvoiceBase: total e currentInvoiceTip: tip (nunca al reves) — mismo algoritmo que el cobro general", () => {
  assert.match(submitHandler, /DalfiClosingMath\.allocateClientPaymentFIFO\(\{/);
  assert.match(submitHandler, /currentInvoiceBase: total,/);
  assert.match(submitHandler, /currentInvoiceTip: tip,/);
  assert.match(submitHandler, /currentInvoiceTipCollected: 0,/);
  assert.doesNotMatch(submitHandler, /DalfiClosingMath\.allocateConfirmedPayment\(/, "la creacion de factura ya no debe llamar allocateConfirmedPayment directamente");
});

test("las lineas credito/transferencia_pendiente se excluyen del reparto (solo isConfirmedPaymentMethod entra a allocateClientPaymentFIFO)", () => {
  const filterIdx = submitHandler.indexOf("const confirmedPayments = payments.filter((paymentLine) => isConfirmedPaymentMethod(paymentLine.method));");
  assert.ok(filterIdx >= 0);
  const allocateIdx = submitHandler.indexOf("DalfiClosingMath.allocateClientPaymentFIFO(");
  assert.ok(allocateIdx > filterIdx, "el filtro debe ocurrir antes de construir la entrada de allocateClientPaymentFIFO");
});

test("'balance a favor' se limita a lo que el cliente REALMENTE tiene (Math.min con clientBalance) antes de entrar al reparto", () => {
  assert.match(submitHandler, /paymentLine\.method === "balance" \? Math\.min\(paymentLine\.amount, availableBalance\) : paymentLine\.amount/);
});

test("'balance a favor' nunca crea un ingreso nuevo (recordAsIncome:false), evitando duplicar caja con dinero que no volvio a entrar", () => {
  const balanceBlock = submitHandler.slice(submitHandler.indexOf('if (paymentLine.method === "balance") {'), submitHandler.indexOf("return;\n      }\n      if (olderPortion > 0) applyClientReceivablesFirst(clientRecord, client, olderPortion, paymentLine.method"));
  assert.match(balanceBlock, /\{ recordAsIncome: false \}/);
  assert.ok(!/addConfirmedPayment\(invoiceId/.test(balanceBlock), "el branch de balance no debe llamar addConfirmedPayment para la factura actual");
});

test("tarjeta: la CxC del procesador usa el monto COMPLETO de la linea (paymentLine.amount), no solo la porcion aplicada a esta factura", () => {
  assert.match(submitHandler, /addReceivable\(invoiceId, \{ clienteID: processor\.procesadorID \|\| "" \}, processor\.nombre \|\| "Procesador tarjeta", paymentLine\.amount, "CxC procesador tarjeta", "", invoiceDate\);/);
});

test("propina pendiente al crear la factura se registra como CxC PROPIA y separada (esPropinaPendiente:true), no mezclada con la CxC de base", () => {
  assert.match(submitHandler, /if \(invoiceRecord\.propinaPendiente > 0\) \{/);
  assert.match(submitHandler, /addReceivable\(invoiceId, clientRecord, client, invoiceRecord\.propinaPendiente, `Propina pendiente factura \$\{invoiceId\}`, "", invoiceDate, \{ esPropinaPendiente: true \}\);/);
});

test("collectInvoiceTip() se llama con cardPortion = suma de lineAllocations de metodo tarjeta (para prorratear la retencion solo sobre lo financiado por tarjeta)", () => {
  assert.match(submitHandler, /const cardTipPortion = allocation\.lineAllocations/);
  assert.match(submitHandler, /\.filter\(\(lineAllocation\) => lineAllocation\.method === "tarjeta"\)/);
  assert.match(submitHandler, /collectInvoiceTip\(invoiceRecord, allocation\.amountAppliedToCurrentTip, \{ cardPortion: cardTipPortion, source: invoiceId \}\);/);
});

test("35-37. la cuenta por pagar de nomina SOLO se genera por propina cobrada (collectInvoiceTip acota a dbInvoice.propinaPendiente, nunca inventa mas)", () => {
  const fnSource = extractFunction("collectInvoiceTip");
  assert.match(fnSource, /const toCollect = Math\.min\(pendingBefore, Math\.max\(0, Number\(amount\) \|\| 0\)\);/);
  assert.match(fnSource, /if \(toCollect <= 0\) return \{ collected: 0, allocations: \[\] \};/);
  assert.match(fnSource, /if \(!dbInvoice\) return \{ collected: 0, allocations: \[\] \};/);
});

test("37. estado inicial de la cuenta por pagar es 'Pendiente' (equivalente existente a pending_payroll)", () => {
  const fnSource = extractFunction("collectInvoiceTip");
  assert.match(fnSource, /estadoPagoNomina: "Pendiente",/);
});

test("38. cobro del cliente NUNCA marca la nomina como pagada: collectInvoiceTip no toca estadoPagoNomina de una fila existente", () => {
  const fnSource = extractFunction("collectInvoiceTip");
  const updateBlock = fnSource.slice(fnSource.indexOf("payable.montoBruto ="));
  assert.ok(!/estadoPagoNomina\s*=/.test(updateBlock), "actualizar montoBruto/montoNetoPagar no debe reescribir estadoPagoNomina de una fila ya existente");
});

// --- 39-41: caja/banco impactados una sola vez ---

test("39-41. el dinero del cliente impacta caja/banco EXACTAMENTE una vez por linea (addConfirmedPayment se llama una sola vez por linea confirmada, nunca una segunda vez para la porcion de propina)", () => {
  const forEachBlock = submitHandler.slice(submitHandler.indexOf("confirmedPayments.forEach((paymentLine, index) => {"), submitHandler.indexOf("// Credito y transferencia pendiente NUNCA participan"));
  const addConfirmedPaymentCalls = forEachBlock.match(/addConfirmedPayment\(invoiceId,/g) || [];
  assert.strictEqual(addConfirmedPaymentCalls.length, 1, "solo debe haber una llamada a addConfirmedPayment(invoiceId,...) por iteracion, cubriendo base+propina juntos");
  assert.match(forEachBlock, /const invoicePortion = lineAllocation\.currentBase \+ lineAllocation\.tip;/);
});

// --- 47-48: sourceKey estable, nunca basado en length ---

test("47-48. sourceKey de la cuenta por pagar es facturaID:colaboradorID (estable), nunca dbTable.length ni un contador", () => {
  const fnSource = extractFunction("collectInvoiceTip");
  assert.match(fnSource, /const sourceKey = `\$\{dbInvoice\.facturaID\}:\$\{allocation\.colaboradorID\}`;/);
  assert.ok(!/\.length/.test(fnSource.split("\n").filter((l) => l.includes("sourceKey")).join("\n")), "sourceKey no debe derivarse de .length de ninguna coleccion");
});

test("collectInvoiceTip() es idempotente por construccion: busca por sourceKey y ACTUALIZA la misma fila mientras siga Pendiente de nomina (nunca le suma dinero a una fila ya Pagada, que quedaria oculta para siempre)", () => {
  const fnSource = extractFunction("collectInvoiceTip");
  assert.match(fnSource, /let payable = dbTable\("propinas"\)\.find\(\(row\) => row\.sourceKey === sourceKey && normalize\(row\.estadoPagoNomina \|\| "Pendiente"\) === "pendiente"\);/);
  assert.match(fnSource, /if \(!payable\) \{/);
});

test("regresion: collectInvoiceTip() crea una fila NUEVA (nunca reutiliza una ya Pagada) cuando llega mas propina despues de que la obligacion anterior de esa factura+colaboradora ya se pago en nomina", () => {
  const fnSource = extractFunction("collectInvoiceTip");
  assert.match(fnSource, /estadoPagoNomina \|\| "Pendiente"\) === "pendiente"/);
  // invoiceTipReversalBlockedReason/reverseInvoiceTipCollection deben poder
  // convivir con varias filas para la misma factura+colaboradora: filtran
  // por facturaID y por "source" dentro de pagosAplicados, nunca asumen una
  // unica fila por sourceKey.
  const blockedSource = extractFunction("invoiceTipReversalBlockedReason");
  assert.match(blockedSource, /dbTable\("propinas"\)\.filter\(\s*\(row\) => row\.facturaID === cxc\.facturaID/);
  const reverseSource = extractFunction("reverseInvoiceTipCollection");
  assert.match(reverseSource, /dbTable\("propinas"\)\s*\.filter\(\(row\) => row\.facturaID === cxc\.facturaID\)/);
});

// --- 49-52: reversion ---

test("49-51. voidReceivableReceipt: antes de mutar nada, verifica que ninguna propina financiada por el recibo ya este pagada en nomina, y bloquea con mensaje claro si lo esta", () => {
  const fnSource = extractFunction("voidReceivableReceipt");
  const blockIdx = fnSource.indexOf("const blockedReason =");
  const confirmIdx = fnSource.indexOf("if (!confirm(");
  assert.ok(blockIdx >= 0 && confirmIdx > blockIdx, "el chequeo de bloqueo debe ocurrir ANTES del confirm() y de cualquier mutacion");
  assert.match(fnSource, /if \(blockedReason\) \{\s*\n\s*alert\(blockedReason\);\s*\n\s*return;\s*\n\s*\}/);
});

test("invoiceTipReversalBlockedReason(): detecta especificamente pagosAplicados con ese cxCID como source, y solo bloquea si esa fila de nomina YA NO esta 'Pendiente'", () => {
  const fnSource = extractFunction("invoiceTipReversalBlockedReason");
  assert.match(fnSource, /row\.pagosAplicados\.some\(\(entry\) => entry\.source === cxc\.cxCID\)/);
  assert.match(fnSource, /normalize\(row\.estadoPagoNomina \|\| "Pendiente"\) !== "pendiente"/);
});

test("50. reverseInvoiceTipCollection(): revierte EXACTAMENTE la entrada de pagosAplicados de ese cobro (source === cxc.cxCID), nunca un monto adivinado/proporcional", () => {
  const fnSource = extractFunction("reverseInvoiceTipCollection");
  assert.match(fnSource, /const entry = row\.pagosAplicados\.find\(\(item\) => item\.source === cxc\.cxCID\);/);
  assert.match(fnSource, /row\.montoBruto = Number\(Math\.max\(0, \(Number\(row\.montoBruto\) \|\| 0\) - entry\.amount\)\.toFixed\(2\)\);/);
});

test("52. doble reversion bloqueada: una segunda llamada no encuentra la entrada de pagosAplicados (ya fue removida) y no resta nada de nuevo", () => {
  const fnSource = extractFunction("reverseInvoiceTipCollection");
  assert.match(fnSource, /row\.pagosAplicados = row\.pagosAplicados\.filter\(\(item\) => item !== entry\);/);
  assert.match(fnSource, /if \(!entry\) return;/);
});

test("voidReceivableReceipt: una CxC de propina pendiente se reversa via reverseInvoiceTipCollection, NUNCA via el branch de totalCxC/totalPagadoConfirmado de la base", () => {
  const fnSource = extractFunction("voidReceivableReceipt");
  assert.match(fnSource, /if \(cxc\?\.esPropinaPendiente\) \{\s*\n\s*reverseInvoiceTipCollection\(dbInvoice, cxc\);/);
});

// --- 62-63: auditoria ---

test("62-63. voidReceivableReceipt sigue emitiendo logAudit('void_receivable_receipt', ...) tras la reversion (incluyendo cuando reversa propina)", () => {
  const fnSource = extractFunction("voidReceivableReceipt");
  assert.match(fnSource, /logAudit\("void_receivable_receipt", \{/);
});

// --- 64-65: permisos ---

test("64-65. voidReceivableReceipt sigue exigiendo canManageInvoices() (nunca user_metadata) antes de evaluar el bloqueo de reversion", () => {
  const fnSource = extractFunction("voidReceivableReceipt");
  const permIdx = fnSource.indexOf("if (!canManageInvoices())");
  const blockIdx = fnSource.indexOf("const blockedReason =");
  assert.ok(permIdx >= 0 && permIdx < blockIdx);
});

// --- 53-55: edicion de factura ---

test("53-54. saveEditedInvoice(): bloquea guardar si la propina total quedaria por debajo de lo YA cobrado (propinaCobrada)", () => {
  const fnSource = extractFunction("saveEditedInvoice");
  assert.match(fnSource, /if \(previousTip < tipCollectedSoFar\) \{/);
  assert.match(fnSource, /return false;/);
});

test("55. saveEditedInvoice(): factura historica sin propinaCobrada/propinaPendiente cae a un default seguro (no revienta, no bloquea guardado por campos ausentes)", () => {
  const fnSource = extractFunction("saveEditedInvoice");
  assert.match(fnSource, /const hasExplicitTipFields = Number\.isFinite\(Number\(invoice\.propinaCobrada\)\) && invoice\.propinaCobrada !== undefined;/);
  assert.match(fnSource, /const tipCollectedSoFar = hasExplicitTipFields \? Math\.max\(0, Number\(invoice\.propinaCobrada\) \|\| 0\) : 0;/);
});

test("saveEditedInvoice(): no toca distribucionPropina (la distribucion historica ya financiada nunca se reescribe al editar)", () => {
  const fnSource = extractFunction("saveEditedInvoice");
  assert.ok(!/distribucionPropina/.test(fnSource), "editar una factura no debe tocar la distribucion de propina");
});

// --- 66: cero escrituras en produccion (estructural: toda esta suite corre en memoria) ---

test("66. esta suite no referencia el project ref real de Supabase (todas las pruebas de arriba corren en memoria, sin red)", () => {
  const thisFile = fs.readFileSync(__filename, "utf8");
  const realProjectRef = ["lcqxbhlkqtjlwsedarej"].join("");
  const occurrences = (thisFile.match(new RegExp(realProjectRef, "g")) || []).length;
  assert.strictEqual(occurrences, 1, "solo debe aparecer aqui mismo, dentro de este assert (nunca en un fixture o URL real)");
});
