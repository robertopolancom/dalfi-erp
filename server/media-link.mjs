// Enlace público al adjunto de una conversación.
//
// Por qué es público y no va detrás de la sesión del ERP: una etiqueta <img> del navegador hace
// una petición normal y NO manda la cabecera de sesión, así que una foto detrás de
// requireErpPermission nunca llega a cargar -- se ve el candado, no la imagen. Y Roberto pidió
// además que el enlace se pueda reenviar: quien lo tenga, lo abre.
//
// Lo que protege el enlace es la firma, igual que en las facturas: sin el secreto no se puede
// fabricar uno para el adjunto de otra persona ni cambiar un id en la URL. Y lo que limita la
// exposición en el tiempo es la purga -- los adjuntos se borran a los 3 días, así que un enlace
// reenviado deja de servir solo.
//
// El prefijo "media:" dentro de lo firmado es deliberado: impide que un token emitido para una
// factura valga como token de adjunto, y al revés. Sin él, los dos usan el mismo secreto y una
// firma serviría para las dos puertas.

import { b64url, signPayload, verifySignedPayload } from "./signed-links.mjs";

const PREFIJO = "media:";

function secretFor(env) {
  return String(env.INVOICE_LINK_SECRET || env.ERP_WEBHOOK_SECRET || "");
}

export function mediaToken(env, messageId) {
  const id = String(messageId || "").trim();
  const secret = secretFor(env);
  // Sin secreto no se emite enlace. Mejor no ofrecer la foto que ofrecer una puerta que
  // cualquiera pueda falsificar.
  if (!id || !secret) return null;
  const payload = b64url(`${PREFIJO}${id}`);
  return `${payload}.${signPayload(secret, payload)}`;
}

export function verifyMediaToken(env, token) {
  const contenido = verifySignedPayload(secretFor(env), token);
  if (!contenido || !contenido.startsWith(PREFIJO)) return null;
  const id = contenido.slice(PREFIJO.length);
  // Los mensajes son uuid. Se comprueba la forma para no llevar cualquier cosa a la consulta.
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export function mediaUrl(env, messageId) {
  const token = mediaToken(env, messageId);
  return token ? `/chat/media/${token}` : null;
}
