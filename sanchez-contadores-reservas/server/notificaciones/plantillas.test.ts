import { describe, expect, it } from 'vitest'
import { formatoLargo, plantilla, type DatosPlantilla } from './plantillas.ts'

const BASE: DatosPlantilla = {
  centro: 'Colegio San José',
  codigo_reserva: 'SC-2027-AB3K9M',
  fecha_inicio: '2027-02-01',
  fecha_fin: '2027-02-05',
  duracion: 5,
  url_app: 'https://ejemplo.do',
}

describe('formato de fecha en los correos', () => {
  it('usa UTC para no correr el día en UTC-4', () => {
    expect(formatoLargo('2027-02-01')).toBe('lunes 1 de febrero de 2027')
    expect(formatoLargo('2027-07-30')).toBe('viernes 30 de julio de 2027')
    expect(formatoLargo('2027-12-25')).toBe('sábado 25 de diciembre de 2027')
  })
})

describe('plantilla de reserva creada', () => {
  it('le da al centro su código y sus fechas', () => {
    const m = plantilla('reserva_creada', BASE)
    expect(m.asunto).toContain('SC-2027-AB3K9M')
    expect(m.texto).toContain('lunes 1 de febrero de 2027')
    expect(m.texto).toContain('SC-2027-AB3K9M')
    expect(m.html).toContain('<html')
  })

  it('la copia para la contadora es distinta y nombra al centro', () => {
    const centro = plantilla('reserva_creada', BASE)
    const contadora = plantilla('reserva_creada', BASE, true)
    expect(contadora.asunto).not.toBe(centro.asunto)
    expect(contadora.asunto).toContain('Colegio San José')
    expect(contadora.asunto).toContain('Nueva reserva')
  })
})

describe('plantillas de solicitudes', () => {
  it('la solicitud recibida incluye la fecha pedida y el motivo', () => {
    const m = plantilla('solicitud_recibida', {
      ...BASE,
      tipo_solicitud: 'cambio',
      nueva_fecha_inicio: '2027-03-08',
      motivo: 'Auditoría interna',
    })
    expect(m.texto).toContain('lunes 8 de marzo de 2027')
    expect(m.texto).toContain('Auditoría interna')
    expect(m.texto).toContain('sigue vigente')
  })

  it('la aprobación de una cancelación no habla de fecha nueva', () => {
    const m = plantilla('solicitud_aprobada', { ...BASE, tipo_solicitud: 'cancelacion' })
    expect(m.asunto).toContain('Reserva cancelada')
    expect(m.texto).toContain('quedó cancelada')
  })

  it('el rechazo insiste en que la fecha original se mantiene', () => {
    const m = plantilla('solicitud_rechazada', { ...BASE, nota: 'Esa semana está llena' })
    expect(m.texto).toContain('se mantiene')
    expect(m.texto).toContain('Esa semana está llena')
  })
})

describe('recordatorio', () => {
  it('anuncia la fecha de inicio en el asunto', () => {
    const m = plantilla('recordatorio', BASE)
    expect(m.asunto).toContain('lunes 1 de febrero de 2027')
    expect(m.texto).toContain('documentación')
  })
})

describe('seguridad de las plantillas', () => {
  it('escapa el motivo que escribe el centro', () => {
    const m = plantilla('solicitud_recibida', {
      ...BASE,
      tipo_solicitud: 'cambio',
      nueva_fecha_inicio: '2027-03-08',
      motivo: '<img src=x onerror="alert(1)">',
    })
    expect(m.html).not.toContain('<img')
    expect(m.html).not.toContain('onerror="')
    expect(m.html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  })

  it('escapa el nombre del centro donde se muestra', () => {
    // El nombre solo aparece en la copia interna de la contadora y en el
    // encabezado, que es el que arma `envolver`.
    const m = plantilla('solicitud_recibida', {
      ...BASE,
      centro: '<script>alert(1)</script>',
      tipo_solicitud: 'cambio',
      nueva_fecha_inicio: '2027-03-08',
      motivo: 'Auditoría',
    }, true)
    expect(m.html).not.toContain('<script>')
    expect(m.html).toContain('&lt;script&gt;')
  })

  it('produce una versión de texto plano sin etiquetas', () => {
    const m = plantilla('reserva_creada', BASE)
    expect(m.texto).not.toMatch(/<[a-z/]/i)
    expect(m.texto).toContain('Sánchez Contadores')
  })
})
