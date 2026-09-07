/** Utilidades HTTP compartidas por las Edge Functions. */

const ORIGENES = (Deno.env.get('ORIGENES_PERMITIDOS') ?? '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

export function cabecerasCors(origen: string | null): Record<string, string> {
  const permitido =
    ORIGENES.includes('*') ? '*'
    : origen && ORIGENES.includes(origen) ? origen
    : ORIGENES[0] ?? '*'

  return {
    'Access-Control-Allow-Origin': permitido,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

export function respuesta(
  cuerpo: unknown,
  estado: number,
  origen: string | null,
): Response {
  return new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: { ...cabecerasCors(origen), 'Content-Type': 'application/json' },
  })
}

export function errorNegocio(
  mensaje: string,
  codigo: string,
  origen: string | null,
  estado = 400,
): Response {
  return respuesta({ ok: false, codigo_error: codigo, mensaje }, estado, origen)
}

/**
 * IP del cliente para el rate limiting. En Supabase el proxy la coloca en
 * `x-forwarded-for`; nos quedamos con la primera, que es la del cliente.
 */
export function ipCliente(peticion: Request): string {
  const reenviada = peticion.headers.get('x-forwarded-for')
  if (reenviada) return reenviada.split(',')[0]!.trim()
  return peticion.headers.get('cf-connecting-ip') ?? 'desconocida'
}
