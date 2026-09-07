import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { salir, sesionActual, type Administrador } from '../../lib/api'
import { Cargando } from '../../components/Cargando'

const SECCIONES = [
  { a: '/admin/calendario',  texto: 'Calendario' },
  { a: '/admin/reservas',    texto: 'Reservas' },
  { a: '/admin/solicitudes', texto: 'Solicitudes' },
  { a: '/admin/bloqueos',    texto: 'Bloqueos' },
  { a: '/admin/centros',     texto: 'Centros' },
  { a: '/admin/ajustes',     texto: 'Ajustes' },
]

export default function LayoutAdmin() {
  const navegar = useNavigate()
  const [admin, setAdmin] = useState<Administrador | null>(null)
  const [listo, setListo] = useState(false)

  useEffect(() => {
    let vigente = true
    sesionActual().then((sesion) => {
      if (!vigente) return
      setAdmin(sesion)
      setListo(true)
      if (!sesion) navegar('/admin/entrar', { replace: true })
    })
    return () => { vigente = false }
  }, [navegar])

  const cerrar = useCallback(async () => {
    await salir().catch(() => undefined)
    navegar('/admin/entrar', { replace: true })
  }, [navegar])

  if (!listo) return <Cargando texto="Verificando sesión…" />
  if (!admin) return null

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="font-bold text-marca-700">Sánchez Contadores</p>
            <p className="truncate text-xs text-slate-500">{admin.nombre}</p>
          </div>
          <button
            type="button"
            className="shrink-0 text-sm font-medium text-slate-600 underline"
            onClick={cerrar}
          >
            Salir
          </button>
        </div>

        <nav className="mx-auto max-w-5xl overflow-x-auto px-4 pb-2">
          <ul className="flex gap-1">
            {SECCIONES.map((s) => (
              <li key={s.a}>
                <NavLink
                  to={s.a}
                  className={({ isActive }) =>
                    `block whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${
                      isActive ? 'bg-marca-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                    }`
                  }
                >
                  {s.texto}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-5">
        <Outlet />
      </main>
    </div>
  )
}
