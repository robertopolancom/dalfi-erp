const $ = (id) => document.getElementById(id);
const state = { catalog: null, account: null, client: null, selectedSlot: null };
const reservappConfig = window.DALFI_RESERVAPP_CONFIG || {};
const apiBase = String(reservappConfig.apiBase || "").replace(/\/$/, "");
const money = new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP", maximumFractionDigits: 0 });

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
  const price = services.reduce((sum, item) => sum + item.price, 0);
  $("service-summary").firstElementChild.textContent = services.length ? `${services.length} servicio${services.length === 1 ? "" : "s"}` : "Selecciona uno o más servicios";
  $("service-summary").lastElementChild.textContent = `${duration} min · ${money.format(price)}`;
  $("progress-bar").style.width = services.length ? "30%" : "12%";
  loadAvailability();
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
      const small = document.createElement("small"); small.textContent = `${service.durationMinutes} min · ${money.format(service.price)}`;
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

async function loadAvailability() {
  const serviceIds = selectedServiceIds();
  const staffId = $("staff").value;
  const date = $("date").value;
  state.selectedSlot = null; $("time").value = "";
  if (!serviceIds.length || !staffId || !date) {
    $("time-field").disabled = true;
    $("slots").innerHTML = '<p class="empty">Selecciona servicios, manicurista y fecha.</p>';
    return;
  }
  $("time-field").disabled = true; $("slots").innerHTML = '<p class="empty">Consultando agenda…</p>';
  try {
    const result = await api(`/api/fast-booking/availability?serviceIds=${encodeURIComponent(serviceIds.join(","))}&staffId=${encodeURIComponent(staffId)}&date=${date}`);
    $("time-field").disabled = false; $("slots").replaceChildren();
    if (!result.slots.length) $("slots").innerHTML = '<p class="empty">No quedan horarios para este día. Prueba otra fecha.</p>';
    for (const slot of result.slots) {
      const button = document.createElement("button"); button.type = "button"; button.className = "slot";
      button.textContent = new Date(`2000-01-01T${slot.time}:00`).toLocaleTimeString("es-DO", { hour: "numeric", minute: "2-digit" });
      button.addEventListener("click", () => {
        document.querySelectorAll(".slot").forEach((item) => item.classList.remove("selected"));
        button.classList.add("selected"); state.selectedSlot = slot; $("time").value = slot.time; $("progress-bar").style.width = "65%";
      });
      $("slots").append(button);
    }
  } catch (error) { $("slots").innerHTML = `<p class="empty">${error.message}</p>`; }
}

function requireBookingSelection(targetMessage) {
  if (!selectedServiceIds().length) { message(targetMessage, "Selecciona al menos un servicio."); return false; }
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

$("open-login").addEventListener("click", () => $("login-dialog").showModal());
$("close-login").addEventListener("click", () => $("login-dialog").close());
$("close-client").addEventListener("click", () => $("client-dialog").close());
$("open-client").addEventListener("click", () => { message($("client-message")); if (requireBookingSelection($("booking-message"))) $("client-dialog").showModal(); });
$("employee-new-client").addEventListener("click", () => { message($("client-message")); if (requireBookingSelection($("booking-message"))) $("client-dialog").showModal(); });

$("client-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!requireBookingSelection($("client-message"))) return;
  const button = event.submitter; button.disabled = true; message($("client-message"), "Enviando enlace…", true);
  try {
    const result = await api("/api/reservapp/auth/request-setup", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(setupPayload()) });
    $("client-dialog").close(); message($("booking-message"), result.message, true); $("submit-booking").disabled = true;
  } catch (error) {
    message($("client-message"), error.message);
    if (error.body?.accountExists) { $("client-dialog").close(); $("login-phone").value = $("new-phone").value; $("login-dialog").showModal(); }
  } finally { button.disabled = false; }
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
  try {
    const result = await api("/api/fast-booking/appointments", {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ clientId: state.client.id, serviceIds: selectedServiceIds(), staffId: $("staff").value, date: $("date").value, time: $("time").value, notes: $("notes").value, actorType: state.account.role === "clienta" ? "customer" : "employee", website: $("website").value }),
    });
    const names = selectedServices().map((item) => item.name).join(", ");
    const person = state.catalog.staff.find((item) => item.id === $("staff").value)?.name;
    $("success-summary").textContent = `${names} con ${person}, el ${new Date(`${$("date").value}T12:00:00`).toLocaleDateString("es-DO", { dateStyle: "long" })} a las ${new Date(`2000-01-01T${$("time").value}:00`).toLocaleTimeString("es-DO", { hour: "numeric", minute: "2-digit" })}. Referencia: ${result.appointment.reference}`;
    $("booking-card").classList.add("hidden"); $("success-card").classList.remove("hidden"); window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) { message($("booking-message"), error.message); if (error.body?.conflict) loadAvailability(); }
  finally { button.disabled = false; button.textContent = "Confirmar reserva"; }
});

$("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const password = $("setup-password").value;
  if (password !== $("setup-password-confirm").value) return message($("setup-message"), "Las contraseñas no coinciden.");
  const button = event.submitter; button.disabled = true; message($("setup-message"), "Activando…", true);
  try {
    const token = new URLSearchParams(location.search).get("setup");
    const result = await api("/api/reservapp/auth/complete-setup", { method: "POST", body: JSON.stringify({ token, password }) });
    history.replaceState({}, "", location.pathname); applyAccount(result.account); $("setup-dialog").close();
    if (result.appointment) {
      $("booking-card").classList.add("hidden"); $("success-card").classList.remove("hidden");
      $("success-summary").textContent = `Cita confirmada. Referencia: ${result.appointment.reference}`;
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
[$("staff"), $("date")].forEach((element) => element.addEventListener("change", loadAvailability));

async function boot() {
  await Promise.all([loadCatalog(), loadSession()]);
  if (new URLSearchParams(location.search).get("setup")) $("setup-dialog").showModal();
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
boot();
