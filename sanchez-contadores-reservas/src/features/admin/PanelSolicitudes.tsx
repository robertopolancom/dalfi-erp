import { useCallback, useEffect, useState } from 'react'
import { Aviso, Cargando } from '../../components/Cargando'
import { cargarSolicitudes, resolverSolicitud } from '../../lib/api'
import { formatoLargo } from '../../domain/fechas'
import { ETIQUETA_SOLICITUD, type SolicitudConReserva } from '../../lib/tipos'

export default function PanelSolicitudes() {
  const [solicitudes, setSolicitudes] = useState<SolicitudConReserva[]>([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [procesando, setProcesando] = useState<string | null>(null)
  const [notas, setNotas] = useState<Record<string, string>>({})

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      setSolicitudes(await cargarSolicitudes('pendiente'))
      setError(null)
    } catch {
      setError('No pudimos cargar las solicitudes.')
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => { void recargar() }, [recargar])

  async function resolver(id: string, aprobar: boolean) {
    setProcesando(id)
    setError(null)
    try {
      const r = await resolverSolicitud(id, aprobar, notas[id]?.trim() || null)
      if (!r.ok) {
        // El caso típico: al aprobar, la nueva fecha ya no cumple alguna regla
        // porque la disponibilidad cambió desde que se envió la solicitud.
        setError(r.mensaje ?? 'No se pudo resolver la solicitud.')
      } else {
        await recargar()
      }
    } catch {
      setError('No se pudo resolver la solicitud.')
    } finally {
      setProcesando(null)
    }
  }

  if (cargando) return <Cargando />

  return (
    <div className="space-y-4">
      {error && <Aviso tono="error">{error}</Aviso>}

      {solicitudes.length === 0 && <Aviso tono="exito">No hay solicitudes pendientes.</Aviso>}

      {solicitudes.map((s) => (
        <article key={s.id} className="tarjeta">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold">{s.reservas?.centros?.nombre ?? '—'}</p>
              <p className="font-mono text-xs text-slate-500">{s.reservas?.codigo_reserva}</p>
            </div>
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
              {ETIQUETA_SOLICITUD[s.tipo]}
            </span>
          </div>

          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-slate-500">Fecha actual:</dt>
              <dd>
                {s.reservas ? `${formatoLargo(s.reservas.fecha_inicio)} → ${formatoLargo(s.reservas.fecha_fin)}` : '—'}
              </dd>
            </div>
            {s.tipo === 'cambio' && s.nueva_fecha_inicio && (
              <div className="flex gap-2">
                <dt className="text-slate-500">Fecha solicitada:</dt>
                <dd className="font-medium text-marca-700">{formatoLargo(s.nueva_fecha_inicio)}</dd>
              </div>
            )}
            <div>
              <dt className="text-slate-500">Motivo:</dt>
              <dd className="mt-0.5 rounded-lg bg-slate-50 px-3 py-2">{s.motivo}</dd>
            </div>
          </dl>

          <label className="etiqueta mt-3" htmlFor={`nota-${s.id}`}>
            Nota para el centro (opcional)
          </label>
          <input
            id={`nota-${s.id}`} className="campo"
            value={notas[s.id] ?? ''}
            onChange={(e) => setNotas({ ...notas, [s.id]: e.target.value })}
            placeholder="Se incluye en el correo de respuesta"
          />

          <div className="mt-3 flex gap-2">
            <button
              type="button" className="boton-peligro flex-1"
              disabled={procesando === s.id}
              onClick={() => resolver(s.id, false)}
            >
              Rechazar
            </button>
            <button
              type="button" className="boton-primario flex-1"
              disabled={procesando === s.id}
              onClick={() => resolver(s.id, true)}
            >
              {procesando === s.id ? 'Procesando…' : 'Aprobar'}
            </button>
          </div>

          <p className="mt-2 text-xs text-slate-500">
            Al aprobar un cambio se revalidan la ventana, los días laborables y el cupo
            simultáneo sobre la nueva fecha.
          </p>
        </article>
      ))}
    </div>
  )
}
