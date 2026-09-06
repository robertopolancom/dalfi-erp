import assert from "node:assert/strict";
import test from "node:test";
import {
  sendBusinessEmail,
  notifyNewAppointment,
  notifyDepositReceiptUploaded,
  notifyDepositReviewPending,
  notifyAppointmentCancelled,
  notifyAppointmentConfirmedByClient,
  resetEmailCaches,
} from "../server/email.mjs";

// server/email.mjs: nunca toca SMTP ni DNS reales. createTransportImpl y resolve4Impl son dobles
// en memoria que registran lo que se hubiera enviado -- mismo patrón que fetchImpl en el resto
// del proyecto.
function fakeCreateTransport(calls, { fail = false, options = [] } = {}) {
  return (opts) => {
    options.push(opts);
    return {
      async sendMail(message) {
        calls.push(message);
        if (fail) throw new Error("SMTP no disponible (simulado)");
        return { messageId: "fake" };
      },
    };
  };
}

// Lo que devuelve dns.resolve4("smtp.gmail.com"): solo A, nunca AAAA.
const IPV4 = ["142.250.115.109", "142.250.115.108"];
const fakeResolve4 = async () => IPV4;

const ENV = { GMAIL_USER: "dalfistudionails@gmail.com", GMAIL_APP_PASSWORD: "app-password-fake" };
const APT = { legacyId: "RES-1", clientName: "María Pérez", serviceName: "Manicura", staffName: "Ana", date: "2026-09-05", time: "15:30" };

test.beforeEach(() => resetEmailCaches());

test("sendBusinessEmail(): sin GMAIL_USER/GMAIL_APP_PASSWORD, no manda nada y responde not_configured", async () => {
  const calls = [];
  const result = await sendBusinessEmail({}, { subject: "x", text: "y", html: "<p>y</p>" }, fakeCreateTransport(calls), fakeResolve4);
  assert.deepEqual(result, { sent: false, reason: "not_configured" });
  assert.equal(calls.length, 0);
});

test("sendBusinessEmail(): con credenciales, manda el correo desde/hacia GMAIL_USER", async () => {
  const calls = [];
  const result = await sendBusinessEmail(ENV, { subject: "Asunto", text: "Texto", html: "<p>Texto</p>" }, fakeCreateTransport(calls), fakeResolve4);
  assert.deepEqual(result, { sent: true, port: 587 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].from, ENV.GMAIL_USER);
  assert.equal(calls[0].to, ENV.GMAIL_USER);
  assert.equal(calls[0].subject, "Asunto");
});

test("sendBusinessEmail(): si el envío falla, no lanza -- responde send_failed con el motivo", async () => {
  const calls = [];
  const result = await sendBusinessEmail(ENV, { subject: "x", text: "y", html: "<p>y</p>" }, fakeCreateTransport(calls, { fail: true }), fakeResolve4);
  assert.equal(result.sent, false);
  assert.equal(result.reason, "send_failed");
  assert.match(result.error, /SMTP no disponible/);
});

test("notifyNewAppointment(): asunto y cuerpo mencionan que todavía no está confirmada", async () => {
  const calls = [];
  await notifyNewAppointment(ENV, APT, fakeCreateTransport(calls), fakeResolve4);
  assert.equal(calls.length, 1);
  assert.match(calls[0].subject, /Nueva reserva por revisar/);
  assert.match(calls[0].subject, /María Pérez/);
  assert.match(calls[0].text, /RES-1/);
  assert.match(calls[0].text, /Todavía no está confirmada/);
});

test("notifyDepositReceiptUploaded(): asunto y cuerpo piden revisar el comprobante", async () => {
  const calls = [];
  await notifyDepositReceiptUploaded(ENV, APT, fakeCreateTransport(calls), fakeResolve4);
  assert.equal(calls.length, 1);
  assert.match(calls[0].subject, /Comprobante de depósito subido/);
  assert.match(calls[0].text, /ya subió su comprobante/);
});

test("notifyDepositReviewPending(): asunto y cuerpo son un recordatorio, no una confirmación", async () => {
  const calls = [];
  await notifyDepositReviewPending(ENV, APT, fakeCreateTransport(calls), fakeResolve4);
  assert.equal(calls.length, 1);
  assert.match(calls[0].subject, /Recordatorio/);
  assert.match(calls[0].text, /no queda apartado/);
});

test("notifyAppointmentCancelled(): dice qué horario queda libre y arrastra el motivo", async () => {
  const calls = [];
  await notifyAppointmentCancelled(ENV, { ...APT, reason: "La clienta no puede" }, fakeCreateTransport(calls), fakeResolve4);
  assert.equal(calls.length, 1);
  assert.match(calls[0].subject, /Cita cancelada/);
  assert.match(calls[0].text, /RES-1/);
  assert.match(calls[0].text, /La clienta no puede/);
  assert.match(calls[0].text, /vuelve a quedar libre/);
});

test("notifyAppointmentCancelled(): sin motivo no inventa una línea vacía", async () => {
  const calls = [];
  await notifyAppointmentCancelled(ENV, APT, fakeCreateTransport(calls), fakeResolve4);
  assert.ok(!calls[0].text.includes("Motivo:"));
  assert.ok(!calls[0].html.includes("Motivo:"));
});

test("notifyAppointmentConfirmedByClient(): deja claro que el depósito sigue mandando", async () => {
  const calls = [];
  await notifyAppointmentConfirmedByClient(ENV, APT, fakeCreateTransport(calls), fakeResolve4);
  assert.match(calls[0].subject, /confirmó su hora/);
  assert.match(calls[0].text, /sigue sin apartarse/);
});

// --- Lo que rompió el envío durante días: nodemailer salía por IPv6 ------------------------
// Con `service: "gmail"` nodemailer resolvía A y AAAA y elegía una al azar; Render tiene interfaz
// IPv6 pero no ruta de salida, así que el envío se jugaba a los dados y perdía. Estas pruebas
// fijan que ahora la conexión SIEMPRE va a una IPv4 concreta.
test("la conexión se abre contra una IPv4 resuelta, nunca contra el hostname", async () => {
  const calls = [];
  const options = [];
  const r = await sendBusinessEmail(ENV, { subject: "x", text: "y", html: "<p>y</p>" }, fakeCreateTransport(calls, { options }), fakeResolve4);
  assert.deepEqual(r, { sent: true, port: 587 });
  assert.equal(options.length, 1);
  assert.equal(options[0].host, IPV4[0], "el host tiene que ser la IP ya resuelta");
  assert.ok(!options[0].service, "`service: gmail` es justo lo que devolvía la resolución al azar");
});

test("se intenta primero 587 con STARTTLS, y sólo si falla el 465", async () => {
  // El 465 se queda colgado desde Render (Connection timeout, 2026-09-06), así que el orden
  // importa: el primer intento tiene que ser el puerto que sí suele estar abierto.
  const options = [];
  const createTransport = (opts) => {
    options.push(opts);
    return { async sendMail() {
      if (opts.port === 587) { const e = new Error("Connection timeout"); e.code = "ETIMEDOUT"; throw e; }
      return { messageId: "fake" };
    } };
  };
  const r = await sendBusinessEmail(ENV, { subject: "x", text: "y", html: "<p>y</p>" }, createTransport, fakeResolve4);
  assert.deepEqual(r, { sent: true, port: 465 });
  assert.deepEqual(options.map((o) => o.port), [587, 587, 465], "las dos IPs del 587, luego el 465");
  assert.equal(options[0].secure, false, "587 va con STARTTLS");
  assert.equal(options[0].requireTLS, true, "sin requireTLS podría acabar mandando en claro");
  assert.equal(options[2].secure, true, "465 va con TLS implícito");
});

test("se conserva el servername para que TLS siga validando smtp.gmail.com", async () => {
  const calls = [];
  const options = [];
  await sendBusinessEmail(ENV, { subject: "x", text: "y", html: "<p>y</p>" }, fakeCreateTransport(calls, { options }), fakeResolve4);
  // El certificado es de smtp.gmail.com, no de la IP: sin esto el handshake fallaría, y bajar
  // rejectUnauthorized para taparlo sería cambiar un correo perdido por una conexión sin validar.
  assert.equal(options[0].tls.servername, "smtp.gmail.com");
  assert.ok(!("rejectUnauthorized" in options[0].tls), "nunca se desactiva la validación del certificado");
});

test("si una dirección no responde, se prueba la siguiente", async () => {
  const options = [];
  const createTransport = (opts) => {
    options.push(opts);
    return { async sendMail() {
      if (opts.host === IPV4[0]) { const e = new Error("connect ETIMEDOUT"); e.code = "ETIMEDOUT"; throw e; }
      return { messageId: "fake" };
    } };
  };
  const result = await sendBusinessEmail(ENV, { subject: "x", text: "y", html: "<p>y</p>" }, createTransport, fakeResolve4);
  assert.equal(result.sent, true);
  assert.deepEqual(options.map((o) => o.host), IPV4, "probó las dos, en orden");
});

test("una contraseña rechazada NO se reintenta contra otro puerto ni otra dirección", async () => {
  // Varias autenticaciones fallidas seguidas es lo que hace que Google bloquee la cuenta: si el
  // problema es la credencial, cambiar de puerto o de IP no lo arregla.
  const options = [];
  const createTransport = (opts) => {
    options.push(opts);
    return { async sendMail() { const e = new Error("Invalid login"); e.code = "EAUTH"; throw e; } };
  };
  const result = await sendBusinessEmail(ENV, { subject: "x", text: "y", html: "<p>y</p>" }, createTransport, fakeResolve4);
  assert.equal(result.sent, false);
  assert.equal(result.reason, "send_failed");
  assert.equal(options.length, 1, "un solo intento de autenticación");
});

test("si el DNS no devuelve ninguna IPv4, se dice por qué en vez de fallar en silencio", async () => {
  const calls = [];
  const result = await sendBusinessEmail(ENV, { subject: "x", text: "y", html: "<p>y</p>" }, fakeCreateTransport(calls), async () => []);
  assert.equal(result.sent, false);
  assert.equal(result.reason, "dns_failed");
  assert.equal(calls.length, 0);
});

test("las direcciones se recuerdan entre envíos, no se resuelve una vez por correo", async () => {
  const calls = [];
  let resolves = 0;
  const counting = async () => { resolves += 1; return IPV4; };
  await sendBusinessEmail(ENV, { subject: "1", text: "y", html: "<p>y</p>" }, fakeCreateTransport(calls), counting);
  await sendBusinessEmail(ENV, { subject: "2", text: "y", html: "<p>y</p>" }, fakeCreateTransport(calls), counting);
  assert.equal(calls.length, 2);
  assert.equal(resolves, 1);
});
