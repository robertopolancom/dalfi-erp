import type { CanalNotificacion, Mensaje, ResultadoEnvio } from './canal.ts'

/**
 * Marcador de posición para el canal de WhatsApp.
 *
 * FUERA DE ALCANCE en esta versión: no está registrado en el notificador y no
 * se invoca desde ninguna parte. Existe únicamente para dejar fijada la forma
 * que tendrá la integración, de modo que añadirla después no obligue a tocar
 * las plantillas ni los disparadores de eventos.
 *
 * Para activarlo en el futuro:
 *   1. Implementar `enviar` contra la API elegida (WhatsApp Cloud API u otra).
 *   2. Registrar la instancia en `crearNotificador()` en notificador.ts.
 *   3. Añadir la plantilla corta correspondiente en plantillas.ts.
 */
export class CanalWhatsApp implements CanalNotificacion {
  readonly nombre = 'whatsapp'

  enviar(_mensaje: Mensaje): Promise<ResultadoEnvio> {
    return Promise.resolve({
      ok: false,
      detalle: 'Canal de WhatsApp no implementado todavía.',
    })
  }
}
