import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { hashPassword, hashToken, normalizePhone, verifyPassword } from "../server/reservapp-auth.mjs";

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("ReservApp protege contraseñas y normaliza teléfonos dominicanos", async () => {
  const encoded = await hashPassword("Dalfi2026Segura");
  assert.match(encoded, /^scrypt\$/);
  assert.equal(await verifyPassword("Dalfi2026Segura", encoded), true);
  assert.equal(await verifyPassword("incorrecta", encoded), false);
  assert.equal(normalizePhone("(809) 555-1212"), "18095551212");
  assert.equal(hashToken("token"), hashToken("token"));
});

test("la migración de ReservApp define roles, sesiones, activación y borradores", () => {
  const migration = read("neon/migrations/0010_reservapp_identity_agenda.sql");
  // 0010 se queda tal como se aplicó en su día: nombraba el rol "clienta". Quien lo renombra a
  // "cliente" es 0016 -- una migración ya aplicada nunca se reescribe hacia atrás.
  for (const role of ["clienta", "manicurista", "asistente", "administradora", "superadministrador"]) assert.match(migration, new RegExp(role));
  assert.match(migration, /reservapp_sessions/);
  assert.match(migration, /reservapp_setup_tokens/);
  assert.match(migration, /reservapp_booking_drafts/);
  assert.match(migration, /reservapp_whatsapp_outbox/);
});

test("0016 renombra el rol clienta a cliente sin dejar el valor viejo en el CHECK", () => {
  const migration = read("neon/migrations/0016_client_soft_delete_and_cliente_role.sql");
  assert.match(migration, /update app\.reservapp_accounts set role = 'cliente'.*where role = 'clienta'/s);
  assert.match(migration, /check \(role in \('cliente','manicurista','asistente','administradora','superadministrador'\)\)/);
  // El CHECK de coherencia rol/dueño (0010) también nombraba el rol, así que se recrea igual.
  assert.match(migration, /role = 'cliente' and client_id is not null and staff_id is null/);
  assert.doesNotMatch(migration.split("-- 2. Borrado lógico")[1], /clienta/);
});

test("0016 deja registrarse de nuevo a un cliente borrado: la unicidad de correo ignora las fichas borradas", () => {
  const migration = read("neon/migrations/0016_client_soft_delete_and_cliente_role.sql");
  assert.match(migration, /drop index if exists app\.clients_email_unique/);
  assert.match(migration, /create unique index if not exists clients_email_unique[\s\S]*status <> 'deleted'/);
});

test("la PWA permite varios servicios y agenda sin depender de Supabase", () => {
  const html = read("outputs/reservar/index.html");
  const app = read("outputs/reservar/app.js");
  const config = read("outputs/reservar/config.js");
  assert.match(html, /Es mi primera vez/);
  assert.match(html, /name="service"|service-list/);
  assert.match(html, /agenda-board/);
  assert.match(app, /selectedServiceIds/);
  assert.match(app, /serviceIds/);
  assert.match(app, /api\/reservapp\/agenda/);
  assert.doesNotMatch(html + config, /supabase/i);
});

test("la PWA activa la cuenta en dos pasos (código de WhatsApp, luego contraseña), no con enlace mágico en la URL", () => {
  const html = read("outputs/reservar/index.html");
  const app = read("outputs/reservar/app.js");
  assert.match(html, /verify-code-dialog/);
  assert.match(html, /verify-code-code/);
  assert.match(app, /api\/reservapp\/setup\/verify-code/);
  assert.match(app, /state\.activationTicket/);
  assert.doesNotMatch(app, /URLSearchParams\(location\.search\)\.get\("setup"\)/);
});

test("la API exige credenciales para confirmar citas de clientes", () => {
  const source = read("server/app.mjs");
  assert.match(source, /Inicia sesión con tu teléfono y contraseña para reservar/);
  assert.match(source, /Access-Control-Allow-Credentials/);
  assert.match(source, /reservapp\.account_setup/);
});
