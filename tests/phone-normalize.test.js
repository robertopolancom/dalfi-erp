import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhone } from "../server/phone.mjs";
import { normalizePhone as normalizePhoneAuth } from "../server/reservapp-auth.mjs";
import { NeonChatStore } from "../server/store.mjs";

const RD = "18295590744";

test("un número dominicano es el mismo escrito como se escriba", () => {
  // Todas estas formas aparecen en la agenda escritas a mano por el personal. Si alguna no
  // colapsara en el mismo valor, la misma persona tendría dos fichas -- o dos hilos en la
  // bandeja de mensajes.
  for (const forma of [
    "8295590744",
    "829-559-0744",
    "(829) 559-0744",
    "829 559 0744",
    "18295590744",
    "+18295590744",
    "+1 829 559 0744",
    "+1 (829) 559-0744",
    "1 829-559-0744",
    " +1-829-559-0744 ",
  ]) {
    assert.equal(normalizePhone(forma), RD, `falló con ${JSON.stringify(forma)}`);
  }
});

test("el + manda sobre la longitud: un número extranjero de 10 dígitos no se vuelve dominicano", () => {
  // Este es el fallo que arregla la migración 0027. México, Colombia y Francia tienen
  // móviles de diez dígitos igual que República Dominicana; sin mirar el "+" todos acababan
  // con un 1 delante y quedaban guardados como un número de aquí que no existe.
  assert.equal(normalizePhone("+52 55 1234 5678"), "525512345678"); // México
  assert.equal(normalizePhone("+57 300 123 4567"), "573001234567"); // Colombia
  assert.equal(normalizePhone("+34 612 345 678"), "34612345678"); // España
  assert.equal(normalizePhone("+33 6 12 34 56 78"), "33612345678"); // Francia
  assert.equal(normalizePhone("+39 312 345 6789"), "393123456789"); // Italia

  // El caso que de verdad se rompía antes: "+" y diez dígitos en total. Islandia entra justa.
  assert.equal(normalizePhone("+354 555 1234"), "3545551234");
});

test("el prefijo internacional 00 vale lo mismo que el +", () => {
  // Es como se marca al extranjero desde un teléfono en casi toda Europa y Latinoamérica,
  // así que aparece pegado en contactos exportados.
  assert.equal(normalizePhone("0018295590744"), RD);
  assert.equal(normalizePhone("+001 829 559 0744"), RD);
  assert.equal(normalizePhone("00 34 612 345 678"), "34612345678");
  assert.equal(normalizePhone("0034612345678"), "34612345678");
});

test("sin señal de país, diez dígitos siguen siendo de aquí", () => {
  // La convención local se conserva intacta: es lo que el personal escribe todos los días.
  assert.equal(normalizePhone("8095550199"), "18095550199");
  // Y lo que no mide diez se deja como está en vez de inventarle un país.
  assert.equal(normalizePhone("829559074"), "829559074");
  assert.equal(normalizePhone("525512345678"), "525512345678");
});

test("una entrada sin dígitos no revienta la búsqueda", () => {
  // Las búsquedas por teléfono le pasan a esto lo que haya escrito una persona en un campo
  // de texto, así que no puede lanzar.
  assert.equal(normalizePhone(""), "");
  assert.equal(normalizePhone(null), "");
  assert.equal(normalizePhone(undefined), "");
  assert.equal(normalizePhone("   "), "");
  assert.equal(normalizePhone("no tiene teléfono"), "");
});

test("las tres puertas del ERP dan el mismo resultado", () => {
  // El motivo de que phone.mjs exista: la misma regla estaba copiada en varios sitios y una
  // sola divergencia deja a una ficha sin su conversación. Si alguien vuelve a duplicarla,
  // esta prueba lo caza.
  for (const forma of ["8295590744", "+52 55 1234 5678", "0034612345678", "18295590744"]) {
    assert.equal(normalizePhoneAuth(forma), normalizePhone(forma), `auth difiere en ${forma}`);
    assert.equal(NeonChatStore.normalizePhone(forma), normalizePhone(forma), `chat difiere en ${forma}`);
  }
});

test("la bandeja distingue 'sin teléfono' de 'teléfono vacío'", () => {
  // ingest() usa este null para abortar: un mensaje sin remitente no tiene conversación a la
  // que pertenecer. El resto del ERP prefiere la cadena vacía porque filtra búsquedas.
  assert.equal(NeonChatStore.normalizePhone(""), null);
  assert.equal(NeonChatStore.normalizePhone("   "), null);
  assert.equal(normalizePhone(""), "");
});
