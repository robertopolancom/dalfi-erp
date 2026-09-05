// Botón "Cargar comprobante" en la tarjeta de cita de la clienta (outputs/reservar/app.js) --
// igual que otros tests de UI de este archivo, manipula el DOM directamente sin framework, así
// que son pruebas de caracterización por texto fuente, no de comportamiento en un DOM real (ver
// tests/reservapp-appointment-status-actions.test.js).

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readApp() {
  return readFile(new URL("../outputs/reservar/app.js", import.meta.url), "utf8");
}
async function readCss() {
  return readFile(new URL("../outputs/reservar/styles.css", import.meta.url), "utf8");
}

test("el botón de cargar comprobante solo aparece con depósito Pendiente o Rechazado", async () => {
  const app = await readApp();
  assert.match(app, /const DEPOSIT_UPLOADABLE_STATES = new Set\(\["Pendiente", "Rechazado"\]\);/);
  assert.match(app, /if \(DEPOSIT_UPLOADABLE_STATES\.has\(depositStatus\)\) \{\s*card\.append\(depositUploadControl\(apt\.id\)\);/);
});

test("compressImageFile() redimensiona en canvas antes de convertir a base64 (evita fotos de varios MB)", async () => {
  const app = await readApp();
  assert.match(app, /function compressImageFile\(file\)/);
  assert.match(app, /Math\.min\(1, DEPOSIT_MAX_DIMENSION \/ Math\.max\(img\.width, img\.height\)\)/);
  assert.match(app, /canvas\.toDataURL\("image\/jpeg", DEPOSIT_JPEG_QUALITY\)/);
});

// La firma creció con dos opciones (showAccounts/onUploaded) cuando el mismo control se empezó a
// usar también en la pantalla de éxito -- ver tests/reservapp-deposit-receipt-visible.test.js.
// Los valores por defecto conservan el comportamiento original de "Mis citas": pinta las cuentas
// encima y recarga la lista al terminar.
test("depositUploadControl() sube al endpoint correcto y recarga las citas al terminar", async () => {
  const app = await readApp();
  assert.match(app, /function depositUploadControl\(appointmentId, \{ showAccounts = true, onUploaded = null \} = \{\}\)/);
  assert.match(app, /api\(`\/api\/reservapp\/my-appointments\/\$\{appointmentId\}\/deposit`, \{\s*method: "POST", body: JSON\.stringify\(\{ mimeType, imageBase64 \}\),/);
  assert.match(app, /await loadMyAppointments\(state\.myAppointmentsScope \|\| "active"\);/);
});

test("las 5 variantes de badge de depósito ya existen en el CSS (deposit-*)", async () => {
  const css = await readCss();
  for (const state of ["pendiente", "comprobanterecibido", "pendienteverificacion", "verificado", "rechazado"]) {
    assert.match(css, new RegExp(`\\.appointment-badge\\.deposit-${state}`));
  }
  assert.match(css, /\.deposit-upload\{/);
});
