// Validación de imágenes que llegan en base64 (comprobante de depósito del cliente, fotos del sitio).
//
// Hasta el 2026-09-18 solo se miraba el tipo que DECLARABA el navegador. El contenido se guardaba
// tal cual y el ERP lo pegaba dentro de un <img src="data:...;base64,<aquí>"> con innerHTML: un
// cliente con cuenta podía mandar texto con comillas en vez de una imagen y meter HTML en la
// pantalla del personal. La CSP (script-src 'self') impedía ejecutar código, pero no el contenido
// falso. Ahora el base64 tiene que ser base64 de verdad, y los primeros bytes tienen que ser los
// de una imagen del tipo declarado.

const FIRMAS = {
  "image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
};

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function validarImagenBase64(imageBase64, mimeType, { maxBytes }) {
  const texto = String(imageBase64 || "");
  const tipo = String(mimeType || "");
  const firma = FIRMAS[tipo];
  if (!firma) return { ok: false, status: 400, error: "La imagen debe ser JPEG, PNG o WebP." };
  if (!texto) return { ok: false, status: 400, error: "Falta la imagen." };
  if (texto.length % 4 !== 0 || !BASE64.test(texto)) return { ok: false, status: 400, error: "La imagen llegó dañada. Vuelve a intentarlo." };
  const bytes = Buffer.from(texto, "base64");
  if (bytes.length > maxBytes) {
    return { ok: false, status: 413, error: `La imagen pesa ${(bytes.length / 1024 / 1024).toFixed(1)} MB y el máximo son ${Math.round(maxBytes / 1024 / 1024)} MB.` };
  }
  if (!firma(bytes)) return { ok: false, status: 400, error: "El archivo no es una imagen válida." };
  return { ok: true, bytes: bytes.length };
}
