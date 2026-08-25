const $ = (id) => document.getElementById(id);
const state = { catalog: null, account: null, client: null, selectedSlot: null, activationTicket: null, passwordResetFlow: false, comboSegments: null, comboIndex: 0, pendingBookingStart: false };
const reservappConfig = window.DALFI_RESERVAPP_CONFIG || {};
const apiBase = String(reservappConfig.apiBase || "").replace(/\/$/, "");

const api = async (path, options = {}) => {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(`${apiBase}${path}`, { ...options, headers, credentials: "include" });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || "No se pudo completar la solicitud."), { status: response.status, body });
  return body;
};

const message = (element, text = "", ok = false) => {
  element.textContent = text;
  element.className = ok ? "message ok" : "message";
};
const todayLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santo_Domingo" }).format(new Date());
// weekDays/holidayClosures ya los respeta la disponibilidad real del backend (server/store.mjs) --
// esto solo evita que la clienta llegue a elegir un día que de todos modos va a salir sin horarios.
function isClosedDate(dateStr) {
  const settings = state.catalog?.schedule?.settings || {};
  const weekDays = Array.isArray(settings.weekDays) ? settings.weekDays : [1, 2, 3, 4, 5, 6];
  const weekday = new Date(`${dateStr}T12:00:00-04:00`).getDay();
  return !weekDays.includes(weekday) || (settings.holidayClosures || []).includes(dateStr);
}
function nextOpenDate(dateStr) {
  let cursor = dateStr;
  for (let i = 0; i < 60 && isClosedDate(cursor); i += 1) {
    const next = new Date(`${cursor}T12:00:00-04:00`); next.setDate(next.getDate() + 1);
    cursor = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santo_Domingo" }).format(next);
  }
  return cursor;
}
const selectedServiceIds = () => [...document.querySelectorAll('input[name="service"]:checked')].map((item) => item.value);
const selectedServices = () => selectedServiceIds().map((id) => state.catalog?.services.find((item) => item.id === id)).filter(Boolean);
const employeeRoles = new Set(["manicurista", "asistente", "administradora", "superadministrador"]);

function setClient(client) {
  state.client = client;
  $("selected-client").textContent = `✓ Cliente: ${client.name || client.firstName}`;
  $("selected-client").classList.remove("hidden");
  $("progress-bar").style.width = "78%";
}

function applyAccount(account) {
  state.account = account;
  state.client = account?.role === "clienta" ? { id: account.clientId, name: account.name } : null;
  $("account-button").textContent = account ? account.name : "Entrar";
  $("logout-link").classList.toggle("hidden", !account);
  // Agenda/panel de personal es una función de cuenta identificada -- sin sesión no debe ni
  // aparecer el botón (pedido explícito de diseño).
  $("agenda-tab").classList.toggle("hidden", !account);
  $("guest-access").classList.toggle("hidden", Boolean(account));
  $("employee-client").classList.toggle("hidden", !account || !employeeRoles.has(account.role));
  const isAdmin = Boolean(account) && ["administradora", "superadministrador"].includes(account.role);
  $("open-user-management").classList.toggle("hidden", !isAdmin);
  $("admin-panel").classList.add("hidden"); // siempre arranca cerrado, se abre con el botón de arriba
  $("agenda-tab").textContent = account && employeeRoles.has(account.role) ? "Panel de colaboradores" : "Citas activas";
  $("mode-label").textContent = !account ? "Reserva rápida" : account.role === "clienta" ? "Mi reserva" : "Reserva del equipo";
  if (state.client) setClient(state.client); else $("selected-client").classList.add("hidden");
  // Cuentas de personal aterrizan directo en el panel de colaboradores (agenda) -- ya no en el
  // wizard de reserva de la clienta -- pedido explícito de diseño.
  if (account && employeeRoles.has(account.role)) showAgenda();
}

function updateServiceSummary() {
  const services = selectedServices();
  const duration = services.reduce((sum, item) => sum + item.durationMinutes, 0);
  $("service-summary").firstElementChild.textContent = services.length ? `${services.length} servicio${services.length === 1 ? "" : "s"}` : "Selecciona uno o más servicios";
  // Sin precio a propósito: los precios los confirma una asesora (misma política que el
  // chatbot de WhatsApp), no se cotizan solos en la app.
  $("service-summary").lastElementChild.textContent = `${duration} min`;
}

// Reserva en pasos: 0=portada, 1=servicios, 2=día, 3=horario por manicurista, 4=identificarse
// y confirmar. Cada paso es un <div class="wizard-step" data-step="N"> -- goToStep solo
// muestra/oculta, no reinicia nada de lo ya elegido en pasos anteriores.
const WIZARD_STEP_PROGRESS = { 0: 8, 1: 20, 2: 40, 3: 60, 4: 85 };
function goToStep(step) {
  state.wizardStep = step;
  document.querySelectorAll(".wizard-step").forEach((panel) => {
    panel.classList.toggle("hidden", Number(panel.dataset.step) !== step);
  });
  $("progress-bar").style.width = `${WIZARD_STEP_PROGRESS[step] ?? 8}%`;
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (step === 3) loadAvailability();
  if (step === 4) renderBookingSelectionSummary();
}

function formatSlotTime(time) {
  return new Date(`2000-01-01T${time}:00`).toLocaleTimeString("es-DO", { hour: "numeric", minute: "2-digit" });
}

// Antes de pedir identificación, recuerda a la clienta exactamente qué eligió -- imprescindible
// en modo combo, donde eligió manicurista y hora una vez por cada servicio en pantallas
// separadas y podría no recordar el resultado final.
function renderBookingSelectionSummary() {
  const target = $("booking-selection-summary");
  if (Array.isArray(state.comboSegments) && state.comboSegments.length) {
    target.textContent = state.comboSegments
      .map((segment) => `${segment.serviceName} con ${segment.staffName} a las ${formatSlotTime(segment.time)}`)
      .join(" · ");
    return;
  }
  if (state.selectedSlot) {
    const names = selectedServices().map((item) => item.name).join(", ");
    target.textContent = `${names} con ${state.selectedSlot.staffName} a las ${formatSlotTime(state.selectedSlot.time)}`;
    return;
  }
  target.textContent = "";
}

async function loadCatalog() {
  try {
    state.catalog = await api("/api/fast-booking/catalog");
    $("service-list").replaceChildren(...state.catalog.services.map((service) => {
      const label = document.createElement("label");
      label.className = "service-option";
      const input = document.createElement("input");
      input.type = "checkbox"; input.name = "service"; input.value = service.id;
      const copy = document.createElement("span");
      const strong = document.createElement("strong"); strong.textContent = service.name;
      const small = document.createElement("small"); small.textContent = `${service.durationMinutes} min`;
      copy.append(strong, small); label.append(input, copy); input.addEventListener("change", updateServiceSummary);
      return label;
    }));
    for (const person of state.catalog.staff) {
      $("staff").add(new Option(person.name, person.id));
      $("account-staff").add(new Option(person.name, person.id));
      $("staff-schedule-select").add(new Option(person.name, person.id));
    }
    // preferred_service en app.clients es texto libre (lo usa el chatbot para lo mismo) -- el
    // nombre del servicio, no su id, para que quien lea la ficha en el ERP lo entienda sin buscar.
    for (const service of state.catalog.services) $("new-preferred-service").add(new Option(service.name, service.name));
    const min = todayLocal();
    const max = new Date(`${min}T12:00:00-04:00`);
    max.setDate(max.getDate() + Number(state.catalog.schedule.settings?.maximumAdvanceBookingDays || 60));
    $("date").min = min;
    $("date").max = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santo_Domingo" }).format(max);
    $("date").value = nextOpenDate(min); $("agenda-date").value = min;
    // Sin banner publicado, el elemento se queda oculto y la página se ve exactamente igual que
    // antes de que existiera esta función -- requisito explícito de diseño.
    if (state.catalog.banner) {
      const banner = $("promo-banner");
      banner.textContent = state.catalog.banner.text;
      banner.style.background = state.catalog.banner.bgColor;
      banner.style.color = state.catalog.banner.textColor;
      banner.classList.remove("hidden");
    }
  } catch { message($("booking-message"), "No pudimos cargar la agenda. Intenta nuevamente."); }
}

async function loadSession() {
  try {
    const { account } = await api("/api/reservapp/auth/me");
    // Una clienta nunca debe abrir la app y encontrarse ya "logueada" -- si el dispositivo es
    // compartido, mostraría el nombre/citas de la última clienta que reservó ahí. El cookie de
    // sesión sigue vigente (no se cierra sesión), solo no se aplica automáticamente; si es
    // ella, entra normal con su teléfono y contraseña. El personal sí mantiene su sesión de 30
    // días -- comparten el tablet de recepción y no tiene sentido pedirles credenciales cada
    // vez que abren la app.
    applyAccount(account && account.role !== "clienta" ? account : null);
  } catch { applyAccount(null); }
}

// Agrupa los slots devueltos por /api/fast-booking/availability en una columna por
// manicurista, para que la clienta compare y elija directamente cuál y a qué hora, en vez de
// tener que elegir una manicurista a ciegas antes de ver si tiene espacio. onPick(staffId,
// slot) decide qué pasa después (avanzar de paso, o pasar al siguiente servicio del combo).
function renderStaffSlotsBoard(slots, onPick) {
  const board = $("staff-slots-board");
  const byStaff = new Map();
  for (const slot of slots) {
    if (!byStaff.has(slot.staffId)) byStaff.set(slot.staffId, { staffName: slot.staffName, slots: [] });
    byStaff.get(slot.staffId).slots.push(slot);
  }
  board.replaceChildren(...[...byStaff.entries()].map(([staffId, group]) => {
    const column = document.createElement("section"); column.className = "staff-slots-column";
    const heading = document.createElement("h3"); heading.textContent = group.staffName; column.append(heading);
    const list = document.createElement("div"); list.className = "slots"; column.append(list);
    for (const slot of group.slots) {
      const button = document.createElement("button"); button.type = "button"; button.className = "slot";
      button.textContent = new Date(`2000-01-01T${slot.time}:00`).toLocaleTimeString("es-DO", { hour: "numeric", minute: "2-digit" });
      button.addEventListener("click", () => {
        document.querySelectorAll(".slot").forEach((item) => item.classList.remove("selected"));
        button.classList.add("selected");
        onPick(staffId, slot);
      });
      list.append(button);
    }
    return column;
  }));
}

// Paso 3, un solo servicio: consulta /api/fast-booking/availability SIN staffId -- el motor ya
// devuelve, en un solo llamado, los horarios libres de TODAS las manicuristas elegibles.
async function loadSingleAvailability(serviceIds, date) {
  $("step3-heading").textContent = "Paso 3 · Elige horario y manicurista";
  message($("availability-message"), "Consultando agenda…", true);
  $("staff-slots-board").replaceChildren();
  try {
    const result = await api(`/api/fast-booking/availability?serviceIds=${encodeURIComponent(serviceIds.join(","))}&date=${date}`);
    if (!result.slots.length) {
      message($("availability-message"), "No quedan horarios para este día con ninguna manicurista. Prueba otra fecha.");
      return;
    }
    message($("availability-message"));
    renderStaffSlotsBoard(result.slots, (staffId, slot) => {
      state.selectedSlot = slot; $("time").value = slot.time; $("staff").value = staffId;
      goToStep(4);
    });
  } catch (error) { message($("availability-message"), error.message); }
}

// Paso 3, servicios combinados: se elige manicurista y hora POR SERVICIO, uno a la vez -- así,
// si la manicurista del primer servicio no tiene espacio para el segundo, la clienta elige otra
// distinta para ese segundo servicio en vez de quedar atascada. Cada servicio termina siendo
// una cita independiente en el backend (createComboAppointment), vinculadas por un groupId
// compartido para que el personal las vea como una sola visita.
async function loadComboAvailabilityStep() {
  const serviceIds = selectedServiceIds();
  const date = $("date").value;
  const index = state.comboIndex;
  const serviceId = serviceIds[index];
  const service = state.catalog?.services.find((item) => item.id === serviceId);
  $("step3-heading").textContent = `Paso 3 · Servicio ${index + 1} de ${serviceIds.length}: ${service?.name || ""}`;
  message($("availability-message"), "Consultando agenda…", true);
  $("staff-slots-board").replaceChildren();
  try {
    const result = await api(`/api/fast-booking/availability?serviceIds=${encodeURIComponent(serviceId)}&date=${date}`);
    if (!result.slots.length) {
      message($("availability-message"), `No quedan horarios para "${service?.name ?? "este servicio"}" ese día con ninguna manicurista. Prueba otra fecha.`);
      return;
    }
    message($("availability-message"));
    renderStaffSlotsBoard(result.slots, (staffId, slot) => {
      state.comboSegments.push({ serviceIds: [serviceId], staffId, date, time: slot.time, staffName: slot.staffName, serviceName: service?.name ?? "" });
      if (index + 1 < serviceIds.length) {
        state.comboIndex += 1;
        loadComboAvailabilityStep();
      } else {
        goToStep(4);
      }
    });
  } catch (error) { message($("availability-message"), error.message); }
}

async function loadAvailability() {
  const serviceIds = selectedServiceIds();
  const date = $("date").value;
  state.selectedSlot = null; $("time").value = ""; $("staff").value = ""; state.comboSegments = null; state.comboIndex = 0;
  if (!serviceIds.length || !date) {
    message($("availability-message"), "Selecciona servicios y una fecha antes de este paso.");
    $("staff-slots-board").replaceChildren();
    return;
  }
  if (serviceIds.length > 1) {
    state.comboSegments = [];
    return loadComboAvailabilityStep();
  }
  return loadSingleAvailability(serviceIds, date);
}

function requireBookingSelection(targetMessage) {
  if (!selectedServiceIds().length) { message(targetMessage, "Selecciona al menos un servicio."); return false; }
  if (Array.isArray(state.comboSegments)) {
    if (state.comboSegments.length !== selectedServiceIds().length) { message(targetMessage, "Elige manicurista y hora para cada servicio."); return false; }
    return true;
  }
  if (!$("staff").value || !$("date").value || !$("time").value) { message(targetMessage, "Selecciona manicurista, fecha y hora."); return false; }
  return true;
}

function setupPayload() {
  // $("date") siempre trae la fecha de hoy precargada por loadCatalog() (y $("staff") puede
  // quedar en cualquier opción tocada durante una visita previa al wizard) -- sin esto, registrarse
  // ANTES de elegir servicios (flujo "es mi primera vez" desde identificarse) mandaría un borrador
  // a medias (fecha sí, servicio no) y el backend lo rechazaría pidiendo "selecciona servicios,
  // manicurista, fecha y hora". Solo hay borrador real si de verdad hay servicios elegidos.
  const serviceIds = selectedServiceIds();
  const hasDraft = Boolean(serviceIds.length);
  return {
    firstName: $("first-name").value,
    lastName: $("last-name").value,
    phone: $("new-phone").value,
    email: $("new-email").value,
    birthDate: $("new-birthdate").value,
    sex: $("new-sex").value,
    address: $("new-address").value,
    preferredService: $("new-preferred-service").value,
    serviceIds, staffId: hasDraft ? $("staff").value : "", date: hasDraft ? $("date").value : "", time: hasDraft ? $("time").value : "",
    notes: $("notes").value, website: $("website").value,
  };
}

const APPOINTMENT_STATUS_LABEL = { scheduled: "Agendada", confirmed: "Confirmada", cancelled: "Cancelada", completed: "Completada" };

function openAppointmentDetail(item) {
  $("appointment-detail-time").textContent = `${item.start_time} – ${item.end_time}`;
  const rows = [
    ["Clienta", item.client_name || "Cliente"],
    ["Teléfono", item.client_phone || "—"],
    ["Servicios", item.services],
    ["Manicurista", item.staff_name || "—"],
    ["Estado", APPOINTMENT_STATUS_LABEL[item.status] || item.status || "—"],
    ["Referencia", item.legacy_id || "—"],
  ];
  if (item.notes) rows.push(["Nota", item.notes]);
  if (item.group_id) rows.push(["Servicio combinado", "Sí, con más de una manicurista"]);
  if (Number(item.deposit_amount) > 0) rows.push(["Depósito", `RD$${item.deposit_amount} (${item.deposit_status || "pendiente"})`]);
  $("appointment-detail-body").replaceChildren(...rows.flatMap(([label, value]) => {
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = value;
    return [dt, dd];
  }));
  $("appointment-detail-dialog").showModal();
}

// Vista de calendario del día: una columna por manicurista, citas posicionadas por hora real en
// vez de apiladas en una lista -- pedido explícito de diseño ("vista de calendario del día...
// si aparece uno dándole click se vea los detalles, si está vacío se vea el día así vacío").
// El rango de horas sale de la configuración real del negocio (catalog.schedule.settings), con
// respaldo 09:00-19:00 si todavía no cargó.
function timeToMinutes(value) {
  const [h, m] = String(value).split(":").map(Number);
  return h * 60 + m;
}

function renderAgendaCalendar(groups, appointments) {
  const settings = state.catalog?.schedule?.settings || {};
  const openMin = timeToMinutes(settings.defaultOpeningTime || "09:00");
  const closeMin = timeToMinutes(settings.defaultClosingTime || "19:00");
  const totalMin = Math.max(60, closeMin - openMin);
  const pxPerMin = 1; // 1 hora = 60px, mismo alto que las etiquetas de hora y las líneas de la grilla
  const bodyHeight = totalMin * pxPerMin;

  const hours = [];
  for (let m = openMin; m <= closeMin; m += 60) hours.push(m);
  const hourGutter = document.createElement("div");
  hourGutter.className = "agenda-hours";
  hourGutter.style.height = `${bodyHeight + 34}px`;
  hourGutter.append(...hours.map((m) => {
    const label = document.createElement("div");
    label.className = "agenda-hour-label";
    label.style.height = "60px";
    label.textContent = new Date(`2000-01-01T${String(Math.floor(m / 60)).padStart(2, "0")}:00`).toLocaleTimeString("es-DO", { hour: "numeric" });
    return label;
  }));

  const columns = document.createElement("div");
  columns.className = "agenda-columns";
  columns.id = "agenda-columns-wrap";
  columns.style.gridTemplateColumns = `repeat(${groups.length}, minmax(170px,1fr))`;
  columns.append(...groups.map((group) => {
    const column = document.createElement("section");
    column.className = "agenda-cal-column";
    column.dataset.staffId = group.id;
    const head = document.createElement("div");
    head.className = "agenda-cal-column-head";
    head.textContent = group.name;
    const body = document.createElement("div");
    body.className = "agenda-cal-body";
    body.style.height = `${bodyHeight}px`;
    body.style.setProperty("--hour-px", "60px");
    const items = appointments.filter((item) => group.client ? true : item.staff_id === group.id);
    for (const item of items) {
      const start = timeToMinutes(item.start_time);
      const end = timeToMinutes(item.end_time);
      const block = document.createElement("button");
      block.type = "button";
      block.className = `agenda-cal-block status-${item.status}`;
      block.style.top = `${Math.max(0, (start - openMin) * pxPerMin)}px`;
      block.style.height = `${Math.max(18, (end - start) * pxPerMin - 2)}px`;
      const strong = document.createElement("strong");
      strong.textContent = `${item.start_time} · ${item.client_name || "Cliente"}`;
      const span = document.createElement("span");
      span.textContent = item.services;
      block.append(strong, span);
      block.addEventListener("click", () => openAppointmentDetail(item));
      body.append(block);
    }
    column.append(head, body);
    return column;
  }));

  return { hourGutter, columns };
}

function renderAgendaFilters(groups) {
  const filters = $("agenda-filters");
  if (groups.length < 2) { filters.replaceChildren(); return; }
  filters.replaceChildren(...groups.map((group) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "agenda-filter-chip active";
    chip.textContent = group.name;
    chip.addEventListener("click", () => {
      chip.classList.toggle("active");
      const column = $("agenda-columns-wrap")?.querySelector(`[data-staff-id="${group.id}"]`);
      if (column) column.classList.toggle("hidden", !chip.classList.contains("active"));
    });
    return chip;
  }));
}

async function showAgenda() {
  $("booking-card").classList.add("hidden"); $("client-appointments-card").classList.add("hidden"); $("success-card").classList.add("hidden"); $("agenda-card").classList.remove("hidden");
  $("booking-tab").classList.remove("active"); $("agenda-tab").classList.add("active");
  if (!state.account) { $("login-dialog").showModal(); return; }
  // applyAccount() puede llamar aquí antes de que loadCatalog() (en paralelo) termine de poner
  // la fecha de hoy por defecto -- sin esto, una cuenta de personal que aterriza directo en la
  // agenda al iniciar sesión dispararía la primera consulta con date="" (400 del servidor).
  if (!$("agenda-date").value) $("agenda-date").value = todayLocal();
  message($("agenda-message"), "Cargando agenda…", true);
  try {
    const result = await api(`/api/reservapp/agenda?date=${$("agenda-date").value}`);
    message($("agenda-message"));
    $("agenda-title").textContent = new Date(`${result.date}T12:00:00`).toLocaleDateString("es-DO", { weekday: "long", day: "numeric", month: "long" });
    $("agenda-intro").textContent = result.visibility === "team" ? "Todo el equipo puede ver clientes, servicios y ocupación de cada manicurista. Toca una cita para ver el detalle." : "Solo se muestran tus propias citas. Toca una cita para ver el detalle.";
    const groups = result.visibility === "team" ? result.staff.map((person) => ({ id: person.id, name: person.full_name })) : [{ id: state.account.clientId, name: "Mis citas", client: true }];
    renderAgendaFilters(groups);
    const { hourGutter, columns } = renderAgendaCalendar(groups, result.appointments);
    $("agenda-board").replaceChildren(hourGutter, columns);
  } catch (error) { message($("agenda-message"), error.message); }
}
$("close-appointment-detail").addEventListener("click", () => $("appointment-detail-dialog").close());

// Etiquetas humanas de las dos dimensiones independientes de una cita -- mismo vocabulario que ya
// usa el ERP legado (outputs/app.js CONFIRM_NOTES/DEPOSIT_NOTES) para que administración y
// clientas vean exactamente el mismo lenguaje en ambos lados.
const CONFIRM_STATUS_LABELS = {
  Programada: "Recordatorio de confirmación programado",
  PendienteConfirmarHora: "Esperando tu confirmación",
  EspacioLiberado: "Tu horario podría liberarse pronto -- confirma ya",
  HoraConfirmada: "Asistencia confirmada",
  NoRequerida: "Sin recordatorio necesario",
};
const DEPOSIT_STATUS_LABELS = {
  Pendiente: "Depósito pendiente",
  ComprobanteRecibido: "Comprobante recibido",
  PendienteVerificacion: "Verificando comprobante",
  Verificado: "Depósito confirmado",
  Rechazado: "Depósito rechazado",
};
// Mismos tres estados que PENDING_CONFIRMATION_STATES en outputs/app.js -- son los únicos en los
// que confirmar todavía tiene sentido (HoraConfirmada/NoRequerida ya no necesitan acción).
const CONFIRMABLE_STATES = new Set(["Programada", "PendienteConfirmarHora", "EspacioLiberado"]);

function badgeEl(text, className) {
  const span = document.createElement("span");
  span.className = `appointment-badge ${className}`;
  span.textContent = text;
  return span;
}

function renderAppointmentCard(apt) {
  const card = document.createElement("article");
  card.className = "appointment-card";

  const top = document.createElement("div"); top.className = "appointment-top";
  const service = document.createElement("span"); service.className = "appointment-service"; service.textContent = apt.services || "Cita";
  const when = document.createElement("span"); when.className = "appointment-when";
  when.textContent = `${new Date(`${apt.date}T12:00:00`).toLocaleDateString("es-DO", { weekday: "short", day: "numeric", month: "short" })} · ${formatSlotTime(apt.start_time)}`;
  top.append(service, when);
  card.append(top);

  if (apt.staff_name) {
    const meta = document.createElement("div"); meta.className = "appointment-meta";
    meta.textContent = `Con ${apt.staff_name}`;
    card.append(meta);
  }

  const badges = document.createElement("div"); badges.className = "appointment-badges";
  const confirmLabel = CONFIRM_STATUS_LABELS[apt.confirmation_status];
  if (confirmLabel) badges.append(badgeEl(confirmLabel, `confirm-${String(apt.confirmation_status).toLowerCase()}`));
  const depositStatus = apt.deposit_status && DEPOSIT_STATUS_LABELS[apt.deposit_status] ? apt.deposit_status : "Pendiente";
  badges.append(badgeEl(DEPOSIT_STATUS_LABELS[depositStatus], `deposit-${depositStatus.toLowerCase()}`));
  card.append(badges);

  if (CONFIRMABLE_STATES.has(apt.confirmation_status)) {
    const btn = document.createElement("button");
    btn.className = "primary compact appointment-confirm-btn"; btn.type = "button";
    btn.textContent = "Confirmar mi hora";
    btn.addEventListener("click", () => confirmMyAppointment(apt.legacy_id, btn));
    card.append(btn);
  }
  return card;
}

async function confirmMyAppointment(reservationId, btn) {
  btn.disabled = true; btn.textContent = "Confirmando…";
  try {
    await api("/api/reservapp/booking/confirm-attendance", { method: "POST", body: JSON.stringify({ reservationId }) });
    await loadMyAppointments(state.myAppointmentsScope || "active");
  } catch (error) {
    message($("my-appointments-message"), error.message);
    btn.disabled = false; btn.textContent = "Confirmar mi hora";
  }
}

async function loadMyAppointments(scope) {
  state.myAppointmentsScope = scope;
  $("my-appointments-active-tab").classList.toggle("active", scope === "active");
  $("my-appointments-history-tab").classList.toggle("active", scope === "history");
  message($("my-appointments-message"), "Cargando…", true);
  try {
    const result = await api(`/api/reservapp/my-appointments?scope=${scope}`);
    $("my-appointments-list").replaceChildren();
    if (!result.appointments.length) {
      message($("my-appointments-message"), scope === "active" ? "No tienes citas activas por el momento." : "Aún no tienes historial de citas.");
      return;
    }
    message($("my-appointments-message"));
    result.appointments.forEach((apt) => $("my-appointments-list").append(renderAppointmentCard(apt)));
  } catch (error) { message($("my-appointments-message"), error.message); }
}

// Vista de clienta: "Citas activas"/"Historial" -- reemplaza a la Agenda de equipo que veía
// antes (pedido explícito: una clienta solo debe ver sus propias citas, no la agenda completa).
function showClientAppointments() {
  $("booking-card").classList.add("hidden"); $("agenda-card").classList.add("hidden"); $("success-card").classList.add("hidden");
  $("client-appointments-card").classList.remove("hidden");
  $("booking-tab").classList.remove("active"); $("agenda-tab").classList.add("active");
  if (!state.account) { $("login-dialog").showModal(); return; }
  loadMyAppointments("active");
}
$("my-appointments-active-tab").addEventListener("click", () => loadMyAppointments("active"));
$("my-appointments-history-tab").addEventListener("click", () => loadMyAppointments("history"));

function showBooking() {
  $("agenda-card").classList.add("hidden"); $("client-appointments-card").classList.add("hidden"); $("success-card").classList.add("hidden"); $("booking-card").classList.remove("hidden");
  $("agenda-tab").classList.remove("active"); $("booking-tab").classList.add("active");
}

// Identificarse es lo PRIMERO al querer reservar, antes de elegir servicios -- pedido
// explícito de diseño ("atención personalizada" desde el primer clic, no como último paso).
// Si ya hay sesión (clienta o personal) pasa directo a elegir servicios, como antes.
$("start-booking").addEventListener("click", () => {
  if (state.account) return goToStep(1);
  state.pendingBookingStart = true;
  $("identify-dialog").showModal();
});
$("close-identify").addEventListener("click", () => { state.pendingBookingStart = false; $("identify-dialog").close(); });
$("identify-login").addEventListener("click", () => {
  $("identify-dialog").close();
  message($("login-message"));
  $("login-dialog").showModal();
});
$("identify-new").addEventListener("click", () => {
  $("identify-dialog").close();
  $("phone-check-value").value = "";
  message($("phone-check-message"));
  $("phone-check-dialog").showModal();
});
$("close-phone-check").addEventListener("click", () => $("phone-check-dialog").close());

$("phone-check-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  message($("phone-check-message"), "Buscando…", true);
  const phone = $("phone-check-value").value;
  try {
    const result = await api("/api/reservapp/auth/check-phone", { method: "POST", body: JSON.stringify({ phone }) });
    $("phone-check-dialog").close();
    if (result.exists) {
      // Ya hay cuenta activa con ese teléfono -- confirma por nombre antes de pedir la
      // contraseña, en vez de simplemente rechazarla o crear una cuenta duplicada.
      $("login-phone").value = phone;
      message(
        $("login-message"),
        result.firstName
          ? `Ya hay una clienta registrada con este teléfono a nombre de ${result.firstName}. ¿Eres tú? Ingresa tu contraseña para confirmar.`
          : "Ese teléfono ya tiene una cuenta. Ingresa tu contraseña para confirmar.",
        true,
      );
      $("login-dialog").showModal();
    } else {
      // Sin cuenta activa (nueva, o pendiente de activar) -- sigue el registro normal, que ya
      // reutiliza la ficha pendiente si existe en vez de crear una duplicada.
      $("new-phone").value = phone;
      openClientDialog({ forEmployee: false, requireSelection: false });
    }
  } catch (error) { message($("phone-check-message"), error.message); }
  finally { button.disabled = false; }
});
$("step1-back").addEventListener("click", () => goToStep(0));
$("step1-next").addEventListener("click", () => {
  if (!selectedServiceIds().length) return message($("booking-message"), "Selecciona al menos un servicio.");
  message($("booking-message"));
  goToStep(2);
});
$("step2-back").addEventListener("click", () => goToStep(1));
// Si el día elegido no se labora (fin de semana fuera de weekDays, o una fecha en
// holidayClosures), en vez de bloquear con un error se avanza sola al próximo día hábil --
// pedido explícito de diseño ("que se siga hacia el próximo día").
$("date").addEventListener("change", () => {
  if (!$("date").value || !isClosedDate($("date").value)) return;
  const closedDate = $("date").value;
  $("date").value = nextOpenDate(closedDate);
  message($("booking-message"), `Ese día no laboramos -- te muestro el próximo día disponible.`, true);
});
$("step2-next").addEventListener("click", () => {
  if (!$("date").value) return message($("booking-message"), "Elige una fecha.");
  if (isClosedDate($("date").value)) {
    $("date").value = nextOpenDate($("date").value);
    message($("booking-message"), "Ese día no laboramos -- te muestro el próximo día disponible.", true);
    return;
  }
  message($("booking-message"));
  goToStep(3);
});
$("step3-back").addEventListener("click", () => goToStep(2));
// Botones duplicados arriba de cada paso -- mismo comportamiento que el de abajo, solo evita
// tener que bajar todo el listado para avanzar (pedido explícito de diseño).
$("step1-back-top").addEventListener("click", () => $("step1-back").click());
$("step1-next-top").addEventListener("click", () => $("step1-next").click());
$("step2-back-top").addEventListener("click", () => $("step2-back").click());
$("step2-next-top").addEventListener("click", () => $("step2-next").click());
$("step4-back").addEventListener("click", () => goToStep(3));

$("open-login").addEventListener("click", () => { message($("login-message")); $("login-dialog").showModal(); });
$("close-login").addEventListener("click", () => $("login-dialog").close());
$("close-client").addEventListener("click", () => $("client-dialog").close());

// Dos entradas distintas al MISMO diálogo de "primera vez", con comportamiento distinto al
// enviarlo (ver client-form submit abajo): la clienta que se registra sola (open-client)
// necesita verificar su teléfono por WhatsApp antes de que exista su ficha -- nadie del salón
// está validando esos datos. El personal (employee-new-client) SÍ está presente validando a
// la clienta en persona, así que no tiene sentido hacerla esperar un código; crea la ficha al
// instante contra /api/fast-booking/clients (mismo endpoint que ya usa la búsqueda existente).
function openClientDialog({ forEmployee, requireSelection = true }) {
  // El registro-invitada por WhatsApp (auto-servicio) guarda un borrador de UNA sola cita
  // (staff_id/appointment_date/appointment_time en una fila) -- no soporta todavía varias citas
  // vinculadas por groupId. En combo, solo el registro hecho por el personal funciona (crea la
  // ficha al instante y la reserva combinada se confirma después, ya con sesión iniciada).
  if (!forEmployee && Array.isArray(state.comboSegments) && state.comboSegments.length) {
    const target = $("booking-message");
    target.className = "message";
    target.replaceChildren(
      "Para servicios combinados con distinta manicurista, pide a una asesora que registre tu cita: ",
      Object.assign(document.createElement("a"), { href: "https://wa.me/18093463030", target: "_blank", rel: "noopener", textContent: "escríbenos por WhatsApp" }),
    );
    return;
  }
  state.clientDialogForEmployee = forEmployee;
  state.clientDialogRequireSelection = requireSelection;
  $("client-dialog-title").textContent = forEmployee ? "Registrar clienta" : "Crear mi acceso";
  const hasSelection = Boolean(selectedServiceIds().length && $("staff").value && $("date").value && $("time").value);
  $("client-dialog-intro").textContent = forEmployee
    ? "Regístrala al instante — tú ya la tienes en frente, no hace falta verificarla por WhatsApp."
    : hasSelection
      ? "Confirma tu teléfono, crea tu contraseña y tu cita quedará agendada."
      : "Confirma tu teléfono y crea tu contraseña para continuar.";
  $("client-form").querySelector("button[type=submit]").textContent = forEmployee ? "Registrar clienta" : "Continuar";
  message($("client-message"));
  if (!requireSelection || requireBookingSelection($("booking-message"))) $("client-dialog").showModal();
}
$("open-client").addEventListener("click", () => openClientDialog({ forEmployee: false }));
$("employee-new-client").addEventListener("click", () => openClientDialog({ forEmployee: true }));

$("client-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  // Identificarse antes de reservar (state.clientDialogRequireSelection === false) no debe
  // exigir servicio/manicurista/fecha/hora -- todavía no se ha llegado a esa parte del wizard.
  if (state.clientDialogRequireSelection && !requireBookingSelection($("client-message"))) return;
  const button = event.submitter; button.disabled = true;
  if (state.clientDialogForEmployee) {
    message($("client-message"), "Registrando…", true);
    try {
      const result = await api("/api/fast-booking/clients", {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          firstName: $("first-name").value, lastName: $("last-name").value, phone: $("new-phone").value, email: $("new-email").value,
          birthDate: $("new-birthdate").value, sex: $("new-sex").value, address: $("new-address").value, preferredService: $("new-preferred-service").value,
          actorType: "employee",
        }),
      });
      setClient(result.client);
      $("client-dialog").close();
      message($("booking-message"), `Clienta ${result.client.name} registrada. Ya puedes confirmar la reserva.`, true);
    } catch (error) {
      message($("client-message"), error.body?.duplicate ? "Ya existe una clienta con ese teléfono o correo." : error.message);
    } finally { button.disabled = false; }
    return;
  }
  message($("client-message"), "Guardando…", true);
  try {
    const result = await api("/api/reservapp/auth/request-setup", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(setupPayload()) });
    $("client-dialog").close(); message($("booking-message"), result.message, true);
    // TEMPORAL: ver comentario en server/app.mjs junto a RESERVAPP_SKIP_PHONE_VERIFICATION --
    // mientras Meta no apruebe la plantilla de activación, el backend puede saltarse el paso de
    // WhatsApp y mandar el activationTicket directo aquí.
    if (result.activationTicket) { openSetupDialog(result.activationTicket); return; }
    $("submit-booking").disabled = true;
    $("verify-code-phone").value = $("new-phone").value; $("verify-code-code").value = "";
    message($("verify-code-message")); $("verify-code-dialog").showModal();
  } catch (error) {
    message($("client-message"), error.message);
    if (error.body?.accountExists) {
      $("client-dialog").close();
      $("login-phone").value = $("new-phone").value;
      $("login-dialog").showModal();
      // Confirmación por nombre antes de pedirle la contraseña -- así sabe que no está
      // creando una cuenta duplicada, solo iniciando sesión en la que ya existe.
      const name = error.body.firstName;
      message($("login-message"), name ? `Ya hay una clienta registrada con este teléfono a nombre de ${name}. ¿Eres tú? Ingresa tu contraseña para confirmar.` : "Ese teléfono ya tiene una cuenta. Ingresa tu contraseña para confirmar.", true);
    }
  } finally { button.disabled = false; }
});

$("open-verify-code").addEventListener("click", () => { state.passwordResetFlow = false; $("login-dialog").close(); message($("verify-code-message")); $("verify-code-dialog").showModal(); });
$("close-verify-code").addEventListener("click", () => $("verify-code-dialog").close());

$("open-forgot-password").addEventListener("click", () => { $("login-dialog").close(); message($("forgot-password-message")); $("forgot-password-phone").value = $("login-phone").value; $("forgot-password-dialog").showModal(); });
$("close-forgot-password").addEventListener("click", () => $("forgot-password-dialog").close());

$("forgot-password-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; message($("forgot-password-message"), "Enviando…", true);
  try {
    const result = await api("/api/reservapp/auth/request-password-reset", { method: "POST", body: JSON.stringify({ phone: $("forgot-password-phone").value }) });
    // TEMPORAL: mientras el backend tenga apagado el autoservicio (ver comentario junto a
    // /auth/request-password-reset en server/app.mjs), no hay código que verificar -- solo
    // mostramos el mensaje que indica pedirle a administración que restablezca la contraseña.
    if (result.selfServiceDisabled) { $("forgot-password-dialog").close(); message($("booking-message"), result.message, true); return; }
    state.passwordResetFlow = true; $("forgot-password-dialog").close(); message($("booking-message"), result.message, true);
    $("verify-code-phone").value = $("forgot-password-phone").value; $("verify-code-code").value = "";
    message($("verify-code-message")); $("verify-code-dialog").showModal();
  } catch (error) { message($("forgot-password-message"), error.message); }
  finally { button.disabled = false; }
});

function openSetupDialog(activationTicket) {
  state.activationTicket = activationTicket; $("verify-code-dialog").close();
  $("setup-password").value = ""; $("setup-password-confirm").value = ""; message($("setup-message"));
  $("setup-dialog-title").textContent = state.passwordResetFlow ? "Elige tu nueva contraseña" : "Crea tu contraseña";
  $("setup-form").querySelector("button[type=submit]").textContent = state.passwordResetFlow ? "Guardar nueva contraseña" : "Activar y confirmar cita";
  $("setup-dialog").showModal();
}

$("verify-code-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; message($("verify-code-message"), "Verificando…", true);
  try {
    const result = await api("/api/reservapp/setup/verify-code", { method: "POST", body: JSON.stringify({ phone: $("verify-code-phone").value, code: $("verify-code-code").value }) });
    openSetupDialog(result.activationTicket);
  } catch (error) { message($("verify-code-message"), error.message); }
  finally { button.disabled = false; }
});

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; message($("login-message"), "Entrando…", true);
  try {
    const result = await api("/api/reservapp/auth/login", { method: "POST", body: JSON.stringify({ phone: $("login-phone").value, password: $("login-password").value }) });
    applyAccount(result.account); $("login-dialog").close(); $("login-form").reset(); message($("booking-message"), `Hola, ${result.account.name}.`, true);
    if (state.pendingBookingStart && result.account.role === "clienta") { state.pendingBookingStart = false; goToStep(1); }
    else if (!$("agenda-card").classList.contains("hidden")) showAgenda();
  } catch (error) { message($("login-message"), error.message); }
  finally { button.disabled = false; }
});

// Antes un solo botón hacía doble función (login/logout, texto "{nombre} · Salir") -- ahora
// "cerrar sesión" es una acción explícita y separada, pedido de diseño para que no se confunda
// con solo ver el nombre de la cuenta.
$("account-button").addEventListener("click", () => { if (!state.account) { message($("login-message")); $("login-dialog").showModal(); } });
$("logout-link").addEventListener("click", async () => {
  await api("/api/reservapp/auth/logout", { method: "POST" }).catch(() => {});
  applyAccount(null); showBooking();
});

let searchTimer;
$("client-search").addEventListener("input", () => {
  clearTimeout(searchTimer); const query = $("client-search").value.trim();
  if (query.length < 2) return $("client-results").replaceChildren();
  searchTimer = setTimeout(async () => {
    try {
      const result = await api(`/api/fast-booking/clients?q=${encodeURIComponent(query)}`);
      $("client-results").replaceChildren(...result.clients.map((client) => {
        const button = document.createElement("button"); button.type = "button"; button.className = "client-result";
        const strong = document.createElement("strong"); strong.textContent = client.full_name;
        const small = document.createElement("small"); small.textContent = client.phone || client.email || "Cliente registrado";
        button.append(strong, small); button.addEventListener("click", () => setClient({ id: client.id, name: client.full_name })); return button;
      }));
    } catch (error) { message($("booking-message"), error.message); }
  }, 280);
});

$("booking-form").addEventListener("submit", async (event) => {
  event.preventDefault(); message($("booking-message"));
  if (!requireBookingSelection($("booking-message"))) return;
  if (!state.account) return $("login-dialog").showModal();
  if (!state.client) return message($("booking-message"), "Selecciona la clienta de la cita.");
  const button = $("submit-booking"); button.disabled = true; button.textContent = "Reservando…";
  const isCombo = Array.isArray(state.comboSegments) && state.comboSegments.length > 0;
  try {
    const result = await api("/api/fast-booking/appointments", {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(isCombo
        ? { clientId: state.client.id, segments: state.comboSegments.map(({ serviceIds, staffId, date, time }) => ({ serviceIds, staffId, date, time })), notes: $("notes").value, actorType: state.account.role === "clienta" ? "customer" : "employee", website: $("website").value }
        : { clientId: state.client.id, serviceIds: selectedServiceIds(), staffId: $("staff").value, date: $("date").value, time: $("time").value, notes: $("notes").value, actorType: state.account.role === "clienta" ? "customer" : "employee", website: $("website").value }),
    });
    if (isCombo) {
      const details = state.comboSegments.map((segment) => `${segment.serviceName} con ${segment.staffName} a las ${formatSlotTime(segment.time)}`).join(" · ");
      $("success-summary").textContent = `${details}, el ${new Date(`${$("date").value}T12:00:00`).toLocaleDateString("es-DO", { dateStyle: "long" })}. Referencia: ${result.appointments.map((item) => item.reference).join(", ")}`;
    } else {
      const names = selectedServices().map((item) => item.name).join(", ");
      const person = state.catalog.staff.find((item) => item.id === $("staff").value)?.name;
      $("success-summary").textContent = `${names} con ${person}, el ${new Date(`${$("date").value}T12:00:00`).toLocaleDateString("es-DO", { dateStyle: "long" })} a las ${new Date(`2000-01-01T${$("time").value}:00`).toLocaleTimeString("es-DO", { hour: "numeric", minute: "2-digit" })}. Referencia: ${result.appointment.reference}`;
    }
    $("booking-card").classList.add("hidden"); $("success-card").classList.remove("hidden"); window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    message($("booking-message"), error.message);
    if (error.body?.conflict) goToStep(3); // el horario se ocupó -- vuelve a elegir de la lista fresca
  }
  finally { button.disabled = false; button.textContent = "Confirmar reserva"; }
});

$("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const password = $("setup-password").value;
  if (password !== $("setup-password-confirm").value) return message($("setup-message"), "Las contraseñas no coinciden.");
  const button = event.submitter; button.disabled = true; message($("setup-message"), "Activando…", true);
  try {
    const result = await api("/api/reservapp/auth/complete-setup", { method: "POST", body: JSON.stringify({ token: state.activationTicket, password }) });
    const wasPasswordReset = state.passwordResetFlow;
    state.activationTicket = null; state.passwordResetFlow = false; applyAccount(result.account); $("setup-dialog").close();
    if (result.appointment) {
      $("booking-card").classList.add("hidden"); $("success-card").classList.remove("hidden");
      $("success-summary").textContent = `Cita confirmada. Referencia: ${result.appointment.reference}`;
    } else if (wasPasswordReset) {
      message($("booking-message"), `Contraseña actualizada. Hola de nuevo, ${result.account.name}.`, true);
    } else if (state.pendingBookingStart) {
      state.pendingBookingStart = false;
      message($("booking-message"), `Cuenta creada. ¡Hola, ${result.account.name}!`, true);
      goToStep(1);
    } else message($("booking-message"), result.bookingError || "Cuenta activada. Ya puedes reservar.", !result.bookingError);
  } catch (error) { message($("setup-message"), error.message); }
  finally { button.disabled = false; }
});

$("create-account").addEventListener("click", async () => {
  message($("account-message"), "Enviando…", true);
  try {
    const result = await api("/api/reservapp/admin/accounts", { method: "POST", body: JSON.stringify({ staffId: $("account-staff").value, role: $("account-role").value, phone: $("account-phone").value }) });
    message($("account-message"), result.deliveryStatus === "sent" ? "Credenciales enviadas por WhatsApp." : "Cuenta creada; el envío de WhatsApp quedó pendiente.", true);
    loadEmployeesTable();
  } catch (error) { message($("account-message"), error.message); }
});

// ---------- Configuración de usuarios (Fase 5) ----------
const EMPLOYEE_STATUS_LABEL = { active: "Activa", suspended: "Suspendida", pending: "Pendiente" };
const CLIENT_STATUS_LABEL = { active: "Activa", blocked: "Bloqueada" };

$("open-user-management").addEventListener("click", () => {
  $("admin-panel").classList.remove("hidden");
  loadEmployeesTable();
  loadClientsAdmin();
  loadBusinessHours();
  loadStaffSchedule($("staff-schedule-select").value);
  // Si ya hay un banner publicado de una sesión anterior, reflejarlo aquí también (si no, el
  // botón "Quitar" solo aparecería después de generar y publicar uno nuevo en esta sesión).
  if (state.catalog?.banner) { generatedBanner = state.catalog.banner; renderBannerPreview(generatedBanner); $("banner-remove").classList.remove("hidden"); }
});
$("close-user-management").addEventListener("click", () => $("admin-panel").classList.add("hidden"));

async function loadEmployeesTable() {
  message($("employees-message"), "Cargando…", true);
  try {
    const { accounts } = await api("/api/reservapp/admin/accounts");
    message($("employees-message"));
    $("employees-body").replaceChildren(...accounts.map((account) => {
      const row = document.createElement("tr");
      const name = document.createElement("td"); name.textContent = account.full_name;
      const role = document.createElement("td"); role.textContent = account.role;
      const status = document.createElement("td");
      const badge = document.createElement("span"); badge.className = `admin-status ${account.status}`; badge.textContent = EMPLOYEE_STATUS_LABEL[account.status] || account.status;
      status.append(badge);
      const actions = document.createElement("td");
      const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "admin-row-action";
      toggle.textContent = account.status === "suspended" ? "Reactivar" : "Suspender";
      toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        try {
          await api(`/api/reservapp/admin/accounts/${account.id}`, { method: "PATCH", body: JSON.stringify({ status: account.status === "suspended" ? "active" : "suspended" }) });
          loadEmployeesTable();
        } catch (error) { message($("employees-message"), error.message); toggle.disabled = false; }
      });
      actions.append(toggle);
      row.append(name, role, status, actions);
      return row;
    }));
  } catch (error) { message($("employees-message"), error.message); }
}

let clientsAdminSearchTimer;
async function loadClientsAdmin(query = "") {
  message($("clients-admin-message"), "Cargando…", true);
  try {
    const { clients } = await api(`/api/reservapp/admin/clients${query ? `?q=${encodeURIComponent(query)}` : ""}`);
    message($("clients-admin-message"));
    $("clients-admin-body").replaceChildren(...clients.map((client) => {
      const row = document.createElement("tr");
      const name = document.createElement("td"); name.textContent = client.full_name;
      const phone = document.createElement("td"); phone.textContent = client.client_phone || "—";
      const status = document.createElement("td");
      const badge = document.createElement("span"); badge.className = `admin-status ${client.status}`; badge.textContent = CLIENT_STATUS_LABEL[client.status] || client.status;
      status.append(badge);
      const actions = document.createElement("td");
      const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "admin-row-action";
      toggle.textContent = client.status === "blocked" ? "Desbloquear" : "Bloquear";
      toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        try {
          await api(`/api/reservapp/admin/clients/${client.id}`, { method: "PATCH", body: JSON.stringify({ status: client.status === "blocked" ? "active" : "blocked" }) });
          loadClientsAdmin($("clients-admin-search").value.trim());
        } catch (error) { message($("clients-admin-message"), error.message); toggle.disabled = false; }
      });
      actions.append(toggle);
      // Mientras el autoservicio de "olvidé mi contraseña" esté apagado (ver comentario junto a
      // /auth/request-password-reset), esta es la única forma de restablecer la contraseña de
      // una clienta -- solo aplica si ya tiene cuenta de ReservApp (account_id).
      if (client.account_id) {
        const resetPassword = document.createElement("button"); resetPassword.type = "button"; resetPassword.className = "admin-row-action";
        resetPassword.textContent = "Restablecer contraseña";
        resetPassword.addEventListener("click", () => openAdminResetPassword({ accountId: client.account_id, name: client.full_name }));
        actions.append(resetPassword);
      }
      row.append(name, phone, status, actions);
      return row;
    }));
  } catch (error) { message($("clients-admin-message"), error.message); }
}
$("clients-admin-search").addEventListener("input", () => {
  clearTimeout(clientsAdminSearchTimer);
  clientsAdminSearchTimer = setTimeout(() => loadClientsAdmin($("clients-admin-search").value.trim()), 300);
});

// ---------- Horarios (Fase 7) ----------
// Único lugar que de verdad cambia la disponibilidad real de ReservApp -- ver comentario junto a
// businessSettings()/availability() en server/store.mjs. El horario general aplica a todo el
// negocio; una colaboradora con su propio horario configurado lo sigue a ella, no al general, los
// días que tenga fila (opt-in: sin ninguna fila, sigue el general como siempre).
const WEEKDAY_LABELS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
let businessHolidayClosures = [];

function renderScheduleGrid(container, { dayValues, prefix }) {
  container.replaceChildren(...WEEKDAY_LABELS.map((label, day) => {
    const existing = dayValues[day];
    const row = document.createElement("div");
    row.className = `schedule-day${existing ? "" : " day-closed"}`;
    row.dataset.day = day;
    const checkboxLabel = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox"; checkbox.className = `${prefix}-day-enabled`; checkbox.checked = Boolean(existing);
    checkbox.addEventListener("change", () => row.classList.toggle("day-closed", !checkbox.checked));
    checkboxLabel.append(checkbox, ` ${label}`);
    const openInput = document.createElement("input");
    openInput.type = "time"; openInput.className = `${prefix}-day-open`; openInput.value = existing?.open || "09:00";
    const closeInput = document.createElement("input");
    closeInput.type = "time"; closeInput.className = `${prefix}-day-close`; closeInput.value = existing?.close || "18:00";
    row.append(checkboxLabel, document.createElement("span"), openInput, closeInput);
    return row;
  }));
}

function readScheduleGrid(container) {
  const values = {};
  container.querySelectorAll(".schedule-day").forEach((row) => {
    const day = row.dataset.day;
    const enabled = row.querySelector("input[type=checkbox]").checked;
    values[day] = enabled ? { open: row.querySelector("input[class$='-day-open']").value, close: row.querySelector("input[class$='-day-close']").value } : null;
  });
  return values;
}

function renderHolidayClosuresList() {
  $("holiday-closures-list").replaceChildren(...businessHolidayClosures.map((date) => {
    const li = document.createElement("li");
    const label = document.createElement("span"); label.textContent = new Date(`${date}T12:00:00`).toLocaleDateString("es-DO", { dateStyle: "long" });
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "admin-row-action"; remove.textContent = "Quitar";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await api("/api/reservapp/admin/business-settings", { method: "PATCH", body: JSON.stringify({ holidayClosures: businessHolidayClosures.filter((item) => item !== date) }) });
        loadBusinessHours();
      } catch (error) { message($("business-hours-message"), error.message); remove.disabled = false; }
    });
    li.append(label, remove);
    return li;
  }));
}

async function loadBusinessHours() {
  message($("business-hours-message"), "Cargando…", true);
  try {
    const { settings } = await api("/api/reservapp/admin/business-settings");
    const weeklyHours = settings.weeklyHours || {};
    const weekDays = new Set(Array.isArray(settings.weekDays) ? settings.weekDays : [1, 2, 3, 4, 5, 6]);
    const dayValues = {};
    for (let day = 0; day <= 6; day += 1) {
      const override = Object.prototype.hasOwnProperty.call(weeklyHours, String(day)) ? weeklyHours[String(day)] : undefined;
      dayValues[day] = override !== undefined ? override : (weekDays.has(day) ? { open: settings.defaultOpeningTime || "09:00", close: settings.defaultClosingTime || "18:00" } : null);
    }
    renderScheduleGrid($("business-weekdays-grid"), { dayValues, prefix: "business" });
    businessHolidayClosures = Array.isArray(settings.holidayClosures) ? [...settings.holidayClosures].sort() : [];
    renderHolidayClosuresList();
    message($("business-hours-message"));
  } catch (error) { message($("business-hours-message"), error.message); }
}

$("business-hours-save").addEventListener("click", async () => {
  const button = $("business-hours-save"); button.disabled = true;
  message($("business-hours-message"), "Guardando…", true);
  try {
    const dayValues = readScheduleGrid($("business-weekdays-grid"));
    const weekDays = Object.entries(dayValues).filter(([, value]) => value).map(([day]) => Number(day));
    await api("/api/reservapp/admin/business-settings", { method: "PATCH", body: JSON.stringify({ weekDays, weeklyHours: dayValues }) });
    message($("business-hours-message"), "Horario general guardado.", true);
  } catch (error) { message($("business-hours-message"), error.message); }
  finally { button.disabled = false; }
});

$("holiday-closure-add").addEventListener("click", async () => {
  const date = $("holiday-closure-date").value;
  if (!date) return message($("business-hours-message"), "Elige una fecha.");
  const button = $("holiday-closure-add"); button.disabled = true;
  try {
    await api("/api/reservapp/admin/business-settings", { method: "PATCH", body: JSON.stringify({ holidayClosures: [...businessHolidayClosures, date] }) });
    $("holiday-closure-date").value = "";
    loadBusinessHours();
  } catch (error) { message($("business-hours-message"), error.message); }
  finally { button.disabled = false; }
});

async function loadStaffSchedule(staffId) {
  if (!staffId) { renderScheduleGrid($("staff-weekdays-grid"), { dayValues: {}, prefix: "staff" }); $("staff-exceptions-list").replaceChildren(); return; }
  message($("staff-schedule-message"), "Cargando…", true);
  try {
    const [{ schedules }, { exceptions }] = await Promise.all([
      api(`/api/reservapp/admin/staff-schedules?staffId=${encodeURIComponent(staffId)}`),
      api(`/api/reservapp/admin/staff-schedule-exceptions?staffId=${encodeURIComponent(staffId)}`),
    ]);
    const dayValues = {};
    for (const row of schedules) dayValues[row.weekday] = { open: row.start_time.slice(0, 5), close: row.end_time.slice(0, 5) };
    renderScheduleGrid($("staff-weekdays-grid"), { dayValues, prefix: "staff" });
    $("staff-exceptions-list").replaceChildren(...exceptions.map((exception) => {
      const li = document.createElement("li");
      const dateLabel = new Date(`${exception.exception_date}T12:00:00`).toLocaleDateString("es-DO", { dateStyle: "long" });
      const hoursLabel = exception.available ? (exception.start_time ? ` (${exception.start_time.slice(0, 5)}–${exception.end_time.slice(0, 5)})` : "") : "libre todo el día";
      const label = document.createElement("span"); label.textContent = `${dateLabel} — ${exception.available ? "trabaja" + hoursLabel : hoursLabel}${exception.reason ? ` · ${exception.reason}` : ""}`;
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "admin-row-action"; remove.textContent = "Quitar";
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await api(`/api/reservapp/admin/staff-schedule-exceptions/${encodeURIComponent(staffId)}/${exception.exception_date}`, { method: "DELETE" });
          loadStaffSchedule(staffId);
        } catch (error) { message($("staff-schedule-message"), error.message); remove.disabled = false; }
      });
      li.append(label, remove);
      return li;
    }));
    message($("staff-schedule-message"));
  } catch (error) { message($("staff-schedule-message"), error.message); }
}

$("staff-schedule-select").addEventListener("change", () => loadStaffSchedule($("staff-schedule-select").value));

$("staff-schedule-save").addEventListener("click", async () => {
  const staffId = $("staff-schedule-select").value;
  if (!staffId) return message($("staff-schedule-message"), "Selecciona una colaboradora.");
  const button = $("staff-schedule-save"); button.disabled = true;
  message($("staff-schedule-message"), "Guardando…", true);
  try {
    const dayValues = readScheduleGrid($("staff-weekdays-grid"));
    for (const [day, value] of Object.entries(dayValues)) {
      if (value) {
        await api("/api/reservapp/admin/staff-schedules", { method: "POST", body: JSON.stringify({ staffId, weekday: Number(day), startTime: value.open, endTime: value.close }) });
      } else {
        await api(`/api/reservapp/admin/staff-schedules/${encodeURIComponent(staffId)}/${day}`, { method: "DELETE" });
      }
    }
    message($("staff-schedule-message"), "Horario de la colaboradora guardado.", true);
  } catch (error) { message($("staff-schedule-message"), error.message); }
  finally { button.disabled = false; }
});

$("staff-exception-available").addEventListener("change", () => {
  $("staff-exception-hours").classList.toggle("hidden", $("staff-exception-available").value !== "true");
});

$("staff-exception-add").addEventListener("click", async () => {
  const staffId = $("staff-schedule-select").value;
  const date = $("staff-exception-date").value;
  if (!staffId) return message($("staff-schedule-message"), "Selecciona una colaboradora.");
  if (!date) return message($("staff-schedule-message"), "Elige una fecha.");
  const available = $("staff-exception-available").value === "true";
  const button = $("staff-exception-add"); button.disabled = true;
  try {
    await api("/api/reservapp/admin/staff-schedule-exceptions", {
      method: "POST",
      body: JSON.stringify({
        staffId, date, available, reason: $("staff-exception-reason").value,
        startTime: available ? $("staff-exception-start").value : "", endTime: available ? $("staff-exception-end").value : "",
      }),
    });
    $("staff-exception-date").value = ""; $("staff-exception-reason").value = ""; $("staff-exception-available").value = "false";
    $("staff-exception-hours").classList.add("hidden");
    loadStaffSchedule(staffId);
  } catch (error) { message($("staff-schedule-message"), error.message); }
  finally { button.disabled = false; }
});

let adminResetPasswordAccountId = null;
function openAdminResetPassword({ accountId, name }) {
  adminResetPasswordAccountId = accountId;
  $("admin-reset-password-name").textContent = name || "";
  $("admin-reset-password-value").value = "";
  message($("admin-reset-password-message"));
  $("admin-reset-password-dialog").showModal();
}
$("close-admin-reset-password").addEventListener("click", () => $("admin-reset-password-dialog").close());
$("admin-reset-password-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  message($("admin-reset-password-message"), "Guardando…", true);
  try {
    await api(`/api/reservapp/admin/accounts/${adminResetPasswordAccountId}/reset-password`, {
      method: "POST", body: JSON.stringify({ password: $("admin-reset-password-value").value }),
    });
    $("admin-reset-password-dialog").close();
    message($("clients-admin-message"), "Contraseña actualizada.", true);
  } catch (error) { message($("admin-reset-password-message"), error.message); }
  finally { button.disabled = false; }
});

// ---------- Banner promocional con IA (Fase 6) ----------
let generatedBanner = null;
function renderBannerPreview(banner) {
  const preview = $("banner-preview");
  if (!banner) { preview.classList.add("hidden"); return; }
  preview.textContent = banner.text;
  preview.style.background = banner.bgColor;
  preview.style.color = banner.textColor;
  preview.classList.remove("hidden");
}
$("banner-generate").addEventListener("click", async () => {
  const instructions = $("banner-instructions").value.trim();
  if (!instructions) return message($("banner-message"), "Escribe qué quieres anunciar.");
  const button = $("banner-generate"); button.disabled = true; message($("banner-message"), "Generando con IA…", true);
  try {
    const result = await api("/api/reservapp/admin/banner/generate", { method: "POST", body: JSON.stringify({ instructions }) });
    generatedBanner = result.banner;
    renderBannerPreview(generatedBanner);
    $("banner-publish").classList.remove("hidden");
    message($("banner-message"), "Vista previa lista. Publícalo si te gusta.", true);
  } catch (error) { message($("banner-message"), error.message); }
  finally { button.disabled = false; }
});
$("banner-publish").addEventListener("click", async () => {
  if (!generatedBanner) return;
  const button = $("banner-publish"); button.disabled = true;
  try {
    await api("/api/reservapp/admin/banner", { method: "POST", body: JSON.stringify(generatedBanner) });
    message($("banner-message"), "Banner publicado.", true);
    $("banner-remove").classList.remove("hidden");
  } catch (error) { message($("banner-message"), error.message); }
  finally { button.disabled = false; }
});
$("banner-remove").addEventListener("click", async () => {
  const button = $("banner-remove"); button.disabled = true;
  try {
    await api("/api/reservapp/admin/banner", { method: "DELETE" });
    generatedBanner = null;
    renderBannerPreview(null);
    $("promo-banner").classList.add("hidden");
    $("banner-publish").classList.add("hidden");
    $("banner-remove").classList.add("hidden");
    message($("banner-message"), "Banner quitado.", true);
  } catch (error) { message($("banner-message"), error.message); }
  finally { button.disabled = false; }
});

$("booking-tab").addEventListener("click", showBooking);
$("agenda-tab").addEventListener("click", () => {
  if (state.account && employeeRoles.has(state.account.role)) showAgenda();
  else showClientAppointments();
});
$("agenda-date").addEventListener("change", showAgenda);
$("agenda-prev").addEventListener("click", () => { const date = new Date(`${$("agenda-date").value}T12:00:00`); date.setDate(date.getDate() - 1); $("agenda-date").value = date.toISOString().slice(0, 10); showAgenda(); });
$("agenda-next").addEventListener("click", () => { const date = new Date(`${$("agenda-date").value}T12:00:00`); date.setDate(date.getDate() + 1); $("agenda-date").value = date.toISOString().slice(0, 10); showAgenda(); });
$("new-booking").addEventListener("click", () => location.reload());

async function boot() {
  await Promise.all([loadCatalog(), loadSession()]);
  goToStep(0);
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
boot();
