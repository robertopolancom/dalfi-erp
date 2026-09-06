// Quién atiende cada conversación. La diferencia entre "el bot contesta" y "el bot está
// callado esperando a alguien" es la que decide si un cliente se queda sin respuesta, así que
// tiene que ser un dato explícito y no algo que haya que deducir mirando el hilo.

import assert from "node:assert/strict";
import test from "node:test";
import { estadoDeConversacion } from "../server/store.mjs";

test("el bot atiende cuando nadie lo ha apartado", () => {
  assert.equal(estadoDeConversacion({ needs_human: false, assigned_staff_id: null }), "bot");
});

test("espera a una persona: el bot se aparto y NADIE ha contestado", () => {
  // Es lo único urgente de la bandeja y por eso va en rojo y primero en la lista.
  assert.equal(estadoDeConversacion({ needs_human: true, assigned_staff_id: null }), "espera");
});

test("con una persona en cuanto alguien contesta, aunque el bot no la hubiera transferido", () => {
  // Responder pausa el bot en el motor. Si esto dijera "con el bot", quien mirase la lista
  // creería que el cliente está atendido automáticamente cuando en realidad nadie le va a
  // responder hasta que se devuelva el turno a mano.
  assert.equal(estadoDeConversacion({ needs_human: false, assigned_staff_id: "staff-1" }), "persona");
});

test("quien la tomó manda sobre la peticion del bot", () => {
  // needs_human sigue en true porque el asunto no está cerrado, pero ya no está desatendida.
  assert.equal(estadoDeConversacion({ needs_human: true, assigned_staff_id: "staff-1" }), "persona");
});
