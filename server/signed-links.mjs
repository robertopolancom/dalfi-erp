// Firma de enlaces públicos: los que alguien abre sin haber iniciado sesión.
//
// Existía ya para las facturas (server/invoice-link.mjs) y ahora hace falta también para los
// adjuntos del chat, así que la parte criptográfica vive aquí una sola vez. Duplicarla sería
// pedir una divergencia: basta con que alguien ajuste el recorte de la firma en una copia para
// que los enlaces de la otra dejen de validar, y el fallo aparecería como "el enlace caducó".
//
// Qué protege esto y qué no. El token no se puede fabricar ni alterar sin el secreto, así que
// nadie puede pedir el adjunto de otra persona cambiando un número en la URL. Pero quien TENGA
// el enlace lo abre: es un enlace público a propósito, porque una etiqueta <img> del navegador
// no manda cabeceras de sesión y el personal necesita poder reenviarlo. Lo que limita la
// exposición es que el contenido se purgue -- ver la purga de adjuntos en server/store.mjs.

import { createHmac, timingSafeEqual } from "node:crypto";

export function b64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64").toString("utf8");
}

// 43 caracteres: la firma completa en base64url sin relleno. Se recorta ahí porque es donde
// termina el digest de SHA-256, no por capricho de longitud.
export function signPayload(secret, payload) {
  return b64url(createHmac("sha256", secret).update(payload).digest()).slice(0, 43);
}

// Devuelve el contenido firmado, o null si la firma no cuadra.
export function verifySignedPayload(secret, token) {
  if (!secret) return null;
  const raw = String(token || "");
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);
  const expected = signPayload(secret, payload);
  // Comparación en tiempo constante: no filtrar cuántos caracteres acertó quien prueba tokens.
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return null;
  try {
    return fromB64url(payload);
  } catch {
    return null;
  }
}
