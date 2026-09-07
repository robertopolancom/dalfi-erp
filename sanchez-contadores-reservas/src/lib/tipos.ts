import type { FechaISO } from '../domain/fechas'

export type EstadoReserva = 'reservada' | 'en_proceso' | 'entregada' | 'cancelada'
export type TipoBloqueo = 'feriado' | 'personal' | 'otro'
export type TipoSolicitud = 'cambio' | 'cancelacion'
export type EstadoSolicitud = 'pendiente' | 'aprobada' | 'rechazada'

export interface CentroPublico {
  id: string
  nombre: string
  duracion_dias_laborables: number
}

export interface Centro extends CentroPublico {
  correo_contacto: string | null
  telefono: string | null
  activo: boolean
  creado_en: string
}

export interface ConfiguracionPublica {
  anio_activo: number
  max_simultaneos: number
  ventana_inicio: FechaISO
  ventana_fin: FechaISO
}

export interface Configuracion {
  id: number
  ventana_inicio_mes: number
  ventana_inicio_dia: number
  ventana_fin_mes: number
  ventana_fin_dia: number
  max_simultaneos: number
  anio_activo: number
}

export interface Reserva {
  id: string
  centro_id: string
  anio: number
  fecha_inicio: FechaISO
  fecha_fin: FechaISO
  duracion_dias_laborables: number
  estado: EstadoReserva
  codigo_reserva: string
  correo_contacto: string
  telefono: string
  creado_en: string
}

export interface ReservaConCentro extends Reserva {
  centros: { nombre: string } | null
}

export interface Bloqueo {
  id: string
  fecha_inicio: FechaISO
  fecha_fin: FechaISO
  tipo: TipoBloqueo
  descripcion: string | null
  creado_en: string
}

export interface Feriado {
  fecha: FechaISO
  nombre: string
  anio: number
  trasladado: boolean
  fecha_original: FechaISO | null
}

export interface Solicitud {
  id: string
  reserva_id: string
  tipo: TipoSolicitud
  nueva_fecha_inicio: FechaISO | null
  motivo: string
  estado: EstadoSolicitud
  nota_resolucion: string | null
  creado_en: string
  resuelta_en: string | null
}

export interface SolicitudConReserva extends Solicitud {
  reservas: (Pick<Reserva, 'codigo_reserva' | 'fecha_inicio' | 'fecha_fin' | 'estado' | 'correo_contacto'>
    & { centros: { nombre: string } | null }) | null
}

export interface ResumenReserva {
  codigo_reserva: string
  centro: string
  fecha_inicio: FechaISO
  fecha_fin: FechaISO
  duracion: number
  estado: EstadoReserva
}

export const ETIQUETA_RESERVA: Record<EstadoReserva, string> = {
  reservada: 'Reservada',
  en_proceso: 'En proceso',
  entregada: 'Entregada',
  cancelada: 'Cancelada',
}

export const ETIQUETA_SOLICITUD: Record<TipoSolicitud, string> = {
  cambio: 'Cambio de fecha',
  cancelacion: 'Cancelación',
}
