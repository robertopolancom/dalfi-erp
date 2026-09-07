import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Marco } from './PaginaReservar'
import Calendario from '../../components/Calendario'
import { Aviso } from '../../components/Cargando'
import {
  cargarConfiguracionPublica, cargarDisponibilidad, consultarReserva, solicitarCambio,
} from '../../lib/api'
import { construirCalendario, type DiaDisponibilidad, type Ventana } from '../../domain/calendario'
import { formatoLargo, type FechaISO } from '../../domain/fechas'
import { ETIQUETA_RESERVA, type ResumenReserva } from '../../lib/tipos'

export default function PaginaConsulta() {
  const [codigo, setCodigo] = useState('')
  const [buscando, setBuscando] = useState(false)
  const [reserva, setReserva] = useState<ResumenReserva | null>(null)
  const [pendiente, setPendiente] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [modo, setModo] = useState<'ninguno' | 'cambio' | 'cancelacion'>('ninguno')
  const [nuevaFecha, setNuevaFecha] = useState<FechaISO | null>(null)
  const [motivo, setMotivo] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [exito, setExito] = useState<string | null>(null)

  const [dias, setDias] = useState<DiaDisponibilidad[]>([])
  const [ventana, setVentana] = useState<Ventana | null>(null)

  useEffect(() => {
    if (modo !== 'cambio' || ventana) return
    Promise.all([cargarDisponibilidad(), cargarConfiguracionPublica()])
      .then(([d, c]) => {
        setDias(d)
        setVentana({ inicio: c.ventana_inicio, fin: c.ventana_fin })
      })
      .catch(() => setError('No pudimos cargar el calendario.'))
  }, [modo, ventana])

  const calendario = useMemo(() => construirCalendario(dias), [dias])

  async function buscar() {
    setBuscando(true)
    setError(null)
    setExito(null)
    setReserva(null)
    setModo('ninguno')
    try {
      const r = await consultarReserva(codigo.trim())
      if (!r.ok) setError(r.mensaje)
      else {
        setReserva(r.reserva)
        setPendiente(r.solicitud_pendiente !== null)
      }
    } catch {
      setError('No pudimos consultar la reserva. Intenta de nuevo.')
    } finally {
      setBuscando(false)
    }
  }

  async function enviarSolicitud() {
    if (!reserva || modo === 'ninguno' || motivo.trim().length < 5) return
    if (modo === 'cambio' && !nuevaFecha) return

    setEnviando(true)
    setError(null)
    const r = await solicitarCambio({
      codigo_reserva: reserva.codigo_reserva,
      tipo: modo,
      ...(modo === 'cambio' && nuevaFecha ? { nueva_fecha_inicio: nuevaFecha } : {}),
      motivo: motivo.trim(),
    })
    setEnviando(false)

    if (!r.ok) { setError(r.mensaje); return }

    setExito(
      'Solicitud enviada. La contadora la revisará y te avisará por correo. ' +
      'Tu fecha actual sigue vigente hasta que la aprueben.',
    )
    setModo('ninguno')
    setMotivo('')
    setNuevaFecha(null)
    setPendiente(true)
  }

  return (
    <Marco>
      <section className="tarjeta">
        <h2 className="mb-1 text-lg font-semibold">Consulta tu reserva</h2>
        <p className="mb-4 text-sm text-slate-600">
          Escribe el código que recibiste al reservar.
        </p>

        <div className="flex gap-2">
          <input
            className="campo font-mono uppercase"
            placeholder="SC-2027-XXXXXX"
            value={codigo}
            autoCapitalize="characters"
            onChange={(e) => setCodigo(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter') void buscar() }}
            aria-label="Código de reserva"
          />
          <button
            type="button" className="boton-primario shrink-0"
            disabled={buscando || codigo.trim().length < 6} onClick={buscar}
          >
            {buscando ? '…' : 'Buscar'}
          </button>
        </div>

        {error && <div className="mt-3"><Aviso tono="error">{error}</Aviso></div>}
        {exito && <div className="mt-3"><Aviso tono="exito">{exito}</Aviso></div>}
      </section>

      {reserva && (
        <section className="tarjeta mt-4">
          <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            <Fila termino="Centro" valor={reserva.centro} />
            <Fila termino="Inicio" valor={formatoLargo(reserva.fecha_inicio)} />
            <Fila termino="Fin" valor={formatoLargo(reserva.fecha_fin)} />
            <Fila termino="Estado" valor={ETIQUETA_RESERVA[reserva.estado]} />
          </dl>

          {pendiente && (
            <div className="mt-4">
              <Aviso tono="alerta">
                Ya tienes una solicitud pendiente de revisión. Espera la respuesta de la
                contadora antes de enviar otra.
              </Aviso>
            </div>
          )}

          {!pendiente && reserva.estado !== 'cancelada' && reserva.estado !== 'entregada' && (
            <>
              {modo === 'ninguno' && (
                <div className="mt-4 flex gap-2">
                  <button type="button" className="boton-secundario flex-1" onClick={() => setModo('cambio')}>
                    Cambiar fecha
                  </button>
                  <button type="button" className="boton-peligro flex-1" onClick={() => setModo('cancelacion')}>
                    Cancelar
                  </button>
                </div>
              )}

              {modo !== 'ninguno' && (
                <div className="mt-4 space-y-4">
                  {modo === 'cambio' && ventana && (
                    <div>
                      <p className="etiqueta">Nueva fecha de inicio</p>
                      <Calendario
                        calendario={calendario}
                        ventana={ventana}
                        duracion={reserva.duracion}
                        seleccion={nuevaFecha}
                        onSeleccionar={setNuevaFecha}
                      />
                    </div>
                  )}

                  <div>
                    <label className="etiqueta" htmlFor="motivo">
                      Motivo {modo === 'cambio' ? 'del cambio' : 'de la cancelación'}
                    </label>
                    <textarea
                      id="motivo" className="campo" rows={3} value={motivo}
                      onChange={(e) => setMotivo(e.target.value)}
                      placeholder="Cuéntale brevemente a la contadora por qué…"
                    />
                  </div>

                  <Aviso>
                    Tu fecha actual no cambia hasta que la contadora apruebe la solicitud.
                  </Aviso>

                  <div className="flex gap-2">
                    <button
                      type="button" className="boton-secundario flex-1"
                      disabled={enviando}
                      onClick={() => { setModo('ninguno'); setMotivo(''); setNuevaFecha(null) }}
                    >
                      Atrás
                    </button>
                    <button
                      type="button" className="boton-primario flex-1"
                      disabled={enviando || motivo.trim().length < 5 || (modo === 'cambio' && !nuevaFecha)}
                      onClick={enviarSolicitud}
                    >
                      {enviando ? 'Enviando…' : 'Enviar solicitud'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}

      <p className="mt-6 text-center text-sm">
        <Link to="/" className="font-semibold text-marca-600 underline">Volver al inicio</Link>
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
