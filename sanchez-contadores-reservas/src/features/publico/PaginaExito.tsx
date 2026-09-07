import { Link, Navigate, useLocation } from 'react-router-dom'
import { Marco } from './PaginaReservar'
import { formatoLargo } from '../../domain/fechas'
import type { ResumenReserva } from '../../lib/tipos'

export default function PaginaExito() {
  const { state } = useLocation()
  const reserva = state as (ResumenReserva & { correo_contacto?: string }) | null

  if (!reserva?.codigo_reserva) return <Navigate to="/" replace />

  return (
    <Marco>
      <section className="tarjeta text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl">
          ✓
        </div>
        <h2 className="text-lg font-semibold">Reserva confirmada</h2>
        <p className="mt-1 text-sm text-slate-600">
          Guarda este código. Lo necesitas para consultar o cambiar tu fecha.
        </p>

        <p className="my-5 select-all rounded-lg border-2 border-dashed border-marca-300 bg-marca-50 py-4 text-2xl font-bold tracking-wider text-marca-700">
          {reserva.codigo_reserva}
        </p>

        <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-left">
          <Fila termino="Centro" valor={reserva.centro} />
          <Fila termino="Inicio" valor={formatoLargo(reserva.fecha_inicio)} />
          <Fila termino="Fin" valor={formatoLargo(reserva.fecha_fin)} />
          <Fila termino="Duración" valor={`${reserva.duracion} días laborables`} />
        </dl>

        {reserva.correo_contacto && (
          <p className="mt-4 text-sm text-slate-600">
            Te enviamos la confirmación a <strong>{reserva.correo_contacto}</strong>.
            Si no llega en unos minutos, revisa la carpeta de correo no deseado.
          </p>
        )}

        <Link to="/consulta" className="boton-secundario mt-5 w-full">
          Consultar mi reserva
        </Link>
      </section>
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
