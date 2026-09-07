import { z } from 'zod'

/**
 * Validación de entrada en el servidor. El frontend valida también, pero esta
 * es la que cuenta: cualquiera puede llamar al endpoint sin pasar por la app.
 */

const uuid = z.string().uuid('Identificador de centro inválido.')

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

export const esquemaResolver = z.object({
  solicitud_id: uuid,
  aprobar: z.boolean(),
  nota: z.string().trim().max(1000).nullable().optional(),
})

export type EntradaCrearReserva = z.infer<typeof esquemaCrearReserva>
export type EntradaSolicitud = z.infer<typeof esquemaSolicitud>

/** Primer mensaje de error legible de un ZodError. */
export function primerMensaje(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Los datos enviados no son válidos.'
}
