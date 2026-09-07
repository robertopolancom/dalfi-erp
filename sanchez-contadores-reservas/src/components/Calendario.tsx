import { useMemo, useState } from 'react'
import {
  ETIQUETA_ESTADO, calcularRango, estadoDia,
  type Calendario as TipoCalendario, type EstadoDia, type Ventana,
} from '../domain/calendario'
import {
  formatoCorto, inicioDeMes, mesDe, nombreMes, rejillaDelMes, sumarDias,
  type FechaISO,
} from '../domain/fechas'

const COLOR: Record<EstadoDia, string> = {
  'disponible':    'bg-emerald-50 text-emerald-900 border-emerald-200 hover:bg-emerald-100',
  'sin-cupo':      'bg-amber-50 text-amber-900 border-amber-200',
  'no-laborable':  'bg-slate-100 text-slate-400 border-slate-200',
  'no-cabe':       'bg-slate-100 text-slate-400 border-slate-200',
  'fuera-ventana': 'bg-transparent text-slate-300 border-transparent',
}

const LEYENDA: EstadoDia[] = ['disponible', 'sin-cupo', 'no-laborable', 'no-cabe']

const DIAS_CABECERA = ['L', 'M', 'M', 'J', 'V', 'S', 'D']

export default function Calendario({
  calendario,
  ventana,
  duracion,
  seleccion,
  onSeleccionar,
  mostrarOcupacion = false,
}: {
  calendario: TipoCalendario
  ventana: Ventana
  duracion: number | null
  seleccion: FechaISO | null
  onSeleccionar: (fecha: FechaISO) => void
  mostrarOcupacion?: boolean
}) {
  const [mes, setMes] = useState<FechaISO>(() =>
    inicioDeMes(seleccion ?? ventana.inicio),
  )

  const dias = useMemo(() => rejillaDelMes(mes), [mes])
  const mesActual = mesDe(mes)

  const rangoPrevisto = useMemo(() => {
    if (!seleccion || duracion === null) return null
    return calcularRango(seleccion, duracion, calendario, ventana)
  }, [seleccion, duracion, calendario, ventana])

  const enRango = useMemo(
    () => new Set(rangoPrevisto?.diasLaborables ?? []),
    [rangoPrevisto],
  )

  const puedeRetroceder = inicioDeMes(mes) > inicioDeMes(ventana.inicio)
  const puedeAvanzar = inicioDeMes(mes) < inicioDeMes(ventana.fin)

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          className="boton-secundario px-3 py-2"
          disabled={!puedeRetroceder}
          onClick={() => setMes(inicioDeMes(sumarDias(mes, -1)))}
          aria-label="Mes anterior"
        >
          ‹
        </button>
        <p className="text-base font-semibold capitalize">
          {nombreMes(mesActual)} {mes.slice(0, 4)}
        </p>
        <button
          type="button"
          className="boton-secundario px-3 py-2"
          disabled={!puedeAvanzar}
          onClick={() => setMes(inicioDeMes(sumarDias(mes, 32)))}
          aria-label="Mes siguiente"
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-slate-500">
        {DIAS_CABECERA.map((d, i) => (
          <div key={i} className="py-1">{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {dias.map((fecha) => {
          const deOtroMes = mesDe(fecha) !== mesActual
          const estado = estadoDia(fecha, calendario, ventana, duracion)
          const seleccionable = estado === 'disponible' && !deOtroMes
          const esInicio = fecha === seleccion
          const dentroRango = enRango.has(fecha)
          const info = calendario.get(fecha)

          return (
            <button
              key={fecha}
              type="button"
              disabled={!seleccionable}
              onClick={() => onSeleccionar(fecha)}
              aria-label={`${formatoCorto(fecha)} — ${ETIQUETA_ESTADO[estado]}`}
              aria-pressed={esInicio}
              className={[
                'relative flex aspect-square flex-col items-center justify-center rounded-lg border text-sm transition',
                deOtroMes ? 'invisible' : COLOR[estado],
                seleccionable ? 'cursor-pointer' : 'cursor-default',
                dentroRango && !esInicio ? 'ring-2 ring-inset ring-marca-300' : '',
                esInicio ? 'ring-2 ring-marca-600 ring-offset-1' : '',
              ].join(' ')}
            >
              <span className={esInicio ? 'font-bold' : ''}>{Number(fecha.slice(8))}</span>
              {mostrarOcupacion && info?.laborable && (
                <span className="text-[10px] leading-none opacity-70">
                  {info.ocupados}/{info.max_simultaneos}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-600">
        {LEYENDA.map((estado) => (
          <li key={estado} className="flex items-center gap-1.5">
            <span className={`inline-block h-3 w-3 rounded border ${COLOR[estado]}`} />
            {ETIQUETA_ESTADO[estado]}
          </li>
        ))}
      </ul>
    </div>
  )
}
