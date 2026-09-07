import { Router } from 'express'
import { consultar, consultarUna, dentroDelLimite, llamarFuncion } from './db.ts'
import { error, ipCliente, responderNegocio, type ResultadoNegocio } from './http.ts'
import { esquemaCrearReserva, esquemaSolicitud, primerMensaje } from './validacion.ts'
import { correoContadora, crearNotificador } from './notificaciones/notificador.ts'

const LIMITE_RESERVA = 8
const LIMITE_SOLICITUD = 10
const LIMITE_CONSULTA = 30
const VENTANA_SEGUNDOS = 600 // 10 minutos

export function rutasPublicas(): Router {
  const r = Router()

  // --- Lectura -------------------------------------------------------------

  r.get('/centros', async (_peticion, respuesta) => {
    respuesta.json(await consultar('select id, nombre, duracion_dias_laborables from centros_publicos'))
  })

  r.get('/disponibilidad', async (_peticion, respuesta) => {
    respuesta.json(await consultar(
      'select fecha, laborable, ocupados, max_simultaneos from disponibilidad_publica order by fecha',
    ))
  })

  r.get('/configuracion', async (_peticion, respuesta) => {
    const fila = await consultarUna('select * from configuracion_publica')
    if (!fila) { error(respuesta, 500, 'Configuración no disponible.', 'SIN_CONFIGURACION'); return }
    respuesta.json(fila)
  })

  // --- Escritura -----------------------------------------------------------

  r.post('/reservas', async (peticion, respuesta) => {
    const analisis = esquemaCrearReserva.safeParse(peticion.body)
    if (!analisis.success) {
      error(respuesta, 400, primerMensaje(analisis.error), 'ENTRADA_INVALIDA'); return
    }
    const entrada = analisis.data

    if (!await dentroDelLimite(`reserva:${ipCliente(peticion)}`, LIMITE_RESERVA, VENTANA_SEGUNDOS)) {
      error(respuesta, 429,
        'Demasiados intentos. Espera unos minutos antes de volver a probar.',
        'DEMASIADOS_INTENTOS')
      return
    }

    const resultado = await llamarFuncion<ResultadoNegocio & {
      reserva?: {
        id: string; codigo_reserva: string; centro: string
        fecha_inicio: string; fecha_fin: string; duracion: number
        correo_contacto: string; estado: string
      }
    }>('crear_reserva', [
      entrada.centro_id, entrada.fecha_inicio, entrada.correo_contacto, entrada.telefono,
    ])

    if (!resultado.ok || !resultado.reserva) {
      responderNegocio(respuesta, resultado, null); return
    }

    const reserva = resultado.reserva

    // Las notificaciones van después de confirmar la reserva y nunca la
    // revierten: si el correo falla, la reserva sigue siendo válida.
    const notificador = crearNotificador()
    if (notificador) {
      const datos = {
        centro: reserva.centro,
        codigo_reserva: reserva.codigo_reserva,
        fecha_inicio: reserva.fecha_inicio,
        fecha_fin: reserva.fecha_fin,
        duracion: reserva.duracion,
      }
      await notificador.notificar('reserva_creada', reserva.correo_contacto, datos,
        { reservaId: reserva.id })

      const contadora = correoContadora()
      if (contadora) {
        await notificador.notificar('reserva_creada', contadora, datos,
          { reservaId: reserva.id, paraContadora: true })
      }
    }

    respuesta.status(201).json({ ok: true, reserva })
  })

  r.get('/reservas/:codigo', async (peticion, respuesta) => {
    if (!await dentroDelLimite(`consulta:${ipCliente(peticion)}`, LIMITE_CONSULTA, VENTANA_SEGUNDOS)) {
      error(respuesta, 429, 'Demasiadas consultas. Espera unos minutos.', 'DEMASIADOS_INTENTOS')
      return
    }

    const codigo = String(peticion.params['codigo'] ?? '').slice(0, 20)
    const resultado = await llamarFuncion<ResultadoNegocio>('consultar_reserva', [codigo])

    if (!resultado.ok) { responderNegocio(respuesta, resultado, null); return }
    respuesta.json(resultado)
  })

  r.post('/solicitudes', async (peticion, respuesta) => {
    const analisis = esquemaSolicitud.safeParse(peticion.body)
    if (!analisis.success) {
      error(respuesta, 400, primerMensaje(analisis.error), 'ENTRADA_INVALIDA'); return
    }
    const entrada = analisis.data

    if (!await dentroDelLimite(`solicitud:${ipCliente(peticion)}`, LIMITE_SOLICITUD, VENTANA_SEGUNDOS)) {
      error(respuesta, 429,
        'Demasiados intentos. Espera unos minutos antes de volver a probar.',
        'DEMASIADOS_INTENTOS')
      return
    }

    const resultado = await llamarFuncion<ResultadoNegocio & {
      solicitud_id?: string
      reserva?: {
        id: string; codigo_reserva: string; correo_contacto: string
        fecha_inicio: string; fecha_fin: string
      }
    }>('crear_solicitud', [
      entrada.codigo_reserva, entrada.tipo, entrada.nueva_fecha_inicio ?? null, entrada.motivo,
    ])

    if (!resultado.ok || !resultado.reserva) {
      responderNegocio(respuesta, resultado, null); return
    }

    const reserva = resultado.reserva

    const notificador = crearNotificador()
    if (notificador) {
      const fila = await consultarUna<{ nombre: string }>(
        'select c.nombre from reservas r join centros c on c.id = r.centro_id where r.id = $1',
        [reserva.id],
      )

      const datos = {
        centro: fila?.nombre ?? 'Tu centro',
        codigo_reserva: reserva.codigo_reserva,
        fecha_inicio: reserva.fecha_inicio,
        fecha_fin: reserva.fecha_fin,
        nueva_fecha_inicio: entrada.nueva_fecha_inicio,
        motivo: entrada.motivo,
        tipo_solicitud: entrada.tipo,
      }

      await notificador.notificar('solicitud_recibida', reserva.correo_contacto, datos,
        { reservaId: reserva.id })

      const contadora = correoContadora()
      if (contadora) {
        await notificador.notificar('solicitud_recibida', contadora, datos,
          { reservaId: reserva.id, paraContadora: true })
      }
    }

    respuesta.status(201).json({ ok: true, solicitud_id: resultado.solicitud_id })
  })

  return r
}
