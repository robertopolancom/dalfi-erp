// Resolución de solicitudes por la contadora.
//
// La autorización la hace Postgres: se llama a resolver_solicitud() con el JWT
// del usuario, de modo que `auth.uid()` y RLS siguen aplicando. Esta función
// existe para poder notificar al centro con el resultado.

import { clienteServicio, clienteUsuario } from '../_shared/db.ts'
import { errorNegocio, respuesta, cabecerasCors } from '../_shared/http.ts'
import { esquemaResolver, primerMensaje } from '../_shared/validacion.ts'
import { crearNotificador } from '../_shared/notifications/notificador.ts'

Deno.serve(async (peticion) => {
  const origen = peticion.headers.get('origin')

  if (peticion.method === 'OPTIONS') {
    return new Response('ok', { headers: cabecerasCors(origen) })
  }
  if (peticion.method !== 'POST') {
    return errorNegocio('Método no permitido.', 'METODO_NO_PERMITIDO', origen, 405)
  }

  const autorizacion = peticion.headers.get('Authorization')
  if (!autorizacion) {
    return errorNegocio('Falta la sesión.', 'NO_AUTORIZADO', origen, 401)
  }

  let cuerpo: unknown
  try {
    cuerpo = await peticion.json()
  } catch {
    return errorNegocio('El cuerpo de la petición no es JSON válido.', 'JSON_INVALIDO', origen)
  }

  const analisis = esquemaResolver.safeParse(cuerpo)
  if (!analisis.success) {
    return errorNegocio(primerMensaje(analisis.error), 'ENTRADA_INVALIDA', origen)
  }
  const entrada = analisis.data

  const comoUsuario = clienteUsuario(autorizacion)

  const { data: usuario } = await comoUsuario.auth.getUser()
  if (!usuario.user) {
    return errorNegocio('Sesión inválida o expirada.', 'NO_AUTORIZADO', origen, 401)
  }

  // Necesitamos el tipo y el destinatario para la plantilla; los leemos antes
  // de resolver porque después el estado ya habrá cambiado.
  const { data: previa } = await comoUsuario
    .from('solicitudes_cambio')
    .select('tipo, reserva_id, reservas(codigo_reserva, correo_contacto, centros(nombre))')
    .eq('id', entrada.solicitud_id)
    .single()

  const { data, error } = await comoUsuario.rpc('resolver_solicitud', {
    p_solicitud_id: entrada.solicitud_id,
    p_aprobar: entrada.aprobar,
    p_nota: entrada.nota ?? null,
  })

  if (error) {
    console.error('resolver_solicitud falló', error.message)
    return errorNegocio('No se pudo resolver la solicitud.', 'ERROR_INTERNO', origen, 500)
  }

  const resultado = data as {
    ok: boolean
    codigo_error?: string
    mensaje?: string
    accion?: 'aprobada' | 'rechazada'
    tipo?: 'cambio' | 'cancelacion'
    reserva_id?: string
    codigo_reserva?: string
    destinatario?: string
    fecha_inicio?: string
    fecha_fin?: string
  }

  if (!resultado.ok) {
    return errorNegocio(
      resultado.mensaje ?? 'No se pudo resolver la solicitud.',
      resultado.codigo_error ?? 'SOLICITUD_RECHAZADA',
      origen,
    )
  }

  const notificador = crearNotificador(clienteServicio())
  if (notificador && resultado.destinatario) {
    const relacion = previa as
      | { tipo?: 'cambio' | 'cancelacion'
          reservas?: { codigo_reserva?: string; correo_contacto?: string
                       centros?: { nombre?: string } | null } | null }
      | null

    // Al rechazar, la reserva no cambió, así que las fechas del resultado no
    // vienen; las tomamos de la reserva tal como quedó.
    const { data: reserva } = await comoUsuario
      .from('reservas')
      .select('fecha_inicio, fecha_fin')
      .eq('id', resultado.reserva_id ?? '')
      .single()

    await notificador.notificar(
      resultado.accion === 'aprobada' ? 'solicitud_aprobada' : 'solicitud_rechazada',
      resultado.destinatario,
      {
        centro: relacion?.reservas?.centros?.nombre ?? 'Tu centro',
        codigo_reserva: resultado.codigo_reserva ?? '',
        fecha_inicio: (reserva?.fecha_inicio as string) ?? resultado.fecha_inicio ?? '',
        fecha_fin: (reserva?.fecha_fin as string) ?? resultado.fecha_fin ?? '',
        tipo_solicitud: resultado.tipo ?? relacion?.tipo,
        nota: entrada.nota ?? undefined,
      },
      { reservaId: resultado.reserva_id },
    )
  }

  return respuesta({ ok: true, accion: resultado.accion }, 200, origen)
})
