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
// Entrar directo a reservapp.dalfistudio.com (sin pasar por aquí) sigue funcionando
// exactamente igual, sin ningún wrapper -- ver outputs/reservar/_headers (frame-ancestors
// solo permite este dominio, ningún otro puede enmarcar ReservApp).
(function () {
  var RESERVAPP_URL = "https://reservapp.dalfistudio.com";
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

// Contenido editable desde el panel "Página web" del ERP (sebensuiteconnect.dalfistudio.com) -- ver
// GET /api/site-content/dalfistudionails en server/app.mjs. El HTML de arriba ya trae el
// contenido real como valor por defecto, así que si este fetch falla o tarda la página se ve
// completa igual -- esto solo la actualiza en el sitio si hay una respuesta válida. El contenido
// viene de la red, así que nunca se usa innerHTML con él: solo textContent/atributos.
(function () {
  var CONTENT_API = "https://sebensuiteconnect.dalfistudio.com/api/site-content/dalfistudionails";

  function getPath(obj, path) {
    return path.split(".").reduce(function (value, key) {
      return value == null ? undefined : value[key];
    }, obj);
  }

  function applyTextNodes(content) {
    document.querySelectorAll("[data-cms]").forEach(function (el) {
      var value = getPath(content, el.dataset.cms);
      if (typeof value !== "string") return;
      el.textContent = value;
      // Campos opcionales (ej. hero.badge) se ocultan si el admin los deja vacíos, en vez de
      // mostrar una etiqueta/recuadro visualmente vacío.
      if (el.dataset.cmsOptional !== undefined) el.style.display = value ? "" : "none";
    });
  }

  function applyWhatsappLinks(content) {
    var whatsapp = content.contact && content.contact.whatsapp;
    if (!whatsapp) return;
    document.querySelectorAll(".js-cms-whatsapp-link").forEach(function (el) {
      el.href = "https://wa.me/" + whatsapp;
    });
    document.querySelectorAll(".js-cms-whatsapp-fab-link").forEach(function (el) {
      el.href = "https://wa.me/" + whatsapp + "?text=" + encodeURIComponent("Hola, quisiera más información");
    });
  }

  function applyInstagramLinks(content) {
    var handle = content.contact && content.contact.instagramHandle;
    if (!handle) return;
    document.querySelectorAll(".js-cms-instagram-link").forEach(function (el) {
      el.href = "https://instagram.com/" + handle;
    });
  }

  function buildServiceRow(service, index) {
    var row = document.createElement("div");
    row.className = "menu-row";

    var indexEl = document.createElement("span");
    indexEl.className = "menu-index";
    indexEl.textContent = String(index + 1).padStart(2, "0");

    var body = document.createElement("div");
    body.className = "menu-body";
    var h3 = document.createElement("h3");
    h3.textContent = service.title || "";
    var p = document.createElement("p");
    p.textContent = service.description || "";
    body.appendChild(h3);
    body.appendChild(p);

    var note = document.createElement("span");
    note.className = "menu-note";
    note.textContent = service.note || "";

    row.appendChild(indexEl);
    row.appendChild(body);
    row.appendChild(note);
    return row;
  }

  function frameIconSvg() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "30");
    svg.setAttribute("height", "30");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.6");
    var rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", "3"); rect.setAttribute("y", "6"); rect.setAttribute("width", "18"); rect.setAttribute("height", "13"); rect.setAttribute("rx", "2");
    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M8 6l1.6-2.4h4.8L16 6");
    var circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", "12"); circle.setAttribute("cy", "12.5"); circle.setAttribute("r", "3.4");
    svg.appendChild(rect); svg.appendChild(path); svg.appendChild(circle);
    return svg;
  }

  function buildGalleryItem(item) {
    var swatch = document.createElement("div");
    swatch.className = "swatch";

    var chip = document.createElement("div");
    if (item.comingSoon || !item.color) {
      chip.className = "chip frame";
      chip.appendChild(frameIconSvg());
    } else {
      chip.className = "chip";
      chip.style.background = item.color;
    }

    var name = document.createElement("span");
    name.className = "chip-name";
    name.textContent = item.label || "";

    var tag = document.createElement("span");
    tag.className = "chip-tag";
    tag.textContent = item.tag || "";

    swatch.appendChild(chip);
    swatch.appendChild(name);
    swatch.appendChild(tag);
    return swatch;
  }

  function applyLists(content) {
    var servicesContainer = document.querySelector('[data-cms-list="services"]');
    if (servicesContainer && Array.isArray(content.services)) {
      servicesContainer.innerHTML = "";
      content.services.forEach(function (service, index) {
        servicesContainer.appendChild(buildServiceRow(service, index));
      });
    }
    var galleryContainer = document.querySelector('[data-cms-list="gallery"]');
    if (galleryContainer && content.gallery && Array.isArray(content.gallery.items)) {
      galleryContainer.innerHTML = "";
      content.gallery.items.forEach(function (item) {
        galleryContainer.appendChild(buildGalleryItem(item));
      });
    }
  }

  function applyPromo(content) {
    var bar = document.getElementById("promo-bar");
    if (!bar) return;
    var promo = content.promo;
    bar.style.display = promo && promo.enabled !== false && promo.text ? "" : "none";
  }

  function applySiteContent(content) {
    if (content.contact) content.contact.instagramHandleDisplay = "@" + (content.contact.instagramHandle || "");
    applyTextNodes(content);
    applyWhatsappLinks(content);
    applyInstagramLinks(content);
    applyLists(content);
    applyPromo(content);
  }

  fetch(CONTENT_API)
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (row) {
      if (row && row.content) applySiteContent(row.content);
    })
    .catch(function () {}); // sin conexión o backend caído -- se queda el contenido estático
})();
