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
