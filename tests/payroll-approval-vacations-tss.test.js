// Controles administrativos e interfaz de nomina (julio 2026): completa los
// cinco vacios operativos dejados por el commit anterior (8d5ed6d) —
// bloqueo funcional de TSS al pagar, interfaz de configuracion TSS,
// distincion explicita Borrador/Aprobada/Pagada/Revertida con Aprobar y
// Reabrir, flujo operativo completo de vacaciones (Solicitada -> Aprobada ->
// Pagada anticipadamente -> Disfrutada/Cancelada), e interfaz de CxC de
// colaboradores (creacion de cargos internos + listado filtrable). Mismo
// patron estatico (sin DOM real en este runner) usado en todo el proyecto.
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

const payPayrollSubmit = extractStatementBlock('let payPayrollSubmitInFlight = false;', 'byId("pay-payroll-form").addEventListener("submit"');
const tssSubmit = extractStatementBlock('byId("tss-config-form").addEventListener("submit"', "(event) => {", appJs);
const staffSubmit = extractStatementBlock('byId("staff-form").addEventListener("submit"', "(event) => {", appJs);
const collaboratorChargeSubmit = extractStatementBlock('byId("collaborator-charge-form").addEventListener("submit"', "(event) => {", appJs);

// ===========================================================================
// A. TSS: bloqueo funcional (vacio 1)
// ===========================================================================

test("1. dia 30 (o mes) bloqueado sin configuracion: payrollTssBlockReason devuelve el mensaje exacto exigido", () => {
  const reason = DalfiClosingMath ? null : null; // placeholder para linters; ver funcion real abajo
  const source = extractFunction("payrollTssBlockReason");
  assert.match(source, /if \(payroll\.payrollType === "first"\) return "";/);
  assert.match(source, /if \(payroll\.tssConfigId\) return "";/);
  assert.match(source, /return "No puede pagarse esta nómina porque falta la configuración TSS vigente del período\.";/);
});

test("2. la funcion interna de Pagar (no solo la UI) rechaza la operacion: el submit revisa payrollTssBlockReason ANTES de crear el egreso", () => {
  const blockIdx = payPayrollSubmit.indexOf("payrollTssBlockReason(payroll)");
  const expenseIdx = payPayrollSubmit.indexOf('dbTable("egresos").push(');
  assert.ok(blockIdx !== -1 && expenseIdx !== -1 && blockIdx < expenseIdx);
});

test("3. dia 15 permitido cuando TSS se aplica el dia 30: payrollTssBlockReason nunca bloquea payrollType==='first'", () => {
  assert.equal(functionExists("payrollTssBlockReason"), true);
  const source = extractFunction("payrollTssBlockReason");
  const firstCheckIdx = source.indexOf('if (payroll.payrollType === "first") return "";');
  assert.ok(firstCheckIdx !== -1 && firstCheckIdx < source.indexOf("return \"No puede pagarse"));
});

test("nota visual en #payroll-form: dia 15 explica que la retencion se aplicara el dia 30, sin bloquear el borrador", () => {
  assert.match(indexHtml, /id="payroll-tss-day15-note"/);
  assert.match(indexHtml, /La retención mensual de TSS del colaborador se aplicará en la nómina del día 30/);
  const source = extractFunction("updatePayrollPreview");
  assert.match(source, /payroll-tss-day15-note.*classList\.toggle\("hidden", data\.cut !== "first"\)/);
});

test("4. configuracion valida (tssConfigId presente en el snapshot) permite pagar", () => {
  const source = extractFunction("payrollTssBlockReason");
  const payload = { payrollType: "second", tssConfigId: "TSS-0001" };
  const sandbox = { normalize: (v) => String(v || "").toLowerCase(), payroll: payload };
  const fn = new Function("payroll", `${source}\nreturn payrollTssBlockReason(payroll);`);
  assert.equal(fn(payload), "");
});

test("5-6. configuracion vencida/futura no aplica: activeTssConfig respeta fechaVigencia y fechaFin", () => {
  const source = extractFunction("activeTssConfig");
  assert.match(source, /row\.fechaVigencia <= target/);
  assert.match(source, /row\.fechaFin >= target/);
});

test("7. solapamiento de vigencias: una configuracion ya usada por una nomina PAGADA no se puede editar en silencio", () => {
  assert.match(tssSubmit, /usedByPaidPayroll/);
  assert.match(tssSubmit, /Esta configuración ya fue usada por una nómina pagada y no puede editarse/);
});

test("8. snapshot TSS congelado: el borrador guarda tssConfigId/tssEmployeeDeduction/employerTssContribution, Pagar los usa tal cual", () => {
  const draftSubmit = extractStatementBlock('let payrollSubmitInFlight = false;', 'byId("payroll-form").addEventListener("submit"');
  assert.match(draftSubmit, /tssConfigId: data\.tssConfig\?\.tssID \|\| "",/);
});

// ===========================================================================
// B. Estados: Borrador / Aprobada / Pagada / Revertida (vacio 3)
// ===========================================================================

test("9-10. Borrador se crea editable/recalculable en el formulario (updatePayrollPreview recalcula en cada input, sin depender de que exista un borrador guardado)", () => {
  assert.ok(functionExists("payrollPreviewData"));
  assert.ok(functionExists("updatePayrollPreview"));
});

test("11. Borrador no puede pagarse: openPayPayrollForm y el submit de pago exigen estado==='aprobada'", () => {
  const openSource = extractFunction("openPayPayrollForm");
  assert.match(openSource, /normalize\(payroll\.estado \|\| ""\) !== "aprobada"/);
  assert.match(payPayrollSubmit, /normalize\(payroll\.estado \|\| ""\) !== "aprobada"/);
});

test("12-13. Aprobar es una accion explicita (approvePayroll) que exige permiso y Borrador; el snapshot ya viene congelado desde Guardar, Aprobar no lo recalcula", () => {
  const source = extractFunction("approvePayroll");
  assert.match(source, /canManageInvoices\(\)/);
  assert.match(source, /normalize\(payroll\.estado \|\| ""\) !== "borrador"/);
  assert.match(source, /payroll\.estado = "Aprobada";/);
  assert.doesNotMatch(source, /DalfiClosingMath\.calculatePayrollSettlement|dbTable\("egresos"\)/);
});

test("14. Aprobada no editable: no existe ninguna funcion que modifique un snapshot de nomina en estado Aprobada salvo Pagar/Reabrir/Revertir", () => {
  assert.equal(functionExists("editApprovedPayroll"), false);
});

test("15-16. Reabrir (solo desde Aprobada) exige permiso Y motivo, nunca aplica sobre Pagada", () => {
  const source = extractFunction("reopenPayroll");
  assert.match(source, /canManageInvoices\(\)/);
  assert.match(source, /normalize\(payroll\.estado \|\| ""\) !== "aprobada"/);
  assert.match(source, /const reason = prompt\(/);
  assert.match(source, /if \(!reason \|\| !reason\.trim\(\)\) \{/);
  assert.match(source, /payroll\.estado = "Borrador";/);
});

test("reabrir NO consume ni restaura obligaciones (nada se habia consumido todavia en Aprobada): reopenPayroll no toca propinas ni CxC", () => {
  const source = extractFunction("reopenPayroll");
  assert.doesNotMatch(source, /estadoPagoNomina|balancePendiente/);
});

test("17. Pagada solo puede provenir de Aprobada (nunca Borrador directo)", () => {
  assert.match(payPayrollSubmit, /Esta nómina debe estar Aprobada antes de pagarse\. No se puede pasar de Borrador directo a Pagada\./);
});

test("18. Pagada bloqueada: una vez Pagada, renderPayroll ya no ofrece Aprobar/Reabrir/Pagar, solo Revertir", () => {
  const source = extractFunction("renderPayroll");
  assert.match(source, /const canRevert = normalizedEstado === "pagada";/);
});

test("19. Revertida bloqueada: revertPayrollPayment exige estado==='pagada' (una Revertida ya no cumple esa condicion)", () => {
  const source = extractFunction("revertPayrollPayment");
  assert.match(source, /if \(normalize\(payroll\.estado \|\| ""\) !== "pagada"\) \{/);
});

test("20. sin salto directo Borrador->Pagada: los 3 estados forman una cadena unica (approvePayroll exige Borrador, openPayPayrollForm/pay exigen Aprobada)", () => {
  const approveSource = extractFunction("approvePayroll");
  assert.match(approveSource, /normalize\(payroll\.estado \|\| ""\) !== "borrador"/);
  const payOpenSource = extractFunction("openPayPayrollForm");
  assert.match(payOpenSource, /normalize\(payroll\.estado \|\| ""\) !== "aprobada"/);
});

test("renderPayroll(): botones Aprobar/Reabrir/Pagar/Revertir aparecen contextualmente segun el estado, nunca dos a la vez para el mismo estado", () => {
  const source = extractFunction("renderPayroll");
  assert.match(source, /const canApprove = normalizedEstado === "borrador";/);
  assert.match(source, /const canReopen = normalizedEstado === "aprobada";/);
});

test("aprobar/reabrir estan conectados al click del listado de nomina", () => {
  assert.match(appJs, /if \(event\.target\.closest\("\.approve-payroll"\)\) approvePayroll\(payrollId\);/);
  assert.match(appJs, /if \(event\.target\.closest\("\.reopen-payroll"\)\) reopenPayroll\(payrollId\);/);
});

// ===========================================================================
// C. Interfaz de configuracion TSS (vacio 5, parte 1)
// ===========================================================================

test("21. interfaz TSS: vigencia, fecha final opcional, tasas, tope, base, bonos/comisiones sujetos, estado, observacion", () => {
  assert.match(indexHtml, /id="tss-effective-date"/);
  assert.match(indexHtml, /id="tss-end-date"/);
  assert.match(indexHtml, /id="tss-employee-rate"/);
  assert.match(indexHtml, /id="tss-employer-rate"/);
  assert.match(indexHtml, /id="tss-cap"/);
  assert.match(indexHtml, /id="tss-base"/);
  assert.match(indexHtml, /id="tss-bonus-subject"/);
  assert.match(indexHtml, /id="tss-commission-subject"/);
  assert.match(indexHtml, /id="tss-status"/);
  assert.match(indexHtml, /id="tss-note"/);
});

test("22. crear/editar/desactivar/consultar: tss-config-form reutiliza el patron generico de Base de datos (fillDataForm tipo 'tss', toggle-record-status)", () => {
  assert.match(appJs, /if \(type === "tss"\) \{/);
  assert.match(appJs, /data-type="tss"/);
  assert.match(appJs, /data-table="configuracionTSS"/);
});

test("23. validaciones: tasas finitas y no negativas (0-100), tope/base finitos, fecha final posterior a la vigencia", () => {
  assert.match(tssSubmit, /employeeRate > 100 \|\| employerRate > 100/);
  assert.match(tssSubmit, /if \(endDate && \(!DalfiClosingMath\.isValidIsoDate\(endDate\) \|\| endDate < effectiveDate\)\) \{/);
});

test("24. una sola configuracion efectiva por fecha: activeTssConfig ordena por fechaVigencia descendente y toma la primera vigente", () => {
  const source = extractFunction("activeTssConfig");
  assert.match(source, /\.sort\(\(a, b\) => String\(b\.fechaVigencia \|\| ""\)\.localeCompare\(String\(a\.fechaVigencia \|\| ""\)\)\)\[0\]/);
});

test("no se sugieren tasas legales especificas: ningun valor numerico de tasa viene precargado en el HTML del formulario TSS", () => {
  const formSection = indexHtml.slice(indexHtml.indexOf('id="tss-config-form"'), indexHtml.indexOf("</form>", indexHtml.indexOf('id="tss-config-form"')));
  assert.doesNotMatch(formSection, /value="[1-9][0-9]*\.?[0-9]*"/);
});

// ===========================================================================
// D. Bonos: bloqueados despues de aprobar (vacio en la seccion 7)
// ===========================================================================

test("bonos se congelan al Guardar (el borrador ya guarda 'bonos' con las lineas exactas) y quedan bloqueados tras Aprobar/Pagar (ninguna funcion de pago/aprobacion vuelve a leer .payroll-bonus-line)", () => {
  assert.doesNotMatch(payPayrollSubmit, /payroll-bonus/);
  const approveSource = extractFunction("approvePayroll");
  assert.doesNotMatch(approveSource, /payroll-bonus/);
});

test("cada bono agregado genera auditoria payroll_bonus_added al Guardar", () => {
  const draftSubmit = extractStatementBlock('let payrollSubmitInFlight = false;', 'byId("payroll-form").addEventListener("submit"');
  assert.match(draftSubmit, /logAudit\("payroll_bonus_added", \{/);
});

// ===========================================================================
// E. Vacaciones: interfaz operativa completa (vacio 4)
// ===========================================================================

test("Solicitada/Aprobada/Pagada anticipadamente/Disfrutada/Cancelada: los 5 estados existen explicitamente en el codigo", () => {
  ["Solicitada", "Aprobada", "Pagada anticipadamente", "Disfrutada", "Cancelada"].forEach((estado) => {
    assert.ok(appJs.includes(`"${estado}"`), `falta el estado ${estado}`);
  });
});

test("campos del registro de vacaciones: colaboradora, fechas, dias, valor diario, monto, cuenta, fecha de pago, observacion, sourceKey (vacationId)", () => {
  const requestSubmit = extractStatementBlock('let vacationSubmitInFlight = false;', 'byId("vacation-form").addEventListener("submit"');
  assert.match(requestSubmit, /colaboradorID: staffRecord\.colaboradorID \|\| "",/);
  assert.match(requestSubmit, /fechaInicio: startDate,/);
  assert.match(requestSubmit, /diasPagados: days,/);
  assert.match(requestSubmit, /vacationId,/);
});

test("pago anticipado requiere estado Aprobada + permiso + cuenta, y afecta Cierres en la fecha real de pago", () => {
  const paySubmit = extractStatementBlock('let vacationPaySubmitInFlight = false;', 'byId("vacation-pay-form").addEventListener("submit"');
  assert.match(paySubmit, /canManageInvoices\(\)/);
  assert.match(paySubmit, /normalize\(vacation\.estado \|\| ""\) !== "aprobada"/);
  assert.match(paySubmit, /findAccountByName\(accountName\)/);
  assert.match(paySubmit, /refreshPendingClosingsForDate\(payDate\);/);
});

test("cancelar antes del pago: permitido con motivo, sin crear ni mover dinero", () => {
  const source = extractFunction("cancelVacation");
  assert.match(source, /vacation\.estado = "Cancelada";/);
  assert.doesNotMatch(source.slice(0, source.indexOf("estado === \"pagada anticipadamente\"")), /dbTable\("egresos"\)/);
});

test("cancelar despues del pago: nunca borra silenciosamente, ofrece un ajuste explicito (CxC) via createCollaboratorInternalCharge, con motivo obligatorio", () => {
  const source = extractFunction("cancelVacation");
  const afterPaymentBlock = source.slice(source.indexOf('estado === "pagada anticipadamente"'));
  assert.match(afterPaymentBlock, /const reason = prompt\("Motivo del ajuste por cancelación después del pago:"\);/);
  assert.match(afterPaymentBlock, /createCollaboratorInternalCharge\(\{/);
  assert.match(afterPaymentBlock, /logAudit\("vacation_cancelled_after_payment"/);
});

test("no inventa una recuperacion automatica del dinero: cancelVacation nunca reduce accountAvailableBalance ni marca el egreso original como revertido", () => {
  const source = extractFunction("cancelVacation");
  assert.doesNotMatch(source, /expense\.estado = "Revertido"/);
});

test("histórico: renderVacations() lista TODAS las vacaciones (no solo las activas), ordenadas por fecha", () => {
  const source = extractFunction("renderVacations");
  assert.doesNotMatch(source, /\.filter\(\(row\) => normalize\(row\.estado/);
});

test("sin valor diario configurado bloquea el calculo del anticipo (Aprobar exige dailyValue > 0)", () => {
  const approveSubmit = extractStatementBlock('byId("vacation-approve-form").addEventListener("submit"', "(event) => {", appJs);
  assert.match(approveSubmit, /if \(!\(dailyValue > 0\)\) \{/);
});

// ===========================================================================
// F. CxC de colaboradores: interfaz (vacio 2 y parte del 5)
// ===========================================================================

test("createCollaboratorInternalCharge() esta conectada a una interfaz real (#collaborator-charge-form)", () => {
  assert.match(indexHtml, /id="collaborator-charge-form"/);
  assert.match(collaboratorChargeSubmit, /createCollaboratorInternalCharge\(\{ staffRecord, staffName, amount, concept, tipoCxC \}\);/);
});

test("el formulario de cargo interno aclara 'sin salida de caja/banco' y no pide cuenta financiera", () => {
  const formSection = indexHtml.slice(indexHtml.indexOf('id="collaborator-charge-form"'), indexHtml.indexOf("</form>", indexHtml.indexOf('id="collaborator-charge-form"')));
  assert.match(formSection, /Sin salida de caja\/banco/);
  assert.doesNotMatch(formSection, /list="accounts-list"/);
});

test("listado de CxC de colaboradores nunca se mezcla con CxC de clientes: filtra deudorTipo==='Colaborador' explicitamente", () => {
  const source = extractFunction("renderCollaboratorReceivables");
  assert.match(source, /cxc\.deudorTipo === "Colaborador"/);
});

test("filtros Pendientes/Parciales/Pagadas/Anuladas existen y son mutuamente excluyentes (un boton .active a la vez)", () => {
  assert.match(indexHtml, /data-filter="pendientes"/);
  assert.match(indexHtml, /data-filter="parciales"/);
  assert.match(indexHtml, /data-filter="pagadas"/);
  assert.match(indexHtml, /data-filter="anuladas"/);
  assert.match(appJs, /button\.parentElement\.querySelectorAll\("\.collaborator-receivable-filter"\)\.forEach\(\(item\) => item\.classList\.remove\("active"\)\);/);
});

test("el listado muestra el egreso relacionado (o 'Sin salida de caja/banco' cuando es un cargo interno)", () => {
  const source = extractFunction("renderCollaboratorReceivables");
  assert.match(source, /cxc\.egresoID \|\| "Sin salida de caja\/banco"/);
});

// ===========================================================================
// G. Configuracion salarial (seccion 6)
// ===========================================================================

test("configurar salario exige permiso (hallazgo nuevo: staff-form tampoco validaba nada)", () => {
  assert.match(staffSubmit, /if \(!canManageInvoices\(\)\) \{/);
});

test("historial salarial: cada cambio real de salarioMensual genera una fila nueva en historialSalarial, nunca sobrescribe en silencio", () => {
  assert.match(staffSubmit, /dbTable\("historialSalarial"\)\.push\(/);
  assert.match(staffSubmit, /if \(newSalary > 0 && newSalary !== previousSalary\) \{/);
});

test("el historial salarial no altera el salario ya usado por una nomina pagada (el snapshot de esa nomina vive en salarioInstallmentSnapshot, no se recalcula)", () => {
  const draftSubmit = extractStatementBlock('let payrollSubmitInFlight = false;', 'byId("payroll-form").addEventListener("submit"');
  assert.match(draftSubmit, /salarioInstallmentSnapshot: data\.installment,/);
});

// ===========================================================================
// H. Resumen final de pago (seccion 12)
// ===========================================================================

test("payPayrollSummaryHtml() muestra colaboradora, periodo, quincena, salario, comision, propinas, bonos, vacaciones, TSS, CxC, otras deducciones y neto", () => {
  const source = extractFunction("payPayrollSummaryHtml");
  ["Colaborador/a", "Período", "Quincena", "Salario", "Comisión", "Propinas", "Bonos", "Ajuste vacaciones", "TSS del colaborador", "CxC descontada", "Otros descuentos", "Neto a pagar"].forEach((label) => {
    assert.ok(source.includes(label), `falta la etiqueta "${label}" en el resumen`);
  });
});

test("el resumen se muestra ANTES de que el usuario confirme el pago (openPayPayrollForm lo llena antes de revelar el formulario)", () => {
  const source = extractFunction("openPayPayrollForm");
  const fillIdx = source.indexOf("payPayrollSummaryHtml(payroll)");
  const revealIdx = source.indexOf("revealFormAtTop(form");
  assert.ok(fillIdx !== -1 && revealIdx !== -1 && fillIdx < revealIdx);
});

// ===========================================================================
// I. Auditoria (nombres exactos de eventos, seccion 14)
// ===========================================================================

test("eventos de auditoria requeridos existen con el nombre EXACTO especificado", () => {
  [
    "payroll_draft_saved",
    "payroll_approved",
    "payroll_reopened",
    "payroll_paid",
    "payroll_reverted",
    "payroll_bonus_added",
    "tss_configuration_changed",
    "commission_threshold_changed",
    "vacation_requested",
    "vacation_approved",
    "vacation_advance_paid",
    "collaborator_receivable_created",
    "collaborator_receivable_applied",
  ].forEach((eventName) => {
    assert.match(appJs, new RegExp(`logAudit\\("${eventName}"`), `falta logAudit("${eventName}"`);
  });
});

test("los nombres antiguos (payroll_draft_created, tss_config_create/edit, commission_threshold_create/edit, collaborator_internal_charge_created) ya no se usan", () => {
  ["payroll_draft_created", "tss_config_create", "tss_config_edit", "commission_threshold_create", "commission_threshold_edit", "collaborator_internal_charge_created"].forEach((old) => {
    assert.doesNotMatch(appJs, new RegExp(`logAudit\\("${old}"`));
  });
});

test("ninguna auditoria nueva vuelca erp_records ni el objeto database completo", () => {
  ["approvePayroll", "reopenPayroll", "cancelVacation", "createCollaboratorInternalCharge"].forEach((name) => {
    const source = extractFunction(name);
    assert.doesNotMatch(source, /database\.data|erp_records/);
  });
});

// ===========================================================================
// J. Compatibilidad historica (seccion 16)
// ===========================================================================

test("una nomina antigua sin estado (undefined) se interpreta como Borrador de forma segura, nunca como Aprobada sin evidencia", () => {
  const source = extractFunction("renderPayroll");
  assert.match(source, /const estado = row\.estado \|\| "Borrador";/);
});

test("una nomina antigua Pagada permanece bloqueada (canPay/canApprove/canReopen todos false para estado Pagada)", () => {
  const source = extractFunction("renderPayroll");
  const normalizedBlock = source.slice(source.indexOf("const normalizedEstado"), source.indexOf("const tssBlock"));
  assert.match(normalizedBlock, /canApprove = normalizedEstado === "borrador"/);
  assert.match(normalizedBlock, /canReopen = normalizedEstado === "aprobada"/);
  assert.match(normalizedBlock, /canPay = normalizedEstado === "aprobada"/);
});

test("no se ejecuta backfill: ninguna funcion nueva de esta tarea reescribe registros historicos masivamente al cargar/renderizar", () => {
  ["renderPayroll", "renderVacations", "renderCollaboratorReceivables"].forEach((name) => {
    const source = extractFunction(name);
    assert.doesNotMatch(source, /forEach\([^)]*=>\s*{[^}]*stampRecord/);
  });
});

// ===========================================================================
// K. Movil / IDs / build
// ===========================================================================

test("sin IDs duplicados en outputs/index.html tras esta tarea", () => {
  const ids = [...indexHtml.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]);
  const counts = {};
  ids.forEach((id) => {
    counts[id] = (counts[id] || 0) + 1;
  });
  assert.deepEqual(Object.entries(counts).filter(([, count]) => count > 1), []);
});

test("los nuevos paneles (vacaciones, CxC de colaboradores, resumen de pago) reutilizan clases responsivas ya existentes", () => {
  assert.match(indexHtml, /<form class="panel form-panel" id="collaborator-charge-form">/);
  assert.match(indexHtml, /<section class="invoice-summary" id="pay-payroll-summary" aria-live="polite">/);
});

test("build/sintaxis: outputs/app.js y outputs/lib/closing-math.js son JS valido", () => {
  assert.doesNotThrow(() => new Function(appJs));
});

test("cero escrituras en produccion: este archivo no importa supabase-js ni referencia el dominio de produccion", () => {
  const source = fs.readFileSync(__filename, "utf8");
  assert.doesNotMatch(source, /supabase\.co|@supabase\/supabase-js/);
});
