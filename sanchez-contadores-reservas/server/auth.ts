import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { consultar, consultarUna } from './db.ts'

const scrypt = promisify(crypto.scrypt) as (
  clave: string, sal: Buffer, largo: number,
) => Promise<Buffer>

const LARGO_CLAVE = 64
const DIAS_SESION = 14

export interface Administrador {
  id: string
  correo: string
  nombre: string
}

/** Hash `scrypt$<sal hex>$<derivada hex>`. Nunca se guarda la contraseña. */
export async function hashearClave(clave: string): Promise<string> {
  const sal = crypto.randomBytes(16)
  const derivada = await scrypt(clave, sal, LARGO_CLAVE)
  return `scrypt$${sal.toString('hex')}$${derivada.toString('hex')}`
}

/** Comparación en tiempo constante: no filtra información por el tiempo. */
export async function claveCoincide(clave: string, hash: string): Promise<boolean> {
  const partes = hash.split('$')
  if (partes.length !== 3 || partes[0] !== 'scrypt') return false

  const sal = Buffer.from(partes[1]!, 'hex')
  const esperada = Buffer.from(partes[2]!, 'hex')
  if (sal.length === 0 || esperada.length !== LARGO_CLAVE) return false

  const derivada = await scrypt(clave, sal, LARGO_CLAVE)
  return crypto.timingSafeEqual(derivada, esperada)
}

export function tokenSeguro(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

/** Solo el hash del token toca la base; el original vive en la cookie. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export async function iniciarSesion(
  correo: string,
  clave: string,
  ip: string,
): Promise<{ token: string; expira: Date; admin: Administrador } | null> {
  const fila = await consultarUna<{
    id: string; correo: string; nombre: string; hash_clave: string
  }>(
    'select id, correo, nombre, hash_clave from administradores where lower(correo) = lower($1) and activo',
    [correo.trim()],
  )

  // Cuando el correo no existe seguimos gastando el mismo tiempo en un hash
  // falso, para que la respuesta no delate qué cuentas existen.
  const hash = fila?.hash_clave ?? `scrypt$${'00'.repeat(16)}$${'00'.repeat(LARGO_CLAVE)}`
  const coincide = await claveCoincide(clave, hash)
  if (!fila || !coincide) return null

  const token = tokenSeguro()
  const expira = new Date(Date.now() + DIAS_SESION * 86_400_000)

  await consultar(
    'insert into sesiones (hash_token, admin_id, expira_en, ultima_ip) values ($1, $2, $3, $4)',
    [hashToken(token), fila.id, expira, ip],
  )
  await consultar('update administradores set ultimo_acceso = now() where id = $1', [fila.id])

  return { token, expira, admin: { id: fila.id, correo: fila.correo, nombre: fila.nombre } }
}

export async function administradorDeSesion(token: string | null): Promise<Administrador | null> {
  if (!token) return null

  const fila = await consultarUna<{ id: string; correo: string; nombre: string }>(
    `select a.id, a.correo, a.nombre
       from sesiones s
       join administradores a on a.id = s.admin_id
      where s.hash_token = $1 and s.expira_en > now() and a.activo`,
    [hashToken(token)],
  )
  return fila
}

export async function cerrarSesion(token: string | null): Promise<void> {
  if (!token) return
  await consultar('delete from sesiones where hash_token = $1', [hashToken(token)])
}

/** Se llama desde el cron diario, junto con la purga del rate limit. */
export async function purgarSesiones(): Promise<void> {
  await consultar('delete from sesiones where expira_en < now()')
}
