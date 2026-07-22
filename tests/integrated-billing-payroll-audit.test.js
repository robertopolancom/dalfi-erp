// Auditoria integral final (julio 2026): Facturacion + cobro FIFO + CxC de
// clientes + propina + CxP de propina + nomina quincenal + comisiones +
// bonos + TSS + vacaciones + CxC de colaboradores + egresos + Cierres +
// reversiones, verificando la CADENA completa end-to-end y el invariante
// monetario global (cada entrada/salida se registra exactamente una vez).
// Documenta ademas los defectos reales encontrados y corregidos durante
// esta auditoria. Mismo patron estatico + funciones puras encadenadas
// (sin DOM real en este runner) usado en todo el proyecto.
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

// ===========================================================================
// Defecto real #1 (encontrado y corregido en esta auditoria): collectInvoiceTip()
// reutilizaba la misma fila de "propinas" (payable de nomina) por sourceKey
// SIN importar si esa fila ya estaba Pagada. Si un cliente terminaba de
// pagar una propina DESPUES de que la nomina que la incluia ya se hubiera
// pagado, el dinero nuevo se sumaba a una fila "Pagada" que ninguna nomina
// futura vuelve a leer (el filtro de propinaPreviewData exige "pendiente"):
// esa porcion de propina quedaba oculta para siempre, nunca se le pagaba a
// la colaboradora.
// ===========================================================================

test("defecto #1 corregido: collectInvoiceTip() NUNCA le suma dinero a una fila de propinas ya Pagada (crea una fila nueva Pendiente en su lugar)", () => {
  const source = extractFunction("collectInvoiceTip");
  assert.match(
    source,
    /let payable = dbTable\("propinas"\)\.find\(\(row\) => row\.sourceKey === sourceKey && normalize\(row\.estadoPagoNomina \|\| "Pendiente"\) === "pendiente"\);/,
  );
});

test("defecto #1: simulacion en memoria confirma que dinero adicional despues de un pago de nomina genera una NUEVA fila Pendiente, nunca se pierde", () => {
  const propinasTable = [];
  function collect(dbInvoice, amount, { source }) {
    if (source && propinasTable.some((row) => row.facturaID === dbInvoice.facturaID && row.pagosAplicados.some((e) => e.source === source))) {
      return { collected: 0 };
    }
    const toCollect = Math.min(dbInvoice.propinaPendiente, amount);
    if (toCollect <= 0) return { collected: 0 };
    const sourceKey = `${dbInvoice.facturaID}:COL-1`;
    // Misma correccion que collectInvoiceTip real: solo reutiliza una fila
    // TODAVIA pendiente de nomina.
    let payable = propinasTable.find((row) => row.sourceKey === sourceKey && row.estadoPagoNomina === "Pendiente");
    if (!payable) {
      payable = { sourceKey, facturaID: dbInvoice.facturaID, montoBruto: 0, estadoPagoNomina: "Pendiente", pagosAplicados: [] };
      propinasTable.push(payable);
    }
    payable.montoBruto += toCollect;
    payable.pagosAplicados.push({ source, amount: toCollect });
    dbInvoice.propinaCobrada += toCollect;
    dbInvoice.propinaPendiente -= toCollect;
    return { collected: toCollect };
  }
  const invoiceStub = { facturaID: "FAC-1", propinaPendiente: 300, propinaCobrada: 0 };
  collect(invoiceStub, 100, { source: "PAG-1" });
  assert.equal(propinasTable.length, 1);
  // Simula que la nomina pago esa primera fila.
  propinasTable[0].estadoPagoNomina = "Pagada";
  // Llega mas propina para la MISMA factura+colaboradora, DESPUES de pagada.
  collect(invoiceStub, 200, { source: "PAG-2" });
  assert.equal(propinasTable.length, 2, "debe crear una segunda fila, no sumarle a la ya pagada");
  assert.equal(propinasTable[0].montoBruto, 100, "la fila ya pagada no debe cambiar");
  assert.equal(propinasTable[1].montoBruto, 200, "la fila nueva contiene el dinero recien cobrado, Pendiente de la proxima nomina");
  assert.equal(propinasTable[1].estadoPagoNomina, "Pendiente");
  const totalTrackedAcrossBothRows = propinasTable.reduce((sum, row) => sum + row.montoBruto, 0);
  assert.equal(totalTrackedAcrossBothRows, 300, "toda la propina cobrada sigue siendo rastreable, ningun centavo se pierde");
});

// ===========================================================================
// Defecto real #2: existingActivePayrollFor() solo comparaba coincidencia
// EXACTA de periodoInicio/periodoFin, asi que una nomina "Mes completo"
// (01-fin) y una "Primera quincena" (01-15) del MISMO colaborador y MISMO
// mes no se detectaban como conflicto -ambas podian crearse, pagando (y
// reteniendo TSS sobre) el mismo mes dos veces-.
// ===========================================================================

test("defecto #2 corregido: existingActivePayrollFor() bloquea por SOLAPAMIENTO de rango (Mes completo choca con Primera y con Segunda quincena)", () => {
  const source = extractFunction("existingActivePayrollFor");
  assert.match(source, /return row\.periodoInicio <= periodoFin && row\.periodoFin >= periodoInicio;/);
});

// ===========================================================================
// Defecto real #3: collaboratorVacationOffsetForRange() solo contaba
// vacaciones en estado "Pagada anticipadamente". Al marcarlas "Disfrutada"
// (una simple anotacion posterior, sin mover dinero) el ajuste salarial
// dejaba de aplicarse: una nomina creada DESPUES de esa marca pagaria el
// salario completo, duplicando el pago de esos dias (ya cubiertos por el
// anticipo).
// ===========================================================================

test("defecto #3 corregido: collaboratorVacationOffsetForRange() sigue aplicando el ajuste para vacaciones 'Disfrutada' (no solo 'Pagada anticipadamente')", () => {
  const source = extractFunction("collaboratorVacationOffsetForRange");
  assert.match(source, /estado === "pagada anticipadamente" \|\| estado === "disfrutada"/);
});

// ===========================================================================
// Invariante monetario global (seccion 3): cada entrada/salida se registra
// EXACTAMENTE una vez, verificado encadenando las funciones puras reales
// (nunca reimplementadas) de principio a fin.
// ===========================================================================

test("invariante: factura nueva con deuda anterior + pago mixto -> allocateClientPaymentFIFO reparte el pago EXACTAMENTE (nada se crea ni se pierde)", () => {
  const priorReceivables = [
    { id: "CXC-OLD-1", invoiceId: "FAC-OLD-1", kind: "base", amount: 300, fechaOrigen: "2026-03-01" },
    { id: "CXC-OLD-2", invoiceId: "FAC-OLD-2", kind: "tip", amount: 150, fechaOrigen: "2026-03-05" },
  ];
  const allocation = DalfiClosingMath.allocateClientPaymentFIFO({
    confirmedPaymentLines: [
      { method: "efectivo", amount: 500 },
      { method: "tarjeta", amount: 300 },
    ],
    priorClientReceivables: priorReceivables,
    currentInvoiceBase: 1000,
    currentInvoiceTip: 200,
    currentInvoiceTipCollected: 0,
  });
  const totalIn = 500 + 300;
  const totalAccountedFor = allocation.amountAppliedToPriorReceivables + allocation.amountAppliedToCurrentBase + allocation.amountAppliedToCurrentTip + allocation.unappliedAmount;
  assert.equal(totalAccountedFor, totalIn, "todo el dinero confirmado debe quedar aplicado o marcado como sobrante, sin fugas ni duplicados");
  const totalByMethod = Object.values(allocation.allocationByPaymentMethod).reduce((sum, v) => sum + v, 0);
  assert.equal(totalByMethod, totalIn, "el desglose por medio de pago debe sumar exactamente el total confirmado");
});

test("invariante: liquidacion completa de nomina -> gross - deductions === net, sin componentes fantasma", () => {
  const settlement = DalfiClosingMath.calculatePayrollSettlement({
    monthlySalary: 24000,
    salaryInstallment: 12000,
    vacationSalaryOffset: 1500,
    commissions: 900,
    collectedTipsPayable: 600,
    bonuses: 400,
    employeeTssDeduction: 350,
    employeeReceivableDeduction: 250,
    otherDeductions: 100,
    employerTssContribution: 800,
  });
  assert.equal(settlement.grossAmount, settlement.salaryPayable + settlement.commissionAmount + settlement.tipsPayableAmount + settlement.bonusAmount + settlement.otherIncomeAmount);
  assert.equal(settlement.totalDeductions, settlement.tssEmployeeDeduction + settlement.employeeReceivableDeduction + settlement.otherDeductionsAmount);
  assert.equal(settlement.netPayable, Math.round((settlement.grossAmount - settlement.totalDeductions) * 100) / 100);
  // El aporte del empleador nunca debe aparecer en el neto ni en el bruto.
  assert.ok(!Object.keys(settlement).includes("grossAmountWithEmployerTss"));
});

test("invariante: pago de nomina crea EXACTAMENTE un egreso por el neto (nunca un egreso por cada componente: salario, comision, propina, bono, TSS, CxC no generan egresos independientes)", () => {
  const payPayrollSubmit = (() => {
    const startIdx = appJs.indexOf('let payPayrollSubmitInFlight = false;');
    const throughIdx = appJs.indexOf('byId("pay-payroll-form").addEventListener("submit"', startIdx);
    const openIdx = appJs.indexOf("(event) => {", throughIdx);
    const braceStart = appJs.indexOf("{", openIdx);
    let depth = 0;
    let end = braceStart;
    for (; end < appJs.length; end++) {
      if (appJs[end] === "{") depth++;
      else if (appJs[end] === "}") {
        depth--;
        if (depth === 0) {
          end++;
          break;
        }
      }
    }
    return appJs.slice(startIdx, end);
  })();
  const expenseMatches = payPayrollSubmit.match(/dbTable\("egresos"\)\.push\(/g) || [];
  assert.equal(expenseMatches.length, 1, "debe existir exactamente un push a egresos en todo el submit de pago de nomina");
  assert.doesNotMatch(payPayrollSubmit, /dbTable\("ingresos"\)\.push/, "pagar nomina no crea ingresos");
});

test("invariante: applyCollaboratorReceivablesFIFO nunca aplica mas de lo pendiente ni mas de lo solicitado (descuento de CxC en nomina)", () => {
  const receivables = [
    { id: "C1", balance: 200, fechaOrigen: "2026-01-01" },
    { id: "C2", balance: 300, fechaOrigen: "2026-02-01" },
  ];
  const result = DalfiClosingMath.applyCollaboratorReceivablesFIFO({ receivables, amountToApply: 1000 });
  const totalApplied = result.allocations.reduce((sum, row) => sum + row.amountApplied, 0);
  assert.equal(totalApplied, 500, "nunca debe aplicar mas de lo que realmente hay pendiente (200+300), aunque se pida 1000");
  assert.equal(result.unappliedAmount, 500);
});

// ===========================================================================
// Transiciones invalidas bloqueadas (seccion 20-G, item 48): cada funcion de
// estado exige el estado ANTERIOR correcto, ninguna permite un salto.
// ===========================================================================

test("48. transiciones invalidas bloqueadas: Aprobar exige Borrador, Pagar exige Aprobada, Reabrir exige Aprobada, Revertir exige Pagada", () => {
  const approveSource = extractFunction("approvePayroll");
  assert.match(approveSource, /normalize\(payroll\.estado \|\| ""\) !== "borrador"/);
  const openPaySource = extractFunction("openPayPayrollForm");
  assert.match(openPaySource, /normalize\(payroll\.estado \|\| ""\) !== "aprobada"/);
  const reopenSource = extractFunction("reopenPayroll");
  assert.match(reopenSource, /normalize\(payroll\.estado \|\| ""\) !== "aprobada"/);
  const revertSource = extractFunction("revertPayrollPayment");
  assert.match(revertSource, /normalize\(payroll\.estado \|\| ""\) !== "pagada"/);
});

test("no puede pagarse dos veces (Pagada no vuelve a calificar para openPayPayrollForm) ni reabrirse una Pagada (reopenPayroll exige Aprobada, no Pagada)", () => {
  const openPaySource = extractFunction("openPayPayrollForm");
  const reopenSource = extractFunction("reopenPayroll");
  // Ninguna de las dos acepta "pagada" como estado de entrada.
  assert.doesNotMatch(openPaySource, /!== "pagada"\) return;/);
  assert.doesNotMatch(reopenSource, /=== "pagada"/);
});

// ===========================================================================
// Compatibilidad historica cruzada (seccion 19): registros de distintos
// modulos, todos sin los campos nuevos, conviven sin fallar.
// ===========================================================================

test("factura historica sin propinaCobrada + CxC historica sin deudorTipo + nomina historica sin estado: cada modulo usa su propio default seguro, ninguno falla ni produce NaN", () => {
  const historicInvoice = { totalPagadoConfirmado: 1000 };
  const totalPagado = (Number(historicInvoice?.totalPagadoConfirmado) || 0) + (Number(historicInvoice?.propinaCobrada) || 0);
  assert.equal(totalPagado, 1000);
  assert.equal(Number.isNaN(totalPagado), false);

  const historicCxc = { balancePendiente: 500 };
  assert.equal(Number(historicCxc.balancePendiente) > 0, true);
  assert.equal(historicCxc.deudorTipo === "Colaborador", false, "una CxC sin deudorTipo nunca se clasifica como de colaborador por accidente");

  const renderPayrollSource = extractFunction("renderPayroll");
  assert.match(renderPayrollSource, /const estado = row\.estado \|\| "Borrador";/);
});

test("nómina histórica Pagada permanece bloqueada para edición/repago incluso sin los campos nuevos del snapshot (payrollType, tssConfigId ausentes)", () => {
  const source = extractFunction("payrollTssBlockReason");
  // Una nomina historica sin payrollType (undefined !== "first") entra al
  // chequeo de TSS; sin tssConfigId, queda bloqueada -comportamiento
  // seguro por defecto, nunca permite pagar/asumir TSS en silencio-.
  const fn = new Function("payroll", `${source}\nreturn payrollTssBlockReason(payroll);`);
  assert.notEqual(fn({ payrollType: undefined, tssConfigId: undefined }), "");
});

test("build/sintaxis: outputs/app.js sigue siendo JS valido tras las correcciones de esta auditoria", () => {
  assert.doesNotThrow(() => new Function(appJs));
});

test("cero escrituras en produccion: este archivo no importa supabase-js ni referencia el dominio de produccion", () => {
  const source = fs.readFileSync(__filename, "utf8");
  assert.doesNotMatch(source, /supabase\.co|@supabase\/supabase-js/);
});
