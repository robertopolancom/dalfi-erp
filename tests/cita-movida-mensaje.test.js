import assert from "node:assert/strict";
import test from "node:test";
import { buildMovedAppointmentMessage, fechaEnPalabras } from "../server/moved-appointment-message.mjs";

const BASE = {
  clientName: "Ana", service: "Manicura", date: "2026-09-16",
  previousTime: "14:30", newTime: "16:00",
};

test("la fecha se le dice al cliente en palabras, no en 2026-09-16", () => {
  assert.equal(fechaEnPalabras("2026-09-16"), "miércoles 16 de septiembre");
  assert.equal(fechaEnPalabras("2026-01-01"), "jueves 1 de enero");
});

test("una fecha ilegible no rompe el mensaje: se cae de pie al valor original", () => {
  assert.equal(fechaEnPalabras("no-es-fecha"), "no-es-fecha");
  assert.equal(fechaEnPalabras(undefined), "");
});

test("el mensaje dice la hora vieja, la nueva y que es el mismo día", () => {
  const texto = buildMovedAppointmentMessage(BASE);
  assert.match(texto, /Hola Ana\./);
  assert.match(texto, /las 14:30 se ocupó/);
  assert.match(texto, /miércoles 16 de septiembre a las 16:00, el mismo día/);
  assert.match(texto, /respóndenos por aquí/);
});

// La regla: al que pagó y perdió, el depósito se le queda a favor para la fecha nueva. Decírselo
// es la mitad del trabajo -- si no, la pregunta llega igual, pero a la bandeja.
test("con el depósito ya verificado, se le promete que no se pierde", () => {
  const texto = buildMovedAppointmentMessage({ ...BASE, depositStatus: "Verificado" });
  assert.match(texto, /Tu depósito sigue aplicado a esta cita, no se pierde\./);
});

test("con el comprobante subido pero sin revisar, se habla de comprobante y no se promete verificación", () => {
  const texto = buildMovedAppointmentMessage({ ...BASE, depositStatus: "ComprobanteRecibido" });
  assert.match(texto, /Tu comprobante sigue guardado con esta cita/);
  assert.doesNotMatch(texto, /depósito sigue aplicado/, "todavía nadie lo ha verificado: no se puede afirmar");
});

test("a quien nunca depositó no se le menciona ningún depósito", () => {
  for (const depositStatus of ["Pendiente", "Rechazado", undefined]) {
    const texto = buildMovedAppointmentMessage({ ...BASE, depositStatus });
    assert.doesNotMatch(texto, /depósito|comprobante/i, `no debe hablar de depósito con estado ${depositStatus}`);
  }
});

test("sin nombre, el saludo no queda con un espacio suelto antes del punto", () => {
  const texto = buildMovedAppointmentMessage({ ...BASE, clientName: "" });
  assert.match(texto, /^Hola\. /);
  assert.doesNotMatch(texto, / \./);
});
