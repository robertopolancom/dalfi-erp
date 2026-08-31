(function () {
  var nav = document.getElementById("nav");
  var onScroll = function () { nav.classList.toggle("scrolled", window.scrollY > 8); };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
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
