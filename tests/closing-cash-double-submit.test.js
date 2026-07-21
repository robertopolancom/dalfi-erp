// Aserciones estaticas (mismo patron que tests/treasury-confirm-ui.test.js)
// sobre la proteccion contra doble clic/doble submit del cierre de caja
// registradora (#cash-form), igual que ya existia para #expense-form via
// expenseSubmitInFlight.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "..", "outputs", "app.js"), "utf8");

function extractStatementBlock(startMarker, throughMarker, source = appJs) {
  const startIdx = source.indexOf(startMarker);
  assert.ok(startIdx !== -1, `no se encontro el marcador: ${startMarker}`);
  const throughIdx = source.indexOf(throughMarker, startIdx);
  assert.ok(throughIdx !== -1, `no se encontro el marcador: ${throughMarker}`);
  const openIdx = source.indexOf("{", throughIdx);
  let depth = 0;
  let end = openIdx;
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  const semi = source.indexOf(";", end);
  return source.slice(startIdx, semi + 1);
}

const handlerSource = extractStatementBlock('let cashSubmitInFlight = false;', 'byId("cash-form")?.addEventListener("submit"');

test("cash-form: declara cashSubmitInFlight igual que expenseSubmitInFlight en el formulario de egresos", () => {
  assert.match(appJs, /let cashSubmitInFlight = false;\s*\n\s*byId\("cash-form"\)\?\.addEventListener\("submit"/);
});

test("cash-form: el submit retorna de inmediato si cashSubmitInFlight ya esta activo (evita doble clic/doble submit)", () => {
  const preventDefaultIdx = handlerSource.indexOf("event.preventDefault();");
  const guardIdx = handlerSource.indexOf("if (cashSubmitInFlight) return;");
  assert.ok(preventDefaultIdx >= 0 && guardIdx > preventDefaultIdx, "el guard debe ir justo despues de event.preventDefault()");
});

test("cash-form: cashSubmitInFlight se activa y el boton se deshabilita SOLO despues de pasar todas las validaciones (justo antes de las mutaciones reales)", () => {
  const activateIdx = handlerSource.indexOf("cashSubmitInFlight = true;");
  const disableIdx = handlerSource.indexOf('byId("cash-submit").disabled = true;');
  const tryIdx = handlerSource.indexOf("try {");
  const lastValidationReturnIdx = handlerSource.lastIndexOf("Primero debes generar el cuadre de efectivo");
  assert.ok(activateIdx > 0 && disableIdx > activateIdx && tryIdx > disableIdx, "debe activarse, deshabilitar el boton y luego abrir el try, en ese orden");
  assert.ok(activateIdx > lastValidationReturnIdx, "no debe activarse antes de que terminen las validaciones con return temprano");
});

test("cash-form: las mutaciones reales (cierreIntentos, ingresos de sobrante, cierres) quedan dentro del try", () => {
  const tryIdx = handlerSource.indexOf("try {");
  // dbTable("cierres") tambien se LEE antes del try (para validar), asi que
  // se busca especificamente el .push(...) que crea el cierre (la mutacion).
  const dbTableCierresPushIdx = handlerSource.indexOf('dbTable("cierres").push(');
  const dbTableIntentosIdx = handlerSource.indexOf('dbTable("cierreIntentos")');
  assert.ok(tryIdx >= 0 && dbTableCierresPushIdx > tryIdx && dbTableIntentosIdx > tryIdx);
});

test("cash-form: un finally garantiza que cashSubmitInFlight se reinicia y el boton se reactiva pase lo que pase (exito, faltante o excepcion)", () => {
  assert.match(handlerSource, /}\s*finally\s*{\s*\n\s*cashSubmitInFlight = false;\s*\n\s*byId\("cash-submit"\)\.disabled = false;\s*\n\s*}/);
  const finallyIdx = handlerSource.indexOf("} finally {");
  const closeHandlerIdx = handlerSource.lastIndexOf("});");
  assert.ok(finallyIdx > 0 && closeHandlerIdx > finallyIdx, "el finally debe cerrar antes de que termine el listener");
});

test("regresion: expense-form conserva su propia proteccion independiente (expenseSubmitInFlight) sin interferir con cashSubmitInFlight", () => {
  assert.match(appJs, /let expenseSubmitInFlight = false;/);
  // El handler de cash-form solo puede MENCIONAR expenseSubmitInFlight en un
  // comentario explicativo; nunca puede leerla ni asignarla como codigo real.
  const offendingLines = handlerSource
    .split("\n")
    .filter((line) => line.includes("expenseSubmitInFlight") && !line.trim().startsWith("//"));
  assert.deepStrictEqual(offendingLines, [], "el handler de cash-form no debe leer/asignar la variable del formulario de egresos como codigo");
});
