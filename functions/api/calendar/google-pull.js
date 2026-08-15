// Google Calendar is an output-only projection of ERP appointments.
// This retired endpoint intentionally never reads Google events and never
// writes appointments or clients back into the ERP.

const json = (body, status = 410) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export async function onRequest() {
  return json({
    success: false,
    code: "CALENDAR_IMPORT_DISABLED",
    error: "Google Calendar es de solo salida. Cree y modifique las citas únicamente desde la agenda o la ERP.",
  });
}
