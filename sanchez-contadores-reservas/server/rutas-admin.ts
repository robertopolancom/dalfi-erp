import { Router, type NextFunction, type Request, type Response } from 'express'
import { consultar, consultarUna, llamarFuncion } from './db.ts'
import {
  NOMBRE_COOKIE, borrarCookieSesion, error, ipCliente, leerCookie, ponerCookieSesion,
  responderNegocio, type ResultadoNegocio,
} from './http.ts'
import { administradorDeSesion, cerrarSesion, iniciarSesion, type Administrador } from './auth.ts'
import {
  esquemaBloqueo, esquemaCentro, esquemaConfiguracion, esquemaEstadoReserva,
  esquemaFeriado, esquemaLogin, esquemaResolver, primerMensaje,
} from './validacion.ts'
import { crearNotificador } from './notificaciones/notificador.ts'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: Administrador
    }
  }
}

/** Puerta única del panel: sin sesión válida no pasa nada. */
async function exigirSesion(
  peticion: Request, respuesta: Response, siguiente: NextFunction,
): Promise<void> {
  const admin = await administradorDeSesion(leerCookie(peticion, NOMBRE_COOKIE))
  if (!admin) { error(respuesta, 401, 'Tu sesión expiró. Entra de nuevo.', 'NO_AUTORIZADO'); return }
  peticion.admin = admin
  siguiente()
}

export function rutasAdmin(): Router {
  const r = Router()

  // --- Sesión --------------------------------------------------------------

  r.post('/sesion', async (peticion, respuesta) => {
    const analisis = esquemaLogin.safeParse(peticion.body)
    if (!analisis.success) {
      error(respuesta, 400, 'Correo o contraseña incorrectos.', 'CREDENCIALES_INVALIDAS'); return
    }

    const sesion = await iniciarSesion(
      analisis.data.correo, analisis.data.clave, ipCliente(peticion),
    )
    // Mensaje genérico a propósito: no revelamos si el correo existe.
    if (!sesion) {
      error(respuesta, 401, 'Correo o contraseña incorrectos.', 'CREDENCIALES_INVALIDAS'); return
    }

    ponerCookieSesion(respuesta, sesion.token, sesion.expira)
    respuesta.json({ ok: true, admin: sesion.admin })
  })

  r.delete('/sesion', async (peticion, respuesta) => {
    await cerrarSesion(leerCookie(peticion, NOMBRE_COOKIE))
    borrarCookieSesion(respuesta)
    respuesta.json({ ok: true })
  })

  r.get('/yo', async (peticion, respuesta) => {
    const admin = await administradorDeSesion(leerCookie(peticion, NOMBRE_COOKIE))
    if (!admin) { error(respuesta, 401, 'Sin sesión.', 'NO_AUTORIZADO'); return }
    respuesta.json({ ok: true, admin })
  })

  // Todo lo de abajo exige sesión.
  r.use(exigirSesion)

  // --- Reservas ------------------------------------------------------------

  r.get('/reservas', async (peticion, respuesta) => {
    const anio = Number(peticion.query['anio'])
    if (!Number.isInteger(anio)) { error(respuesta, 400, 'Año inválido.', 'ENTRADA_INVALIDA'); return }

    const estado = String(peticion.query['estado'] ?? 'todos')
    const mes = String(peticion.query['mes'] ?? 'todos')

    const condiciones = ['r.anio = $1']
    const valores: unknown[] = [anio]

    if (estado !== 'todos') {
      valores.push(estado)
      condiciones.push(`r.estado = $${valores.length}::reserva_estado`)
    }

    if (mes !== 'todos') {
      const numeroMes = Number(mes)
      if (!Number.isInteger(numeroMes) || numeroMes < 1 || numeroMes > 12) {
        error(respuesta, 400, 'Mes inválido.', 'ENTRADA_INVALIDA'); return
      }
      // Solapamiento con el mes: empieza antes de que acabe y termina después
      // de que empiece.
      valores.push(numeroMes)
      condiciones.push(
        `r.fecha_inicio <= (make_date($1, $${valores.length}, 1) + interval '1 month - 1 day')::date
         and r.fecha_fin >= make_date($1, $${valores.length}, 1)`,
      )
    }

    respuesta.json(await consultar(
      `select r.*, json_build_object('nombre', c.nombre) as centros
         from reservas r
         join centros c on c.id = r.centro_id
        where ${condiciones.join(' and ')}
        order by r.fecha_inicio`,
      valores,
    ))
  })

  r.patch('/reservas/:id', async (peticion, respuesta) => {
    const analisis = esquemaEstadoReserva.safeParse(peticion.body)
    if (!analisis.success) {
      error(respuesta, 400, primerMensaje(analisis.error), 'ENTRADA_INVALIDA'); return
    }

    const filas = await consultar(
      'update reservas set estado = $1::reserva_estado where id = $2 returning id',
      [analisis.data.estado, peticion.params['id']],
    )
    if (filas.length === 0) { error(respuesta, 404, 'Reserva no encontrada.', 'NO_EXISTE'); return }
    respuesta.json({ ok: true })
  })

  // --- Solicitudes ---------------------------------------------------------

  r.get('/solicitudes', async (peticion, respuesta) => {
    const estado = String(peticion.query['estado'] ?? 'pendiente')
    const filtro = estado === 'todas' ? '' : 'where s.estado = $1::solicitud_estado'
    const valores = estado === 'todas' ? [] : [estado]

    respuesta.json(await consultar(
      `select s.*,
              json_build_object(
                'codigo_reserva', r.codigo_reserva,
                'fecha_inicio',   r.fecha_inicio,
                'fecha_fin',      r.fecha_fin,
                'estado',         r.estado,
                'correo_contacto', r.correo_contacto,
                'centros', json_build_object('nombre', c.nombre)
              ) as reservas
         from solicitudes_cambio s
         join reservas r on r.id = s.reserva_id
         join centros  c on c.id = r.centro_id
         ${filtro}
        order by s.creado_en desc`,
      valores,
    ))
  })

  r.post('/solicitudes/:id/resolver', async (peticion, respuesta) => {
    const analisis = esquemaResolver.safeParse(peticion.body)
    if (!analisis.success) {
      error(respuesta, 400, primerMensaje(analisis.error), 'ENTRADA_INVALIDA'); return
    }

    // El tipo y el centro se leen antes de resolver, porque después el estado
    // ya habrá cambiado.
    const previa = await consultarUna<{ tipo: 'cambio' | 'cancelacion'; centro: string }>(
      `select s.tipo, c.nombre as centro
         from solicitudes_cambio s
         join reservas r on r.id = s.reserva_id
         join centros  c on c.id = r.centro_id
        where s.id = $1`,
      [peticion.params['id']],
    )

    const resultado = await llamarFuncion<ResultadoNegocio & {
      accion?: 'aprobada' | 'rechazada'
      tipo?: 'cambio' | 'cancelacion'
      reserva_id?: string
      codigo_reserva?: string
      destinatario?: string
    }>('resolver_solicitud', [
      peticion.params['id'], analisis.data.aprobar, peticion.admin!.id, analisis.data.nota ?? null,
    ])

    if (!resultado.ok) { responderNegocio(respuesta, resultado, null); return }

    const notificador = crearNotificador()
    if (notificador && resultado.destinatario && resultado.reserva_id) {
      // Al rechazar, la reserva no se movió; leemos sus fechas tal como quedaron.
      const reserva = await consultarUna<{ fecha_inicio: string; fecha_fin: string }>(
        'select fecha_inicio, fecha_fin from reservas where id = $1',
        [resultado.reserva_id],
      )

      await notificador.notificar(
        resultado.accion === 'aprobada' ? 'solicitud_aprobada' : 'solicitud_rechazada',
        resultado.destinatario,
        {
          centro: previa?.centro ?? 'Tu centro',
          codigo_reserva: resultado.codigo_reserva ?? '',
          fecha_inicio: reserva?.fecha_inicio ?? '',
          fecha_fin: reserva?.fecha_fin ?? '',
          tipo_solicitud: resultado.tipo ?? previa?.tipo,
          nota: analisis.data.nota ?? undefined,
        },
        { reservaId: resultado.reserva_id },
      )
    }

    respuesta.json({ ok: true, accion: resultado.accion })
  })

  // --- Centros -------------------------------------------------------------

  r.get('/centros', async (_peticion, respuesta) => {
    respuesta.json(await consultar('select * from centros order by nombre'))
  })

  r.post('/centros', async (peticion, respuesta) => {
    const analisis = esquemaCentro.safeParse(peticion.body)
    if (!analisis.success) {
      error(respuesta, 400, primerMensaje(analisis.error), 'ENTRADA_INVALIDA'); return
    }
    const c = analisis.data

    try {
      const fila = await consultarUna(
        `insert into centros (nombre, correo_contacto, telefono, duracion_dias_laborables, activo)
         values ($1, $2, $3, $4, $5) returning *`,
        [c.nombre, c.correo_contacto ?? null, c.telefono ?? null,
         c.duracion_dias_laborables, c.activo],
      )
      respuesta.status(201).json(fila)
    } catch (e) {
      if (esViolacionUnica(e)) {
        error(respuesta, 409, 'Ya existe un centro con ese nombre.', 'NOMBRE_DUPLICADO'); return
      }
      throw e
    }
  })

  r.patch('/centros/:id', async (peticion, respuesta) => {
    const analisis = esquemaCentro.safeParse(peticion.body)
    if (!analisis.success) {
      error(respuesta, 400, primerMensaje(analisis.error), 'ENTRADA_INVALIDA'); return
    }
    const c = analisis.data

    try {
      const fila = await consultarUna(
        `update centros
            set nombre = $1, correo_contacto = $2, telefono = $3,
                duracion_dias_laborables = $4, activo = $5
          where id = $6 returning *`,
        [c.nombre, c.correo_contacto ?? null, c.telefono ?? null,
         c.duracion_dias_laborables, c.activo, peticion.params['id']],
      )
      if (!fila) { error(respuesta, 404, 'Centro no encontrado.', 'NO_EXISTE'); return }
      respuesta.json(fila)
    } catch (e) {
      if (esViolacionUnica(e)) {
        error(respuesta, 409, 'Ya existe un centro con ese nombre.', 'NOMBRE_DUPLICADO'); return
      }
      throw e
    }
  })

  // --- Bloqueos ------------------------------------------------------------

  r.get('/bloqueos', async (_peticion, respuesta) => {
    respuesta.json(await consultar('select * from bloqueos order by fecha_inicio'))
  })

  r.get('/bloqueos/afectadas', async (peticion, respuesta) => {
    const inicio = String(peticion.query['inicio'] ?? '')
    const fin = String(peticion.query['fin'] ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fin)) {
      error(respuesta, 400, 'Rango inválido.', 'ENTRADA_INVALIDA'); return
    }
    respuesta.json(await consultar(
      'select * from reservas_afectadas_por_rango($1, $2)', [inicio, fin],
    ))
  })

  r.post('/bloqueos', async (peticion, respuesta) => {
    const analisis = esquemaBloqueo.safeParse(peticion.body)
    if (!analisis.success) {
      error(respuesta, 400, primerMensaje(analisis.error), 'ENTRADA_INVALIDA'); return
    }
    const b = analisis.data

    const fila = await consultarUna(
      `insert into bloqueos (fecha_inicio, fecha_fin, tipo, descripcion, creado_por)
       values ($1, $2, $3::bloqueo_tipo, $4, $5) returning *`,
      [b.fecha_inicio, b.fecha_fin, b.tipo, b.descripcion ?? null, peticion.admin!.id],
    )
    respuesta.status(201).json(fila)
  })

  r.patch('/bloqueos/:id', async (peticion, respuesta) => {
    const analisis = esquemaBloqueo.safeParse(peticion.body)
    if (!analisis.success) {
      error(respuesta, 400, primerMensaje(analisis.error), 'ENTRADA_INVALIDA'); return
    }
    const b = analisis.data

    const fila = await consultarUna(
      `update bloqueos set fecha_inicio = $1, fecha_fin = $2,
                           tipo = $3::bloqueo_tipo, descripcion = $4
        where id = $5 returning *`,
      [b.fecha_inicio, b.fecha_fin, b.tipo, b.descripcion ?? null, peticion.params['id']],
    )
    if (!fila) { error(respuesta, 404, 'Bloqueo no encontrado.', 'NO_EXISTE'); return }
    respuesta.json(fila)
  })

  r.delete('/bloqueos/:id', async (peticion, respuesta) => {
    await consultar('delete from bloqueos where id = $1', [peticion.params['id']])
    respuesta.json({ ok: true })
  })

  // --- Feriados ------------------------------------------------------------

  r.get('/feriados', async (peticion, respuesta) => {
    const anio = Number(peticion.query['anio'])
    if (!Number.isInteger(anio)) { error(respuesta, 400, 'Año inválido.', 'ENTRADA_INVALIDA'); return }
    respuesta.json(await consultar('select * from feriados where anio = $1 order by fecha', [anio]))
  })

  r.put('/feriados', async (peticion, respuesta) => {
    const analisis = esquemaFeriado.safeParse(peticion.body)
    if (!analisis.success) {
      error(respuesta, 400, primerMensaje(analisis.error), 'ENTRADA_INVALIDA'); return
    }
    const fila = await consultarUna(
      `insert into feriados (fecha, nombre) values ($1, $2)
       on conflict (fecha) do update set nombre = excluded.nombre returning *`,
      [analisis.data.fecha, analisis.data.nombre],
    )
    respuesta.json(fila)
  })

  r.delete('/feriados/:fecha', async (peticion, respuesta) => {
    const fecha = String(peticion.params['fecha'])
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      error(respuesta, 400, 'Fecha inválida.', 'ENTRADA_INVALIDA'); return
    }
    await consultar('delete from feriados where fecha = $1', [fecha])
    respuesta.json({ ok: true })
  })

  // --- Configuración -------------------------------------------------------

  r.get('/configuracion', async (_peticion, respuesta) => {
    respuesta.json(await consultarUna('select * from configuracion where id = 1'))
  })

  r.put('/configuracion', async (peticion, respuesta) => {
    const analisis = esquemaConfiguracion.safeParse(peticion.body)
    if (!analisis.success) {
      error(respuesta, 400, primerMensaje(analisis.error), 'ENTRADA_INVALIDA'); return
    }
    const c = analisis.data

    try {
      const fila = await consultarUna(
        `update configuracion
            set ventana_inicio_mes = $1, ventana_inicio_dia = $2,
                ventana_fin_mes = $3, ventana_fin_dia = $4,
                max_simultaneos = $5, anio_activo = $6
          where id = 1 returning *`,
        [c.ventana_inicio_mes, c.ventana_inicio_dia, c.ventana_fin_mes,
         c.ventana_fin_dia, c.max_simultaneos, c.anio_activo],
      )
      respuesta.json(fila)
    } catch (e) {
      // Una ventana como "31 de febrero" hace fallar make_date en las vistas.
      if (e instanceof Error && /date/i.test(e.message)) {
        error(respuesta, 400,
          'Esa combinación de día y mes no existe en el calendario.', 'VENTANA_INVALIDA')
        return
      }
      throw e
    }
  })

  return r
}

function esViolacionUnica(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e &&
    (e as { code?: string }).code === '23505'
}
