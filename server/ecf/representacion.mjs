// Representación impresa del e-CF: la factura que ve e imprime el cliente, con el formato de la DGII.
//
// Orden de la hoja: datos del emisor y del comprobante arriba, detalle con ITBIS, totales, formas de
// pago y, ABAJO A LA IZQUIERDA, el QR (al menos 22 × 22 mm; aquí 25 mm para tener margen al
// imprimir) con el código de seguridad de 6 caracteres debajo y la fecha de firma.
//
// Mientras el emisor no tenga RNC, o el e-CF sea del adaptador simulado, la hoja lo dice en grande:
// "Vista de prueba — no válida como comprobante fiscal". Nunca debe poder confundirse con una real.
import { urlConsultaDGII, qrSvg } from "./consulta-qr.mjs";

const esc = (v) => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const money = (v) => `RD$ ${(Number(v) || 0).toLocaleString("es-DO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const FORMAS = { 1: "Efectivo", 2: "Transferencia / depósito", 3: "Tarjeta", 4: "Venta a crédito", 8: "Otras" };
function fechaCorta(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}
function fechaFirmaLegible(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const rd = new Date(d.getTime() - 4 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(rd.getUTCDate())}-${p(rd.getUTCMonth() + 1)}-${rd.getUTCFullYear()} ${p(rd.getUTCHours())}:${p(rd.getUTCMinutes())}:${p(rd.getUTCSeconds())}`;
}

const ESTILOS = `
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;background:#F4F2EC;color:#111;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:20px 12px 48px}
  .hoja{width:min(760px,100%);margin:0 auto;background:#fff;border:1px solid #D8D2C0;padding:28px 28px 24px}
  .prueba{background:#FFF4E5;border:2px dashed #C26A1B;color:#8A4A10;font-weight:700;text-align:center;padding:10px;margin-bottom:18px;letter-spacing:.02em}
  .cab{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;border-bottom:2px solid #111;padding-bottom:14px}
  .emisor h1{font-size:1.1rem;margin:0 0 4px}
  .emisor p,.comprobante p{margin:2px 0;font-size:.82rem}
  .comprobante{text-align:right}
  .comprobante .tipo{font-weight:700;font-size:.92rem;margin-bottom:6px}
  .comprobante .encf{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:1rem;font-weight:700}
  .comprador{margin:14px 0;font-size:.84rem}
  table{width:100%;border-collapse:collapse;font-size:.82rem;margin-top:6px}
  th{text-align:left;border-bottom:1px solid #111;padding:6px 4px;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}
  td{padding:7px 4px;border-bottom:1px solid #E6E2D6;vertical-align:top}
  .num{text-align:right;white-space:nowrap}
  .pie{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;margin-top:18px;flex-wrap:wrap-reverse}
  .qr{width:25mm;min-width:25mm}
  .qr svg{display:block;width:25mm;height:25mm}
  .qr p{margin:4px 0 0;font-size:.72rem;line-height:1.35}
  .qr .codigo{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.86rem;font-weight:700;letter-spacing:.08em}
  .totales{min-width:260px;font-size:.86rem}
  .totales div{display:flex;justify-content:space-between;padding:4px 0}
  .totales .total{border-top:2px solid #111;margin-top:4px;padding-top:8px;font-weight:700;font-size:1rem}
  .pagos{font-size:.78rem;margin-top:10px;color:#333}
  .nota{font-size:.7rem;color:#555;margin-top:16px}
  @media print{body{background:#fff;padding:0}.hoja{border:0;width:100%;padding:10mm}@page{size:letter;margin:8mm}}
`;

export function renderRepresentacionImpresa(doc, { ambiente = "produccion" } = {}) {
  const esPrueba = doc.modo !== "real" || doc.simulado;
  const url = urlConsultaDGII(doc, { ambiente });
  const { svg, version } = qrSvg(url);
  const filas = doc.lineas.map((l) => `<tr>
      <td class="num">${l.cantidad}</td>
      <td>${esc(l.descripcion)}${l.indicadorFacturacion === 4 ? " <small>(E)</small>" : ""}</td>
      <td class="num">${money(l.precioUnitario)}</td>
      <td class="num">${money(l.itbis)}</td>
      <td class="num">${money(l.montoItem)}</td>
    </tr>`).join("");
  const pagos = doc.formasPago.map((fp) => `${esc(FORMAS[fp.codigo] || "Otras")}: ${money(fp.monto)}`).join(" · ");

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(doc.tipoNombre)} ${esc(doc.encf || "")}</title><style>${ESTILOS}</style></head><body>
<div class="hoja">
  ${esPrueba ? `<div class="prueba">VISTA DE PRUEBA — NO VÁLIDA COMO COMPROBANTE FISCAL${doc.simulado ? " (e-NCF y código simulados)" : ""}</div>` : ""}
  <div class="cab">
    <div class="emisor">
      <h1>${esc(doc.emisor.razonSocial)}</h1>
      ${doc.emisor.nombreComercial && doc.emisor.nombreComercial !== doc.emisor.razonSocial ? `<p>${esc(doc.emisor.nombreComercial)}</p>` : ""}
      <p>RNC: ${esc(doc.emisor.rnc || "pendiente de constitución")}</p>
      <p>${esc(doc.emisor.direccion)}</p>
    </div>
    <div class="comprobante">
      <p class="tipo">${esc(doc.tipoNombre)}</p>
      <p class="encf">e-NCF: ${esc(doc.encf || "pendiente")}</p>
      <p>Fecha de emisión: ${esc(fechaCorta(doc.fechaEmision))}</p>
    </div>
  </div>
  <div class="comprador">
    ${doc.comprador
      ? `<strong>Comprador:</strong> ${esc(doc.comprador.razonSocial)} · RNC/Cédula ${esc(doc.comprador.rnc)}`
      : `<strong>Comprador:</strong> Consumidor final`}
  </div>
  <table>
    <thead><tr><th class="num">Cant.</th><th>Descripción</th><th class="num">Precio</th><th class="num">ITBIS</th><th class="num">Valor</th></tr></thead>
    <tbody>${filas || `<tr><td colspan="5">Sin líneas.</td></tr>`}</tbody>
  </table>
  <div class="pie">
    <div class="qr">
      ${svg}
      <p>Código de seguridad:<br><span class="codigo">${esc(doc.codigoSeguridad || "------")}</span></p>
      ${doc.fechaFirma ? `<p>Fecha de firma:<br>${esc(fechaFirmaLegible(doc.fechaFirma))}</p>` : ""}
    </div>
    <div class="totales">
      <div><span>Monto gravado</span><span>${money(doc.totales.montoGravado)}</span></div>
      <div><span>ITBIS 18 %</span><span>${money(doc.totales.totalItbis)}</span></div>
      <div><span>Monto exento</span><span>${money(doc.totales.montoExento)}</span></div>
      <div class="total"><span>Total</span><span>${money(doc.totales.montoTotal)}</span></div>
      ${pagos ? `<p class="pagos">${pagos}</p>` : ""}
    </div>
  </div>
  <p class="nota">(E) Servicio exento de ITBIS.${version > 8 ? ` QR versión ${version}: el contenido no cabe en la versión 8 (pendiente de confirmar con la DGII).` : ""}</p>
</div></body></html>`;
}
