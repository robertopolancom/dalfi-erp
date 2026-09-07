import { describe, expect, it } from 'vitest'
import {
  aISO, anioDe, diaIso, diferenciaEnDias, esFechaISO, esFinDeSemana, formatoCorto,
  formatoLargo, inicioDeMes, rangoDeFechas, rejillaDelMes, sumarDias,
} from '../fechas'

describe('fechas: seguridad frente a zona horaria', () => {
  // Este es el error clásico: con accesores locales en UTC-4, el 1 de febrero
  // de 2027 se leería como el domingo 31 de enero y todo el calendario se
  // correría un día.
  it('interpreta la fecha como día de calendario, no como instante local', () => {
    expect(diaIso('2027-02-01')).toBe(1) // lunes
    expect(diaIso('2027-01-31')).toBe(7) // domingo
    expect(diaIso('2027-07-31')).toBe(6) // sábado
  })

  it('no cambia de día al sumar sobre un cambio de mes o de año', () => {
    expect(sumarDias('2027-02-28', 1)).toBe('2027-03-01')
    expect(sumarDias('2027-12-31', 1)).toBe('2028-01-01')
    expect(sumarDias('2027-03-01', -1)).toBe('2027-02-28')
  })

  it('reconoce febrero de un año bisiesto', () => {
    expect(esFechaISO('2028-02-29')).toBe(true)
    expect(esFechaISO('2027-02-29')).toBe(false)
    expect(esFechaISO('2027-13-01')).toBe(false)
    expect(esFechaISO('01/02/2027')).toBe(false)
  })
})

describe('fechas: utilidades', () => {
  it('identifica fines de semana', () => {
    expect(esFinDeSemana('2027-02-06')).toBe(true)  // sábado
    expect(esFinDeSemana('2027-02-07')).toBe(true)  // domingo
    expect(esFinDeSemana('2027-02-05')).toBe(false) // viernes
  })

  it('cuenta días entre fechas', () => {
    expect(diferenciaEnDias('2027-02-01', '2027-02-05')).toBe(4)
    expect(diferenciaEnDias('2027-02-05', '2027-02-01')).toBe(-4)
  })

  it('genera el rango cerrado de fechas', () => {
    expect(rangoDeFechas('2027-02-01', '2027-02-03')).toEqual([
      '2027-02-01', '2027-02-02', '2027-02-03',
    ])
    expect(rangoDeFechas('2027-02-01', '2027-02-01')).toEqual(['2027-02-01'])
    expect(rangoDeFechas('2027-02-03', '2027-02-01')).toEqual([])
  })

  it('formatea en español dominicano', () => {
    expect(formatoLargo('2027-02-01')).toBe('lunes 1 de febrero de 2027')
    expect(formatoLargo('2027-07-30')).toBe('viernes 30 de julio de 2027')
    expect(formatoCorto('2027-02-01')).toBe('01/02/2027')
  })

  it('construye una rejilla mensual de 6 semanas que empieza en lunes', () => {
    const rejilla = rejillaDelMes('2027-02-15')
    expect(rejilla).toHaveLength(42)
    expect(diaIso(rejilla[0]!)).toBe(1)
    expect(rejilla).toContain('2027-02-01')
    expect(rejilla).toContain('2027-02-28')
    // Febrero de 2027 empieza en lunes, así que la rejilla arranca justo ahí.
    expect(rejilla[0]).toBe('2027-02-01')
  })

  it('devuelve el primer día del mes y el año', () => {
    expect(inicioDeMes('2027-07-19')).toBe('2027-07-01')
    expect(anioDe('2027-07-19')).toBe(2027)
    expect(aISO(new Date('2027-07-19T23:30:00Z'))).toBe('2027-07-19')
  })
})
