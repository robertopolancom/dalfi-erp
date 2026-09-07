/**
 * Crea o actualiza una cuenta de administrador.
 *
 *   DATABASE_URL=... npm run admin:crear -- contadora@dominio.do "Nombre" "contraseña"
 *
 * La contraseña se pasa como argumento a propósito: así no queda en un archivo.
 * Ejecútalo desde una shell donde el historial no se guarde, o cámbiala después
 * desde el propio script. Nunca se guarda en claro: solo el hash scrypt.
 */
import { crearPool, consultar, obtenerPool } from '../server/db.ts'
import { hashearClave } from '../server/auth.ts'

const [correo, nombre, clave] = process.argv.slice(2)

if (!correo || !nombre || !clave) {
  console.error('Uso: npm run admin:crear -- <correo> <nombre> <contraseña>')
  process.exit(1)
}

if (clave.length < 12) {
  console.error('La contraseña debe tener al menos 12 caracteres.')
  process.exit(1)
}

crearPool()

const hash = await hashearClave(clave)

await consultar(
  `insert into administradores (correo, nombre, hash_clave)
   values ($1, $2, $3)
   on conflict (correo) do update
     set nombre = excluded.nombre, hash_clave = excluded.hash_clave, activo = true`,
  [correo.trim().toLowerCase(), nombre.trim(), hash],
)

console.log(`Cuenta lista para ${correo}.`)
await obtenerPool().end()
