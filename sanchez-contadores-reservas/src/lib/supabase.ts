import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'Faltan VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY. Copia .env.example a .env.local.',
  )
}

/**
 * La clave `anon` es pública por diseño: viaja en el bundle del navegador. Lo
 * que protege los datos es Row Level Security, no el secreto de esta clave.
 * La `service_role` NUNCA aparece aquí; vive solo en las Edge Functions.
 */
export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
})

export const URL_FUNCIONES = `${url.replace(/\/$/, '')}/functions/v1`

/**
 * Llama a una Edge Function y normaliza la respuesta de negocio.
 *
 * Con `conSesion` se envía el JWT de la contadora en vez de la clave anon, de
 * modo que la función puede actuar en su nombre y Postgres siga aplicando RLS
 * y `auth.uid()`.
 */
export async function invocarFuncion<T>(
  nombre: string,
  cuerpo: unknown,
  opciones: { conSesion?: boolean } = {},
): Promise<{ ok: true; datos: T } | { ok: false; mensaje: string; codigo?: string }> {
  try {
    let credencial = anonKey
    if (opciones.conSesion) {
      const { data } = await supabase.auth.getSession()
      if (!data.session) return { ok: false, mensaje: 'Tu sesión expiró. Entra de nuevo.' }
      credencial = data.session.access_token
    }

    const respuesta = await fetch(`${URL_FUNCIONES}/${nombre}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${credencial}`,
      },
      body: JSON.stringify(cuerpo),
    })

    const json: unknown = await respuesta.json().catch(() => null)
    const datos = (json ?? {}) as Record<string, unknown>

    if (!respuesta.ok || datos['ok'] !== true) {
      return {
        ok: false,
        mensaje: typeof datos['mensaje'] === 'string'
          ? datos['mensaje']
          : 'No pudimos completar la operación. Intenta de nuevo.',
        ...(typeof datos['codigo_error'] === 'string' ? { codigo: datos['codigo_error'] } : {}),
      }
    }

    return { ok: true, datos: datos as T }
  } catch {
    return { ok: false, mensaje: 'No hay conexión con el servidor. Revisa tu internet.' }
  }
}
