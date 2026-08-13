var DALFI_CALENDAR_VERSION = "1.1.0";
var DALFI_SECRET_PROPERTY = "DALFI_WEBHOOK_SECRET";
var DALFI_CALENDAR_PROPERTY = "DALFI_CALENDAR_ID";

function jsonResponse_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return jsonResponse_({ ok: true, service: "dalfi-erp-calendar", version: DALFI_CALENDAR_VERSION });
}

function safeEquals_(left, right) {
  left = String(left || "");
  right = String(right || "");
  var mismatch = left.length ^ right.length;
  var length = Math.max(left.length, right.length);
  for (var i = 0; i < length; i += 1) {
    mismatch |= (left.charCodeAt(i % Math.max(1, left.length)) || 0) ^
      (right.charCodeAt(i % Math.max(1, right.length)) || 0);
  }
  return mismatch === 0;
}

function mappingKey_(appointmentId) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(appointmentId),
    Utilities.Charset.UTF_8
  );
  var hex = digest.map(function (byte) {
    var value = byte < 0 ? byte + 256 : byte;
    return ("0" + value.toString(16)).slice(-2);
  }).join("");
  return "reservation_" + hex;
}

function parseDateTime_(value) {
  var text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00$/.test(text)) {
    throw new Error("INVALID_DATE_TIME");
  }
  // República Dominicana mantiene UTC-04:00 todo el año.
  var date = new Date(text + "-04:00");
  if (isNaN(date.getTime())) throw new Error("INVALID_DATE_TIME");
  return date;
}

function clean_(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanDescription_(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 2000);
}

function validatePayload_(payload) {
  if (!payload || typeof payload !== "object") throw new Error("INVALID_PAYLOAD");
  var action = String(payload.action || "");
  if (["upsert", "delete", "list", "claim"].indexOf(action) === -1) throw new Error("INVALID_ACTION");
  if (action === "list") {
    var from = new Date(String(payload.from || ""));
    var to = new Date(String(payload.to || ""));
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || to.getTime() <= from.getTime()) throw new Error("INVALID_WINDOW");
    if (to.getTime() - from.getTime() > 90 * 24 * 60 * 60 * 1000) throw new Error("WINDOW_TOO_LARGE");
    return { action: action, from: from, to: to, limit: Math.min(250, Math.max(1, Number(payload.limit) || 250)) };
  }
  var appointmentId = clean_(payload.appointmentId, 240);
  if (!appointmentId) throw new Error("MISSING_APPOINTMENT_ID");
  if (action === "claim") {
    var eventId = clean_(payload.eventId, 300);
    if (!eventId) throw new Error("MISSING_EVENT_ID");
    return { action: action, appointmentId: appointmentId, eventId: eventId };
  }
  if (action === "delete") return { action: action, appointmentId: appointmentId };

  var event = payload.event || {};
  var title = clean_(event.summary, 180);
  var description = cleanDescription_(event.description);
  var start = parseDateTime_(event.start && event.start.dateTime);
  var end = parseDateTime_(event.end && event.end.dateTime);
  if (!title || end.getTime() <= start.getTime()) throw new Error("INVALID_EVENT");
  return {
    action: action,
    appointmentId: appointmentId,
    title: title,
    description: description,
    start: start,
    end: end,
    colorId: /^(?:[1-9]|1[01])$/.test(String(event.colorId || "")) ? String(event.colorId) : ""
  };
}

function doPost(e) {
  var properties = PropertiesService.getScriptProperties();
  var expectedSecret = properties.getProperty(DALFI_SECRET_PROPERTY);
  var raw = e && e.postData && e.postData.contents ? e.postData.contents : "";
  if (!expectedSecret || !raw || raw.length > 50000) {
    return jsonResponse_({ ok: false, code: "UNAUTHORIZED_OR_INVALID" });
  }

  var payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    return jsonResponse_({ ok: false, code: "INVALID_JSON" });
  }
  if (!safeEquals_(payload.secret, expectedSecret)) {
    return jsonResponse_({ ok: false, code: "UNAUTHORIZED" });
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonResponse_({ ok: false, code: "BUSY" });
  try {
    var input = validatePayload_(payload);
    var calendarId = properties.getProperty(DALFI_CALENDAR_PROPERTY) || "dalfistudionails@gmail.com";
    var calendar = CalendarApp.getCalendarById(calendarId);
    if (!calendar) return jsonResponse_({ ok: false, code: "CALENDAR_NOT_FOUND" });

    if (input.action === "list") {
      var listed = calendar.getEvents(input.from, input.to);
      var events = [];
      for (var i = 0; i < listed.length && events.length < input.limit; i += 1) {
        var candidate = listed[i];
        if (candidate.isAllDayEvent()) continue;
        var description = cleanDescription_(candidate.getDescription());
        // ERP-origin events are projections and must never be imported again.
        if (description.indexOf("Reserva ERP:") !== -1) continue;
        events.push({
          eventId: clean_(candidate.getId(), 300),
          summary: clean_(candidate.getTitle(), 180),
          description: description,
          start: candidate.getStartTime().toISOString(),
          end: candidate.getEndTime().toISOString(),
          colorId: clean_(candidate.getColor(), 2),
          origin: "google"
        });
      }
      return jsonResponse_({ ok: true, action: "listed", events: events });
    }

    var key = mappingKey_(input.appointmentId);
    var storedEventId = properties.getProperty(key);
    var existingEvent = storedEventId ? calendar.getEventById(storedEventId) : null;

    if (input.action === "claim") {
      if (!existingEvent && input.eventId) existingEvent = calendar.getEventById(input.eventId);
      if (!existingEvent) return jsonResponse_({ ok: false, code: "EVENT_NOT_FOUND" });
      properties.setProperty(key, existingEvent.getId());
      properties.setProperty(key + "_meta", JSON.stringify({ origin: "google", eventId: existingEvent.getId() }));
      return jsonResponse_({ ok: true, action: "claimed", appointmentId: input.appointmentId, eventId: existingEvent.getId() });
    }

    if (input.action === "delete") {
      if (existingEvent) existingEvent.deleteEvent();
      properties.deleteProperty(key);
      properties.deleteProperty(key + "_meta");
      return jsonResponse_({ ok: true, action: "deleted", appointmentId: input.appointmentId });
    }

    var action;
    if (existingEvent) {
      existingEvent
        .setTitle(input.title)
        .setDescription(input.description)
        .setTime(input.start, input.end)
        .setVisibility(CalendarApp.Visibility.PRIVATE);
      if (input.colorId) existingEvent.setColor(input.colorId);
      action = "updated";
    } else {
      existingEvent = calendar.createEvent(input.title, input.start, input.end, {
        description: input.description
      });
      existingEvent.setVisibility(CalendarApp.Visibility.PRIVATE);
      if (input.colorId) existingEvent.setColor(input.colorId);
      properties.setProperty(key, existingEvent.getId());
      properties.setProperty(key + "_meta", JSON.stringify({ origin: "erp", eventId: existingEvent.getId() }));
      action = "created";
    }
    return jsonResponse_({ ok: true, action: action, appointmentId: input.appointmentId });
  } catch (error) {
    // No registrar el payload, secreto, clienta ni descripción.
    console.error("dalfi-calendar: " + String(error && error.message || "SYNC_FAILED"));
    return jsonResponse_({ ok: false, code: "SYNC_FAILED" });
  } finally {
    lock.releaseLock();
  }
}
