import type { Mensaje, TipoEvento } from './canal.ts'

/** Datos que alimentan cualquier plantilla. */
export interface DatosPlantilla {
  centro: string
  codigo_reserva: string
  fecha_inicio: string
  fecha_fin: string
  duracion?: number
  nueva_fecha_inicio?: string | undefined
  motivo?: string | undefined
  nota?: string | undefined
  tipo_solicitud?: 'cambio' | 'cancelacion' | undefined
  url_app: string
}

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]
const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo']

/** `2027-02-01` → `lunes 1 de febrero de 2027`. Siempre en UTC. */
export function formatoLargo(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  const indiceDia = (d.getUTCDay() + 6) % 7
  return `${DIAS[indiceDia]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`
}

function escapar(texto: string): string {
  return texto
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function envolver(titulo: string, parrafos: string[], url: string): string {
  const cuerpo = parrafos
    .map((p) => `<p style="margin:0 0 14px;line-height:1.55;">${p}</p>`)
    .join('')

  return [
    '<!doctype html><html lang="es"><meta charset="utf-8">',
    '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;',
    'max-width:560px;margin:0 auto;padding:24px;color:#0f172a;font-size:15px;">',
    `<h1 style="font-size:19px;margin:0 0 16px;color:#233f8e;">${escapar(titulo)}</h1>`,
    cuerpo,
    `<p style="margin:22px 0 0;"><a href="${escapar(url)}/consulta" `,
    'style="color:#2b50b4;">Consultar mi reserva</a></p>',
    '<hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0 12px;">',
    '<p style="font-size:13px;color:#64748b;margin:0;">Sánchez Contadores · ',
    'Este correo se generó automáticamente, no hace falta responderlo.</p>',
    '</div></html>',
  ].join('')
}

/** Construye el mensaje de un evento para el destinatario dado. */
export function plantilla(
  evento: TipoEvento,
  datos: DatosPlantilla,
  paraContadora = false,
): Mensaje {
  const { centro, codigo_reserva, fecha_inicio, fecha_fin, url_app } = datos
  const inicio = formatoLargo(fecha_inicio)
  const fin = formatoLargo(fecha_fin)

  switch (evento) {
    case 'reserva_creada': {
      const asunto = paraContadora
        ? `Nueva reserva: ${centro} (${inicio})`
        : `Reserva confirmada — ${codigo_reserva}`

      const parrafos = paraContadora
        ? [
            `<strong>${escapar(centro)}</strong> reservó del ${inicio} al ${fin}.`,
            `Código: <strong>${escapar(codigo_reserva)}</strong>.`,
          ]
        : [
            `Hola, ${escapar(centro)}.`,
            `Tu reporte contable anual queda agendado del <strong>${inicio}</strong> al <strong>${fin}</strong>.`,
            `Guarda tu código de reserva: <strong>${escapar(codigo_reserva)}</strong>. Lo necesitas para consultar o pedir un cambio.`,
          ]

      return armar(asunto, parrafos, url_app)
    }

    case 'solicitud_recibida': {
      const que = datos.tipo_solicitud === 'cancelacion' ? 'cancelación' : 'cambio de fecha'
      const asunto = paraContadora
        ? `Solicitud de ${que}: ${centro}`
        : `Recibimos tu solicitud de ${que}`

      const parrafos = [
        paraContadora
          ? `<strong>${escapar(centro)}</strong> solicitó una ${que}.`
          : `Recibimos tu solicitud de ${que} para la reserva <strong>${escapar(codigo_reserva)}</strong>.`,
        `Fecha actual: del ${inicio} al ${fin}.`,
      ]

      if (datos.nueva_fecha_inicio) {
        parrafos.push(`Fecha solicitada: <strong>${formatoLargo(datos.nueva_fecha_inicio)}</strong>.`)
      }
      if (datos.motivo) {
        parrafos.push(`Motivo: ${escapar(datos.motivo)}`)
      }
      parrafos.push(
        paraContadora
          ? 'Revísala en el panel de administración.'
          : 'Tu fecha actual sigue vigente hasta que la contadora responda.',
      )

      return armar(asunto, parrafos, url_app)
    }

    case 'solicitud_aprobada': {
      const cancelada = datos.tipo_solicitud === 'cancelacion'
      const parrafos = cancelada
        ? [
            `Tu reserva <strong>${escapar(codigo_reserva)}</strong> quedó cancelada.`,
            'Si necesitas volver a agendar, puedes reservar una fecha nueva.',
          ]
        : [
            `Tu solicitud fue aprobada. La nueva fecha de tu reporte es del <strong>${inicio}</strong> al <strong>${fin}</strong>.`,
            `Tu código sigue siendo <strong>${escapar(codigo_reserva)}</strong>.`,
          ]

      if (datos.nota) parrafos.push(`Nota de la contadora: ${escapar(datos.nota)}`)

      return armar(
        cancelada ? `Reserva cancelada — ${codigo_reserva}` : `Cambio aprobado — ${codigo_reserva}`,
        parrafos,
        url_app,
      )
    }

    case 'solicitud_rechazada': {
      const parrafos = [
        `Tu solicitud para la reserva <strong>${escapar(codigo_reserva)}</strong> no fue aprobada.`,
        `Tu fecha original se mantiene: del ${inicio} al ${fin}.`,
      ]
      if (datos.nota) parrafos.push(`Motivo: ${escapar(datos.nota)}`)
      parrafos.push('Si necesitas coordinar otra fecha, envía una solicitud nueva.')

      return armar(`Solicitud no aprobada — ${codigo_reserva}`, parrafos, url_app)
    }

    case 'recordatorio': {
      const parrafos = [
        `Hola, ${escapar(centro)}.`,
        `Te recordamos que la preparación de tu reporte contable anual empieza el <strong>${inicio}</strong> y termina el ${fin}.`,
        'Ten lista la documentación del período para que podamos empezar sin retrasos.',
        `Código de reserva: <strong>${escapar(codigo_reserva)}</strong>.`,
      ]
      return armar(`Recordatorio: tu reporte empieza el ${inicio}`, parrafos, url_app)
    }
  }
}

function armar(asunto: string, parrafosHtml: string[], url: string): Mensaje {
  // La versión de texto plano sale del mismo contenido quitando las etiquetas,
  // así ambas versiones nunca se desincronizan.
  const texto = parrafosHtml
    .map((p) => p.replace(/<[^>]+>/g, ''))
    .join('\n\n')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')

  return {
    destinatario: '',
    asunto,
    texto: `${texto}\n\n—\nSánchez Contadores\n${url}/consulta`,
    html: envolver(asunto, parrafosHtml, url),
  }
}
