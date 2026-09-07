import { useCallback, useEffect, useState } from 'react'
import { Aviso, Cargando } from '../../components/Cargando'
import { cargarCentros, guardarCentro } from '../../lib/api'
import type { Centro } from '../../lib/tipos'

const VACIO = {
  id: undefined as string | undefined,
  nombre: '',
  correo_contacto: '',
  telefono: '',
  duracion_dias_laborables: 5,
  activo: true,
}

export default function PanelCentros() {
  const [centros, setCentros] = useState<Centro[]>([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ ...VACIO })
  const [guardando, setGuardando] = useState(false)
  const [busqueda, setBusqueda] = useState('')

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      setCentros(await cargarCentros())
      setError(null)
    } catch {
      setError('No pudimos cargar los centros.')
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => { void recargar() }, [recargar])

  async function guardar() {
    if (form.nombre.trim() === '') return
    setGuardando(true)
    setError(null)
    try {
      await guardarCentro({
        ...(form.id ? { id: form.id } : {}),
        nombre: form.nombre,
        correo_contacto: form.correo_contacto,
        telefono: form.telefono,
        duracion_dias_laborables: form.duracion_dias_laborables,
        activo: form.activo,
      })
      setForm({ ...VACIO })
      await recargar()
    } catch (e) {
      const mensaje = e instanceof Error ? e.message : ''
      setError(
        mensaje.includes('duplicate') || mensaje.includes('unique')
          ? 'Ya existe un centro con ese nombre.'
          : 'No se pudo guardar el centro.',
      )
    } finally {
      setGuardando(false)
    }
  }

  const filtrados = centros.filter((c) =>
    c.nombre.toLowerCase().includes(busqueda.trim().toLowerCase()),
  )

  return (
    <div className="space-y-5">
      <section className="tarjeta">
        <h2 className="mb-3 text-lg font-semibold">
          {form.id ? 'Editar centro' : 'Nuevo centro'}
        </h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="etiqueta" htmlFor="c-nombre">Nombre</label>
            <input id="c-nombre" className="campo" value={form.nombre}
                   onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
          </div>
          <div>
            <label className="etiqueta" htmlFor="c-correo">Correo de contacto</label>
            <input id="c-correo" type="email" className="campo" value={form.correo_contacto}
                   onChange={(e) => setForm({ ...form, correo_contacto: e.target.value })} />
          </div>
          <div>
            <label className="etiqueta" htmlFor="c-tel">Teléfono</label>
            <input id="c-tel" type="tel" className="campo" value={form.telefono}
                   onChange={(e) => setForm({ ...form, telefono: e.target.value })} />
          </div>
          <div>
            <label className="etiqueta" htmlFor="c-dur">Días laborables de trabajo</label>
            <input
              id="c-dur" type="number" min={1} max={60} className="campo"
              value={form.duracion_dias_laborables}
              onChange={(e) => setForm({
                ...form,
                duracion_dias_laborables: Math.max(1, Math.min(60, Number(e.target.value) || 1)),
              })}
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 pb-2.5 text-sm">
              <input
                type="checkbox" className="h-4 w-4" checked={form.activo}
                onChange={(e) => setForm({ ...form, activo: e.target.checked })}
              />
              Activo (aparece en el formulario público)
            </label>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          {form.id && (
            <button type="button" className="boton-secundario flex-1"
                    onClick={() => setForm({ ...VACIO })}>
              Cancelar
            </button>
          )}
          <button type="button" className="boton-primario flex-1"
                  disabled={guardando || form.nombre.trim() === ''} onClick={guardar}>
            {guardando ? 'Guardando…' : form.id ? 'Guardar cambios' : 'Crear centro'}
          </button>
        </div>
      </section>

      {error && <Aviso tono="error">{error}</Aviso>}
      {cargando && <Cargando />}

      {!cargando && (
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Centros ({centros.length})</h2>
            <input
              type="search" className="campo max-w-56" placeholder="Buscar…"
              value={busqueda} onChange={(e) => setBusqueda(e.target.value)}
            />
          </div>

          <ul className="space-y-2">
            {filtrados.map((c) => (
              <li key={c.id} className="tarjeta flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {c.nombre}
                    {!c.activo && (
                      <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-600">
                        Inactivo
                      </span>
                    )}
                  </p>
                  <p className="truncate text-sm text-slate-600">
                    {c.duracion_dias_laborables} días · {c.correo_contacto ?? 'sin correo'}
                    {c.telefono ? ` · ${c.telefono}` : ''}
                  </p>
                </div>
                <button
                  type="button" className="boton-secundario px-3 py-1.5 text-sm"
                  onClick={() => setForm({
                    id: c.id,
                    nombre: c.nombre,
                    correo_contacto: c.correo_contacto ?? '',
                    telefono: c.telefono ?? '',
                    duracion_dias_laborables: c.duracion_dias_laborables,
                    activo: c.activo,
                  })}
                >
                  Editar
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
