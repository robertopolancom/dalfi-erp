import { supabase, invocarFuncion } from './supabase'
import type { DiaDisponibilidad } from '../domain/calendario'
import type {
  Bloqueo, Centro, CentroPublico, Configuracion, ConfiguracionPublica, Feriado,
  ReservaConCentro, ResumenReserva, SolicitudConReserva, EstadoReserva, TipoBloqueo,
} from './tipos'
import type { FechaISO } from '../domain/fechas'

// --- Lectura pública (anon, vía vistas con RLS resuelto en el servidor) ------

export async function cargarCentrosPublicos(): Promise<CentroPublico[]> {
  const { data, error } = await supabase
    .from('centros_publicos')
    .select('id, nombre, duracion_dias_laborables')
  if (error) throw error
  return data ?? []
}

export async function cargarDisponibilidad(): Promise<DiaDisponibilidad[]> {
  const { data, error } = await supabase
    .from('disponibilidad_publica')
    .select('fecha, laborable, ocupados, max_simultaneos')
    .order('fecha')
  if (error) throw error
  return data ?? []
}

export async function cargarConfiguracionPublica(): Promise<ConfiguracionPublica> {
  const { data, error } = await supabase
    .from('configuracion_publica')
    .select('anio_activo, max_simultaneos, ventana_inicio, ventana_fin')
    .single()
  if (error) throw error
  return data
}

// --- Escritura pública (siempre por Edge Function) --------------------------

export function reservar(entrada: {
  centro_id: string
  fecha_inicio: FechaISO
  correo_contacto: string
  telefono: string
}) {
  return invocarFuncion<{ reserva: ResumenReserva & { correo_contacto: string } }>(
    'crear-reserva',
    entrada,
  )
}

export function solicitarCambio(entrada: {
  codigo_reserva: string
  tipo: 'cambio' | 'cancelacion'
  nueva_fecha_inicio?: FechaISO
  motivo: string
}) {
  return invocarFuncion<{ solicitud_id: string }>('solicitar-cambio', entrada)
}

export async function consultarReserva(codigo: string) {
  const { data, error } = await supabase.rpc('consultar_reserva', { p_codigo: codigo })
  if (error) throw error
  return data as
    | { ok: true; reserva: ResumenReserva; solicitud_pendiente: unknown | null }
    | { ok: false; codigo_error: string; mensaje: string }
}

// --- Administración (requiere sesión autenticada) ---------------------------

export async function cargarReservas(filtros: {
  estado?: EstadoReserva | 'todos'
  mes?: number | 'todos'
  anio: number
}): Promise<ReservaConCentro[]> {
  let q = supabase
    .from('reservas')
    .select('*, centros(nombre)')
    .eq('anio', filtros.anio)
    .order('fecha_inicio')

  if (filtros.estado && filtros.estado !== 'todos') q = q.eq('estado', filtros.estado)

  if (filtros.mes && filtros.mes !== 'todos') {
    const mes = String(filtros.mes).padStart(2, '0')
    const ultimo = new Date(Date.UTC(filtros.anio, filtros.mes, 0)).getUTCDate()
    q = q
      .lte('fecha_inicio', `${filtros.anio}-${mes}-${ultimo}`)
      .gte('fecha_fin', `${filtros.anio}-${mes}-01`)
  }

  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as ReservaConCentro[]
}

export async function cambiarEstadoReserva(id: string, estado: EstadoReserva) {
  const { error } = await supabase.from('reservas').update({ estado }).eq('id', id)
  if (error) throw error
}

export async function cargarCentros(): Promise<Centro[]> {
  const { data, error } = await supabase.from('centros').select('*').order('nombre')
  if (error) throw error
  return (data ?? []) as Centro[]
}

export async function guardarCentro(centro: Partial<Centro> & { nombre: string }) {
  const fila = {
    nombre: centro.nombre.trim(),
    correo_contacto: centro.correo_contacto?.trim() || null,
    telefono: centro.telefono?.trim() || null,
    duracion_dias_laborables: centro.duracion_dias_laborables ?? 5,
    activo: centro.activo ?? true,
  }
  const { error } = centro.id
    ? await supabase.from('centros').update(fila).eq('id', centro.id)
    : await supabase.from('centros').insert(fila)
  if (error) throw error
}

export async function cargarBloqueos(): Promise<Bloqueo[]> {
  const { data, error } = await supabase.from('bloqueos').select('*').order('fecha_inicio')
  if (error) throw error
  return (data ?? []) as Bloqueo[]
}

export async function reservasAfectadas(inicio: FechaISO, fin: FechaISO) {
  const { data, error } = await supabase.rpc('reservas_afectadas_por_rango', {
    p_inicio: inicio,
    p_fin: fin,
  })
  if (error) throw error
  return (data ?? []) as {
    id: string; codigo_reserva: string; centro: string
    fecha_inicio: FechaISO; fecha_fin: FechaISO; estado: EstadoReserva
  }[]
}

export async function guardarBloqueo(bloqueo: {
  id?: string; fecha_inicio: FechaISO; fecha_fin: FechaISO
  tipo: TipoBloqueo; descripcion: string | null
}) {
  const fila = {
    fecha_inicio: bloqueo.fecha_inicio,
    fecha_fin: bloqueo.fecha_fin,
    tipo: bloqueo.tipo,
    descripcion: bloqueo.descripcion,
  }
  const { error } = bloqueo.id
    ? await supabase.from('bloqueos').update(fila).eq('id', bloqueo.id)
    : await supabase.from('bloqueos').insert(fila)
  if (error) throw error
}

export async function eliminarBloqueo(id: string) {
  const { error } = await supabase.from('bloqueos').delete().eq('id', id)
  if (error) throw error
}

export async function cargarSolicitudes(estado: 'pendiente' | 'todas' = 'pendiente') {
  let q = supabase
    .from('solicitudes_cambio')
    .select('*, reservas(codigo_reserva, fecha_inicio, fecha_fin, estado, correo_contacto, centros(nombre))')
    .order('creado_en', { ascending: false })
  if (estado !== 'todas') q = q.eq('estado', estado)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as SolicitudConReserva[]
}

/**
 * Se resuelve a través de la Edge Function y no por RPC directa, para que el
 * correo al centro salga en la misma operación. La autorización sigue siendo de
 * Postgres: la función reenvía el JWT de la contadora.
 */
export async function resolverSolicitud(id: string, aprobar: boolean, nota: string | null) {
  const r = await invocarFuncion<{ accion: 'aprobada' | 'rechazada' }>(
    'resolver-solicitud',
    { solicitud_id: id, aprobar, nota },
    { conSesion: true },
  )
  return r.ok
    ? { ok: true as const, accion: r.datos.accion }
    : { ok: false as const, mensaje: r.mensaje, codigo_error: r.codigo }
}

export async function cargarFeriados(anio: number): Promise<Feriado[]> {
  const { data, error } = await supabase
    .from('feriados').select('*').eq('anio', anio).order('fecha')
  if (error) throw error
  return (data ?? []) as Feriado[]
}

export async function guardarFeriado(f: { fecha: FechaISO; nombre: string }) {
  const { error } = await supabase
    .from('feriados')
    .upsert({ fecha: f.fecha, nombre: f.nombre.trim() }, { onConflict: 'fecha' })
  if (error) throw error
}

export async function eliminarFeriado(fecha: FechaISO) {
  const { error } = await supabase.from('feriados').delete().eq('fecha', fecha)
  if (error) throw error
}

export async function cargarConfiguracion(): Promise<Configuracion> {
  const { data, error } = await supabase.from('configuracion').select('*').eq('id', 1).single()
  if (error) throw error
  return data as Configuracion
}

export async function guardarConfiguracion(config: Partial<Configuracion>) {
  const { error } = await supabase.from('configuracion').update(config).eq('id', 1)
  if (error) throw error
}
