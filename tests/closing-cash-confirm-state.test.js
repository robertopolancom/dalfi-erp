// Regresion del defecto real encontrado en la auditoria integral de Cierres:
// un cierre de caja registradora NUEVO (sin editId todavia) con cuadre
// exacto (shortage = 0) se guardaba como "Cerrado" con solo hacer clic en
// "Guardar cierre" -sin pasar por confirmSingleRegisterClosing, sin
// confirmadoPor/fechaConfirmacion, sin auditoria de confirmacion y sin
// verificar canConfirmClosings()-, porque la condicion original
// ("editId && !confirmAfterSave") solo protegia cierres YA existentes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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

test("regresion: ya no existe el patron viejo 'editId && !confirmAfterSave' como CODIGO (solo protegia cierres YA existentes, no cierres nuevos)", () => {
  const offendingLines = handlerSource
    .split("\n")
    .filter((line) => line.includes("editId && !confirmAfterSave") && !line.trim().startsWith("//"));
  assert.deepStrictEqual(offendingLines, [], "el condicional viejo que causaba el bug no debe reaparecer como codigo real");
});

test("willConfirmNow se calcula ANTES de construir closingPayload, y closingPayload.estado/requiereConfirmacion dependen de willConfirmNow (no se re-derivan por separado)", () => {
  const willConfirmIdx = handlerSource.indexOf("const willConfirmNow =");
  const payloadIdx = handlerSource.indexOf("const closingPayload = {");
  assert.ok(willConfirmIdx >= 0 && payloadIdx > willConfirmIdx, "willConfirmNow debe existir antes del objeto closingPayload");
  assert.match(handlerSource, /estado: willConfirmNow \? "Cerrado" : "Pendiente de confirmacion",/);
  assert.match(handlerSource, /requiereConfirmacion: !willConfirmNow,/);
});

test("willConfirmNow exige explicitamente permiso de confirmar (canConfirmClosings), ademas de confirmAfterSave y ausencia de faltante", () => {
  assert.match(handlerSource, /const willConfirmNow = confirmAfterSave && shortage <= 0 && canConfirmClosings\(\);/);
});

test("tabla de verdad de willConfirmNow contra la formula REAL extraida de outputs/app.js (no una copia a mano que se pueda desincronizar)", () => {
  const match = /const willConfirmNow = (confirmAfterSave && shortage <= 0 && canConfirmClosings\(\));/.exec(handlerSource);
  assert.ok(match, "no se encontro la formula de willConfirmNow");
  const formula = match[1];

  function evalFormula({ confirmAfterSave, shortage, canConfirmClosings }) {
    const sandbox = { confirmAfterSave, shortage, canConfirmClosings: () => canConfirmClosings };
    vm.createContext(sandbox);
    return vm.runInContext(formula, sandbox);
  }

  // Caso real del bug: cierre NUEVO, cuadre exacto, boton "Guardar cierre"
  // (confirmAfterSave = "" -> falsy). Antes quedaba "Cerrado"; ahora debe
  // quedar pendiente.
  assert.strictEqual(evalFormula({ confirmAfterSave: false, shortage: 0, canConfirmClosings: true }), false, "guardar sin pedir confirmar NUNCA debe confirmar, sea cierre nuevo o existente");

  // "Confirmar y cerrar" con cuadre exacto y permiso: SI debe confirmar.
  assert.strictEqual(evalFormula({ confirmAfterSave: true, shortage: 0, canConfirmClosings: true }), true);

  // "Confirmar y cerrar" pero con faltante pendiente: nunca debe confirmar.
  assert.strictEqual(evalFormula({ confirmAfterSave: true, shortage: 150, canConfirmClosings: true }), false);

  // "Confirmar y cerrar" pedido pero SIN permiso real de confirmar (bypass
  // del boton, p.ej. manipulando el campo oculto cash-confirm-after-save):
  // no debe confirmar, para no dejar un cierre "Cerrado" sin confirmadoPor.
  assert.strictEqual(evalFormula({ confirmAfterSave: true, shortage: 0, canConfirmClosings: false }), false);
});

test("confirmadoPor/fechaConfirmacion solo se agregan al payload dentro del bloque 'if (willConfirmNow)' (nunca por separado de la decision de estado)", () => {
  const willConfirmIdx = handlerSource.indexOf("const willConfirmNow =");
  const ifBlockSource = handlerSource.slice(willConfirmIdx);
  assert.match(ifBlockSource, /if \(willConfirmNow\) \{\s*\n\s*closingPayload\.confirmadoPor = currentUserEmail\(\);\s*\n\s*closingPayload\.fechaConfirmacion = new Date\(\)\.toISOString\(\);\s*\n\s*\}/);
});

test("regresion: confirmSingleRegisterClosing sigue revalidando canConfirmClosings() de forma independiente (defensa en profundidad, no se debilito por este fix)", () => {
  const pattern = /function confirmSingleRegisterClosing\(closing\) \{\s*\n\s*if \(!canConfirmClosings\(\) \|\| !closing\) return;/;
  assert.match(appJs, pattern);
});
