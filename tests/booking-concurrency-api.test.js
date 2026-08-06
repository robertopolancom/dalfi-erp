import test from "node:test";
import assert from "node:assert/strict";

import { onRequestPost as confirmPost } from "../functions/api/booking/confirm.js";

function createMockEnv(initialDoc) {
  let doc = JSON.parse(JSON.stringify(initialDoc));
  let updatedAt = "2026-08-03T12:00:00.000Z";

  return {
    SUPABASE_URL: "https://mock.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "mock_service_key",
    fetch: async (url, options = {}) => {
      const urlStr = String(url);
      if (urlStr.includes("save_erp_record_if_current")) {
        const body = JSON.parse(options.body || "{}");
        if (body.p_expected_updated_at !== null && body.p_expected_updated_at !== updatedAt) {
          return new Response(JSON.stringify([{ saved: false, new_updated_at: updatedAt }]), { status: 200 });
        }
        doc = body.p_data;
        updatedAt = new Date().toISOString();
        return new Response(JSON.stringify([{ saved: true, new_updated_at: updatedAt }]), { status: 200 });
      }

      return new Response(
        JSON.stringify([{ data: doc, updated_at: updatedAt }]),
        { status: 200 }
      );
    },
  };
}

test("Confirmación de reserva atómica: la primera tiene éxito y la segunda en la misma hora retorna 409 Conflict (Prevención de Doble Reserva)", async () => {
  const initialDoc = {
    servicios: [{ servicioID: "SRV-1", servicio: "Manicura Rusa", duracionMin: 60 }],
    colaboradores: [{ colaboradorID: "COL-1", nombreCompleto: "Ana Pérez", estado: "Activo" }],
    reservas: [],
  };

  const env = createMockEnv(initialDoc);

  const req1 = new Request("https://localhost/api/booking/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "IDEM-101",
      client: { id: "CLI-1", name: "Maria Lopez" },
      serviceLines: [{ serviceId: "SRV-1", quantity: 1 }],
      requestedStartAt: "2026-08-03T09:00:00",
      collaboratorPreference: { mode: "specific", collaboratorId: "COL-1" },
    }),
  });

  const res1 = await confirmPost({ request: req1, env });
  assert.equal(res1.status, 200);
  const data1 = await res1.json();
  assert.equal(data1.success, true);
  assert.equal(data1.appointment.status, "Confirmada");

  // Segunda solicitud enviada para la misma hora y manicurista
  const req2 = new Request("https://localhost/api/booking/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "IDEM-102",
      client: { id: "CLI-2", name: "Carmen Rosa" },
      serviceLines: [{ serviceId: "SRV-1", quantity: 1 }],
      requestedStartAt: "2026-08-03T09:00:00",
      collaboratorPreference: { mode: "specific", collaboratorId: "COL-1" },
    }),
  });

  const res2 = await confirmPost({ request: req2, env });
  assert.equal(res2.status, 409); // Conflict
  const data2 = await res2.json();
  assert.equal(data2.success, false);
  assert.equal(data2.code, "SLOT_NO_LONGER_AVAILABLE");
});

test("IdempotencyKey repetida devuelve la misma cita en vez de crear un duplicado", async () => {
  const initialDoc = {
    servicios: [{ servicioID: "SRV-1", servicio: "Manicura Rusa", duracionMin: 60 }],
    colaboradores: [{ colaboradorID: "COL-1", nombreCompleto: "Ana Pérez", estado: "Activo" }],
    reservas: [],
  };

  const env = createMockEnv(initialDoc);

  const payload = {
    idempotencyKey: "IDEM-REPEAT-KEY",
    client: { id: "CLI-1", name: "Maria Lopez" },
    serviceLines: [{ serviceId: "SRV-1", quantity: 1 }],
    requestedStartAt: "2026-08-03T10:00:00",
    collaboratorPreference: { mode: "specific", collaboratorId: "COL-1" },
  };

  const req1 = new Request("https://localhost/api/booking/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const res1 = await confirmPost({ request: req1, env });
  const data1 = await res1.json();
  assert.equal(data1.success, true);

  // Reintento con la misma idempotencyKey
  const req2 = new Request("https://localhost/api/booking/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const res2 = await confirmPost({ request: req2, env });
  const data2 = await res2.json();
  assert.equal(data2.success, true);
  assert.equal(data2.idempotent, true);
  assert.equal(data2.appointment.appointmentId, data1.appointment.appointmentId);
});
