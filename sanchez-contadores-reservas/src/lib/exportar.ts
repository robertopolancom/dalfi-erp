import * as XLSX from 'xlsx'
import { formatoCorto } from '../domain/fechas'
import { ETIQUETA_RESERVA, type ReservaConCentro } from './tipos'

/**
 * Exportación a Excel desde el navegador. Se genera en cliente a propósito: los
 * datos ya están en pantalla y así no hace falta un endpoint que devuelva el
 * listado completo.
 *
 * Nota de dependencia: `xlsx` se instala desde el CDN oficial de SheetJS
 * (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`) y no desde npm,
 * porque el paquete de npm está congelado en 0.18.5, versión afectada por
 * CVE-2023-30533. Ver README.
 */
export function exportarReservas(reservas: ReservaConCentro[], anio: number): void {
  const filas = reservas.map((r) => ({
    'Centro':        r.centros?.nombre ?? '—',
    'Correo':        r.correo_contacto,
    'Teléfono':      r.telefono,
    'Fecha inicio':  formatoCorto(r.fecha_inicio),
    'Fecha fin':     formatoCorto(r.fecha_fin),
    'Duración (días laborables)': r.duracion_dias_laborables,
    'Estado':        ETIQUETA_RESERVA[r.estado],
    'Código':        r.codigo_reserva,
  }))

  const hoja = XLSX.utils.json_to_sheet(filas)
  hoja['!cols'] = [
    { wch: 34 }, { wch: 28 }, { wch: 16 }, { wch: 12 },
    { wch: 12 }, { wch: 26 }, { wch: 12 }, { wch: 16 },
  ]

  const libro = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(libro, hoja, `Reservas ${anio}`)

  const hoy = new Date().toISOString().slice(0, 10)
  XLSX.writeFile(libro, `reservas-${anio}-${hoy}.xlsx`)
}
