import { borrar, enviar, intentar, modificar, obtener, reemplazar } from './api-cliente'
import type { DiaDisponibilidad } from '../domain/calendario'
import type {
  Bloqueo, Centro, CentroPublico, Configuracion, ConfiguracionPublica, Feriado,
  ReservaConCentro, ResumenReserva, SolicitudConReserva, EstadoReserva, TipoBloqueo,
} from './tipos'
import type { FechaISO } from '../domain/fechas'

// --- Público ----------------------------------------------------------------

export const cargarCentrosPublicos = () =>
  obtener<CentroPublico[]>('/publico/centros')

export const cargarDisponibilidad = () =>
  obtener<DiaDisponibilidad[]>('/publico/disponibilidad')

export const cargarConfiguracionPublica = () =>
  obtener<ConfiguracionPublica>('/publico/configuracion')

export function reservar(entrada: {
  centro_id: string
  fecha_inicio: FechaISO
  correo_contacto: string
  telefono: string
}) {
  return intentar(() =>
    enviar<{ reserva: ResumenReserva & { correo_contacto: string } }>('/publico/reservas', entrada),
  )
}

export function solicitarCambio(entrada: {
  codigo_reserva: string
  tipo: 'cambio' | 'cancelacion'
  nueva_fecha_inicio?: FechaISO
  motivo: string
}) {
  return intentar(() => enviar<{ solicitud_id: string }>('/publico/solicitudes', entrada))
}

export function consultarReserva(codigo: string) {
  return intentar(() =>
    obtener<{ reserva: ResumenReserva; solicitud_pendiente: unknown | null }>(
      `/publico/reservas/${encodeURIComponent(codigo.trim().toUpperCase())}`,
    ),
  )
}

// --- Sesión de la contadora --------------------------------------------------

export interface Administrador {
  id: string
  correo: string
  nombre: string
}

export const entrar = (correo: string, clave: string) =>
  intentar(() => enviar<{ admin: Administrador }>('/admin/sesion', { correo, clave }))

export const salir = () => borrar<{ ok: true }>('/admin/sesion')

/** `null` si no hay sesión. No lanza: se usa para decidir si mostrar el panel. */
export async function sesionActual(): Promise<Administrador | null> {
  const r = await intentar(() => obtener<{ admin: Administrador }>('/admin/yo'))
  return r.ok ? r.datos.admin : null
}

// --- Administración ----------------------------------------------------------

export function cargarReservas(filtros: {
  estado?: EstadoReserva | 'todos'
  mes?: number | 'todos'
  anio: number
}) {
  const parametros = new URLSearchParams({
    anio: String(filtros.anio),
    estado: String(filtros.estado ?? 'todos'),
    mes: String(filtros.mes ?? 'todos'),
  })
  return obtener<ReservaConCentro[]>(`/admin/reservas?${parametros}`)
}

export const cambiarEstadoReserva = (id: string, estado: EstadoReserva) =>
  modificar<{ ok: true }>(`/admin/reservas/${id}`, { estado })

export const cargarCentros = () => obtener<Centro[]>('/admin/centros')

export function guardarCentro(centro: Partial<Centro> & { nombre: string }) {
  const cuerpo = {
    nombre: centro.nombre.trim(),
    correo_contacto: centro.correo_contacto?.trim() || null,
    telefono: centro.telefono?.trim() || null,
    duracion_dias_laborables: centro.duracion_dias_laborables ?? 5,
    activo: centro.activo ?? true,
  }
  return centro.id
    ? modificar<Centro>(`/admin/centros/${centro.id}`, cuerpo)
    : enviar<Centro>('/admin/centros', cuerpo)
}

export const cargarBloqueos = () => obtener<Bloqueo[]>('/admin/bloqueos')

export function reservasAfectadas(inicio: FechaISO, fin: FechaISO) {
  const parametros = new URLSearchParams({ inicio, fin })
  return obtener<{
    id: string; codigo_reserva: string; centro: string
    fecha_inicio: FechaISO; fecha_fin: FechaISO; estado: EstadoReserva
  }[]>(`/admin/bloqueos/afectadas?${parametros}`)
}

export function guardarBloqueo(bloqueo: {
  id?: string; fecha_inicio: FechaISO; fecha_fin: FechaISO
  tipo: TipoBloqueo; descripcion: string | null
}) {
  const cuerpo = {
    fecha_inicio: bloqueo.fecha_inicio,
    fecha_fin: bloqueo.fecha_fin,
    tipo: bloqueo.tipo,
    descripcion: bloqueo.descripcion,
  }
  return bloqueo.id
    ? modificar<Bloqueo>(`/admin/bloqueos/${bloqueo.id}`, cuerpo)
    : enviar<Bloqueo>('/admin/bloqueos', cuerpo)
}

export const eliminarBloqueo = (id: string) => borrar<{ ok: true }>(`/admin/bloqueos/${id}`)

export const cargarSolicitudes = (estado: 'pendiente' | 'todas' = 'pendiente') =>
  obtener<SolicitudConReserva[]>(`/admin/solicitudes?estado=${estado}`)

export function resolverSolicitud(id: string, aprobar: boolean, nota: string | null) {
  return intentar(() =>
    enviar<{ accion: 'aprobada' | 'rechazada' }>(
      `/admin/solicitudes/${id}/resolver`, { aprobar, nota },
    ),
  )
}

export const cargarFeriados = (anio: number) =>
  obtener<Feriado[]>(`/admin/feriados?anio=${anio}`)

export const guardarFeriado = (f: { fecha: FechaISO; nombre: string }) =>
  reemplazar<Feriado>('/admin/feriados', { fecha: f.fecha, nombre: f.nombre.trim() })

export const eliminarFeriado = (fecha: FechaISO) =>
  borrar<{ ok: true }>(`/admin/feriados/${fecha}`)

export const cargarConfiguracion = () => obtener<Configuracion>('/admin/configuracion')

export const guardarConfiguracion = (config: Omit<Configuracion, 'id'>) =>
  reemplazar<Configuracion>('/admin/configuracion', config)
