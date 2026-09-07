import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { Aviso } from '../../components/Cargando'

export default function PaginaLogin() {
  const navegar = useNavigate()
  const [correo, setCorreo] = useState('')
  const [clave, setClave] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navegar('/admin/calendario', { replace: true })
    })
  }, [navegar])

  async function entrar(e: React.FormEvent) {
    e.preventDefault()
    setEnviando(true)
    setError(null)

    const { error: err } = await supabase.auth.signInWithPassword({
      email: correo.trim(),
      password: clave,
    })

    setEnviando(false)
    if (err) {
      // Mensaje genérico a propósito: no revelamos si el correo existe.
      setError('Correo o contraseña incorrectos.')
      return
    }
    navegar('/admin/calendario', { replace: true })
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-xl font-bold text-marca-700">Sánchez Contadores</h1>
      <p className="mb-6 text-sm text-slate-600">Panel de administración</p>

      <form className="tarjeta space-y-4" onSubmit={entrar}>
        <div>
          <label className="etiqueta" htmlFor="correo">Correo</label>
          <input
            id="correo" type="email" autoComplete="username" required
            className="campo" value={correo} onChange={(e) => setCorreo(e.target.value)}
          />
        </div>
        <div>
          <label className="etiqueta" htmlFor="clave">Contraseña</label>
          <input
            id="clave" type="password" autoComplete="current-password" required
            className="campo" value={clave} onChange={(e) => setClave(e.target.value)}
          />
        </div>

        {error && <Aviso tono="error">{error}</Aviso>}

        <button type="submit" className="boton-primario w-full" disabled={enviando}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  )
}
