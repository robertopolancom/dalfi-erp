import { z } from 'zod'

/**
 * Validación de entrada en el servidor. El frontend valida también, pero esta
 * es la que cuenta: cualquiera puede llamar a la API sin pasar por la app.
 */

const uuid = z.string().uuid('Identificador inválido.')

const fecha = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida.')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Fecha inválida.')

const correo = z
  .string()
  .trim()
  .min(5)
  .max(200)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Escribe un correo válido.')

const telefono = z
  .string()
  .trim()
  .min(10, 'El teléfono es muy corto.')
  .max(20)
  .regex(/^[\d\s()+-]+$/, 'El teléfono solo admite números y los signos + ( ) -')

export const esquemaCrearReserva = z.object({
  centro_id: uuid,
  fecha_inicio: fecha,
  correo_contacto: correo,
  telefono,
})

export const esquemaSolicitud = z
  .object({
    codigo_reserva: z.string().trim().min(6).max(20),
    tipo: z.enum(['cambio', 'cancelacion']),
    nueva_fecha_inicio: fecha.optional(),
    motivo: z.string().trim().min(5, 'Cuéntanos el motivo.').max(1000),
  })
  .refine((d) => d.tipo !== 'cambio' || d.nueva_fecha_inicio !== undefined, {
    message: 'Indica la nueva fecha que prefieres.',
    path: ['nueva_fecha_inicio'],
  })

export const esquemaLogin = z.object({
  correo: z.string().trim().min(3).max(200),
  clave: z.string().min(1).max(200),
})

export const esquemaResolver = z.object({
  aprobar: z.boolean(),
  nota: z.string().trim().max(1000).nullable().optional(),
})

export const esquemaCentro = z.object({
  nombre: z.string().trim().min(2, 'El nombre es obligatorio.').max(200),
  correo_contacto: correo.nullable().optional(),
  telefono: z.string().trim().max(20).nullable().optional(),
  duracion_dias_laborables: z.number().int().min(1).max(60),
  activo: z.boolean(),
})

export const esquemaBloqueo = z
  .object({
    fecha_inicio: fecha,
    fecha_fin: fecha,
    tipo: z.enum(['feriado', 'personal', 'otro']),
    descripcion: z.string().trim().max(300).nullable().optional(),
  })
  .refine((d) => d.fecha_fin >= d.fecha_inicio, {
    message: 'La fecha final no puede ser anterior a la inicial.',
    path: ['fecha_fin'],
  })

export const esquemaFeriado = z.object({
  fecha,
  nombre: z.string().trim().min(2).max(200),
})

export const esquemaConfiguracion = z.object({
  ventana_inicio_mes: z.number().int().min(1).max(12),
  ventana_inicio_dia: z.number().int().min(1).max(31),
  ventana_fin_mes: z.number().int().min(1).max(12),
  ventana_fin_dia: z.number().int().min(1).max(31),
  max_simultaneos: z.number().int().min(1).max(20),
  anio_activo: z.number().int().min(2020).max(2100),
})

export const esquemaEstadoReserva = z.object({
  estado: z.enum(['reservada', 'en_proceso', 'entregada', 'cancelada']),
})

/** Primer mensaje de error legible de un ZodError. */
export function primerMensaje(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Los datos enviados no son válidos.'
}
