const $ = (id) => document.getElementById(id);
const state = { catalog: null, client: null, mode: "customer", token: "", selectedSlot: null };
const api = async (path, options = {}) => {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || "No se pudo completar la solicitud."), { status: response.status, body });
  return body;
};
const message = (element, text = "", ok = false) => { element.textContent = text; element.className = ok ? "message ok" : "message"; };
const money = new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP", maximumFractionDigits: 0 });

function todayLocal() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santo_Domingo" }).format(new Date());
}

function setClient(client) {
  state.client = client;
  $("selected-client").textContent = `✓ Cliente: ${client.name || client.firstName}`;
  $("selected-client").classList.remove("hidden");
  $("progress-bar").style.width = "72%";
}

async function loadCatalog() {
  try {
    state.catalog = await api("/api/fast-booking/catalog");
    for (const service of state.catalog.services) {
      const option = new Option(`${service.name} · ${money.format(service.price)}`, service.id);
      option.dataset.duration = service.durationMinutes;
      $("service").add(option);
    }
    for (const person of state.catalog.staff) $("staff").add(new Option(person.name, person.id));
    const min = todayLocal();
    const max = new Date(`${min}T12:00:00-04:00`);
    max.setDate(max.getDate() + Number(state.catalog.schedule.settings?.maximumAdvanceBookingDays || 60));
    $("date").min = min;
    $("date").max = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santo_Domingo" }).format(max);
    $("date").value = min;
  } catch (error) { message($("booking-message"), "No pudimos cargar la agenda. Intenta nuevamente."); }
}

async function loadAvailability() {
  const serviceId = $("service").value;
  const staffId = $("staff").value;
  const date = $("date").value;
  state.selectedSlot = null;
  $("time").value = "";
  if (!serviceId || !staffId || !date) return;
  $("time-field").disabled = true;
  $("slots").innerHTML = '<p class="empty">Consultando agenda…</p>';
  try {
    const result = await api(`/api/fast-booking/availability?serviceId=${encodeURIComponent(serviceId)}&staffId=${encodeURIComponent(staffId)}&date=${date}`);
    $("time-field").disabled = false;
    $("slots").innerHTML = "";
    if (!result.slots.length) $("slots").innerHTML = '<p class="empty">No quedan horarios para este día. Prueba otra fecha.</p>';
    for (const slot of result.slots) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "slot";
      button.textContent = new Date(`2000-01-01T${slot.time}:00`).toLocaleTimeString("es-DO", { hour: "numeric", minute: "2-digit" });
      button.addEventListener("click", () => {
        document.querySelectorAll(".slot").forEach((item) => item.classList.remove("selected"));
        button.classList.add("selected");
        state.selectedSlot = slot;
        $("time").value = slot.time;
        $("progress-bar").style.width = state.client ? "88%" : "56%";
      });
      $("slots").append(button);
    }
  } catch (error) { $("slots").innerHTML = `<p class="empty">${error.message}</p>`; }
}

$("find-client").addEventListener("click", async () => {
  message($("booking-message"));
  const phone = $("phone").value.trim();
  if (!phone) return message($("booking-message"), "Escribe tu teléfono para buscarte.");
  try {
    const result = await api("/api/fast-booking/client/resolve", { method: "POST", body: JSON.stringify({ phone, email: $("email").value.trim() }) });
    if (result.found) setClient({ id: result.client.id, name: result.client.firstName });
    else {
      $("new-phone").value = phone;
      $("new-email").value = $("email").value.trim();
      message($("booking-message"), "No encontramos tu ficha. Créala con el botón Cliente nuevo.");
      $("open-client").focus();
    }
  } catch (error) { message($("booking-message"), error.message); }
});

$("open-client").addEventListener("click", () => {
  message($("client-message"));
  if (state.mode === "customer") {
    $("new-phone").value ||= $("phone").value;
    $("new-email").value ||= $("email").value;
  }
  $("client-dialog").showModal();
});
$("close-client").addEventListener("click", () => $("client-dialog").close());

$("client-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  message($("client-message"));
  try {
    const result = await api("/api/fast-booking/clients", {
      method: "POST",
      body: JSON.stringify({
        firstName: $("first-name").value, lastName: $("last-name").value,
        phone: $("new-phone").value, email: $("new-email").value,
        actorType: state.mode, website: $("website").value,
      }),
    });
    setClient({ id: result.client.id, name: result.client.name });
    $("client-dialog").close();
    $("client-form").reset();
    message($("booking-message"), "Cliente creado correctamente.", true);
  } catch (error) { message($("client-message"), error.message); }
  finally { button.disabled = false; }
});

$("staff-mode").addEventListener("click", () => {
  if (state.mode === "employee") {
    state.mode = "customer"; state.token = ""; state.client = null;
    $("mode-label").textContent = "Reserva personal";
    $("staff-mode").textContent = "Soy del equipo";
    $("employee-client").classList.add("hidden"); $("customer-self").classList.remove("hidden");
    $("selected-client").classList.add("hidden");
    return;
  }
  $("login-dialog").showModal();
});
$("close-login").addEventListener("click", () => $("login-dialog").close());

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const config = window.DALFI_SUPABASE_CONFIG || {};
  if (!window.supabase || !config.url || !config.publishableKey) return message($("login-message"), "Acceso del equipo no disponible.");
  message($("login-message"), "Entrando…", true);
  const client = window.supabase.createClient(config.url, config.publishableKey, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email: $("login-email").value, password: $("login-password").value });
  if (error) return message($("login-message"), "Correo o contraseña incorrectos.");
  state.token = data.session.access_token; state.mode = "employee"; state.client = null;
  $("mode-label").textContent = "Reserva para un cliente";
  $("staff-mode").textContent = "Salir del equipo";
  $("customer-self").classList.add("hidden"); $("employee-client").classList.remove("hidden");
  $("selected-client").classList.add("hidden");
  $("login-dialog").close(); $("login-form").reset();
});

let searchTimer;
$("client-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = $("client-search").value.trim();
  if (query.length < 2) return $("client-results").replaceChildren();
  searchTimer = setTimeout(async () => {
    try {
      const result = await api(`/api/fast-booking/clients?q=${encodeURIComponent(query)}`);
      $("client-results").replaceChildren(...result.clients.map((client) => {
        const button = document.createElement("button");
        button.type = "button"; button.className = "client-result";
        const strong = document.createElement("strong");
        const small = document.createElement("small");
        strong.textContent = client.full_name;
        small.textContent = client.phone || client.email || "Cliente registrado";
        button.append(strong, small);
        button.addEventListener("click", () => setClient({ id: client.id, name: client.full_name }));
        return button;
      }));
    } catch (error) { message($("booking-message"), error.message); }
  }, 280);
});

$("booking-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  message($("booking-message"));
  if (!state.client) return message($("booking-message"), state.mode === "employee" ? "Selecciona o crea el cliente." : "Busca tu teléfono o crea tu ficha.");
  if (!$("time").value) return message($("booking-message"), "Selecciona una hora disponible.");
  const button = $("submit-booking"); button.disabled = true; button.textContent = "Reservando…";
  try {
    const key = crypto.randomUUID();
    const result = await api("/api/fast-booking/appointments", {
      method: "POST", headers: { "Idempotency-Key": key },
      body: JSON.stringify({ clientId: state.client.id, serviceId: $("service").value, staffId: $("staff").value, date: $("date").value, time: $("time").value, notes: $("notes").value, actorType: state.mode, website: $("website").value }),
    });
    const service = state.catalog.services.find((item) => item.id === $("service").value)?.name;
    const person = state.catalog.staff.find((item) => item.id === $("staff").value)?.name;
    $("success-summary").textContent = `${service} con ${person}, el ${new Date(`${$("date").value}T12:00:00`).toLocaleDateString("es-DO", { dateStyle: "long" })} a las ${new Date(`2000-01-01T${$("time").value}:00`).toLocaleTimeString("es-DO", { hour: "numeric", minute: "2-digit" })}. Referencia: ${result.appointment.reference}`;
    $("booking-card").classList.add("hidden"); $("success-card").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    message($("booking-message"), error.message);
    if (error.body?.conflict) loadAvailability();
  } finally { button.disabled = false; button.textContent = "Confirmar reserva"; }
});

$("new-booking").addEventListener("click", () => location.reload());
["service", "staff", "date"].forEach((id) => $(id).addEventListener("change", loadAvailability));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/reservar/sw.js").catch(() => {});
loadCatalog();
