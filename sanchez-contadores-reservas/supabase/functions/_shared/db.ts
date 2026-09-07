import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Cliente con `service_role`: ignora RLS. Solo se usa dentro de Edge Functions,
 * nunca en el navegador. La clave la inyecta Supabase automáticamente.
 */
export function clienteServicio(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')
  const clave = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !clave) throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY')
  return createClient(url, clave, { auth: { persistSession: false } })
}

/**
 * Cliente que actúa en nombre del usuario que llamó, propagando su JWT. Sirve
 * para que las funciones administrativas sigan sujetas a RLS y a `auth.uid()`.
 */
export function clienteUsuario(autorizacion: string): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')
  const anon = Deno.env.get('SUPABASE_ANON_KEY')
  if (!url || !anon) throw new Error('Faltan SUPABASE_URL o SUPABASE_ANON_KEY')
  return createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: autorizacion } },
  })
}

/** Rate limiting por ventana fija. `true` si la petición cabe. */
export async function dentroDelLimite(
  db: SupabaseClient,
  clave: string,
  limite: number,
  ventanaSegundos: number,
): Promise<boolean> {
  const { data, error } = await db.rpc('consumir_rate_limit', {
    p_clave: clave,
    p_limite: limite,
    p_ventana_segundos: ventanaSegundos,
  })
  // Ante un fallo del contador dejamos pasar la petición: es preferible a
  // dejar el formulario público inutilizable, y las reglas de negocio siguen
  // protegiendo la base de datos.
  if (error) {
    console.error('rate limit falló', error.message)
    return true
  }
  return data === true
}
