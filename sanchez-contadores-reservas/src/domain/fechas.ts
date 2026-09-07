/**
 * Utilidades de fecha sin dependencias.
 *
 * Regla del proyecto: las fechas de negocio son días de calendario, no
 * instantes. Se representan siempre como cadenas `YYYY-MM-DD` y todo cálculo
 * usa accesores UTC. Si usáramos accesores locales, en República Dominicana
 * (UTC-4) `new Date('2027-02-01').getDay()` devolvería el domingo 31 de enero
 * y el calendario se correría un día entero.
 */

/** Fecha de calendario en formato ISO corto, p. ej. `2027-02-01`. */
export type FechaISO = string

const ISO = /^\d{4}-\d{2}-\d{2}$/

export function esFechaISO(valor: string): valor is FechaISO {
  if (!ISO.test(valor)) return false
  const d = new Date(`${valor}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && aISO(d) === valor
}

export function aFecha(iso: FechaISO): Date {
  return new Date(`${iso}T00:00:00Z`)
}

export function aISO(fecha: Date): FechaISO {
  return fecha.toISOString().slice(0, 10)
}

export function sumarDias(iso: FechaISO, dias: number): FechaISO {
  const d = aFecha(iso)
  d.setUTCDate(d.getUTCDate() + dias)
  return aISO(d)
}

/** 1 = lunes … 7 = domingo (ISO-8601, igual que `extract(isodow)` en Postgres). */
export function diaIso(iso: FechaISO): number {
  const dia = aFecha(iso).getUTCDay()
  return dia === 0 ? 7 : dia
}

export function esFinDeSemana(iso: FechaISO): boolean {
  return diaIso(iso) >= 6
}

export function anioDe(iso: FechaISO): number {
  return Number(iso.slice(0, 4))
}

export function mesDe(iso: FechaISO): number {
  return Number(iso.slice(5, 7))
}

/** Días de calendario entre dos fechas (fin - inicio). */
export function diferenciaEnDias(inicio: FechaISO, fin: FechaISO): number {
  return Math.round((aFecha(fin).getTime() - aFecha(inicio).getTime()) / 86_400_000)
}

/** Todas las fechas del rango cerrado [inicio, fin]. */
export function rangoDeFechas(inicio: FechaISO, fin: FechaISO): FechaISO[] {
  const total = diferenciaEnDias(inicio, fin)
  if (total < 0) return []
  return Array.from({ length: total + 1 }, (_, i) => sumarDias(inicio, i))
}

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
] as const

const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'] as const

export function formatoLargo(iso: FechaISO): string {
  const d = aFecha(iso)
  const nombreDia = DIAS[diaIso(iso) - 1]
  const nombreMes = MESES[d.getUTCMonth()]
  return `${nombreDia} ${d.getUTCDate()} de ${nombreMes} de ${d.getUTCFullYear()}`
}

export function formatoCorto(iso: FechaISO): string {
  const d = aFecha(iso)
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${d.getUTCFullYear()}`
}

export function nombreMes(mes: number): string {
  return MESES[mes - 1] ?? ''
}

/** Primer día del mes que contiene la fecha. */
export function inicioDeMes(iso: FechaISO): FechaISO {
  return `${iso.slice(0, 7)}-01`
}

/** Rejilla de 6 semanas que empieza en lunes, para pintar un mes completo. */
export function rejillaDelMes(mes: FechaISO): FechaISO[] {
  const primero = inicioDeMes(mes)
  const desplazamiento = diaIso(primero) - 1
  const arranque = sumarDias(primero, -desplazamiento)
  return Array.from({ length: 42 }, (_, i) => sumarDias(arranque, i))
}
