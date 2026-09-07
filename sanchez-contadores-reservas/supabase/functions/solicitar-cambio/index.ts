// Endpoint público de solicitud de cambio o cancelación.
//
// Nada de la reserva se modifica aquí: solo se registra la solicitud para que
// la contadora la resuelva desde el panel.

import { clienteServicio, dentroDelLimite } from '../_shared/db.ts'
import { errorNegocio, ipCliente, respuesta, cabecerasCors } from '../_shared/http.ts'
import { esquemaSolicitud, primerMensaje } from '../_shared/validacion.ts'
import { correoContadora, crearNotificador } from '../_shared/notifications/notificador.ts'

const LIMITE_POR_IP = 10
const VENTANA_SEGUNDOS = 600

Deno.serve(async (peticion) => {
  const origen = peticion.headers.get('origin')

  if (peticion.method === 'OPTIONS') {
    return new Response('ok', { headers: cabecerasCors(origen) })
  }
  if (peticion.method !== 'POST') {
    return errorNegocio('Método no permitido.', 'METODO_NO_PERMITIDO', origen, 405)
  }

  let cuerpo: unknown
  try {
    cuerpo = await peticion.json()
  } catch {
    return errorNegocio('El cuerpo de la petición no es JSON válido.', 'JSON_INVALIDO', origen)
  }

  const analisis = esquemaSolicitud.safeParse(cuerpo)
  if (!analisis.success) {
    return errorNegocio(primerMensaje(analisis.error), 'ENTRADA_INVALIDA', origen)
  }
  const entrada = analisis.data

  const db = clienteServicio()

  const permitido = await dentroDelLimite(
    db, `solicitud:${ipCliente(peticion)}`, LIMITE_POR_IP, VENTANA_SEGUNDOS,
  )
  if (!permitido) {
    return errorNegocio(
      'Demasiados intentos. Espera unos minutos antes de volver a probar.',
      'DEMASIADOS_INTENTOS', origen, 429,
    )
  }

  const { data, error } = await db.rpc('crear_solicitud', {
    p_codigo_reserva: entrada.codigo_reserva,
    p_tipo: entrada.tipo,
    p_nueva_fecha_inicio: entrada.nueva_fecha_inicio ?? null,
    p_motivo: entrada.motivo,
  })

  if (error) {
    console.error('crear_solicitud falló', error.message)
    return errorNegocio(
      'No pudimos registrar la solicitud. Intenta de nuevo.',
      'ERROR_INTERNO', origen, 500,
    )
  }

  const resultado = data as {
    ok: boolean
    codigo_error?: string
    mensaje?: string
    solicitud_id?: string
    reserva?: {
      id: string; codigo_reserva: string; correo_contacto: string
      fecha_inicio: string; fecha_fin: string
    }
  }

  if (!resultado.ok || !resultado.reserva) {
    return errorNegocio(
      resultado.mensaje ?? 'No se pudo registrar la solicitud.',
      resultado.codigo_error ?? 'SOLICITUD_RECHAZADA',
      origen,
    )
  }

  const reserva = resultado.reserva

  const notificador = crearNotificador(db)
  if (notificador) {
    // El nombre del centro no viene en la respuesta de la RPC; lo buscamos solo
    // para la plantilla.
    const { data: fila } = await db
      .from('reservas')
      .select('centros(nombre)')
      .eq('id', reserva.id)
      .single()

    const centro =
      (fila as { centros?: { nombre?: string } | null } | null)?.centros?.nombre ?? 'Tu centro'

    const datos = {
      centro,
      codigo_reserva: reserva.codigo_reserva,
      fecha_inicio: reserva.fecha_inicio,
      fecha_fin: reserva.fecha_fin,
      nueva_fecha_inicio: entrada.nueva_fecha_inicio,
      motivo: entrada.motivo,
      tipo_solicitud: entrada.tipo,
    }

    await notificador.notificar('solicitud_recibida', reserva.correo_contacto, datos, {
      reservaId: reserva.id,
    })

    const contadora = correoContadora()
    if (contadora) {
      await notificador.notificar('solicitud_recibida', contadora, datos, {
        reservaId: reserva.id,
        paraContadora: true,
      })
    }
  }

  return respuesta({ ok: true, solicitud_id: resultado.solicitud_id }, 201, origen)
})
