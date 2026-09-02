import nodemailer from "nodemailer";

// Avisos internos por correo para el personal de Dalfi Studio Nails (nueva reserva por revisar,
// comprobante de depósito subido, recordatorio horario mientras siga sin revisar). Se manda
// desde/hacia la misma cuenta (GMAIL_USER, dalfistudionails@gmail.com se notifica a sí misma)
// usando Gmail SMTP con una contraseña de aplicación -- gratis, sin proveedor externo. Si las
// variables no están configuradas, se registra un aviso y se sigue de largo: un correo que no
// sale nunca debe tumbar la reserva, el comprobante o el recordatorio que lo disparó.
let cachedTransporter = null;
let cachedKey = null;

// createTransportImpl inyectable (pruebas usan un doble en memoria, nunca SMTP real) -- mismo
// patrón que fetchImpl en el resto del proyecto (workers/*, syncAppointmentToGoogleCalendar).
function getTransporter(env, createTransportImpl = nodemailer.createTransport) {
  const user = env.GMAIL_USER;
  const pass = env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  const key = `${user}:${pass}`;
  if (cachedTransporter && cachedKey === key) return cachedTransporter;
  cachedTransporter = createTransportImpl({ service: "gmail", auth: { user, pass } });
  cachedKey = key;
  return cachedTransporter;
}

// Se limpia entre pruebas para que un test no reutilice el transporter (real o doble) de otro.
export function resetTransporterCache() {
  cachedTransporter = null;
  cachedKey = null;
}

export async function sendBusinessEmail(env, { subject, html, text }, createTransportImpl = nodemailer.createTransport) {
  const transporter = getTransporter(env, createTransportImpl);
  if (!transporter) {
    console.warn("email: GMAIL_USER/GMAIL_APP_PASSWORD no configurados -- correo no enviado:", subject);
    return { sent: false, reason: "not_configured" };
  }
  try {
    await transporter.sendMail({ from: env.GMAIL_USER, to: env.GMAIL_USER, subject, text, html });
    return { sent: true };
  } catch (error) {
    console.error("email: fallo enviando correo:", subject, error.message);
    return { sent: false, reason: "send_failed", error: error.message };
  }
}

function aptLine({ legacyId, clientName, serviceName, staffName, date, time }) {
  return `Reserva ${legacyId} -- ${clientName || "Cliente"} -- ${serviceName || "Servicio"} con ${staffName || "colaboradora"} -- ${date} ${time}`;
}

// Cada cita nueva, sin importar el canal por el que se creó -- todavía no aparta el horario
// (ver neon/migrations/0024), así que esto es un aviso para que el personal la tenga en la mira,
// no una confirmación de nada.
export async function notifyNewAppointment(env, appointment, createTransportImpl = nodemailer.createTransport) {
  const line = aptLine(appointment);
  return sendBusinessEmail(env, {
    subject: `Nueva reserva por revisar -- ${appointment.clientName || "Cliente"}`,
    text: `${line}\n\nTodavía no está confirmada: falta que se confirme el depósito de RD$500. Al revisarla, confírmala en ReservApp.`,
    html: `<p>${line}</p><p>Todavía no está confirmada: falta que se confirme el depósito de RD$500. Al revisarla, confírmala en ReservApp.</p>`,
  }, createTransportImpl);
}

// La clienta subió su foto del comprobante -- listo para que el personal lo revise y
// apruebe/rechace en ReservApp.
export async function notifyDepositReceiptUploaded(env, appointment, createTransportImpl = nodemailer.createTransport) {
  const line = aptLine(appointment);
  return sendBusinessEmail(env, {
    subject: `Comprobante de depósito subido -- ${appointment.clientName || "Cliente"}`,
    text: `${line}\n\nLa clienta ya subió su comprobante de depósito. Revísalo y confirma o rechaza la reserva en ReservApp.`,
    html: `<p>${line}</p><p>La clienta ya subió su comprobante de depósito. Revísalo y confirma o rechaza la reserva en ReservApp.</p>`,
  }, createTransportImpl);
}

// Recordatorio horario (solo dentro de la ventana de negocio, ver isWithinDepositReminderWindow
// en server/app.mjs) mientras un comprobante siga subido sin que el personal lo confirme o
// rechace.
export async function notifyDepositReviewPending(env, appointment, createTransportImpl = nodemailer.createTransport) {
  const line = aptLine(appointment);
  return sendBusinessEmail(env, {
    subject: `Recordatorio: comprobante pendiente de revisar -- ${appointment.clientName || "Cliente"}`,
    text: `${line}\n\nSigue sin revisarse el comprobante de depósito. El horario no queda apartado hasta que lo confirmes o lo rechaces desde SSC.`,
    html: `<p>${line}</p><p>Sigue sin revisarse el comprobante de depósito. El horario no queda apartado hasta que lo confirmes o lo rechaces desde SSC.</p>`,
  }, createTransportImpl);
}
