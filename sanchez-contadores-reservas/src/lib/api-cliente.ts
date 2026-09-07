/**
 * Cliente HTTP de la API.
 *
 * El frontend y la API se sirven desde el mismo origen (el servicio de Render
 * sirve el `dist/` compilado), así que las rutas son relativas: no hay CORS ni
 * URLs de API en variables de entorno.
 *
 * La sesión de la contadora viaja en una cookie httpOnly. El navegador la envía
 * sola con `credentials: 'same-origin'`; JavaScript nunca ve el token, así que
 * un XSS no puede robarlo.
 */

export interface FalloApi {
  mensaje: string
  codigo?: string
  estado: number
}

export class ErrorApi extends Error {
  readonly codigo?: string
  readonly estado: number

  constructor(fallo: FalloApi) {
    // El texto vive en `message`, heredado de Error, para que un `catch` normal
    // lo muestre sin conocer este tipo.
    super(fallo.mensaje)
    this.name = 'ErrorApi'
    this.estado = fallo.estado
    if (fallo.codigo !== undefined) this.codigo = fallo.codigo
  }
}

async function peticion<T>(
  ruta: string,
  opciones: { metodo?: string; cuerpo?: unknown } = {},
): Promise<T> {
  let respuesta: Response
  try {
    respuesta = await fetch(`/api${ruta}`, {
      method: opciones.metodo ?? 'GET',
      credentials: 'same-origin',
      headers: opciones.cuerpo === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(opciones.cuerpo === undefined ? {} : { body: JSON.stringify(opciones.cuerpo) }),
    })
  } catch {
    throw new ErrorApi({ mensaje: 'No hay conexión con el servidor. Revisa tu internet.', estado: 0 })
  }

  if (respuesta.status === 204) return undefined as T

  const json: unknown = await respuesta.json().catch(() => null)

  if (!respuesta.ok) {
    const datos = (json ?? {}) as Record<string, unknown>
    throw new ErrorApi({
      mensaje: typeof datos['mensaje'] === 'string'
        ? datos['mensaje']
        : 'No pudimos completar la operación. Intenta de nuevo.',
      estado: respuesta.status,
      ...(typeof datos['codigo_error'] === 'string' ? { codigo: datos['codigo_error'] } : {}),
    })
  }

  return json as T
}

export const obtener = <T>(ruta: string) => peticion<T>(ruta)
export const enviar = <T>(ruta: string, cuerpo: unknown) =>
  peticion<T>(ruta, { metodo: 'POST', cuerpo })
export const modificar = <T>(ruta: string, cuerpo: unknown) =>
  peticion<T>(ruta, { metodo: 'PATCH', cuerpo })
export const reemplazar = <T>(ruta: string, cuerpo: unknown) =>
  peticion<T>(ruta, { metodo: 'PUT', cuerpo })
export const borrar = <T>(ruta: string) => peticion<T>(ruta, { metodo: 'DELETE' })

/**
 * Envoltorio para operaciones donde el error se muestra en pantalla en vez de
 * romper el flujo: devuelve un resultado en lugar de lanzar.
 */
export async function intentar<T>(
  operacion: () => Promise<T>,
): Promise<{ ok: true; datos: T } | { ok: false; mensaje: string; codigo?: string }> {
  try {
    return { ok: true, datos: await operacion() }
  } catch (e) {
    if (e instanceof ErrorApi) {
      return { ok: false, mensaje: e.message, ...(e.codigo ? { codigo: e.codigo } : {}) }
    }
    return { ok: false, mensaje: 'Ocurrió un error inesperado.' }
  }
}
