import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Calendario from '../../components/Calendario'
import SelectorCentro from '../../components/SelectorCentro'
import { Aviso, Cargando } from '../../components/Cargando'
import { cargarCentrosPublicos, cargarConfiguracionPublica, cargarDisponibilidad, reservar } from '../../lib/api'
import { calcularRango, construirCalendario, type DiaDisponibilidad, type Ventana } from '../../domain/calendario'
import { formatoCorto, formatoLargo, type FechaISO } from '../../domain/fechas'
import type { CentroPublico } from '../../lib/tipos'

type Paso = 'centro' | 'fecha' | 'contacto'

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const TELEFONO = /^[\d\s()+-]{10,20}$/

export default function PaginaReservar() {
  const navegar = useNavigate()

  const [centros, setCentros] = useState<CentroPublico[]>([])
  const [dias, setDias] = useState<DiaDisponibilidad[]>([])
  const [ventana, setVentana] = useState<Ventana | null>(null)
  const [anio, setAnio] = useState<number | null>(null)
  const [cargando, setCargando] = useState(true)
  const [errorCarga, setErrorCarga] = useState<string | null>(null)

  const [paso, setPaso] = useState<Paso>('centro')
  const [centro, setCentro] = useState<CentroPublico | null>(null)
  const [fecha, setFecha] = useState<FechaISO | null>(null)
  const [correo, setCorreo] = useState('')
  const [telefono, setTelefono] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null)

  useEffect(() => {
    let vigente = true
    ;(async () => {
      try {
        const [lista, disponibilidad, config] = await Promise.all([
          cargarCentrosPublicos(),
          cargarDisponibilidad(),
          cargarConfiguracionPublica(),
        ])
        if (!vigente) return
        setCentros(lista)
        setDias(disponibilidad)
        setVentana({ inicio: config.ventana_inicio, fin: config.ventana_fin })
        setAnio(config.anio_activo)
      } catch {
        if (vigente) setErrorCarga('No pudimos cargar el calendario. Recarga la página.')
      } finally {
        if (vigente) setCargando(false)
      }
    })()
    return () => { vigente = false }
  }, [])

  const calendario = useMemo(() => construirCalendario(dias), [dias])

  const rango = useMemo(() => {
    if (!fecha || !centro || !ventana) return null
    return calcularRango(fecha, centro.duracion_dias_laborables, calendario, ventana)
  }, [fecha, centro, calendario, ventana])

  const correoValido = CORREO.test(correo.trim())
  const telefonoValido = TELEFONO.test(telefono.trim())

  async function enviar() {
    if (!centro || !fecha || !correoValido || !telefonoValido) return
    setEnviando(true)
    setErrorEnvio(null)

    const resultado = await reservar({
      centro_id: centro.id,
      fecha_inicio: fecha,
      correo_contacto: correo.trim(),
      telefono: telefono.trim(),
    })

    if (!resultado.ok) {
      setEnviando(false)
      setErrorEnvio(resultado.mensaje)
      // Si el hueco se llenó mientras el usuario llenaba el formulario,
      // recargamos la disponibilidad para que vea el calendario actualizado.
      if (resultado.codigo === 'SIN_CUPO') {
        cargarDisponibilidad().then(setDias).catch(() => undefined)
        setPaso('fecha')
        setFecha(null)
      }
      return
    }

    navegar('/exito', { state: resultado.datos.reserva, replace: true })
  }

  if (cargando) return <Marco><Cargando /></Marco>
  if (errorCarga || !ventana || anio === null) {
    return <Marco><Aviso tono="error">{errorCarga ?? 'Configuración no disponible.'}</Aviso></Marco>
  }

  return (
    <Marco>
      <ol className="mb-5 flex gap-2 text-xs font-medium">
        {(['centro', 'fecha', 'contacto'] as const).map((p, i) => (
          <li
            key={p}
            className={`flex-1 rounded-full py-1 text-center ${
              paso === p ? 'bg-marca-600 text-white'
                : (['centro', 'fecha', 'contacto'] as const).indexOf(paso) > i
                  ? 'bg-marca-100 text-marca-700'
                  : 'bg-slate-200 text-slate-500'
            }`}
          >
            {i + 1}. {p === 'centro' ? 'Centro' : p === 'fecha' ? 'Fecha' : 'Contacto'}
          </li>
        ))}
      </ol>

      {paso === 'centro' && (
        <section className="tarjeta">
          <h2 className="mb-1 text-lg font-semibold">¿Cuál es tu centro educativo?</h2>
          <p className="mb-4 text-sm text-slate-600">
            Elige tu centro de la lista. Si no aparece, escribe a la contadora.
          </p>
          <SelectorCentro centros={centros} valor={centro} onCambio={setCentro} />
          <button
            type="button"
            className="boton-primario mt-4 w-full"
            disabled={!centro}
            onClick={() => setPaso('fecha')}
          >
            Continuar
          </button>
        </section>
      )}

      {paso === 'fecha' && centro && (
        <section className="tarjeta">
          <h2 className="mb-1 text-lg font-semibold">Elige la fecha de inicio</h2>
          <p className="mb-4 text-sm text-slate-600">
            Tu reporte toma <strong>{centro.duracion_dias_laborables} días laborables</strong>.
            Al tocar un día verás el rango completo que ocuparía.
          </p>

          <Calendario
            calendario={calendario}
            ventana={ventana}
            duracion={centro.duracion_dias_laborables}
            seleccion={fecha}
            onSeleccionar={setFecha}
          />

          {fecha && rango && (
            <div className="mt-4 rounded-lg border border-marca-200 bg-marca-50 p-3 text-sm">
              <p className="font-semibold text-marca-700">Rango previsto</p>
              <p className="text-marca-700">
                Del {formatoLargo(fecha)}<br />al {formatoLargo(rango.fin)}
              </p>
              <p className="mt-1 text-marca-600">
                {rango.diasLaborables.length} días laborables. No se cuentan fines de semana,
                feriados ni días bloqueados.
              </p>
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <button type="button" className="boton-secundario flex-1" onClick={() => setPaso('centro')}>
              Atrás
            </button>
            <button
              type="button"
              className="boton-primario flex-1"
              disabled={!fecha || !rango}
              onClick={() => setPaso('contacto')}
            >
              Continuar
            </button>
          </div>
        </section>
      )}

      {paso === 'contacto' && centro && fecha && rango && (
        <section className="tarjeta">
          <h2 className="mb-4 text-lg font-semibold">Confirma tu reserva</h2>

          <dl className="mb-5 divide-y divide-slate-100 rounded-lg border border-slate-200">
            <Fila termino="Centro" valor={centro.nombre} />
            <Fila termino="Inicio" valor={formatoLargo(fecha)} />
            <Fila termino="Fin" valor={formatoLargo(rango.fin)} />
            <Fila termino="Duración" valor={`${rango.diasLaborables.length} días laborables`} />
          </dl>

          <div className="space-y-4">
            <div>
              <label className="etiqueta" htmlFor="correo">Correo de contacto</label>
              <input
                id="correo" type="email" inputMode="email" autoComplete="email"
                className="campo" value={correo}
                onChange={(e) => setCorreo(e.target.value)}
                placeholder="direccion@centro.edu.do"
              />
              {correo && !correoValido && (
                <p className="mt-1 text-sm text-rose-700">Escribe un correo válido.</p>
              )}
            </div>

            <div>
              <label className="etiqueta" htmlFor="telefono">Teléfono</label>
              <input
                id="telefono" type="tel" inputMode="tel" autoComplete="tel"
                className="campo" value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                placeholder="809-000-0000"
              />
              {telefono && !telefonoValido && (
                <p className="mt-1 text-sm text-rose-700">Escribe un teléfono válido.</p>
              )}
            </div>
          </div>

          {errorEnvio && <div className="mt-4"><Aviso tono="error">{errorEnvio}</Aviso></div>}

          <div className="mt-5 flex gap-2">
            <button
              type="button" className="boton-secundario flex-1"
              disabled={enviando} onClick={() => setPaso('fecha')}
            >
              Atrás
            </button>
            <button
              type="button" className="boton-primario flex-1"
              disabled={enviando || !correoValido || !telefonoValido}
              onClick={enviar}
            >
              {enviando ? 'Reservando…' : 'Reservar'}
            </button>
          </div>
        </section>
      )}

      <p className="mt-6 text-center text-sm text-slate-600">
        ¿Ya reservaste?{' '}
        <Link to="/consulta" className="font-semibold text-marca-600 underline">
          Consulta o cambia tu reserva
        </Link>
      </p>

      <p className="mt-2 text-center text-xs text-slate-500">
        Temporada {anio}: del {formatoCorto(ventana.inicio)} al {formatoCorto(ventana.fin)}.
      </p>
    </Marco>
  )
}

function Fila({ termino, valor }: { termino: string; valor: string }) {
  return (
    <div className="flex justify-between gap-4 px-3 py-2.5 text-sm">
      <dt className="shrink-0 text-slate-500">{termino}</dt>
      <dd className="text-right font-medium">{valor}</dd>
    </div>
  )
}

export function Marco({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-lg px-4 py-6">
      <header className="mb-5">
        <h1 className="text-xl font-bold text-marca-700">Sánchez Contadores</h1>
        <p className="text-sm text-slate-600">
          Reserva la fecha de tu reporte contable anual
        </p>
      </header>
      {children}
    </main>
  )
}
