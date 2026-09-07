import { useCallback, useEffect, useState } from 'react'
import { Aviso, Cargando } from '../../components/Cargando'
import { cambiarEstadoReserva, cargarConfiguracionPublica, cargarReservas } from '../../lib/api'
import { formatoCorto, nombreMes } from '../../domain/fechas'
import { ETIQUETA_RESERVA, type EstadoReserva, type ReservaConCentro } from '../../lib/tipos'

const ESTADOS: (EstadoReserva | 'todos')[] = ['todos', 'reservada', 'en_proceso', 'entregada', 'cancelada']

/** Regla 8: el seguimiento avanza en un solo sentido. */
const SIGUIENTE: Partial<Record<EstadoReserva, EstadoReserva>> = {
  reservada: 'en_proceso',
  en_proceso: 'entregada',
}

export default function PanelReservas() {
  const [anio, setAnio] = useState<number | null>(null)
  const [estado, setEstado] = useState<EstadoReserva | 'todos'>('todos')
  const [mes, setMes] = useState<number | 'todos'>('todos')
  const [reservas, setReservas] = useState<ReservaConCentro[]>([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exportando, setExportando] = useState(false)

  // SheetJS pesa varios cientos de kB: se carga solo cuando se pulsa exportar.
  async function exportar() {
    if (anio === null) return
    setExportando(true)
    try {
      const { exportarReservas } = await import('../../lib/exportar')
      exportarReservas(reservas, anio)
    } catch {
      setError('No se pudo generar el archivo de Excel.')
    } finally {
      setExportando(false)
    }
  }

  const recargar = useCallback(async (a: number) => {
    setCargando(true)
    try {
      setReservas(await cargarReservas({ anio: a, estado, mes }))
      setError(null)
    } catch {
      setError('No pudimos cargar las reservas.')
    } finally {
      setCargando(false)
    }
  }, [estado, mes])

  useEffect(() => {
    cargarConfiguracionPublica()
      .then((c) => { setAnio(c.anio_activo); return recargar(c.anio_activo) })
      .catch(() => { setError('No pudimos cargar la configuración.'); setCargando(false) })
  }, [recargar])

  async function avanzar(r: ReservaConCentro) {
    const siguiente = SIGUIENTE[r.estado]
    if (!siguiente || anio === null) return
    await cambiarEstadoReserva(r.id, siguiente)
    await recargar(anio)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="etiqueta" htmlFor="f-estado">Estado</label>
          <select
            id="f-estado" className="campo w-44" value={estado}
            onChange={(e) => setEstado(e.target.value as EstadoReserva | 'todos')}
          >
            {ESTADOS.map((e) => (
              <option key={e} value={e}>
                {e === 'todos' ? 'Todos' : ETIQUETA_RESERVA[e]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="etiqueta" htmlFor="f-mes">Mes</label>
          <select
            id="f-mes" className="campo w-44" value={mes}
            onChange={(e) => setMes(e.target.value === 'todos' ? 'todos' : Number(e.target.value))}
          >
            <option value="todos">Todos</option>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m} className="capitalize">{nombreMes(m)}</option>
            ))}
          </select>
        </div>

        <button
          type="button"
          className="boton-secundario ml-auto"
          disabled={reservas.length === 0 || anio === null || exportando}
          onClick={exportar}
        >
          {exportando ? 'Generando…' : 'Exportar a Excel'}
        </button>
      </div>

      {error && <Aviso tono="error">{error}</Aviso>}
      {cargando && <Cargando />}

      {!cargando && reservas.length === 0 && (
        <Aviso>No hay reservas que coincidan con estos filtros.</Aviso>
      )}

      {!cargando && reservas.length > 0 && (
        <>
          <p className="text-sm text-slate-600">{reservas.length} reservas</p>

          {/* Tabla en pantallas anchas */}
          <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white sm:block">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="px-3 py-2 font-medium">Centro</th>
                  <th className="px-3 py-2 font-medium">Inicio</th>
                  <th className="px-3 py-2 font-medium">Fin</th>
                  <th className="px-3 py-2 font-medium">Días</th>
                  <th className="px-3 py-2 font-medium">Estado</th>
                  <th className="px-3 py-2 font-medium">Código</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {reservas.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2">{r.centros?.nombre ?? '—'}</td>
                    <td className="px-3 py-2">{formatoCorto(r.fecha_inicio)}</td>
                    <td className="px-3 py-2">{formatoCorto(r.fecha_fin)}</td>
                    <td className="px-3 py-2">{r.duracion_dias_laborables}</td>
                    <td className="px-3 py-2">{ETIQUETA_RESERVA[r.estado]}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.codigo_reserva}</td>
                    <td className="px-3 py-2 text-right">
                      {SIGUIENTE[r.estado] && (
                        <button
                          type="button"
                          className="text-sm font-semibold text-marca-600 underline"
                          onClick={() => avanzar(r)}
                        >
                          Marcar {ETIQUETA_RESERVA[SIGUIENTE[r.estado]!].toLowerCase()}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Tarjetas en móvil */}
          <ul className="space-y-2 sm:hidden">
            {reservas.map((r) => (
              <li key={r.id} className="tarjeta">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium">{r.centros?.nombre ?? '—'}</p>
                  <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-xs">
                    {ETIQUETA_RESERVA[r.estado]}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  {formatoCorto(r.fecha_inicio)} → {formatoCorto(r.fecha_fin)} ·{' '}
                  {r.duracion_dias_laborables} días
                </p>
                <p className="font-mono text-xs text-slate-500">{r.codigo_reserva}</p>
                {SIGUIENTE[r.estado] && (
                  <button
                    type="button" className="boton-secundario mt-2 w-full"
                    onClick={() => avanzar(r)}
                  >
                    Marcar {ETIQUETA_RESERVA[SIGUIENTE[r.estado]!].toLowerCase()}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
