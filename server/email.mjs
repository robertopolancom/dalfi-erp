import nodemailer from "nodemailer";
import { promises as dnsPromises } from "node:dns";

// Avisos internos por correo para el personal de Dalfi Studio Nails (nueva reserva por revisar,
// comprobante de depósito subido, cita cancelada, cliente que confirma su hora, recordatorio
// horario mientras un comprobante siga sin revisar). Se manda desde/hacia la misma cuenta
// (GMAIL_USER, dalfistudionails@gmail.com se notifica a sí misma) usando Gmail SMTP con una
// contraseña de aplicación -- gratis, sin proveedor externo. Si las variables no están
// configuradas, se registra un aviso y se sigue de largo: un correo que no sale nunca debe
// tumbar la reserva, el comprobante o el recordatorio que lo disparó.

// --- Por qué resolvemos la IP nosotros y no dejamos que lo haga nodemailer ---------------
// Con `service: "gmail"` nodemailer resuelve smtp.gmail.com por su cuenta: pide los registros A
// Y los AAAA, los junta, y elige UNA AL AZAR (lib/shared/index.js, formatDNSValue). Decide si
// pedir AAAA mirando os.networkInterfaces(): el contenedor de Render TIENE una interfaz IPv6, lo
// que no tiene es ruta de salida por IPv6. Resultado: cada envío se jugaba a los dados salir por
// una dirección inalcanzable, y entre el 2 y el 5 de septiembre de 2026 los 12 avisos que generó
// ReservApp fallaron ("connect ENETUNREACH 2607:f8b0:...:465" o "Connection timeout"): ni una
// sola reserva llegó a dalfistudionails@gmail.com.
//
// Cuando el host ya es una IP, nodemailer se salta su resolución (net.isIP -> "nothing to do
// here"), así que le entregamos una IPv4 concreta. El certificado lo emite Google para
// smtp.gmail.com y no para la IP, por eso va `tls.servername`: el handshake sigue validando el
// nombre real, no se debilita nada.
const SMTP_HOST = "smtp.gmail.com";

// --- Y por qué se prueban dos puertos ----------------------------------------------------
// Arreglado lo de IPv6, el primer envío real (2026-09-06 17:25) siguió fallando, pero ya con la
// IPv4 correcta y con otro error: "fallo enviando por 173.194.202.109 ... Connection timeout".
// El 465 no sale de Render: no lo rechazan, se queda colgado hasta el timeout.
//
// Recorrer direcciones no ayudaba, porque dns.resolve4("smtp.gmail.com") devuelve UNA sola IPv4 y
// el bucle daba una vuelta. Lo que hay que variar es el puerto. Gmail acepta 587 con STARTTLS y
// 465 con TLS implícito; se prueba 587 primero, que es el que suelen dejar abierto los
// proveedores que filtran salida SMTP.
const SMTP_ENDPOINTS = [
  // requireTLS: sin esto, si el servidor no ofreciera STARTTLS nodemailer seguiría en claro, y
  // ahí viajarían la contraseña de aplicación y el correo entero.
  { port: 587, secure: false, requireTLS: true },
  { port: 465, secure: true },
];
// Las IPs de Gmail rotan; se recuerdan cinco minutos (el mismo TTL que usa nodemailer para su
// propia caché) y se vuelven a pedir. Al volumen de este salón -- unos pocos correos al día --
// resolver de nuevo no cuesta nada.
const ADDRESS_TTL_MS = 5 * 60 * 1000;

let cachedAddresses = [];
let cachedAddressesExpire = 0;

async function smtpAddresses(resolve4Impl) {
  const now = Date.now();
  if (cachedAddresses.length && now < cachedAddressesExpire) return cachedAddresses;
  const addresses = await resolve4Impl(SMTP_HOST);
  if (!addresses?.length) throw new Error(`${SMTP_HOST} no devolvió ninguna dirección IPv4`);
  cachedAddresses = addresses;
  cachedAddressesExpire = now + ADDRESS_TTL_MS;
  return cachedAddresses;
}

// Se limpia entre pruebas para que un test no reutilice las direcciones que cacheó otro.
export function resetEmailCaches() {
  cachedAddresses = [];
  cachedAddressesExpire = 0;
}

// Solo se prueba la siguiente IP cuando el fallo fue de red. Si Gmail rechaza la contraseña de
// aplicación (EAUTH) o el mensaje (EENVELOPE), reintentar contra las otras tres direcciones da
// exactamente el mismo error cuatro veces y son cuatro autenticaciones fallidas seguidas contra
// la cuenta -- justo lo que hace que Google la bloquee.
const RETRYABLE_CODES = new Set([
  "ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "EDNS",
]);

// --- Resend: el transporte que de verdad sale de Render ------------------------------------
// Render bloquea la salida SMTP. Comprobado el 2026-09-06 con dos reservas reales: 587 y 465, los
// dos con "Connection timeout" tras 15 segundos, y ya con la IPv4 correcta. No es Gmail, no son
// las credenciales, no es IPv6 (eso se arregló antes y no bastó): es política del proveedor.
//
// Resend manda por HTTPS, así que el bloqueo deja de importar. El camino SMTP de más abajo se
// queda para correr fuera de Render (local, o si algún día se muda el alojamiento); si hay
// RESEND_API_KEY, gana Resend.
const RESEND_ENDPOINT = "https://api.resend.com/emails";

// "Dalfi Studio Nails <info@dalfistudio.com>" -> "info@dalfistudio.com". Con un remitente sin
// nombre ("info@dalfistudio.com" a secas) devuelve la cadena tal cual.
function addressOf(from) {
  const match = /<([^>]+)>/.exec(from);
  return (match ? match[1] : from).trim();
}

async function sendViaResend(env, { subject, html, text, to, replyTo, attachments }, fetchImpl) {
  const from = String(env.RESEND_FROM || "").trim();
  if (!from) {
    console.error("email: RESEND_API_KEY está puesta pero falta RESEND_FROM -- no se envió:", subject);
    return { sent: false, reason: "resend_from_missing" };
  }
  let response;
  try {
    response = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: [to], reply_to: replyTo, subject, html, text,
        // Resend espera el contenido en base64, igual que ya lo tenemos guardado para los
        // comprobantes de depósito -- no hay que convertir nada.
        ...(attachments?.length
          ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })) }
          : {}),
      }),
    });
  } catch (error) {
    console.error("email: no se pudo llamar a Resend --", error.message);
    return { sent: false, reason: "resend_unreachable", error: error.message };
  }
  if (!response.ok) {
    // El cuerpo de Resend dice POR QUÉ (dominio sin verificar, remitente ajeno, clave mala). Sin
    // esto volveríamos al punto de partida: saber que falla y no saber de qué.
    const detail = await response.text().catch(() => "");
    console.error(`email: Resend rechazó el envío (${response.status}):`, subject, detail.slice(0, 300));
    return { sent: false, reason: "resend_rejected", error: `${response.status} ${detail.slice(0, 200)}` };
  }
  console.log("email: enviado por Resend --", subject);
  return { sent: true, via: "resend" };
}

// `to` opcional: sin él sigue siendo el aviso interno de siempre (la cuenta se escribe a sí
// misma). Con `to` se le manda a una clienta -- hoy solo lo usa el envío de facturas.
// createTransportImpl/resolve4Impl inyectables (las pruebas usan dobles en memoria, nunca SMTP ni
// DNS reales) -- mismo patrón que fetchImpl en el resto del proyecto.
export async function sendBusinessEmail(
  env,
  { subject, html, text, to = null, attachments = null },
  createTransportImpl = nodemailer.createTransport,
  resolve4Impl = dnsPromises.resolve4,
  fetchImpl = globalThis.fetch,
) {
  const user = env.GMAIL_USER;
  const pass = env.GMAIL_APP_PASSWORD;
  const destino = to || user;
  // Responder a un aviso tiene que llegar al mismo buzón que aparece como remitente. Antes el
  // Reply-To era GMAIL_USER, así que una clienta que respondiera a su factura le escribía a
  // dalfistudionails@gmail.com aunque viera info@dalfistudio.com -- justo la dirección que Roberto
  // está retirando de cara al público (pedido del 2026-09-06). Se deriva del propio RESEND_FROM en
  // vez de meter otra variable, para que no puedan quedar desalineados; Cloudflare Email Routing
  // reenvía info@ al buzón del salón. RESEND_REPLY_TO existe por si algún día conviene separarlos.
  const replyTo = String(env.RESEND_REPLY_TO || "").trim()
    || (env.RESEND_FROM ? addressOf(env.RESEND_FROM) : "")
    || user;
  if (env.RESEND_API_KEY) {
    if (!destino) {
      console.error("email: no hay destinatario (falta `to` y GMAIL_USER) -- no se envió:", subject);
      return { sent: false, reason: "no_recipient" };
    }
    return sendViaResend(env, { subject, html, text, to: destino, replyTo, attachments }, fetchImpl);
  }
  if (!user || !pass) {
    console.warn("email: sin RESEND_API_KEY ni GMAIL_USER/GMAIL_APP_PASSWORD -- correo no enviado:", subject);
    return { sent: false, reason: "not_configured" };
  }

  let addresses;
  try {
    addresses = await smtpAddresses(resolve4Impl);
  } catch (error) {
    console.error(`email: no se pudo resolver ${SMTP_HOST} --`, error.message);
    return { sent: false, reason: "dns_failed", error: error.message };
  }

  const message = {
    from: user, to: destino, replyTo, subject, text, html,
    ...(attachments?.length ? { attachments } : {}),
  };

  let lastError = null;
  for (const endpoint of SMTP_ENDPOINTS) {
    for (const address of addresses) {
      const transporter = createTransportImpl({
        host: address,
        ...endpoint,
        tls: { servername: SMTP_HOST },
        auth: { user, pass },
        // Por debajo del defecto de nodemailer (2 minutos): estos envíos salen DESPUÉS de haberle
        // respondido a la clienta, y la instancia de Render es del plan gratis -- colgarse dos
        // minutos por intento es tiempo en el que el contenedor puede irse a dormir con el correo
        // a medias. Con dos puertos, el peor caso completo queda por debajo del minuto.
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
      });
      try {
        await transporter.sendMail(message);
        // Rastro también cuando SÍ sale. Durante días el único síntoma fue el silencio, y "no hay
        // error en el log" no es lo mismo que "el correo llegó". Además deja escrito qué puerto
        // funciona desde este proveedor, que es el dato que costó encontrar.
        console.log(`email: enviado por ${address}:${endpoint.port} --`, subject);
        return { sent: true, port: endpoint.port };
      } catch (error) {
        lastError = error;
        console.error(`email: fallo enviando por ${address}:${endpoint.port}:`, subject, error.message);
        // Un fallo que no es de red (contraseña, destinatario) da igual por dónde se intente.
        if (!RETRYABLE_CODES.has(error.code)) return { sent: false, reason: "send_failed", error: error.message };
      }
    }
  }
  return { sent: false, reason: "send_failed", error: lastError?.message };
}

function aptLine({ legacyId, clientName, serviceName, staffName, date, time }) {
  return `Reserva ${legacyId} -- ${clientName || "Cliente"} -- ${serviceName || "Servicio"} con ${staffName || "colaboradora"} -- ${date} ${time}`;
}

// Cada cita nueva, sin importar el canal por el que se creó -- todavía no aparta el horario
// (ver neon/migrations/0024), así que esto es un aviso para que el personal la tenga en la mira,
// no una confirmación de nada.
export async function notifyNewAppointment(env, appointment, createTransportImpl = nodemailer.createTransport, resolve4Impl = dnsPromises.resolve4, fetchImpl = globalThis.fetch) {
  const line = aptLine(appointment);
  return sendBusinessEmail(env, {
    subject: `Nueva reserva por revisar -- ${appointment.clientName || "Cliente"}`,
    text: `${line}\n\nTodavía no está confirmada: falta que se confirme el depósito de RD$500. Al revisarla, confírmala en ReservApp.`,
    html: `<p>${line}</p><p>Todavía no está confirmada: falta que se confirme el depósito de RD$500. Al revisarla, confírmala en ReservApp.</p>`,
  }, createTransportImpl, resolve4Impl, fetchImpl);
}

// La clienta subió su foto del comprobante -- listo para que el personal lo revise y
// apruebe/rechace en ReservApp. La foto va ADJUNTA (receiptBase64/receiptMimeType, opcionales):
// pedido de Roberto 2026-09-05, "que se envíe por correo a dalfistudionails@gmail.com ... para
// que tenga la información a mano" -- así el correo se basta solo, sin tener que abrir ReservApp
// para ver de qué depósito se trata. Sin foto (llamada vieja) el correo sale igual, solo sin
// adjunto.
export async function notifyDepositReceiptUploaded(env, appointment, createTransportImpl = nodemailer.createTransport, resolve4Impl = dnsPromises.resolve4, fetchImpl = globalThis.fetch) {
  const line = aptLine(appointment);
  const amount = `RD$${Number(appointment.depositAmount) > 0 ? appointment.depositAmount : 500}`;
  const attachments = appointment.receiptBase64
    ? [{
        filename: `comprobante-${appointment.legacyId || "deposito"}.${MIME_EXTENSIONS[appointment.receiptMimeType] || "jpg"}`,
        content: appointment.receiptBase64,
        encoding: "base64",
        contentType: appointment.receiptMimeType || "image/jpeg",
      }]
    : null;
  const attachedNote = attachments
    ? "El comprobante va adjunto a este correo."
    : "El comprobante quedó guardado en ReservApp (no se pudo adjuntar la foto a este correo).";
  return sendBusinessEmail(env, {
    subject: `Comprobante de depósito subido -- ${appointment.clientName || "Cliente"}`,
    text: `${line}\nDepósito: ${amount}\n\nLa clienta ya subió su comprobante de depósito. ${attachedNote} Revísalo y confirma o rechaza la reserva en ReservApp.`,
    html: `<p>${line}</p><p>Depósito: <strong>${amount}</strong></p><p>La clienta ya subió su comprobante de depósito. ${attachedNote} Revísalo y confirma o rechaza la reserva en ReservApp.</p>`,
    attachments,
  }, createTransportImpl, resolve4Impl, fetchImpl);
}

const MIME_EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// Una cita que estaba en la agenda deja de estarlo. Se avisa aunque la cancelación la haya hecho
// el propio personal: quien cancela desde el mostrador no siempre es quien tenía el turno
// apartado, y el correo deja el rastro con la hora que queda libre. `reason` es opcional.
export async function notifyAppointmentCancelled(env, appointment, createTransportImpl = nodemailer.createTransport, resolve4Impl = dnsPromises.resolve4, fetchImpl = globalThis.fetch) {
  const line = aptLine(appointment);
  const reason = appointment.reason ? `\nMotivo: ${appointment.reason}` : "";
  const reasonHtml = appointment.reason ? `<p>Motivo: ${appointment.reason}</p>` : "";
  return sendBusinessEmail(env, {
    subject: `Cita cancelada -- ${appointment.clientName || "Cliente"}`,
    text: `${line}${reason}\n\nEse horario vuelve a quedar libre en la agenda.`,
    html: `<p>${line}</p>${reasonHtml}<p>Ese horario vuelve a quedar libre en la agenda.</p>`,
  }, createTransportImpl, resolve4Impl, fetchImpl);
}

// La clienta respondió que sí viene (el "1" del recordatorio por WhatsApp, o el botón de
// confirmar en ReservApp). Es el único cambio de estatus que NO hace el personal, así que es el
// que de verdad hay que contarle a alguien.
export async function notifyAppointmentConfirmedByClient(env, appointment, createTransportImpl = nodemailer.createTransport, resolve4Impl = dnsPromises.resolve4, fetchImpl = globalThis.fetch) {
  const line = aptLine(appointment);
  return sendBusinessEmail(env, {
    subject: `La clienta confirmó su hora -- ${appointment.clientName || "Cliente"}`,
    text: `${line}\n\nConfirmó que asistirá. Si todavía falta el depósito, el horario sigue sin apartarse.`,
    html: `<p>${line}</p><p>Confirmó que asistirá. Si todavía falta el depósito, el horario sigue sin apartarse.</p>`,
  }, createTransportImpl, resolve4Impl, fetchImpl);
}

// Recordatorio horario (solo dentro de la ventana de negocio, ver isWithinDepositReminderWindow
// en server/app.mjs) mientras un comprobante siga subido sin que el personal lo confirme o
// rechace.
export async function notifyDepositReviewPending(env, appointment, createTransportImpl = nodemailer.createTransport, resolve4Impl = dnsPromises.resolve4, fetchImpl = globalThis.fetch) {
  const line = aptLine(appointment);
  return sendBusinessEmail(env, {
    subject: `Recordatorio: comprobante pendiente de revisar -- ${appointment.clientName || "Cliente"}`,
    text: `${line}\n\nSigue sin revisarse el comprobante de depósito. El horario no queda apartado hasta que lo confirmes o lo rechaces desde SSC.`,
    html: `<p>${line}</p><p>Sigue sin revisarse el comprobante de depósito. El horario no queda apartado hasta que lo confirmes o lo rechaces desde SSC.</p>`,
  }, createTransportImpl, resolve4Impl, fetchImpl);
}

// Factura para la clienta. El correo NO lleva la factura adjunta: lleva el enlace, que arma la
// factura desde los datos vivos del ERP en el momento en que se abre (ver server/invoice-link.mjs).
// Así no queda ningún archivo guardado y el enlace siempre muestra la versión buena.
export async function sendInvoiceEmail(env, { to, clientName, invoiceId, url, total }, createTransportImpl = nodemailer.createTransport, resolve4Impl = dnsPromises.resolve4, fetchImpl = globalThis.fetch) {
  const amount = `RD$ ${(Number(total) || 0).toLocaleString("es-DO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const greeting = `Hola ${clientName || ""}`.trim();
  return sendBusinessEmail(env, {
    to,
    subject: `Tu factura ${invoiceId} -- Dalfi Studio Nails`,
    text: `${greeting},\n\nAquí está tu factura ${invoiceId} por ${amount}:\n${url}\n\nGracias por tu visita.\nDalfi Studio Nails & Academy -- Juan Caballero 38, Baní`,
    html: `<p>${greeting},</p><p>Aquí está tu factura <strong>${invoiceId}</strong> por <strong>${amount}</strong>:</p>`
        + `<p><a href="${url}">Ver mi factura</a></p>`
        + `<p>Gracias por tu visita.<br>Dalfi Studio Nails &amp; Academy -- Juan Caballero 38, Baní</p>`,
  }, createTransportImpl, resolve4Impl, fetchImpl);
}
