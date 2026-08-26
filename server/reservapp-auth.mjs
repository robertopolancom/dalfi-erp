import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;

export const RESERVAPP_ROLES = Object.freeze([
  "cliente",
  "manicurista",
  "asistente",
  "administradora",
  "superadministrador",
]);

export function normalizePhone(value) {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  return digits.length === 10 ? `1${digits}` : digits;
}

export function secureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

// Código corto de 6 dígitos para el relay de manicurista (ver reservapp_relay_otps).
// crypto.randomInt es criptográficamente seguro y no tiene el sesgo de módulo
// de Math.random() -- no reutilizar Math.random() para esto.
export function generateOtpCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashToken(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(String(password), salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, saltText, hashText] = String(encoded || "").split("$");
  if (algorithm !== "scrypt" || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64url");
  const derived = Buffer.from(await scrypt(String(password), Buffer.from(saltText, "base64url"), expected.length));
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

export function parseCookies(header) {
  return Object.fromEntries(String(header || "").split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

export function sessionCookie(token, maxAgeSeconds) {
  return [
    `reservapp_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].join("; ");
}

export function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    role: account.role,
    name: account.full_name || "Usuario",
    phone: account.phone_normalized,
    clientId: account.client_id || null,
    staffId: account.staff_id || null,
  };
}
