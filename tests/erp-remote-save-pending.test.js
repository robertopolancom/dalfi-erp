import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Ninguna de las 41 reservas del ERP tenía guardado su postgresAppointmentId, así que cancelar o
// cambiar estatus desde el ERP no llegaba nunca a Postgres. La causa no era una: eran tres formas
// distintas de tirar un cambio a la basura sin decir nada.
//
//   1. saveRemoteDatabase() hacía `return` si ya había un PUT en vuelo, sin reprogramar.
//   2. scheduleRemoteSave() hacía `return` si el poll estaba cargando, sin reprogramar.
//   3. refreshRemoteDatabase() hace `database = nextDatabase` -- un reemplazo COMPLETO -- y corre
//      cada 30 segundos, así que borraba lo que aún no se había guardado.
//
// El id de Postgres cae justo en esa ventana: llega del POST cuando el guardado que disparó el
// mismo formulario ya salió. Por eso fallaba SIEMPRE, no de vez en cuando.
const erpJs = readFileSync(new URL("../outputs/app.js", import.meta.url), "utf8");

function fn(name, hasta) {
  const start = erpJs.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `no se encontró ${name}`);
  return erpJs.slice(start, erpJs.indexOf(`function ${hasta}(`, start));
}

test("un guardado pedido mientras hay otro en vuelo se encola, no se pierde", () => {
  const save = fn("saveRemoteDatabase", "logAudit");
  assert.match(save, /if \(remoteSaveInFlight\) \{[\s\S]{0,200}remoteSavePending = true;/,
    "en vuelo debe anotarse como pendiente");
  // Y al terminar tiene que salir de verdad.
  const finalBlock = save.slice(save.indexOf("} finally {"));
  assert.match(finalBlock, /remoteSavePending[\s\S]{0,200}scheduleRemoteSave\(\)/,
    "el finally debe reprogramar lo que quedó pendiente");
});

test("un guardado pedido durante una carga se encola, no se pierde", () => {
  const schedule = fn("scheduleRemoteSave", "saveRemoteDatabase");
  assert.match(schedule, /if \(isLoadingRemote\) \{[\s\S]{0,200}remoteSavePending = true;/);
  // El conflicto es la única salida sin reintento, y a propósito: reintentar pisaría a la otra
  // sesión que guardó primero.
  assert.match(schedule, /remoteConflictDetected\) return;/);
});

test("el poll no pisa cambios que todavía no se guardaron", () => {
  const refresh = fn("refreshRemoteDatabase", "startRemoteRefreshLoop");
  const guard = refresh.slice(0, refresh.indexOf("try {"));
  assert.match(guard, /remoteSavePending/,
    "refreshRemoteDatabase reemplaza database entero: con cambios sin guardar no puede correr");
  const finalBlock = refresh.slice(refresh.indexOf("} finally {"));
  assert.match(finalBlock, /remoteSavePending[\s\S]{0,200}scheduleRemoteSave\(\)/,
    "al terminar la carga tiene que salir lo que quedó pendiente");
});

test("sincronizar un cambio de estatus ya no exige tener el mapeo", () => {
  const sync = erpJs.slice(erpJs.indexOf("async function syncReservationToPostgres"), erpJs.indexOf("function loadState"));
  const rama = sync.slice(sync.indexOf("} else if"));
  assert.ok(!/else if \(dbRow\.postgresAppointmentId &&/.test(rama),
    "exigir postgresAppointmentId dejaba fuera a las 41 reservas que no lo tienen");
  assert.match(rama, /dbRow\.postgresAppointmentId \|\| reservationId/,
    "sin mapeo se manda el reservaID, que el servidor sabe resolver");
});
