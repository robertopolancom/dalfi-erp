// El comprobante de depósito deja de ser invisible: se ve dentro de ReservApp (la clienta en su
// propia cita, y todo el personal -- manicurista incluida -- en el detalle de la cita), el botón
// de subirlo aparece ya en la pantalla de éxito junto a las cuentas, el inicio tiene un botón
// fijo para consultar las cuentas, y el correo a dalfistudionails@gmail.com lleva la foto
// adjunta. Pedido de Roberto 2026-09-05.
//
// Igual que el resto de tests de UI de este repo (ver tests/reservapp-deposit-upload-ui.test.js),
// las partes de frontend son pruebas de caracterización por texto fuente: no hay framework ni DOM
// real que montar. Las de store/correo sí ejercitan el código de verdad, con dobles en memoria.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { NeonBookingStore } from "../server/store.mjs";
import { notifyDepositReceiptUploaded, resetTransporterCache } from "../server/email.mjs";

const readApp = () => readFile(new URL("../outputs/reservar/app.js", import.meta.url), "utf8");
const readHtml = () => readFile(new URL("../outputs/reservar/index.html", import.meta.url), "utf8");
const readCss = () => readFile(new URL("../outputs/reservar/styles.css", import.meta.url), "utf8");
const readServer = () => readFile(new URL("../server/app.mjs", import.meta.url), "utf8");

/* ---------- store: la clienta solo puede leer el comprobante de SUS citas ---------- */

test("getDepositReceiptForClient(): acota por client_id y no devuelve reviewed_by", async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [{ appointment_id: "apt-1", image_data: "BASE64", mime_type: "image/jpeg", uploaded_at: "2026-09-05T15:00:00Z", reviewed_at: null, deposit_status: "ComprobanteRecibido" }] };
    },
  };
  const store = new NeonBookingStore(pool);
  const receipt = await store.getDepositReceiptForClient({ appointmentId: "apt-1", clientId: "cli-1" });

  assert.equal(receipt.image_data, "BASE64");
  assert.equal(receipt.deposit_status, "ComprobanteRecibido");
  assert.deepEqual(queries[0].params, ["apt-1", "cli-1"]);
  assert.match(queries[0].sql, /join app\.appointments a on a\.id = r\.appointment_id/);
  assert.match(queries[0].sql, /where r\.appointment_id=\$1 and a\.client_id=\$2/);
  assert.doesNotMatch(queries[0].sql, /reviewed_by/);
});

test("getDepositReceiptForClient(): una cita ajena responde null, igual que una inexistente", async () => {
  const store = new NeonBookingStore({ query: async () => ({ rows: [] }) });
  assert.equal(await store.getDepositReceiptForClient({ appointmentId: "apt-de-otra", clientId: "cli-1" }), null);
});

/* ---------- rutas ---------- */

test("GET /my-appointments/:id/deposit existe, es solo para cuentas de cliente y usa el client_id de la sesión", async () => {
  const server = await readServer();
  assert.match(server, /app\.get\("\/api\/reservapp\/my-appointments\/:id\/deposit", requireReservapp/);
  assert.match(server, /getDepositReceiptForClient\(\{\s*appointmentId: req\.params\.id, clientId: req\.reservapp\.account\.client_id,/);
});

test("una foto ya archivada por el cron de limpieza responde 410, no 404, en ambas rutas", async () => {
  const server = await readServer();
  const purged = server.match(/if \(!receipt\.image_data\) return res\.status\(410\)/g) || [];
  assert.equal(purged.length, 2, "410 esperado tanto en la ruta del personal como en la de la clienta");
});

/* ---------- correo con el comprobante adjunto ---------- */

const ENV = { GMAIL_USER: "dalfistudionails@gmail.com", GMAIL_APP_PASSWORD: "app-password-fake" };
const APT = { legacyId: "RES-1", clientName: "María Pérez", serviceName: "Manicura", staffName: "Ana", date: "2026-09-05", time: "15:30" };

function fakeCreateTransport(calls) {
  return () => ({ async sendMail(msg) { calls.push(msg); return { messageId: "fake" }; } });
}

test.beforeEach(() => resetTransporterCache());

test("notifyDepositReceiptUploaded(): adjunta la foto y la manda a la cuenta del salón", async () => {
  const calls = [];
  await notifyDepositReceiptUploaded(
    ENV,
    { ...APT, depositAmount: 500, receiptBase64: "BASE64DATA", receiptMimeType: "image/png" },
    fakeCreateTransport(calls),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, "dalfistudionails@gmail.com");
  assert.equal(calls[0].attachments.length, 1);
  assert.equal(calls[0].attachments[0].filename, "comprobante-RES-1.png");
  assert.equal(calls[0].attachments[0].content, "BASE64DATA");
  assert.equal(calls[0].attachments[0].encoding, "base64");
  assert.equal(calls[0].attachments[0].contentType, "image/png");
  assert.match(calls[0].text, /RD\$500/);
  assert.match(calls[0].text, /va adjunto/);
});

test("notifyDepositReceiptUploaded(): sin foto sigue mandando el aviso, sin adjunto y diciéndolo", async () => {
  const calls = [];
  await notifyDepositReceiptUploaded(ENV, APT, fakeCreateTransport(calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].attachments, undefined);
  assert.match(calls[0].text, /no se pudo adjuntar la foto/);
});

test("la ruta de subida le pasa al correo la foto que acaba de guardar", async () => {
  const server = await readServer();
  assert.match(server, /depositAmount: 500, receiptBase64: imageBase64, receiptMimeType: mimeType,/);
});

/* ---------- frontend ---------- */

test("depositReceiptView() pide la ruta del personal o la de la clienta según quién mira", async () => {
  const app = await readApp();
  assert.match(app, /function depositReceiptView\(appointmentId, \{ staff = false \} = \{\}\)/);
  assert.match(app, /`\/api\/reservapp\/agenda\/appointments\/\$\{appointmentId\}\/deposit`/);
  assert.match(app, /`\/api\/reservapp\/my-appointments\/\$\{appointmentId\}\/deposit`/);
  assert.match(app, /img\.src = `data:\$\{receipt\.mime_type \|\| "image\/jpeg"\};base64,\$\{receipt\.image_data\}`/);
});

test("la clienta ve su comprobante en la tarjeta en cuanto deja de estar Pendiente", async () => {
  const app = await readApp();
  assert.match(app, /if \(depositStatus !== "Pendiente"\) \{\s*card\.append\(depositReceiptView\(apt\.id\)\);/);
});

test("todo el personal ve la foto en el detalle, pero solo administración la aprueba/rechaza", async () => {
  const app = await readApp();
  assert.match(app, /const DEPOSIT_UPLOADED_STATES = new Set\(\["ComprobanteRecibido", "PendienteVerificacion", "Verificado", "Rechazado"\]\);/);
  // La foto se decide con isStaff (manicurista incluida); la revisión sigue atada a isAdmin.
  assert.match(app, /renderDepositReceiptSection\(item, isStaff\);\s*renderDepositReview\(item, isAdmin\);/);
  assert.match(app, /const shouldShow = isStaff && DEPOSIT_UPLOADED_STATES\.has\(item\.deposit_status\);/);
  assert.match(app, /const shouldShow = isAdmin && DEPOSIT_REVIEWABLE_STATES\.has\(item\.deposit_status\);/);
});

test("la pantalla de éxito trae el botón de subir el comprobante, sin repetir las cuentas", async () => {
  const app = await readApp();
  const html = await readHtml();
  assert.match(html, /id="success-deposit-upload"/);
  assert.match(app, /function renderSuccessDepositUpload\(appointments\)/);
  // Solo cuentas de cliente: el endpoint de subida rechaza al personal (isClientRole).
  assert.match(app, /if \(!state\.account \|\| !isClientRole\(state\.account\.role\)\) return;/);
  assert.match(app, /depositUploadControl\(item\.id, \{\s*showAccounts: false,/);
  // Los tres caminos que llegan a la pantalla de éxito la pintan (reserva normal, reserva
  // combinada y activación de cuenta con cita pendiente).
  assert.equal((app.match(/renderSuccessDepositUpload\(/g) || []).length, 4);
  assert.match(app, /renderSuccessDepositUpload\(isFallback \? result\.appointments : \[result\.appointment\]\)/);
});

test("el inicio tiene un botón fijo de cuentas bancarias que exige sesión antes de pedirlas", async () => {
  const app = await readApp();
  const html = await readHtml();
  assert.match(html, /id="home-bank-accounts"/);
  assert.match(html, /id="bank-accounts-dialog"/);
  assert.match(html, /id="dialog-bank-accounts"/);
  assert.match(app, /\$\("home-bank-accounts"\)\.addEventListener\("click", \(\) => \{\s*if \(!state\.account\) \{/);
  assert.match(app, /renderBankAccounts\(\$\("dialog-bank-accounts"\)\);\s*\$\("bank-accounts-dialog"\)\.showModal\(\);/);
});

test("el CSS del visor del comprobante existe", async () => {
  const css = await readCss();
  assert.match(css, /\.deposit-receipt-view\{/);
  assert.match(css, /\.deposit-receipt-image img\{/);
  assert.match(css, /\.success-deposit-upload\{/);
});
