import type { SupabaseClient } from '@supabase/supabase-js'
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
  readonly #db: SupabaseClient
  readonly #urlApp: string

  constructor(db: SupabaseClient, canales: CanalNotificacion[], urlApp: string) {
    this.#db = db
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

      const { error } = await this.#db.from('notificaciones_log').insert({
        reserva_id: opciones.reservaId ?? null,
        canal: canal.nombre,
        destinatario,
        tipo_evento: evento,
        resultado: resultado.ok ? 'enviado' : 'fallido',
        detalle: resultado.detalle ?? null,
      })

      if (error) console.error('no se pudo registrar la notificación', error.message)
      if (!resultado.ok) console.error(`envío fallido por ${canal.nombre}`, resultado.detalle)
    }
  }
}

/**
 * Construye el notificador con los canales activos. Si falta la configuración
 * de correo devuelve `null` y quien llama sigue adelante sin notificar.
 *
 * Para añadir WhatsApp: importar `CanalWhatsApp` y agregarlo a `canales`.
 */
export function crearNotificador(db: SupabaseClient): Notificador | null {
  const clave = Deno.env.get('RESEND_API_KEY')
  const remitente = Deno.env.get('CORREO_REMITENTE')
  const urlApp = Deno.env.get('APP_URL') ?? ''

  if (!clave || !remitente) {
    console.error('Notificaciones desactivadas: faltan RESEND_API_KEY o CORREO_REMITENTE')
    return null
  }

  const canales: CanalNotificacion[] = [new CanalCorreoResend(clave, remitente)]
  return new Notificador(db, canales, urlApp)
}

export function correoContadora(): string | null {
  return Deno.env.get('CORREO_CONTADORA') ?? null
}
