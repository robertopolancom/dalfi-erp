import type { Request, Response } from 'express'

export const NOMBRE_COOKIE = 'scr_sesion'

/** Lee una cookie sin dependencias extra. */
export function leerCookie(peticion: Request, nombre: string): string | null {
  const cabecera = peticion.headers.cookie
  if (!cabecera) return null

  for (const parte of cabecera.split(';')) {
    const separador = parte.indexOf('=')
    if (separador === -1) continue
    if (parte.slice(0, separador).trim() === nombre) {
      return decodeURIComponent(parte.slice(separador + 1).trim())
    }
  }
  return null
}

export function ponerCookieSesion(respuesta: Response, token: string, expira: Date): void {
  respuesta.cookie(NOMBRE_COOKIE, token, {
    httpOnly: true,                                    // inaccesible desde JavaScript
    secure: process.env['NODE_ENV'] === 'production',  // solo por HTTPS en producción
    sameSite: 'lax',                                   // corta el CSRF entre sitios
    expires: expira,
    path: '/',
  })
}

export function borrarCookieSesion(respuesta: Response): void {
  respuesta.clearCookie(NOMBRE_COOKIE, { path: '/' })
}

export function error(
  respuesta: Response,
  estado: number,
  mensaje: string,
  codigo: string,
): void {
  respuesta.status(estado).json({ ok: false, codigo_error: codigo, mensaje })
}

/**
 * IP del cliente para el rate limiting. Render pone la del cliente primero en
 * `x-forwarded-for`; con `trust proxy` activo, Express ya la resuelve en `req.ip`.
 */
export function ipCliente(peticion: Request): string {
  return peticion.ip ?? 'desconocida'
}

/** Resultado estándar de las funciones de negocio en SQL. */
export interface ResultadoNegocio {
  ok: boolean
  codigo_error?: string
  mensaje?: string
}

/** Traduce un `{ ok: false }` de SQL a una respuesta HTTP. */
export function responderNegocio(
  respuesta: Response,
  resultado: ResultadoNegocio,
  cuerpoOk: unknown,
  estadoOk = 200,
): void {
  if (!resultado.ok) {
    error(
      respuesta,
      400,
      resultado.mensaje ?? 'No se pudo completar la operación.',
      resultado.codigo_error ?? 'OPERACION_RECHAZADA',
    )
    return
  }
  respuesta.status(estadoOk).json(cuerpoOk)
}
