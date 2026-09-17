// La capa de datos de la bandeja. Todo lo que habla con el servidor pasa por aquí.
//
// Existe separada de las pantallas por una razón concreta y no por gusto: hoy los datos llegan
// por SONDEO, y eso fue una decisión de coste, no de arquitectura. Una conexión SSE abierta
// consume vCPU-segundos facturables en Cloud Run y LISTEN/NOTIFY mantiene despierto el cómputo de
// Neon; las dos cosas se comen la capa gratuita en la que corre todo esto. El día que eso cambie,
// se reescribe ESTE archivo y ninguna pantalla se entera.
//
// Las tres reglas que abaratan el sondeo, y que no hay que "simplificar":
//
//   1. SOLO EN PRIMER PLANO. Con la pestaña oculta no se pregunta nada. Una app olvidada abierta
//      toda la noche costaría miles de peticiones para no traer nada.
//   2. PETICIONES CONDICIONALES. Se manda el ETag de lo último que se vio; si no cambió, el
//      servidor responde 304 sin cuerpo y sin armar la lista. Es la diferencia entre sondear
//      barato y sondear caro.
//   3. RETROCESO ANTE ERRORES. Si el servidor falla o no hay red, se va espaciando hasta un
//      minuto en vez de martillear.

(function (global) {
  var API = (global.DALFI_INBOX_CONFIG && global.DALFI_INBOX_CONFIG.apiBase) || "";

  var MS_LISTA = 20000;
  var MS_HILO = 10000;
  var MS_ERROR_MAXIMO = 60000;

  function crearTransporte(obtenerToken) {
    // Un ciclo de sondeo por recurso. Cada uno guarda su ETag y su propio retroceso: que falle la
    // lista no tiene por qué espaciar el hilo que alguien está mirando.
    function crearCiclo({ ruta, intervalo, alRecibir, alFallar }) {
      var etag = null;
      var temporizador = null;
      var esperaPorError = 0;
      var vivo = false;

      async function vuelta() {
        if (!vivo || document.hidden) return programar();
        try {
          var cabeceras = { Authorization: "Bearer " + (await obtenerToken()) };
          if (etag) cabeceras["If-None-Match"] = etag;
          var res = await fetch(API + ruta(), { headers: cabeceras });

          if (res.status === 304) { esperaPorError = 0; return programar(); }
          if (!res.ok) throw new Error("HTTP " + res.status);

          etag = res.headers.get("etag") || etag;
          esperaPorError = 0;
          alRecibir(await res.json());
        } catch (error) {
          // Se dobla la espera hasta el tope. Sin esto, un servidor caído recibe una petición
          // cada diez segundos de cada móvil abierto.
          esperaPorError = Math.min(esperaPorError ? esperaPorError * 2 : intervalo, MS_ERROR_MAXIMO);
          if (alFallar) alFallar(error);
        }
        programar();
      }

      function programar() {
        clearTimeout(temporizador);
        if (!vivo) return;
        temporizador = setTimeout(vuelta, esperaPorError || intervalo);
      }

      return {
        arrancar: function () { vivo = true; vuelta(); },
        parar: function () { vivo = false; clearTimeout(temporizador); },
        // Al cambiar de conversación hay que olvidar el ETag: si no, el primer sondeo del hilo
        // nuevo se compararía con la versión del anterior y podría devolver 304 con el hilo
        // equivocado en pantalla.
        olvidar: function () { etag = null; },
        refrescar: function () { etag = null; esperaPorError = 0; vuelta(); },
      };
    }

    async function pedir(ruta, opciones) {
      var res = await fetch(API + ruta, Object.assign({}, opciones, {
        headers: Object.assign(
          { Authorization: "Bearer " + (await obtenerToken()) },
          (opciones && opciones.headers) || {},
        ),
      }));
      var cuerpo = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        var error = new Error(cuerpo.error || "HTTP " + res.status);
        error.status = res.status;
        error.datos = cuerpo;
        throw error;
      }
      return cuerpo;
    }

    return {
      cicloDeLista: function (alRecibir, alFallar) {
        return crearCiclo({
          ruta: function () { return "/api/chat/conversations"; },
          intervalo: MS_LISTA, alRecibir: alRecibir, alFallar: alFallar,
        });
      },
      cicloDeHilo: function (obtenerId, alRecibir, alFallar) {
        return crearCiclo({
          ruta: function () { return "/api/chat/conversations/" + encodeURIComponent(obtenerId()); },
          intervalo: MS_HILO, alRecibir: alRecibir, alFallar: alFallar,
        });
      },
      accion: function (id, accion) {
        return pedir("/api/chat/conversations/" + encodeURIComponent(id) + "/" + accion, { method: "POST" });
      },
      responder: function (id, texto) {
        return pedir("/api/chat/conversations/" + encodeURIComponent(id) + "/reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: texto }),
        });
      },
      marcarLeido: function (id) {
        return pedir("/api/chat/conversations/" + encodeURIComponent(id) + "/read", { method: "POST" });
      },
      clavePublicaDePush: function () { return pedir("/api/push/public-key"); },
      suscribirPush: function (suscripcion) {
        return pedir("/api/push/subscriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: suscripcion }),
        });
      },
      desuscribirPush: function (endpoint) {
        return pedir("/api/push/subscriptions", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: endpoint }),
        });
      },
    };
  }

  // Lo único que se pide SIN sesión, porque por definición quien lo usa no puede entrar. Va suelto
  // y no dentro de crearTransporte: ahí todo pasa por obtenerToken, y aquí no hay token que pedir.
  //
  // El servidor contesta {ok:true} exista o no el correo (es a propósito: si no, esta ruta serviría
  // para averiguar quién tiene cuenta), así que aquí no hay nada que interpretar. El único caso que
  // sí hay que distinguir es el 429 del limitador, que sí es culpa de quien insiste.
  async function restablecerClave(correo) {
    var res = await fetch(API + "/api/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: correo }),
    });
    if (res.status === 429) throw new Error("Demasiados intentos. Espera unos minutos.");
    if (!res.ok) throw new Error("HTTP " + res.status);
  }

  global.DalfiTransporte = { crear: crearTransporte, restablecerClave: restablecerClave };
})(window);
