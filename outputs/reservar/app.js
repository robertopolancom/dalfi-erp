const $ = (id) => document.getElementById(id);
const state = { catalog: null, account: null, client: null, selectedSlot: null, fallbackSegments: null, activationTicket: null, passwordResetFlow: false, pendingBookingStart: false, agendaView: "day", quickSetupPhone: null, appointmentDetailId: null, preferredAgendaStaffId: null, language: "es" };
const reservappConfig = window.DALFI_RESERVAPP_CONFIG || {};
const apiBase = String(reservappConfig.apiBase || "").replace(/\/$/, "");

// Botón EN/ES junto al login -- solo traduce el flujo de reserva/registro/"Mis citas" de la
// cliente (pedido explícito); la agenda y "Configuración de usuarios" del personal se quedan en
// español siempre, por eso el botón se oculta para cuentas de personal (ver applyAccount). Dos
// mecanismos conviven: t(es, en) para texto armado en JS en tiempo de ejecución (plantillas con
// variables), y el atributo data-en en el HTML para texto estático -- applyLanguage() recorre
// [data-en] y guarda el español original en data-es la primera vez, para poder volver a español
// sin recargar la página.
function t(es, en) {
  return state.language === "en" ? en : es;
}

function applyLanguage(lang) {
  state.language = lang;
  try { localStorage.setItem("reservapp_lang", lang); } catch { /* modo privado o cuota llena -- no afecta la sesión actual */ }
  document.querySelectorAll("[data-en]").forEach((el) => {
    if (el.dataset.es === undefined) el.dataset.es = el.textContent;
    el.textContent = lang === "en" ? el.dataset.en : el.dataset.es;
  });
  document.querySelectorAll("[data-en-placeholder]").forEach((el) => {
    if (el.dataset.esPlaceholder === undefined) el.dataset.esPlaceholder = el.getAttribute("placeholder") || "";
    el.setAttribute("placeholder", lang === "en" ? el.dataset.enPlaceholder : el.dataset.esPlaceholder);
  });
  $("lang-toggle").textContent = lang === "en" ? "ES" : "EN";
  $("lang-toggle").setAttribute("aria-label", lang === "en" ? "Cambiar a español" : "Switch to English");
  document.documentElement.lang = lang;
  // mode-label ("Reserva rápida"/"Mi reserva") y agenda-tab ("Citas activas") los arma
  // applyAccount() con t(), no [data-en] -- sin este re-aplique, un toggle después de que ya
  // cargó la sesión los dejaba pegados en el idioma con el que se pintaron la última vez
  // (bug real, encontrado probando el toggle a mano antes de dar esto por terminado).
  applyAccount(state.account);
  // Contenido ya pintado en pantalla que no pasa por [data-en] (tarjetas/mensajes generados en
  // JS con fechas/horas formateadas o plantillas con variables) -- se vuelve a pedir/pintar para
  // que refleje el idioma nuevo sin tener que recargar la página.
  if (!$("client-appointments-card").classList.contains("hidden")) loadMyAppointments(state.myAppointmentsScope || "active");
  if (!$("booking-card").classList.contains("hidden") && state.wizardStep === 3) loadAvailability();
  if (!$("success-card").classList.contains("hidden")) renderBankAccounts($("success-bank-accounts"));
}
$("lang-toggle").addEventListener("click", () => applyLanguage(state.language === "en" ? "es" : "en"));

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
  $("selected-client").textContent = t(`✓ Cliente: ${client.name || client.firstName}`, `✓ Client: ${client.name || client.firstName}`);
  $("selected-client").classList.remove("hidden");
  $("progress-bar").style.width = "78%";
}

function applyAccount(account) {
  state.account = account;
  state.client = isClientRole(account?.role) ? { id: account.clientId, name: account.name } : null;
  $("account-button").textContent = account ? account.name : t("Entrar", "Log in");
  $("logout-link").classList.toggle("hidden", !account);
  // El botón de idioma solo traduce el flujo del cliente (reserva/registro/Mis citas) -- para
  // el personal se oculta, ya que su pantalla (agenda/Configuración de usuarios) se queda en
  // español siempre y un botón que no hace nada visible ahí solo confundiría.
  $("lang-toggle").classList.toggle("hidden", Boolean(account) && employeeRoles.has(account.role));
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
  // "Mi disponibilidad" solo para administradora/superadministrador -- antes cualquier
  // colaboradora (manicurista/asistente) podía bloquear su propio horario; a pedido explícito
  // del dueño del negocio, ahora solo administración bloquea horas (propias o de cualquier
  // colaboradora, desde "Configuración de usuarios" -> Horarios).
  $("open-my-availability").classList.toggle("hidden", !isAdmin);
  $("admin-panel").classList.add("hidden"); // siempre arranca cerrado, se abre con el botón de arriba
  $("agenda-tab").textContent = account && employeeRoles.has(account.role) ? "Panel de colaboradores" : t("Citas activas", "Active appointments");
  $("mode-label").textContent = !account ? t("Reserva rápida", "Quick booking") : isClientRole(account.role) ? t("Mi reserva", "My booking") : "Reserva del equipo";
  if (state.client) setClient(state.client); else $("selected-client").classList.add("hidden");
  // Cuentas de personal aterrizan directo en el panel de colaboradores (agenda) -- ya no en el
  // wizard de reserva del cliente -- pedido explícito de diseño.
  if (account && employeeRoles.has(account.role)) showAgenda();
}

function updateServiceSummary() {
  const services = selectedServices();
  const duration = services.reduce((sum, item) => sum + item.durationMinutes, 0);
  $("service-summary").firstElementChild.textContent = services.length
    ? t(`${services.length} servicio${services.length === 1 ? "" : "s"}`, `${services.length} service${services.length === 1 ? "" : "s"}`)
    : t("Selecciona uno o más servicios", "Select one or more services");
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
  return new Date(`2000-01-01T${time}:00`).toLocaleTimeString(state.language === "en" ? "en-US" : "es-DO", { hour: "numeric", minute: "2-digit" });
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
      .map((seg) => t(`${seg.serviceName} con ${seg.staffName} a las ${formatSlotTime(seg.time)}`, `${seg.serviceName} with ${seg.staffName} at ${formatSlotTime(seg.time)}`))
      .join(" · ");
    return;
  }
  if (state.selectedSlot) {
    const names = selectedServices().map((item) => item.name).join(", ");
    target.textContent = t(`${names} con ${state.selectedSlot.staffName} a las ${formatSlotTime(state.selectedSlot.time)}`, `${names} with ${state.selectedSlot.staffName} at ${formatSlotTime(state.selectedSlot.time)}`);
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
    // Mismo criterio que el banner promocional: sin mensaje publicado, el elemento se queda
    // oculto y la página se ve igual que antes de que existiera esta función.
    renderInfoBanner(state.catalog.infoBanner?.text);
  } catch { message($("booking-message"), t("No pudimos cargar la agenda. Intenta nuevamente.", "We couldn't load the schedule. Please try again.")); }
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
    column.dataset.staffId = staffId;
    const heading = document.createElement("h3"); heading.textContent = group.staffName; column.append(heading);
    const list = document.createElement("div"); list.className = "slots"; column.append(list);
    for (const slot of group.slots) {
      const button = document.createElement("button"); button.type = "button"; button.className = "slot";
      button.textContent = formatSlotTime(slot.time);
      button.addEventListener("click", () => {
        document.querySelectorAll(".slot").forEach((item) => item.classList.remove("selected"));
        button.classList.add("selected");
        onPick(staffId, slot);
      });
      list.append(button);
    }
    return column;
  }));
  // Si venimos de un click en la agenda vacía sobre la columna de una manicurista específica
  // (ver startAgendaQuickBooking), resalta y desplaza a su columna aquí para que el personal no
  // tenga que buscarla entre todas -- preferencia de un solo uso, se descarta apenas se aplica.
  if (state.preferredAgendaStaffId) {
    const preferredColumn = board.querySelector(`[data-staff-id="${state.preferredAgendaStaffId}"]`);
    if (preferredColumn) {
      preferredColumn.classList.add("preferred-staff-column");
      preferredColumn.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    }
    state.preferredAgendaStaffId = null;
  }
}

// Paso 3: consulta /api/fast-booking/availability SIN staffId -- el motor ya devuelve, en un
// solo llamado, los horarios libres de TODAS las manicuristas elegibles. Con varios servicios
// seleccionados, serviceIds trae más de un id y el backend suma sus duraciones para calcular el
// bloque continuo real (ver server/store.mjs: availability()) -- el cliente elige un único
// horario para todo el bloque, con una sola manicurista que sepa hacer todos los servicios
// elegidos, en vez de repartirlos en horarios sueltos.
async function loadSingleAvailability(serviceIds, date) {
  $("step3-heading").textContent = t("Paso 3 · Elige horario y manicurista", "Step 3 · Choose a time and manicurist");
  message($("availability-message"), t("Consultando agenda…", "Checking schedule…"), true);
  $("staff-slots-board").replaceChildren();
  $("availability-fallback").replaceChildren();
  try {
    const result = await api(`/api/fast-booking/availability?serviceIds=${encodeURIComponent(serviceIds.join(","))}&date=${date}`);
    if (serviceIds.length > 1 && result.durationMinutes) {
      $("step3-heading").textContent = t(`Paso 3 · Elige horario y manicurista (${result.durationMinutes} min en total)`, `Step 3 · Choose a time and manicurist (${result.durationMinutes} min total)`);
    }
    if (!result.slots.length) {
      message($("availability-message"), t("No quedan horarios para este día con ninguna manicurista. Prueba otra fecha.", "No times are left this day with any manicurist. Try another date."));
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
    p.append(t("No encontramos cómo acomodar todos los servicios ese día. ", "We couldn't find a way to fit all the services that day. "));
    p.append(Object.assign(document.createElement("a"), { href: "https://wa.me/18296679289", target: "_blank", rel: "noopener", textContent: t("Escríbenos por WhatsApp", "Message us on WhatsApp") }));
    p.append(t(" y una asesora revisa la agenda contigo.", " and an advisor will review the schedule with you."));
    box.append(p);
    container.append(box);
    return;
  }
  const intro = document.createElement("p");
  intro.textContent = fallback.tier === "same_staff_gap"
    ? t("No hay un horario 100% continuo ese día con una sola manicurista, pero sí podemos hacerlo así, con espera entre servicios:", "There's no fully continuous time that day with a single manicurist, but we can do it this way, with a wait between services:")
    : t("No hay con la misma manicurista ese día, pero sí repartido entre distintas manicuristas así:", "Not with the same manicurist that day, but split between different manicurists like this:");
  box.append(intro);
  const summary = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = fallback.segments.map((seg) => t(`${seg.serviceName} con ${seg.staffName} a las ${formatSlotTime(seg.time)}`, `${seg.serviceName} with ${seg.staffName} at ${formatSlotTime(seg.time)}`)).join(" · ");
  summary.append(strong);
  box.append(summary);
  const confirmButton = document.createElement("button"); confirmButton.type = "button"; confirmButton.className = "primary";
  confirmButton.textContent = t("Confirmar este horario", "Confirm this time");
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
  if (!selectedServiceIds().length) { message(targetMessage, t("Selecciona al menos un servicio.", "Select at least one service.")); return false; }
  if (Array.isArray(state.fallbackSegments) && state.fallbackSegments.length) return true;
  if (!$("staff").value || !$("date").value || !$("time").value) { message(targetMessage, t("Selecciona manicurista, fecha y hora.", "Select manicurist, date, and time.")); return false; }
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

const APPOINTMENT_STATUS_LABEL = { scheduled: "Programada", confirmed: "Confirmada", cancelled: "Cancelada", completed: "Atendida", no_show: "No asistió" };

// "Retrasada" nunca se guarda -- se calcula aquí comparando la hora actual contra la hora de
// inicio de la cita, para una Programada/Confirmada que todavía no se marcó Atendida/Cancelada.
// Misma idea que displayReservationStatus() en outputs/app.js (ERP), mismo criterio en los dos
// lados: evita un job/cron que se pueda desincronizar, siempre correcto con solo mirar el reloj.
function isAppointmentLate(item, now = new Date()) {
  if (item.status !== "scheduled" && item.status !== "confirmed") return false;
  const dateStr = item.date || $("agenda-date")?.value;
  if (!dateStr || !item.start_time) return false;
  const startsAt = new Date(`${dateStr}T${item.start_time}:00`);
  return now.getTime() > startsAt.getTime();
}

function displayAppointmentStatusLabel(item, now = new Date()) {
  if (isAppointmentLate(item, now)) return "Retrasada";
  return APPOINTMENT_STATUS_LABEL[item.status] || item.status || "—";
}

function formatIsoTimeLocal(iso) {
  return new Date(iso).toLocaleTimeString("es-DO", { hour: "numeric", minute: "2-digit", timeZone: "America/Santo_Domingo" });
}

const ADMIN_ROLES = new Set(["administradora", "superadministrador"]);
// Comprobante subido, todavía sin que administración decida -- los mismos dos deposit_status que
// ya usa DEPOSIT_UPLOADABLE_STATES del lado contrario (aquí lo que puede ENTRAR a revisión, no lo
// que puede volver a subirse).
const DEPOSIT_REVIEWABLE_STATES = new Set(["ComprobanteRecibido", "PendienteVerificacion"]);

function openAppointmentDetail(item) {
  $("appointment-detail-time").textContent = `${item.start_time} – ${item.end_time}`;
  const rows = [
    ["Cliente", item.client_name || "Cliente"],
    ["Teléfono", item.client_phone || "—"],
    ["Servicios", item.services],
    ["Manicurista", item.staff_name || "—"],
    ["Estado", displayAppointmentStatusLabel(item)],
    ["Referencia", item.legacy_id || "—"],
  ];
  if (item.notes) rows.push(["Nota", item.notes]);
  if (item.group_id) rows.push(["Servicio combinado", "Sí, con más de una manicurista"]);
  if (Number(item.deposit_amount) > 0) rows.push(["Depósito", `RD$${item.deposit_amount} (${item.deposit_status || "pendiente"})`]);
  // moved_from lo pone resolveDisplacedAppointments (server/store.mjs) cuando esta cita perdió su
  // horario porque otra, con el mismo staff+hora, se confirmó primero (permitido a propósito
  // desde la migración 0024) -- hay que escribirle al cliente a confirmar si el nuevo horario le
  // sirve, así que se deja bien visible en el detalle, no solo como nota en el calendario.
  if (item.moved_from) {
    rows.push(["Cita movida", `Se movió de las ${formatIsoTimeLocal(item.moved_from.originalStartsAt)} -- el horario original lo confirmó otro cliente. Escríbele para confirmar si le sirve esta hora.`]);
  }
  $("appointment-detail-body").replaceChildren(...rows.flatMap(([label, value]) => {
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = value;
    return [dt, dd];
  }));
  state.appointmentDetailId = item.id;
  const cancellable = !["cancelled", "completed", "no_show"].includes(item.status);
  $("appointment-cancel-toggle").classList.toggle("hidden", !cancellable);
  $("appointment-cancel-confirm").classList.add("hidden");
  $("appointment-cancel-reason").value = "";
  // Cambiar estatus con un click es solo para personal -- nunca para una cliente viendo su
  // propia cita en "Mis citas" (mismo criterio de rol que ya usa employeeRoles en toda la app).
  const isStaff = state.account && employeeRoles.has(state.account.role);
  // Confirmar asistencia (autorizar sin depósito) y Confirmar depósito deciden si un horario
  // queda apartado -- solo administración, nunca manicurista/asistente (pedido explícito, mismo
  // guard que ya aplica el servidor en POST .../status y .../deposit/review). Manicurista/
  // asistente solo ven Atendida/No asistió, uno al lado del otro.
  const isAdmin = Boolean(state.account) && ADMIN_ROLES.has(state.account.role);
  $("appointment-status-actions").classList.toggle("hidden", !isStaff);
  if (isStaff) {
    $("appointment-mark-confirmed").classList.toggle("hidden", !isAdmin || item.status !== "scheduled");
    const canMarkOutcome = ["scheduled", "confirmed"].includes(item.status);
    $("appointment-mark-attended").classList.toggle("hidden", !canMarkOutcome);
    $("appointment-mark-no-show").classList.toggle("hidden", !canMarkOutcome);
  }
  renderDepositReview(item, isAdmin);
  message($("appointment-cancel-message"));
  $("appointment-detail-dialog").showModal();
}

// Sección "Confirmar cita": solo administración, y solo si hay un comprobante subido esperando
// revisión -- no muestra la foto (la revisión real del comprobante pasa fuera de la app, por
// donde lo haya recibido administración); esto solo deja confirmar/rechazar una vez ya lo
// revisó. El calendario ya avisa "Comprobante recibido" para que sepa que hay algo que revisar
// antes de entrar aquí (ver layoutOverlappingItems más abajo).
function renderDepositReview(item, isAdmin) {
  const box = $("appointment-deposit-review");
  const shouldShow = isAdmin && DEPOSIT_REVIEWABLE_STATES.has(item.deposit_status);
  box.classList.toggle("hidden", !shouldShow);
  message($("appointment-deposit-message"));
}

async function reviewAppointmentDeposit(approve, button) {
  button.disabled = true;
  message($("appointment-deposit-message"), approve ? "Confirmando…" : "Rechazando…", true);
  try {
    const result = await api(`/api/reservapp/agenda/appointments/${state.appointmentDetailId}/deposit/review`, {
      method: "POST", body: JSON.stringify({ approve }),
    });
    $("appointment-detail-dialog").close();
    if (result.appointment?.displaced?.length) {
      message($("agenda-message"), `Depósito confirmado. Se movió automáticamente ${result.appointment.displaced.length === 1 ? "1 cita" : `${result.appointment.displaced.length} citas`} que compartían ese horario -- revisa "Cita movida" en el calendario.`, true);
    }
    loadAgendaView();
  } catch (error) { message($("appointment-deposit-message"), error.message); }
  finally { button.disabled = false; }
}
$("appointment-deposit-approve").addEventListener("click", (event) => reviewAppointmentDeposit(true, event.currentTarget));
$("appointment-deposit-reject").addEventListener("click", (event) => reviewAppointmentDeposit(false, event.currentTarget));

// Vista de calendario del día: una columna por manicurista, citas posicionadas por hora real en
// vez de apiladas en una lista -- pedido explícito de diseño ("vista de calendario del día...
// si aparece uno dándole click se vea los detalles, si está vacío se vea el día así vacío").
// El rango de horas sale de la configuración real del negocio (catalog.schedule.settings), con
// respaldo 09:00-19:00 si todavía no cargó.
function timeToMinutes(value) {
  const [h, m] = String(value).split(":").map(Number);
  return h * 60 + m;
}

// Desde la migración 0024 (server/store.mjs, appointments_no_staff_overlap) una cita
// 'scheduled' (sin confirmar) ya NO bloquea el horario de nadie más -- así que dos citas
// pueden compartir manicurista+horario mientras ninguna esté confirmada. Antes de esto la
// grilla nunca necesitaba manejar solapes reales; ahora sí, o la segunda cita queda tapada
// exactamente detrás de la primera (mismo top/height, mismo ancho de columna) y la
// administradora nunca se entera de que existe. Agrupa por "clusters" de horario solapado y
// les reparte el ancho de la columna en carriles, como cualquier calendario tipo Google
// Calendar/Outlook -- fuera de un solape, un ítem sigue ocupando toda la columna.
function layoutOverlappingItems(items) {
  const withRange = items
    .map((item) => ({ item, start: timeToMinutes(item.start_time), end: timeToMinutes(item.end_time) }))
    .sort((a, b) => a.start - b.start);
  const clusters = [];
  let current = [];
  let clusterEnd = -Infinity;
  for (const entry of withRange) {
    if (current.length && entry.start >= clusterEnd) {
      clusters.push(current);
      current = [];
      clusterEnd = -Infinity;
    }
    current.push(entry);
    clusterEnd = Math.max(clusterEnd, entry.end);
  }
  if (current.length) clusters.push(current);

  const laidOut = [];
  for (const cluster of clusters) {
    const laneEnds = []; // hora de fin de la última cita puesta en cada carril
    for (const entry of cluster) {
      let lane = laneEnds.findIndex((end) => end <= entry.start);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(entry.end); }
      else laneEnds[lane] = entry.end;
      entry.lane = lane;
    }
    const totalLanes = laneEnds.length;
    for (const entry of cluster) laidOut.push({ ...entry, totalLanes });
  }
  return laidOut;
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
    for (const { item, start, end, lane, totalLanes } of layoutOverlappingItems(items)) {
      const block = document.createElement("button");
      block.type = "button";
      const late = isAppointmentLate(item);
      // 'scheduled' = todavía sin confirmar (ni depósito aprobado ni autorización manual, ver
      // appointments_no_staff_overlap en server/store.mjs) -- el único estado donde puede haber
      // otra cita chocando en el mismo horario, así que es justo el que la administradora
      // necesita poder distinguir de un vistazo para saber si debe revisar el comprobante.
      const pending = item.status === "scheduled";
      const moved = Boolean(item.moved_from);
      block.className = `agenda-cal-block status-${item.status}${late ? " status-delayed" : ""}${pending ? " status-pending-confirm" : ""}${moved ? " status-moved" : ""}`;
      block.style.top = `${Math.max(0, (start - openMin) * pxPerMin)}px`;
      block.style.height = `${Math.max(18, (end - start) * pxPerMin - 2)}px`;
      if (totalLanes > 1) {
        block.style.left = `calc(4px + (100% - 8px) * ${lane}/${totalLanes})`;
        block.style.right = "auto";
        block.style.width = `calc((100% - 8px)/${totalLanes} - 3px)`;
      }
      const strong = document.createElement("strong");
      strong.textContent = `${item.start_time} · ${item.client_name || "Cliente"}`;
      const span = document.createElement("span");
      // appointmentStatusMessage() siempre dice en qué parte del ciclo de vida está la cita
      // (pendiente confirmar depósito / comprobante recibido / depósito confirmado / confirmada
      // en seguimiento / asistió / no asistió / cancelada) -- pedido explícito, nunca solo
      // avisar cuando hay algo pendiente. Retrasada/Cita movida se suman aparte porque son
      // transversales a cualquiera de esos estatus, no un estatus más.
      const notes = [item.services, appointmentStatusMessage(item)];
      if (late) notes.push("Retrasada");
      if (moved) notes.push("Cita movida");
      span.textContent = notes.join(" · ");
      block.append(strong, span);
      block.addEventListener("click", () => openAppointmentDetail(item));
      body.append(block);
    }
    // Click en un espacio vacío de la columna de una manicurista (nunca en la vista "Mis citas"
    // de un cliente, group.client): arranca el registro rápido de una cita para alguien que
    // llamó pidiendo un horario -- pedido explícito de personal. La hora exacta la calcula el
    // paso 3 del wizard (depende de la duración del servicio, que todavía no se eligió aquí);
    // este click solo aproxima la hora para que el personal empiece cerca de donde tocó.
    if (!group.client) {
      body.classList.add("agenda-cal-body-clickable");
      body.addEventListener("click", (event) => {
        if (event.target.closest(".agenda-cal-block")) return;
        const rect = body.getBoundingClientRect();
        const offsetY = event.clientY - rect.top;
        const clickedMinutes = openMin + Math.round(offsetY / pxPerMin);
        const roundedMinutes = Math.min(closeMin, Math.max(openMin, Math.round(clickedMinutes / 15) * 15));
        const time = `${String(Math.floor(roundedMinutes / 60)).padStart(2, "0")}:${String(roundedMinutes % 60).padStart(2, "0")}`;
        startAgendaQuickBooking({ date: $("agenda-date").value, staffId: group.id, staffName: group.name, time });
      });
    }
    column.append(head, body);
    return column;
  }));

  return { hourGutter, columns };
}

// Click en zona vacía del calendario del Panel de colaboradores: arranca el wizard de reserva
// (mismo formulario que ya usa cualquier cliente/personal) ya con la fecha fija y recordando
// la manicurista de la columna clickeada, para que el personal registre rápido la cita de
// quien llamó por teléfono en vez de pedirle los mismos datos desde cero.
function startAgendaQuickBooking({ date, staffId, staffName, time }) {
  resetDeviceState();
  state.preferredAgendaStaffId = staffId;
  if (date) $("date").value = date;
  showBooking();
  goToStep(1);
  message($("booking-message"), `Cita para ${staffName || "una manicurista"} cerca de las ${time} el ${date} — elige el servicio para ver su disponibilidad real.`, true);
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
$("appointment-cancel-toggle").addEventListener("click", () => {
  $("appointment-cancel-confirm").classList.remove("hidden");
  $("appointment-cancel-toggle").classList.add("hidden");
});
$("appointment-cancel-back").addEventListener("click", () => {
  $("appointment-cancel-confirm").classList.add("hidden");
  $("appointment-cancel-toggle").classList.remove("hidden");
});
$("appointment-cancel-submit").addEventListener("click", async () => {
  const button = $("appointment-cancel-submit"); button.disabled = true;
  message($("appointment-cancel-message"), "Cancelando…", true);
  try {
    await api(`/api/reservapp/agenda/appointments/${state.appointmentDetailId}/cancel`, {
      method: "POST", body: JSON.stringify({ reason: $("appointment-cancel-reason").value.trim() }),
    });
    $("appointment-detail-dialog").close();
    loadAgendaView();
  } catch (error) { message($("appointment-cancel-message"), error.message); }
  finally { button.disabled = false; }
});

// Cambiar estatus con un click desde el detalle de la cita -- mismo endpoint que también puede
// llamar el ERP (ver POST /api/reservapp/agenda/appointments/:id/status en server/app.mjs).
async function setAppointmentDetailStatus(status, button) {
  button.disabled = true;
  message($("appointment-cancel-message"), "Actualizando…", true);
  try {
    const result = await api(`/api/reservapp/agenda/appointments/${state.appointmentDetailId}/status`, {
      method: "POST", body: JSON.stringify({ status }),
    });
    $("appointment-detail-dialog").close();
    if (result.appointment?.displaced?.length) {
      message($("agenda-message"), `Cita confirmada. Se movió automáticamente ${result.appointment.displaced.length === 1 ? "1 cita" : `${result.appointment.displaced.length} citas`} que compartían ese horario -- revisa "Cita movida" en el calendario.`, true);
    }
    loadAgendaView();
  } catch (error) { message($("appointment-cancel-message"), error.message); }
  finally { button.disabled = false; }
}
$("appointment-mark-confirmed").addEventListener("click", (event) => setAppointmentDetailStatus("confirmed", event.currentTarget));
$("appointment-mark-attended").addEventListener("click", (event) => setAppointmentDetailStatus("completed", event.currentTarget));
$("appointment-mark-no-show").addEventListener("click", (event) => setAppointmentDetailStatus("no_show", event.currentTarget));

// Etiquetas humanas de las dos dimensiones independientes de una cita -- mismo vocabulario que ya
// usa el ERP legado (outputs/app.js CONFIRM_NOTES/DEPOSIT_NOTES) para que administración y
// clientes vean exactamente el mismo lenguaje en ambos lados.
// Objetos, no funciones -- se leen por valor donde se usan (renderAppointmentCard,
// renderTeamAppointmentCard, openAppointmentDetail), así que "cambian de idioma solos" en la
// siguiente vez que se pinten después de un toggle, sin tener que tocar cada sitio que los usa.
// Compartidos con el detalle de cita del personal (staff-only) a propósito -- son solo 10
// etiquetas cortas, no vale la pena duplicar el objeto por un caso tan chico.
const CONFIRM_STATUS_LABELS_ES = {
  Programada: "Recordatorio de confirmación programado",
  PendienteConfirmarHora: "Esperando tu confirmación",
  EspacioLiberado: "Tu horario podría liberarse pronto -- confirma ya",
  HoraConfirmada: "Asistencia confirmada",
  NoRequerida: "Sin recordatorio necesario",
};
const CONFIRM_STATUS_LABELS_EN = {
  Programada: "Confirmation reminder scheduled",
  PendienteConfirmarHora: "Waiting for your confirmation",
  EspacioLiberado: "Your time slot could be released soon -- confirm now",
  HoraConfirmada: "Attendance confirmed",
  NoRequerida: "No reminder needed",
};
const DEPOSIT_STATUS_LABELS_ES = {
  Pendiente: "Depósito pendiente",
  ComprobanteRecibido: "Comprobante recibido",
  PendienteVerificacion: "Verificando comprobante",
  Verificado: "Depósito confirmado",
  Rechazado: "Depósito rechazado",
};
const DEPOSIT_STATUS_LABELS_EN = {
  Pendiente: "Deposit pending",
  ComprobanteRecibido: "Receipt received",
  PendienteVerificacion: "Verifying receipt",
  Verificado: "Deposit confirmed",
  Rechazado: "Deposit rejected",
};
// Alias language-aware -- se leen con [] en el resto del archivo, así que un getter dinámico
// evita tener que tocar cada uso existente uno por uno.
const CONFIRM_STATUS_LABELS = new Proxy({}, { get: (_, key) => (state.language === "en" ? CONFIRM_STATUS_LABELS_EN : CONFIRM_STATUS_LABELS_ES)[key] });
const DEPOSIT_STATUS_LABELS = new Proxy({}, { get: (_, key) => (state.language === "en" ? DEPOSIT_STATUS_LABELS_EN : DEPOSIT_STATUS_LABELS_ES)[key] });
// Mismos tres estados que PENDING_CONFIRMATION_STATES en outputs/app.js -- son los únicos en los
// que confirmar todavía tiene sentido (HoraConfirmada/NoRequerida ya no necesitan acción).
const CONFIRMABLE_STATES = new Set(["Programada", "PendienteConfirmarHora", "EspacioLiberado"]);

// Un solo mensaje que siempre refleja en qué parte del ciclo de vida está la cita -- pedido
// explícito: el calendario del Panel de colaboradoras debe decir siempre el estatus real
// (pendiente de confirmar depósito / depósito confirmado / confirmada en seguimiento / asistió /
// etc.), no solo avisar cuando hay algo pendiente. 'confirmed' se separa en dos mensajes según
// CÓMO se ganó el horario (ver setAppointmentStatus/reviewDepositReceipt en server/store.mjs):
// con depósito aprobado (deposit_status='Verificado') o con autorización manual de
// administración sin depósito ("en seguimiento" -- se sigue de cerca hasta que asista).
function appointmentStatusMessage(item) {
  if (item.status === "cancelled") return t("Cancelada", "Cancelled");
  if (item.status === "no_show") return t("No asistió", "No-show");
  if (item.status === "completed") return t("Asistió", "Attended");
  if (item.status === "confirmed") {
    return item.deposit_status === "Verificado" ? t("Depósito confirmado", "Deposit confirmed") : t("Confirmada en seguimiento", "Confirmed, being followed up");
  }
  // 'scheduled': todavía no gana el horario -- distingue si ya hay algo que revisar o no.
  return DEPOSIT_REVIEWABLE_STATES.has(item.deposit_status) ? t("Comprobante recibido", "Receipt received") : t("Pendiente confirmar depósito", "Pending deposit confirmation");
}

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
  const service = document.createElement("span"); service.className = "appointment-service"; service.textContent = apt.services || t("Cita", "Appointment");
  const when = document.createElement("span"); when.className = "appointment-when";
  when.textContent = `${new Date(`${apt.date}T12:00:00`).toLocaleDateString(state.language === "en" ? "en-US" : "es-DO", { weekday: "short", day: "numeric", month: "short" })} · ${formatSlotTime(apt.start_time)}`;
  top.append(service, when);
  card.append(top);

  if (apt.staff_name) {
    const meta = document.createElement("div"); meta.className = "appointment-meta";
    meta.textContent = t(`Con ${apt.staff_name}`, `With ${apt.staff_name}`);
    card.append(meta);
  }

  const badges = document.createElement("div"); badges.className = "appointment-badges";
  const confirmLabel = CONFIRM_STATUS_LABELS[apt.confirmation_status];
  if (confirmLabel) badges.append(badgeEl(confirmLabel, `confirm-${String(apt.confirmation_status).toLowerCase()}`));
  const depositStatus = apt.deposit_status && DEPOSIT_STATUS_LABELS[apt.deposit_status] ? apt.deposit_status : "Pendiente";
  badges.append(badgeEl(DEPOSIT_STATUS_LABELS[depositStatus], `deposit-${depositStatus.toLowerCase()}`));
  if (apt.moved_from) badges.append(badgeEl(t("Cita movida", "Appointment moved"), "moved"));
  card.append(badges);

  // moved_from lo pone resolveDisplacedAppointments (server/store.mjs) cuando esta cita perdió
  // su horario porque otro cliente con la misma manicurista+hora confirmó primero (permitido a
  // propósito desde la migración 0024) -- se le explica aquí mismo, junto a la nueva hora, en vez
  // de dejar que solo lo note por el badge.
  if (apt.moved_from) {
    const notice = document.createElement("p"); notice.className = "appointment-moved-notice";
    notice.textContent = t(
      `Tu cita se movió de las ${formatIsoTimeLocal(apt.moved_from.originalStartsAt)} a las ${formatSlotTime(apt.start_time)} porque ese horario se confirmó con otro cliente mientras esperábamos tu comprobante. Si esta hora no te sirve, escríbenos por WhatsApp para reprogramar.`,
      `Your appointment moved from ${formatIsoTimeLocal(apt.moved_from.originalStartsAt)} to ${formatSlotTime(apt.start_time)} because that time was confirmed by another client while we were waiting for your receipt. If this time doesn't work for you, message us on WhatsApp to reschedule.`,
    );
    card.append(notice);
  }

  if (CONFIRMABLE_STATES.has(apt.confirmation_status)) {
    const row = document.createElement("div"); row.className = "appointment-confirm-row";
    const btn = document.createElement("button");
    btn.className = "primary compact appointment-confirm-btn"; btn.type = "button";
    btn.textContent = t("Confirmar hora reservada", "Confirm reserved time");
    btn.addEventListener("click", () => confirmMyAppointment(apt.legacy_id, btn));
    const modifyLink = Object.assign(document.createElement("a"), {
      className: "secondary compact appointment-modify-link", target: "_blank", rel: "noopener",
      href: `https://wa.me/18296679289?text=${encodeURIComponent(t(
        `Hola, quisiera modificar mi cita (referencia ${apt.legacy_id}), del ${apt.date} a las ${formatSlotTime(apt.start_time)}.`,
        `Hi, I'd like to modify my appointment (reference ${apt.legacy_id}) on ${apt.date} at ${formatSlotTime(apt.start_time)}.`,
      ))}`,
      textContent: t("Modificar", "Modify"),
    });
    row.append(btn, modifyLink);
    card.append(row);
  }

  // El comprobante se puede subir mientras el depósito esté "Pendiente" (nunca se subió nada) o
  // "Rechazado" (el personal lo rechazó -- se sobrescribe con el nuevo, ver submitDepositReceipt
  // en server/store.mjs). Una vez queda "ComprobanteRecibido"/"PendienteVerificacion"/"Verificado"
  // no hay nada más que el cliente pueda hacer aquí.
  if (DEPOSIT_UPLOADABLE_STATES.has(depositStatus)) {
    card.append(depositUploadControl(apt.id));
  }
  return card;
}

const DEPOSIT_UPLOADABLE_STATES = new Set(["Pendiente", "Rechazado"]);
const DEPOSIT_MAX_DIMENSION = 1600;
const DEPOSIT_JPEG_QUALITY = 0.8;

// Se pide una sola vez por sesión y se reutiliza en la pantalla de éxito (justo después de
// reservar) y en "Mis citas" (mientras el comprobante siga pendiente) -- ver GET
// /api/reservapp/bank-accounts en server/app.mjs, que ya filtra a cuentas de tipo Banco activas.
let bankAccountsPromise = null;
function fetchBankAccounts() {
  if (!bankAccountsPromise) {
    bankAccountsPromise = api("/api/reservapp/bank-accounts").catch((error) => {
      bankAccountsPromise = null; // permite reintentar la próxima vez que se pinte el panel
      throw error;
    });
  }
  return bankAccountsPromise;
}

function renderBankAccounts(container) {
  container.textContent = t("Cargando cuentas para transferir…", "Loading transfer accounts…");
  fetchBankAccounts()
    .then(({ accounts }) => {
      container.textContent = "";
      if (!accounts?.length) { container.textContent = t("Consulta las cuentas disponibles con el salón.", "Check with the salon for available accounts."); return; }
      const title = document.createElement("p"); title.className = "bank-accounts-title";
      title.textContent = t("Cuentas para transferir el depósito:", "Accounts to transfer the deposit:");
      container.append(title);
      accounts.forEach((account) => {
        const row = document.createElement("div"); row.className = "bank-account";
        const bankLine = document.createElement("strong");
        bankLine.textContent = account.tipoProducto ? `${account.banco} (${account.tipoProducto})` : account.banco;
        const numberLine = document.createElement("span");
        numberLine.textContent = t(`Cuenta: ${account.numeroCuenta}`, `Account: ${account.numeroCuenta}`);
        const holderLine = document.createElement("span");
        holderLine.textContent = account.documento ? `${account.titular} · ${account.tipoDocumento}: ${account.documento}` : account.titular;
        row.append(bankLine, numberLine, holderLine);
        container.append(row);
      });
    })
    .catch(() => { container.textContent = t("No se pudieron cargar las cuentas. Consulta con el salón.", "Couldn't load the accounts. Check with the salon."); });
}

// Redimensiona/comprime la foto en un <canvas> antes de mandarla -- una foto de cámara sin tocar
// puede pesar varios MB, y el body JSON del backend tiene un límite de 8MB (MAX_BODY_BYTES en
// server/app.mjs); esto la deja típicamente por debajo de 300-500KB.
function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, DEPOSIT_MAX_DIMENSION / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", DEPOSIT_JPEG_QUALITY);
      resolve({ mimeType: "image/jpeg", imageBase64: dataUrl.split(",")[1] });
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error(t("No se pudo leer la imagen.", "Couldn't read the image."))); };
    img.src = objectUrl;
  });
}

function depositUploadControl(appointmentId) {
  const wrap = document.createElement("div"); wrap.className = "deposit-upload";
  const accounts = document.createElement("div"); accounts.className = "bank-accounts";
  renderBankAccounts(accounts);
  wrap.append(accounts);
  const input = document.createElement("input");
  input.type = "file"; input.accept = "image/*"; input.capture = "environment"; input.className = "hidden";
  const btn = document.createElement("button");
  btn.className = "secondary compact deposit-upload-btn"; btn.type = "button";
  btn.textContent = t("Cargar comprobante", "Upload receipt");
  const msg = document.createElement("span"); msg.className = "deposit-upload-message";

  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    btn.disabled = true; btn.textContent = t("Subiendo…", "Uploading…"); msg.textContent = "";
    try {
      const { mimeType, imageBase64 } = await compressImageFile(file);
      await api(`/api/reservapp/my-appointments/${appointmentId}/deposit`, {
        method: "POST", body: JSON.stringify({ mimeType, imageBase64 }),
      });
      await loadMyAppointments(state.myAppointmentsScope || "active");
    } catch (error) {
      msg.textContent = error.message;
      btn.disabled = false; btn.textContent = t("Cargar comprobante", "Upload receipt");
    } finally {
      input.value = "";
    }
  });

  wrap.append(input, btn, msg);
  return wrap;
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
  // Primer badge: el estatus real de la cita en su ciclo de vida (misma función que ya usa el
  // calendario del día, ver appointmentStatusMessage) -- pedido explícito, siempre visible, no
  // solo cuando hay algo pendiente. Los badges de abajo (recordatorio de asistencia, depósito)
  // se quedan como detalle adicional, no reemplazan a este.
  badges.append(badgeEl(appointmentStatusMessage(apt), `lifecycle-${apt.status}`));
  const confirmLabel = CONFIRM_STATUS_LABELS[apt.confirmation_status];
  if (confirmLabel) badges.append(badgeEl(confirmLabel, `confirm-${String(apt.confirmation_status).toLowerCase()}`));
  const depositStatus = apt.deposit_status && DEPOSIT_STATUS_LABELS[apt.deposit_status] ? apt.deposit_status : "Pendiente";
  badges.append(badgeEl(DEPOSIT_STATUS_LABELS[depositStatus], `deposit-${depositStatus.toLowerCase()}`));
  if (apt.moved_from) badges.append(badgeEl(`Cita movida (era ${formatIsoTimeLocal(apt.moved_from.originalStartsAt)})`, "moved"));
  card.append(badges);

  return card;
}

async function confirmMyAppointment(reservationId, btn) {
  btn.disabled = true; btn.textContent = t("Confirmando…", "Confirming…");
  try {
    await api("/api/reservapp/booking/confirm-attendance", { method: "POST", body: JSON.stringify({ reservationId }) });
    await loadMyAppointments(state.myAppointmentsScope || "active");
  } catch (error) {
    message($("my-appointments-message"), error.message);
    btn.disabled = false; btn.textContent = t("Confirmar hora reservada", "Confirm reserved time");
  }
}

async function loadMyAppointments(scope) {
  state.myAppointmentsScope = scope;
  $("my-appointments-active-tab").classList.toggle("active", scope === "active");
  $("my-appointments-history-tab").classList.toggle("active", scope === "history");
  message($("my-appointments-message"), t("Cargando…", "Loading…"), true);
  try {
    const result = await api(`/api/reservapp/my-appointments?scope=${scope}`);
    $("my-appointments-list").replaceChildren();
    if (!result.appointments.length) {
      message($("my-appointments-message"), scope === "active" ? t("No tienes citas activas por el momento.", "You have no active appointments right now.") : t("Aún no tienes historial de citas.", "You don't have any appointment history yet."));
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
  message($("phone-check-message"), t("Buscando…", "Searching…"), true);
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
  message($("confirm-name-message"), t("Verificando…", "Verifying…"), true);
  try {
    const result = await api("/api/reservapp/auth/verify-name", { method: "POST", body: JSON.stringify({ phone: state.confirmNamePhone, firstName: typedName }) });
    if (!result.verified) {
      message($("confirm-name-message"), t("No pudimos confirmar tu identidad con ese nombre. Revisa que esté bien escrito, o pide a administración que reinicie tu acceso.", "We couldn't confirm your identity with that name. Check that it's spelled correctly, or ask administration to reset your access."));
      return;
    }
    $("confirm-name-dialog").close();
    if (state.confirmNameNeedsPasswordOnly) {
      state.quickSetupPhone = state.confirmNamePhone;
      state.quickSetupFirstName = typedName;
      $("quick-setup-title").textContent = state.passwordResetFlow ? t("Elige tu nueva contraseña", "Choose your new password") : t("Crea tu contraseña", "Create your password");
      $("quick-setup-intro").textContent = state.passwordResetFlow
        ? t(`¡Hola, ${typedName}! Define una contraseña nueva.`, `Hi, ${typedName}! Set a new password.`)
        : t(`¡Hola, ${typedName}! Ya tienes una ficha con nosotros, solo falta que crees tu contraseña.`, `Hi, ${typedName}! You already have a record with us -- you just need to create your password.`);
      $("quick-setup-password").value = ""; $("quick-setup-password-confirm").value = "";
      message($("quick-setup-message"));
      $("quick-setup-dialog").showModal();
    } else {
      $("login-phone").value = state.confirmNamePhone;
      message($("login-message"), t(`¿Eres tú, ${typedName}? Ingresa tu contraseña para confirmar.`, `Is that you, ${typedName}? Enter your password to confirm.`), true);
      $("login-dialog").showModal();
    }
  } catch (error) { message($("confirm-name-message"), error.message); }
  finally { button.disabled = false; }
});

$("close-quick-setup").addEventListener("click", () => $("quick-setup-dialog").close());
$("quick-setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("quick-setup-password").value;
  if (password !== $("quick-setup-password-confirm").value) return message($("quick-setup-message"), t("Las contraseñas no coinciden.", "Passwords don't match."));
  const button = event.submitter; button.disabled = true;
  message($("quick-setup-message"), t("Guardando…", "Saving…"), true);
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
      $("success-summary").textContent = t(`Cita registrada, pendiente de confirmar. Referencia: ${result.appointment.reference}`, `Appointment registered, pending confirmation. Reference: ${result.appointment.reference}`);
      renderBankAccounts($("success-bank-accounts"));
    } else if (wasPasswordReset) {
      message($("booking-message"), t(`Contraseña actualizada. Hola de nuevo, ${result.account.name}.`, `Password updated. Welcome back, ${result.account.name}.`), true);
    } else if (state.pendingBookingStart) {
      state.pendingBookingStart = false;
      message($("booking-message"), t(`Cuenta creada. ¡Hola, ${result.account.name}!`, `Account created. Hi, ${result.account.name}!`), true);
      goToStep(1);
    } else message($("booking-message"), result.bookingError || t("Contraseña guardada. Ya puedes reservar.", "Password saved. You can book now."), !result.bookingError);
  } catch (error) { message($("quick-setup-message"), error.message); }
  finally { button.disabled = false; }
});
$("step1-back").addEventListener("click", () => goToStep(0));
$("step1-next").addEventListener("click", () => {
  if (!selectedServiceIds().length) return message($("booking-message"), t("Selecciona al menos un servicio.", "Select at least one service."));
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
  message($("booking-message"), t("Ese día no laboramos -- te muestro el próximo día disponible.", "We're closed that day -- showing you the next available day."), true);
});
$("step2-next").addEventListener("click", () => {
  if (!$("date").value) return message($("booking-message"), t("Elige una fecha.", "Choose a date."));
  if (isClosedDate($("date").value)) {
    $("date").value = nextOpenDate($("date").value);
    message($("booking-message"), t("Ese día no laboramos -- te muestro el próximo día disponible.", "We're closed that day -- showing you the next available day."), true);
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
// Mismo flujo que "Es mi primera vez" al iniciar una reserva (identify-new): reutiliza
// phone-check-dialog para buscar el teléfono -- si ya hay ficha, pasa a crear/reiniciar
// contraseña (openConfirmName); si no existe, abre el formulario completo de registro.
$("login-new-user").addEventListener("click", () => {
  $("login-dialog").close();
  $("phone-check-value").value = "";
  message($("phone-check-message"));
  $("phone-check-dialog").showModal();
});
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
      t("Para este horario con varias citas, pide a una asesora que registre tu cita: ", "For this multi-appointment time slot, please ask an advisor to book it for you: "),
      Object.assign(document.createElement("a"), { href: "https://wa.me/18296679289", target: "_blank", rel: "noopener", textContent: t("escríbenos por WhatsApp", "message us on WhatsApp") }),
    );
    return;
  }
  state.clientDialogForEmployee = forEmployee;
  state.clientDialogRequireSelection = requireSelection;
  $("client-dialog-title").textContent = forEmployee ? "Registrar cliente" : t("Crear mi acceso", "Create my access");
  const hasSelection = Boolean(selectedServiceIds().length && $("staff").value && $("date").value && $("time").value);
  $("client-dialog-intro").textContent = forEmployee
    ? "Regístrala al instante — tú ya la tienes en frente, no hace falta verificarla por WhatsApp."
    : hasSelection
      ? t("Confirma tu teléfono, crea tu contraseña y tu cita quedará agendada.", "Confirm your phone number, create your password, and your appointment will be booked.")
      : t("Confirma tu teléfono y crea tu contraseña para continuar.", "Confirm your phone number and create your password to continue.");
  $("client-form").querySelector("button[type=submit]").textContent = forEmployee ? "Registrar cliente" : t("Continuar", "Continue");
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
  message($("client-message"), t("Guardando…", "Saving…"), true);
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
      message($("login-message"), t("Ese teléfono ya tiene una cuenta. Ingresa tu contraseña para confirmar.", "That phone number already has an account. Enter your password to confirm."), true);
      $("login-dialog").showModal();
    }
  } finally { button.disabled = false; }
});

$("open-verify-code").addEventListener("click", () => { state.passwordResetFlow = false; $("login-dialog").close(); message($("verify-code-message")); $("verify-code-dialog").showModal(); });
$("close-verify-code").addEventListener("click", () => $("verify-code-dialog").close());

$("open-forgot-password").addEventListener("click", () => { $("login-dialog").close(); message($("forgot-password-message")); $("forgot-password-phone").value = $("login-phone").value; $("forgot-password-dialog").showModal(); });
$("close-forgot-password").addEventListener("click", () => $("forgot-password-dialog").close());

$("forgot-password-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; message($("forgot-password-message"), t("Enviando…", "Sending…"), true);
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
  $("setup-dialog-title").textContent = state.passwordResetFlow ? t("Elige tu nueva contraseña", "Choose your new password") : t("Crea tu contraseña", "Create your password");
  $("setup-form").querySelector("button[type=submit]").textContent = state.passwordResetFlow ? t("Guardar nueva contraseña", "Save new password") : t("Activar y confirmar cita", "Activate and confirm appointment");
  $("setup-dialog").showModal();
}

$("verify-code-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; message($("verify-code-message"), t("Verificando…", "Verifying…"), true);
  try {
    const result = await api("/api/reservapp/setup/verify-code", { method: "POST", body: JSON.stringify({ phone: $("verify-code-phone").value, code: $("verify-code-code").value }) });
    openSetupDialog(result.activationTicket);
  } catch (error) { message($("verify-code-message"), error.message); }
  finally { button.disabled = false; }
});

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; message($("login-message"), t("Entrando…", "Logging in…"), true);
  try {
    const result = await api("/api/reservapp/auth/login", { method: "POST", body: JSON.stringify({ phone: $("login-phone").value, password: $("login-password").value }) });
    applyAccount(result.account); $("login-dialog").close(); $("login-form").reset(); message($("booking-message"), t(`Hola, ${result.account.name}.`, `Hi, ${result.account.name}.`), true);
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
  state.preferredAgendaStaffId = null;
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
  if (!state.client) return message($("booking-message"), t("Selecciona el cliente de la cita.", "Select the appointment's client."));
  const button = $("submit-booking"); button.disabled = true; button.textContent = t("Reservando…", "Booking…");
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
    const summaryLocale = state.language === "en" ? "en-US" : "es-DO";
    if (isFallback) {
      const details = state.fallbackSegments.map((seg) => t(`${seg.serviceName} con ${seg.staffName} a las ${formatSlotTime(seg.time)}`, `${seg.serviceName} with ${seg.staffName} at ${formatSlotTime(seg.time)}`)).join(" · ");
      $("success-summary").textContent = t(
        `${details}, el ${new Date(`${$("date").value}T12:00:00`).toLocaleDateString(summaryLocale, { dateStyle: "long" })}. Referencia: ${result.appointments.map((item) => item.reference).join(", ")}`,
        `${details}, on ${new Date(`${$("date").value}T12:00:00`).toLocaleDateString(summaryLocale, { dateStyle: "long" })}. Reference: ${result.appointments.map((item) => item.reference).join(", ")}`,
      );
    } else {
      const names = selectedServices().map((item) => item.name).join(", ");
      const person = state.catalog.staff.find((item) => item.id === $("staff").value)?.name;
      const dateLabel = new Date(`${$("date").value}T12:00:00`).toLocaleDateString(summaryLocale, { dateStyle: "long" });
      const timeLabel = formatSlotTime($("time").value);
      $("success-summary").textContent = t(
        `${names} con ${person}, el ${dateLabel} a las ${timeLabel}. Referencia: ${result.appointment.reference}`,
        `${names} with ${person}, on ${dateLabel} at ${timeLabel}. Reference: ${result.appointment.reference}`,
      );
    }
    $("booking-card").classList.add("hidden"); $("success-card").classList.remove("hidden"); window.scrollTo({ top: 0, behavior: "smooth" });
    renderBankAccounts($("success-bank-accounts"));
  } catch (error) {
    message($("booking-message"), error.message);
    if (error.body?.conflict) goToStep(3); // el horario se ocupó -- vuelve a elegir de la lista fresca
  }
  finally { button.disabled = false; button.textContent = t("Confirmar reserva", "Confirm booking"); }
});

$("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const password = $("setup-password").value;
  if (password !== $("setup-password-confirm").value) return message($("setup-message"), t("Las contraseñas no coinciden.", "Passwords don't match."));
  const button = event.submitter; button.disabled = true; message($("setup-message"), t("Activando…", "Activating…"), true);
  try {
    const result = await api("/api/reservapp/auth/complete-setup", { method: "POST", body: JSON.stringify({ token: state.activationTicket, password }) });
    const wasPasswordReset = state.passwordResetFlow;
    state.activationTicket = null; state.passwordResetFlow = false; applyAccount(result.account); $("setup-dialog").close();
    if (result.appointment) {
      $("booking-card").classList.add("hidden"); $("success-card").classList.remove("hidden");
      $("success-summary").textContent = t(`Cita registrada, pendiente de confirmar. Referencia: ${result.appointment.reference}`, `Appointment registered, pending confirmation. Reference: ${result.appointment.reference}`);
      renderBankAccounts($("success-bank-accounts"));
    } else if (wasPasswordReset) {
      message($("booking-message"), t(`Contraseña actualizada. Hola de nuevo, ${result.account.name}.`, `Password updated. Welcome back, ${result.account.name}.`), true);
    } else if (state.pendingBookingStart) {
      state.pendingBookingStart = false;
      message($("booking-message"), t(`Cuenta creada. ¡Hola, ${result.account.name}!`, `Account created. Hi, ${result.account.name}!`), true);
      goToStep(1);
    } else message($("booking-message"), result.bookingError || t("Cuenta activada. Ya puedes reservar.", "Account activated. You can book now."), !result.bookingError);
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
  if (state.catalog?.infoBanner) { $("info-banner-text").value = state.catalog.infoBanner.text; $("info-banner-remove").classList.remove("hidden"); }
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
let businessScheduleExceptions = [];

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

function renderScheduleExceptionsList() {
  $("schedule-exceptions-list").replaceChildren(...businessScheduleExceptions.map((exc) => {
    const li = document.createElement("li");
    const dateLabel = new Date(`${exc.date}T12:00:00`).toLocaleDateString("es-DO", { dateStyle: "long" });
    const hoursLabel = exc.open && exc.close ? `${exc.open}–${exc.close}` : "Cerrado todo el día";
    const label = document.createElement("span");
    label.textContent = `${dateLabel} · ${hoursLabel}${exc.label ? ` (${exc.label})` : ""}`;
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "admin-row-action"; remove.textContent = "Quitar";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await api("/api/reservapp/admin/business-settings", {
          method: "PATCH",
          body: JSON.stringify({ scheduleExceptions: businessScheduleExceptions.filter((item) => item.date !== exc.date) }),
        });
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
    businessScheduleExceptions = Array.isArray(settings.scheduleExceptions)
      ? [...settings.scheduleExceptions].sort((a, b) => a.date.localeCompare(b.date))
      : [];
    renderScheduleExceptionsList();
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

$("schedule-exception-add").addEventListener("click", async () => {
  const date = $("schedule-exception-date").value;
  const open = $("schedule-exception-open").value;
  const close = $("schedule-exception-close").value;
  const label = $("schedule-exception-label").value;
  if (!date) return message($("business-hours-message"), "Elige una fecha.");
  if ((open && !close) || (!open && close)) return message($("business-hours-message"), "Pon apertura y cierre, o deja ambos vacíos para cerrar el día completo.");
  if (open && close && open >= close) return message($("business-hours-message"), "La hora de cierre debe ser posterior a la de apertura.");
  const button = $("schedule-exception-add"); button.disabled = true;
  try {
    const nextExceptions = [...businessScheduleExceptions.filter((item) => item.date !== date), { date, open: open || null, close: close || null, label }];
    await api("/api/reservapp/admin/business-settings", { method: "PATCH", body: JSON.stringify({ scheduleExceptions: nextExceptions }) });
    $("schedule-exception-date").value = ""; $("schedule-exception-open").value = ""; $("schedule-exception-close").value = ""; $("schedule-exception-label").value = "";
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

// Resalta el teléfono dentro del mensaje informativo con enlaces de WhatsApp y llamada. El
// texto es de administración (confiable), pero se escapa igual antes de inyectar los enlaces
// por si acaso.
function renderInfoBanner(text) {
  const el = $("info-banner");
  if (!text) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const whatsappIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="#25925a" aria-hidden="true"><path d="M12.04 2c-5.46 0-9.9 4.44-9.9 9.9 0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.9-4.44 9.9-9.9 0-2.64-1.03-5.13-2.9-7C17.17 3.03 14.68 2 12.04 2zm5.8 14.13c-.24.68-1.4 1.3-1.93 1.38-.5.08-1.12.11-1.8-.11-.42-.13-.96-.31-1.65-.6-2.9-1.25-4.8-4.16-4.94-4.35-.14-.19-1.18-1.57-1.18-3 0-1.42.75-2.12 1.02-2.41.27-.29.58-.36.78-.36.19 0 .39 0 .56.01.18.01.42-.07.66.5.24.58.83 2 .9 2.15.07.15.12.32.02.51-.1.19-.15.31-.3.48-.15.17-.31.38-.44.51-.15.15-.3.31-.13.6.17.29.75 1.24 1.62 2.01 1.11 1 2.05 1.31 2.34 1.46.29.15.46.13.63-.08.17-.21.72-.84.91-1.13.19-.29.39-.24.65-.14.27.1 1.68.79 1.97.93.29.14.48.21.55.33.07.12.07.68-.17 1.36z"/></svg>';
  const phoneIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.4c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1L6.6 10.8z"/></svg>';
  const withIcons = escaped.replace(/(\d{10})/, (match) => (
    `${match} `
    + `<a class="info-banner-icon" href="https://wa.me/1${match}" target="_blank" rel="noopener" aria-label="Escribir por WhatsApp">${whatsappIcon}</a>`
    + `<a class="info-banner-icon" href="tel:+1${match}" aria-label="Llamar">${phoneIcon}</a>`
  ));
  el.innerHTML = withIcons;
  el.classList.remove("hidden");
}

$("info-banner-publish").addEventListener("click", async () => {
  const text = $("info-banner-text").value.trim();
  if (!text) return message($("info-banner-message"), "Escribe el mensaje.");
  const button = $("info-banner-publish"); button.disabled = true;
  try {
    await api("/api/reservapp/admin/info-banner", { method: "POST", body: JSON.stringify({ text }) });
    message($("info-banner-message"), "Mensaje publicado.", true);
    $("info-banner-remove").classList.remove("hidden");
  } catch (error) { message($("info-banner-message"), error.message); }
  finally { button.disabled = false; }
});
$("info-banner-remove").addEventListener("click", async () => {
  const button = $("info-banner-remove"); button.disabled = true;
  try {
    await api("/api/reservapp/admin/info-banner", { method: "DELETE" });
    $("info-banner").classList.add("hidden");
    $("info-banner-text").value = "";
    $("info-banner-remove").classList.add("hidden");
    message($("info-banner-message"), "Mensaje quitado.", true);
  } catch (error) { message($("info-banner-message"), error.message); }
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
  let savedLang = "es";
  try { savedLang = localStorage.getItem("reservapp_lang") || "es"; } catch { /* modo privado -- se queda en español */ }
  applyLanguage(savedLang);
  await Promise.all([loadCatalog(), loadSession()]);
  goToStep(0);
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
boot();
