// El flujo de "olvide mi contrasena" es intencionalmente admin-mediado (sin
// SMTP/servicios externos): un administrador genera una contrasena
// temporal (password_reset_required=true) y la entrega fuera de la app; el
// usuario la usa para iniciar sesion y luego se le fuerza a definir una
// propia. Ver el informe de revision de seguridad, seccion 4, para el
// detalle de los tres flujos (A: contrasena temporal recibida, B: usuario
// que olvido todo, C: administrador fuerza un reset).
//
// Estas pruebas fijan en el codigo las dos invariantes de seguridad que
// exige esa seccion: (1) el formulario publico "olvide mi contrasena" ya NO
// debe poder usarse para saber si un correo existe, y (2) el mecanismo de
// recuperacion (login con contrasena temporal + cambio forzado) sigue
// intacto.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");

function extractFunctionBody(anchorRegex) {
  const match = anchorRegex.exec(appJs);
  assert.ok(match, `no se encontro el bloque esperado (${anchorRegex})`);
  return appJs.slice(match.index, match.index + 1500);
}

test("forgot-password-form: el handler de submit ya NO llama a functionEndpoint('password-reset-status') (ese endpoint ahora exige sesion de administrador)", () => {
  const block = extractFunctionBody(/byId\("forgot-password-form"\)\.addEventListener\("submit"/);
  assert.ok(!block.includes('functionEndpoint("password-reset-status")'), "el formulario publico no debe consultar un endpoint que ahora requiere sesion de administrador");
});

test("forgot-password-form: siempre muestra el mismo mensaje generico y abre el formulario de cambio de contrasena, sin bifurcar segun si el correo existe", () => {
  const block = extractFunctionBody(/byId\("forgot-password-form"\)\.addEventListener\("submit"/);
  // No debe haber ningun "if" que dependa de una respuesta de red para
  // decidir si mostrar el formulario (eso reintroduciria la enumeracion).
  assert.ok(!/if\s*\(\s*result\.canReset/.test(block));
  assert.match(block, /resetPasswordPanel\("forgot"\)/, "debe seguir abriendo el formulario de cambio de contrasena en modo 'forgot'");
});

test("password-change-form (modo forgot/forced): sigue validando la identidad via signInWithPassword con la contrasena temporal — ese es el mecanismo real de recuperacion, no depende de password-reset-status", () => {
  const anchor = /byId\("password-change-form"\)\.addEventListener\("submit"/;
  const match = anchor.exec(appJs);
  assert.ok(match);
  const block = appJs.slice(match.index, match.index + 2500);
  assert.match(block, /signInWithPassword\(\{\s*email,\s*password:\s*currentPassword\s*\}\)/);
  assert.match(block, /auth\.updateUser\(/, "debe seguir permitiendo definir la contrasena nueva tras validar la temporal");
});

test("password_reset_required sigue siendo lo que fuerza el cambio obligatorio de contrasena tras un login exitoso (flujo A: contrasena temporal)", () => {
  assert.match(appJs, /isPasswordResetRequired\(\)/);
  const anchor = /byId\("auth-form"\)\.addEventListener\("submit"/;
  const match = anchor.exec(appJs);
  assert.ok(match);
  const block = appJs.slice(match.index, match.index + 1500);
  assert.match(block, /if\s*\(isPasswordResetRequired\(\)\)\s*\{\s*resetPasswordPanel\("forced"\)/);
});
