import { useCallback, useEffect, useState } from 'react'
import { Aviso, Cargando } from '../../components/Cargando'
import { cargarBloqueos, eliminarBloqueo, guardarBloqueo, reservasAfectadas } from '../../lib/api'
import { formatoCorto, type FechaISO } from '../../domain/fechas'
import type { Bloqueo, EstadoReserva, TipoBloqueo } from '../../lib/tipos'

const TIPOS: TipoBloqueo[] = ['feriado', 'personal', 'otro']

interface Afectada {
  id: string; codigo_reserva: string; centro: string
  fecha_inicio: FechaISO; fecha_fin: FechaISO; estado: EstadoReserva
}

export default function PanelBloqueos() {
  const [bloqueos, setBloqueos] = useState<Bloqueo[]>([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [editando, setEditando] = useState<string | null>(null)
  const [inicio, setInicio] = useState('')
  const [fin, setFin] = useState('')
  const [tipo, setTipo] = useState<TipoBloqueo>('personal')
  const [descripcion, setDescripcion] = useState('')
  const [afectadas, setAfectadas] = useState<Afectada[] | null>(null)
  const [guardando, setGuardando] = useState(false)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      setBloqueos(await cargarBloqueos())
      setError(null)
    } catch {
      setError('No pudimos cargar los bloqueos.')
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => { void recargar() }, [recargar])

  const rangoValido = inicio !== '' && fin !== '' && fin >= inicio

  // Regla 7: antes de guardar mostramos qué reservas quedarían dentro del
  // bloqueo. El sistema advierte; nunca cancela nada por su cuenta.
  useEffect(() => {
    if (!rangoValido) { setAfectadas(null); return }
    let vigente = true
    reservasAfectadas(inicio as FechaISO, fin as FechaISO)
      .then((r) => { if (vigente) setAfectadas(r) })
      .catch(() => { if (vigente) setAfectadas(null) })
    return () => { vigente = false }
  }, [inicio, fin, rangoValido])

  function limpiar() {
    setEditando(null); setInicio(''); setFin('')
    setTipo('personal'); setDescripcion(''); setAfectadas(null)
  }

  async function guardar() {
    if (!rangoValido) return
    setGuardando(true)
    try {
      await guardarBloqueo({
        ...(editando ? { id: editando } : {}),
        fecha_inicio: inicio as FechaISO,
        fecha_fin: fin as FechaISO,
        tipo,
        descripcion: descripcion.trim() || null,
      })
      limpiar()
      await recargar()
    } catch {
      setError('No se pudo guardar el bloqueo.')
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="space-y-5">
      <section className="tarjeta">
        <h2 className="mb-3 text-lg font-semibold">
          {editando ? 'Editar bloqueo' : 'Nuevo bloqueo'}
        </h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="etiqueta" htmlFor="b-inicio">Desde</label>
            <input id="b-inicio" type="date" className="campo" value={inicio}
                   onChange={(e) => setInicio(e.target.value)} />
          </div>
          <div>
            <label className="etiqueta" htmlFor="b-fin">Hasta</label>
            <input id="b-fin" type="date" className="campo" value={fin} min={inicio}
                   onChange={(e) => setFin(e.target.value)} />
          </div>
          <div>
            <label className="etiqueta" htmlFor="b-tipo">Tipo</label>
            <select id="b-tipo" className="campo" value={tipo}
                    onChange={(e) => setTipo(e.target.value as TipoBloqueo)}>
              {TIPOS.map((t) => <option key={t} value={t} className="capitalize">{t}</option>)}
            </select>
          </div>
          <div>
            <label className="etiqueta" htmlFor="b-desc">Descripción</label>
            <input id="b-desc" className="campo" value={descripcion}
                   onChange={(e) => setDescripcion(e.target.value)}
                   placeholder="Vacaciones, capacitación…" />
          </div>
        </div>

        {inicio !== '' && fin !== '' && !rangoValido && (
          <div className="mt-3"><Aviso tono="error">La fecha final no puede ser anterior a la inicial.</Aviso></div>
        )}

        {afectadas && afectadas.length > 0 && (
          <div className="mt-3">
            <Aviso tono="alerta">
              <p className="font-semibold">
                Este bloqueo choca con {afectadas.length} reserva{afectadas.length > 1 ? 's' : ''}.
              </p>
              <p className="mt-1">
                No se cancelará ninguna. Revísalas y coordina el cambio con cada centro.
              </p>
              <ul className="mt-2 space-y-1">
                {afectadas.map((a) => (
                  <li key={a.id}>
                    • {a.centro} — {formatoCorto(a.fecha_inicio)} a {formatoCorto(a.fecha_fin)}{' '}
                    <span className="font-mono text-xs">{a.codigo_reserva}</span>
                  </li>
                ))}
              </ul>
            </Aviso>
          </div>
        )}

        <div className="mt-4 flex gap-2">
          {editando && (
            <button type="button" className="boton-secundario flex-1" onClick={limpiar}>
              Cancelar
            </button>
          )}
          <button
            type="button" className="boton-primario flex-1"
            disabled={!rangoValido || guardando} onClick={guardar}
          >
            {guardando ? 'Guardando…' : editando ? 'Guardar cambios' : 'Crear bloqueo'}
          </button>
        </div>
      </section>

      {error && <Aviso tono="error">{error}</Aviso>}
      {cargando && <Cargando />}

      {!cargando && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Bloqueos registrados</h2>
          {bloqueos.length === 0 && <Aviso>Todavía no hay bloqueos.</Aviso>}
          <ul className="space-y-2">
            {bloqueos.map((b) => (
              <li key={b.id} className="tarjeta flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium">
                    {formatoCorto(b.fecha_inicio)}
                    {b.fecha_fin !== b.fecha_inicio && ` → ${formatoCorto(b.fecha_fin)}`}
                  </p>
                  <p className="text-sm capitalize text-slate-600">
                    {b.tipo}{b.descripcion ? ` · ${b.descripcion}` : ''}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button" className="boton-secundario px-3 py-1.5 text-sm"
                    onClick={() => {
                      setEditando(b.id); setInicio(b.fecha_inicio); setFin(b.fecha_fin)
                      setTipo(b.tipo); setDescripcion(b.descripcion ?? '')
                    }}
                  >
                    Editar
                  </button>
                  <button
                    type="button" className="boton-peligro px-3 py-1.5 text-sm"
                    onClick={async () => {
                      if (!confirm('¿Eliminar este bloqueo? Los días vuelven a quedar disponibles.')) return
                      await eliminarBloqueo(b.id)
                      await recargar()
                    }}
                  >
                    Eliminar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
