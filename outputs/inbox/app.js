// Bandeja móvil del personal. Tres pantallas: lista, hilo, ajustes.
//
// Lo que NO hace, a propósito: configurar el bot, reportes, gestión de usuarios. Todo eso vive en
// el ERP. Esta app es para atender a alguien que está esperando, desde el móvil, y cada cosa que
// no sea eso le quita sitio a lo que sí.
//
// Los datos NO se piden desde aquí: van por transporte.js. Ver ahí por qué es sondeo y no SSE.

(function () {
  var cfg = window.DALFI_INBOX_CONFIG || {};
  var supabase = null;
  var transporte = null;

  var estado = {
    filtro: "pendientes",
    conversaciones: [],
    hilo: null,
    abierta: null,
    miStaffId: null,
  };

  var $ = function (id) { return document.getElementById(id); };
  var mostrar = function (id) {
    ["pantalla-acceso", "pantalla-lista", "pantalla-hilo", "pantalla-ajustes"]
      .forEach(function (p) { $(p).classList.toggle("oculta", p !== id); });
  };
  var aviso = function (id, texto, esAlerta) {
    var el = $(id);
    el.textContent = texto || "";
    el.className = "aviso" + (esAlerta ? " alerta" : "");
  };

  // --- Acceso ---------------------------------------------------------------------------------

  function iniciarSupabase() {
    if (supabase) return supabase;
    supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    return supabase;
  }

  // El token se pide en CADA llamada en vez de guardarse: supabase-js lo renueva solo, y una copia
  // nuestra caducada produciría 401 aleatorios que parecen "se cayó el servidor".
  async function token() {
    var r = await iniciarSupabase().auth.getSession();
    if (!r.data.session) { cerrarSesion(); throw new Error("Sesión caducada."); }
    return r.data.session.access_token;
  }

  $("form-acceso").addEventListener("submit", async function (e) {
    e.preventDefault();
    var boton = $("boton-entrar");
    boton.disabled = true;
    aviso("aviso-acceso", "Entrando…");
    try {
      var r = await iniciarSupabase().auth.signInWithPassword({
        email: $("correo").value.trim(),
        password: $("clave").value,
      });
      if (r.error) throw new Error("Correo o contraseña incorrectos.");
      $("clave").value = "";
      await entrar();
    } catch (error) {
      aviso("aviso-acceso", error.message, true);
    } finally {
      boton.disabled = false;
    }
  });

  // Olvido de contraseña. El correo que llega lleva a ssc.dalfistudio.com (el ERP) porque el enlace
  // de recuperación de Supabase apunta allí y allí está la pantalla que ya sabe recibirlo. Se dice
  // en el aviso: si no, la persona abre el correo en el móvil, aterriza en el ERP y cree que se
  // equivocó de aplicación.
  $("boton-olvide").addEventListener("click", async function () {
    var correo = $("correo").value.trim();
    if (!correo || correo.indexOf("@") < 0) {
      $("correo").focus();
      return aviso("aviso-acceso", "Escribe primero tu correo y vuelve a pulsar.", true);
    }
    var boton = $("boton-olvide");
    boton.disabled = true;
    aviso("aviso-acceso", "Enviando…");
    try {
      await window.DalfiTransporte.restablecerClave(correo);
      // Redacción deliberadamente en condicional ("si esa cuenta existe"): el servidor contesta
      // igual en ambos casos y prometer un correo que no va a llegar es peor que no prometerlo.
      aviso("aviso-acceso", "Si esa cuenta existe, te llega un correo con el enlace. Se abre en el ERP; cuando cambies la contraseña, vuelve aquí.");
    } catch (error) {
      aviso("aviso-acceso", error.message, true);
    } finally {
      boton.disabled = false;
    }
  });

  async function cerrarSesion() {
    pararTodo();
    try { await iniciarSupabase().auth.signOut(); } catch (e) { /* da igual: igual salimos */ }
    mostrar("pantalla-acceso");
  }
  $("boton-salir").addEventListener("click", cerrarSesion);

  // --- Lista ----------------------------------------------------------------------------------

  var cicloLista = null;
  var cicloHilo = null;

  function pararTodo() {
    if (cicloLista) cicloLista.parar();
    if (cicloHilo) cicloHilo.parar();
  }

  async function entrar() {
    transporte = window.DalfiTransporte.crear(token);
    cicloLista = transporte.cicloDeLista(
      function (datos) {
        estado.conversaciones = datos.conversations || [];
        pintarLista();
        aviso("aviso-lista", "");
      },
      function (error) {
        // El 403 aquí significa "tu usuario no atiende conversaciones", y es distinto de un fallo
        // de red: no se arregla esperando.
        aviso("aviso-lista", error.message.indexOf("403") >= 0
          ? "Tu usuario no tiene permiso para atender la bandeja."
          : "Sin conexión. Reintentando…", true);
      },
    );
    cicloLista.arrancar();
    mostrar("pantalla-lista");
    var r = await iniciarSupabase().auth.getSession();
    $("quien-soy").textContent = r.data.session ? r.data.session.user.email : "";
  }

  function conversacionesVisibles() {
    return estado.conversaciones.filter(function (c) {
      if (estado.filtro === "pendientes") return c.needsHuman && !c.assignedStaffId;
      if (estado.filtro === "mias") return c.assignedStaffId && c.assignedStaffId === estado.miStaffId;
      return true;
    });
  }

  function pintarLista() {
    var lista = $("lista");
    lista.textContent = "";
    var visibles = conversacionesVisibles();
    if (!visibles.length) {
      var vacio = document.createElement("li");
      vacio.className = "vacio";
      vacio.textContent = estado.filtro === "pendientes"
        ? "Nadie esperando. 🎉"
        : "Nada por aquí.";
      lista.append(vacio);
      return;
    }
    visibles.forEach(function (c) {
      var li = document.createElement("li");
      li.className = "fila" + ((!c.assignedStaffId && (c.botPausado || c.needsHuman)) ? " urgente" : "");
      li.tabIndex = 0;
      li.setAttribute("role", "button");

      var cabecera = document.createElement("div");
      cabecera.className = "fila-cabecera";
      var nombre = document.createElement("strong");
      // textContent y nunca innerHTML: el nombre viene del perfil de WhatsApp y lo elige quien
      // escribe, así que es texto ajeno.
      nombre.textContent = c.name;
      cabecera.append(nombre);
      cabecera.append(etiqueta(c.channel === "web" ? "web" : "WhatsApp", "canal"));
      // Lo más grave primero: si nadie la atiende, eso manda sobre "pide ayuda".
      if (!c.assignedStaffId && c.botPausado) cabecera.append(etiqueta("nadie atiende", "urgente"));
      else if (c.needsHuman && !c.assignedStaffId) cabecera.append(etiqueta("pide ayuda", "urgente"));
      // Quién atiende, siempre a la vista. Nunca se deja una fila sin decirlo.
      if (c.assignedStaffId) {
        cabecera.append(etiqueta(
          c.assignedStaffId === estado.miStaffId ? "la atiendes tú" : (c.assignedStaffName || "otro asesor"),
          "asignada",
        ));
      } else if (!c.botPausado) {
        cabecera.append(etiqueta("atiende el bot", "bot"));
      }
      if (c.channel !== "web" && c.within24h === false) cabecera.append(etiqueta("fuera de 24 h", "ventana"));
      li.append(cabecera);

      if (c.handoffReason) {
        var motivo = document.createElement("small");
        motivo.className = "motivo";
        motivo.textContent = c.handoffReason;
        li.append(motivo);
      }

      var previo = document.createElement("p");
      previo.className = "previo";
      previo.textContent = c.preview || "";
      li.append(previo);

      if (c.unread) li.append(etiqueta(String(c.unread), "sinleer"));

      var abrir = function () { abrirHilo(c.id); };
      li.addEventListener("click", abrir);
      li.addEventListener("keydown", function (e) { if (e.key === "Enter") abrir(); });
      lista.append(li);
    });
  }

  function etiqueta(texto, clase) {
    var s = document.createElement("span");
    s.className = "etiqueta " + clase;
    s.textContent = texto;
    return s;
  }

  $("filtros").addEventListener("click", function (e) {
    var boton = e.target.closest("[data-filtro]");
    if (!boton) return;
    estado.filtro = boton.dataset.filtro;
    [].forEach.call($("filtros").children, function (b) { b.classList.toggle("activo", b === boton); });
    pintarLista();
  });

  // --- Hilo -----------------------------------------------------------------------------------

  function abrirHilo(id) {
    estado.abierta = id;
    estado.hilo = null;
    $("mensajes").textContent = "";
    aviso("aviso-hilo", "");
    mostrar("pantalla-hilo");

    if (!cicloHilo) {
      cicloHilo = transporte.cicloDeHilo(
        function () { return estado.abierta; },
        function (hilo) { estado.hilo = hilo; estado.miStaffId = hilo.miStaffId || estado.miStaffId; pintarHilo(); },
        function () { aviso("aviso-hilo", "Sin conexión. Reintentando…", true); },
      );
    }
    cicloHilo.olvidar();
    cicloHilo.arrancar();
    transporte.marcarLeido(id).catch(function () { /* no leído es mejor que romper la pantalla */ });
  }

  $("boton-volver").addEventListener("click", function () {
    if (cicloHilo) cicloHilo.parar();
    estado.abierta = null;
    mostrar("pantalla-lista");
    if (cicloLista) cicloLista.refrescar();
  });

  function pintarHilo() {
    var hilo = estado.hilo;
    if (!hilo) return;
    $("hilo-nombre").textContent = hilo.name;

    var mia = hilo.assignedStaffId && hilo.assignedStaffId === hilo.miStaffId;
    var deOtra = hilo.assignedStaffId && !mia;
    var fueraDeVentana = hilo.channel !== "web" && hilo.within24h === false;

    // El peor de los dos mundos: el bot en pausa Y sin nadie asignado. A esa persona no le
    // contesta NADIE. Pasa cuando alguien toma una conversación y la suelta sin devolverla al
    // bot, o cuando la suelta la reanudación automática. Hasta ahora no se veía en ninguna
    // pantalla: se leía igual que "sin tomar", que es una situación mucho menos grave.
    var abandonada = !hilo.assignedStaffId && hilo.botPausado;

    // Solo dos estados, nunca un tercero: la atiende un asesor o la atiende el bot. "Sin tomar"
    // se decía antes y era engañoso -- describía de quién NO era, no quién estaba respondiendo.
    $("hilo-estado").textContent = [
      hilo.channel === "web" ? "chat de la web" : "WhatsApp",
      abandonada ? "NO LA ATIENDE NADIE"
        : deOtra ? "la atiende " + (hilo.assignedStaffName || "otro asesor")
        : mia ? "la atiendes tú"
        : "atiende el bot",
    ].join(" · ");

    $("boton-tomar").classList.toggle("oculta", Boolean(hilo.assignedStaffId));
    $("boton-soltar").classList.toggle("oculta", !mia);
    $("boton-cerrar").classList.toggle("oculta", !mia);

    // Cualquier asesor puede continuar la conversación, la tenga quien la tenga. Si quien la
    // empezó no está, el cliente no tiene por qué esperar a que vuelva; no pisarse va por
    // procedimiento interno, que admite matices que un candado no admite.
    //
    // Lo único que sigue bloqueando es la ventana de 24 h, y eso no es una regla nuestra: es que
    // WhatsApp descarta el mensaje y el cliente no recibiría nada.
    var puede = !fueraDeVentana;
    $("texto").disabled = !puede;
    $("boton-enviar").disabled = !puede;
    $("texto").placeholder = fueraDeVentana ? "Fuera de la ventana de 24 h"
      : deOtra ? "Continuar (la atiende " + (hilo.assignedStaffName || "otro asesor") + ")"
      : "Escribe tu respuesta…";

    // Orden a propósito: primero lo que deja a alguien sin respuesta, después lo que te impide
    // responder. Si las dos cosas pasan a la vez, la que hay que leer es la primera.
    if (abandonada) {
      // Con el servidor arreglado esto ya no debería ocurrir: soltar y cerrar reanudan el bot
      // antes de tocar nada. Se queda como red de seguridad -- para conversaciones que quedaron
      // así antes del arreglo, y para el día que el puente falle de una forma nueva.
      aviso("aviso-hilo", "Nadie está atendiendo esto: el bot está en pausa y no la tiene ningún asesor. Tómala, o devuélvela al bot.", true);
    } else if (deOtra) {
      aviso("aviso-hilo", "La está atendiendo " + (hilo.assignedStaffName || "otro asesor") + ". Puedes continuar tú, pero que no le lleguen dos respuestas distintas.", true);
    } else if (fueraDeVentana) {
      aviso("aviso-hilo", "Pasaron más de 24 horas desde su último mensaje: WhatsApp no deja escribirle texto libre hasta que vuelva a escribir.", true);
    } else {
      aviso("aviso-hilo", "");
    }

    var caja = $("mensajes");
    caja.textContent = "";
    (hilo.messages || []).forEach(function (m) {
      var div = document.createElement("div");
      var quien = m.senderType === "cliente" ? "cliente" : m.senderType === "staff" ? "agente" : "bot";
      div.className = "mensaje " + quien;
      var meta = document.createElement("small");
      meta.textContent = (m.senderType === "staff" ? (m.staffName || "Personal")
        : m.senderType === "bot" ? "Dalfi" : hilo.name) + " · " + cuando(m.createdAt);
      div.append(meta);
      var cuerpo = document.createElement("p");
      cuerpo.textContent = m.body || "";
      div.append(cuerpo);
      // Adjuntos: si el servidor ya firma la URL se muestra la imagen; si no, se dice que hay algo
      // en vez de fingir que el mensaje venía vacío.
      if (m.mediaHref && m.messageType === "image") {
        var img = document.createElement("img");
        img.className = "adjunto";
        img.src = m.mediaHref;
        img.alt = m.mediaFilename || "Adjunto";
        img.loading = "lazy";
        div.append(img);
      } else if (m.tieneAdjunto || (m.messageType && m.messageType !== "text")) {
        var nota = document.createElement("small");
        nota.className = "adjunto-nota";
        nota.textContent = "📎 adjunto — ábrelo desde el ERP";
        div.append(nota);
      }
      if (m.deliveryStatus === "failed") {
        var fallo = document.createElement("small");
        fallo.className = "fallo";
        fallo.textContent = "no se entregó";
        div.append(fallo);
      }
      caja.append(div);
    });
    caja.scrollTop = caja.scrollHeight;
  }

  function cuando(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    var min = Math.round((Date.now() - d.getTime()) / 60000);
    if (min < 1) return "ahora";
    if (min < 60) return "hace " + min + " min";
    if (min < 1440) return "hace " + Math.round(min / 60) + " h";
    return d.toLocaleDateString("es-DO", { day: "numeric", month: "short" });
  }

  ["tomar", "soltar", "cerrar"].forEach(function (nombre) {
    var accion = { tomar: "claim", soltar: "release", cerrar: "close" }[nombre];
    $("boton-" + nombre).addEventListener("click", async function () {
      if (!estado.abierta) return;
      try {
        var r = await transporte.accion(estado.abierta, accion);
        if (r.aviso) aviso("aviso-hilo", r.aviso, true);
        if (accion === "close") {
          if (cicloHilo) cicloHilo.parar();
          estado.abierta = null;
          mostrar("pantalla-lista");
          if (cicloLista) cicloLista.refrescar();
          return;
        }
        cicloHilo.refrescar();
      } catch (error) {
        // El 409 de "la tiene otra" no es un error de la app: es el estado real. Se muestra y se
        // recarga el hilo para que la pantalla deje de ofrecer lo que ya no se puede.
        aviso("aviso-hilo", error.message, true);
        if (cicloHilo) cicloHilo.refrescar();
      }
    });
  });

  $("form-responder").addEventListener("submit", async function (e) {
    e.preventDefault();
    var texto = $("texto").value.trim();
    if (!texto || !estado.abierta) return;
    // Sin red no se intenta: dejarlo "enviando" y perderlo es peor que decirlo.
    if (!navigator.onLine) return aviso("aviso-hilo", "Sin conexión: no se puede enviar todavía.", true);
    $("boton-enviar").disabled = true;
    aviso("aviso-hilo", "Enviando…");
    try {
      var r = await transporte.responder(estado.abierta, texto);
      // ok:false con 200 significa que quedó en el hilo pero no se entregó. Hay que decirlo o
      // alguien creerá que ya atendió a una clienta que sigue esperando.
      if (r.ok === false) {
        aviso("aviso-hilo", r.error || "Quedó guardado pero no se entregó.", true);
      } else {
        $("texto").value = "";
        aviso("aviso-hilo", r.aviso || "");
      }
      cicloHilo.refrescar();
    } catch (error) {
      aviso("aviso-hilo", error.message, true);
      if (error.status === 409 || error.status === 403) cicloHilo.refrescar();
    } finally {
      $("boton-enviar").disabled = false;
    }
  });

  // --- Ajustes y notificaciones ---------------------------------------------------------------

  $("boton-ajustes").addEventListener("click", function () { mostrar("pantalla-ajustes"); estadoDePush(); });
  $("boton-volver-ajustes").addEventListener("click", function () { mostrar("pantalla-lista"); });

  // En iPhone las notificaciones solo existen si la app está instalada en la pantalla de inicio.
  // Es la pregunta que va a llegar, así que se contesta antes de que la hagan.
  var esIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  var instalada = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

  async function estadoDePush() {
    var texto = $("estado-push");
    $("nota-ios").hidden = !(esIOS && !instalada);
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      texto.textContent = "Este navegador no admite notificaciones.";
      $("boton-push").disabled = true;
      return;
    }
    var reg = await navigator.serviceWorker.getRegistration();
    var sub = reg && await reg.pushManager.getSubscription();
    texto.textContent = sub ? "Activadas en este dispositivo." : "Desactivadas en este dispositivo.";
    $("boton-push").textContent = sub ? "Desactivar notificaciones" : "Activar notificaciones";
    $("boton-push").dataset.activas = sub ? "1" : "";
  }

  $("boton-push").addEventListener("click", async function () {
    var boton = $("boton-push");
    boton.disabled = true;
    try {
      var reg = await navigator.serviceWorker.ready;
      if (boton.dataset.activas) {
        var actual = await reg.pushManager.getSubscription();
        if (actual) { await transporte.desuscribirPush(actual.endpoint); await actual.unsubscribe(); }
      } else {
        var permiso = await Notification.requestPermission();
        if (permiso !== "granted") throw new Error("No diste permiso para notificaciones.");
        // La clave pública se pide al servidor en vez de venir en el build: así se puede rotar el
        // par sin volver a desplegar esta app.
        var clave = (await transporte.clavePublicaDePush()).publicKey;
        var sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlABytes(clave),
        });
        // Si el servidor no se queda con la suscripción, hay que DESHACER la del navegador. Sin
        // esto la pantalla mentía de la peor manera posible: el navegador sí tenía suscripción,
        // así que decía "Activadas en este dispositivo" y ofrecía desactivarlas, mientras el
        // servidor no tenía a quién avisar. Nunca llegaba nada y no había forma de saber por qué.
        try {
          await transporte.suscribirPush(sub.toJSON());
        } catch (fallo) {
          await sub.unsubscribe().catch(function () {});
          throw fallo;
        }
      }
      await estadoDePush();
    } catch (error) {
      // Un 403 aquí no es un problema de notificaciones: es que el correo de esta cuenta no está
      // en ninguna ficha de app.staff. Decirlo así ahorra la llamada.
      $("estado-push").textContent = error.status === 403
        ? "Tu cuenta no está vinculada a una ficha de personal. Hay que poner este correo en tu ficha desde el ERP."
        : error.message;
    } finally {
      boton.disabled = false;
    }
  });

  function base64UrlABytes(base64) {
    var relleno = "=".repeat((4 - (base64.length % 4)) % 4);
    var normal = (base64 + relleno).replace(/-/g, "+").replace(/_/g, "/");
    var crudo = atob(normal);
    return Uint8Array.from(crudo, function (c) { return c.charCodeAt(0); });
  }

  // Tocar la notificación abre su conversación: el service worker manda el id por aquí.
  navigator.serviceWorker && navigator.serviceWorker.addEventListener("message", function (e) {
    if (e.data && e.data.tipo === "abrir-conversacion" && e.data.conversationId) {
      abrirHilo(e.data.conversationId);
    }
  });

  // --- Arranque -------------------------------------------------------------------------------

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(function (error) {
      console.warn("[inbox] no se pudo registrar el service worker:", error);
    });
  }

  // Al volver a primer plano se refresca en el acto en vez de esperar la siguiente vuelta: quien
  // vuelve a la app quiere ver lo de ahora, no lo de hace veinte segundos.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    if (cicloLista) cicloLista.refrescar();
    if (cicloHilo && estado.abierta) cicloHilo.refrescar();
  });

  (async function () {
    var r = await iniciarSupabase().auth.getSession();
    if (r.data.session) await entrar();
    else mostrar("pantalla-acceso");
  })();
})();
