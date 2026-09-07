// Endpoint público de reserva.
//
// Es el único camino por el que un centro escribe en la base de datos. Valida
// la entrada con zod, aplica rate limiting y delega la decisión de negocio en
// crear_reserva(), que valida e inserta de forma atómica.

import { clienteServicio, dentroDelLimite } from '../_shared/db.ts'
import { errorNegocio, ipCliente, respuesta, cabecerasCors } from '../_shared/http.ts'
import { esquemaCrearReserva, primerMensaje } from '../_shared/validacion.ts'
import { correoContadora, crearNotificador } from '../_shared/notifications/notificador.ts'

const LIMITE_POR_IP = 8
const VENTANA_SEGUNDOS = 600 // 10 minutos

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

  const analisis = esquemaCrearReserva.safeParse(cuerpo)
  if (!analisis.success) {
    return errorNegocio(primerMensaje(analisis.error), 'ENTRADA_INVALIDA', origen)
  }
  const entrada = analisis.data

  const db = clienteServicio()

  const permitido = await dentroDelLimite(
    db, `reserva:${ipCliente(peticion)}`, LIMITE_POR_IP, VENTANA_SEGUNDOS,
  )
  if (!permitido) {
    return errorNegocio(
      'Demasiados intentos. Espera unos minutos antes de volver a probar.',
      'DEMASIADOS_INTENTOS', origen, 429,
    )
  }

  const { data, error } = await db.rpc('crear_reserva', {
    p_centro_id: entrada.centro_id,
    p_fecha_inicio: entrada.fecha_inicio,
    p_correo_contacto: entrada.correo_contacto,
    p_telefono: entrada.telefono,
  })

  if (error) {
    console.error('crear_reserva falló', error.message)
    return errorNegocio(
      'No pudimos completar la reserva. Intenta de nuevo en un momento.',
      'ERROR_INTERNO', origen, 500,
    )
  }

  const resultado = data as {
    ok: boolean
    codigo_error?: string
    mensaje?: string
    reserva?: {
      id: string; codigo_reserva: string; centro: string
      fecha_inicio: string; fecha_fin: string; duracion: number
      correo_contacto: string; estado: string
    }
  }

  if (!resultado.ok || !resultado.reserva) {
    return errorNegocio(
      resultado.mensaje ?? 'No se pudo reservar esa fecha.',
      resultado.codigo_error ?? 'RESERVA_RECHAZADA',
      origen,
    )
  }

  const reserva = resultado.reserva

  // Las notificaciones van después de confirmar la reserva y nunca la revierten.
  const notificador = crearNotificador(db)
  if (notificador) {
    const datos = {
      centro: reserva.centro,
      codigo_reserva: reserva.codigo_reserva,
      fecha_inicio: reserva.fecha_inicio,
      fecha_fin: reserva.fecha_fin,
      duracion: reserva.duracion,
    }

    await notificador.notificar('reserva_creada', reserva.correo_contacto, datos, {
      reservaId: reserva.id,
    })

    const contadora = correoContadora()
    if (contadora) {
      await notificador.notificar('reserva_creada', contadora, datos, {
        reservaId: reserva.id,
        paraContadora: true,
      })
    }
  }

  return respuesta({ ok: true, reserva }, 201, origen)
})
