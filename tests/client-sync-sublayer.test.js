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
