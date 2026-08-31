(function () {
  var nav = document.getElementById("nav");
  var onScroll = function () { nav.classList.toggle("scrolled", window.scrollY > 8); };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
})();

// Navegación por páginas (Inicio/Servicios/Galería/Ubicación) en vez de una sola página
// larga con scroll -- cada botón del nav muestra su sección y oculta las demás. El hash
// de la URL (#servicios, etc.) sigue funcionando para compartir/recargar un enlace directo
// a una página concreta, y el botón "atrás" del navegador funciona porque se usa
// history.pushState en vez de solo cambiar el hash a mano.
(function () {
  var DEFAULT_PAGE = "inicio";
  var pages = Array.prototype.slice.call(document.querySelectorAll(".page"));
  var tabs = Array.prototype.slice.call(document.querySelectorAll("[data-page-link]"));

  function pageIdFromHash() {
    var id = (window.location.hash || "").replace("#", "");
    var known = pages.some(function (page) { return page.dataset.page === id; });
    return known ? id : DEFAULT_PAGE;
  }

  function showPage(id, options) {
    options = options || {};
    pages.forEach(function (page) {
      page.classList.toggle("active", page.dataset.page === id);
    });
    tabs.forEach(function (tab) {
      if (tab.classList.contains("nav-tab")) tab.classList.toggle("active", tab.dataset.pageLink === id);
    });
    if (options.scrollTop !== false) window.scrollTo(0, 0);
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function (event) {
      var id = tab.dataset.pageLink;
      if (!id) return;
      event.preventDefault();
      if (window.location.hash !== "#" + id) history.pushState(null, "", "#" + id);
      showPage(id);
    });
  });

  window.addEventListener("popstate", function () { showPage(pageIdFromHash(), { scrollTop: false }); });

  showPage(pageIdFromHash(), { scrollTop: false }); // respeta un enlace directo con hash al cargar
})();

// El botón "Reservar" abre ReservApp en un modal incrustado (iframe) en vez de navegar
// fuera de la página -- la clienta nunca pierde el contexto de la página del estudio.
// Entrar directo a reservapp.sebengroup.com (sin pasar por aquí) sigue funcionando
// exactamente igual, sin ningún wrapper -- ver outputs/reservar/_headers (frame-ancestors
// solo permite este dominio, ningún otro puede enmarcar ReservApp).
(function () {
  var RESERVAPP_URL = "https://reservapp.sebengroup.com";
  var dialog = document.getElementById("reservar-dialog");
  var frame = document.getElementById("reservar-frame");
  var closeBtn = document.getElementById("reservar-close");

  function openReservar(event) {
    event.preventDefault();
    if (!frame.src) frame.src = RESERVAPP_URL; // primera apertura: carga perezosa
    dialog.showModal();
  }
  document.querySelectorAll(".js-reservar").forEach(function (el) {
    el.addEventListener("click", openReservar);
  });
  closeBtn.addEventListener("click", function () { dialog.close(); });
  dialog.addEventListener("click", function (event) {
    if (event.target === dialog) dialog.close(); // clic fuera del panel
  });
})();
