// Recordatorio 3 días laborables antes del inicio.
//
// Pensado para ejecutarse una vez al día desde un cron (pg_cron o un Cron
// Trigger de Cloudflare). Se protege con un secreto compartido porque no está
// detrás de la sesión de nadie.

import { clienteServicio } from '../_shared/db.ts'
import { respuesta } from '../_shared/http.ts'
import { crearNotificador } from '../_shared/notifications/notificador.ts'

const DIAS_ANTES = 3

Deno.serve(async (peticion) => {
  const secreto = Deno.env.get('CRON_SECRET')
  if (!secreto) {
    return respuesta({ ok: false, mensaje: 'CRON_SECRET no configurado.' }, 500, null)
  }
  if (peticion.headers.get('x-cron-secret') !== secreto) {
    return respuesta({ ok: false, mensaje: 'No autorizado.' }, 401, null)
  }

  const db = clienteServicio()

  const { data, error } = await db.rpc('reservas_para_recordatorio', {
    p_dias_laborables: DIAS_ANTES,
  })

  if (error) {
    console.error('reservas_para_recordatorio falló', error.message)
    return respuesta({ ok: false, mensaje: 'Error consultando las reservas.' }, 500, null)
  }

  const pendientes = (data ?? []) as {
    reserva_id: string; codigo_reserva: string; centro: string
    correo_contacto: string; fecha_inicio: string; fecha_fin: string; duracion: number
  }[]

  const notificador = crearNotificador(db)
  if (!notificador) {
    return respuesta({ ok: false, mensaje: 'Notificaciones no configuradas.' }, 500, null)
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

  await db.rpc('purgar_rate_limit')

  return respuesta({ ok: true, enviados: pendientes.length }, 200, null)
})
