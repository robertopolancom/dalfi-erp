import { createHmac, timingSafeEqual } from "node:crypto";

// Enlace público para que la clienta vea su factura. NO se guarda nada: el token es una firma
// HMAC del propio facturaID, así que no hay tabla, ni archivo, ni PDF acumulándose en ningún
// lado. Al abrir el enlace, el servidor lee la base viva del ERP y arma la factura en ese
// momento -- si después se edita, el enlace muestra lo nuevo; si se elimina, el enlace deja de
// funcionar solo. Ese fue el pedido explícito de Roberto (2026-09-04).
//
// El token es determinista (mismo facturaID -> mismo enlace) a propósito: reenviar la factura a
// la misma clienta no genera un enlace distinto, y no hay estado que limpiar. Lo que protege el
// enlace es la firma: sin el secreto no se puede fabricar uno para otra factura.

function secretFor(env) {
  // Secreto propio si existe; si no, se reutiliza el del webhook del bridge, que ya está
  // configurado en Render. Sin ninguno de los dos no se emiten enlaces (mejor no emitir que
  // emitir uno que cualquiera pueda falsificar).
  return String(env.INVOICE_LINK_SECRET || env.ERP_WEBHOOK_SECRET || "");
}

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64").toString("utf8");
}

function sign(env, payload) {
  return b64url(createHmac("sha256", secretFor(env)).update(payload).digest()).slice(0, 43);
}

export function invoiceToken(env, invoiceId) {
  const id = String(invoiceId || "").trim();
  if (!id || !secretFor(env)) return null;
  const payload = b64url(id);
  return `${payload}.${sign(env, payload)}`;
}

export function verifyInvoiceToken(env, token) {
  if (!secretFor(env)) return null;
  const raw = String(token || "");
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);
  const expected = sign(env, payload);
  // Comparación en tiempo constante: no filtrar cuántos caracteres acertó quien prueba tokens.
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return null;
  try {
    const id = fromB64url(payload);
    return id && /^[\w-]{1,80}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function invoiceUrl(env, invoiceId) {
  const token = invoiceToken(env, invoiceId);
  if (!token) return null;
  const base = String(env.APP_BASE_URL || "https://ssc.dalfistudio.com").replace(/\/$/, "");
  return `${base}/factura/${token}`;
}

// Arma la factura a partir del documento vivo del ERP. Devuelve null si la factura ya no existe
// (eliminada o nunca existió) -- quien llama decide qué mostrar.
export function buildInvoiceView(document, invoiceId) {
  const data = document && typeof document === "object" ? document : {};
  const invoices = Array.isArray(data.facturas) ? data.facturas : [];
  const invoice = invoices.find((row) => String(row?.facturaID) === String(invoiceId));
  if (!invoice) return null;

  const allDetails = Array.isArray(data.facturaDetalle) ? data.facturaDetalle : [];
  const lines = allDetails
    .filter((row) => String(row?.facturaID) === String(invoiceId))
    .map((row) => {
      const qty = Number(row.cantidad) || 1;
      const base = Number(row.precioBase) || 0;
      const extra = Number(row.extraMonto) || 0;
      const discount = (Number(row.deduccionMonto) || 0) + (Number(row.deduccionGeneralMonto) || 0);
      return {
        servicio: String(row.servicio || "Servicio"),
        colaboradora: String(row.colaboradorNombre || ""),
        cantidad: qty,
        precio: base,
        extra,
        descuento: discount,
        // subtotal ya viene calculado por el ERP; solo se recalcula si falta (facturas viejas).
        total: Number(row.subtotal) || qty * base + extra - discount,
      };
    });

  const clients = Array.isArray(data.clientes) ? data.clientes : [];
  const client = clients.find((row) => String(row?.clienteID) === String(invoice.clienteID)) || null;

  return {
    id: String(invoice.facturaID),
    fecha: String(invoice.fechaOperacion || invoice.fechaHora || "").slice(0, 10),
    clienteNombre: String(invoice.clienteNombre || client?.nombreCompleto || "Cliente"),
    clienteTelefono: String(client?.telefono || client?.celular || ""),
    clienteEmail: String(client?.email || client?.correo || ""),
    colaboradora: String(invoice.colaboradorNombre || ""),
    lines,
    propina: Number(invoice.propinaCobrada) || 0,
    total: Number(invoice.totalFacturado) || lines.reduce((sum, line) => sum + line.total, 0),
    pendiente: Number(invoice.totalCxC) || 0,
  };
}

function money(value) {
  return `RD$ ${(Number(value) || 0).toLocaleString("es-DO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const SHELL_STYLES = `
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;background:#FAF6EE;color:#211F1B;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       -webkit-font-smoothing:antialiased;padding:24px 16px 64px}
  .sheet{width:min(640px,100%);margin:0 auto;background:#fff;border:1px solid #D8D2C0;
         border-radius:18px;overflow:hidden;box-shadow:0 18px 40px rgba(33,31,27,.10)}
  .head{padding:26px 26px 20px;border-bottom:1px solid #E9E4D6}
  .brand{font-size:1.18rem;font-weight:700;color:#4B5040;letter-spacing:-.01em;margin:0}
  .brand em{font-style:italic;font-weight:400;color:#726C60}
  .meta{margin:14px 0 0;font-size:.82rem;color:#726C60;line-height:1.7}
  .meta strong{color:#211F1B;font-weight:600}
  .body{padding:22px 26px}
  table{width:100%;border-collapse:collapse;font-size:.86rem}
  th{text-align:left;font-size:.68rem;letter-spacing:.09em;text-transform:uppercase;
     color:#726C60;font-weight:700;padding:0 0 10px;border-bottom:1px solid #E9E4D6}
  th.num,td.num{text-align:right;white-space:nowrap}
  td{padding:13px 0;border-bottom:1px solid #F1EEE5;vertical-align:top}
  .svc{font-weight:600}
  .who{display:block;font-size:.74rem;color:#726C60;margin-top:3px}
  .adj{display:block;font-size:.72rem;color:#726C60;margin-top:3px}
  .totals{margin-top:18px;font-size:.88rem}
  .totals div{display:flex;justify-content:space-between;padding:7px 0}
  .totals .grand{border-top:1px solid #D8D2C0;margin-top:6px;padding-top:14px;
                 font-size:1.12rem;font-weight:700;color:#4B5040}
  .due{margin-top:14px;background:#FBF1EC;border:1px solid #E4C9BC;color:#A5583F;
       border-radius:11px;padding:11px 14px;font-size:.82rem;font-weight:600}
  .foot{padding:18px 26px 24px;border-top:1px solid #E9E4D6;font-size:.76rem;color:#726C60;line-height:1.7}
  .foot a{color:#4B5040;font-weight:600}
  .empty{width:min(460px,100%);margin:56px auto;text-align:center;color:#726C60;line-height:1.7}
  .empty h1{font-size:1.24rem;color:#211F1B;margin:0 0 10px}
  @media print{body{background:#fff;padding:0}.sheet{border:0;box-shadow:none}}
`;

function page(title, inner) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${SHELL_STYLES}</style></head><body>${inner}</body></html>`;
}

export function renderInvoiceNotFound() {
  return page("Factura no disponible", `<div class="empty">
    <h1>Esta factura ya no está disponible</h1>
    <p>Puede que se haya anulado o corregido. Escríbenos por WhatsApp al
    <a href="https://wa.me/18296679289">829-667-9289</a> y te la reenviamos.</p>
  </div>`);
}

export function renderInvoiceHtml(view) {
  const rows = view.lines.map((line) => {
    const adjustments = [];
    if (line.extra) adjustments.push(`Extra ${money(line.extra)}`);
    if (line.descuento) adjustments.push(`Descuento −${money(line.descuento)}`);
    return `<tr>
      <td>
        <span class="svc">${esc(line.servicio)}</span>
        ${line.colaboradora ? `<span class="who">con ${esc(line.colaboradora)}</span>` : ""}
        ${adjustments.length ? `<span class="adj">${esc(adjustments.join(" · "))}</span>` : ""}
      </td>
      <td class="num">${line.cantidad}</td>
      <td class="num">${money(line.total)}</td>
    </tr>`;
  }).join("");

  const subtotal = view.lines.reduce((sum, line) => sum + line.total, 0);

  return page(`Factura ${view.id} · Dalfi Studio Nails`, `<div class="sheet">
  <div class="head">
    <p class="brand">Dalfi <em>Studio Nails &amp; Academy</em></p>
    <p class="meta">
      <strong>Factura ${esc(view.id)}</strong><br>
      ${esc(view.clienteNombre)}${view.fecha ? ` · ${esc(view.fecha)}` : ""}
      ${view.colaboradora ? `<br>Atendida por ${esc(view.colaboradora)}` : ""}
    </p>
  </div>
  <div class="body">
    <table>
      <thead><tr><th>Servicio</th><th class="num">Cant.</th><th class="num">Importe</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="3">Sin servicios registrados.</td></tr>`}</tbody>
    </table>
    <div class="totals">
      <div><span>Subtotal</span><span>${money(subtotal)}</span></div>
      ${view.propina ? `<div><span>Propina</span><span>${money(view.propina)}</span></div>` : ""}
      <div class="grand"><span>Total</span><span>${money(view.total)}</span></div>
    </div>
    ${view.pendiente > 0 ? `<p class="due">Pendiente por pagar: ${money(view.pendiente)}</p>` : ""}
  </div>
  <div class="foot">
    Calle Juan Caballero No. 38 · Baní, Peravia<br>
    WhatsApp <a href="https://wa.me/18296679289">829-667-9289</a> ·
    <a href="https://nails.dalfistudio.com">nails.dalfistudio.com</a><br>
    Gracias por tu visita. Si algo no cuadra, escríbenos y lo revisamos.
  </div>
</div>`);
}
