// Aplica un archivo de neon/migrations contra la base, leyendo la conexión por la entrada estándar
// para que nunca quede en un archivo, en el historial de la terminal ni en pantalla:
//
//   pbpaste | node scripts/aplicar-migracion.mjs neon/migrations/0032_ecf_documentos.sql
//
// (Copia antes el DATABASE_URL de Cloud Run, servicio dalfi-erp.) Todo el archivo corre en UNA
// transacción: o entra completo o no entra nada. Las migraciones de este repo son idempotentes
// ("if not exists"), así que correrla dos veces no rompe nada.
import { readFileSync } from "node:fs";
import pg from "pg";

const archivo = process.argv[2];
if (!archivo || !/^neon\/migrations\/\d{4}_[\w-]+\.sql$/.test(archivo)) {
  console.error("Uso: pbpaste | node scripts/aplicar-migracion.mjs neon/migrations/NNNN_nombre.sql");
  process.exit(1);
}
const sql = readFileSync(archivo, "utf8");

let entrada = "";
for await (const trozo of process.stdin) entrada += trozo;
const conexion = entrada.trim();
if (!/^postgres(ql)?:\/\//.test(conexion)) {
  console.error("No llegó una conexión postgres:// por la entrada. ¿Copiaste el DATABASE_URL?");
  process.exit(1);
}

const client = new pg.Client({ connectionString: conexion, ssl: { rejectUnauthorized: true } });
await client.connect();
try {
  const { rows } = await client.query("select current_database() as base, (select count(*) from information_schema.schemata where schema_name = 'app') as esquema_app");
  if (Number(rows[0].esquema_app) !== 1) throw new Error(`La base "${rows[0].base}" no tiene el esquema app: ¿es la rama correcta (migration-staging)?`);
  await client.query("begin");
  await client.query(sql);
  await client.query("commit");
  console.log(`Aplicada ${archivo} en la base "${rows[0].base}".`);
  const tablas = await client.query(
    "select table_name from information_schema.tables where table_schema = 'app' and table_name like 'ecf_%' order by 1",
  );
  if (tablas.rowCount) console.log(`Tablas e-CF: ${tablas.rows.map((r) => r.table_name).join(", ")}`);
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error(`No se aplicó (se deshizo todo): ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
