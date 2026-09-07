import { useCallback, useEffect, useState } from 'react'
import { Aviso, Cargando } from '../../components/Cargando'
import {
  cargarConfiguracion, cargarFeriados, eliminarFeriado, guardarConfiguracion, guardarFeriado,
} from '../../lib/api'
import { formatoLargo, type FechaISO } from '../../domain/fechas'
import type { Configuracion, Feriado } from '../../lib/tipos'

export default function PanelAjustes() {
  const [config, setConfig] = useState<Configuracion | null>(null)
  const [feriados, setFeriados] = useState<Feriado[]>([])
  const [anioVista, setAnioVista] = useState<number | null>(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [guardado, setGuardado] = useState(false)

  const [nuevaFecha, setNuevaFecha] = useState('')
  const [nuevoNombre, setNuevoNombre] = useState('')

  const recargarFeriados = useCallback(async (anio: number) => {
    setFeriados(await cargarFeriados(anio))
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const c = await cargarConfiguracion()
        setConfig(c)
        setAnioVista(c.anio_activo)
        await recargarFeriados(c.anio_activo)
      } catch {
        setError('No pudimos cargar los ajustes.')
      } finally {
        setCargando(false)
      }
    })()
  }, [recargarFeriados])

  async function guardar() {
    if (!config) return
    setError(null)
    try {
      await guardarConfiguracion({
        ventana_inicio_mes: config.ventana_inicio_mes,
        ventana_inicio_dia: config.ventana_inicio_dia,
        ventana_fin_mes: config.ventana_fin_mes,
        ventana_fin_dia: config.ventana_fin_dia,
        max_simultaneos: config.max_simultaneos,
        anio_activo: config.anio_activo,
      })
      setGuardado(true)
      setTimeout(() => setGuardado(false), 3000)
    } catch {
      setError('No se pudo guardar la configuración.')
    }
  }

  if (cargando) return <Cargando />
  if (!config || anioVista === null) return <Aviso tono="error">{error ?? 'Sin datos.'}</Aviso>

  return (
    <div className="space-y-5">
      <section className="tarjeta">
        <h2 className="mb-3 text-lg font-semibold">Temporada y capacidad</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="etiqueta" htmlFor="a-anio">Año activo</label>
            <input
              id="a-anio" type="number" min={2020} max={2100} className="campo"
              value={config.anio_activo}
              onChange={(e) => setConfig({ ...config, anio_activo: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="etiqueta" htmlFor="a-max">Centros simultáneos como máximo</label>
            <input
              id="a-max" type="number" min={1} max={20} className="campo"
              value={config.max_simultaneos}
              onChange={(e) => setConfig({ ...config, max_simultaneos: Number(e.target.value) })}
            />
          </div>
          <fieldset className="sm:col-span-2">
            <legend className="etiqueta">Ventana de reservas</legend>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>Del día</span>
              <input type="number" min={1} max={31} className="campo w-20"
                     value={config.ventana_inicio_dia} aria-label="Día de inicio"
                     onChange={(e) => setConfig({ ...config, ventana_inicio_dia: Number(e.target.value) })} />
              <span>del mes</span>
              <input type="number" min={1} max={12} className="campo w-20"
                     value={config.ventana_inicio_mes} aria-label="Mes de inicio"
                     onChange={(e) => setConfig({ ...config, ventana_inicio_mes: Number(e.target.value) })} />
              <span>al día</span>
              <input type="number" min={1} max={31} className="campo w-20"
                     value={config.ventana_fin_dia} aria-label="Día de cierre"
                     onChange={(e) => setConfig({ ...config, ventana_fin_dia: Number(e.target.value) })} />
              <span>del mes</span>
              <input type="number" min={1} max={12} className="campo w-20"
                     value={config.ventana_fin_mes} aria-label="Mes de cierre"
                     onChange={(e) => setConfig({ ...config, ventana_fin_mes: Number(e.target.value) })} />
            </div>
          </fieldset>
        </div>

        {error && <div className="mt-3"><Aviso tono="error">{error}</Aviso></div>}
        {guardado && <div className="mt-3"><Aviso tono="exito">Configuración guardada.</Aviso></div>}

        <button type="button" className="boton-primario mt-4 w-full sm:w-auto" onClick={guardar}>
          Guardar configuración
        </button>
      </section>

      <section className="tarjeta">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Feriados</h2>
          <div className="flex items-center gap-2">
            <label className="text-sm text-slate-600" htmlFor="a-anio-fer">Año</label>
            <input
              id="a-anio-fer" type="number" className="campo w-28" value={anioVista}
              onChange={(e) => {
                const a = Number(e.target.value)
                setAnioVista(a)
                if (a > 2000) void recargarFeriados(a)
              }}
            />
          </div>
        </div>

        <div className="mb-4 grid gap-2 sm:grid-cols-[auto_1fr_auto]">
          <input type="date" className="campo" value={nuevaFecha}
                 aria-label="Fecha del feriado"
                 onChange={(e) => setNuevaFecha(e.target.value)} />
          <input className="campo" placeholder="Nombre del feriado" value={nuevoNombre}
                 aria-label="Nombre del feriado"
                 onChange={(e) => setNuevoNombre(e.target.value)} />
          <button
            type="button" className="boton-secundario"
            disabled={nuevaFecha === '' || nuevoNombre.trim() === ''}
            onClick={async () => {
              await guardarFeriado({ fecha: nuevaFecha as FechaISO, nombre: nuevoNombre })
              setNuevaFecha(''); setNuevoNombre('')
              await recargarFeriados(anioVista)
            }}
          >
            Agregar
          </button>
        </div>

        {feriados.length === 0 && <Aviso>No hay feriados registrados para {anioVista}.</Aviso>}

        <ul className="divide-y divide-slate-100">
          {feriados.map((f) => (
            <li key={f.fecha} className="flex items-center justify-between gap-3 py-2">
              <div>
                <p className="text-sm font-medium">{f.nombre}</p>
                <p className="text-sm text-slate-600">
                  {formatoLargo(f.fecha)}
                  {f.trasladado && f.fecha_original && (
                    <span className="ml-1 text-xs text-amber-700">
                      (trasladado desde el {f.fecha_original}, Ley 139-97)
                    </span>
                  )}
                </p>
              </div>
              <button
                type="button" className="text-sm font-medium text-rose-700 underline"
                onClick={async () => {
                  if (!confirm(`¿Eliminar el feriado "${f.nombre}"?`)) return
                  await eliminarFeriado(f.fecha)
                  await recargarFeriados(anioVista)
                }}
              >
                Eliminar
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
