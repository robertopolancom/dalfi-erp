// Diagnóstico de los códigos de WhatsApp de ReservApp (registro y cambio de contraseña).
// SOLO LECTURA: la transacción se abre READ ONLY, no puede cambiar nada.
//
//   pbpaste | node scripts/diagnostico-codigos.mjs
//
// (Con el DATABASE_URL de Cloud Run, servicio dalfi-erp, copiado.) Los teléfonos salen enmascarados.
import pg from "pg";

let entrada = "";
for await (const trozo of process.stdin) entrada += trozo;
const conexion = entrada.trim();
if (!/^postgres(ql)?:\/\//.test(conexion)) {
  console.error("No llegó una conexión postgres:// por la entrada. ¿Copiaste el DATABASE_URL?");
  process.exit(1);
}
const client = new pg.Client({ connectionString: conexion, ssl: { rejectUnauthorized: true } });
await client.connect();
const enmascarar = (tel) => { const d = String(tel || "").replace(/\D/g, ""); return d ? `***${d.slice(-4)}` : "-"; };
try {
  await client.query("begin transaction read only");
  const envios = await client.query(`
    select to_char(created_at at time zone 'America/Santo_Domingo','YYYY-MM-DD HH24:MI') as hora,
           event_type, status, attempt_count, recipient_phone,
           left(coalesce(last_error,''), 220) as error,
           case when account_id is null then 'registro nuevo' else 'cuenta existente' end as tipo
      from app.reservapp_whatsapp_outbox
     where event_type like 'reservapp.%'
     order by created_at desc limit 40`);
  console.log("\n== Últimos envíos de código (más reciente arriba) ==");
  for (const r of envios.rows) {
    console.log(`${r.hora}  ${r.status.padEnd(9)} intentos=${r.attempt_count}  ${enmascarar(r.recipient_phone)}  ${r.tipo}${r.error ? `\n      error: ${r.error}` : ""}`);
  }
  const resumen = await client.query(`
    select date(created_at at time zone 'America/Santo_Domingo') as dia, status, count(*)::int as n
      from app.reservapp_whatsapp_outbox
     where event_type like 'reservapp.%' and created_at > now() - interval '10 days'
     group by 1,2 order by 1 desc, 2`);
  console.log("\n== Por día (últimos 10 días) ==");
  for (const r of resumen.rows) console.log(`${r.dia.toISOString().slice(0, 10)}  ${r.status.padEnd(9)} ${r.n}`);
  const registros = await client.query(`
    select count(*)::int as pedidos,
           count(*) filter (where otp_verified_at is not null)::int as verificados,
           count(*) filter (where consumed_at is not null and otp_verified_at is not null)::int as completados
      from app.reservapp_pending_registrations where created_at > now() - interval '3 days'`);
  const g = registros.rows[0];
  console.log(`\n== Registros nuevos (últimos 3 días) ==\npidieron código: ${g.pedidos} · escribieron el código bien: ${g.verificados} · terminaron la cuenta: ${g.completados}`);
  await client.query("rollback");
} finally {
  await client.end();
}
