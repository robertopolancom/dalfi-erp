import { describe, expect, it } from 'vitest'
import fixture from './disponibilidad-2027.fixture.json'
import {
  calcularRango, construirCalendario, contarDiasLaborables, dentroDeVentana,
  esLaborable, estadoDia, primerDiaSinCupo,
  type DiaDisponibilidad, type Ventana,
} from '../calendario'
import type { FechaISO } from '../fechas'

// El fixture lo produce la vista `disponibilidad_publica` del servidor
// (neon/tests/exportar_fixture.sql). Probar el espejo del cliente contra
// datos reales del motor SQL es lo que garantiza que ambos coincidan.
const DIAS = fixture.dias as DiaDisponibilidad[]
const VENTANA: Ventana = fixture.ventana as Ventana
const CAL = construirCalendario(DIAS)

/** Copia del calendario con `ocupados` forzado en ciertos días. */
function conOcupacion(ocupacion: Record<string, number>) {
  return construirCalendario(
    DIAS.map((d) => ({ ...d, ocupados: ocupacion[d.fecha] ?? d.ocupados })),
  )
}

describe('ventana de trabajo (regla 1)', () => {
  it('cubre del 1 de febrero al 31 de julio de 2027', () => {
    expect(VENTANA).toEqual({ inicio: '2027-02-01', fin: '2027-07-31' })
    expect(DIAS).toHaveLength(181)
  })

  it('deja fuera lo anterior y lo posterior', () => {
    expect(dentroDeVentana('2027-01-31', VENTANA)).toBe(false)
    expect(dentroDeVentana('2027-02-01', VENTANA)).toBe(true)
    expect(dentroDeVentana('2027-07-31', VENTANA)).toBe(true)
    expect(dentroDeVentana('2027-08-01', VENTANA)).toBe(false)
  })

  it('marca como fuera de temporada los días de otro mes', () => {
    expect(estadoDia('2027-01-29', CAL, VENTANA, 5)).toBe('fuera-ventana')
    expect(estadoDia('2027-08-02', CAL, VENTANA, 5)).toBe('fuera-ventana')
  })
})

describe('días laborables (regla 2)', () => {
  it('excluye sábados y domingos', () => {
    expect(esLaborable('2027-02-06', CAL)).toBe(false)
    expect(esLaborable('2027-02-07', CAL)).toBe(false)
    expect(esLaborable('2027-02-05', CAL)).toBe(true)
  })

  it('excluye los feriados dominicanos que caen dentro de la ventana', () => {
    expect(esLaborable('2027-03-26', CAL)).toBe(false) // Viernes Santo
    expect(esLaborable('2027-05-27', CAL)).toBe(false) // Corpus Christi
  })

  it('el 1 de mayo de 2027 cae sábado, así que la Ley 139-97 no lo traslada', () => {
    // El Artículo 1 solo mueve los feriados de martes a viernes. El lunes 3 de
    // mayo sigue siendo un día laborable normal.
    expect(esLaborable('2027-05-03', CAL)).toBe(true)
  })
})

describe('cálculo del rango de la reserva', () => {
  it('cuenta el día de inicio como el primero', () => {
    expect(calcularRango('2027-02-01', 1, CAL, VENTANA)?.fin).toBe('2027-02-01')
    expect(calcularRango('2027-02-01', 5, CAL, VENTANA)?.fin).toBe('2027-02-05')
  })

  it('salta el fin de semana', () => {
    expect(calcularRango('2027-02-04', 5, CAL, VENTANA)?.fin).toBe('2027-02-10')
  })

  it('salta un feriado que parte la semana', () => {
    // Semana Santa: el viernes 26 de marzo es feriado, así que el quinto día
    // laborable cae el lunes 29.
    const rango = calcularRango('2027-03-22', 5, CAL, VENTANA)
    expect(rango?.fin).toBe('2027-03-29')
    expect(rango?.diasLaborables).toEqual([
      '2027-03-22', '2027-03-23', '2027-03-24', '2027-03-25', '2027-03-29',
    ])
    expect(rango?.diasLaborables).not.toContain('2027-03-26')
  })

  it('coincide con el servidor en el número de días laborables del rango', () => {
    expect(contarDiasLaborables('2027-03-22', '2027-03-29', CAL)).toBe(5)
  })

  it('rechaza empezar en un día no laborable', () => {
    expect(calcularRango('2027-02-06', 5, CAL, VENTANA)).toBeNull()
    expect(calcularRango('2027-03-26', 5, CAL, VENTANA)).toBeNull()
  })

  it('rechaza una duración inválida', () => {
    expect(calcularRango('2027-02-01', 0, CAL, VENTANA)).toBeNull()
  })
})

describe('caso límite: cierre de la ventana el 31 de julio', () => {
  it('el 31 de julio de 2027 cae sábado, así que el último día hábil es el viernes 30', () => {
    expect(esLaborable('2027-07-31', CAL)).toBe(false)
    expect(esLaborable('2027-07-30', CAL)).toBe(true)
  })

  it('acepta la reserva que termina justo en el último día hábil', () => {
    const rango = calcularRango('2027-07-26', 5, CAL, VENTANA)
    expect(rango?.fin).toBe('2027-07-30')
    expect(estadoDia('2027-07-26', CAL, VENTANA, 5)).toBe('disponible')
  })

  it('rechaza el inicio cuyo rango se saldría de la ventana', () => {
    expect(calcularRango('2027-07-27', 5, CAL, VENTANA)).toBeNull()
    expect(estadoDia('2027-07-27', CAL, VENTANA, 5)).toBe('no-cabe')
    expect(estadoDia('2027-07-30', CAL, VENTANA, 5)).toBe('no-cabe')
  })

  it('un centro con duración más corta sí alcanza a entrar al final', () => {
    expect(calcularRango('2027-07-30', 1, CAL, VENTANA)?.fin).toBe('2027-07-30')
    expect(estadoDia('2027-07-30', CAL, VENTANA, 1)).toBe('disponible')
  })
})

describe('capacidad simultánea (regla 3)', () => {
  it('acepta hasta el tercer centro y rechaza el cuarto', () => {
    const semana = ['2027-02-01', '2027-02-02', '2027-02-03', '2027-02-04', '2027-02-05']

    const dos = conOcupacion(Object.fromEntries(semana.map((d) => [d, 2])))
    expect(estadoDia('2027-02-01', dos, VENTANA, 5)).toBe('disponible')

    const tres = conOcupacion(Object.fromEntries(semana.map((d) => [d, 3])))
    expect(estadoDia('2027-02-01', tres, VENTANA, 5)).toBe('sin-cupo')
  })

  it('revisa el rango completo, no solo el día inicial', () => {
    // Solo el jueves está lleno; el lunes se ve libre pero la reserva de 5 días
    // pasaría por el jueves.
    const cal = conOcupacion({ '2027-02-04': 3 })
    expect(estadoDia('2027-02-01', cal, VENTANA, 5)).toBe('sin-cupo')
    expect(primerDiaSinCupo('2027-02-01', '2027-02-05', cal)).toBe('2027-02-04')
  })

  it('ignora la ocupación de días no laborables dentro del rango', () => {
    // El sábado 6 nunca se trabaja: aunque figure lleno, no bloquea nada.
    const cal = conOcupacion({ '2027-02-06': 3 })
    expect(estadoDia('2027-02-04', cal, VENTANA, 5)).toBe('disponible')
    expect(primerDiaSinCupo('2027-02-01', '2027-02-10', cal)).toBeNull()
  })

  it('un día lleno vuelve a liberarse para rangos que no lo tocan', () => {
    const cal = conOcupacion(
      Object.fromEntries(
        ['2027-02-01', '2027-02-02', '2027-02-03', '2027-02-04', '2027-02-05']
          .map((d) => [d, 3]),
      ),
    )
    expect(estadoDia('2027-02-08', cal, VENTANA, 5)).toBe('disponible')
  })
})

describe('caso límite: un bloqueo parte el rango', () => {
  it('estira la reserva los días que dure el bloqueo', () => {
    // Simulamos el bloqueo del miércoles 9 y jueves 10 de junio marcando esos
    // días como no laborables, que es exactamente lo que hace el servidor.
    const bloqueados = new Set<FechaISO>(['2027-06-09', '2027-06-10'])
    const cal = construirCalendario(
      DIAS.map((d) => (bloqueados.has(d.fecha) ? { ...d, laborable: false } : d)),
    )

    expect(calcularRango('2027-06-07', 5, CAL, VENTANA)?.fin).toBe('2027-06-11')
    expect(calcularRango('2027-06-07', 5, cal, VENTANA)?.fin).toBe('2027-06-15')
    expect(contarDiasLaborables('2027-06-07', '2027-06-15', cal)).toBe(5)
    expect(estadoDia('2027-06-09', cal, VENTANA, 5)).toBe('no-laborable')
  })
})
