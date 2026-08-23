import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePhoneDigits,
  resolveOrCreateClientProfile,
} from "../outputs/lib/booking-engine.js";

test("normalizePhoneDigits limpia espacios, guiones y código de país 1", () => {
  assert.equal(normalizePhoneDigits("+1 (809) 555-0199"), "8095550199");
  assert.equal(normalizePhoneDigits("809-555-0199"), "8095550199");
});

test("resolveOrCreateClientProfile vincula a cliente existente cuando el teléfono coincide sin duplicar", () => {
  const clientList = [
    {
      clienteID: "CLI-101",
      nombreCompleto: "María Gomez",
      telefono: "8095550199",
      lineasContactoVinculadas: [],
    },
  ];

  const res = resolveOrCreateClientProfile({
    clientList,
    client: { name: "María G.", phone: "+1 809 555-0199" },
    senderPhone: "+1 809 555-0199",
  });

  assert.equal(res.isNew, false);
  assert.equal(res.clientId, "CLI-101");
  assert.equal(res.clientName, "María Gomez");
  assert.ok(res.note.includes("Cliente coincidente detectado"));
});

test("resolveOrCreateClientProfile vincula la conversación de un amigo a la cuenta del cliente real sin duplicar ni crear cuenta errónea", () => {
  const clientList = [
    {
      clienteID: "CLI-102",
      nombreCompleto: "Laura Torres",
      telefono: "8295559988",
      lineasContactoVinculadas: [],
    },
  ];

  // El amigo escribe desde su WhatsApp (8091112233) para agendar a Laura Torres (8295559988)
  const res = resolveOrCreateClientProfile({
    clientList,
    client: { name: "Laura Torres", phone: "829-555-9988" },
    senderPhone: "+1 (809) 111-2233",
    source: "chatbot_whatsapp",
  });

  assert.equal(res.isNew, false);
  assert.equal(res.clientId, "CLI-102");
  assert.equal(res.clientName, "Laura Torres");

  // La subcapa de líneas vinculadas debe registrar el número del amigo
  const linked = res.clientRecord.lineasContactoVinculadas;
  assert.equal(linked.length, 1);
  assert.equal(linked[0].phone, "+1 (809) 111-2233");
});

test("resolveOrCreateClientProfile guarda fechaNacimiento y servicioInteres en un cliente nuevo (registro del chatbot)", () => {
  const res = resolveOrCreateClientProfile({
    clientList: [],
    client: {
      name: "Carla Peña",
      phone: "+1 809 555-0177",
      email: "carla@example.com",
      dateOfBirth: "15/03/1995",
      preferredService: "Pedicura",
    },
    senderPhone: "+1 809 555-0177",
  });

  assert.equal(res.isNew, true);
  assert.equal(res.clientRecord.fechaNacimiento, "15/03/1995");
  assert.equal(res.clientRecord.servicioInteres, "Pedicura");
});

test("resolveOrCreateClientProfile completa fechaNacimiento/servicioInteres en un cliente existente que no los tenía, sin sobrescribir si ya existían", () => {
  const clientList = [
    {
      clienteID: "CLI-103",
      nombreCompleto: "Rosa Diaz",
      telefono: "8095550188",
      fechaNacimiento: "01/01/1990",
      lineasContactoVinculadas: [],
    },
  ];

  const res = resolveOrCreateClientProfile({
    clientList,
    client: { name: "Rosa Diaz", phone: "809-555-0188", dateOfBirth: "99/99/9999", preferredService: "Manicura Rusa" },
    senderPhone: "809-555-0188",
  });

  assert.equal(res.isNew, false);
  // No sobrescribe una fecha de nacimiento ya guardada con un valor distinto que llegue después.
  assert.equal(res.clientRecord.fechaNacimiento, "01/01/1990");
  // Pero sí completa el campo que estaba vacío.
  assert.equal(res.clientRecord.servicioInteres, "Manicura Rusa");
});

test("resolveOrCreateClientProfile marca telefonoVerificado en un cliente nuevo cuando phoneVerified es true", () => {
  const res = resolveOrCreateClientProfile({
    clientList: [],
    client: { name: "Nueva Clienta", phone: "809-555-0166" },
    phoneVerified: true,
  });

  assert.equal(res.isNew, true);
  assert.equal(res.clientRecord.telefonoVerificado, true);
  assert.ok(res.clientRecord.telefonoVerificadoEn);
});

test("resolveOrCreateClientProfile no marca telefonoVerificado en un cliente nuevo si phoneVerified no llega (default false)", () => {
  const res = resolveOrCreateClientProfile({
    clientList: [],
    client: { name: "Nueva Clienta", phone: "809-555-0155" },
  });

  assert.equal(res.clientRecord.telefonoVerificado, false);
  assert.equal(res.clientRecord.telefonoVerificadoEn, null);
});

test("resolveOrCreateClientProfile marca verificado a un cliente existente que no lo estaba, cuando esta llamada trae phoneVerified: true", () => {
  const clientList = [
    { clienteID: "CLI-104", nombreCompleto: "Ana Ruiz", telefono: "8095550144", telefonoVerificado: false, lineasContactoVinculadas: [] },
  ];
  const res = resolveOrCreateClientProfile({
    clientList,
    client: { name: "Ana Ruiz", phone: "809-555-0144" },
    phoneVerified: true,
  });

  assert.equal(res.isNew, false);
  assert.equal(res.clientRecord.telefonoVerificado, true);
  assert.ok(res.clientRecord.telefonoVerificadoEn);
});

test("resolveOrCreateClientProfile nunca desverifica a un cliente que ya estaba verificado", () => {
  const clientList = [
    { clienteID: "CLI-105", nombreCompleto: "Bea Cruz", telefono: "8095550133", telefonoVerificado: true, telefonoVerificadoEn: "2026-01-01T00:00:00.000Z", lineasContactoVinculadas: [] },
  ];
  const res = resolveOrCreateClientProfile({
    clientList,
    client: { name: "Bea Cruz", phone: "809-555-0133" },
    phoneVerified: false,
  });

  assert.equal(res.clientRecord.telefonoVerificado, true);
  assert.equal(res.clientRecord.telefonoVerificadoEn, "2026-01-01T00:00:00.000Z");
});
