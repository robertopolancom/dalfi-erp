export function Cargando({ texto = 'Cargando…' }: { texto?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-10 text-slate-500" role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-marca-600" />
      <span>{texto}</span>
    </div>
  )
}

export function Aviso({
  tono = 'info',
  children,
}: {
  tono?: 'info' | 'error' | 'exito' | 'alerta'
  children: React.ReactNode
}) {
  const estilos = {
    info: 'border-slate-200 bg-slate-50 text-slate-700',
    error: 'border-rose-200 bg-rose-50 text-rose-800',
    exito: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    alerta: 'border-amber-200 bg-amber-50 text-amber-900',
  }[tono]

  return (
    <div className={`rounded-lg border px-3 py-2.5 text-sm ${estilos}`} role={tono === 'error' ? 'alert' : undefined}>
      {children}
    </div>
  )
}
