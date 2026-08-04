// Anulacion de facturas de servicio (agosto 2026): una administradora
// necesitaba poder eliminar una factura mal hecha, pero el sistema nunca
// borra registros financieros (mismo principio que reverseRetailSale y
// voidReceivableReceipt) — en vez de eso, voidInvoice() la marca
// estadoFactura:"Anulada", reversa su efecto en inventario, propinas, pagos
// confirmados y cuentas por cobrar, y conserva quien/cuando/por que.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
const stylesCss = fs.readFileSync(path.join(__dirname, "..", "outputs", "styles.css"), "utf8");

function extractFunction(name, source = appJs) {
  const pattern = new RegExp(`^\\s*(async )?function ${name}\\(`, "m");
  const match = pattern.exec(source);
  assert.ok(match, `no se encontro function ${name}`);
  let depth = 0;
  let end = source.indexOf("{", match.index);
  for (; end < source.length; end += 1) {
    if (source[end] === "{") depth += 1;
    if (source[end] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, end + 1);
    }
  }
  throw new Error(`function ${name} incompleta`);
}

test("canVoidInvoice(): solo exige canReopenClosings() y que no este ya anulada; DELIBERADAMENTE no revisa cierre/cobros posteriores/propina pagada, para que el boton nunca desaparezca en silencio y voidInvoice() pueda explicar el motivo exacto al intentarlo", () => {
  const source = extractFunction("canVoidInvoice");
  assert.match(source, /if \(!canReopenClosings\(\)\) return false;/);
  assert.match(source, /Boolean\(invoice\) && invoice\.estadoFactura !== "Anulada";/);
  assert.doesNotMatch(source, /isClosingOpenForEdits/);
});

test("voidInvoice(): nunca borra la factura (marca estadoFactura:Anulada, conserva anuladaEn/anuladaPor/motivoAnulacion)", () => {
  const source = extractFunction("voidInvoice");
  assert.doesNotMatch(source, /dbTable\("facturas"\)\.splice|\.filter\(\(row\) => row\.facturaID !== invoiceId\)/);
  assert.match(source, /invoice\.estadoFactura = "Anulada";/);
  assert.match(source, /invoice\.anuladaEn = new Date\(\)\.toISOString\(\);/);
  assert.match(source, /invoice\.anuladaPor = currentUserEmail\(\);/);
  assert.match(source, /invoice\.motivoAnulacion = reason;/);
});

test("voidInvoice(): exige permiso de administrador senior, bloquea si ya esta anulada, exige cierre abierto y exige un motivo", () => {
  const source = extractFunction("voidInvoice");
  assert.match(source, /if \(!canReopenClosings\(\)\) \{/);
  assert.match(source, /Esta factura ya está anulada\./);
  assert.match(source, /Primero administración debe reabrir el cierre\./);
  assert.match(source, /const reason = prompt\(/);
  assert.match(source, /if \(!reason\) \{/);
});

test("las 3 reglas de bloqueo (cierre confirmado, cobro posterior ya aplicado, propina ya pagada en nomina) SIEMPRE explican el motivo exacto: el boton Anular nunca se oculta por estas 3 razones, asi que la persona siempre llega a intentarlo y ver el mensaje", () => {
  const canVoidSource = extractFunction("canVoidInvoice");
  assert.doesNotMatch(canVoidSource, /isClosingOpenForEdits|montoAplicado|invoiceVoidTipBlockedReason/);
  const voidSource = extractFunction("voidInvoice");
  assert.match(voidSource, /Esta factura pertenece a un día con cierre confirmado\. Primero administración debe reabrir el cierre\./);
  assert.match(voidSource, /No se puede anular: esta factura tiene cobros posteriores aplicados a su cuenta por cobrar\./);
  assert.match(voidSource, /alert\(tipBlockedReason\);/);
  // Orden: cierre -> cobro posterior -> propina pagada, cada uno con su
  // propio return antes de mutar nada.
  const closingCheck = voidSource.indexOf("Primero administración debe reabrir el cierre");
  const collectedCheck = voidSource.indexOf("cobros posteriores aplicados");
  const tipCheck = voidSource.indexOf("invoiceVoidTipBlockedReason(invoiceId)");
  assert.ok(closingCheck > -1 && collectedCheck > closingCheck && tipCheck > collectedCheck);
});

test("voidInvoice(): bloquea si hay un cobro posterior (recibo) ya aplicado a la CxC de esta factura, igual patron que reverseRetailSale", () => {
  const source = extractFunction("voidInvoice");
  assert.match(source, /alreadyCollectedElsewhere = relatedReceivables\.some\(\(row\) => Number\(row\.montoAplicado\) > 0\)/);
  assert.match(source, /Primero anula esos recibos desde Cuentas por cobrar/);
});

test("voidInvoice(): bloquea si alguna propina de la factura ya se pago en nomina (invoiceVoidTipBlockedReason), antes de mutar cualquier fila", () => {
  const source = extractFunction("voidInvoice");
  assert.match(source, /const tipBlockedReason = invoiceVoidTipBlockedReason\(invoiceId\);/);
  assert.match(source, /if \(tipBlockedReason\) \{/);
  const tipCheckIndex = source.indexOf("invoiceVoidTipBlockedReason(invoiceId)");
  const firstMutation = source.indexOf("reverseInvoiceInventoryEffects(");
  assert.ok(tipCheckIndex > -1 && firstMutation > tipCheckIndex, "el bloqueo de propina debe revisarse ANTES de reversar inventario/pagos");
});

test("invoiceVoidTipBlockedReason(): revisa TODOS los origenes de cobro de la propina de la factura (no solo un cxCID como invoiceTipReversalBlockedReason), buscando por facturaID directamente", () => {
  const source = extractFunction("invoiceVoidTipBlockedReason");
  assert.match(source, /row\.facturaID === invoiceId && Number\(row\.montoBruto\) > 0/);
  assert.match(source, /normalize\(row\.estadoPagoNomina \|\| "Pendiente"\) !== "pendiente"/);
});

test("reverseAllInvoiceTipCollections(): limpia TODA propina de la factura (monto y pagosAplicados), nunca borra la fila, y dejar estadoPagoNomina fuera de 'pendiente' evita que se reutilice para un cobro futuro", () => {
  const source = extractFunction("reverseAllInvoiceTipCollections");
  assert.match(source, /row\.montoBruto = 0;/);
  assert.match(source, /row\.pagosAplicados = \[\];/);
  assert.match(source, /row\.estadoPagoNomina = "Anulada";/);
  assert.match(source, /dbInvoice\.propinaCobrada = 0;/);
  assert.match(source, /dbInvoice\.propinaPendiente = 0;/);
});

test("voidInvoice(): reversa inventario de la factura reutilizando DalfiClosingMath.reverseInvoiceInventoryEffects (mismo motor generico que retail, ya probado)", () => {
  const source = extractFunction("voidInvoice");
  assert.match(source, /DalfiClosingMath\.reverseInvoiceInventoryEffects\(\{/);
  assert.match(source, /invoiceId,\s*\n\s*inventoryMovements: dbTable\("inventarioMovimientos"\)/);
});

test("voidInvoice(): reversa pagos CONFIRMADOS con un egreso nuevo (nunca reescribe el ingreso original ya registrado ese dia, conserva el rastro de auditoria), marca pagosFactura como Revertido", () => {
  const source = extractFunction("voidInvoice");
  assert.match(source, /row\.estadoPago === "Confirmado"/);
  assert.match(source, /tipoEgreso: "reversion_factura"/);
  assert.match(source, /payment\.estadoPago = "Revertido";/);
  assert.doesNotMatch(source, /dbTable\("ingresos"\)/);
});

test("voidInvoice(): marca las cuentas por cobrar de la factura (base y propina pendiente) como Anulada con balance en 0", () => {
  const source = extractFunction("voidInvoice");
  assert.match(source, /relatedReceivables\.forEach\(\(cxc\) => \{/);
  assert.match(source, /cxc\.estado = "Anulada";/);
  assert.match(source, /cxc\.balancePendiente = 0;/);
});

test("voidInvoice(): audita la anulacion (invoice_voided) y refresca state antes de guardar/renderizar", () => {
  const source = extractFunction("voidInvoice");
  assert.match(source, /logAudit\("invoice_voided", \{/);
  assert.match(source, /state = stateFromDatabase\(database\);\s*\n\s*saveState\(\);\s*\n\s*renderAll\(\);/);
});

test("state.invoices expone 'voided' (estadoFactura === Anulada) para que la UI la refleje sin adivinar", () => {
  const source = extractFunction("stateFromDatabase");
  assert.match(source, /voided: invoice\.estadoFactura === "Anulada",/);
});

test("statusBadge() muestra 'Anulada' antes que cualquier otro estado, y canEditInvoice() nunca permite editar una factura ya anulada", () => {
  const badgeSource = extractFunction("statusBadge");
  assert.match(badgeSource, /if \(invoice\.voided\) return '<span class="badge voided">Anulada<\/span>';/);
  const editSource = extractFunction("canEditInvoice");
  assert.match(editSource, /invoice\?\.estadoFactura === "Anulada"\) return false;/);
});

test("el boton 'Anular' aparece en Facturacion y Admin facturas solo cuando canVoidInvoice() lo permite, y esta conectado a voidInvoice()", () => {
  assert.match(appJs, /voidable = !invoice\.voided && canVoidInvoice\(invoice\.id\)/);
  assert.match(appJs, /class="secondary-btn compact danger void-invoice" type="button">Anular<\/button>/);
  assert.match(appJs, /voidable = !voided && canVoidInvoice\(invoice\.facturaID\)/);
  assert.match(appJs, /class="secondary-btn compact danger void-invoice-admin" type="button">Anular<\/button>/);
  assert.match(appJs, /if \(event\.target\.closest\("\.void-invoice"\)\) voidInvoice\(invoiceId\);/);
  assert.match(appJs, /if \(event\.target\.closest\("\.void-invoice-admin"\)\) voidInvoice\(invoiceId\);/);
});

test("la vista/impresion de una factura anulada muestra un aviso claro con motivo y fecha", () => {
  const source = extractFunction("invoiceReportHtml");
  assert.match(source, /dbInvoice\?\.estadoFactura === "Anulada"/);
  assert.match(source, /FACTURA ANULADA/);
});

test("el badge .voided existe en el CSS (visualmente distinto de pagada/abonada/pendiente)", () => {
  assert.match(stylesCss, /\.badge\.voided \{/);
});

test("Facturacion (Facturas) y Admin facturas muestran una columna de Estado para que la factura anulada quede visible en la lista, no oculta", () => {
  assert.match(indexHtml, /<th>Estado<\/th>\s*\n\s*<th>Acción<\/th>/);
  assert.match(indexHtml, /<th>Estado cierre<\/th>\s*\n\s*<th>Estado factura<\/th>/);
});

test("closingCollaboratorSummary() ahora si excluye facturas anuladas del resumen de comisiones por colaboradora del cierre (usa estadoFactura, el campo real)", () => {
  const source = extractFunction("closingCollaboratorSummary");
  assert.match(source, /invoice\.estadoFactura !== "Anulada"/);
});
