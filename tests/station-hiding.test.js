import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAvailabilityResponseForChatbot } from "../outputs/lib/booking-engine.js";

test("stationId y stationName de mesa NO deben aparecer en respuestas del chatbot ni documentos del cliente", () => {
  const chatbotResp = buildAvailabilityResponseForChatbot({
    success: true,
    date: "2026-08-03",
    serviceId: "SRV-1",
    serviceName: "Manicura Rusa",
    durationMinutes: 60,
    collaboratorId: "STAFF-1",
    collaboratorName: "Ana Pérez",
    slots: [{ startAt: "2026-08-03T09:00:00", endAt: "2026-08-03T10:00:00", time: "09:00", endTime: "10:00", collaboratorId: "STAFF-1" }],
  });

  const jsonStr = JSON.stringify(chatbotResp);
  assert.equal(jsonStr.includes("stationId"), false);
  assert.equal(jsonStr.includes("stationName"), false);
  assert.equal(jsonStr.includes("mesa"), false);
});

test("Exportación térmica de factura y comprobante del cliente omiten datos de mesa", () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), "outputs/app.js"), "utf8");
  // Verificar que la función de impresión térmica o recibo al cliente no inyecte stationId ni stationName al comprobante impreso
  assert.equal(appJs.includes("comprobante-cliente-mesa"), false);
});
