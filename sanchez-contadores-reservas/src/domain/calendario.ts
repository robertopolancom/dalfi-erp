/**
 * Espejo en cliente de las reglas de negocio, SOLO para pintar el calendario y
 * dar retroalimentación inmediata.
 *
 * No duplica el conocimiento de feriados ni de bloqueos: parte de lo que el
 * servidor ya resolvió en la vista `disponibilidad_publica` (un registro por
 * día con `laborable` y `ocupados`). La decisión final siempre la toma
 * `crear_reserva()` en Postgres; si el usuario tarda y el hueco se llena, el
 * servidor rechaza y la interfaz muestra el motivo.
 */

import { rangoDeFechas, sumarDias, type FechaISO } from './fechas'

export interface DiaDisponibilidad {
  fecha: FechaISO
  laborable: boolean
  ocupados: number
  max_simultaneos: number
}

export interface Ventana {
  inicio: FechaISO
  fin: FechaISO
}

export type EstadoDia =
  | 'disponible'      // se puede iniciar una reserva aquí
  | 'sin-cupo'        // laborable, pero el rango chocaría con el máximo simultáneo
  | 'no-laborable'    // fin de semana, feriado o bloqueo
  | 'fuera-ventana'   // fuera del 1-feb / 31-jul del año activo
  | 'no-cabe'         // el rango se saldría de la ventana

export type Calendario = ReadonlyMap<FechaISO, DiaDisponibilidad>

export function construirCalendario(dias: readonly DiaDisponibilidad[]): Calendario {
  return new Map(dias.map((d) => [d.fecha, d]))
}

export function dentroDeVentana(fecha: FechaISO, ventana: Ventana): boolean {
  return fecha >= ventana.inicio && fecha <= ventana.fin
}

export function esLaborable(fecha: FechaISO, calendario: Calendario): boolean {
  return calendario.get(fecha)?.laborable === true
}

export function tieneCupo(fecha: FechaISO, calendario: Calendario): boolean {
  const dia = calendario.get(fecha)
  if (!dia) return false
  return dia.ocupados < dia.max_simultaneos
}

/**
 * Rango de días de calendario que ocuparía una reserva que empieza en `inicio`
 * y dura `duracion` días laborables. Devuelve `null` si el inicio no es
 * laborable o si no hay días laborables suficientes dentro de la ventana.
 *
 * Es el equivalente en cliente de `calcular_fecha_fin()` en SQL.
 */
export function calcularRango(
  inicio: FechaISO,
  duracion: number,
  calendario: Calendario,
  ventana: Ventana,
): { fin: FechaISO; diasLaborables: FechaISO[] } | null {
  if (duracion < 1) return null
  if (!esLaborable(inicio, calendario)) return null

  const diasLaborables: FechaISO[] = []
  let cursor = inicio

  while (diasLaborables.length < duracion) {
    if (cursor > ventana.fin) return null
    if (!calendario.has(cursor)) return null
    if (esLaborable(cursor, calendario)) diasLaborables.push(cursor)
    if (diasLaborables.length === duracion) break
    cursor = sumarDias(cursor, 1)
  }

  return { fin: cursor, diasLaborables }
}

/**
 * Clasifica un día para pintarlo. `duracion` es la del centro seleccionado; si
 * aún no hay centro elegido, se evalúa solo el día en sí.
 */
export function estadoDia(
  fecha: FechaISO,
  calendario: Calendario,
  ventana: Ventana,
  duracion: number | null,
): EstadoDia {
  if (!dentroDeVentana(fecha, ventana)) return 'fuera-ventana'
  if (!esLaborable(fecha, calendario)) return 'no-laborable'

  if (duracion === null) {
    return tieneCupo(fecha, calendario) ? 'disponible' : 'sin-cupo'
  }

  const rango = calcularRango(fecha, duracion, calendario, ventana)
  if (!rango) return 'no-cabe'

  // Regla 3: el cupo se revisa en TODOS los días laborables del rango.
  const sinCupo = rango.diasLaborables.some((d) => !tieneCupo(d, calendario))
  return sinCupo ? 'sin-cupo' : 'disponible'
}

/** Primer día laborable del rango que ya llegó al máximo simultáneo. */
export function primerDiaSinCupo(
  inicio: FechaISO,
  fin: FechaISO,
  calendario: Calendario,
): FechaISO | null {
  for (const dia of rangoDeFechas(inicio, fin)) {
    if (esLaborable(dia, calendario) && !tieneCupo(dia, calendario)) return dia
  }
  return null
}

export function contarDiasLaborables(
  inicio: FechaISO,
  fin: FechaISO,
  calendario: Calendario,
): number {
  return rangoDeFechas(inicio, fin).filter((d) => esLaborable(d, calendario)).length
}

export const ETIQUETA_ESTADO: Record<EstadoDia, string> = {
  'disponible': 'Disponible',
  'sin-cupo': 'Sin cupo',
  'no-laborable': 'No laborable',
  'fuera-ventana': 'Fuera de temporada',
  'no-cabe': 'No alcanza antes del cierre',
}
