import type { CanalNotificacion, Mensaje, ResultadoEnvio } from './canal.ts'

/** Canal de correo sobre Resend. */
export class CanalCorreoResend implements CanalNotificacion {
  readonly nombre = 'correo'

  readonly #clave: string
  readonly #remitente: string

  constructor(clave: string, remitente: string) {
    this.#clave = clave
    this.#remitente = remitente
  }

  async enviar(mensaje: Mensaje): Promise<ResultadoEnvio> {
    try {
      const respuesta = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#clave}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.#remitente,
          to: [mensaje.destinatario],
          subject: mensaje.asunto,
          text: mensaje.texto,
          html: mensaje.html,
        }),
      })

      if (!respuesta.ok) {
        const cuerpo = await respuesta.text()
        // El cuerpo puede traer el correo del destinatario; lo recortamos para
        // no volcar datos de contacto completos en los logs.
        return { ok: false, detalle: `HTTP ${respuesta.status}: ${cuerpo.slice(0, 200)}` }
      }

      return { ok: true }
    } catch (e) {
      return { ok: false, detalle: e instanceof Error ? e.message : 'error desconocido' }
    }
  }
}
