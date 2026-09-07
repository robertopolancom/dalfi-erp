/**
 * Interfaz abstracta de notificaciones.
 *
 * Hoy solo existe el canal de correo. Añadir WhatsApp más adelante consiste en
 * implementar `CanalNotificacion` y registrarlo en el notificador: ni las
 * plantillas ni las funciones que disparan eventos cambian.
 */

export type TipoEvento =
  | 'reserva_creada'
  | 'solicitud_recibida'
  | 'solicitud_aprobada'
  | 'solicitud_rechazada'
  | 'recordatorio'

export interface Mensaje {
  destinatario: string
  asunto: string
  texto: string
  html: string
}

export interface ResultadoEnvio {
  ok: boolean
  detalle?: string
}

export interface CanalNotificacion {
  /** Identificador que se guarda en `notificaciones_log.canal`. */
  readonly nombre: string
  enviar(mensaje: Mensaje): Promise<ResultadoEnvio>
}
