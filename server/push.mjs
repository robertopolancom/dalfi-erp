// Envío de Web Push al personal (bandeja móvil).
//
// Por qué existe este archivo y no está metido en app.mjs:
//
//   1. AÍSLA LA DEPENDENCIA. `web-push` se carga de forma perezosa y opcional: si no está
//      instalada, el ERP arranca igual y el push queda desactivado con un aviso claro. Eso permite
//      que el código viva en el repo antes de instalar nada, y que un fallo al cargarla no tumbe
//      el servidor entero por una función accesoria.
//
//   2. AÍSLA LAS CLAVES. Las VAPID se leen de env y no se escriben nunca en ningún sitio. Las
//      claves p256dh/auth de cada dispositivo pasan por aquí para cifrar y no se registran jamás
//      en los logs -- de ahí `endpointCorto()`, que es lo único del endpoint que se puede anotar.
//
// Un push que no sale NO puede romper lo que lo disparó. Todo lo de aquí atrapa sus errores y los
// devuelve: quien llama decide si le importa, y en la práctica nunca le importa lo bastante como
// para fallar una ingesta de mensaje por un aviso perdido.

let webPushCargado = null;
let webPushIntentado = false;

async function cargarWebPush(logger = console) {
  if (webPushIntentado) return webPushCargado;
  webPushIntentado = true;
  try {
    const modulo = await import("web-push");
    webPushCargado = modulo.default || modulo;
  } catch {
    logger.warn("[push] la dependencia web-push no está instalada: las notificaciones quedan desactivadas.");
    webPushCargado = null;
  }
  return webPushCargado;
}

// Solo esto de un endpoint puede ir a un log. El endpoint completo es un identificador con el que
// se le pueden mandar notificaciones a una persona; el host y cuatro caracteres bastan para
// distinguir dispositivos al diagnosticar.
export function endpointCorto(endpoint) {
  const texto = String(endpoint || "");
  try {
    const url = new URL(texto);
    return `${url.host}/…${texto.slice(-6)}`;
  } catch {
    return `…${texto.slice(-6)}`;
  }
}

export function pushConfigurado(env) {
  return Boolean(env?.VAPID_PUBLIC_KEY && env?.VAPID_PRIVATE_KEY);
}

// El "subject" que exige el estándar VAPID: una forma de contactar con quien manda las
// notificaciones, por si el servicio de push necesita avisar de un problema. Tiene que ser un
// mailto: o una URL, no un texto cualquiera.
function asuntoVapid(env) {
  return String(env?.VAPID_SUBJECT || "mailto:info@dalfistudio.com");
}

/**
 * Manda una notificación a una lista de suscripciones.
 *
 * Devuelve un resultado por suscripción para que quien llama pueda registrar el desenlace con
 * recordPushResult (borrar las caducadas, contar los fallos pasajeros). Nunca lanza.
 */
export async function enviarPush({ env, suscripciones, payload, logger = console, webPushImpl = null }) {
  const lista = Array.isArray(suscripciones) ? suscripciones : [];
  if (!lista.length) return [];
  if (!pushConfigurado(env)) {
    logger.warn("[push] faltan VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY: no se envía nada.");
    return lista.map((s) => ({ id: s.id, ok: false, statusCode: null, motivo: "sin_configurar" }));
  }

  const webPush = webPushImpl || await cargarWebPush(logger);
  if (!webPush) {
    return lista.map((s) => ({ id: s.id, ok: false, statusCode: null, motivo: "sin_dependencia" }));
  }

  const cuerpo = JSON.stringify(payload);
  const opciones = {
    vapidDetails: {
      subject: asuntoVapid(env),
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    },
    // Si el móvil está apagado, que el aviso espere un rato razonable y no eternamente: una
    // notificación de "te está esperando una clienta" no sirve de nada al día siguiente.
    TTL: 3600,
  };

  // En paralelo: son unas pocas suscripciones y encadenarlas haría esperar al mensaje entrante
  // que las disparó.
  return Promise.all(lista.map(async (suscripcion) => {
    try {
      await webPush.sendNotification(
        { endpoint: suscripcion.endpoint, keys: suscripcion.keys },
        cuerpo,
        opciones,
      );
      return { id: suscripcion.id, ok: true, statusCode: 201 };
    } catch (error) {
      const statusCode = Number(error?.statusCode) || null;
      // Se registra el endpoint TRUNCADO y el código. Nunca las claves, nunca el cuerpo del
      // mensaje: el payload lleva el nombre de una clienta y parte de lo que escribió.
      logger.error(`[push] fallo ${statusCode || "sin código"} a ${endpointCorto(suscripcion.endpoint)}`);
      return { id: suscripcion.id, ok: false, statusCode };
    }
  }));
}

/**
 * El contenido de la notificación.
 *
 * Lo justo para decidir si vale la pena abrir: quién escribe, por dónde, y el principio de lo que
 * dijo. Nada más -- una notificación se ve en la pantalla de bloqueo de un teléfono que puede
 * estar encima de una mesa, y ahí no tiene que aparecer nada que no aparecería ya en la lista de
 * conversaciones.
 */
export function construirNotificacion({ conversationId, name, channel, preview, needsHuman = false }) {
  const canal = channel === "web" ? "chat de la web" : "WhatsApp";
  return {
    title: needsHuman ? `${name || "Alguien"} pide atención` : (name || "Mensaje nuevo"),
    body: `${canal}: ${String(preview || "").slice(0, 80)}`.trim(),
    data: { conversationId, channel },
  };
}
