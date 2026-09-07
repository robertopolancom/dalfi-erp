import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import { consultar } from './db.ts'
import { error } from './http.ts'
import { purgarSesiones } from './auth.ts'
import { rutasPublicas } from './rutas-publicas.ts'
import { rutasAdmin } from './rutas-admin.ts'
import { crearNotificador } from './notificaciones/notificador.ts'

const DIAS_ANTES_RECORDATORIO = 3

export function crearApp(opciones: { directorioEstatico: string }) {
  const app = express()

  // Render está detrás de un proxy: sin esto, req.ip sería siempre la del
  // proxy y el rate limiting agruparía a todo el mundo bajo la misma clave.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  app.use(express.json({ limit: '32kb' }))

  app.use((_peticion, respuesta, siguiente) => {
    respuesta.setHeader('X-Content-Type-Options', 'nosniff')
    respuesta.setHeader('X-Frame-Options', 'DENY')
    respuesta.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    siguiente()
  })

  app.get('/health', async (_peticion, respuesta) => {
    try {
      await consultar('select 1')
      respuesta.json({ ok: true })
    } catch {
      respuesta.status(503).json({ ok: false })
    }
  })

  app.use('/api/publico', rutasPublicas())
  app.use('/api/admin', rutasAdmin())

  // --- Cron de recordatorios ------------------------------------------------
  // No está detrás de sesión, así que se protege con un secreto compartido.
  app.post('/api/cron/recordatorios', async (peticion, respuesta) => {
    const secreto = process.env['CRON_SECRET']

    // Si falta el secreto la ruta queda cerrada, pero la respuesta es la misma
    // que ante un secreto equivocado: quien llama sin autorización no debe
    // poder deducir cómo está configurado el servidor. El aviso va al log.
    if (!secreto) console.error('CRON_SECRET no configurado: los recordatorios no se enviarán.')

    if (!secreto || peticion.get('x-cron-secret') !== secreto) {
      error(respuesta, 401, 'No autorizado.', 'NO_AUTORIZADO'); return
    }

    const pendientes = await consultar<{
      reserva_id: string; codigo_reserva: string; centro: string
      correo_contacto: string; fecha_inicio: string; fecha_fin: string; duracion: number
    }>('select * from reservas_para_recordatorio($1)', [DIAS_ANTES_RECORDATORIO])

    const notificador = crearNotificador()
    if (!notificador) {
      error(respuesta, 500, 'Notificaciones no configuradas.', 'SIN_CONFIGURACION'); return
    }

    for (const r of pendientes) {
      await notificador.notificar('recordatorio', r.correo_contacto, {
        centro: r.centro,
        codigo_reserva: r.codigo_reserva,
        fecha_inicio: r.fecha_inicio,
        fecha_fin: r.fecha_fin,
        duracion: r.duracion,
      }, { reservaId: r.reserva_id })
    }

    await consultar('select purgar_rate_limit()')
    await purgarSesiones()

    respuesta.json({ ok: true, enviados: pendientes.length })
  })

  app.use('/api', (_peticion, respuesta) => {
    error(respuesta, 404, 'Ruta no encontrada.', 'NO_EXISTE')
  })

  // --- Frontend -------------------------------------------------------------
  // El mismo servicio sirve la SPA: un solo despliegue y nada de CORS.
  app.use(express.static(opciones.directorioEstatico, { maxAge: '1h', index: false }))

  app.get('/{*ruta}', (_peticion, respuesta) => {
    respuesta.sendFile(path.join(opciones.directorioEstatico, 'index.html'))
  })

  app.use((e: Error, _peticion: Request, respuesta: Response, _siguiente: NextFunction) => {
    // El detalle va al log del servidor, nunca al navegador: un mensaje de
    // Postgres puede revelar nombres de tablas y columnas.
    console.error('error no controlado:', e.message)
    if (respuesta.headersSent) return
    error(respuesta, 500, 'Ocurrió un error inesperado. Intenta de nuevo.', 'ERROR_INTERNO')
  })

  return app
}
