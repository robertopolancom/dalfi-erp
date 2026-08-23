const $ = (id) => document.getElementById(id);
const state = { catalog: null, account: null, client: null, selectedSlot: null, activationTicket: null, passwordResetFlow: false, comboSegments: null, comboIndex: 0 };
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
  $("account-button").textContent = account ? `${account.name} · Salir` : "Entrar";
  $("guest-access").classList.toggle("hidden", Boolean(account));
  $("employee-client").classList.toggle("hidden", !account || !employeeRoles.has(account.role));
  $("admin-panel").classList.toggle("hidden", !account || !["administradora", "superadministrador"].includes(account.role));
  $("mode-label").textContent = !account ? "Reserva rápida" : account.role === "clienta" ? "Mi reserva" : "Reserva del equipo";
  if (state.client) setClient(state.client); else $("selected-client").classList.add("hidden");
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
    }
    const min = todayLocal();
    const max = new Date(`${min}T12:00:00-04:00`);
    max.setDate(max.getDate() + Number(state.catalog.schedule.settings?.maximumAdvanceBookingDays || 60));
    $("date").min = min;
    $("date").max = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santo_Domingo" }).format(max);
    $("date").value = min; $("agenda-date").value = min;
  } catch { message($("booking-message"), "No pudimos cargar la agenda. Intenta nuevamente."); }
}

async function loadSession() {
  try { applyAccount((await api("/api/reservapp/auth/me")).account); }
  catch { applyAccount(null); }
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
  return {
    firstName: $("first-name").value,
    lastName: $("last-name").value,
    phone: $("new-phone").value,
    email: $("new-email").value,
    serviceIds: selectedServiceIds(), staffId: $("staff").value, date: $("date").value, time: $("time").value,
    notes: $("notes").value, website: $("website").value,
  };
}

async function showAgenda() {
  $("booking-card").classList.add("hidden"); $("success-card").classList.add("hidden"); $("agenda-card").classList.remove("hidden");
  $("booking-tab").classList.remove("active"); $("agenda-tab").classList.add("active");
  if (!state.account) { $("login-dialog").showModal(); return; }
  message($("agenda-message"), "Cargando agenda…", true);
  try {
    const result = await api(`/api/reservapp/agenda?date=${$("agenda-date").value}`);
    message($("agenda-message"));
    $("agenda-title").textContent = new Date(`${result.date}T12:00:00`).toLocaleDateString("es-DO", { weekday: "long", day: "numeric", month: "long" });
    $("agenda-intro").textContent = result.visibility === "team" ? "Todo el equipo puede ver clientes, servicios y ocupación de cada manicurista." : "Solo se muestran tus propias citas.";
    const groups = result.visibility === "team" ? result.staff.map((person) => ({ id: person.id, name: person.full_name })) : [{ id: state.account.clientId, name: "Mis citas", client: true }];
    $("agenda-board").replaceChildren(...groups.map((group) => {
      const column = document.createElement("section"); column.className = "agenda-column";
      const heading = document.createElement("h3"); heading.textContent = group.name; column.append(heading);
      const appointments = result.appointments.filter((item) => group.client ? true : item.staff_id === group.id);
      if (!appointments.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "Disponible"; column.append(empty); }
      for (const item of appointments) {
        const block = document.createElement("article"); block.className = "appointment-block";
        const time = document.createElement("strong"); time.textContent = `${item.start_time}–${item.end_time}`;
        const client = document.createElement("span"); client.textContent = item.client_name || "Cliente";
        const service = document.createElement("small"); service.textContent = item.services;
        block.append(time, client, service); column.append(block);
      }
      return column;
    }));
  } catch (error) { message($("agenda-message"), error.message); }
}

function showBooking() {
  $("agenda-card").classList.add("hidden"); $("success-card").classList.add("hidden"); $("booking-card").classList.remove("hidden");
  $("agenda-tab").classList.remove("active"); $("booking-tab").classList.add("active");
}

$("start-booking").addEventListener("click", () => goToStep(1));
$("step1-back").addEventListener("click", () => goToStep(0));
$("step1-next").addEventListener("click", () => {
  if (!selectedServiceIds().length) return message($("booking-message"), "Selecciona al menos un servicio.");
  message($("booking-message"));
  goToStep(2);
});
$("step2-back").addEventListener("click", () => goToStep(1));
$("step2-next").addEventListener("click", () => {
  if (!$("date").value) return message($("booking-message"), "Elige una fecha.");
  message($("booking-message"));
  goToStep(3);
});
$("step3-back").addEventListener("click", () => goToStep(2));
$("step4-back").addEventListener("click", () => goToStep(3));

$("open-login").addEventListener("click", () => $("login-dialog").showModal());
$("close-login").addEventListener("click", () => $("login-dialog").close());
$("close-client").addEventListener("click", () => $("client-dialog").close());

// Dos entradas distintas al MISMO diálogo de "primera vez", con comportamiento distinto al
// enviarlo (ver client-form submit abajo): la clienta que se registra sola (open-client)
// necesita verificar su teléfono por WhatsApp antes de que exista su ficha -- nadie del salón
// está validando esos datos. El personal (employee-new-client) SÍ está presente validando a
// la clienta en persona, así que no tiene sentido hacerla esperar un código; crea la ficha al
// instante contra /api/fast-booking/clients (mismo endpoint que ya usa la búsqueda existente).
function openClientDialog({ forEmployee }) {
  // El registro-invitada por WhatsApp (auto-servicio) guarda un borrador de UNA sola cita
  // (staff_id/appointment_date/appointment_time en una fila) -- no soporta todavía varias citas
  // vinculadas por groupId. En combo, solo el registro hecho por el personal funciona (crea la
  // ficha al instante y la reserva combinada se confirma después, ya con sesión iniciada).
  if (!forEmployee && Array.isArray(state.comboSegments) && state.comboSegments.length) {
    message($("booking-message"), "Para servicios combinados con distinta manicurista, pide a una asesora que registre tu cita.");
    return;
  }
  state.clientDialogForEmployee = forEmployee;
  $("client-dialog-title").textContent = forEmployee ? "Registrar clienta" : "Crear mi acceso";
  $("client-dialog-intro").textContent = forEmployee
    ? "Regístrala al instante — tú ya la tienes en frente, no hace falta verificarla por WhatsApp."
    : "Te enviaremos un código de 6 dígitos a tu WhatsApp. Con él confirmas tu teléfono, creas tu contraseña y se confirma el horario elegido.";
  $("client-form").querySelector("button[type=submit]").textContent = forEmployee ? "Registrar clienta" : "Enviarme el código por WhatsApp";
  message($("client-message"));
  if (requireBookingSelection($("booking-message"))) $("client-dialog").showModal();
}
$("open-client").addEventListener("click", () => openClientDialog({ forEmployee: false }));
$("employee-new-client").addEventListener("click", () => openClientDialog({ forEmployee: true }));

$("client-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!requireBookingSelection($("client-message"))) return;
  const button = event.submitter; button.disabled = true;
  if (state.clientDialogForEmployee) {
    message($("client-message"), "Registrando…", true);
    try {
      const result = await api("/api/fast-booking/clients", {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ firstName: $("first-name").value, lastName: $("last-name").value, phone: $("new-phone").value, email: $("new-email").value, actorType: "employee" }),
      });
      setClient(result.client);
      $("client-dialog").close();
      message($("booking-message"), `Clienta ${result.client.name} registrada. Ya puedes confirmar la reserva.`, true);
    } catch (error) {
      message($("client-message"), error.body?.duplicate ? "Ya existe una clienta con ese teléfono o correo." : error.message);
    } finally { button.disabled = false; }
    return;
  }
  message($("client-message"), "Enviando código…", true);
  try {
    const result = await api("/api/reservapp/auth/request-setup", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(setupPayload()) });
    $("client-dialog").close(); message($("booking-message"), result.message, true); $("submit-booking").disabled = true;
    $("verify-code-phone").value = $("new-phone").value; $("verify-code-code").value = "";
    message($("verify-code-message")); $("verify-code-dialog").showModal();
  } catch (error) {
    message($("client-message"), error.message);
    if (error.body?.accountExists) { $("client-dialog").close(); $("login-phone").value = $("new-phone").value; $("login-dialog").showModal(); }
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
    state.passwordResetFlow = true; $("forgot-password-dialog").close(); message($("booking-message"), result.message, true);
    $("verify-code-phone").value = $("forgot-password-phone").value; $("verify-code-code").value = "";
    message($("verify-code-message")); $("verify-code-dialog").showModal();
  } catch (error) { message($("forgot-password-message"), error.message); }
  finally { button.disabled = false; }
});

$("verify-code-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; message($("verify-code-message"), "Verificando…", true);
  try {
    const result = await api("/api/reservapp/setup/verify-code", { method: "POST", body: JSON.stringify({ phone: $("verify-code-phone").value, code: $("verify-code-code").value }) });
    state.activationTicket = result.activationTicket; $("verify-code-dialog").close();
    $("setup-password").value = ""; $("setup-password-confirm").value = ""; message($("setup-message"));
    $("setup-dialog-title").textContent = state.passwordResetFlow ? "Elige tu nueva contraseña" : "Crea tu contraseña";
    $("setup-form").querySelector("button[type=submit]").textContent = state.passwordResetFlow ? "Guardar nueva contraseña" : "Activar y confirmar cita";
    $("setup-dialog").showModal();
  } catch (error) { message($("verify-code-message"), error.message); }
  finally { button.disabled = false; }
});

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; message($("login-message"), "Entrando…", true);
  try {
    const result = await api("/api/reservapp/auth/login", { method: "POST", body: JSON.stringify({ phone: $("login-phone").value, password: $("login-password").value }) });
    applyAccount(result.account); $("login-dialog").close(); $("login-form").reset(); message($("booking-message"), `Hola, ${result.account.name}.`, true);
    if (!$("agenda-card").classList.contains("hidden")) showAgenda();
  } catch (error) { message($("login-message"), error.message); }
  finally { button.disabled = false; }
});

$("account-button").addEventListener("click", async () => {
  if (!state.account) return $("login-dialog").showModal();
  await api("/api/reservapp/auth/logout", { method: "POST" }).catch(() => {}); applyAccount(null); showBooking();
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
    } else message($("booking-message"), result.bookingError || "Cuenta activada. Ya puedes reservar.", !result.bookingError);
  } catch (error) { message($("setup-message"), error.message); }
  finally { button.disabled = false; }
});

$("create-account").addEventListener("click", async () => {
  message($("account-message"), "Enviando…", true);
  try {
    const result = await api("/api/reservapp/admin/accounts", { method: "POST", body: JSON.stringify({ staffId: $("account-staff").value, role: $("account-role").value, phone: $("account-phone").value }) });
    message($("account-message"), result.deliveryStatus === "sent" ? "Credenciales enviadas por WhatsApp." : "Cuenta creada; el envío de WhatsApp quedó pendiente.", true);
  } catch (error) { message($("account-message"), error.message); }
});

$("booking-tab").addEventListener("click", showBooking); $("agenda-tab").addEventListener("click", showAgenda);
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
