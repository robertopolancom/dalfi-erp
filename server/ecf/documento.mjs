// De una factura del ERP a NUESTRO documento e-CF neutral.
//
// Este documento es el contrato entre el ERP y la capa de PSFE (server/ecf/servicio.mjs): el ERP
// no sabe nada de Alanube, The Factory HKA ni del XML de la DGII. Cada adaptador traduce ESTO al
// formato de su proveedor. Si mañana se cambia de proveedor, este archivo no se toca.
//
// Reglas fiscales de Dalfi (confirmadas por Roberto el 2026-09-18):
//   - Los SERVICIOS del salón son exentos de ITBIS (indicador de facturación 4).
//   - Los PRODUCTOS se ofrecen con el ITBIS del 18 % YA INCLUIDO en el precio: la base se saca
//     dividiendo entre 1,18 (indicador 1). Hoy la factura de servicios solo lleva servicios; los
//     productos van por Ventas directas y se mapearán igual cuando se conecten.
//   - La propina NO es ingreso del negocio: no entra al e-CF.
//
// Los montos se redondean a 2 decimales por línea y los totales se suman desde las líneas ya
// redondeadas, que es como los valida la DGII (el total tiene que cuadrar con la suma de líneas).

export const TIPOS_ECF = {
  "31": "Factura de Crédito Fiscal Electrónica",
  "32": "Factura de Consumo Electrónica",
  "33": "Nota de Débito Electrónica",
  "34": "Nota de Crédito Electrónica",
};

// Indicador de facturación por línea (tabla de la DGII).
export const INDICADOR = { ITBIS_18: 1, EXENTO: 4 };
const TASA_ITBIS = 0.18;

// Formas de pago de la DGII: 1 efectivo, 2 cheque/transferencia/depósito, 3 tarjeta,
// 4 venta a crédito, 8 otras.
function codigoFormaPago(metodo) {
  const m = String(metodo || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (m.includes("tarjeta")) return 3;
  if (m.includes("transferencia") || m.includes("deposito") || m.includes("cheque")) return 2;
  if (m.includes("credito")) return 4;
  if (m.includes("efectivo")) return 1;
  return 8;
}

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function tablas(document) {
  if (document?.data && typeof document.data === "object") return document.data;
  return document && typeof document === "object" ? document : {};
}

// Emisor desde el entorno. Sin RNC el documento sale en modo "prueba": se puede ver y probar
// todo, pero nunca se manda a la DGII (ver servicio.mjs). Hoy Dalfi factura con el RNC de persona
// física y la empresa se está constituyendo: el RNC se pone cuando exista el definitivo.
export function emisorDesdeEntorno(env = {}) {
  const rnc = String(env.ECF_EMISOR_RNC || "").replace(/\D/g, "");
  return {
    rnc: rnc || null,
    razonSocial: String(env.ECF_EMISOR_RAZON_SOCIAL || "Dalfi Studio Nails & Academy"),
    nombreComercial: String(env.ECF_EMISOR_NOMBRE_COMERCIAL || "Dalfi Studio Nails & Academy"),
    direccion: String(env.ECF_EMISOR_DIRECCION || "Calle Juan Caballero No. 38, Baní, Peravia"),
    modo: rnc ? "real" : "prueba",
  };
}

export function documentoDesdeFactura(document, facturaID, { emisor }) {
  const data = tablas(document);
  const factura = (data.facturas || []).find((f) => String(f?.facturaID) === String(facturaID));
  if (!factura) return null;

  const detalles = (data.facturaDetalle || []).filter((d) => String(d?.facturaID) === String(facturaID));
  const lineas = detalles.map((d, i) => {
    const cantidad = Number(d.cantidad) || 1;
    const bruto = Number(d.precioBase) || 0;
    const recargo = Number(d.extraMonto) || 0;
    const descuento = (Number(d.deduccionMonto) || 0) + (Number(d.deduccionGeneralMonto) || 0);
    const montoItem = r2(Number(d.subtotal) || cantidad * bruto + recargo - descuento);
    // Una línea de factura de servicios es un servicio: exenta. Si algún día trae un producto
    // marcado como gravado (d.gravado === true), el precio ya incluye el ITBIS.
    const gravada = d.gravado === true;
    const itbis = gravada ? r2(montoItem - montoItem / (1 + TASA_ITBIS)) : 0;
    return {
      numero: i + 1,
      descripcion: String(d.servicio || "Servicio").slice(0, 80),
      cantidad,
      precioUnitario: r2(bruto),
      recargo: r2(recargo),
      descuento: r2(descuento),
      indicadorFacturacion: gravada ? INDICADOR.ITBIS_18 : INDICADOR.EXENTO,
      montoItem,
      itbis,
    };
  });

  const montoExento = r2(lineas.filter((l) => l.indicadorFacturacion === INDICADOR.EXENTO).reduce((s, l) => s + l.montoItem, 0));
  const totalGravadoConItbis = lineas.filter((l) => l.indicadorFacturacion === INDICADOR.ITBIS_18).reduce((s, l) => s + l.montoItem, 0);
  const totalItbis = r2(lineas.reduce((s, l) => s + l.itbis, 0));
  const montoGravado = r2(totalGravadoConItbis - totalItbis);
  const montoTotal = r2(montoExento + montoGravado + totalItbis);

  const comprador = factura.compradorRNC
    ? { rnc: String(factura.compradorRNC).replace(/\D/g, ""), razonSocial: String(factura.compradorRazonSocial || factura.clienteNombre || "") }
    : null;
  const tipo = comprador && factura.tipoComprobante === "31" ? "31" : "32";

  // Formas de pago: lo cobrado por método, y lo que quedó pendiente como venta a crédito.
  const pagos = (data.pagosFactura || []).filter((p) => String(p?.facturaID) === String(facturaID) && p.estadoPago !== "Anulado");
  const porCodigo = new Map();
  for (const p of pagos) {
    const codigo = codigoFormaPago(p.metodoPago);
    porCodigo.set(codigo, r2((porCodigo.get(codigo) || 0) + (Number(p.montoBruto) || 0)));
  }
  const cobrado = [...porCodigo.values()].reduce((s, v) => s + v, 0);
  const pendiente = r2(montoTotal - cobrado);
  if (pendiente > 0.009) porCodigo.set(4, r2((porCodigo.get(4) || 0) + pendiente));
  // Si se cobró de más (por ejemplo, abonos a deudas anteriores), el e-CF solo declara el total
  // de ESTA factura: se recorta desde el último método.
  let exceso = r2([...porCodigo.values()].reduce((s, v) => s + v, 0) - montoTotal);
  const formasPago = [...porCodigo.entries()].map(([codigo, monto]) => ({ codigo, monto })).reverse();
  for (const fp of formasPago) {
    if (exceso <= 0) break;
    const quita = Math.min(fp.monto, exceso);
    fp.monto = r2(fp.monto - quita);
    exceso = r2(exceso - quita);
  }

  return {
    facturaID: String(factura.facturaID),
    tipo,
    tipoNombre: TIPOS_ECF[tipo],
    modo: emisor.modo,
    emisor,
    comprador,
    fechaEmision: String(factura.fechaOperacion || factura.fechaHora || "").slice(0, 10),
    lineas,
    totales: { montoGravado, totalItbis, montoExento, montoTotal },
    formasPago: formasPago.reverse().filter((fp) => fp.monto > 0),
    // Los pone el PSFE al emitir (servicio.mjs). Mientras tanto, vacíos.
    encf: factura.encf || null,
    codigoSeguridad: factura.ecfCodigoSeguridad || null,
    fechaFirma: factura.ecfFechaFirma || null,
    estadoECF: factura.ecfEstado || "no_emitido",
  };
}
