import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createApp } from "./app.mjs";
import { NeonDocumentStore } from "./store.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL es obligatoria.");
for (const name of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!process.env[name]) throw new Error(`${name} es obligatoria durante la transicion de autenticacion.`);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined,
});
pool.on("error", (error) => console.error("postgres pool:", error));

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const app = createApp({ store: new NeonDocumentStore(pool), staticDir: path.resolve(currentDir, "../outputs") });
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, "0.0.0.0", () => console.log(`Dalfi ERP escuchando en puerto ${port}.`));

async function shutdown(signal) {
  console.log(`${signal}: cerrando servidor.`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
