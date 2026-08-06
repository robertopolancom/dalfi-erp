import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTextForMatching,
  calculateNameSimilarity,
  isPhoneMatch,
  resolveOrCreateClientProfile,
  deduplicateClientDatabase,
} from "../outputs/lib/booking-engine.js";

test("normalizeTextForMatching elimina acentos y caracteres especiales", () => {
  assert.equal(normalizeTextForMatching("María José Gómez-Pérez!"), "maria jose gomezperez");
});

test("calculateNameSimilarity reconoce nombres muy parecidos (Jaccard token ratio)", () => {
  const sim1 = calculateNameSimilarity("Maria Gomez", "María Gómez");
  assert.equal(sim1, 1.0);

  const sim2 = calculateNameSimilarity("Dalfina Guzman Perez", "Dalfina Guzman");
  assert.ok(sim2 >= 0.65);
});

test("isPhoneMatch reconoce números con distintos formatos locales o de código de país", () => {
  assert.equal(isPhoneMatch("+1 809 555 0199", "809-555-0199"), true);
  assert.equal(isPhoneMatch("8095550199", "18095550199"), true);
  assert.equal(isPhoneMatch("8095550199", "8091112233"), false);
});

test("resolveOrCreateClientProfile evita duplicar cliente si coincide por correo exacto", () => {
  const clientList = [
    {
      clienteID: "CLI-EMAIL-01",
      nombreCompleto: "Ana María",
      telefono: "8091111111",
      correo: "anamaria@gmail.com",
    },
  ];

  const res = resolveOrCreateClientProfile({
    clientList,
    client: { name: "Ana M. Perez", phone: "8099999999", email: "ANAMARIA@GMAIL.COM" },
  });

  assert.equal(res.isNew, false);
  assert.equal(res.clientId, "CLI-EMAIL-01");
});

test("resolveOrCreateClientProfile evita duplicar por similitud de nombre difuso (ej. acentos)", () => {
  const clientList = [
    {
      clienteID: "CLI-NAME-01",
      nombreCompleto: "Dalfina Guzmán",
      telefono: "8095550000",
    },
  ];

  const res = resolveOrCreateClientProfile({
    clientList,
    client: { name: "Dalfina Guzman", phone: "8095550000" },
  });

  assert.equal(res.isNew, false);
  assert.equal(res.clientId, "CLI-NAME-01");
});

test("deduplicateClientDatabase limpia y unifica un arreglo con registros duplicados", () => {
  const dirtyList = [
    { clienteID: "1", nombreCompleto: "María Gómez", telefono: "+1 (809) 555-0199" },
    { clienteID: "2", nombreCompleto: "Maria Gomez", telefono: "809-555-0199" },
    { clienteID: "3", nombreCompleto: "Laura Torres", telefono: "8295550000" },
  ];

  const { cleanedList, mergedCount } = deduplicateClientDatabase(dirtyList);
  assert.equal(cleanedList.length, 2);
  assert.equal(mergedCount, 1);
});
