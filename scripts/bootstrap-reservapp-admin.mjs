#!/usr/bin/env node
// Crea la primera cuenta superadministrador de ReservApp. POST /api/reservapp/admin/accounts
// exige ya tener una sesión administradora/superadministrador (o un admin ERP con
// canManageUsers, que nunca puede crear un superadministrador) — no hay forma de arrancar la
// primera cuenta desde la API pública, a propósito, para no exponer ese bootstrap por HTTP.
// Este script requiere acceso directo a DATABASE_URL (el mismo nivel de confianza que correr
// una migración a mano) y nunca sobreescribe una cuenta existente sin --force.
//
// Uso:
//   DATABASE_URL=postgres://... node scripts/bootstrap-reservapp-admin.mjs \
//     --staff-id <uuid-de-app.staff> --phone 8095551234 [--password 'Clave-Segura-1'] [--force]
//
// Si no se pasa --password, se genera una temporal aleatoria y se imprime UNA sola vez —
// cámbiala apenas inicies sesión.
import crypto from "node:crypto";
import pg from "pg";
import { hashPassword } from "../server/reservapp-auth.mjs";

function parseArgs(argv) {
  const args = { force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--staff-id") args.staffId = argv[++i];
    else if (value === "--phone") args.phone = argv[++i];
    else if (value === "--password") args.password = argv[++i];
    else if (value === "--force") args.force = true;
  }
  return args;
}

function normalizePhoneDigits(phone) {
  const digits = String(phone || "").replace(/[^0-9]/g, "");
  if (digits.length === 10) return `1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return digits;
  throw new Error(`Teléfono inválido: ${phone}`);
}

async function main() {
  const { staffId, phone, password, force } = parseArgs(process.argv.slice(2));
  if (!staffId || !phone) {
    console.error("Uso: node scripts/bootstrap-reservapp-admin.mjs --staff-id <uuid> --phone <telefono> [--password '...'] [--force]");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL es obligatoria.");

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const staff = await pool.query("select id, full_name, status from app.staff where id = $1", [staffId]);
    if (!staff.rowCount) throw new Error(`No existe app.staff.id = ${staffId}. Créala primero en el ERP.`);

    const phoneNormalized = normalizePhoneDigits(phone);
    const existing = await pool.query(
      "select id, role, status from app.reservapp_accounts where staff_id = $1 or phone_normalized = $2",
      [staffId, phoneNormalized],
    );
    if (existing.rowCount && !force) {
      throw new Error(`Ya existe una cuenta ReservApp para esa colaboradora/teléfono (id=${existing.rows[0].id}, role=${existing.rows[0].role}). Usa --force para reemplazar su contraseña y rol.`);
    }

    const finalPassword = password || crypto.randomBytes(9).toString("base64url");
    const passwordHash = await hashPassword(finalPassword);

    let account;
    if (existing.rowCount) {
      const updated = await pool.query(
        `update app.reservapp_accounts
           set role = 'superadministrador', password_hash = $1, status = 'active', updated_at = now()
         where id = $2
         returning id, phone_normalized, role, status`,
        [passwordHash, existing.rows[0].id],
      );
      account = updated.rows[0];
    } else {
      const inserted = await pool.query(
        `insert into app.reservapp_accounts (phone_normalized, staff_id, role, password_hash, status)
         values ($1, $2, 'superadministrador', $3, 'active')
         returning id, phone_normalized, role, status`,
        [phoneNormalized, staffId, passwordHash],
      );
      account = inserted.rows[0];
    }

    console.log(`Cuenta superadministrador lista: id=${account.id} phone=${account.phone_normalized} status=${account.status}`);
    if (!password) console.log(`Contraseña temporal (guárdala, no se vuelve a mostrar): ${finalPassword}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
