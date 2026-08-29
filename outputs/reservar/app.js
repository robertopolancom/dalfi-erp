const $ = (id) => document.getElementById(id);
const state = { catalog: null, account: null, client: null, selectedSlot: null, fallbackSegments: null, activationTicket: null, passwordResetFlow: false, pendingBookingStart: false, agendaView: "day", quickSetupPhone: null };
const reservappConfig = window.DALFI_RESERVAPP_CONFIG || {};
const apiBase = String(reservappConfig.apiBase || "").replace(/\/$/, "");

const api = async (path, options = {}) => {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(`${apiBase}${path}`, { ...options, headers, credentials: "include" });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || "No se pudo completar la solicitud."), { status: response.status, body });
  return body;
};

// La migración 0016 del ERP renombró el rol "clienta" a "cliente". Este frontend (Cloudflare) y
// el backend (Render) se publican por separado, y la migración es un tercer paso aparte -- así
// que la sesión puede llegar con cualquiera de los dos valores. Si aquí se compara solo contra
// uno, en esa ventana un cliente se toma por personal: la app le pediría elegir "el cliente de
// la cita" (búsqueda que el backend solo permite a personal) y no podría reservar.
// Cuando la migración lleve tiempo aplicada en producción, se puede dejar solo "cliente".
const isClientRole = (role) => role === "cliente" || role === "clienta";

const message = (element, text = "", ok = false) => {
  element.textContent = text;
  element.className = ok ? "message ok" : "message";
};
const todayLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santo_Domingo" }).format(new Date());
// weekDays/holidayClosures ya los respeta la disponibilidad real del backend (server/store.mjs) --
// esto solo evita que el cliente llegue a elegir un día que de todos modos va a salir sin horarios.
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
  state.client = isClientRole(account?.role) ? { id: account.clientId, name: account.name } : null;
  $("account-button").textContent = account ? account.name : "Entrar";
  $("logout-link").classList.toggle("hidden", !account);
  // Agenda/panel de personal es una función de cuenta identificada -- sin sesión no debe ni
  // aparecer el botón (pedido explícito de diseño).
  $("agenda-tab").classList.toggle("hidden", !account);
  // Sin sesión, "Agenda" queda oculta y "Nueva reserva" se queda sola en la barra de pestañas --
  // sin nada que alternar, es un botón que no hace nada útil en la pantalla inicial. Con sesión
  // (cliente o personal) sí es una pestaña real junto a "Citas activas"/"Panel de colaboradores".
  $("app-nav").classList.toggle("hidden", !account);
  $("guest-access").classList.toggle("hidden", Boolean(account));
  $("employee-client").classList.toggle("hidden", !account || !employeeRoles.has(account.role));
  const isAdmin = Boolean(account) && ["administradora", "superadministrador"].includes(account.role);
  $("open-user-management").classList.toggle("hidden", !isAdmin);
  // "Mi disponibilidad" es para cualquier colaboradora con horario propio (manicurista/asistente
  // también, no solo administración) -- pedido explícito: cada una marca sus propios días/horas
  // no disponibles en vez de depender de que administración lo haga por ella.
  $("open-my-availability").classList.toggle("hidden", !account || !employeeRoles.has(account.role));
  $("admin-panel").classList.add("hidden"); // siempre arranca cerrado, se abre con el botón de arriba
  $("agenda-tab").textContent = account && employeeRoles.has(account.role) ? "Panel de colaboradores" : "Citas activas";
  $("mode-label").textContent = !account ? "Reserva rápida" : isClientRole(account.role) ? "Mi reserva" : "Reserva del equipo";
  if (state.client) setClient(state.client); else $("selected-client").classList.add("hidden");
  // Cuentas de personal aterrizan directo en el panel de colaboradores (agenda) -- ya no en el
  // wizard de reserva del cliente -- pedido explícito de diseño.
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

// Antes de pedir identificación, recuerda al cliente exactamente qué eligió -- con varios
// servicios, selectedServices() ya lista todos y state.selectedSlot es el único horario (la
// duración combinada la calculó el backend al armar los slots, ver loadSingleAvailability).
// Si en cambio aceptó una propuesta de horario alternativo (state.fallbackSegments, ver
// renderAvailabilityFallback), son varias citas -- se listan todas.
function renderBookingSelectionSummary() {
  const target = $("booking-selection-summary");
  if (Array.isArray(state.fallbackSegments) && state.fallbackSegments.length) {
    target.textContent = state.fallbackSegments
      .map((seg) => `${seg.serviceName} con ${seg.staffName} a las ${formatSlotTime(seg.time)}`)
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
    // Un cliente nunca debe abrir la app y encontrarse ya "logueado" -- si el dispositivo es
    // compartido, mostraría el nombre/citas del último cliente que reservó ahí. El cookie de
    // sesión sigue vigente (no se cierra sesión), solo no se aplica automáticamente; si es
    // ella, entra normal con su teléfono y contraseña. El personal sí mantiene su sesión de 30
    // días -- comparten el tablet de recepción y no tiene sentido pedirles credenciales cada
    // vez que abren la app.
    applyAccount(account && !isClientRole(account.role) ? account : null);
  } catch { applyAccount(null); }
}

// Agrupa los slots devueltos por /api/fast-booking/availability en una columna por
// manicurista, para que el cliente compare y elija directamente cuál y a qué hora, en vez de
// tener que elegir una manicurista a ciegas antes de ver si tiene espacio. onPick(staffId,
// slot) avanza al paso 4.
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

// Paso 3: consulta /api/fast-booking/availability SIN staffId -- el motor ya devuelve, en un
// solo llamado, los horarios libres de TODAS las manicuristas elegibles. Con varios servicios
// seleccionados, serviceIds trae más de un id y el backend suma sus duraciones para calcular el
// bloque continuo real (ver server/store.mjs: availability()) -- el cliente elige un único
// horario para todo el bloque, con una sola manicurista que sepa hacer todos los servicios
// elegidos, en vez de repartirlos en horarios sueltos.
async function loadSingleAvailability(serviceIds, date) {
  $("step3-heading").textContent = "Paso 3 · Elige horario y manicurista";
  message($("availability-message"), "Consultando agenda…", true);
  $("staff-slots-board").replaceChildren();
  $("availability-fallback").replaceChildren();
  try {
    const result = await api(`/api/fast-booking/availability?serviceIds=${encodeURIComponent(serviceIds.join(","))}&date=${date}`);
    if (serviceIds.length > 1 && result.durationMinutes) {
      $("step3-heading").textContent = `Paso 3 · Elige horario y manicurista (${result.durationMinutes} min en total)`;
    }
    if (!result.slots.length) {
      message($("availability-message"), "No quedan horarios para este día con ninguna manicurista. Prueba otra fecha.");
      if (result.fallback) renderAvailabilityFallback(result.fallback);
      return;
    }
    message($("availability-message"));
    renderStaffSlotsBoard(result.slots, (staffId, slot) => {
      state.selectedSlot = slot; $("time").value = slot.time; $("staff").value = staffId;
      goToStep(4);
    });
  } catch (error) { message($("availability-message"), error.message); }
}

// Sin bloque continuo ese día para 2+ servicios, el backend ya probó una alternativa (ver
// availabilityFallback en server/store.mjs): misma manicurista con espera (same_staff_gap),
// distintas manicuristas lo más continuo posible (multi_staff), o ninguna de las dos
// (contact_agent). Muestra la propuesta con un botón para aceptarla tal cual -- confirmarla es
// la MISMA llamada con `segments` que ya usa el personal para reservas combinadas.
function renderAvailabilityFallback(fallback) {
  const container = $("availability-fallback");
  container.replaceChildren();
  const box = document.createElement("div"); box.className = "client-box";
  if (!fallback || fallback.tier === "contact_agent") {
    const p = document.createElement("p");
    p.append("No encontramos cómo acomodar todos los servicios ese día. ");
    p.append(Object.assign(document.createElement("a"), { href: "https://wa.me/18093463030", target: "_blank", rel: "noopener", textContent: "Escríbenos por WhatsApp" }));
    p.append(" y una asesora revisa la agenda contigo.");
    box.append(p);
    container.append(box);
    return;
  }
  const intro = document.createElement("p");
  intro.textContent = fallback.tier === "same_staff_gap"
    ? "No hay un horario 100% continuo ese día con una sola manicurista, pero sí podemos hacerlo así, con espera entre servicios:"
    : "No hay con la misma manicurista ese día, pero sí repartido entre distintas manicuristas así:";
  box.append(intro);
  const summary = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = fallback.segments.map((seg) => `${seg.serviceName} con ${seg.staffName} a las ${formatSlotTime(seg.time)}`).join(" · ");
  summary.append(strong);
  box.append(summary);
  const confirmButton = document.createElement("button"); confirmButton.type = "button"; confirmButton.className = "primary";
  confirmButton.textContent = "Confirmar este horario";
  confirmButton.addEventListener("click", () => {
    state.fallbackSegments = fallback.segments.map((seg) => ({
      serviceIds: [seg.serviceId], staffId: seg.staffId, date: $("date").value, time: seg.time,
      staffName: seg.staffName, serviceName: seg.serviceName,
    }));
    goToStep(4);
  });
  box.append(confirmButton);
  container.append(box);
}

async function loadAvailability() {
  const serviceIds = selectedServiceIds();
  const date = $("date").value;
  state.selectedSlot = null; $("time").value = ""; $("staff").value = ""; state.fallbackSegments = null;
  if (!serviceIds.length || !date) {
    message($("availability-message"), "Selecciona servicios y una fecha antes de este paso.");
    $("staff-slots-board").replaceChildren();
    $("availability-fallback").replaceChildren();
    return;
  }
  return loadSingleAvailability(serviceIds, date);
}

function requireBookingSelection(targetMessage) {
  if (!selectedServiceIds().length) { message(targetMessage, "Selecciona al menos un servicio."); return false; }
  if (Array.isArray(state.fallbackSegments) && state.fallbackSegments.length) return true;
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
    ["Cliente", item.client_name || "Cliente"],
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

// Panel de colaboradoras: vista de "Día" (grilla horaria por manicurista, ya existente) o
// "Semana" (lista compacta por día -- pedido explícito: el volumen de citas no justifica repetir
// la grilla horaria 7 veces, una lista simple por día alcanza).
async function showAgenda() {
  $("booking-card").classList.add("hidden"); $("client-appointments-card").classList.add("hidden"); $("success-card").classList.add("hidden"); $("agenda-card").classList.remove("hidden");
  $("booking-tab").classList.remove("active"); $("agenda-tab").classList.add("active");
  if (!state.account) { $("login-dialog").showModal(); return; }
  // applyAccount() puede llamar aquí antes de que loadCatalog() (en paralelo) termine de poner
  // la fecha de hoy por defecto -- sin esto, una cuenta de personal que aterriza directo en la
  // agenda al iniciar sesión dispararía la primera consulta con date="" (400 del servidor).
  if (!$("agenda-date").value) $("agenda-date").value = todayLocal();
  await loadAgendaView();
}

async function loadAgendaView() {
  if (state.agendaView === "week") return loadAgendaWeek();
  return loadAgendaDay();
}

async function loadAgendaDay() {
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

function startOfWeek(dateStr) {
  const d = new Date(`${dateStr}T12:00:00-04:00`);
  const day = d.getDay(); // 0=domingo
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day)); // retrocede al lunes de esa semana
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santo_Domingo" }).format(d);
}

async function loadAgendaWeek() {
  message($("agenda-message"), "Cargando semana…", true);
  $("agenda-filters").replaceChildren();
  const monday = startOfWeek($("agenda-date").value || todayLocal());
  const days = [...Array(7)].map((_, i) => {
    const d = new Date(`${monday}T12:00:00-04:00`); d.setDate(d.getDate() + i);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santo_Domingo" }).format(d);
  });
  try {
    const results = await Promise.all(days.map((date) => api(`/api/reservapp/agenda?date=${date}`)));
    message($("agenda-message"));
    const sunday = days[6];
    $("agenda-title").textContent = `Semana del ${new Date(`${monday}T12:00:00`).toLocaleDateString("es-DO", { day: "numeric", month: "long" })} al ${new Date(`${sunday}T12:00:00`).toLocaleDateString("es-DO", { day: "numeric", month: "long" })}`;
    $("agenda-intro").textContent = "Resumen de la semana, un vistazo por día. Cambia a «Día» para ver la ocupación hora por hora de cada manicurista.";
    $("agenda-week-board").replaceChildren(...days.map((date, index) => {
      const container = document.createElement("div"); container.className = "agenda-week-day";
      const heading = document.createElement("h3");
      heading.textContent = new Date(`${date}T12:00:00`).toLocaleDateString("es-DO", { weekday: "long", day: "numeric", month: "short" });
      container.append(heading);
      const appointments = (results[index].appointments || []).slice().sort((a, b) => a.start_time.localeCompare(b.start_time));
      if (!appointments.length) {
        const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "Sin citas.";
        container.append(empty);
      } else {
        const list = document.createElement("div"); list.className = "client-appointments-list";
        appointments.forEach((apt) => list.append(renderTeamAppointmentCard(apt)));
        container.append(list);
      }
      return container;
    }));
  } catch (error) { message($("agenda-message"), error.message); }
}

function setAgendaView(view) {
  state.agendaView = view;
  $("agenda-view-day").classList.toggle("active", view === "day");
  $("agenda-view-week").classList.toggle("active", view === "week");
  $("agenda-board").classList.toggle("hidden", view !== "day");
  $("agenda-week-board").classList.toggle("hidden", view !== "week");
  loadAgendaView();
}
$("agenda-view-day").addEventListener("click", () => setAgendaView("day"));
$("agenda-view-week").addEventListener("click", () => setAgendaView("week"));

$("close-appointment-detail").addEventListener("click", () => $("appointment-detail-dialog").close());

// Etiquetas humanas de las dos dimensiones independientes de una cita -- mismo vocabulario que ya
// usa el ERP legado (outputs/app.js CONFIRM_NOTES/DEPOSIT_NOTES) para que administración y
// clientes vean exactamente el mismo lenguaje en ambos lados.
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

// Misma tarjeta que renderAppointmentCard, pero para la vista semanal del equipo (agenda() trae
// cliente + manicurista, no solo manicurista como en /my-appointments) -- el día ya lo indica el
// encabezado del día en loadAgendaWeek, así que aquí solo hace falta la hora.
function renderTeamAppointmentCard(apt) {
  const card = document.createElement("article");
  card.className = "appointment-card";

  const top = document.createElement("div"); top.className = "appointment-top";
  const service = document.createElement("span"); service.className = "appointment-service"; service.textContent = apt.services || "Cita";
  const when = document.createElement("span"); when.className = "appointment-when"; when.textContent = formatSlotTime(apt.start_time);
  top.append(service, when);
  card.append(top);

  const metaText = [apt.client_name, apt.staff_name ? `con ${apt.staff_name}` : null].filter(Boolean).join(" · ");
  if (metaText) {
    const meta = document.createElement("div"); meta.className = "appointment-meta"; meta.textContent = metaText;
    card.append(meta);
  }

  const badges = document.createElement("div"); badges.className = "appointment-badges";
  const confirmLabel = CONFIRM_STATUS_LABELS[apt.confirmation_status];
  if (confirmLabel) badges.append(badgeEl(confirmLabel, `confirm-${String(apt.confirmation_status).toLowerCase()}`));
  const depositStatus = apt.deposit_status && DEPOSIT_STATUS_LABELS[apt.deposit_status] ? apt.deposit_status : "Pendiente";
  badges.append(badgeEl(DEPOSIT_STATUS_LABELS[depositStatus], `deposit-${depositStatus.toLowerCase()}`));
  card.append(badges);

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

// Vista del cliente: "Citas activas"/"Historial" -- reemplaza a la Agenda de equipo que veía
// antes (pedido explícito: un cliente solo debe ver sus propias citas, no la agenda completa).
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
// Si ya hay sesión (cliente o personal) pasa directo a elegir servicios, como antes.
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
      // Ya hay una ficha con ese teléfono (con o sin contraseña creada) -- el servidor nunca
      // revela el nombre aquí (auditoría de seguridad 2026-08-25: antes lo hacía, y eso permitía
      // adivinar qué teléfonos son de clientes reales solo probando números). Confirmar que es
      // ella ahora pasa por que ELLA escriba su nombre, no por leerlo del servidor.
      openConfirmName({ phone, needsPasswordOnly: Boolean(result.needsPasswordOnly) });
    } else {
      // Sin cuenta activa ni ficha previa -- sigue el registro normal, que ya reutiliza la ficha
      // pendiente si existe en vez de crear una duplicada.
      $("new-phone").value = phone;
      openClientDialog({ forEmployee: false, requireSelection: false });
    }
  } catch (error) { message($("phone-check-message"), error.message); }
  finally { button.disabled = false; }
});

// Paso intermedio compartido por "Es mi primera vez" y "Olvidé mi contraseña" cuando ya existe
// una ficha con ese teléfono: en vez de que el servidor diga el nombre, la propia persona lo
// escribe y /auth/verify-name lo compara (tolerando errores de tipografía) sin nunca revelarlo
// -- ni siquiera la respuesta de "no coincide" distingue de "el teléfono no existía". Una vez
// verificada, "crear contraseña por primera vez" y "no recordarla" son la MISMA acción (definir
// una contraseña nueva) -- isReset solo cambia el texto que ve, nunca la lógica.
function openConfirmName({ phone, needsPasswordOnly, isReset = false }) {
  state.confirmNamePhone = phone;
  state.confirmNameNeedsPasswordOnly = needsPasswordOnly;
  state.passwordResetFlow = isReset;
  $("confirm-name-value").value = "";
  message($("confirm-name-message"));
  $("confirm-name-dialog").showModal();
}
$("close-confirm-name").addEventListener("click", () => $("confirm-name-dialog").close());
$("confirm-name-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  const typedName = $("confirm-name-value").value.trim();
  message($("confirm-name-message"), "Verificando…", true);
  try {
    const result = await api("/api/reservapp/auth/verify-name", { method: "POST", body: JSON.stringify({ phone: state.confirmNamePhone, firstName: typedName }) });
    if (!result.verified) {
      message($("confirm-name-message"), "No pudimos confirmar tu identidad con ese nombre. Revisa que esté bien escrito, o pide a administración que reinicie tu acceso.");
      return;
    }
    $("confirm-name-dialog").close();
    if (state.confirmNameNeedsPasswordOnly) {
      state.quickSetupPhone = state.confirmNamePhone;
      state.quickSetupFirstName = typedName;
      $("quick-setup-title").textContent = state.passwordResetFlow ? "Elige tu nueva contraseña" : "Crea tu contraseña";
      $("quick-setup-intro").textContent = state.passwordResetFlow
        ? `¡Hola, ${typedName}! Define una contraseña nueva.`
        : `¡Hola, ${typedName}! Ya tienes una ficha con nosotros, solo falta que crees tu contraseña.`;
      $("quick-setup-password").value = ""; $("quick-setup-password-confirm").value = "";
      message($("quick-setup-message"));
      $("quick-setup-dialog").showModal();
    } else {
      $("login-phone").value = state.confirmNamePhone;
      message($("login-message"), `¿Eres tú, ${typedName}? Ingresa tu contraseña para confirmar.`, true);
      $("login-dialog").showModal();
    }
  } catch (error) { message($("confirm-name-message"), error.message); }
  finally { button.disabled = false; }
});

$("close-quick-setup").addEventListener("click", () => $("quick-setup-dialog").close());
$("quick-setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("quick-setup-password").value;
  if (password !== $("quick-setup-password-confirm").value) return message($("quick-setup-message"), "Las contraseñas no coinciden.");
  const button = event.submitter; button.disabled = true;
  message($("quick-setup-message"), "Guardando…", true);
  try {
    const serviceIds = selectedServiceIds();
    const hasDraft = Boolean(serviceIds.length);
    const result = await api("/api/reservapp/auth/set-password-after-verification", {
      method: "POST",
      body: JSON.stringify({
        phone: state.quickSetupPhone, firstName: state.quickSetupFirstName, password,
        serviceIds, staffId: hasDraft ? $("staff").value : "", date: hasDraft ? $("date").value : "", time: hasDraft ? $("time").value : "",
        notes: $("notes").value,
      }),
    });
    const wasPasswordReset = state.passwordResetFlow;
    state.passwordResetFlow = false;
    applyAccount(result.account);
    $("quick-setup-dialog").close();
    if (result.appointment) {
      $("booking-card").classList.add("hidden"); $("success-card").classList.remove("hidden");
      $("success-summary").textContent = `Cita confirmada. Referencia: ${result.appointment.reference}`;
    } else if (wasPasswordReset) {
      message($("booking-message"), `Contraseña actualizada. Hola de nuevo, ${result.account.name}.`, true);
    } else if (state.pendingBookingStart) {
      state.pendingBookingStart = false;
      message($("booking-message"), `Cuenta creada. ¡Hola, ${result.account.name}!`, true);
      goToStep(1);
    } else message($("booking-message"), result.bookingError || "Contraseña guardada. Ya puedes reservar.", !result.bookingError);
  } catch (error) { message($("quick-setup-message"), error.message); }
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
// enviarlo (ver client-form submit abajo): el cliente que se registra solo (open-client)
// necesita verificar su teléfono por WhatsApp antes de que exista su ficha -- nadie del salón
// está validando esos datos. El personal (employee-new-client) SÍ está presente validando a
// al cliente en persona, así que no tiene sentido hacerlo esperar un código; crea la ficha al
// instante contra /api/fast-booking/clients (mismo endpoint que ya usa la búsqueda existente).
function openClientDialog({ forEmployee, requireSelection = true }) {
  // El registro-invitada por WhatsApp (auto-servicio) guarda un borrador de UNA sola cita
  // (staff_id/appointment_date/appointment_time en una fila) -- no soporta varias citas
  // vinculadas por groupId. Una propuesta de horario alternativo (ver availabilityFallback en
  // server/store.mjs) sí puede ser varias citas -- en ese caso, solo el registro hecho por el
  // personal funciona (crea la ficha al instante y la reserva se confirma después, ya con
  // sesión iniciada).
  if (!forEmployee && Array.isArray(state.fallbackSegments) && state.fallbackSegments.length) {
    const target = $("booking-message");
    target.className = "message";
    target.replaceChildren(
      "Para este horario con varias citas, pide a una asesora que registre tu cita: ",
      Object.assign(document.createElement("a"), { href: "https://wa.me/18093463030", target: "_blank", rel: "noopener", textContent: "escríbenos por WhatsApp" }),
    );
    return;
  }
  state.clientDialogForEmployee = forEmployee;
  state.clientDialogRequireSelection = requireSelection;
  $("client-dialog-title").textContent = forEmployee ? "Registrar cliente" : "Crear mi acceso";
  const hasSelection = Boolean(selectedServiceIds().length && $("staff").value && $("date").value && $("time").value);
  $("client-dialog-intro").textContent = forEmployee
    ? "Regístrala al instante — tú ya la tienes en frente, no hace falta verificarla por WhatsApp."
    : hasSelection
      ? "Confirma tu teléfono, crea tu contraseña y tu cita quedará agendada."
      : "Confirma tu teléfono y crea tu contraseña para continuar.";
  $("client-form").querySelector("button[type=submit]").textContent = forEmployee ? "Registrar cliente" : "Continuar";
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
      message($("booking-message"), `Cliente ${result.client.name} registrado. Ya puedes confirmar la reserva.`, true);
    } catch (error) {
      message($("client-message"), error.body?.duplicate ? "Ya existe un cliente con ese teléfono o correo." : error.message);
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
      // Condición de carrera real -- el servidor no revela el nombre aquí, ver /auth/check-phone.
      $("client-dialog").close();
      $("login-phone").value = $("new-phone").value;
      message($("login-message"), "Ese teléfono ya tiene una cuenta. Ingresa tu contraseña para confirmar.", true);
      $("login-dialog").showModal();
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
    // TEMPORAL a propósito (ver comentario junto a /auth/request-password-reset en
    // server/app.mjs): mientras Meta no apruebe la verificación real por WhatsApp, confirma
    // identidad por nombre en vez de mandar un código -- mismo paso intermedio que usa
    // check-phone, tanto si nunca creó contraseña como si la olvidó.
    if (result.needsNameConfirmation) {
      $("forgot-password-dialog").close();
      openConfirmName({ phone: $("forgot-password-phone").value, needsPasswordOnly: true, isReset: true });
      return;
    }
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
    if (state.pendingBookingStart && isClientRole(result.account.role)) { state.pendingBookingStart = false; goToStep(1); }
    else if (!$("agenda-card").classList.contains("hidden")) showAgenda();
  } catch (error) { message($("login-message"), error.message); }
  finally { button.disabled = false; }
});

// Antes un solo botón hacía doble función (login/logout, texto "{nombre} · Salir") -- ahora
// "cerrar sesión" es una acción explícita y separada, pedido de diseño para que no se confunda
// con solo ver el nombre de la cuenta.
$("account-button").addEventListener("click", () => { if (!state.account) { message($("login-message")); $("login-dialog").showModal(); } });
// Dispositivo compartido (tablet de recepción, teléfono que pasa de cliente en cliente): cerrar
// sesión debe dejar todo como recién cargado, para que la siguiente persona tenga que
// identificarse desde cero y no vea ni un campo con datos de la anterior -- pedido explícito.
function resetDeviceState() {
  ["booking-form", "identify-form", "phone-check-form", "confirm-name-form", "quick-setup-form", "client-form", "login-form", "forgot-password-form", "verify-code-form", "setup-form"].forEach((id) => {
    $(id)?.reset();
  });
  $("client-search").value = "";
  $("client-results").replaceChildren();
  $("selected-client").textContent = "";
  $("selected-client").classList.add("hidden");
  state.client = null;
  state.selectedSlot = null;
  state.fallbackSegments = null;
  state.pendingBookingStart = false;
  state.quickSetupPhone = null;
  goToStep(0);
}

$("logout-link").addEventListener("click", async () => {
  await api("/api/reservapp/auth/logout", { method: "POST" }).catch(() => {});
  applyAccount(null); resetDeviceState(); showBooking();
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
  if (!state.client) return message($("booking-message"), "Selecciona el cliente de la cita.");
  const button = $("submit-booking"); button.disabled = true; button.textContent = "Reservando…";
  // state.fallbackSegments solo existe si aceptó una propuesta de horario alternativo (ver
  // renderAvailabilityFallback) -- son varias citas vinculadas por groupId, mismo mecanismo
  // que ya usa el personal para reservas combinadas (createComboAppointment, sin cambios).
  const isFallback = Array.isArray(state.fallbackSegments) && state.fallbackSegments.length > 0;
  try {
    const result = await api("/api/fast-booking/appointments", {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(isFallback
        ? { clientId: state.client.id, segments: state.fallbackSegments.map(({ serviceIds, staffId, date, time }) => ({ serviceIds, staffId, date, time })), notes: $("notes").value, actorType: isClientRole(state.account.role) ? "customer" : "employee", website: $("website").value }
        : { clientId: state.client.id, serviceIds: selectedServiceIds(), staffId: $("staff").value, date: $("date").value, time: $("time").value, notes: $("notes").value, actorType: isClientRole(state.account.role) ? "customer" : "employee", website: $("website").value }),
    });
    if (isFallback) {
      const details = state.fallbackSegments.map((seg) => `${seg.serviceName} con ${seg.staffName} a las ${formatSlotTime(seg.time)}`).join(" · ");
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
const CLIENT_STATUS_LABEL = { active: "Activo", blocked: "Bloqueado" };

$("open-user-management").addEventListener("click", () => {
  $("admin-panel").classList.remove("hidden");
  loadEmployeesTable();
  loadClientsAdmin();
  loadBusinessHours();
  loadStaffSchedule($("staff-schedule-select").value);
  loadStaffScheduleChanges();
  // Si ya hay un banner publicado de una sesión anterior, reflejarlo aquí también (si no, el
  // botón "Quitar" solo aparecería después de generar y publicar uno nuevo en esta sesión).
  if (state.catalog?.banner) { generatedBanner = state.catalog.banner; renderBannerPreview(generatedBanner); $("banner-remove").classList.remove("hidden"); }
  // El panel aparece debajo de toda la grilla de la agenda del día -- sin este scroll, en
  // pantallas normales parece que el botón "no responde" porque no hay ningún cambio visible
  // hasta que se hace scroll manualmente (reportado en vivo 2026-08-25).
  $("admin-panel").scrollIntoView({ behavior: "smooth", block: "start" });
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
      // Editable en vez de solo texto -- antes no había forma de cambiarle el rol a alguien ya
      // creada, solo se elegía una vez al invitarla. Guarda apenas se cambia la selección; el
      // backend igual exige ser superadministrador para tocar cualquier cosa que sea o pase a
      // ser "superadministrador" (ver PATCH /admin/accounts/:id).
      const role = document.createElement("td");
      const roleSelect = document.createElement("select"); roleSelect.className = "admin-role-select";
      ["manicurista", "asistente", "administradora", "superadministrador"].forEach((value) => {
        roleSelect.append(new Option(value.charAt(0).toUpperCase() + value.slice(1), value, false, value === account.role));
      });
      roleSelect.addEventListener("change", async () => {
        const nextRole = roleSelect.value;
        roleSelect.disabled = true;
        try {
          await api(`/api/reservapp/admin/accounts/${account.id}`, { method: "PATCH", body: JSON.stringify({ role: nextRole }) });
          message($("employees-message"), `Rol de ${account.full_name} actualizado a ${nextRole}.`, true);
          account.role = nextRole;
        } catch (error) {
          message($("employees-message"), error.message);
          roleSelect.value = account.role;
        } finally { roleSelect.disabled = false; }
      });
      role.append(roleSelect);
      const status = document.createElement("td");
      const badge = document.createElement("span"); badge.className = `admin-status ${account.status}`; badge.textContent = EMPLOYEE_STATUS_LABEL[account.status] || account.status;
      status.append(badge);
      const actionsCell = document.createElement("td");
      const actions = document.createElement("div"); actions.className = "admin-row-actions";
      actionsCell.append(actions);
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
      // Misma válvula de escape que en la tabla de clientes (autoservicio de "olvidé mi
      // contraseña" apagado, ver /auth/request-password-reset) -- el personal también necesita
      // que administración pueda reiniciarle la contraseña.
      const resetPassword = document.createElement("button"); resetPassword.type = "button"; resetPassword.className = "admin-row-action";
      resetPassword.textContent = "Restablecer contraseña";
      resetPassword.addEventListener("click", () => openAdminResetPassword({ accountId: account.id, name: account.full_name, messageTarget: "employees-message" }));
      actions.append(resetPassword);
      actions.append(clearPasswordButton({ accountId: account.id, name: account.full_name, messageTarget: "employees-message", onDone: loadEmployeesTable }));
      actions.append(deleteAccountButton({ accountId: account.id, name: account.full_name, messageTarget: "employees-message", onDone: loadEmployeesTable }));
      row.append(name, role, status, actionsCell);
      return row;
    }));
  } catch (error) { message($("employees-message"), error.message); }
}

// Botón compartido por la tabla de Personal y la de Clientes: en vez de que administración
// escriba la contraseña nueva (openAdminResetPassword), borra la que tenía para que la
// propia persona la defina la próxima vez que ponga su teléfono en ReservApp.
function clearPasswordButton({ accountId, name, messageTarget, onDone }) {
  const button = document.createElement("button"); button.type = "button"; button.className = "admin-row-action";
  button.textContent = "Reiniciar acceso";
  button.title = `${name || "Esta persona"} tendrá que crear su propia contraseña de nuevo`;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api(`/api/reservapp/admin/accounts/${accountId}/clear-password`, { method: "POST" });
      message($(messageTarget), `Listo -- ${name || "esa persona"} deberá crear una contraseña nueva la próxima vez que entre.`, true);
      onDone?.();
    } catch (error) { message($(messageTarget), error.message); button.disabled = false; }
  });
  return button;
}

// Un paso más allá de "Reiniciar acceso": borra la cuenta de ReservApp entera (DELETE
// /admin/accounts/:id). La ficha de la colaboradora o del cliente se queda -- lo único que
// desaparece es el acceso a la app, y con él su teléfono queda libre para volver a invitarla.
function deleteAccountButton({ accountId, name, messageTarget, onDone }) {
  const button = document.createElement("button"); button.type = "button"; button.className = "admin-row-action danger";
  button.textContent = "Borrar credenciales";
  button.title = `${name || "Esta persona"} perderá el acceso a ReservApp; su ficha no se toca`;
  button.addEventListener("click", async () => {
    if (!confirm(`¿Borrar las credenciales de ReservApp de ${name || "esta persona"}?\n\nPerderá el acceso a la app y se cerrará su sesión. Su ficha y su historial no se tocan, y puedes volver a darle acceso cuando quieras.`)) return;
    button.disabled = true;
    try {
      await api(`/api/reservapp/admin/accounts/${accountId}`, { method: "DELETE" });
      message($(messageTarget), `Credenciales de ${name || "esa persona"} borradas.`, true);
      onDone?.();
    } catch (error) { message($(messageTarget), error.message); button.disabled = false; }
  });
  return button;
}

// "Borrar cliente" (DELETE /admin/clients/:id) -- borrado lógico en el ERP: la ficha desaparece
// de las búsquedas y del listado, pero sus citas pasadas y sus facturas se quedan donde están.
// El backend lo rechaza (409) si todavía tiene citas futuras sin cancelar.
function deleteClientButton({ client, onDone }) {
  const button = document.createElement("button"); button.type = "button"; button.className = "admin-row-action danger";
  button.textContent = "Borrar cliente";
  button.title = "Quita la ficha del ERP; el historial de citas y facturas se conserva";
  button.addEventListener("click", async () => {
    if (!confirm(`¿Borrar a ${client.full_name} del ERP?\n\nSu ficha deja de aparecer en búsquedas y no se le podrán agendar citas. Su historial de citas y facturas se conserva. Si vuelve al salón, hay que registrarlo de nuevo desde cero.`)) return;
    button.disabled = true;
    try {
      await api(`/api/reservapp/admin/clients/${client.id}`, { method: "DELETE" });
      message($("clients-admin-message"), `${client.full_name} fue borrado del ERP.`, true);
      onDone?.();
    } catch (error) { message($("clients-admin-message"), error.message); button.disabled = false; }
  });
  return button;
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
      const actionsCell = document.createElement("td");
      const actions = document.createElement("div"); actions.className = "admin-row-actions";
      actionsCell.append(actions);
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
      // un cliente -- solo aplica si ya tiene cuenta de ReservApp (account_id).
      if (client.account_id) {
        const resetPassword = document.createElement("button"); resetPassword.type = "button"; resetPassword.className = "admin-row-action";
        resetPassword.textContent = "Restablecer contraseña";
        resetPassword.addEventListener("click", () => openAdminResetPassword({ accountId: client.account_id, name: client.full_name }));
        actions.append(resetPassword);
        actions.append(clearPasswordButton({ accountId: client.account_id, name: client.full_name, messageTarget: "clients-admin-message", onDone: () => loadClientsAdmin($("clients-admin-search").value.trim()) }));
        actions.append(deleteAccountButton({ accountId: client.account_id, name: client.full_name, messageTarget: "clients-admin-message", onDone: () => loadClientsAdmin($("clients-admin-search").value.trim()) }));
      }
      actions.append(deleteClientButton({ client, onDone: () => loadClientsAdmin($("clients-admin-search").value.trim()) }));
      row.append(name, phone, status, actionsCell);
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

// Aviso arriba del panel: qué marcó cada colaboradora por su cuenta en "Mi disponibilidad"
// (created_by='staff' en el backend) -- así administración no tiene que ir colaboradora por
// colaboradora a ver si alguien cambió algo.
async function loadStaffScheduleChanges() {
  try {
    const { changes } = await api("/api/reservapp/admin/staff-schedule-changes");
    $("staff-schedule-changes-alert").classList.toggle("hidden", changes.length === 0);
    $("staff-schedule-changes-list").replaceChildren(...changes.map((change) => {
      const li = document.createElement("li");
      const dateLabel = new Date(`${change.exception_date}T12:00:00`).toLocaleDateString("es-DO", { dateStyle: "long" });
      const hoursLabel = change.available ? (change.start_time ? ` (${change.start_time.slice(0, 5)}–${change.end_time.slice(0, 5)})` : "") : "libre todo el día";
      const span = document.createElement("span");
      span.textContent = `${change.staff_name}: ${dateLabel} — ${change.available ? "trabaja" + hoursLabel : hoursLabel}${change.reason ? ` · ${change.reason}` : ""}`;
      li.append(span);
      return li;
    }));
  } catch { /* aviso opcional -- no bloquea el resto del panel si falla */ }
}

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

// ---------- Mi disponibilidad (autoservicio de cada colaboradora) ----------
async function loadMyAvailability() {
  message($("my-availability-message"), "Cargando…", true);
  try {
    const { exceptions } = await api("/api/reservapp/my-schedule-exceptions");
    message($("my-availability-message"));
    $("my-availability-list").replaceChildren(...exceptions.map((exception) => {
      const li = document.createElement("li");
      const dateLabel = new Date(`${exception.exception_date}T12:00:00`).toLocaleDateString("es-DO", { dateStyle: "long" });
      const hoursLabel = exception.available ? (exception.start_time ? ` (${exception.start_time.slice(0, 5)}–${exception.end_time.slice(0, 5)})` : "") : "libre todo el día";
      const label = document.createElement("span"); label.textContent = `${dateLabel} — ${exception.available ? "trabajo" + hoursLabel : hoursLabel}${exception.reason ? ` · ${exception.reason}` : ""}`;
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "admin-row-action"; remove.textContent = "Quitar";
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await api(`/api/reservapp/my-schedule-exceptions/${exception.exception_date}`, { method: "DELETE" });
          loadMyAvailability();
        } catch (error) { message($("my-availability-message"), error.message); remove.disabled = false; }
      });
      li.append(label, remove);
      return li;
    }));
  } catch (error) { message($("my-availability-message"), error.message); }
}

$("open-my-availability").addEventListener("click", () => {
  $("my-availability-date").value = ""; $("my-availability-reason").value = ""; $("my-availability-available").value = "false";
  $("my-availability-hours").classList.add("hidden");
  $("my-availability-dialog").showModal();
  loadMyAvailability();
});
$("close-my-availability").addEventListener("click", () => $("my-availability-dialog").close());
$("my-availability-available").addEventListener("change", () => {
  $("my-availability-hours").classList.toggle("hidden", $("my-availability-available").value !== "true");
});
$("my-availability-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const date = $("my-availability-date").value;
  if (!date) return message($("my-availability-message"), "Elige una fecha.");
  const available = $("my-availability-available").value === "true";
  const button = event.submitter; button.disabled = true;
  try {
    await api("/api/reservapp/my-schedule-exceptions", {
      method: "POST",
      body: JSON.stringify({
        date, available, reason: $("my-availability-reason").value,
        startTime: available ? $("my-availability-start").value : "", endTime: available ? $("my-availability-end").value : "",
      }),
    });
    $("my-availability-date").value = ""; $("my-availability-reason").value = ""; $("my-availability-available").value = "false";
    $("my-availability-hours").classList.add("hidden");
    message($("my-availability-message"), "Guardado.", true);
    loadMyAvailability();
  } catch (error) { message($("my-availability-message"), error.message); }
  finally { button.disabled = false; }
});

let adminResetPasswordAccountId = null;
let adminResetPasswordMessageTarget = null;
function openAdminResetPassword({ accountId, name, messageTarget = "clients-admin-message" }) {
  adminResetPasswordAccountId = accountId;
  adminResetPasswordMessageTarget = messageTarget;
  $("admin-reset-password-name").textContent = name || "";
  $("admin-reset-password-value").value = "";
  $("admin-reset-password-confirm").value = "";
  message($("admin-reset-password-message"));
  $("admin-reset-password-dialog").showModal();
}
$("close-admin-reset-password").addEventListener("click", () => $("admin-reset-password-dialog").close());
$("admin-reset-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("admin-reset-password-value").value;
  const confirm = $("admin-reset-password-confirm").value;
  if (password !== confirm) return message($("admin-reset-password-message"), "Las contraseñas no coinciden.");
  const button = event.submitter; button.disabled = true;
  message($("admin-reset-password-message"), "Guardando…", true);
  try {
    await api(`/api/reservapp/admin/accounts/${adminResetPasswordAccountId}/reset-password`, {
      method: "POST", body: JSON.stringify({ password }),
    });
    $("admin-reset-password-dialog").close();
    message($(adminResetPasswordMessageTarget || "clients-admin-message"), "Contraseña actualizada.", true);
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
$("agenda-date").addEventListener("change", loadAgendaView);
// En vista "Semana", ‹/› saltan 7 días (a la semana anterior/siguiente); en "Día", 1 día.
$("agenda-prev").addEventListener("click", () => { const step = state.agendaView === "week" ? 7 : 1; const date = new Date(`${$("agenda-date").value}T12:00:00`); date.setDate(date.getDate() - step); $("agenda-date").value = date.toISOString().slice(0, 10); loadAgendaView(); });
$("agenda-next").addEventListener("click", () => { const step = state.agendaView === "week" ? 7 : 1; const date = new Date(`${$("agenda-date").value}T12:00:00`); date.setDate(date.getDate() + step); $("agenda-date").value = date.toISOString().slice(0, 10); loadAgendaView(); });
$("new-booking").addEventListener("click", () => location.reload());

async function boot() {
  await Promise.all([loadCatalog(), loadSession()]);
  goToStep(0);
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
boot();
