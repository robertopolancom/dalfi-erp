// El QR de la representación impresa del e-CF.
//
// Reglas de la DGII (resumidas por Roberto, 2026-09-18):
//   - QR versión 8, de al menos 22 × 22 mm, abajo a la izquierda de la factura.
//   - Contenido: la dirección de consulta de la DGII con RNC del emisor y del comprador, e-NCF,
//     fecha, monto y código de seguridad. Quien lo escanea ve si la factura es válida.
//   - Debajo del QR, los 6 caracteres del código de seguridad (salen de la firma).
//   - Las facturas de consumo (E32) de menos de RD$250.000 usan otra dirección de consulta.
//
// ⚠ PENDIENTE DE CONFIRMAR con la documentación técnica vigente de la DGII antes de emitir de
// verdad: las URLs y el formato exacto de cada parámetro (fechas dd-MM-yyyy, monto con 2
// decimales). Están aquí, en un solo sitio, para corregirlas sin tocar nada más.
//
// Versión del QR: la URL completa de un E31 (dos RNC, e-NCF, dos fechas, monto y código) pasa de
// 192 caracteres, que es lo máximo que cabe en la versión 8 aun con la corrección de errores más
// baja. Se usa versión 8 siempre que quepa y, si no, la siguiente que alcance; la respuesta dice
// qué versión salió, para no esconderlo. También a confirmar con la DGII.
import qrcode from "qrcode-generator";

const HOSTS = {
  // Ambiente → segmento de la ruta en los servicios de la DGII.
  prueba: "testecf",
  certificacion: "certecf",
  produccion: "ecf",
};
export const LIMITE_CONSUMO_RESUMIDO = 250000;

const dosDigitos = (n) => String(n).padStart(2, "0");
function fechaDGII(iso) {
  // "2026-09-18" o "2026-09-18T15:30:00" → "18-09-2026"
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}
function fechaHoraDGII(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Hora de República Dominicana (UTC-4, sin horario de verano).
  const rd = new Date(d.getTime() - 4 * 3600 * 1000);
  return `${dosDigitos(rd.getUTCDate())}-${dosDigitos(rd.getUTCMonth() + 1)}-${rd.getUTCFullYear()} ${dosDigitos(rd.getUTCHours())}:${dosDigitos(rd.getUTCMinutes())}:${dosDigitos(rd.getUTCSeconds())}`;
}

export function urlConsultaDGII(doc, { ambiente = "produccion" } = {}) {
  const segmento = HOSTS[ambiente] || HOSTS.produccion;
  const monto = Number(doc.totales?.montoTotal || 0).toFixed(2);
  const esConsumoResumido = doc.tipo === "32" && Number(doc.totales?.montoTotal || 0) < LIMITE_CONSUMO_RESUMIDO;
  if (esConsumoResumido) {
    const q = new URLSearchParams({
      RncEmisor: doc.emisor?.rnc || "",
      ENCF: doc.encf || "",
      MontoTotal: monto,
      CodigoSeguridad: doc.codigoSeguridad || "",
    });
    return `https://fc.dgii.gov.do/${segmento}/ConsultaTimbreFC?${q}`;
  }
  const q = new URLSearchParams({
    RncEmisor: doc.emisor?.rnc || "",
    RncComprador: doc.comprador?.rnc || "",
    ENCF: doc.encf || "",
    FechaEmision: fechaDGII(doc.fechaEmision),
    MontoTotal: monto,
    FechaFirma: fechaHoraDGII(doc.fechaFirma),
    CodigoSeguridad: doc.codigoSeguridad || "",
  });
  return `https://ecf.dgii.gov.do/${segmento}/ConsultaTimbre?${q}`;
}

// SVG del QR, sin dependencias de red ni imágenes externas (la CSP de la factura solo permite
// lo propio). Devuelve también la versión usada.
export function qrSvg(texto) {
  let qr = null;
  let version = 8;
  for (; version <= 12; version += 1) {
    try {
      qr = qrcode(version, "L");
      qr.addData(texto);
      qr.make();
      break;
    } catch {
      qr = null;
    }
  }
  if (!qr) throw new Error("El contenido del QR es demasiado largo.");
  const modulos = qr.getModuleCount();
  // viewBox en módulos con margen de 4 (zona tranquila); el tamaño físico lo pone el CSS (mm).
  let path = "";
  for (let r = 0; r < modulos; r += 1) {
    for (let c = 0; c < modulos; c += 1) {
      if (qr.isDark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`;
    }
  }
  const lado = modulos + 8;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}" shape-rendering="crispEdges" role="img" aria-label="Código QR de consulta DGII"><rect width="${lado}" height="${lado}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  return { svg, version, modulos };
}
