import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
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
  const [sesion, setSesion] = useState<Session | null>(null)
  const [listo, setListo] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSesion(data.session)
      setListo(true)
      if (!data.session) navegar('/admin/entrar', { replace: true })
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_evento, nueva) => {
      setSesion(nueva)
      if (!nueva) navegar('/admin/entrar', { replace: true })
    })

    return () => sub.subscription.unsubscribe()
  }, [navegar])

  if (!listo) return <Cargando texto="Verificando sesión…" />
  if (!sesion) return null

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <p className="font-bold text-marca-700">Sánchez Contadores</p>
          <button
            type="button"
            className="text-sm font-medium text-slate-600 underline"
            onClick={() => supabase.auth.signOut()}
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
