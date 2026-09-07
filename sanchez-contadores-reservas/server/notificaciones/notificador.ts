import { consultar } from '../db.ts'
import type { CanalNotificacion, TipoEvento } from './canal.ts'
import { CanalCorreoResend } from './correo-resend.ts'
import { plantilla, type DatosPlantilla } from './plantillas.ts'

/**
 * Despacha eventos por los canales registrados y deja constancia de cada envío
 * en `notificaciones_log`. Un fallo de notificación nunca revierte la operación
 * de negocio que la originó: la reserva ya está hecha.
 */
export class Notificador {
  readonly #canales: CanalNotificacion[]
  readonly #urlApp: string

  constructor(canales: CanalNotificacion[], urlApp: string) {
    this.#canales = canales
    this.#urlApp = urlApp
  }

  async notificar(
    evento: TipoEvento,
    destinatario: string,
    datos: Omit<DatosPlantilla, 'url_app'>,
    opciones: { reservaId?: string | undefined; paraContadora?: boolean } = {},
  ): Promise<void> {
    if (!destinatario) return

    const mensaje = {
      ...plantilla(evento, { ...datos, url_app: this.#urlApp }, opciones.paraContadora ?? false),
      destinatario,
    }

    for (const canal of this.#canales) {
      const resultado = await canal.enviar(mensaje)

      try {
        await consultar(
          `insert into notificaciones_log
             (reserva_id, canal, destinatario, tipo_evento, resultado, detalle)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            opciones.reservaId ?? null,
            canal.nombre,
            destinatario,
            evento,
            resultado.ok ? 'enviado' : 'fallido',
            resultado.detalle ?? null,
          ],
        )
      } catch (error) {
        console.error('no se pudo registrar la notificación:',
          error instanceof Error ? error.message : error)
      }

      if (!resultado.ok) console.error(`envío fallido por ${canal.nombre}:`, resultado.detalle)
    }
  }
}

/**
 * Construye el notificador con los canales activos. Si falta la configuración
 * de correo devuelve `null` y quien llama sigue adelante sin notificar.
 *
 * Para añadir WhatsApp: importar `CanalWhatsApp` y agregarlo a `canales`.
 */
export function crearNotificador(): Notificador | null {
  const clave = process.env['RESEND_API_KEY']
  const remitente = process.env['CORREO_REMITENTE']
  const urlApp = process.env['APP_URL'] ?? ''

  if (!clave || !remitente) {
    console.error('Notificaciones desactivadas: faltan RESEND_API_KEY o CORREO_REMITENTE')
    return null
  }

  const canales: CanalNotificacion[] = [new CanalCorreoResend(clave, remitente)]
  return new Notificador(canales, urlApp)
}

export function correoContadora(): string | null {
  return process.env['CORREO_CONTADORA'] ?? null
}
