import { useEffect, useMemo, useState } from 'react'
import { Aviso, Cargando } from '../../components/Cargando'
import { cargarConfiguracionPublica, cargarDisponibilidad, cargarReservas } from '../../lib/api'
import { construirCalendario, type DiaDisponibilidad, type Ventana } from '../../domain/calendario'
import {
  formatoCorto, inicioDeMes, mesDe, nombreMes, rejillaDelMes, sumarDias, type FechaISO,
} from '../../domain/fechas'
import { ETIQUETA_RESERVA, type EstadoReserva, type ReservaConCentro } from '../../lib/tipos'

const COLOR_ESTADO: Record<EstadoReserva, string> = {
  reservada:  'bg-marca-500',
  en_proceso: 'bg-amber-500',
  entregada:  'bg-emerald-500',
  cancelada:  'bg-slate-300',
}

const DIAS_CABECERA = ['L', 'M', 'M', 'J', 'V', 'S', 'D']

export default function PanelCalendario() {
  const [dias, setDias] = useState<DiaDisponibilidad[]>([])
  const [ventana, setVentana] = useState<Ventana | null>(null)
  const [reservas, setReservas] = useState<ReservaConCentro[]>([])
  const [mes, setMes] = useState<FechaISO | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cargando, setCargando] = useState(true)

  useEffect(() => {
    ;(async () => {
      try {
        const config = await cargarConfiguracionPublica()
        const [d, r] = await Promise.all([
          cargarDisponibilidad(),
          cargarReservas({ anio: config.anio_activo, estado: 'todos', mes: 'todos' }),
        ])
        setVentana({ inicio: config.ventana_inicio, fin: config.ventana_fin })
        setDias(d)
        setReservas(r)
        setMes(inicioDeMes(config.ventana_inicio))
      } catch {
        setError('No pudimos cargar el calendario.')
      } finally {
        setCargando(false)
      }
    })()
  }, [])

  const calendario = useMemo(() => construirCalendario(dias), [dias])

  /** Reservas activas que tocan cada día, para el contador de simultáneos. */
  const porDia = useMemo(() => {
    const mapa = new Map<FechaISO, ReservaConCentro[]>()
    for (const r of reservas) {
      if (r.estado === 'cancelada') continue
      for (let f = r.fecha_inicio; f <= r.fecha_fin; f = sumarDias(f, 1)) {
        const lista = mapa.get(f) ?? []
        lista.push(r)
        mapa.set(f, lista)
      }
    }
    return mapa
  }, [reservas])

  if (cargando) return <Cargando />
  if (error || !ventana || !mes) return <Aviso tono="error">{error ?? 'Sin datos.'}</Aviso>

  const rejilla = rejillaDelMes(mes)
  const mesActual = mesDe(mes)
  const maximo = dias[0]?.max_simultaneos ?? 3

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <button
          type="button" className="boton-secundario px-3 py-2"
          disabled={inicioDeMes(mes) <= inicioDeMes(ventana.inicio)}
          onClick={() => setMes(inicioDeMes(sumarDias(mes, -1)))}
        >‹</button>
        <h2 className="text-lg font-semibold capitalize">
          {nombreMes(mesActual)} {mes.slice(0, 4)}
        </h2>
        <button
          type="button" className="boton-secundario px-3 py-2"
          disabled={inicioDeMes(mes) >= inicioDeMes(ventana.fin)}
          onClick={() => setMes(inicioDeMes(sumarDias(mes, 32)))}
        >›</button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-slate-500">
        {DIAS_CABECERA.map((d, i) => <div key={i}>{d}</div>)}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {rejilla.map((fecha) => {
          const deOtroMes = mesDe(fecha) !== mesActual
          const info = calendario.get(fecha)
          const delDia = porDia.get(fecha) ?? []
          const activas = delDia.filter((r) => r.estado === 'reservada' || r.estado === 'en_proceso')
          const laborable = info?.laborable === true

          return (
            <div
              key={fecha}
              className={[
                'min-h-20 rounded-lg border p-1 text-xs',
                deOtroMes ? 'invisible' : '',
                !laborable ? 'border-slate-200 bg-slate-100' : 'border-slate-200 bg-white',
              ].join(' ')}
            >
              <div className="mb-1 flex items-center justify-between">
                <span className={laborable ? 'font-medium' : 'text-slate-400'}>
                  {Number(fecha.slice(8))}
                </span>
                {laborable && (
                  <span
                    className={`rounded px-1 text-[10px] font-semibold ${
                      activas.length >= maximo
                        ? 'bg-rose-100 text-rose-700'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                    title={`${activas.length} de ${maximo} centros simultáneos`}
                  >
                    {activas.length}/{maximo}
                  </span>
                )}
              </div>

              <ul className="space-y-0.5">
                {delDia.slice(0, 3).map((r) => (
                  <li key={r.id} className="flex items-center gap-1">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${COLOR_ESTADO[r.estado]}`} />
                    <span className="truncate text-[10px] leading-tight text-slate-700">
                      {r.centros?.nombre ?? '—'}
                    </span>
                  </li>
                ))}
                {delDia.length > 3 && (
                  <li className="text-[10px] text-slate-500">+{delDia.length - 3} más</li>
                )}
              </ul>
            </div>
          )
        })}
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-600">
        {(Object.keys(COLOR_ESTADO) as EstadoReserva[]).map((e) => (
          <li key={e} className="flex items-center gap-1.5">
            <span className={`h-3 w-3 rounded-full ${COLOR_ESTADO[e]}`} />
            {ETIQUETA_RESERVA[e]}
          </li>
        ))}
      </ul>

      <p className="text-xs text-slate-500">
        Temporada del {formatoCorto(ventana.inicio)} al {formatoCorto(ventana.fin)}.
        El contador de cada día muestra los centros activos frente al máximo simultáneo.
      </p>
    </div>
  )
}
