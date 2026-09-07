import pg from 'pg'

/**
 * Una columna `date` de Postgres (OID 1082) llega por defecto como `Date` de
 * JavaScript, y `JSON.stringify` la convierte en un instante UTC
 * ("2027-02-01T00:00:00.000Z"). Todo el dominio trabaja con días de calendario
 * en formato 'YYYY-MM-DD' y los compara como cadenas, así que la dejamos tal
 * cual viene de la base. Sin esto el calendario se desalinea entero.
 */
pg.types.setTypeParser(1082, (valor: string) => valor)

/**
 * Pool de conexiones a Neon. `DATABASE_URL` es el secreto más sensible del
 * sistema: nunca sale del servidor, no viaja al navegador ni se registra.
 */
let pool: pg.Pool | null = null

export function crearPool(): pg.Pool {
  const cadena = process.env['DATABASE_URL']
  if (!cadena) throw new Error('DATABASE_URL es obligatoria.')

  const creado = new pg.Pool({
    connectionString: cadena,
    max: Number(process.env['PG_POOL_MAX'] ?? 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Neon exige TLS. En local (Postgres sin certificado) se desactiva solo
    // cuando NODE_ENV no es production.
    ssl: process.env['NODE_ENV'] === 'production' ? { rejectUnauthorized: true } : undefined,
  })

  creado.on('error', (error) => console.error('pool de postgres:', error.message))
  pool = creado
  return creado
}

export function obtenerPool(): pg.Pool {
  if (!pool) throw new Error('El pool no se ha inicializado.')
  return pool
}

/** Consulta simple. Devuelve solo las filas. */
export async function consultar<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  valores: readonly unknown[] = [],
): Promise<T[]> {
  const resultado = await obtenerPool().query<T>(sql, valores as unknown[])
  return resultado.rows
}

/** Consulta que devuelve como mucho una fila. */
export async function consultarUna<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  valores: readonly unknown[] = [],
): Promise<T | null> {
  const filas = await consultar<T>(sql, valores)
  return filas[0] ?? null
}

/**
 * Llama a una función SQL que devuelve jsonb y entrega el objeto ya tipado.
 * Las funciones de negocio (`crear_reserva`, `crear_solicitud`,
 * `resolver_solicitud`) devuelven siempre `{ ok, ... }`.
 */
export async function llamarFuncion<T>(
  nombre: string,
  argumentos: readonly unknown[],
): Promise<T> {
  const marcadores = argumentos.map((_, i) => `$${i + 1}`).join(', ')
  const filas = await consultar<{ resultado: T }>(
    `select ${nombre}(${marcadores}) as resultado`,
    argumentos,
  )
  return filas[0]!.resultado
}

/** Rate limiting por ventana fija. `true` si la petición cabe. */
export async function dentroDelLimite(
  clave: string,
  limite: number,
  ventanaSegundos: number,
): Promise<boolean> {
  try {
    const fila = await consultarUna<{ permitido: boolean }>(
      'select consumir_rate_limit($1, $2, $3) as permitido',
      [clave, limite, ventanaSegundos],
    )
    return fila?.permitido !== false
  } catch (error) {
    // Ante un fallo del contador dejamos pasar: es preferible a dejar el
    // formulario público inutilizable, y las reglas de negocio siguen
    // protegiendo la base.
    console.error('rate limit falló:', error instanceof Error ? error.message : error)
    return true
  }
}
