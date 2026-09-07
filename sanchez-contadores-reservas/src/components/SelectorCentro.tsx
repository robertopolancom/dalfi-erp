import { useMemo, useState } from 'react'
import type { CentroPublico } from '../lib/tipos'

/**
 * Desplegable con búsqueda. No admite texto libre: el centro siempre sale de la
 * lista precargada, así que el `centro_id` que se envía siempre existe.
 */
export default function SelectorCentro({
  centros,
  valor,
  onCambio,
}: {
  centros: CentroPublico[]
  valor: CentroPublico | null
  onCambio: (centro: CentroPublico | null) => void
}) {
  const [busqueda, setBusqueda] = useState('')
  const [abierto, setAbierto] = useState(false)

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    if (!q) return centros
    return centros.filter((c) => c.nombre.toLowerCase().includes(q))
  }, [centros, busqueda])

  if (valor && !abierto) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-marca-500 bg-marca-50 px-3 py-2.5">
        <div className="min-w-0">
          <p className="truncate font-medium text-marca-700">{valor.nombre}</p>
          <p className="text-sm text-marca-600">
            {valor.duracion_dias_laborables} días laborables de trabajo
          </p>
        </div>
        <button
          type="button"
          className="shrink-0 text-sm font-semibold text-marca-600 underline"
          onClick={() => {
            setAbierto(true)
            setBusqueda('')
          }}
        >
          Cambiar
        </button>
      </div>
    )
  }

  return (
    <div>
      <input
        type="search"
        className="campo"
        placeholder="Escribe el nombre de tu centro…"
        value={busqueda}
        autoComplete="off"
        onChange={(e) => setBusqueda(e.target.value)}
        onFocus={() => setAbierto(true)}
        aria-label="Buscar centro educativo"
      />

      <ul className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white">
        {filtrados.length === 0 && (
          <li className="px-3 py-3 text-sm text-slate-500">
            No encontramos ese centro. Verifica el nombre o escribe a la contadora.
          </li>
        )}
        {filtrados.map((centro) => (
          <li key={centro.id}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-slate-50"
              onClick={() => {
                onCambio(centro)
                setAbierto(false)
              }}
            >
              <span className="min-w-0 truncate">{centro.nombre}</span>
              <span className="shrink-0 text-xs text-slate-500">
                {centro.duracion_dias_laborables} días
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
