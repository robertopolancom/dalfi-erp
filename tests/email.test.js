import assert from "node:assert/strict";
import test from "node:test";
import {
  sendBusinessEmail,
  notifyNewAppointment,
  notifyDepositReceiptUploaded,
  notifyDepositReviewPending,
  resetTransporterCache,
} from "../server/email.mjs";

// server/email.mjs: nunca toca SMTP real. createTransportImpl es un doble en memoria que
// registra lo que se hubiera enviado -- mismo patrón que fetchImpl en el resto del proyecto.
function fakeCreateTransport(calls, { fail = false } = {}) {
  return () => ({
    async sendMail(message) {
      calls.push(message);
      if (fail) throw new Error("SMTP no disponible (simulado)");
      return { messageId: "fake" };
    },
  });
}

const ENV = { GMAIL_USER: "dalfistudionails@gmail.com", GMAIL_APP_PASSWORD: "app-password-fake" };
const APT = { legacyId: "RES-1", clientName: "María Pérez", serviceName: "Manicura", staffName: "Ana", date: "2026-09-05", time: "15:30" };

test.beforeEach(() => resetTransporterCache());

test("sendBusinessEmail(): sin GMAIL_USER/GMAIL_APP_PASSWORD, no manda nada y responde not_configured", async () => {
  const calls = [];
  const result = await sendBusinessEmail({}, { subject: "x", text: "y", html: "<p>y</p>" }, fakeCreateTransport(calls));
  assert.deepEqual(result, { sent: false, reason: "not_configured" });
  assert.equal(calls.length, 0);
});

test("sendBusinessEmail(): con credenciales, manda el correo desde/hacia GMAIL_USER", async () => {
  const calls = [];
  const result = await sendBusinessEmail(ENV, { subject: "Asunto", text: "Texto", html: "<p>Texto</p>" }, fakeCreateTransport(calls));
  assert.deepEqual(result, { sent: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].from, ENV.GMAIL_USER);
  assert.equal(calls[0].to, ENV.GMAIL_USER);
  assert.equal(calls[0].subject, "Asunto");
});

test("sendBusinessEmail(): si el envío falla, no lanza -- responde send_failed con el motivo", async () => {
  const calls = [];
  const result = await sendBusinessEmail(ENV, { subject: "x", text: "y", html: "<p>y</p>" }, fakeCreateTransport(calls, { fail: true }));
  assert.equal(result.sent, false);
  assert.equal(result.reason, "send_failed");
  assert.match(result.error, /SMTP no disponible/);
});

test("notifyNewAppointment(): asunto y cuerpo mencionan que todavía no está confirmada", async () => {
  const calls = [];
  await notifyNewAppointment(ENV, APT, fakeCreateTransport(calls));
  assert.equal(calls.length, 1);
  assert.match(calls[0].subject, /Nueva reserva por revisar/);
  assert.match(calls[0].subject, /María Pérez/);
  assert.match(calls[0].text, /RES-1/);
  assert.match(calls[0].text, /Todavía no está confirmada/);
});

test("notifyDepositReceiptUploaded(): asunto y cuerpo piden revisar el comprobante", async () => {
  const calls = [];
  await notifyDepositReceiptUploaded(ENV, APT, fakeCreateTransport(calls));
  assert.equal(calls.length, 1);
  assert.match(calls[0].subject, /Comprobante de depósito subido/);
  assert.match(calls[0].text, /ya subió su comprobante/);
});

test("notifyDepositReviewPending(): asunto y cuerpo son un recordatorio, no una confirmación", async () => {
  const calls = [];
  await notifyDepositReviewPending(ENV, APT, fakeCreateTransport(calls));
  assert.equal(calls.length, 1);
  assert.match(calls[0].subject, /Recordatorio/);
  assert.match(calls[0].text, /no queda apartado/);
});
