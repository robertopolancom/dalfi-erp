import test from "node:test";
import assert from "node:assert/strict";
import {
  generateWhatsAppReceiptText,
  buildChatbotNotificationPayload,
} from "../outputs/lib/booking-engine.js";

test("generateWhatsAppReceiptText genera el comprobante digital formateado para WhatsApp", () => {
  const receipt = generateWhatsAppReceiptText({
    eventType: "invoice.created",
    invoiceId: "FACT-2026-0099",
    clientName: "María Gomez",
    clientPhone: "+1 (809) 555-0199",
    date: "2026-08-06",
    lines: [
      { name: "Manicura Rusa", total: 1500 },
      { name: "Pedicura Clínica", total: 1800 },
    ],
    subtotal: 3300,
    tip: 300,
    total: 3600,
    paymentMethods: ["Tarjeta", "Efectivo"],
  });

  assert.ok(receipt.includes("DALFI STUDIO NAILS & ACADEMY"));
  assert.ok(receipt.includes("COMPROBANTE DE FACTURA N° FACT-2026-0099"));
  assert.ok(receipt.includes("María Gomez"));
  assert.ok(receipt.includes("Manicura Rusa"));
  assert.ok(receipt.includes("3,600.00"));
});

test("generateWhatsAppReceiptText genera el comprobante de cobro/pago de CxC", () => {
  const receipt = generateWhatsAppReceiptText({
    eventType: "payment.recorded",
    invoiceId: "CXC-1002",
    clientName: "Laura Torres",
    total: 1200,
    paymentMethods: ["Transferencia"],
  });

  assert.ok(receipt.includes("RECIBO DE PAGO / COBRO"));
  assert.ok(receipt.includes("Laura Torres"));
  assert.ok(receipt.includes("1,200.00"));
});

test("generateWhatsAppReceiptText genera el aviso de nuevo servicio agregado", () => {
  const receipt = generateWhatsAppReceiptText({
    eventType: "service.added",
    clientName: "Carmen Rosa",
    serviceName: "Soft Gel",
    staffName: "Ana Pérez",
  });

  assert.ok(receipt.includes("NUEVO SERVICIO AGREGADO A TU CITA"));
  assert.ok(receipt.includes("Carmen Rosa"));
  assert.ok(receipt.includes("Soft Gel"));
  assert.ok(receipt.includes("Ana Pérez"));
});

test("buildChatbotNotificationPayload construye el JSON estructurado para el Webhook del Bridge", () => {
  const payload = buildChatbotNotificationPayload({
    eventType: "invoice.created",
    clientPhone: "+18095550199",
    clientName: "María Gomez",
    invoiceId: "FACT-2026-0099",
    receiptText: "Texto comprobante...",
    extraData: { total: 3600 },
  });

  assert.equal(payload.event, "invoice.created");
  assert.equal(payload.recipientPhone, "+18095550199");
  assert.equal(payload.receiptNumber, "FACT-2026-0099");
  assert.equal(payload.whatsappFormattedText, "Texto comprobante...");
});
