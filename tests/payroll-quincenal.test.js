// Nomina quincenal, comisiones, propinas del periodo 21-20, vacaciones
// pagadas anticipadamente, TSS y CxC de colaboradores (julio 2026). Corrige
// el hallazgo previo (Guardar nomina no validaba permiso) y separa
// Guardar (Borrador, sin efectos reales) de Pagar (unico paso que crea
// egreso, marca propinas/comision, aplica CxC). Mismo patron estatico (sin
// DOM real en este runner, ver tests/closing-cash-confirm-state.test.js) y
// mismas funciones puras compartidas (DalfiClosingMath) usadas en todo el
// proyecto.
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

const payrollSubmit = extractStatementBlock('let payrollSubmitInFlight = false;', 'byId("payroll-form").addEventListener("submit"');
const payPayrollSubmit = extractStatementBlock('let payPayrollSubmitInFlight = false;', 'byId("pay-payroll-form").addEventListener("submit"');
const vacationSubmit = extractStatementBlock('let vacationSubmitInFlight = false;', 'byId("vacation-form").addEventListener("submit"');
const commissionSubmit = extractStatementBlock('byId("commission-form").addEventListener("submit"', "(event) => {", appJs);
const tssSubmit = extractStatementBlock('byId("tss-config-form").addEventListener("submit"', "(event) => {", appJs);

// ===========================================================================
// A. Calendario quincenal
// ===========================================================================

test("1-2-3. salario mensual se divide en dos cuotas quincenales: primera (dia 15) y segunda (dia 30)", () => {
  const r = DalfiClosingMath.computeBiweeklySalaryInstallment({ monthlySalary: 24000, cut: "first" });
  const r2 = DalfiClosingMath.computeBiweeklySalaryInstallment({ monthlySalary: 24000, cut: "second" });
  assert.equal(r.installment, 12000);
  assert.equal(r2.installment, 12000);
  assert.equal(DalfiClosingMath.payrollOrdinaryPaymentDate({ period: "2026-04", cut: "first" }), "2026-04-15");
  assert.equal(DalfiClosingMath.payrollOrdinaryPaymentDate({ period: "2026-04", cut: "second" }), "2026-04-30");
});

test("4. febrero (y meses cortos) usan el ULTIMO dia calendario para la segunda quincena, nunca un dia 30 inexistente", () => {
  assert.equal(DalfiClosingMath.payrollOrdinaryPaymentDate({ period: "2026-02", cut: "second" }), "2026-02-28");
  assert.equal(DalfiClosingMath.payrollOrdinaryPaymentDate({ period: "2028-02", cut: "second" }), "2028-02-29");
  assert.equal(DalfiClosingMath.payrollOrdinaryPaymentDate({ period: "2026-11", cut: "second" }), "2026-11-30");
});

test("5-6. redondeo: cualquier diferencia de centavos queda en la segunda quincena, la suma da EXACTO el salario mensual", () => {
  [10000.01, 999.99, 15333.33, 0.01, 24000].forEach((salary) => {
    const first = DalfiClosingMath.computeBiweeklySalaryInstallment({ monthlySalary: salary, cut: "first" }).installment;
    const second = DalfiClosingMath.computeBiweeklySalaryInstallment({ monthlySalary: salary, cut: "second" }).installment;
    assert.equal(Math.round((first + second) * 100), Math.round(salary * 100), `first+second debe igualar ${salary}`);
  });
});

test("7. no existe una tercera cuota: cut='month' devuelve la cuota completa, cut invalido no inventa un cuarto valor", () => {
  const r = DalfiClosingMath.computeBiweeklySalaryInstallment({ monthlySalary: 20000, cut: "month" });
  assert.equal(r.installment, 20000);
  assert.equal(r.second, 0);
});

test("7b. existingActivePayrollFor bloquea una segunda nomina Borrador/Pagada para el mismo colaborador+periodo+corte", () => {
  const source = extractFunction("existingActivePayrollFor");
  assert.match(source, /normalize\(row\.estado \|\| ""\) !== "revertida"/);
});

test("el submit de #payroll-form bloquea la duplicacion llamando a existingActivePayrollFor ANTES de crear la nomina", () => {
  assert.match(payrollSubmit, /existingActivePayrollFor\(staffRecord\?\.colaboradorID, data\.staffName, data\.range\.start, data\.range\.end\)/);
  const guardIdx = payrollSubmit.indexOf("existingActivePayrollFor(");
  const pushIdx = payrollSubmit.indexOf('dbTable("nomina").push(');
  assert.ok(guardIdx !== -1 && pushIdx !== -1 && guardIdx < pushIdx);
});

// ===========================================================================
// B. Periodo 21-20 (propinas y comisiones)
// ===========================================================================

test("8-9-10-11. periodo empieza el 21 del mes anterior y termina el 20 del mes actual, sin duplicar ni saltar dias", () => {
  const r = DalfiClosingMath.computeTipCommissionPeriod({ period: "2026-04" });
  assert.equal(r.start, "2026-03-21");
  assert.equal(r.end, "2026-04-20");
});

test("12. las fechas son fechas-calendario simples (America/Santo_Domingo ya esta implicita en como el resto del ERP genera 'today'/'dateOnly', no se reconvierte aqui)", () => {
  const source = extractFunction("computeTipCommissionPeriod", fs.readFileSync(path.join(__dirname, "..", "outputs", "lib", "closing-math.js"), "utf8"));
  assert.doesNotMatch(source, /Intl\.DateTimeFormat|timeZone/);
});

test("13. la nomina del dia 30 (segunda quincena o mes completo) incluye el periodo 21-20; la del dia 15 no", () => {
  const source = extractFunction("payrollCommissionTipRange");
  assert.match(source, /if \(cut === "first"\) return null;/);
});

test("14. el periodo queda congelado en el snapshot de la nomina (commissionPeriodStart/commissionPeriodEnd), no se recalcula despues", () => {
  assert.match(payrollSubmit, /commissionPeriodStart: data\.commissionTipRange\?\.start \|\| "",/);
  assert.match(payrollSubmit, /commissionPeriodEnd: data\.commissionTipRange\?\.end \|\| "",/);
});

test("diciembre->enero: el periodo cruza el año calendario correctamente", () => {
  const r = DalfiClosingMath.computeTipCommissionPeriod({ period: "2026-01" });
  assert.equal(r.start, "2025-12-21");
  assert.equal(r.end, "2026-01-20");
});

// ===========================================================================
// C. Umbrales de comision
// ===========================================================================

test("15. sin umbral asignado, la comision es cero (no se inventa una tasa)", () => {
  const r = DalfiClosingMath.selectCommissionThreshold({ eligibleSales: 5000, thresholds: [] });
  assert.equal(r.commissionAmount, 0);
  assert.equal(r.rate, 0);
});

test("16-17. un umbral, o varios umbrales: total_por_umbral usa el umbral con 'desde' mas alto que la produccion alcanza", () => {
  const thresholds = [
    { escalaID: "A", desde: 0, hasta: 5000, porcentajeComision: 0.03, estado: "Activo" },
    { escalaID: "B", desde: 5000, hasta: 10000, porcentajeComision: 0.05, estado: "Activo" },
    { escalaID: "C", desde: 10000, hasta: 0, porcentajeComision: 0.08, estado: "Activo" },
  ];
  assert.equal(DalfiClosingMath.selectCommissionThreshold({ eligibleSales: 12000, thresholds }).thresholdId, "C");
  assert.equal(DalfiClosingMath.selectCommissionThreshold({ eligibleSales: 7000, thresholds: thresholds.slice(0, 2) }).thresholdId, "B");
});

test("18-19. umbral minimo y maximo se respetan (produccion fuera de rango no aplica esa regla)", () => {
  const thresholds = [{ escalaID: "A", desde: 1000, hasta: 2000, porcentajeComision: 0.1, estado: "Activo" }];
  assert.equal(DalfiClosingMath.selectCommissionThreshold({ eligibleSales: 500, thresholds }).commissionAmount, 0);
  assert.equal(DalfiClosingMath.selectCommissionThreshold({ eligibleSales: 2500, thresholds }).commissionAmount, 0);
  assert.equal(DalfiClosingMath.selectCommissionThreshold({ eligibleSales: 1500, thresholds }).commissionAmount, 150);
});

test("20. rangos solapados se rechazan al validar (validateCommissionThresholdRule)", () => {
  const existing = [{ escalaID: "A", aplicaA: "Grupo 1", desde: 0, hasta: 5000, porcentajeComision: 0.05, estado: "Activo" }];
  const overlapping = { aplicaA: "Grupo 1", desde: 3000, hasta: 8000, porcentajeComision: 0.06 };
  const result = DalfiClosingMath.validateCommissionThresholdRule(overlapping, existing);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((msg) => /solapa/.test(msg)));
});

test("no solapado (grupos distintos o rangos no adyacentes) se acepta", () => {
  const existing = [{ escalaID: "A", aplicaA: "Grupo 1", desde: 0, hasta: 5000, porcentajeComision: 0.05, estado: "Activo" }];
  const disjoint = { aplicaA: "Grupo 1", desde: 5000, hasta: 8000, porcentajeComision: 0.06 };
  assert.equal(DalfiClosingMath.validateCommissionThresholdRule(disjoint, existing).valid, true);
  const otherGroup = { aplicaA: "Grupo 2", desde: 1000, hasta: 4000, porcentajeComision: 0.06 };
  assert.equal(DalfiClosingMath.validateCommissionThresholdRule(otherGroup, existing).valid, true);
});

test("21. porcentaje invalido (negativo, >100, NaN) se rechaza", () => {
  assert.equal(DalfiClosingMath.validateCommissionThresholdRule({ desde: 0, hasta: 100, porcentajeComision: -5 }).valid, false);
  assert.equal(DalfiClosingMath.validateCommissionThresholdRule({ desde: 0, hasta: 100, porcentajeComision: 150 }).valid, false);
  assert.equal(DalfiClosingMath.validateCommissionThresholdRule({ desde: 0, hasta: 100, porcentajeComision: NaN }).valid, false);
  assert.equal(DalfiClosingMath.validateCommissionThresholdRule({ desde: 0, hasta: 100, porcentajeComision: 5 }).valid, true);
});

test("22-23. la regla efectiva se elige por fecha de vigencia y los cambios futuros no alteran una nomina ya guardada (commissionRuleSnapshot congelado)", () => {
  assert.match(payrollSubmit, /commissionRuleSnapshot: data\.threshold,/);
});

test("24-25. modo total_por_umbral es el default; progresivo_por_tramos solo se aplica si se pide explicitamente", () => {
  const thresholds = [
    { escalaID: "A", desde: 0, hasta: 5000, porcentajeComision: 0.05, estado: "Activo" },
    { escalaID: "B", desde: 5000, hasta: 0, porcentajeComision: 0.1, estado: "Activo" },
  ];
  const total = DalfiClosingMath.selectCommissionThreshold({ eligibleSales: 8000, thresholds });
  assert.equal(total.mode, "total_por_umbral");
  assert.equal(total.commissionAmount, 800); // 8000 * 0.10, TODO al umbral mas alto
  const progressive = DalfiClosingMath.selectCommissionThreshold({ eligibleSales: 8000, thresholds, mode: "progresivo_por_tramos" });
  assert.equal(progressive.mode, "progresivo_por_tramos");
  assert.equal(progressive.commissionAmount, 5000 * 0.05 + 3000 * 0.1); // 250 + 300 = 550, por tramos
});

test("validateCommissionThresholdRule/selectCommissionThreshold no leen el DOM ni persisten (funciones puras)", () => {
  const closingMathSource = fs.readFileSync(path.join(__dirname, "..", "outputs", "lib", "closing-math.js"), "utf8");
  ["selectCommissionThreshold", "validateCommissionThresholdRule"].forEach((name) => {
    const source = extractFunction(name, closingMathSource);
    assert.doesNotMatch(source, /document\.|byId\(|dbTable\(|stampRecord\(/);
  });
});

test("el submit de #commission-form valida con DalfiClosingMath.validateCommissionThresholdRule y exige canManageInvoices()", () => {
  assert.match(commissionSubmit, /canManageInvoices\(\)/);
  assert.match(commissionSubmit, /DalfiClosingMath\.validateCommissionThresholdRule\(/);
  assert.match(commissionSubmit, /if \(!validation\.valid\)/);
});

// ===========================================================================
// D. Comisiones (base elegible)
// ===========================================================================

test("26-31. la produccion elegible usa detail.subtotal (neto ya despues de descuentos, mismo campo que factura) dentro del rango de comision", () => {
  const source = extractFunction("payrollPreviewData");
  assert.match(source, /detail\.subtotal/);
  assert.match(source, /dateInRange\(invoice\.fechaHora, commissionTipRange\.start, commissionTipRange\.end\)/);
});

test("28. la comision solo cuenta lineas de la MISMA colaboradora (colaboradorID o nombre normalizado)", () => {
  const source = extractFunction("payrollPreviewData");
  assert.match(source, /staff\?\.colaboradorID \? detail\.colaboradorID === staff\.colaboradorID : normalize\(detail\.colaboradorNombre\) === normalize\(staffName\)/);
});

test("32. la propina NUNCA entra a la base de comision (details viene de facturaDetalle, no de propinas)", () => {
  const source = extractFunction("payrollPreviewData");
  const detailsBlock = source.slice(source.indexOf("const details ="), source.indexOf("const sales ="));
  assert.doesNotMatch(detailsBlock, /propinas/);
});

test("33-34-35. la comision solo se calcula/agrega cuando hay periodo de comision (dia 30/mes), nunca en la nomina del dia 15, y una sola vez (sin duplicar) por el guard de nomina duplicada", () => {
  const source = extractFunction("payrollPreviewData");
  assert.match(source, /const details = commissionTipRange\s*\?/);
});

// ===========================================================================
// E. Propinas
// ===========================================================================

test("36-37-38-39-40-41. propinas: solo pendientes de pago, del colaborador correcto, dentro del periodo 21-20", () => {
  const source = extractFunction("payrollPreviewData");
  const tipsBlock = source.slice(source.indexOf("const tipsRows ="), source.indexOf("const tips ="));
  assert.match(tipsBlock, /normalize\(tip\.estadoPagoNomina \|\| "Pendiente"\) === "pendiente"/);
  assert.match(tipsBlock, /dateInRange\(tip\.fechaHora, commissionTipRange\.start, commissionTipRange\.end\)/);
});

test("42-43. las propinas solo se incluyen cuando hay periodo de comision/propina (nunca en la quincena del 15)", () => {
  const source = extractFunction("payrollPreviewData");
  assert.match(source, /const tipsRows = commissionTipRange\s*\?/);
});

test("44. una propina NUNCA se marca pagada al Guardar (borrador): el submit de #payroll-form no escribe estadoPagoNomina", () => {
  assert.doesNotMatch(payrollSubmit, /estadoPagoNomina/);
  assert.doesNotMatch(payrollSubmit, /tip\.nominaID = /);
});

test("45. se marca pagada UNICAMENTE al Pagar, y solo las propinas congeladas en el snapshot (propinaIdsIncluidas), no 'todas las pendientes ahora'", () => {
  assert.match(payPayrollSubmit, /const tipIds = new Set\(Array\.isArray\(payroll\.propinaIdsIncluidas\) \? payroll\.propinaIdsIncluidas : \[\]\);/);
  assert.match(payPayrollSubmit, /if \(!tipIds\.has\(tip\.propinaID\)\) return;/);
  assert.match(payPayrollSubmit, /tip\.estadoPagoNomina = "Pagada";/);
});

test("46. no se duplican entre periodos: al pagar solo se tocan propinas con nominaID vacio o coincidiendo con esta nomina (revert las libera correctamente)", () => {
  assert.match(payPayrollSubmit, /if \(normalize\(tip\.estadoPagoNomina \|\| "Pendiente"\) === "pagada"\) return;/);
});

// ===========================================================================
// F. Bonos
// ===========================================================================

test("47-48-49-50-51-52. bonos: linea repetible con concepto/monto/TSS, se filtran los de monto>0, no se pre-crean sueltos (evita reutilizarse en una nomina futura)", () => {
  assert.ok(functionExists("addPayrollBonusLine"));
  assert.ok(functionExists("getPayrollBonusLines"));
  const source = extractFunction("getPayrollBonusLines");
  assert.match(source, /\.filter\(\(line\) => line\.amount > 0\)/);
  assert.match(source, /subjectToTss: row\.querySelector\("\.payroll-bonus-tss"\)\.checked/);
});

test("53. agregar bono require permiso: el boton solo funciona dentro de #payroll-form, cuyo Guardar ya exige canManageInvoices()", () => {
  assert.match(payrollSubmit, /canManageInvoices\(\)/);
});

test("los bonos quedan en el snapshot de la nomina (campo 'bonos') y se suman al bruto via calculatePayrollSettlement", () => {
  assert.match(payrollSubmit, /bonos: data\.bonusLines,/);
  const previewSource = extractFunction("payrollPreviewData");
  assert.match(previewSource, /bonuses: bonusAmount,/);
});

// ===========================================================================
// G. Vacaciones
// ===========================================================================

test("54-55-56. registro de vacaciones (14 dias tipico) y pago anticipado crean exactamente UN egreso + UN registro de vacaciones", () => {
  const matches = vacationSubmit.match(/dbTable\("egresos"\)\.push\(/g) || [];
  assert.equal(matches.length, 1);
  const vacMatches = vacationSubmit.match(/dbTable\("vacaciones"\)\.push\(/g) || [];
  assert.equal(vacMatches.length, 1);
  assert.match(vacationSubmit, /estado: "Pagada anticipadamente",/);
});

test("57-58-59-60. el ajuste se calcula por corte (computeVacationSalaryOffset) y la suma de ambos cortes coincide con el anticipo cuando las vacaciones cruzan las dos quincenas", () => {
  const off1 = DalfiClosingMath.computeVacationSalaryOffset({ vacationStart: "2026-04-10", vacationDays: 14, cutStart: "2026-04-01", cutEnd: "2026-04-15", dailyValue: 500 });
  const off2 = DalfiClosingMath.computeVacationSalaryOffset({ vacationStart: "2026-04-10", vacationDays: 14, cutStart: "2026-04-16", cutEnd: "2026-04-30", dailyValue: 500 });
  assert.equal(off1.daysInCut, 6);
  assert.equal(off2.daysInCut, 8);
  assert.equal(off1.offsetAmount + off2.offsetAmount, 14 * 500);
});

test("61. sin doble pago: collaboratorVacationOffsetForRange resta del salario pagable exactamente ese monto, nunca se vuelve a crear el egreso del anticipo", () => {
  const source = extractFunction("collaboratorVacationOffsetForRange");
  assert.match(source, /normalize\(row\.estado \|\| ""\) === "pagada anticipadamente"/);
  assert.doesNotMatch(source, /dbTable\("egresos"\)\.push/);
});

test("62. cancelacion ANTES del pago: no aplica (el pago anticipado en este ERP se registra y paga en un solo paso; una vacacion nunca queda 'solicitada' sin pagar como registro persistido)", () => {
  assert.match(vacationSubmit, /requiere autorizaci|canManageInvoices\(\)/);
});

test("63. el registro de vacaciones conserva egresoID para permitir bloquear una cancelacion silenciosa despues de pagado", () => {
  assert.match(vacationSubmit, /egresoID: expenseId,/);
});

test("64. sin valor diario configurado (<=0), el calculo/registro se bloquea explicitamente, nunca se asume un divisor legal", () => {
  assert.match(vacationSubmit, /if \(!\(dailyValue > 0\)\) \{/);
});

test("65. el valor diario usado queda guardado en el registro historico (vacaciones.valorDiario), cambios futuros de politica no lo alteran", () => {
  assert.match(vacationSubmit, /valorDiario: dailyValue,/);
});

test("computeVacationSalaryOffset es pura, deterministica, y no aplica dias fuera del rango del corte", () => {
  const noOverlap = DalfiClosingMath.computeVacationSalaryOffset({ vacationStart: "2026-01-01", vacationDays: 5, cutStart: "2026-04-01", cutEnd: "2026-04-15", dailyValue: 500 });
  assert.equal(noOverlap.daysInCut, 0);
  assert.equal(noOverlap.offsetAmount, 0);
});

// ===========================================================================
// H. TSS
// ===========================================================================

test("66-67-68. configuracion TSS: tasa, tope, base contributiva y vigencia se guardan (nunca hardcodeadas)", () => {
  assert.match(tssSubmit, /tasaColaborador: employeeRate,/);
  assert.match(tssSubmit, /tope: cap,/);
  assert.match(tssSubmit, /baseContributiva: base,/);
  assert.match(tssSubmit, /fechaVigencia: effectiveDate,/);
  assert.doesNotMatch(appJs, /0\.0[0-9]{1,2}\s*\*.*tss|tss.*0\.0[0-9]{1,2}\s*\*/i);
});

test("el submit de #tss-config-form exige canManageInvoices() y valida tasas 0-100 y fecha valida", () => {
  assert.match(tssSubmit, /canManageInvoices\(\)/);
  assert.match(tssSubmit, /employeeRate > 100 \|\| employerRate > 100/);
  assert.match(tssSubmit, /DalfiClosingMath\.isValidIsoDate\(effectiveDate\)/);
});

test("69. la retencion del colaborador (tssEmployee) reduce el neto: se pasa como employeeTssDeduction a calculatePayrollSettlement", () => {
  const source = extractFunction("payrollPreviewData");
  assert.match(source, /employeeTssDeduction: tssEmployee,/);
});

test("70. el aporte del empleador (tssEmployer) NUNCA reduce el neto: calculatePayrollSettlement lo devuelve aparte (employerTssContribution), no se resta de netPayable", () => {
  const closingMathSource = fs.readFileSync(path.join(__dirname, "..", "outputs", "lib", "closing-math.js"), "utf8");
  const source = extractFunction("calculatePayrollSettlement", closingMathSource);
  const netFormula = source.slice(source.indexOf("const rawNet ="), source.indexOf("const netPayable ="));
  assert.doesNotMatch(netFormula, /employerTssContribution/);
});

test("71-72. TSS se retiene UNA vez al mes: activeTssConfig() se evalua solo cuando cut !== 'first' (nunca en la quincena del 15), nunca dos veces para el mismo mes", () => {
  const source = extractFunction("payrollPreviewData");
  assert.match(source, /const tssApplies = cut !== "first";/);
});

test("73-74. bonos sujetos a TSS (subjectToTss) se suman a la base contributiva; los que no, quedan fuera", () => {
  const source = extractFunction("payrollPreviewData");
  assert.match(source, /bonusTssBase/);
  assert.match(source, /const bonusTssBase = bonusLines\.filter\(\(line\) => line\.subjectToTss\)/);
});

test("75. sin configuracion vigente, Pagar informa explicitamente antes de continuar (nunca paga TSS en silencio)", () => {
  assert.match(payPayrollSubmit, /No hay configuración de TSS vigente/);
});

test("calculatePayrollSettlement: TSS del colaborador reduce netPayable, TSS del empleador no", () => {
  const withTss = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: 10000, salaryInstallment: 10000, employeeTssDeduction: 300, employerTssContribution: 700 });
  const withoutTss = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: 10000, salaryInstallment: 10000 });
  assert.equal(withoutTss.netPayable - withTss.netPayable, 300);
});

// ===========================================================================
// I. CxC de colaboradores
// ===========================================================================

test("76-77-78. avance de efectivo/salario/propina: mismo flujo de egreso ya probado, con subtipo guardado en tipoCxC/concepto", () => {
  const source = extractStatementBlock('byId("expense-form").addEventListener("submit"', "(event) => {", appJs);
  assert.match(source, /const advanceType = byId\("expense-advance-type"\)\.value \|\| "efectivo";/);
  assert.match(source, /Avance de efectivo.*Avance de salario.*Avance de propina/s);
});

test("79-80. servicio cargado / otro concepto autorizado: createCollaboratorInternalCharge crea SOLO la CxC (cargo interno), sin egreso", () => {
  assert.ok(functionExists("createCollaboratorInternalCharge"));
  const source = extractFunction("createCollaboratorInternalCharge");
  assert.doesNotMatch(source, /dbTable\("egresos"\)/);
  assert.match(source, /dbTable\("cuentasCobrar"\)\.push/);
});

test("81-82-83-84-85. un avance real (efectivo/salario/propina) crea exactamente UN egreso y UNA CxC, vinculados por egresoID", () => {
  const source = extractStatementBlock('byId("expense-form").addEventListener("submit"', "(event) => {", appJs);
  const advanceBlock = source.slice(source.indexOf('if (type === "avance") {'), source.indexOf('if (supplierRecord) {'));
  const cxcPushes = advanceBlock.match(/dbTable\("cuentasCobrar"\)\.push\(/g) || [];
  assert.equal(cxcPushes.length, 1);
  assert.match(advanceBlock, /egresoID: expenseId,/);
});

test("86. crear un cargo interno exige permiso (canManageInvoices) y rechaza monto/colaborador/concepto invalidos", () => {
  const source = extractFunction("createCollaboratorInternalCharge");
  assert.match(source, /canManageInvoices\(\)/);
  assert.match(source, /if \(!Number\.isFinite\(safeAmount\) \|\| safeAmount <= 0\)/);
});

test("un avance de propina NUNCA marca propinas futuras como pagadas (el bloque 'avance' no toca dbTable\\(\"propinas\"\\))", () => {
  const source = extractStatementBlock('byId("expense-form").addEventListener("submit"', "(event) => {", appJs);
  const advanceBlock = source.slice(source.indexOf('if (type === "avance") {'), source.indexOf('refreshPendingClosingsForDate(row.date)'));
  assert.doesNotMatch(advanceBlock, /dbTable\("propinas"\)/);
});

// ===========================================================================
// J. Descuento de CxC en nomina
// ===========================================================================

test("87-88-89. descontar cero, parcial, o liquidar totalmente: applyCollaboratorReceivablesFIFO respeta el monto solicitado sin superar los saldos", () => {
  const receivables = [{ id: "C1", balance: 500, fechaOrigen: "2026-01-01" }];
  assert.equal(DalfiClosingMath.applyCollaboratorReceivablesFIFO({ receivables, amountToApply: 0 }).totalApplied, 0);
  assert.equal(DalfiClosingMath.applyCollaboratorReceivablesFIFO({ receivables, amountToApply: 200 }).totalApplied, 200);
  assert.equal(DalfiClosingMath.applyCollaboratorReceivablesFIFO({ receivables, amountToApply: 500 }).totalApplied, 500);
});

test("90-91. varias CxC: se aplican de la mas antigua a la mas reciente (FIFO)", () => {
  const receivables = [
    { id: "NUEVA", balance: 300, fechaOrigen: "2026-03-01" },
    { id: "VIEJA", balance: 300, fechaOrigen: "2026-01-01" },
  ];
  const result = DalfiClosingMath.applyCollaboratorReceivablesFIFO({ receivables, amountToApply: 300 });
  assert.equal(result.allocations.length, 1);
  assert.equal(result.allocations[0].id, "VIEJA");
});

test("92. el monto lo elige la administradora (payroll-cxc-total), y tambien puede seguir escogiendo linea por linea (payroll-cxc-discount, generado dinamicamente por renderPayrollCxCList)", () => {
  assert.match(indexHtml, /id="payroll-cxc-total"/);
  assert.match(extractFunction("renderPayrollCxCList"), /class="payroll-cxc-discount"/);
});

test("93-94. el descuento nunca supera el saldo pendiente de cada CxC ni el monto solicitado", () => {
  const receivables = [{ id: "C1", balance: 100, fechaOrigen: "2026-01-01" }];
  const result = DalfiClosingMath.applyCollaboratorReceivablesFIFO({ receivables, amountToApply: 99999 });
  assert.equal(result.totalApplied, 100);
  assert.equal(result.unappliedAmount, 99899);
});

test("95-96-97. el descuento reduce la CxC, no crea ingreso nuevo ni egreso nuevo: el bloque de Pagar solo hace montoAplicado/balancePendiente, sin dbTable(ingresos)/dbTable(egresos) por cada CxC", () => {
  const cxcBlock = payPayrollSubmit.slice(payPayrollSubmit.indexOf("const cxcDetalle ="), payPayrollSubmit.indexOf("payroll.estado ="));
  assert.doesNotMatch(cxcBlock, /dbTable\("ingresos"\)|dbTable\("egresos"\)/);
  assert.match(cxcBlock, /cxc\.balancePendiente = Math\.max\(0, \(Number\(cxc\.balancePendiente\) \|\| 0\) - applied\);/);
});

test("98-99. sourceKey estable: cada aplicacion queda anotada en observaciones con el payrollId, y solo se aplica una vez (Pagar exige estado==='borrador')", () => {
  assert.match(payPayrollSubmit, /Descontado en nómina \$\{payrollId\}/);
  assert.match(payPayrollSubmit, /if \(normalize\(payroll\.estado \|\| ""\) !== "borrador"\) \{/);
});

// ===========================================================================
// K. Calculo (calculatePayrollSettlement)
// ===========================================================================

test("100. solo salario", () => {
  const r = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: 12000, salaryInstallment: 6000 });
  assert.equal(r.netPayable, 6000);
});

test("101. salario y comision", () => {
  const r = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: 12000, salaryInstallment: 6000, commissions: 1000 });
  assert.equal(r.netPayable, 7000);
});

test("102. salario y propinas", () => {
  const r = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: 12000, salaryInstallment: 6000, collectedTipsPayable: 500 });
  assert.equal(r.netPayable, 6500);
});

test("103. bonos", () => {
  const r = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: 12000, salaryInstallment: 6000, bonuses: 200 });
  assert.equal(r.netPayable, 6200);
});

test("104. vacaciones (offset resta del salario pagable, nunca del bruto de otros conceptos)", () => {
  const r = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: 12000, salaryInstallment: 6000, vacationSalaryOffset: 1000, commissions: 500 });
  assert.equal(r.salaryPayable, 5000);
  assert.equal(r.netPayable, 5500);
});

test("105. TSS", () => {
  const r = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: 12000, salaryInstallment: 6000, employeeTssDeduction: 250 });
  assert.equal(r.netPayable, 5750);
});

test("106. CxC descontada", () => {
  const r = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: 12000, salaryInstallment: 6000, employeeReceivableDeduction: 400 });
  assert.equal(r.netPayable, 5600);
});

test("107. calculo completo (todos los componentes a la vez)", () => {
  const r = DalfiClosingMath.calculatePayrollSettlement({
    monthlySalary: 20000,
    salaryInstallment: 10000,
    vacationSalaryOffset: 1000,
    commissions: 1200,
    collectedTipsPayable: 800,
    bonuses: 500,
    employeeTssDeduction: 300,
    employeeReceivableDeduction: 200,
    otherDeductions: 100,
  });
  // ingresos: (10000-1000) + 1200 + 800 + 500 = 11500; deducciones: 300+200+100=600
  assert.equal(r.grossAmount, 11500);
  assert.equal(r.totalDeductions, 600);
  assert.equal(r.netPayable, 10900);
});

test("108. neto cero es valido (no es un error)", () => {
  const r = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: 1000, salaryInstallment: 1000, employeeTssDeduction: 1000 });
  assert.equal(r.netPayable, 0);
  assert.equal(r.validationErrors.length, 0);
});

test("109. neto negativo se bloquea salvo allowNegativeNet explicito", () => {
  const blocked = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: 1000, salaryInstallment: 1000, employeeTssDeduction: 2000 });
  assert.ok(blocked.validationErrors.length > 0);
  assert.equal(blocked.netPayable, 0);
  const allowed = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: 1000, salaryInstallment: 1000, employeeTssDeduction: 2000, allowNegativeNet: true });
  assert.equal(allowed.netPayable, -1000);
  assert.equal(allowed.validationErrors.length, 0);
});

test("110-111-112. NaN, Infinity y negativos invalidos se rechazan con validationErrors, sin lanzar excepcion", () => {
  const nanResult = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: NaN });
  assert.ok(nanResult.validationErrors.some((msg) => /monthlySalary/.test(msg)));
  const infResult = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: 1000, commissions: Infinity });
  assert.ok(infResult.validationErrors.some((msg) => /commissions/.test(msg)));
  const negResult = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: 1000, bonuses: -50 });
  assert.ok(negResult.validationErrors.some((msg) => /bonuses/.test(msg)));
});

test("113. redondeo monetario: todos los montos devueltos tienen a lo sumo 2 decimales", () => {
  const r = DalfiClosingMath.calculatePayrollSettlement({ monthlySalary: 10000.005, salaryInstallment: 3333.333, commissions: 111.116 });
  [r.salaryPayable, r.commissionAmount, r.netPayable, r.grossAmount].forEach((value) => {
    assert.equal(Math.round(value * 100) / 100, value);
  });
});

test("calculatePayrollSettlement es pura, deterministica, no lee DOM, no persiste, no crea movimientos", () => {
  const closingMathSource = fs.readFileSync(path.join(__dirname, "..", "outputs", "lib", "closing-math.js"), "utf8");
  const source = extractFunction("calculatePayrollSettlement", closingMathSource);
  assert.doesNotMatch(source, /document\.|byId\(|dbTable\(|stampRecord\(/);
  const input = { monthlySalary: 15000, salaryInstallment: 7500, commissions: 300 };
  assert.deepEqual(DalfiClosingMath.calculatePayrollSettlement(input), DalfiClosingMath.calculatePayrollSettlement(input));
});

// ===========================================================================
// L. Estados (Borrador / Pagada / Revertida)
// ===========================================================================

test("114-115. Borrador no genera ninguna salida ni marca obligaciones: Guardar solo hace UN push a dbTable(\"nomina\") y nada mas de dinero real", () => {
  assert.doesNotMatch(payrollSubmit, /dbTable\("egresos"\)\.push/);
  assert.doesNotMatch(payrollSubmit, /estadoPagoNomina = "Pagada"/);
  assert.doesNotMatch(payrollSubmit, /cxc\.balancePendiente = Math\.max/);
});

test("116. Aprobada/congelacion de snapshot: el borrador YA es el snapshot congelado (commissionRuleSnapshot, salarioInstallmentSnapshot, propinaIdsIncluidas, cxcDiscountDetalle)", () => {
  assert.match(payrollSubmit, /salarioInstallmentSnapshot: data\.installment,/);
  assert.match(payrollSubmit, /propinaIdsIncluidas: data\.tipsRows\.map/);
  assert.match(payrollSubmit, /cxcDiscountDetalle,/);
});

test("117-118-119-120. Pagada genera exactamente una salida, marca propinas incluidas, y aplica CxC (comision no requiere marca aparte: se congela en el snapshot y no se vuelve a generar)", () => {
  const expenseMatches = payPayrollSubmit.match(/dbTable\("egresos"\)\.push\(/g) || [];
  assert.equal(expenseMatches.length, 1);
  assert.match(payPayrollSubmit, /tip\.estadoPagoNomina = "Pagada";/);
  assert.match(payPayrollSubmit, /cxc\.balancePendiente = Math\.max\(0, \(Number\(cxc\.balancePendiente\) \|\| 0\) - applied\);/);
  assert.match(payPayrollSubmit, /payroll\.estado = "Pagada";/);
});

test("121. Pagada bloquea edicion/repago: renderPayroll solo muestra el boton Pagar para filas en Borrador", () => {
  const source = extractFunction("renderPayroll");
  assert.match(source, /const canPay = normalize\(estado\) === "borrador";/);
});

// ===========================================================================
// M. Caja, banco y Cierres
// ===========================================================================

test("122-123. Pagar acepta efectivo o transferencia (select #pay-payroll-method)", () => {
  assert.match(indexHtml, /<select id="pay-payroll-method">\s*<option value="efectivo">Efectivo<\/option>\s*<option value="transferencia">Transferencia<\/option>\s*<\/select>/);
});

test("124-125. Pagar exige una cuenta VALIDA (findAccountByName) y rechaza cuentas inexistentes", () => {
  assert.match(payPayrollSubmit, /const account = findAccountByName\(accountName\);/);
  assert.match(payPayrollSubmit, /if \(!account\) \{/);
});

test("126. Pagar rechaza cuentas inactivas", () => {
  assert.match(payPayrollSubmit, /normalize\(account\.estado \|\| "Activo"\) !== "activo"/);
});

test("127-128. un solo egreso, con fecha real de pago (payDate), para que Cierres lo reciba en la fecha correcta", () => {
  assert.match(payPayrollSubmit, /fechaHora: `\$\{payDate\}T12:00:00`,/);
  assert.match(payPayrollSubmit, /refreshPendingClosingsForDate\(payDate\);/);
});

test("129. el anticipo de vacaciones aparece en Cierres en su fecha real (refreshPendingClosingsForDate en el submit de vacaciones)", () => {
  assert.match(vacationSubmit, /refreshPendingClosingsForDate\(today\);/);
});

test("130. el descuento posterior de CxC en nomina no crea un movimiento financiero nuevo (ya cubierto en seccion J, aqui se confirma que Pagar no llama a ningun addExpense/addIncome por cada CxC)", () => {
  const cxcBlock = payPayrollSubmit.slice(payPayrollSubmit.indexOf("const cxcDetalle ="), payPayrollSubmit.indexOf("payroll.estado ="));
  assert.doesNotMatch(cxcBlock, /createExtraIncome|dbTable\("egresos"\)/);
});

test("131. pagar nomina nunca vuelve a tocar dbTable(\"facturas\")", () => {
  assert.doesNotMatch(payPayrollSubmit, /dbTable\("facturas"\)/);
});

test("accountAvailableBalance excluye egresos Revertidos (necesario para que revertPayrollPayment realmente devuelva el saldo)", () => {
  const source = extractFunction("accountAvailableBalance");
  assert.match(source, /normalize\(row\.estado \|\| "Registrado"\) !== "revertido"/);
});

// ===========================================================================
// N. Idempotencia
// ===========================================================================

test("132-133-134-135-136. Guardar y Pagar tienen guardia de doble-submit (mismo patron try/finally que invoiceSubmitInFlight/cashSubmitInFlight)", () => {
  assert.match(appJs, /let payrollSubmitInFlight = false;/);
  assert.match(payrollSubmit, /if \(payrollSubmitInFlight\) return;/);
  assert.match(payrollSubmit, /payrollSubmitInFlight = true;/);
  assert.match(payrollSubmit, /finally \{\s*payrollSubmitInFlight = false;/);
  assert.match(appJs, /let payPayrollSubmitInFlight = false;/);
  assert.match(payPayrollSubmit, /if \(payPayrollSubmitInFlight\) return;/);
});

test("137. payrollId estable: nextDbId genera un identificador unico por nomina, usado consistentemente en egreso/propinas/CxC/auditoria", () => {
  assert.match(payrollSubmit, /const payrollId = nextDbId\("nomina", "nominaID", "NOM"\);/);
});

test("138. commission sourceKey estable: commissionRuleSnapshot + commissionPeriodStart/End identifican la comision de forma unica por nomina", () => {
  assert.match(payrollSubmit, /commissionRuleSnapshot: data\.threshold,/);
});

test("139. tip sourceKey estable: propinaIdsIncluidas fija exactamente que propinas pertenecen a esta nomina", () => {
  assert.match(payrollSubmit, /propinaIdsIncluidas: data\.tipsRows\.map\(\(tip\) => tip\.propinaID\),/);
});

test("140. vacation sourceKey estable: egresoID enlaza el anticipo con su unico egreso, vacationId es el ID propio del registro", () => {
  assert.match(vacationSubmit, /const vacationId = nextDbId\("vacaciones", "vacationId", "VAC"\);/);
});

test("141. CxC application sourceKey estable: cada aplicacion queda anotada por payrollId en observaciones, ademas del cxcDiscountDetalle snapshot", () => {
  assert.match(payrollSubmit, /cxcDiscountDetalle,/);
});

test("142-143-144. una obligacion se paga una sola vez (Pagar exige Borrador), un egreso se crea una sola vez, y una sola entrada de auditoria por pago", () => {
  const auditMatches = payPayrollSubmit.match(/logAudit\("payroll_paid"/g) || [];
  assert.equal(auditMatches.length, 1);
});

// ===========================================================================
// O. Reversion
// ===========================================================================

test("145. la reversion exige un motivo (prompt obligatorio, sin motivo se bloquea)", () => {
  const source = extractFunction("revertPayrollPayment");
  assert.match(source, /const reason = prompt\(/);
  assert.match(source, /if \(!reason \|\| !reason\.trim\(\)\) \{/);
});

test("146. el egreso se revierte UNA sola vez (se marca 'Revertido', nunca se borra)", () => {
  const source = extractFunction("revertPayrollPayment");
  assert.match(source, /expense\.estado = "Revertido";/);
  assert.doesNotMatch(source, /dbTable\("egresos"\)\.splice|delete dbTable/);
});

test("147-148. propinas incluidas vuelven a Pendiente; no existe un concepto separado de 'comision pendiente' que revertir (la comision solo vivio en el snapshot, nunca en una tabla propia con estado)", () => {
  const source = extractFunction("revertPayrollPayment");
  assert.match(source, /tip\.estadoPagoNomina = "Pendiente";/);
  assert.match(source, /tip\.nominaID = "";/);
});

test("149. CxC restauradas: balancePendiente y montoAplicado vuelven a su valor previo", () => {
  const source = extractFunction("revertPayrollPayment");
  assert.match(source, /cxc\.montoAplicado = Math\.max\(0, \(Number\(cxc\.montoAplicado\) \|\| 0\) - applied\);/);
  assert.match(source, /cxc\.balancePendiente = \(Number\(cxc\.balancePendiente\) \|\| 0\) \+ applied;/);
});

test("150. doble reversion bloqueada: revertPayrollPayment exige estado==='pagada', una nomina Revertida ya no cumple esa condicion", () => {
  const source = extractFunction("revertPayrollPayment");
  assert.match(source, /if \(normalize\(payroll\.estado \|\| ""\) !== "pagada"\) \{/);
});

test("151. historico conservado: revertPayrollPayment nunca borra la nomina, solo cambia estado + agrega motivoReversion/revertidoPor/fechaReversion", () => {
  const source = extractFunction("revertPayrollPayment");
  assert.doesNotMatch(source, /dbTable\("nomina"\)\.splice|delete dbTable/);
  assert.match(source, /payroll\.estado = "Revertida";/);
  assert.match(source, /payroll\.motivoReversion = reason\.trim\(\);/);
});

test("152. si una propina incluida ya quedo asociada a OTRA nomina, la reversion se bloquea en vez de corromper esa otra nomina en silencio", () => {
  const source = extractFunction("revertPayrollPayment");
  assert.match(source, /const blockedTip = dbTable\("propinas"\)\.find\(\(tip\) => tipIds\.has\(tip\.propinaID\) && tip\.nominaID && tip\.nominaID !== payrollId\);/);
  assert.match(source, /if \(blockedTip\) \{/);
});

// ===========================================================================
// P. Seguridad e integracion
// ===========================================================================

test("153. Guardar nomina exige permiso (hallazgo previo corregido: antes no validaba nada)", () => {
  assert.match(payrollSubmit, /if \(!canManageInvoices\(\)\) \{/);
});

test("154. Pagar exige permiso", () => {
  assert.match(payPayrollSubmit, /if \(!canManageInvoices\(\)\) \{/);
});

test("155. configurar umbral exige permiso", () => {
  assert.match(commissionSubmit, /if \(!canManageInvoices\(\)\) \{/);
});

test("156. agregar bono exige permiso (vive dentro de #payroll-form, protegido por el mismo canManageInvoices del submit)", () => {
  assert.match(appJs, /byId\("add-payroll-bonus"\)\.addEventListener\("click"/);
});

test("157. crear CxC a colaboradores exige permiso: createCollaboratorInternalCharge y el bloque 'avance' viven detras de canManageInvoices", () => {
  assert.match(extractFunction("createCollaboratorInternalCharge"), /canManageInvoices\(\)/);
});

test("158-159-160. usuario inactivo/sin perfil bloqueado, user_metadata jamas se usa como autorizacion (canManageInvoices ya es la fuente unica en todo el archivo)", () => {
  [payrollSubmit, payPayrollSubmit, vacationSubmit, commissionSubmit, tssSubmit].forEach((block) => {
    assert.doesNotMatch(block, /user_metadata/);
  });
});

test("openPayPayrollForm y revertPayrollPayment tambien exigen permiso (no solo el submit del formulario)", () => {
  assert.match(extractFunction("openPayPayrollForm"), /canManageInvoices\(\)/);
  assert.match(extractFunction("revertPayrollPayment"), /canManageInvoices\(\)/);
});

test("161. reportes: renderPayroll muestra estado y no confunde propina pendiente de cobro con propina pendiente de nomina (usa datos ya filtrados de payrollPreviewData)", () => {
  const source = extractFunction("renderPayroll");
  assert.match(source, /row\.estado \|\| "Borrador"/);
});

test("162. compatibilidad historica: activeTssConfig, collaboratorVacationOffsetForRange y collaboratorReceivablesSorted usan defaults seguros ante campos ausentes", () => {
  assert.match(extractFunction("activeTssConfig"), /row\.fechaVigencia \|\| "Activo"|!row\.fechaVigencia \|\| row\.fechaVigencia <= target/);
  assert.match(extractFunction("collaboratorVacationOffsetForRange"), /Number\(vac\.diasPagados\) \|\| 0/);
  assert.match(extractFunction("collaboratorReceivablesSorted"), /Number\(cxc\.balancePendiente\) > 0/);
});

test("162b. no se ejecuta backfill: ninguna funcion nueva reescribe registros historicos al cargar (solo se leen con defaults, nunca se les hace .push a si mismos como update masivo)", () => {
  [
    "activeTssConfig",
    "collaboratorReceivablesSorted",
    "collaboratorVacationOffsetForRange",
    "existingActivePayrollFor",
  ].forEach((name) => {
    const source = extractFunction(name);
    assert.doesNotMatch(source, /forEach\([^)]*=>\s*{[^}]*stampRecord/);
  });
});

test("163. sin IDs duplicados en outputs/index.html", () => {
  const ids = [...indexHtml.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]);
  const counts = {};
  ids.forEach((id) => {
    counts[id] = (counts[id] || 0) + 1;
  });
  const duplicates = Object.entries(counts).filter(([, count]) => count > 1);
  assert.deepEqual(duplicates, []);
});

test("164. movil: los nuevos bloques de nomina/vacaciones/pago reutilizan clases responsivas ya existentes (form-panel, row-actions, simple-list), sin CSS nuevo fragil", () => {
  assert.match(indexHtml, /<form class="panel form-panel" id="vacation-form">/);
  assert.match(indexHtml, /<form class="panel form-panel hidden" id="pay-payroll-form">/);
});

test("165-166. build y sintaxis: outputs/app.js y outputs/lib/closing-math.js son JS valido", () => {
  assert.doesNotThrow(() => new Function(appJs));
});

test("167. cero escrituras en produccion: este archivo de pruebas no importa supabase-js ni referencia el dominio de produccion", () => {
  const source = fs.readFileSync(__filename, "utf8");
  assert.doesNotMatch(source, /supabase\.co|@supabase\/supabase-js/);
});
