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
 * IP real del visitante, para agrupar el rate limiting.
 *
 * Con Cloudflare delante de Render hay DOS saltos de proxy, no uno:
 *
 *     visitante -> Cloudflare -> proxy de Render -> esta app
 *
 * Cloudflare manda `X-Forwarded-For: <visitante>` y el proxy de Render le
 * añade la IP de Cloudflare, así que la cabecera llega como
 * `<visitante>, <cloudflare>`. Con `trust proxy` en 1, Express se queda con la
 * penúltima entrada, que es la de Cloudflare: TODO el tráfico del mundo caería
 * en la misma clave y el límite de 8 reservas por 10 minutos dejaría fuera a
 * los centros legítimos en cuanto entrara el noveno.
 *
 * Por eso, cuando la app está detrás de Cloudflare, se usa `CF-Connecting-IP`,
 * que Cloudflare fija siempre con la IP real y sobrescribe si el cliente
 * intenta enviarla él.
 *
 * Riesgo residual, dicho claramente: la URL de Render (`*.onrender.com`) sigue
 * siendo alcanzable, y quien la llame directamente puede inventarse esa
 * cabecera y saltarse el límite. Por eso el flag es explícito y no se deduce
 * de la presencia de la cabecera. El daño posible se limita a saturar el
 * formulario público: las reglas de negocio viven en SQL, así que ni con eso
 * se puede sobrevender un cupo ni reservar dos veces con el mismo centro.
 * Para cerrarlo del todo hay que restringir el servicio de Render a los rangos
 * de Cloudflare; el README explica cómo.
 */
export function ipCliente(peticion: Request): string {
  if (process.env['DETRAS_DE_CLOUDFLARE'] === '1') {
    const deCloudflare = peticion.get('cf-connecting-ip')
    if (deCloudflare) return deCloudflare.trim()
  }
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
