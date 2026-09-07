import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { entrar, sesionActual } from '../../lib/api'
import { Aviso } from '../../components/Cargando'

export default function PaginaLogin() {
  const navegar = useNavigate()
  const [correo, setCorreo] = useState('')
  const [clave, setClave] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let vigente = true
    sesionActual().then((admin) => {
      if (vigente && admin) navegar('/admin/calendario', { replace: true })
    })
    return () => { vigente = false }
  }, [navegar])

  async function iniciar(e: React.FormEvent) {
    e.preventDefault()
    setEnviando(true)
    setError(null)

    const r = await entrar(correo, clave)
    setEnviando(false)

    // El servidor responde lo mismo si el correo no existe o si la contraseña
    // falla, así que no hay que distinguir aquí.
    if (!r.ok) { setError(r.mensaje); return }
    navegar('/admin/calendario', { replace: true })
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-xl font-bold text-marca-700">Sánchez Contadores</h1>
      <p className="mb-6 text-sm text-slate-600">Panel de administración</p>

      <form className="tarjeta space-y-4" onSubmit={iniciar}>
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
