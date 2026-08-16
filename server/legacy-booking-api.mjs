// Puerto a Render/Neon de functions/api/booking/{services,staff,availability,confirm,cancel,
// reschedule,clients,bank-accounts}.js — el chatbot (ERP_BASE_URL) depende de estas rutas y
// no existían aquí. Reusa exactamente la misma lógica de negocio (outputs/lib/booking-engine.js,
// insertAuditLog, syncAppointmentToGoogleCalendar) contra el mismo modelo de documento único
// que ya usan GET/PUT /api/database — solo cambia el transporte (store de Neon en vez de
// Supabase REST). server/app.mjs ya mantiene app.erp_document sincronizado con las tablas
// normalizadas al crear citas/clientas desde ReservApp, así que este documento es la misma
// fuente que ve el personal.
import { insertAuditLog } from "../functions/api/_lib/audit.js";
import { syncAppointmentToGoogleCalendar } from "../functions/api/_lib/google-calendar.js";
import {
  calculateAvailableSlots,
  selectBestAvailableCollaborator,
  buildAvailabilityResponseForChatbot,
  normalizeBusinessSchedule,
  calculateAppointmentDuration,
  parseTimeToMinutes,
  determineInitialBookingStatus,
  resolveOrCreateClientProfile,
  isCollaboratorEligibleForServiceLines,
} from "../outputs/lib/booking-engine.js";

const SYSTEM_IDENTITY = { userId: "booking_api", email: "system@seben", role: "system" };
const SYSTEM_IDENTITY_AUDIT = { userId: SYSTEM_IDENTITY.userId, userEmail: SYSTEM_IDENTITY.email, userRole: SYSTEM_IDENTITY.role };

function normalizePhoneDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 10 ? `1${digits}` : digits;
}

function matchesPhone(client, phone) {
  const target = normalizePhoneDigits(phone);
  if (!target) return false;
  if (normalizePhoneDigits(client.phone) === target) return true;
  return client.linkedContactLines.some((line) => normalizePhoneDigits(line?.phone || line?.telefono) === target);
}

// A diferencia del original (que permite acceso sin secreto si CHATBOT_SECRET no está
// configurado — pensado para desarrollo local), aquí falla cerrado: estos endpoints exponen
// PII y datos bancarios, no deben quedar abiertos por una variable de entorno faltante en
// producción.
function requireChatbotSecret(req, res, env) {
  const secret = env.CHATBOT_SECRET;
  if (!secret) {
    res.status(503).json({ success: false, error: "CHATBOT_SECRET no configurado en este servidor." });
    return false;
  }
  const header = req.get("x-chatbot-secret");
  const authHeader = req.get("authorization") || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();
  if (header === secret || bearer === secret) return true;
  res.status(401).json({ success: false, error: "No autorizado. Se requiere x-chatbot-secret o Bearer token dedicado del Chatbot Bridge." });
  return false;
}

async function readDocument(store) {
  const row = await store.read();
  if (!row) return null;
  const envelope = row.data;
  const docData = envelope?.data && typeof envelope.data === "object" ? envelope.data : envelope;
  return { envelope, docData, updatedAt: row.updatedAt };
}

function patchEnvelope(envelope, patch) {
  return envelope?.data && typeof envelope.data === "object"
    ? { ...envelope, data: { ...envelope.data, ...patch } }
    : { ...envelope, ...patch };
}

export function registerLegacyBookingApi(app, { store, env, fetchImpl }) {
  const runtime = { fetchImpl: env.fetch || fetchImpl };

  app.get("/api/booking/services", async (_req, res, next) => {
    try {
      const current = await readDocument(store);
      if (!current) return res.status(404).json({ error: "Base de datos no encontrada." });
      const servicesList = Array.isArray(current.docData.servicios) ? current.docData.servicios : [];
      const activeServices = servicesList
        .filter((s) => String(s.estado || "Activo").toLowerCase() === "activo")
        .map((s) => ({
          id: String(s.servicioID || s.id || s.servicio),
          name: s.servicio || s.name || "Servicio",
          durationMinutes: Number(s.duracionMin || s.durationMinutes || s.duration) || 60,
          price: Number(s.precio || s.price) || 0,
          active: true,
        }));
      res.json({ success: true, services: activeServices });
    } catch (error) { next(error); }
  });

  app.get("/api/booking/staff", async (req, res, next) => {
    try {
      const current = await readDocument(store);
      if (!current) return res.status(404).json({ error: "Base de datos no encontrada." });
      const staffList = Array.isArray(current.docData.colaboradores) ? current.docData.colaboradores : [];
      const servicesList = Array.isArray(current.docData.servicios) ? current.docData.servicios : [];
      const serviceId = req.query.serviceId;
      let targetService = null;
      if (serviceId) {
        targetService = servicesList.find((s) => String(s.servicioID || s.id || s.servicio).toLowerCase() === String(serviceId).toLowerCase());
      }
      const filtered = staffList
        .filter((s) => {
          if (String(s.estado || "Activo").toLowerCase() !== "activo") return false;
          if (targetService) {
            const eligible = targetService.eligibleCollaboratorIds;
            if (Array.isArray(eligible) && eligible.length > 0) {
              const sId = String(s.colaboradorID || s.id || s.nombreCompleto);
              if (!eligible.includes(sId) && !eligible.includes(s.nombreCompleto)) return false;
            }
          }
          return true;
        })
        .map((s) => ({
          id: String(s.colaboradorID || s.id || s.nombreCompleto),
          displayName: s.nombreCompleto || `${s.nombre || ""} ${s.apellido || ""}`.trim(),
          available: true,
        }));
      res.json({ success: true, staff: filtered });
    } catch (error) { next(error); }
  });

  app.get("/api/booking/availability", async (req, res, next) => {
    try {
      const rawServiceIds = [].concat(req.query.serviceId || []);
      const serviceIds = rawServiceIds.flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter(Boolean);
      const serviceId = serviceIds[0] || null;
      const date = req.query.date;
      const collaboratorId = req.query.collaboratorId;
      if (!serviceIds.length || !date) return res.status(400).json({ success: false, error: "Parámetros 'serviceId' y 'date' son requeridos." });

      const current = await readDocument(store);
      if (!current) return res.status(404).json({ error: "Base de datos no encontrada." });
      const { docData } = current;
      const services = Array.isArray(docData.servicios) ? docData.servicios : [];
      const staffList = Array.isArray(docData.colaboradores) ? docData.colaboradores : [];
      const appointments = Array.isArray(docData.reservas) ? docData.reservas : [];
      const weeklySchedules = Array.isArray(docData.staffWeeklySchedules) ? docData.staffWeeklySchedules : [];
      const exceptions = Array.isArray(docData.staffScheduleExceptions) ? docData.staffScheduleExceptions : [];
      const bSched = normalizeBusinessSchedule(docData.businessSchedule);

      const targetService = services.find((s) => String(s.servicioID || s.id || s.servicio).toLowerCase() === String(serviceId).toLowerCase());
      if (!targetService) {
        return res.status(404).json(buildAvailabilityResponseForChatbot({ success: false, errorCode: "SERVICE_NOT_FOUND", errorMessage: "El servicio solicitado no existe en el catálogo." }));
      }
      const serviceLines = serviceIds.map((id) => ({ serviceId: id, quantity: 1 }));
      const durationRes = calculateAppointmentDuration({ serviceLines, services });
      if (!durationRes.isValid) {
        return res.status(404).json(buildAvailabilityResponseForChatbot({ success: false, errorCode: "SERVICE_NOT_FOUND", errorMessage: durationRes.warnings[0] || "Uno o más de los servicios solicitados no existen en el catálogo." }));
      }
      const combinedServiceName = durationRes.evaluatedServices.map((s) => s.name).join(" + ");
      const combinedDurationMinutes = durationRes.totalServiceMinutes;

      if (collaboratorId) {
        const staffMember = staffList.find((s) => String(s.colaboradorID || s.id || s.nombreCompleto) === String(collaboratorId));
        if (!staffMember || !isCollaboratorEligibleForServiceLines(staffMember, serviceLines, services)) {
          return res.status(409).json(buildAvailabilityResponseForChatbot({ success: false, date, serviceId, errorCode: "SPECIALIST_NOT_ELIGIBLE", errorMessage: "La colaboradora seleccionada no está capacitada para uno o más de los servicios solicitados." }));
        }
        const avail = calculateAvailableSlots({ date, collaboratorId, serviceLines, businessSchedule: bSched, weeklySchedules, exceptions, appointments, services, now: new Date() });
        return res.json(buildAvailabilityResponseForChatbot({
          success: avail.available, date, serviceId,
          serviceName: combinedServiceName || targetService.servicio || targetService.name,
          durationMinutes: combinedDurationMinutes || targetService.duracionMin || targetService.durationMinutes || 30,
          collaboratorId, collaboratorName: staffMember?.nombreCompleto || staffMember?.nombre || collaboratorId,
          slots: avail.slots, cancellationPolicy: bSched.cancellationPolicy, errorMessage: avail.reason,
        }));
      }

      const eligibleStaff = staffList.filter((s) => String(s.estado || "Activo").toLowerCase() === "activo" && isCollaboratorEligibleForServiceLines(s, serviceLines, services));
      const bestSelection = selectBestAvailableCollaborator({ eligibleCollaborators: eligibleStaff, date, serviceLines, services, businessSchedule: bSched, weeklySchedules, exceptions, appointments, now: new Date() });
      if (!bestSelection.selected) {
        return res.json(buildAvailabilityResponseForChatbot({ success: false, date, serviceId, serviceName: combinedServiceName || targetService.servicio || targetService.name, durationMinutes: combinedDurationMinutes || targetService.duracionMin || targetService.durationMinutes || 30, errorMessage: bestSelection.reason }));
      }
      res.json(buildAvailabilityResponseForChatbot({
        success: true, date, serviceId,
        serviceName: combinedServiceName || targetService.servicio || targetService.name,
        durationMinutes: combinedDurationMinutes || targetService.duracionMin || targetService.durationMinutes || 30,
        collaboratorId: bestSelection.selected.colaboradorID || bestSelection.selected.id,
        collaboratorName: bestSelection.selected.nombreCompleto,
        slots: bestSelection.availableSlots, cancellationPolicy: bSched.cancellationPolicy,
      }));
    } catch (error) { next(error); }
  });

  app.get("/api/booking/bank-accounts", async (req, res, next) => {
    if (!requireChatbotSecret(req, res, env)) return;
    try {
      const current = await readDocument(store);
      if (!current) return res.status(404).json({ error: "Base de datos no encontrada." });
      const accountList = Array.isArray(current.docData.cuentas) ? current.docData.cuentas : [];
      const activeBankAccounts = accountList
        .filter((a) => String(a.tipoCuenta || "") === "Banco" && String(a.estado || "Activo").toLowerCase() === "activo")
        .map((a) => ({
          id: String(a.cuentaID || a.id), banco: a.entidad || "", tipoCuenta: a.tipoProducto || "",
          numeroCuenta: a.numeroCuenta || "", titular: a.titular || "",
          documento: a.documentoTitular || "", tipoDocumento: a.tipoDocumentoTitular || "Cedula",
        }))
        .filter((a) => a.banco && a.numeroCuenta);
      res.json({ success: true, accounts: activeBankAccounts });
    } catch (error) { next(error); }
  });

  app.get("/api/booking/clients", async (req, res, next) => {
    if (!requireChatbotSecret(req, res, env)) return;
    try {
      const current = await readDocument(store);
      if (!current) return res.status(404).json({ error: "Base de datos no encontrada." });
      const clientList = Array.isArray(current.docData.clientes) ? current.docData.clientes : [];
      const activeClients = clientList
        .filter((c) => String(c.estado || "Activo").toLowerCase() === "activo")
        .map((c) => ({
          clientId: String(c.clienteID || c.id), name: c.nombreCompleto || c.nombre || "Cliente",
          phone: c.telefono || "", email: c.correo || "",
          linkedContactLines: Array.isArray(c.lineasContactoVinculadas) ? c.lineasContactoVinculadas : [],
        }));
      const requestedPhone = req.query.phone;
      if (requestedPhone) {
        const client = activeClients.find((item) => matchesPhone(item, requestedPhone)) || null;
        return res.json({ success: true, found: Boolean(client), client });
      }
      res.json({ success: true, totalClients: activeClients.length, clients: activeClients });
    } catch (error) { next(error); }
  });

  app.post("/api/booking/clients", async (req, res, next) => {
    if (!requireChatbotSecret(req, res, env)) return;
    const { client, senderPhone = null, source = "chatbot_whatsapp" } = req.body || {};
    if (!client || (!client.phone && !client.telefono && !senderPhone)) {
      return res.status(400).json({ success: false, error: "Se requiere información del cliente y número de teléfono." });
    }
    try {
      const current = await readDocument(store);
      if (!current) return res.status(404).json({ error: "Base de datos no encontrada." });
      const clientList = Array.isArray(current.docData.clientes) ? current.docData.clientes : [];
      const profileRes = resolveOrCreateClientProfile({ clientList, client, senderPhone, source });
      const updatedClients = profileRes.isNew
        ? [...clientList, profileRes.clientRecord]
        : clientList.map((c) => (String(c.clienteID || c.id) === profileRes.clientId ? profileRes.clientRecord : c));
      const nextEnvelope = patchEnvelope(current.envelope, { clientes: updatedClients });
      const saved = await store.save({ document: nextEnvelope, expectedUpdatedAt: current.updatedAt, identity: SYSTEM_IDENTITY, changes: { action: "chatbot_client_upsert" } });
      if (saved.conflict || saved.missing) return res.status(409).json({ error: "Otra sesión guardó primero. Reintente." });
      res.json({
        success: true, isNew: profileRes.isNew,
        client: { clientId: profileRes.clientId, name: profileRes.clientName, phone: profileRes.phone, linkedContactLines: profileRes.clientRecord.lineasContactoVinculadas || [] },
        note: profileRes.note,
      });
    } catch (error) { next(error); }
  });

  app.post("/api/booking/cancel", async (req, res, next) => {
    if (!requireChatbotSecret(req, res, env)) return;
    const { appointmentId, reason = "" } = req.body || {};
    if (!appointmentId) return res.status(400).json({ success: false, error: "Se requiere 'appointmentId'." });
    try {
      const current = await readDocument(store);
      if (!current) return res.status(404).json({ error: "Base de datos no encontrada." });
      const { docData, envelope, updatedAt } = current;
      const appointments = Array.isArray(docData.reservas) ? docData.reservas : [];
      const targetIndex = appointments.findIndex((a) => String(a.reservaID || a.id) === String(appointmentId));
      if (targetIndex === -1) return res.status(404).json({ success: false, error: "La reserva especificada no fue encontrada." });
      const targetApt = appointments[targetIndex];
      const staffCtx = { services: Array.isArray(docData.servicios) ? docData.servicios : [], staff: Array.isArray(docData.colaboradores) ? docData.colaboradores : [] };
      if (targetApt.estado === "Cancelada") {
        const calendarSync = await syncAppointmentToGoogleCalendar(env, targetApt, staffCtx, runtime);
        return res.json({ success: true, message: "La reserva ya se encontraba cancelada.", appointment: targetApt, calendarSync });
      }
      const updatedApt = { ...targetApt, estado: "Cancelada", cancellationReason: reason, cancelledAt: new Date().toISOString(), updated_at: new Date().toISOString() };
      const newAppointments = [...appointments];
      newAppointments[targetIndex] = updatedApt;
      const nextEnvelope = patchEnvelope(envelope, { reservas: newAppointments });
      const saved = await store.save({ document: nextEnvelope, expectedUpdatedAt: updatedAt, identity: SYSTEM_IDENTITY, changes: { action: "appointment_cancelled", reservaID: appointmentId } });
      if (saved.conflict || saved.missing) return res.status(409).json({ error: "Otra sesión guardó primero. Reintente." });
      await insertAuditLog(env, { tableName: "erp_records", entityId: "app/database", action: "appointment_cancelled", oldData: { reservaID: appointmentId, status: targetApt.estado }, newData: { reservaID: appointmentId, status: "Cancelada", reason }, ...SYSTEM_IDENTITY_AUDIT, success: true, note: "Reserva cancelada exitosamente." });
      const calendarSync = await syncAppointmentToGoogleCalendar(env, updatedApt, staffCtx, runtime);
      res.json({ success: true, message: "Reserva cancelada con éxito. El horario ha sido liberado.", appointmentId, status: "Cancelada", calendarSync });
    } catch (error) { next(error); }
  });

  app.post("/api/booking/reschedule", async (req, res, next) => {
    if (!requireChatbotSecret(req, res, env)) return;
    const { appointmentId, newStartAt, date: newDate, time: newTime, newCollaboratorId = null, reason = "" } = req.body || {};
    const targetDate = newStartAt ? newStartAt.slice(0, 10) : newDate;
    const targetTime = newStartAt ? newStartAt.slice(11, 16) : newTime;
    if (!appointmentId || !targetDate || !targetTime) return res.status(400).json({ success: false, error: "Parámetros 'appointmentId', 'date' y 'time' requeridos." });
    try {
      const current = await readDocument(store);
      if (!current) return res.status(404).json({ error: "Base de datos no encontrada." });
      const { docData, envelope, updatedAt } = current;
      const appointments = Array.isArray(docData.reservas) ? docData.reservas : [];
      const targetIndex = appointments.findIndex((a) => String(a.reservaID || a.id) === String(appointmentId));
      if (targetIndex === -1) return res.status(404).json({ success: false, error: "La reserva no fue encontrada." });
      const currentApt = appointments[targetIndex];
      const services = Array.isArray(docData.servicios) ? docData.servicios : [];
      const staffList = Array.isArray(docData.colaboradores) ? docData.colaboradores : [];
      const weeklySchedules = Array.isArray(docData.staffWeeklySchedules) ? docData.staffWeeklySchedules : [];
      const exceptions = Array.isArray(docData.staffScheduleExceptions) ? docData.staffScheduleExceptions : [];
      const bSched = normalizeBusinessSchedule(docData.businessSchedule);
      const collabId = newCollaboratorId || currentApt.colaboradorID;
      const staffMember = staffList.find((s) => String(s.colaboradorID || s.id || s.nombreCompleto) === String(collabId));
      const serviceLines = Array.isArray(currentApt.servicios) && currentApt.servicios.length > 0
        ? currentApt.servicios.map((s) => ({ serviceId: s.servicioID, quantity: 1 }))
        : [{ serviceId: currentApt.servicioID, quantity: 1 }];
      if (staffMember && !isCollaboratorEligibleForServiceLines(staffMember, serviceLines, services)) {
        return res.status(409).json({ success: false, code: "SPECIALIST_NOT_ELIGIBLE", message: "La colaboradora seleccionada no está capacitada para uno o más de los servicios de esta cita." });
      }
      const otherAppointments = appointments.filter((a) => String(a.reservaID || a.id) !== String(appointmentId));
      const avail = calculateAvailableSlots({ date: targetDate, collaboratorId: collabId, serviceLines, businessSchedule: bSched, weeklySchedules, exceptions, appointments: otherAppointments, services, now: new Date() });
      const isSlotFree = avail.available && avail.slots.some((s) => s.time === targetTime);
      if (!isSlotFree) return res.status(409).json({ success: false, code: "SLOT_NO_LONGER_AVAILABLE", message: "El nuevo horario solicitado no está disponible para la manicurista.", alternatives: avail.slots.slice(0, 3) });
      const durationRes = calculateAppointmentDuration({ serviceLines, services });
      const durationMin = durationRes.totalServiceMinutes || currentApt.duracionMin || 30;
      const startMin = parseTimeToMinutes(targetTime) || 540;
      const endMin = startMin + durationMin;
      const endTimeStr = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
      const initialStatus = determineInitialBookingStatus({ source: currentApt.canalOrigen || "chatbot_whatsapp", date: targetDate, time: targetTime, referenceTime: new Date(), businessSchedule: bSched });
      const newEstado = initialStatus.estadoConfirmacion === "NoRequerida" ? "Confirmada" : "Reprogramada";
      const updatedApt = {
        ...currentApt, fecha: targetDate, hora: targetTime, horaFin: endTimeStr, duracionMin: durationMin,
        colaboradorID: collabId, colaboradorNombre: staffMember?.nombreCompleto || currentApt.colaboradorNombre,
        estado: newEstado, estadoConfirmacion: initialStatus.estadoConfirmacion,
        primerRecordatorioEnviadoEn: null, segundoRecordatorioEnviadoEn: null,
        observaciones: reason ? `Reprogramada: ${reason}. ${currentApt.observaciones || ""}`.trim() : currentApt.observaciones,
        updated_at: new Date().toISOString(),
      };
      const newAppointments = [...appointments];
      newAppointments[targetIndex] = updatedApt;
      const nextEnvelope = patchEnvelope(envelope, { reservas: newAppointments });
      const saved = await store.save({ document: nextEnvelope, expectedUpdatedAt: updatedAt, identity: SYSTEM_IDENTITY, changes: { action: "appointment_rescheduled", reservaID: appointmentId } });
      if (saved.conflict || saved.missing) return res.status(409).json({ error: "Otra sesión guardó primero. Reintente." });
      await insertAuditLog(env, { tableName: "erp_records", entityId: "app/database", action: "appointment_rescheduled", oldData: { fecha: currentApt.fecha, hora: currentApt.hora }, newData: { fecha: targetDate, hora: targetTime, colaboradorID: collabId, reason }, ...SYSTEM_IDENTITY_AUDIT, success: true, note: "Reserva reprogramada exitosamente." });
      const calendarSync = await syncAppointmentToGoogleCalendar(env, updatedApt, { services, staff: staffList }, runtime);
      res.json({
        success: true, message: "Reserva reprogramada con éxito.", calendarSync,
        appointment: { appointmentId, startAt: `${targetDate}T${targetTime}:00`, endAt: `${targetDate}T${endTimeStr}:00`, collaboratorId: collabId, collaboratorName: updatedApt.colaboradorNombre, status: updatedApt.estado, estadoConfirmacion: updatedApt.estadoConfirmacion },
      });
    } catch (error) { next(error); }
  });

  app.post("/api/booking/confirm", async (req, res, next) => {
    if (!requireChatbotSecret(req, res, env)) return;
    const payload = req.body || {};
    const { idempotencyKey, client, serviceLines = [], requestedStartAt, date: payloadDate, time: payloadTime, collaboratorPreference = {}, source = "chatbot_whatsapp", sourceConversationId = null, notes = "" } = payload;
    if (!idempotencyKey) return res.status(400).json({ success: false, error: "Se requiere idempotencyKey." });
    const dateStr = requestedStartAt ? requestedStartAt.slice(0, 10) : payloadDate;
    const timeStr = requestedStartAt ? requestedStartAt.slice(11, 16) : payloadTime;
    const targetResId = payload.reservationId || payload.reservaID;
    if (!targetResId && (!dateStr || !timeStr || !Array.isArray(serviceLines) || serviceLines.length === 0)) {
      return res.status(400).json({ success: false, error: "Datos de cita incompletos (fecha, hora y servicio requeridos)." });
    }
    try {
      const current = await readDocument(store);
      if (!current) return res.status(404).json({ error: "Base de datos no encontrada." });
      const { docData, envelope, updatedAt } = current;
      const appointments = Array.isArray(docData.reservas) ? docData.reservas : [];

      if (targetResId) {
        const existingApt = appointments.find((a) => String(a.reservaID) === String(targetResId));
        if (!existingApt) return res.status(404).json({ success: false, error: `Reserva '${targetResId}' no encontrada.` });
        const alreadyReassigned = new Set(["reemplazada", "cancelada"]);
        if (alreadyReassigned.has(String(existingApt.estado || "").toLowerCase())) {
          return res.status(409).json({ success: false, code: "ALREADY_REASSIGNED", error: `La reserva '${targetResId}' ya no está disponible: su horario fue reasignado (estado actual: ${existingApt.estado}).` });
        }
        const nextEstado = payload.status || "Confirmada";
        let updatedApt = { ...existingApt, estado: nextEstado, observaciones: payload.notes || existingApt.observaciones || "", updated_at: new Date().toISOString(), ...(nextEstado === "Confirmada" ? { estadoConfirmacion: "HoraConfirmada" } : {}) };
        let completedClientRecord = null;
        const isGooglePending = Boolean(existingApt.googleCalendarEventId) && String(existingApt.estado || "").toLowerCase().includes("pendiente de completar");
        if (isGooglePending) {
          const completionDate = dateStr || existingApt.fecha;
          const completionTime = timeStr || existingApt.hora;
          const completionLines = Array.isArray(serviceLines) ? serviceLines : [];
          const completionClient = client && typeof client === "object" ? client : null;
          if (!completionDate || !completionTime || !completionLines.length || !completionClient) {
            return res.status(400).json({ success: false, code: "PENDING_RESERVATION_INCOMPLETE", error: "Para completar esta reserva se requieren clienta, servicio, fecha y hora." });
          }
          const services = Array.isArray(docData.servicios) ? docData.servicios : [];
          const staffList = Array.isArray(docData.colaboradores) ? docData.colaboradores : [];
          const weeklySchedules = Array.isArray(docData.staffWeeklySchedules) ? docData.staffWeeklySchedules : [];
          const exceptions = Array.isArray(docData.staffScheduleExceptions) ? docData.staffScheduleExceptions : [];
          const bSched = normalizeBusinessSchedule(docData.businessSchedule);
          const requestedStaffId = collaboratorPreference?.collaboratorId || existingApt.colaboradorID;
          const assigned = staffList.find((person) => String(person.colaboradorID || person.id || person.nombreCompleto) === String(requestedStaffId));
          if (!assigned || !isCollaboratorEligibleForServiceLines(assigned, completionLines, services)) {
            return res.status(409).json({ success: false, code: "SPECIALIST_REQUIRED_OR_NOT_ELIGIBLE", error: "Selecciona una manicurista válida para los servicios solicitados." });
          }
          const otherAppointments = appointments.filter((a) => String(a.reservaID) !== String(targetResId));
          const availability = calculateAvailableSlots({ date: completionDate, collaboratorId: String(assigned.colaboradorID || assigned.id), serviceLines: completionLines, businessSchedule: bSched, weeklySchedules, exceptions, appointments: otherAppointments, services, now: new Date() });
          if (!availability.available || !availability.slots.some((slot) => slot.time === completionTime)) {
            return res.status(409).json({ success: false, code: "SLOT_NO_LONGER_AVAILABLE", error: "El horario ya no está disponible." });
          }
          const duration = calculateAppointmentDuration({ serviceLines: completionLines, services });
          const startMinutes = parseTimeToMinutes(completionTime);
          const endMinutes = startMinutes + (duration.totalServiceMinutes || 30);
          const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
          const clientProfile = resolveOrCreateClientProfile({ clientList: Array.isArray(docData.clientes) ? docData.clientes : [], client: completionClient, senderPhone: sourceConversationId || payload.senderPhone || null, source: source || "chatbot_whatsapp" });
          completedClientRecord = clientProfile;
          updatedApt = {
            ...updatedApt, fecha: completionDate, hora: completionTime, horaFin: endTime, duracionMin: duration.totalServiceMinutes || 30,
            clienteID: clientProfile.clientId, clienteNombre: clientProfile.clientName, telefono: clientProfile.clientRecord?.telefono || completionClient.phone || "",
            correo: completionClient.email || "", clienteProvisional: false, colaboradorID: String(assigned.colaboradorID || assigned.id),
            colaboradorNombre: assigned.nombreCompleto || assigned.nombre, servicioID: completionLines[0]?.serviceId || completionLines[0]?.servicioID || "",
            servicio: duration.evaluatedServices.map((line) => line.name).join(" + "),
            servicios: duration.evaluatedServices.map((line) => ({ servicioID: line.id, servicio: line.name, duracionMin: line.durationMinutes })),
            bloqueoGlobal: false, estado: payload.status || "Confirmada",
          };
        }
        const updatedReservas = appointments.map((a) => (String(a.reservaID) === String(targetResId) ? updatedApt : a));
        const patch = { reservas: updatedReservas };
        if (completedClientRecord?.clientRecord) {
          const clients = Array.isArray(docData.clientes) ? docData.clientes : [];
          patch.clientes = completedClientRecord.isNew
            ? [...clients, completedClientRecord.clientRecord]
            : clients.map((item) => (String(item.clienteID || item.id) === String(completedClientRecord.clientId) ? completedClientRecord.clientRecord : item));
        }
        const nextEnvelope = patchEnvelope(envelope, patch);
        const saved = await store.save({ document: nextEnvelope, expectedUpdatedAt: updatedAt, identity: SYSTEM_IDENTITY, changes: { action: "appointment_confirmed_update", reservaID: targetResId } });
        if (saved.conflict || saved.missing) return res.status(409).json({ error: "Otra sesión guardó primero. Reintente." });
        const calendarSync = await syncAppointmentToGoogleCalendar(env, updatedApt, { services: Array.isArray(docData.servicios) ? docData.servicios : [], staff: Array.isArray(docData.colaboradores) ? docData.colaboradores : [] }, runtime);
        return res.json({ success: true, updated: true, calendarSync, appointment: { appointmentId: updatedApt.reservaID, confirmationCode: updatedApt.reservaID, status: updatedApt.estado, startAt: `${updatedApt.fecha}T${updatedApt.hora}:00` } });
      }

      const existingKeyApt = appointments.find((a) => a.idempotencyKey === idempotencyKey);
      if (existingKeyApt) {
        const calendarSync = await syncAppointmentToGoogleCalendar(env, existingKeyApt, { services: Array.isArray(docData.servicios) ? docData.servicios : [], staff: Array.isArray(docData.colaboradores) ? docData.colaboradores : [] }, runtime);
        return res.json({
          success: true, idempotent: true, calendarSync,
          appointment: { appointmentId: existingKeyApt.reservaID, confirmationCode: existingKeyApt.reservaID, startAt: `${existingKeyApt.fecha}T${existingKeyApt.hora}:00`, endAt: `${existingKeyApt.fecha}T${existingKeyApt.horaFin || existingKeyApt.hora}:00`, collaboratorId: existingKeyApt.colaboradorID, collaboratorName: existingKeyApt.colaboradorNombre, status: existingKeyApt.estado || "Confirmada" },
        });
      }

      const services = Array.isArray(docData.servicios) ? docData.servicios : [];
      const staffList = Array.isArray(docData.colaboradores) ? docData.colaboradores : [];
      const weeklySchedules = Array.isArray(docData.staffWeeklySchedules) ? docData.staffWeeklySchedules : [];
      const exceptions = Array.isArray(docData.staffScheduleExceptions) ? docData.staffScheduleExceptions : [];
      const bSched = normalizeBusinessSchedule(docData.businessSchedule);

      let assignedCollaborator = null;
      let assignmentStrategy = "specific";
      if (collaboratorPreference.mode === "specific" && collaboratorPreference.collaboratorId) {
        const requested = staffList.find((s) => String(s.colaboradorID || s.id || s.nombreCompleto) === String(collaboratorPreference.collaboratorId));
        if (requested && !isCollaboratorEligibleForServiceLines(requested, serviceLines, services)) {
          return res.status(409).json({ success: false, code: "SPECIALIST_NOT_ELIGIBLE", message: "La colaboradora seleccionada no está capacitada para uno o más de los servicios solicitados." });
        }
        assignedCollaborator = requested;
      }
      if (!assignedCollaborator) {
        const eligibleStaff = staffList.filter((s) => String(s.estado || "Activo").toLowerCase() === "activo" && isCollaboratorEligibleForServiceLines(s, serviceLines, services));
        const best = selectBestAvailableCollaborator({ eligibleCollaborators: eligibleStaff, date: dateStr, serviceLines, services, businessSchedule: bSched, weeklySchedules, exceptions, appointments, requestedTime: timeStr, now: new Date() });
        if (!best.selected) return res.status(409).json({ success: false, code: "NO_STAFF_AVAILABLE", message: "No hay manicurista disponible para el horario seleccionado." });
        assignedCollaborator = best.selected;
        assignmentStrategy = "automatic";
      }
      const targetCollaboratorId = String(assignedCollaborator.colaboradorID || assignedCollaborator.id);
      const avail = calculateAvailableSlots({ date: dateStr, collaboratorId: targetCollaboratorId, serviceLines, businessSchedule: bSched, weeklySchedules, exceptions, appointments, services, now: new Date() });
      const isSlotFree = avail.available && avail.slots.some((s) => s.time === timeStr);
      if (!isSlotFree) {
        await insertAuditLog(env, { tableName: "erp_records", entityId: "app/database", action: "booking_conflict_detected", oldData: null, newData: { date: dateStr, time: timeStr, collaboratorId: targetCollaboratorId, idempotencyKey }, ...SYSTEM_IDENTITY_AUDIT, success: false, note: "Conflicto de disponibilidad detectado al intentar confirmar cita." });
        return res.status(409).json({ success: false, code: "SLOT_NO_LONGER_AVAILABLE", message: "El horario seleccionado ya no está disponible.", alternatives: avail.slots.slice(0, 3) });
      }

      const clientList = Array.isArray(docData.clientes) ? docData.clientes : [];
      const clientProfile = resolveOrCreateClientProfile({ clientList, client, senderPhone: sourceConversationId || payload.senderPhone || null, source });
      const updatedClients = clientProfile.isNew
        ? [...clientList, clientProfile.clientRecord]
        : clientList.map((c) => (String(c.clienteID || c.id) === clientProfile.clientId ? clientProfile.clientRecord : c));

      const durationRes = calculateAppointmentDuration({ serviceLines, services });
      const durationMin = durationRes.totalServiceMinutes || 30;
      const startMin = parseTimeToMinutes(timeStr) || 540;
      const endMin = startMin + durationMin;
      const endTimeStr = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
      const newReservaID = `RES-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const newAppointment = {
        reservaID: newReservaID, fecha: dateStr, hora: timeStr, horaFin: endTimeStr, duracionMin: durationMin,
        clienteID: clientProfile.clientId, clienteNombre: clientProfile.clientName, telefono: clientProfile.phone, correo: client?.email || "",
        clienteProvisional: false, colaboradorID: targetCollaboratorId, colaboradorNombre: assignedCollaborator.nombreCompleto || assignedCollaborator.nombre,
        servicioID: serviceLines[0]?.serviceId || "SRV-GENERIC", servicio: durationRes.evaluatedServices.map((s) => s.name).join(" + ") || "Servicio",
        servicios: durationRes.evaluatedServices.map((s) => ({ servicioID: s.id, servicio: s.name, duracionMin: s.durationMinutes })),
        canalOrigen: source, sourceConversationId: sourceConversationId || null, idempotencyKey,
        selectedByClient: collaboratorPreference.mode === "specific", assignmentStrategy,
        ...determineInitialBookingStatus({ source, requestedStartAt, date: dateStr, time: timeStr, businessSchedule: bSched }),
        observaciones: notes || clientProfile.note || "", needsReview: true,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      const appointmentsWithBump = appointments.map((apt) => {
        if (String(apt.estadoConfirmacion || "").toLowerCase() !== "espacioliberado") return apt;
        if (String(apt.colaboradorID || "") !== String(targetCollaboratorId)) return apt;
        if (apt.fecha !== dateStr || apt.hora !== timeStr) return apt;
        return { ...apt, estado: "Reemplazada", observaciones: "Reemplazada: su horario fue tomado por otra reserva confirmada tras no confirmarse a tiempo.", updated_at: new Date().toISOString() };
      });
      const nextEnvelope = patchEnvelope(envelope, { reservas: [...appointmentsWithBump, newAppointment], clientes: updatedClients });
      const saved = await store.save({ document: nextEnvelope, expectedUpdatedAt: updatedAt, identity: SYSTEM_IDENTITY, changes: { action: "appointment_confirmed", reservaID: newReservaID } });
      if (saved.conflict || saved.missing) {
        return res.status(409).json({ success: false, code: "CONCURRENCY_CONFLICT", message: "Otra sesión actualizó la base de datos simultáneamente. Por favor reintente." });
      }
      await insertAuditLog(env, { tableName: "erp_records", entityId: "app/database", action: "appointment_confirmed", oldData: null, newData: { reservaID: newReservaID, idempotencyKey, fecha: dateStr, hora: timeStr, colaboradorID: targetCollaboratorId }, ...SYSTEM_IDENTITY_AUDIT, success: true, note: "Reserva confirmada con éxito por la API de reservas." });
      const calendarSync = await syncAppointmentToGoogleCalendar(env, newAppointment, { services, staff: staffList }, runtime);
      res.json({
        success: true, calendarSync,
        appointment: { appointmentId: newReservaID, confirmationCode: newReservaID, startAt: `${dateStr}T${timeStr}:00`, endAt: `${dateStr}T${endTimeStr}:00`, collaboratorId: targetCollaboratorId, collaboratorName: assignedCollaborator.nombreCompleto || assignedCollaborator.nombre, status: "Confirmada" },
      });
    } catch (error) { next(error); }
  });
}
