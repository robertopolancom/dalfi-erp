import { isClientRole } from "./reservapp-auth.mjs";

export class NeonDocumentStore {
  constructor(pool) {
    this.pool = pool;
  }

  async read({ metadataOnly = false } = {}) {
    const columns = metadataOnly ? "updated_at, version" : "document, updated_at, version";
    const result = await this.pool.query(`select ${columns} from app.erp_document where id = true`);
    const row = result.rows[0];
    if (!row) return null;
    return {
      data: metadataOnly ? undefined : row.document,
      updatedAt: row.updated_at?.toISOString?.() || row.updated_at || null,
      version: Number(row.version),
    };
  }

  async save({ document, expectedUpdatedAt, identity, changes }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const currentResult = await client.query(
        "select document, updated_at, version from app.erp_document where id = true for update",
      );
      const current = currentResult.rows[0];
      if (!current) {
        await client.query("rollback");
        return { missing: true };
      }
      const currentUpdatedAt = current.updated_at?.toISOString?.() || current.updated_at || null;
      if (currentUpdatedAt !== (expectedUpdatedAt || null)) {
        await client.query("rollback");
        return { conflict: true, updatedAt: currentUpdatedAt };
      }
      const saved = await client.query(
        `update app.erp_document
           set document = $1::jsonb, version = version + 1, updated_at = clock_timestamp()
         where id = true
         returning updated_at, version`,
        [JSON.stringify(document)],
      );
      await client.query(
        `insert into app.api_audit_log
           (action, entity_type, entity_id, actor_user_id, actor_email, actor_role, changes)
         values ('database_save', 'erp_document', 'app/database', $1, $2, $3, $4::jsonb)`,
        [identity.userId, identity.email, identity.role, JSON.stringify(changes)],
      );
      await client.query("commit");
      const row = saved.rows[0];
      return {
        saved: true,
        updatedAt: row.updated_at?.toISOString?.() || row.updated_at || null,
        version: Number(row.version),
        previousDocument: current.document,
      };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

function legacyId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function documentData(document) {
  if (document?.data && typeof document.data === "object") return document.data;
  return document;
}

function uniqueServiceIds(value) {
  return [...new Set((Array.isArray(value) ? value : [value]).filter(Boolean).map(String))];
}

// Ventana de apertura del negocio para una fecha exacta (America/Santo_Domingo, UTC-4 fijo, sin
// horario de verano), o null si está cerrado. Prioridad: scheduleExceptions (fecha exacta) >
// holidayClosures/weekDays > weeklyHours[díaDeSemana] > defaultOpeningTime/defaultClosingTime.
// Extraído de availability() para reutilizarse también en businessMinutesBetween (motor de
// recordatorios de confirmación) sin duplicar la lógica de resolución de horario.
export function resolveBusinessDayWindow(dateStr, settings = {}) {
  const weekday = new Date(`${dateStr}T12:00:00-04:00`).getDay();
  const weeklyHours = settings.weeklyHours && typeof settings.weeklyHours === "object" ? settings.weeklyHours : {};
  const dayKey = String(weekday);
  const dayOverride = Object.prototype.hasOwnProperty.call(weeklyHours, dayKey) ? weeklyHours[dayKey] : undefined;
  const weekDays = Array.isArray(settings.weekDays) ? settings.weekDays : [1, 2, 3, 4, 5, 6];
  const businessClosedToday = dayOverride === undefined ? !weekDays.includes(weekday) : dayOverride === null;
  const scheduleExceptions = Array.isArray(settings.scheduleExceptions) ? settings.scheduleExceptions : [];
  const dateException = scheduleExceptions.find((exc) => exc?.date === dateStr);
  const dateExceptionClosed = dateException && !dateException.open && !dateException.close;
  const dateExceptionOpensSpecially = Boolean(dateException?.open && dateException?.close);
  if (dateExceptionClosed) return null;
  // Con horario propio (open+close) la excepción manda de verdad sobre weekDays/holidayClosures
  // -- si no, "domingo con horario especial" (weekDays no incluye domingo) nunca podría abrir,
  // contradiciendo la prioridad ya documentada arriba.
  if (!dateExceptionOpensSpecially && (businessClosedToday || (settings.holidayClosures || []).includes(dateStr))) return null;
  const open = dateException?.open || dayOverride?.open || settings.defaultOpeningTime || "09:00";
  const close = dateException?.close || dayOverride?.close || settings.defaultClosingTime || "18:00";
  return { open, close };
}

// Minutos de horario laboral real entre dos instantes (fromMs, toMs), caminando día por día en
// America/Santo_Domingo -- usado para que "faltan N horas para la cita" cuente solo horas en que
// el salón realmente atiende, no horas de reloj puro (ver checkConfirmationReminder en
// server/app.mjs). Puerto de businessMinutesUntil (outputs/lib/booking-engine.js), adaptado a la
// forma de settings de app.business_settings en vez de businessSchedule normalizado.
export function businessMinutesBetween(fromMs, toMs, settings = {}) {
  if (!(toMs > fromMs)) return 0;
  let totalMinutes = 0;
  let cursorMs = fromMs;
  const toMinutesNum = (clock) => {
    const [hour, minute] = clock.split(":").map(Number);
    return hour * 60 + minute;
  };
  // Límite defensivo: nunca camina más allá de ~2 años de días, para que un settings corrupto
  // (todo cerrado) nunca cause un bucle largo.
  for (let guard = 0; guard < 730 && cursorMs < toMs; guard += 1) {
    const dateStr = new Date(cursorMs - 4 * 3600000).toISOString().slice(0, 10); // fecha SD del cursor
    const window = resolveBusinessDayWindow(dateStr, settings);
    const [y, m, d] = dateStr.split("-").map(Number);
    const dayStartMs = Date.UTC(y, m - 1, d, 4, 0, 0); // 00:00 SD == 04:00 UTC
    if (window) {
      const openMs = dayStartMs + toMinutesNum(window.open) * 60000;
      const closeMs = dayStartMs + toMinutesNum(window.close) * 60000;
      const segStart = Math.max(cursorMs, openMs);
      const segEnd = Math.min(toMs, closeMs);
      if (segEnd > segStart) totalMinutes += (segEnd - segStart) / 60000;
    }
    cursorMs = dayStartMs + 24 * 3600000; // medianoche del día siguiente
  }
  return totalMinutes;
}

export class NeonBookingStore {
  constructor(pool) {
    this.pool = pool;
  }

  async catalog() {
    const [services, staff, settings] = await Promise.all([
      this.pool.query(`select id, legacy_id, name, category, base_price, duration_minutes
        from app.services where status = 'active' order by category nulls last, name`),
      this.pool.query(`select id, legacy_id, full_name from app.staff where status = 'active' order by full_name`),
      this.pool.query(`select timezone, settings from app.business_settings where id = true`),
    ]);
    return {
      services: services.rows.map((row) => ({
        id: row.id,
        // legacyId: id propio del ERP (ej. "SER-0001") -- lo usa outputs/app.js para mapear su
        // servicioID/colaboradorID al UUID de Postgres al crear una cita, sin tabla de mapeo
        // aparte (ver POST /api/fast-booking/appointments).
        legacyId: row.legacy_id || null,
        name: row.name,
        category: row.category || "Servicios",
        price: Number(row.base_price),
        durationMinutes: Number(row.duration_minutes),
      })),
      staff: staff.rows.map((row) => ({ id: row.id, legacyId: row.legacy_id || null, name: row.full_name })),
      schedule: settings.rows[0] || { timezone: "America/Santo_Domingo", settings: {} },
      // Banner promocional configurable (Fase 6) -- null si nunca se publicó ninguno, para que
      // ReservApp se vea exactamente igual que antes de que existiera esta función.
      banner: settings.rows[0]?.settings?.banner || null,
      // Segundo cuadro de mensaje (independiente del banner promocional): sin IA, sin colores
      // por publicación -- solo texto, estilo fijo, para notas más largas y permanentes (ej.
      // invitar a preguntar por servicios que no están en el menú).
      infoBanner: settings.rows[0]?.settings?.infoBanner || null,
    };
  }

  // Panel "Configuración de usuarios" -- guarda/quita el banner promocional dentro de la misma
  // columna jsonb que ya existe para configuración del negocio, sin tabla nueva.
  async setBanner(banner) {
    const result = await this.pool.query(
      `update app.business_settings
          set settings = settings || jsonb_build_object('banner', $1::jsonb), updated_at = now()
        where id = true
        returning settings->'banner' banner`,
      [JSON.stringify(banner)],
    );
    return result.rows[0]?.banner || null;
  }

  async clearBanner() {
    await this.pool.query("update app.business_settings set settings = settings - 'banner', updated_at = now() where id = true");
  }

  async setInfoBanner(infoBanner) {
    const result = await this.pool.query(
      `update app.business_settings
          set settings = settings || jsonb_build_object('infoBanner', $1::jsonb), updated_at = now()
        where id = true
        returning settings->'infoBanner' "infoBanner"`,
      [JSON.stringify(infoBanner)],
    );
    return result.rows[0]?.infoBanner || null;
  }

  async clearInfoBanner() {
    await this.pool.query("update app.business_settings set settings = settings - 'infoBanner', updated_at = now() where id = true");
  }

  // Panel "Horarios" -- mismo business_settings.settings que ya lee availability() (server/store.mjs
  // más abajo) para calcular horarios reales, así que editar esto SÍ cambia qué se puede reservar.
  // El panel del ERP legado edita un documento JSON aparte que ya no alimenta la disponibilidad
  // real -- este es el único lugar que de verdad la afecta.
  async businessSettings() {
    const result = await this.pool.query("select timezone, settings from app.business_settings where id = true");
    return result.rows[0] || { timezone: "America/Santo_Domingo", settings: {} };
  }

  async updateBusinessSettings(patch) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `update app.business_settings
            set settings = settings || $1::jsonb, updated_at = now()
          where id = true
          returning timezone, settings`,
        [JSON.stringify(patch)],
      );
      // Espejo hacia el documento del ERP legado -- mismas claves (weekDays, weeklyHours,
      // holidayClosures, etc.) que ya usaba su propio editor de horario, así que la pantalla del
      // ERP sigue mostrando lo mismo que se acaba de guardar desde ReservApp, sin traducir nada.
      const docResult = await client.query("select document from app.erp_document where id=true for update");
      const document = docResult.rows[0]?.document;
      const data = documentData(document);
      if (data) {
        data.businessSchedule = { ...(data.businessSchedule || {}), ...result.rows[0].settings };
        await client.query(`update app.erp_document set document=$1::jsonb, version=version+1, updated_at=clock_timestamp() where id=true`, [JSON.stringify(document)]);
      }
      await client.query("commit");
      return result.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Horario semanal propio de una colaboradora -- opt-in, ver comentario en availability(). Una
  // fila por día de semana (upsert: borra la fila vieja de ese día si existía, mete la nueva) para
  // no acumular duplicados ni depender de un unique index que la tabla no tiene.
  async listStaffWeeklySchedules(staffId = null) {
    const result = await this.pool.query(
      `select id, staff_id, weekday, start_time, end_time, active from app.staff_weekly_schedules
        where ($1::uuid is null or staff_id=$1) order by staff_id, weekday`,
      [staffId],
    );
    return result.rows;
  }

  async setStaffWeeklySchedule({ staffId, weekday, startTime, endTime, active }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from app.staff_weekly_schedules where staff_id=$1 and weekday=$2", [staffId, weekday]);
      const inserted = await client.query(
        `insert into app.staff_weekly_schedules (staff_id, weekday, start_time, end_time, active)
         values ($1,$2,$3,$4,$5) returning id, staff_id, weekday, start_time, end_time, active`,
        [staffId, weekday, startTime, endTime, active],
      );
      await this.mirrorStaffScheduleToDocument(client);
      await client.query("commit");
      return inserted.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteStaffWeeklySchedule({ staffId, weekday }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from app.staff_weekly_schedules where staff_id=$1 and weekday=$2", [staffId, weekday]);
      await this.mirrorStaffScheduleToDocument(client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Excepción puntual (un día suelto, no un patrón semanal) -- vacaciones, medio día, etc. Gana
  // siempre sobre el horario semanal de ese día, tenga fila o no (ver availability()).
  async listStaffScheduleExceptions(staffId = null) {
    const result = await this.pool.query(
      `select id, staff_id, exception_date, start_time, end_time, available, reason from app.staff_schedule_exceptions
        where ($1::uuid is null or staff_id=$1) order by exception_date`,
      [staffId],
    );
    return result.rows;
  }

  // createdBy: 'admin' (por defecto, Configuración de usuarios) o 'staff' (la propia
  // colaboradora desde "Mi disponibilidad") -- listRecentStaffCreatedExceptions() usa esta
  // columna para mostrarle a administración solo los cambios que no hizo ella misma.
  async setStaffScheduleException({ staffId, date, startTime, endTime, available, reason, createdBy = "admin" }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from app.staff_schedule_exceptions where staff_id=$1 and exception_date=$2", [staffId, date]);
      const inserted = await client.query(
        `insert into app.staff_schedule_exceptions (staff_id, exception_date, start_time, end_time, available, reason, created_by, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,now()) returning id, staff_id, exception_date, start_time, end_time, available, reason, created_by, updated_at`,
        [staffId, date, startTime, endTime, available, reason || null, createdBy],
      );
      await this.mirrorStaffScheduleToDocument(client);
      await client.query("commit");
      return inserted.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Panel de administración ("Configuración de usuarios") -- lista los cambios de disponibilidad
  // que hizo la propia colaboradora desde "Mi disponibilidad" (nunca los que hizo
  // administración), más recientes primero, para que no tenga que revisar colaboradora por
  // colaboradora si alguien marcó algo nuevo.
  async listRecentStaffCreatedExceptions({ days = 30 } = {}) {
    const result = await this.pool.query(
      `select e.id, e.staff_id, s.full_name staff_name, e.exception_date, e.start_time, e.end_time,
              e.available, e.reason, e.updated_at
         from app.staff_schedule_exceptions e
         join app.staff s on s.id = e.staff_id
        where e.created_by = 'staff' and e.updated_at > now() - ($1 || ' days')::interval
        order by e.updated_at desc
        limit 50`,
      [days],
    );
    return result.rows;
  }

  async deleteStaffScheduleException({ staffId, date }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from app.staff_schedule_exceptions where staff_id=$1 and exception_date=$2", [staffId, date]);
      await this.mirrorStaffScheduleToDocument(client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Vuelca staff_weekly_schedules/staff_schedule_exceptions completas al documento del ERP legado
  // (mismas claves que ya inicializaba su propio código, ver outputs/app.js) -- se llama dentro de
  // la misma transacción que cada cambio para que nunca queden desincronizados.
  async mirrorStaffScheduleToDocument(client) {
    const [weekly, exceptions, staffRows] = await Promise.all([
      client.query("select staff_id, weekday, start_time, end_time, active from app.staff_weekly_schedules order by staff_id, weekday"),
      client.query("select staff_id, exception_date, start_time, end_time, available, reason from app.staff_schedule_exceptions order by exception_date"),
      client.query("select id, legacy_id, full_name from app.staff"),
    ]);
    const staffById = new Map(staffRows.rows.map((row) => [row.id, row]));
    const docResult = await client.query("select document from app.erp_document where id=true for update");
    const document = docResult.rows[0]?.document;
    const data = documentData(document);
    if (!data) return;
    data.staffWeeklySchedules = weekly.rows.map((row) => ({
      colaboradorID: staffById.get(row.staff_id)?.legacy_id || row.staff_id,
      colaboradorNombre: staffById.get(row.staff_id)?.full_name || "",
      weekday: row.weekday, startTime: row.start_time, endTime: row.end_time, active: row.active,
    }));
    data.staffScheduleExceptions = exceptions.rows.map((row) => ({
      colaboradorID: staffById.get(row.staff_id)?.legacy_id || row.staff_id,
      colaboradorNombre: staffById.get(row.staff_id)?.full_name || "",
      date: row.exception_date, startTime: row.start_time, endTime: row.end_time,
      available: row.available, reason: row.reason || "",
    }));
    await client.query(`update app.erp_document set document=$1::jsonb, version=version+1, updated_at=clock_timestamp() where id=true`, [JSON.stringify(document)]);
  }

  // staff_services es opt-in igual que staff_weekly_schedules (ver comentario más abajo): si
  // NINGUNA colaboradora del grupo tiene ninguna fila propia en staff_services, nadie queda
  // restringida (se asume que el salón no configuró asignaciones específicas todavía) -- pero
  // en cuanto UNA sola fila existe para el grupo, cada colaboradora sin fila propia queda
  // excluida de todos los servicios. Devuelve, POR SERVICIO, el set de ids de colaboradoras
  // elegibles -- availability() exige que una colaboradora esté en el set de TODOS los
  // servicios elegidos; availabilityFallback() (nivel 2) consulta cada servicio por separado.
  async staffServiceEligibility({ staff, serviceIds }) {
    const mappings = await this.pool.query(
      `select staff_id, service_id from app.staff_services where staff_id = any($1::uuid[])`,
      [staff.map((item) => item.id)],
    );
    const noRestrictions = !mappings.rowCount;
    const mappedByStaff = new Map();
    for (const row of mappings.rows) {
      if (!mappedByStaff.has(row.staff_id)) mappedByStaff.set(row.staff_id, new Set());
      mappedByStaff.get(row.staff_id).add(row.service_id);
    }
    const eligibility = new Map(serviceIds.map((id) => [id, new Set()]));
    for (const person of staff) {
      const mapped = mappedByStaff.get(person.id);
      for (const id of serviceIds) {
        if (noRestrictions || mapped?.has(id)) eligibility.get(id).add(person.id);
      }
    }
    return eligibility;
  }

  // Horario/ausencias por colaboradora -- opt-in: una colaboradora sin ninguna fila propia en
  // staff_weekly_schedules sigue el horario general del negocio como siempre (así se comportaba
  // esto antes de que existiera esta tabla). Solo quien tiene AL MENOS una fila propia queda
  // sujeta a "si no hay fila para hoy, hoy no trabaja" -- y una excepción puntual (vacaciones,
  // medio día, etc.) siempre gana sobre el horario semanal, tenga fila o no. Devuelve
  // Map(staffId -> {open,close} | null); null significa que esa colaboradora no trabaja ese día.
  async staffDayWindows({ staff, date, weekday, opening, closing }) {
    const staffIds = staff.map((item) => item.id);
    const [weeklyToday, weeklyAny, exceptionRows] = await Promise.all([
      this.pool.query(
        `select staff_id, start_time, end_time from app.staff_weekly_schedules
          where staff_id = any($1::uuid[]) and weekday=$2 and active=true`,
        [staffIds, weekday],
      ),
      this.pool.query(`select distinct staff_id from app.staff_weekly_schedules where staff_id = any($1::uuid[])`, [staffIds]),
      this.pool.query(
        `select staff_id, start_time, end_time, available from app.staff_schedule_exceptions
          where staff_id = any($1::uuid[]) and exception_date=$2`,
        [staffIds, date],
      ),
    ]);
    const optedIn = new Set(weeklyAny.rows.map((row) => row.staff_id));
    const todayByStaff = new Map(weeklyToday.rows.map((row) => [row.staff_id, row]));
    const exceptionByStaff = new Map(exceptionRows.rows.map((row) => [row.staff_id, row]));
    const windows = new Map();
    for (const person of staff) {
      const exception = exceptionByStaff.get(person.id);
      if (exception) {
        windows.set(person.id, exception.available
          ? { open: exception.start_time?.slice(0, 5) || opening, close: exception.end_time?.slice(0, 5) || closing }
          : null);
        continue;
      }
      if (optedIn.has(person.id)) {
        const today = todayByStaff.get(person.id);
        windows.set(person.id, today ? { open: today.start_time.slice(0, 5), close: today.end_time.slice(0, 5) } : null);
        continue;
      }
      windows.set(person.id, { open: opening, close: closing });
    }
    return windows;
  }

  // Citas ya ocupadas ese día por colaboradora -- EspacioLiberado no cuenta como ocupado (ver
  // checkConfirmationReminder en server/app.mjs: esa cita ya liberó su horario). Devuelve
  // Map(staffId -> [{starts_at, ends_at}]).
  async staffBusyIntervals({ staffIds, date, timezone }) {
    const busy = await this.pool.query(
      `select staff_id, starts_at, ends_at from app.appointments
       where staff_id = any($1::uuid[]) and status not in ('cancelled','replaced')
         and confirmation_status is distinct from 'EspacioLiberado'
         and starts_at < (($2::date + interval '1 day')::timestamp at time zone $3)
         and ends_at > ($2::date::timestamp at time zone $3)`,
      [staffIds, date, timezone],
    );
    const byStaff = new Map();
    for (const row of busy.rows) {
      if (!byStaff.has(row.staff_id)) byStaff.set(row.staff_id, []);
      byStaff.get(row.staff_id).push(row);
    }
    return byStaff;
  }

  async availability({ serviceId, serviceIds, staffId, date }) {
    const catalog = await this.catalog();
    const selectedIds = uniqueServiceIds(serviceIds?.length ? serviceIds : serviceId);
    const services = selectedIds.map((id) => catalog.services.find((item) => item.id === id)).filter(Boolean);
    if (!selectedIds.length || services.length !== selectedIds.length) return { missing: "service" };
    const durationMinutes = services.reduce((sum, item) => sum + item.durationMinutes, 0);
    const totalPrice = services.reduce((sum, item) => sum + item.price, 0);
    const settings = catalog.schedule.settings || {};
    const timezone = catalog.schedule.timezone || "America/Santo_Domingo";
    const interval = Math.max(5, Number(settings.defaultSlotIntervalMinutes) || 15);
    const minNotice = Math.max(0, Number(settings.minimumBookingNoticeMinutes) || 30);
    const maxDays = Math.max(1, Number(settings.maximumAdvanceBookingDays) || 60);
    const weekday = new Date(`${date}T12:00:00-04:00`).getDay();
    const dayWindow = resolveBusinessDayWindow(date, settings);
    if (!dayWindow) return { date, slots: [], closed: true };
    const opening = dayWindow.open;
    const closing = dayWindow.close;
    let staff = staffId ? catalog.staff.filter((item) => item.id === staffId) : catalog.staff;
    if (!staff.length) return { missing: "staff" };
    const eligibility = await this.staffServiceEligibility({ staff, serviceIds: selectedIds });
    staff = staff.filter((person) => selectedIds.every((id) => eligibility.get(id).has(person.id)));
    if (!staff.length) return { missing: "staff_services" };
    const staffWindows = await this.staffDayWindows({ staff, date, weekday, opening, closing });
    staff = staff.filter((person) => staffWindows.get(person.id));
    if (!staff.length) return { date, slots: [], closed: true };
    const busyByStaff = await this.staffBusyIntervals({ staffIds: staff.map((item) => item.id), date, timezone });
    const toMinutes = (clock) => {
      const [hour, minute] = clock.split(":").map(Number);
      return hour * 60 + minute;
    };
    const now = Date.now();
    const latest = now + maxDays * 86_400_000;
    const slots = [];
    for (const person of staff) {
      const personBusy = busyByStaff.get(person.id) || [];
      const window = staffWindows.get(person.id);
      // La última cita del día puede terminar después de la hora de cierre -- a diferencia de
      // un banco, lo que importa es que la clienta haya entrado (el horario de inicio) antes de
      // que se cierre, no que el servicio completo quepa antes del cierre. Por eso el límite del
      // bucle es "empieza antes de cerrar" (minute < close), no "termina antes de cerrar".
      for (let minute = toMinutes(window.open); minute < toMinutes(window.close); minute += interval) {
        const hour = String(Math.floor(minute / 60)).padStart(2, "0");
        const min = String(minute % 60).padStart(2, "0");
        const start = new Date(`${date}T${hour}:${min}:00-04:00`);
        const end = new Date(start.getTime() + durationMinutes * 60_000);
        if (start.getTime() < now + minNotice * 60_000 || start.getTime() > latest) continue;
        const overlaps = personBusy.some((row) => start < new Date(row.ends_at) && end > new Date(row.starts_at));
        if (!overlaps) slots.push({ staffId: person.id, staffName: person.name, time: `${hour}:${min}` });
      }
    }
    return { date, timezone, durationMinutes, totalPrice, services, slots };
  }

  // Se llama SOLO cuando availability() (bloque continuo, una sola colaboradora) no encontró
  // nada para 2+ servicios ese día -- nunca para un solo servicio. Busca, dentro del MISMO día,
  // una alternativa en 3 niveles de prioridad:
  //   1. la misma colaboradora, con espera entre servicios (ya no 100% continuo).
  //   2. distintas colaboradoras, acomodadas para que sea lo más continuo posible.
  //   3. si ninguna de las dos anteriores encuentra nada: "habla con un agente".
  // En los niveles 1 y 2 prueba TODOS los órdenes posibles de los servicios (no solo el orden
  // en que se seleccionaron) y se queda con el que menos espera total acumula -- empate: el que
  // arranca más temprano. El resultado son "segments" en el mismo shape que ya acepta
  // POST /api/fast-booking/appointments (createComboAppointment, sin cambios) -- confirmar la
  // propuesta es la misma llamada que ya existía para reservas combinadas.
  async availabilityFallback({ serviceIds, date }) {
    const catalog = await this.catalog();
    const selectedIds = uniqueServiceIds(serviceIds);
    const services = selectedIds.map((id) => catalog.services.find((item) => item.id === id)).filter(Boolean);
    if (services.length < 2) return { tier: "contact_agent" };
    // Las permutaciones crecen factorial -- con más de 6 servicios (720 órdenes) ya no vale la
    // pena probarlas todas para un caso que de por sí ya es la excepción (el bloque continuo
    // falló). Directo a "habla con un agente".
    if (services.length > 6) return { tier: "contact_agent" };
    const settings = catalog.schedule.settings || {};
    const timezone = catalog.schedule.timezone || "America/Santo_Domingo";
    const interval = Math.max(5, Number(settings.defaultSlotIntervalMinutes) || 15);
    const minNotice = Math.max(0, Number(settings.minimumBookingNoticeMinutes) || 30);
    const maxDays = Math.max(1, Number(settings.maximumAdvanceBookingDays) || 60);
    const weekday = new Date(`${date}T12:00:00-04:00`).getDay();
    const dayWindow = resolveBusinessDayWindow(date, settings);
    if (!dayWindow) return { tier: "contact_agent" };
    const { open: opening, close: closing } = dayWindow;
    const now = Date.now();
    const latest = now + maxDays * 86_400_000;
    const toMinutes = (clock) => { const [hour, minute] = clock.split(":").map(Number); return hour * 60 + minute; };
    const toClock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

    // Primer horario legal de `durationMinutes` para una colaboradora, en o después de
    // earliestMinute ese día -- mismo criterio de intervalo/no-solape/minNotice que
    // availability(), solo que arrancando desde un punto cualquiera del día en vez de la
    // apertura, para poder encadenar un servicio detrás de otro. Mismo criterio de cierre que
    // availability() también: el límite es "empieza antes de cerrar", no "termina antes de
    // cerrar" -- y no hace falta distinguir el último servicio de la cadena de los demás: si
    // availabilityFallback() se está ejecutando es porque el bloque continuo completo (mismo
    // criterio relajado) ya no cupo en ningún punto del día, así que un tramo intermedio nunca
    // puede alcanzar a estirarse más allá de cerrar sin que esa misma ventana ya hubiera hecho
    // caber el bloque continuo entero -- caso que availability() ya habría resuelto antes de
    // llegar aquí.
    const firstFit = (window, busy, durationMinutes, earliestMinute) => {
      const start = Math.max(toMinutes(window.open), earliestMinute);
      const startAligned = Math.ceil(start / interval) * interval;
      for (let minute = startAligned; minute < toMinutes(window.close); minute += interval) {
        const startDate = new Date(`${date}T${toClock(minute)}:00-04:00`);
        const endDate = new Date(startDate.getTime() + durationMinutes * 60_000);
        if (startDate.getTime() < now + minNotice * 60_000 || startDate.getTime() > latest) continue;
        const overlaps = busy.some((row) => startDate < new Date(row.ends_at) && endDate > new Date(row.starts_at));
        if (!overlaps) return { minute, endMinute: minute + durationMinutes };
      }
      return null;
    };

    const permutationsOf = (array) => {
      if (array.length <= 1) return [array];
      const result = [];
      for (let i = 0; i < array.length; i++) {
        const rest = [...array.slice(0, i), ...array.slice(i + 1)];
        for (const perm of permutationsOf(rest)) result.push([array[i], ...perm]);
      }
      return result;
    };
    const orders = permutationsOf(services);

    const toSegments = (found) => found.segments.map((seg) => ({
      serviceId: seg.serviceId, serviceName: seg.serviceName, staffId: seg.staffId, staffName: seg.staffName,
      time: toClock(seg.startMinute), endTime: toClock(seg.endMinute),
    }));
    const consider = (best, candidate) => {
      if (!best) return candidate;
      if (candidate.totalGapMinutes < best.totalGapMinutes) return candidate;
      if (candidate.totalGapMinutes === best.totalGapMinutes && candidate.firstStart < best.firstStart) return candidate;
      return best;
    };

    const staffAll = catalog.staff;
    const eligiblePerService = await this.staffServiceEligibility({ staff: staffAll, serviceIds: selectedIds });

    // ---------- Nivel 1: misma colaboradora, con espera entre servicios ----------
    const sameStaffCandidates = staffAll.filter((person) => selectedIds.every((id) => eligiblePerService.get(id).has(person.id)));
    if (sameStaffCandidates.length) {
      const windows = await this.staffDayWindows({ staff: sameStaffCandidates, date, weekday, opening, closing });
      const busyByStaff = await this.staffBusyIntervals({ staffIds: sameStaffCandidates.map((p) => p.id), date, timezone });
      let best = null;
      for (const person of sameStaffCandidates) {
        const window = windows.get(person.id);
        if (!window) continue;
        const busy = busyByStaff.get(person.id) || [];
        for (const order of orders) {
          const segments = [];
          let cursor = toMinutes(opening);
          let firstStart = null;
          let ok = true;
          for (const service of order) {
            const fit = firstFit(window, busy, service.durationMinutes, cursor);
            if (!fit) { ok = false; break; }
            if (firstStart === null) firstStart = fit.minute;
            segments.push({ serviceId: service.id, serviceName: service.name, staffId: person.id, staffName: person.name, startMinute: fit.minute, endMinute: fit.endMinute });
            cursor = fit.endMinute;
          }
          if (!ok) continue;
          const totalGapMinutes = (cursor - firstStart) - order.reduce((sum, s) => sum + s.durationMinutes, 0);
          best = consider(best, { segments, totalGapMinutes, firstStart });
        }
      }
      if (best) return { tier: "same_staff_gap", totalGapMinutes: best.totalGapMinutes, segments: toSegments(best) };
    }

    // ---------- Nivel 2: distintas colaboradoras, lo más continuo posible ----------
    const anyEligibleIds = new Set();
    for (const id of selectedIds) for (const staffId of eligiblePerService.get(id)) anyEligibleIds.add(staffId);
    const anyEligibleStaff = staffAll.filter((p) => anyEligibleIds.has(p.id));
    if (anyEligibleStaff.length) {
      const windows = await this.staffDayWindows({ staff: anyEligibleStaff, date, weekday, opening, closing });
      const busyByStaff = await this.staffBusyIntervals({ staffIds: anyEligibleStaff.map((p) => p.id), date, timezone });
      let best = null;
      for (const order of orders) {
        const segments = [];
        let cursor = toMinutes(opening);
        let firstStart = null;
        let ok = true;
        for (const service of order) {
          let picked = null;
          for (const staffId of eligiblePerService.get(service.id)) {
            const window = windows.get(staffId);
            if (!window) continue;
            const busy = busyByStaff.get(staffId) || [];
            const fit = firstFit(window, busy, service.durationMinutes, cursor);
            if (fit && (!picked || fit.minute < picked.fit.minute)) picked = { person: anyEligibleStaff.find((p) => p.id === staffId), fit };
          }
          if (!picked) { ok = false; break; }
          if (firstStart === null) firstStart = picked.fit.minute;
          segments.push({ serviceId: service.id, serviceName: service.name, staffId: picked.person.id, staffName: picked.person.name, startMinute: picked.fit.minute, endMinute: picked.fit.endMinute });
          cursor = picked.fit.endMinute;
        }
        if (!ok) continue;
        const totalGapMinutes = (cursor - firstStart) - order.reduce((sum, s) => sum + s.durationMinutes, 0);
        best = consider(best, { segments, totalGapMinutes, firstStart });
      }
      if (best) return { tier: "multi_staff", totalGapMinutes: best.totalGapMinutes, segments: toSegments(best) };
    }

    // ---------- Nivel 3: nada encontrado ese día ----------
    return { tier: "contact_agent" };
  }

  async createClient(input) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const normalizedPhone = await client.query("select app.normalize_phone($1) value", [input.phone]);
      const duplicate = await client.query(
        `select c.id, c.full_name, 'phone' matched_by from app.client_phones p join app.clients c on c.id=p.client_id
          where p.phone_normalized=$1 and c.status <> 'deleted'
         union all
         select c.id, c.full_name, 'email' matched_by from app.clients c
          where $2 <> '' and lower(c.email)=lower($2) and c.status <> 'deleted'
         limit 1`,
        [normalizedPhone.rows[0].value, input.email || ""],
      );
      if (duplicate.rowCount) {
        await client.query("rollback");
        return { duplicate: true, matchedBy: duplicate.rows[0].matched_by };
      }
      const id = input.legacyPayload?.clienteID || legacyId("CLI");
      const inserted = await client.query(
        `insert into app.clients
          (legacy_id, full_name, first_name, last_name, email, birth_date, sex, address, preferred_service, registration_source, legacy_payload)
         values ($1,$2,$3,$4,nullif($5,''),nullif($6,'')::date,nullif($7,''),nullif($8,''),nullif($9,''),$10,$11::jsonb) returning id, legacy_id, full_name`,
        [
          id, input.fullName, input.firstName, input.lastName || "", input.email || "",
          input.birthDate || "", input.sex || "", input.address || "", input.preferredService || "",
          input.source, JSON.stringify(input.legacyPayload),
        ],
      );
      await client.query(
        `insert into app.client_phones (client_id, phone_original, phone_normalized, label, source, is_primary)
         values ($1,$2,$3,'Principal',$4,true)`,
        [inserted.rows[0].id, input.phone, normalizedPhone.rows[0].value, input.source],
      );
      const docResult = await client.query("select document from app.erp_document where id=true for update");
      const document = docResult.rows[0]?.document;
      const previousDocument = structuredClone(document);
      const data = documentData(document);
      if (data) {
        data.clientes ||= [];
        data.clientes.push(input.legacyPayload);
        await client.query(`update app.erp_document set document=$1::jsonb, version=version+1, updated_at=clock_timestamp() where id=true`, [JSON.stringify(document)]);
      }
      await client.query("commit");
      return { client: inserted.rows[0], previousDocument, document };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      if (error?.code === "23505") return { duplicate: true, matchedBy: error.constraint?.includes("email") ? "email" : "phone" };
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveClient({ phone, email = "" }) {
    const result = await this.pool.query(
      `select c.id, c.full_name
         from app.client_phones p join app.clients c on c.id=p.client_id
        where p.phone_normalized=app.normalize_phone($1)
          and ($2='' or lower(coalesce(c.email,''))=lower($2))
          and c.status <> 'deleted'
        limit 1`,
      [phone, email],
    );
    return result.rows[0] || null;
  }

  async searchClients(query) {
    const digits = String(query).replace(/[^0-9]/g, "");
    const result = await this.pool.query(
      `select distinct c.id, c.full_name, c.email, p.phone_original phone
         from app.clients c left join app.client_phones p on p.client_id=c.id and p.is_primary
        where c.status <> 'deleted'
          and (lower(c.full_name) like lower($1)
               or ($2 <> '' and p.phone_normalized like '%' || app.normalize_phone($2) || '%'))
        order by c.full_name limit 12`,
      [`%${query}%`, digits],
    );
    return result.rows;
  }

  async createAppointment(input) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const selectedIds = uniqueServiceIds(input.serviceIds?.length ? input.serviceIds : input.serviceId);
      const [serviceResult, staffResult, clientResult] = await Promise.all([
        client.query(`select id, legacy_id, name, duration_minutes, base_price from app.services
          where id = any($1::uuid[]) and status='active'`, [selectedIds]),
        client.query("select id, legacy_id, full_name from app.staff where id=$1 and status='active'", [input.staffId]),
        client.query(`select c.id, c.legacy_id, c.full_name, c.email, p.phone_original
          from app.clients c left join app.client_phones p on p.client_id=c.id and p.is_primary
          where c.id=$1 and c.status <> 'deleted'`, [input.clientId]),
      ]);
      const byId = new Map(serviceResult.rows.map((row) => [row.id, row]));
      const services = selectedIds.map((id) => byId.get(id)).filter(Boolean);
      const staff = staffResult.rows[0];
      const customer = clientResult.rows[0];
      if (!selectedIds.length || services.length !== selectedIds.length || !staff || !customer) {
        await client.query("rollback");
        return { missing: !customer ? "client" : services.length !== selectedIds.length ? "service" : "staff" };
      }
      const durationMinutes = services.reduce((sum, item) => sum + Number(item.duration_minutes), 0);
      const settingsResult = await client.query("select timezone, settings from app.business_settings where id=true");
      const timezone = settingsResult.rows[0]?.timezone || "America/Santo_Domingo";
      const businessSettings = settingsResult.rows[0]?.settings || {};
      const startResult = await client.query("select ($1::date + $2::time)::timestamp at time zone $3 starts_at", [input.date, input.time, timezone]);
      const startsAt = startResult.rows[0].starts_at;
      const endsAt = new Date(new Date(startsAt).getTime() + durationMinutes * 60_000);
      const id = legacyId("RES");
      // Toda cita nueva, sin importar el canal de origen, entra al motor de recordatorios de
      // confirmación de asistencia (4h laborales antes + 1h laboral después, ver
      // checkConfirmationReminder en server/app.mjs) -- salvo que ya falten <=4h laborales para
      // la cita al momento de crearse, caso en el que un recordatorio no tendría sentido.
      const hoursUntilAppointment = businessMinutesBetween(Date.now(), new Date(startsAt).getTime(), businessSettings) / 60;
      const confirmationStatus = hoursUntilAppointment <= 4 ? "NoRequerida" : "Programada";
      const legacyPayload = {
        reservaID: id, fecha: input.date, hora: input.time, horaFin: input.endTime,
        clienteID: customer.legacy_id, clienteNombre: customer.full_name,
        telefono: customer.phone_original || "", correo: customer.email || "",
        clienteProvisional: false, canalOrigen: input.source, creadoPor: input.createdBy || null,
        servicioID: services[0].legacy_id, servicio: services.map((item) => item.name).join(", "),
        servicios: services.map((item) => ({ servicioID: item.legacy_id, nombre: item.name, cantidad: 1, duracionMin: Number(item.duration_minutes), precio: Number(item.base_price) })),
        colaboradorID: staff.legacy_id, colaboradorNombre: staff.full_name,
        duracionMin: durationMinutes, bloqueoGlobal: false,
        estado: "Programada", estadoConfirmacion: confirmationStatus, estadoDeposito: "Pendiente",
        primerRecordatorioEnviadoEn: null,
        montoDeposito: 500, observaciones: input.notes || "",
        idempotencyKey: input.idempotencyKey,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      const inserted = await client.query(
        `insert into app.appointments
          (legacy_id,idempotency_key,client_id,staff_id,starts_at,ends_at,status,confirmation_status,
           deposit_status,deposit_amount,source_channel,notes,legacy_payload,group_id)
         values ($1,$2,$3,$4,$5,$6,'scheduled',$11,'Pendiente',500,$7,$8,$9::jsonb,$10)
         returning id, legacy_id, starts_at, ends_at`,
        [id, input.idempotencyKey, customer.id, staff.id, startsAt, endsAt, input.source, input.notes || "", JSON.stringify(legacyPayload), input.groupId || null, confirmationStatus],
      );
      for (const [index, service] of services.entries()) {
        await client.query(
          `insert into app.appointment_services
            (appointment_id,service_id,legacy_service_id,service_name_snapshot,duration_minutes,price_snapshot,position)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [inserted.rows[0].id, service.id, service.legacy_id, service.name, service.duration_minutes, service.base_price, index + 1],
        );
      }
      const docResult = await client.query("select document from app.erp_document where id=true for update");
      const document = docResult.rows[0]?.document;
      const previousDocument = structuredClone(document);
      const data = documentData(document);
      if (data) {
        data.reservas ||= [];
        data.reservas.push(legacyPayload);
        await client.query(`update app.erp_document set document=$1::jsonb, version=version+1, updated_at=clock_timestamp() where id=true`, [JSON.stringify(document)]);
      }
      await client.query("commit");
      return { appointment: inserted.rows[0], legacyPayload, previousDocument, document };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      if (error?.code === "23P01") return { conflict: true };
      if (error?.code === "23505" && error.constraint?.includes("idempotency")) {
        const existing = await this.pool.query("select id, legacy_id, starts_at, ends_at from app.appointments where idempotency_key=$1", [input.idempotencyKey]);
        return { appointment: existing.rows[0], idempotent: true };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  // Aplica `mutateFn` a la fila de app.erp_document.data.reservas[] que corresponde a `legacyId`
  // (no-op si el documento o la fila no existen) -- mismo patrón de mirror que
  // mirrorStaffScheduleToDocument, para que el Matriz Consolidada y el banner del ERP legado
  // (outputs/app.js, que solo leen el documento) vean el mismo estado que app.appointments.
  async mirrorAppointmentToDocument(client, legacyId, mutateFn) {
    const docResult = await client.query("select document from app.erp_document where id=true for update");
    const document = docResult.rows[0]?.document;
    const data = documentData(document);
    if (!data) return;
    const row = (data.reservas || []).find((item) => String(item.reservaID) === String(legacyId));
    if (!row) return;
    mutateFn(row);
    await client.query(`update app.erp_document set document=$1::jsonb, version=version+1, updated_at=clock_timestamp() where id=true`, [JSON.stringify(document)]);
  }

  // Citas candidatas al motor de recordatorios de confirmación de asistencia (ver
  // checkConfirmationReminder en server/app.mjs) -- cualquier cita futura, sin importar canal de
  // origen, cuyo estadoConfirmacion siga en "Programada" (aún no se envió el primer recordatorio)
  // o "PendienteConfirmarHora" (primer recordatorio enviado, esperando respuesta o el segundo).
  async listAppointmentsForReminderSweep() {
    const result = await this.pool.query(
      `select a.id, a.legacy_id, a.starts_at, a.confirmation_status, a.first_reminder_sent_at,
              c.full_name client_name, p.phone_original client_phone,
              coalesce(string_agg(distinct x.service_name_snapshot, ', '),'Cita') service_name,
              s.full_name staff_name,
              to_char(a.starts_at at time zone bs.timezone,'YYYY-MM-DD') apt_date,
              to_char(a.starts_at at time zone bs.timezone,'HH24:MI') apt_time
         from app.appointments a
         join app.clients c on c.id=a.client_id
         left join app.client_phones p on p.client_id=c.id and p.is_primary
         left join app.staff s on s.id=a.staff_id
         left join app.appointment_services x on x.appointment_id=a.id
         cross join app.business_settings bs
        where a.confirmation_status in ('Programada','PendienteConfirmarHora')
          and a.status not in ('cancelled','replaced')
          and a.starts_at > now()
        group by a.id, c.full_name, p.phone_original, s.full_name, bs.timezone
        order by a.starts_at`,
    );
    return result.rows;
  }

  // stage "first": primer recordatorio (Programada -> PendienteConfirmarHora, estampa
  // first_reminder_sent_at). stage "second": segundo recordatorio sin respuesta
  // (PendienteConfirmarHora -> EspacioLiberado) -- availability() ya excluye
  // confirmation_status='EspacioLiberado' de las citas ocupadas, así que el horario reaparece
  // como disponible en el mismo paso (ver el WHERE de app.appointments ahí y el predicado
  // equivalente en la restricción appointments_no_staff_overlap, neon/migrations/0014).
  async markConfirmationReminderSent({ appointmentId, stage }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const nextStatus = stage === "first" ? "PendienteConfirmarHora" : "EspacioLiberado";
      const result = await client.query(
        stage === "first"
          ? `update app.appointments set confirmation_status=$2, first_reminder_sent_at=now(), updated_at=clock_timestamp() where id=$1 returning legacy_id`
          : `update app.appointments set confirmation_status=$2, updated_at=clock_timestamp() where id=$1 returning legacy_id`,
        [appointmentId, nextStatus],
      );
      const legacyIdValue = result.rows[0]?.legacy_id;
      if (legacyIdValue) {
        const nowIso = new Date().toISOString();
        await this.mirrorAppointmentToDocument(client, legacyIdValue, (row) => {
          row.estadoConfirmacion = nextStatus;
          if (stage === "first") row.primerRecordatorioEnviadoEn = nowIso;
          else row.segundoRecordatorioEnviadoEn = nowIso;
          row.updated_at = nowIso;
        });
      }
      await client.query("commit");
      return { updated: Boolean(legacyIdValue), confirmationStatus: nextStatus };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Confirma la asistencia de una cita (respuesta del cliente por WhatsApp vía el Chatbot
  // Bridge, o el botón "Confirmar cita en salón" del ERP legado). Si el horario ya fue tomado por
  // otra cita (esta quedó "EspacioLiberado" y alguien más reservó exactamente esa colaboradora +
  // horario mientras tanto), rechaza con alreadyReassigned:true para que quien llama le pida a la
  // cliente elegir otro horario -- nunca resucita una cita por encima de una reserva nueva.
  // clientId: cuando lo llama una sesión de cliente (no el bridge ni administración), acota la
  // confirmación a SU PROPIA cita -- nunca confía en un legacyId ajeno. null/omitido para
  // llamadas ya autorizadas de otra forma (bridge, administración).
  async confirmAppointmentAttendance({ legacyId, clientId = null }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const current = await client.query(
        `select id, legacy_id, staff_id, client_id, starts_at, ends_at, status, confirmation_status
           from app.appointments where legacy_id=$1 for update`,
        [legacyId],
      );
      const apt = current.rows[0];
      if (!apt || (clientId && String(apt.client_id) !== String(clientId))) {
        await client.query("rollback");
        return { missing: true };
      }
      if (["cancelled", "replaced"].includes(apt.status)) {
        await client.query("rollback");
        return { alreadyReassigned: true, status: apt.status };
      }
      const conflict = await client.query(
        `select id from app.appointments
          where staff_id=$1 and id<>$2 and status not in ('cancelled','replaced')
            and starts_at < $4 and ends_at > $3
          limit 1`,
        [apt.staff_id, apt.id, apt.starts_at, apt.ends_at],
      );
      if (conflict.rowCount) {
        await client.query("rollback");
        return { alreadyReassigned: true, status: "Reemplazada" };
      }
      // Antes esto solo tocaba confirmation_status -- el estatus visible (status) se quedaba
      // en "scheduled" aunque la clienta ya hubiera confirmado la hora por WhatsApp. Ahora
      // también se pone en "confirmed", pero solo partiendo de "scheduled": si ya está
      // "completed" (se atendió antes de que llegara esta confirmación tardía) no lo regresa.
      const alsoConfirmStatus = apt.status === "scheduled";
      await client.query(
        `update app.appointments
            set confirmation_status='HoraConfirmada',
                status = case when $2 then 'confirmed' else status end,
                updated_at=clock_timestamp()
          where id=$1`,
        [apt.id, alsoConfirmStatus],
      );
      await this.mirrorAppointmentToDocument(client, legacyId, (row) => {
        row.estadoConfirmacion = "HoraConfirmada";
        if (alsoConfirmStatus) row.estado = "Confirmada";
        row.updated_at = new Date().toISOString();
      });
      await client.query("commit");
      return { confirmed: true };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      // Ventana de carrera real entre el chequeo de conflicto de arriba (un SELECT normal, no
      // bloquea inserciones nuevas de otras sesiones) y este UPDATE: si alguien más reservó
      // exactamente ese staff_id+horario en el instante entre medio, este UPDATE reintroduce la
      // fila al alcance de la restricción de exclusión (confirmation_status deja de ser
      // 'EspacioLiberado') y Postgres la rechaza con 23P01 -- mismo código que ya maneja
      // createAppointment(). Sin este catch, esa carrera se veía como un 500 genérico en vez del
      // 409 ALREADY_REASSIGNED que sí espera el frontend.
      if (error?.code === "23P01") return { alreadyReassigned: true, status: "Reemplazada" };
      throw error;
    } finally {
      client.release();
    }
  }

  // Servicios combinados con distinta manicurista por servicio (ej. servicio 1 con Ana,
  // servicio 2 con Jaimely porque Ana no tenía espacio para el segundo). app.appointments solo
  // admite una colaboradora por fila, así que esto crea VARIAS citas -- una por segmento -- y
  // las vincula con un group_id compartido para que el personal las vea como una sola visita.
  // Cada segmento reutiliza exactamente createAppointment() (misma lógica de negocio, mismo
  // documento legado, mismo appointment_services) -- lo único nuevo es la coordinación entre
  // segmentos: si uno falla, se cancelan los ya creados antes de reportar el error, para no
  // dejar una visita a medias cobrando un depósito por un servicio que nunca se agendó.
  async createComboAppointment({ clientId, segments, notes, source, createdBy, idempotencyKey }) {
    const groupId = crypto.randomUUID();
    const created = [];
    for (const [index, segment] of segments.entries()) {
      const result = await this.createAppointment({
        clientId, serviceIds: segment.serviceIds, staffId: segment.staffId,
        date: segment.date, time: segment.time, endTime: segment.endTime,
        notes, source, createdBy, groupId,
        idempotencyKey: `${idempotencyKey}-${index + 1}`,
      });
      if (result.conflict || result.missing) {
        for (const done of created) {
          await this.pool.query("update app.appointments set status='cancelled', updated_at=clock_timestamp() where id=$1", [done.appointment.id]).catch(() => {});
        }
        return result;
      }
      created.push(result);
    }
    return { appointments: created, groupId };
  }

  async accountByPhone(phone) {
    const result = await this.pool.query(
      `select a.*, coalesce(c.full_name,s.full_name) full_name
         from app.reservapp_accounts a
         left join app.clients c on c.id=a.client_id
         left join app.staff s on s.id=a.staff_id
        where a.phone_normalized=app.normalize_phone($1)
        limit 1`,
      [phone],
    );
    return result.rows[0] || null;
  }

  async sessionAccount(tokenHash) {
    const result = await this.pool.query(
      `select a.*, coalesce(c.full_name,st.full_name) full_name, s.id session_id
         from app.reservapp_sessions s
         join app.reservapp_accounts a on a.id=s.account_id
         left join app.clients c on c.id=a.client_id
         left join app.staff st on st.id=a.staff_id
        where s.token_hash=$1 and s.revoked_at is null and s.expires_at>now()
          and a.status='active'
        limit 1`,
      [tokenHash],
    );
    if (result.rowCount) {
      await this.pool.query("update app.reservapp_sessions set last_seen_at=now() where id=$1", [result.rows[0].session_id]);
    }
    return result.rows[0] || null;
  }

  async createSession({ accountId, tokenHash, expiresAt }) {
    await this.pool.query(
      `insert into app.reservapp_sessions (account_id,token_hash,expires_at)
       values ($1,$2,$3)`,
      [accountId, tokenHash, expiresAt],
    );
    await this.pool.query("update app.reservapp_accounts set last_login_at=now(),updated_at=now() where id=$1", [accountId]);
  }

  async revokeSession(tokenHash) {
    await this.pool.query("update app.reservapp_sessions set revoked_at=now() where token_hash=$1 and revoked_at is null", [tokenHash]);
  }

  async ensureClientAccount({ clientId, phone }) {
    const result = await this.pool.query(
      `insert into app.reservapp_accounts (phone_normalized,client_id,role)
       values (app.normalize_phone($1),$2,'cliente')
       on conflict (phone_normalized) do update set updated_at=now()
       returning *`,
      [phone, clientId],
    );
    if (!isClientRole(result.rows[0].role) || result.rows[0].client_id !== clientId) {
      throw Object.assign(new Error("El teléfono pertenece a otra cuenta."), { code: "PHONE_ACCOUNT_CONFLICT" });
    }
    return result.rows[0];
  }

  async createEmployeeAccount({ staffId, phone, role, createdByAccountId = null }) {
    const result = await this.pool.query(
      `insert into app.reservapp_accounts
         (phone_normalized,staff_id,role,created_by_account_id)
       values (app.normalize_phone($1),$2,$3,$4)
       returning *`,
      [phone, staffId, role, createdByAccountId],
    );
    return result.rows[0];
  }

  // Panel "Configuración de usuarios" (solo administradora/superadministrador) -- lista todo el
  // personal con cuenta de ReservApp, staff.status aparte de reservapp_accounts.status porque
  // una ficha de staff inactiva (ej. la del superadministrador de desarrollo, que no debe salir
  // como manicurista reservable) no implica que su cuenta de acceso esté suspendida.
  async listEmployeeAccounts() {
    const result = await this.pool.query(
      `select ra.id, ra.role, ra.status, ra.phone_normalized, ra.last_login_at, ra.created_at,
              s.id staff_id, s.full_name, s.status staff_status
         from app.reservapp_accounts ra
         join app.staff s on s.id = ra.staff_id
        where ra.role not in ('cliente','clienta')
        order by s.full_name`,
    );
    return result.rows;
  }

  // Configuración de usuarios -> Clientes muestra SOLO clientes que ya tienen cuenta de
  // ReservApp (join, no left join) -- antes mostraba las 43+ fichas de toda la ERP (cualquier
  // cliente facturado por el personal, tenga o no acceso a la app), lo cual hacía parecer que
  // "todo cliente de la ERP ya está creado en ReservApp". La búsqueda que usa el personal para
  // reservarle una cita a CUALQUIER cliente (GET /api/fast-booking/clients) es una consulta
  // aparte y sigue mostrando la ERP completa -- ese es un uso legítimo distinto de este panel.
  async listClientsForAdmin({ query = "", limit = 200 } = {}) {
    const search = `%${query.trim()}%`;
    const result = await this.pool.query(
      `select c.id, c.full_name, c.status, c.email, p.phone_original client_phone,
              ra.id account_id, ra.status account_status
         from app.clients c
         left join app.client_phones p on p.client_id = c.id and p.is_primary
         join app.reservapp_accounts ra on ra.client_id = c.id
        where c.status <> 'deleted'
          and ($1 = '' or c.full_name ilike $2 or p.phone_original ilike $2)
        order by c.full_name
        limit $3`,
      [query.trim(), search, limit],
    );
    return result.rows;
  }

  // role=null deja el rol sin tocar (solo cambia status) -- separar los dos casos evita mandar
  // el rol actual de vuelta desde el frontend solo para no perderlo por accidente.
  async updateEmployeeAccount({ id, role = null, status = null }) {
    const result = await this.pool.query(
      `update app.reservapp_accounts
          set role = coalesce($2, role), status = coalesce($3, status), updated_at = now()
        where id = $1 and role not in ('cliente','clienta')
        returning id, role, status, staff_id`,
      [id, role, status],
    );
    return result.rows[0] || null;
  }

  // Fija una contraseña nueva a mano (ver POST /admin/accounts/:id/reset-password) y revoca toda
  // sesión activa de esa cuenta -- si alguien más ya tenía sesión abierta con la contraseña
  // vieja, no debe seguir teniéndola después de un restablecimiento por administración.
  async resetAccountPassword({ id, passwordHash }) {
    const result = await this.pool.query(
      `update app.reservapp_accounts set password_hash=$2, updated_at=now() where id=$1 returning id`,
      [id, passwordHash],
    );
    if (!result.rowCount) return null;
    await this.pool.query("update app.reservapp_sessions set revoked_at=now() where account_id=$1 and revoked_at is null", [id]);
    return true;
  }

  // Autoservicio (POST /auth/set-password-after-verification): crea o reinicia su propia
  // contraseña una vez que /auth/verify-name confirmó su identidad por nombre -- mientras Meta no
  // apruebe la verificación real por WhatsApp (RESERVAPP_SKIP_PHONE_VERIFICATION), esta es la
  // prueba de identidad que reemplaza al código real. Nunca reactiva una cuenta
  // suspendida/bloqueada (where status in pending/active) -- alguien a quien administración le
  // quitó el acceso a propósito no puede recuperarlo solo sabiendo su propio nombre; esa cuenta
  // sigue exigiendo una acción explícita de administración.
  async setOwnPasswordAndActivate({ id, passwordHash }) {
    const result = await this.pool.query(
      `update app.reservapp_accounts set password_hash=$2, status='active', updated_at=now()
        where id=$1 and status in ('pending','active') returning id`,
      [id, passwordHash],
    );
    if (!result.rowCount) return null;
    await this.pool.query("update app.reservapp_sessions set revoked_at=now() where account_id=$1 and revoked_at is null", [id]);
    return true;
  }

  // Alternativa a resetAccountPassword: en vez de que administración escriba la contraseña
  // nueva por la persona, borra la que tenía y la deja en el mismo estado "sin contraseña
  // todavía" que una cuenta recién creada -- la próxima vez que esa persona (cliente o
  // personal) ponga su teléfono en ReservApp, check-phone/request-setup ya la reconocen
  // (password_hash IS NULL) y la mandan directo a "¿Eres tú? Crea tu contraseña".
  async clearAccountPassword({ id }) {
    const result = await this.pool.query(
      `update app.reservapp_accounts set password_hash=null, updated_at=now() where id=$1 returning id`,
      [id],
    );
    if (!result.rowCount) return null;
    await this.pool.query("update app.reservapp_sessions set revoked_at=now() where account_id=$1 and revoked_at is null", [id]);
    return true;
  }

  // "Borrar credenciales" del panel: elimina la cuenta de ReservApp, sea de personal o de
  // cliente. Las sesiones abiertas y los tokens de setup pendientes cuelgan de ella con
  // on delete cascade (ver 0010_reservapp_identity_agenda.sql), así que se van con ella y quien
  // la tuviera abierta queda fuera en su siguiente petición. La ficha de staff o de cliente NO
  // se toca -- solo desaparece el acceso a la app, y el teléfono queda libre
  // (phone_normalized es único) para volver a invitar a esa persona desde cero.
  async deleteAccount({ id }) {
    const result = await this.pool.query(
      "delete from app.reservapp_accounts where id=$1 returning id, role, client_id, staff_id",
      [id],
    );
    return result.rows[0] || null;
  }

  // "Borrar cliente" del panel -- borrado LÓGICO. La ficha pasa a status='deleted' y desaparece
  // de todo lo vivo (búsqueda, duplicados, listado de administración, citas nuevas), pero sus
  // citas pasadas, facturas e ingresos quedan intactos: borrarlos de verdad descuadraría la
  // contabilidad histórica. Se borra además su cuenta de ReservApp -- si no, su teléfono
  // seguiría ocupado (phone_normalized es único) y no podría volver a registrarse nunca.
  //
  // Volver a atender a esa persona = registrarla de cero, con un id nuevo. El id viejo queda
  // colgando solo del historial; los índices de unicidad (correo) y la detección de duplicados
  // por teléfono ignoran las fichas borradas, justamente para que ese registro nuevo pase.
  //
  // Devuelve null si la ficha no existe o ya estaba borrada, y { blocked: n } si todavía tiene
  // n citas futuras: cancelarlas aquí a mano dejaría app.erp_document desincronizado del
  // documento que ve el personal, así que administración las cancela por el flujo normal del
  // ERP y después borra la ficha.
  async softDeleteClient({ id }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // for update: sin el candado, dos borrados simultáneos (o un borrado mientras alguien
      // agenda) podrían leer la misma ficha "todavía activa" y decidir sobre datos viejos.
      const current = await client.query(
        "select id, full_name from app.clients where id=$1 and status <> 'deleted' for update",
        [id],
      );
      if (!current.rowCount) { await client.query("rollback"); return null; }
      const upcoming = await client.query(
        `select count(*)::int total from app.appointments
          where client_id=$1 and status not in ('cancelled','replaced') and ends_at >= now()`,
        [id],
      );
      if (upcoming.rows[0].total) { await client.query("rollback"); return { blocked: upcoming.rows[0].total }; }
      await client.query("update app.clients set status='deleted', updated_at=now() where id=$1", [id]);
      const account = await client.query("delete from app.reservapp_accounts where client_id=$1 returning id", [id]);
      await client.query("commit");
      return { id, fullName: current.rows[0].full_name, deletedAccount: Boolean(account.rowCount) };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // "Bloquear" tiene que impedir el login de verdad, no solo marcar la ficha -- el login
  // (POST /auth/login) exige reservapp_accounts.status='active', que es una tabla aparte de
  // app.clients. Si el cliente ya tiene cuenta de ReservApp, se suspende/reactiva junto con el
  // bloqueo del cliente en la misma transacción; solo se toca una cuenta que estaba
  // active/suspended (nunca una 'pending' que todavía no completó su setup).
  async updateClientStatus({ id, status }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const updated = await client.query(
        "update app.clients set status=$2, updated_at=now() where id=$1 returning id, status",
        [id, status],
      );
      if (!updated.rowCount) { await client.query("rollback"); return null; }
      await client.query(
        `update app.reservapp_accounts
            set status = $2, updated_at = now()
          where client_id = $1 and role in ('cliente','clienta') and status in ('active','suspended')`,
        [id, status === "blocked" ? "suspended" : "active"],
      );
      await client.query("commit");
      return updated.rows[0];
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async prepareSetup({ accountId, tokenHash, expiresAt, recipientPhone, draft = null }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "update app.reservapp_setup_tokens set consumed_at=now() where account_id=$1 and consumed_at is null",
        [accountId],
      );
      const token = await client.query(
        `insert into app.reservapp_setup_tokens (account_id,token_hash,expires_at)
         values ($1,$2,$3) returning id`,
        [accountId, tokenHash, expiresAt],
      );
      let bookingDraft = null;
      if (draft) {
        const inserted = await client.query(
          `insert into app.reservapp_booking_drafts
            (account_id,service_ids,staff_id,appointment_date,appointment_time,notes,idempotency_key,expires_at)
           values ($1,$2::uuid[],$3,$4,$5,$6,$7,$8)
           returning id,status`,
          [accountId, draft.serviceIds, draft.staffId, draft.date, draft.time, draft.notes || "", draft.idempotencyKey, expiresAt],
        );
        bookingDraft = inserted.rows[0];
      }
      const outbox = await client.query(
        `insert into app.reservapp_whatsapp_outbox
          (account_id,recipient_phone,event_type,payload)
         values ($1,app.normalize_phone($2),'reservapp.account_setup',$3::jsonb)
         returning id,status`,
        [accountId, recipientPhone, JSON.stringify({ expiresAt, draftId: bookingDraft?.id || null })],
      );
      await client.query("commit");
      return { tokenId: token.rows[0].id, draft: bookingDraft, outbox: outbox.rows[0] };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async markWhatsApp({ outboxId, status, error = null }) {
    await this.pool.query(
      `update app.reservapp_whatsapp_outbox
          set status=$2,attempt_count=attempt_count+1,last_error=$3,
              sent_at=case when $2='sent' then now() else sent_at end
        where id=$1`,
      [outboxId, status, error],
    );
  }

  // Código de relay (ver 0011_reservapp_relay_otp.sql): una manicurista
  // solicita un código de 6 dígitos para verificar el teléfono de una
  // cliente nuevo antes de registrarla. Cualquier código activo anterior
  // para ese mismo teléfono se invalida -- solo el más reciente es válido.
  async createRelayOtp({ requestedByAccountId, phone, firstName, lastName, email, codeHash, expiresAt, maxAttempts = 5 }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const normalizedPhone = await client.query("select app.normalize_phone($1) value", [phone]);
      await client.query(
        `update app.reservapp_relay_otps set consumed_at=now()
          where phone_normalized=$1 and consumed_at is null`,
        [normalizedPhone.rows[0].value],
      );
      const inserted = await client.query(
        `insert into app.reservapp_relay_otps
          (requested_by_account_id,phone_normalized,first_name,last_name,email,code_hash,max_attempts,expires_at)
         values ($1,$2,$3,$4,nullif($5,''),$6,$7,$8)
         returning id`,
        [requestedByAccountId, normalizedPhone.rows[0].value, firstName, lastName || "", email || "", codeHash, maxAttempts, expiresAt],
      );
      const outbox = await client.query(
        `insert into app.reservapp_whatsapp_outbox
          (account_id,recipient_phone,event_type,payload)
         values ($1,$2,'reservapp.relay_otp',$3::jsonb)
         returning id,status`,
        [requestedByAccountId, normalizedPhone.rows[0].value, JSON.stringify({ otpId: inserted.rows[0].id, expiresAt })],
      );
      await client.query("commit");
      return { otpId: inserted.rows[0].id, outbox: outbox.rows[0] };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Verifica un código de relay. Retorna exactamente uno de:
  // { notFound: true } -- no hay código activo (vencido/no solicitado/ya usado)
  // { locked: true } -- se agotaron los intentos, hace falta solicitar uno nuevo
  // { invalid: true, attemptsRemaining } -- código incorrecto, aún quedan intentos
  // { ok: true, row } -- válido; ya quedó marcado consumido (uso único)
  async verifyRelayOtp({ phone, codeHash }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const found = await client.query(
        `select * from app.reservapp_relay_otps
          where phone_normalized=app.normalize_phone($1) and consumed_at is null and expires_at>now()
          order by created_at desc limit 1 for update`,
        [phone],
      );
      if (!found.rowCount) {
        await client.query("rollback");
        return { notFound: true };
      }
      const row = found.rows[0];
      if (row.attempt_count >= row.max_attempts) {
        await client.query("rollback");
        return { locked: true };
      }
      if (row.code_hash !== codeHash) {
        await client.query("update app.reservapp_relay_otps set attempt_count=attempt_count+1 where id=$1", [row.id]);
        await client.query("commit");
        return { invalid: true, attemptsRemaining: Math.max(0, row.max_attempts - row.attempt_count - 1) };
      }
      await client.query("update app.reservapp_relay_otps set consumed_at=now() where id=$1", [row.id]);
      await client.query("commit");
      return { ok: true, row };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async markRelayOtpClient(otpId, clientId) {
    await this.pool.query("update app.reservapp_relay_otps set created_client_id=$2 where id=$1", [otpId, clientId]);
  }

  // Verifica el código de 6 dígitos del setup en dos pasos. Si coincide, ROTA el token_hash de
  // la misma fila a un secreto nuevo (newTokenHash) en vez de marcarla consumida -- así
  // activateWithToken (que ya existía, sin cambios) sirve igual para el segundo paso
  // (fijar contraseña) sin tener que reescribirlo ni añadir una tabla nueva.
  async verifySetupOtp({ accountId, codeHash, newTokenHash, newExpiresAt }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const found = await client.query(
        `select id, token_hash, attempt_count, max_attempts
           from app.reservapp_setup_tokens
          where account_id=$1 and consumed_at is null and expires_at>now()
          order by created_at desc limit 1
          for update`,
        [accountId],
      );
      if (!found.rowCount) {
        await client.query("rollback");
        return { notFound: true };
      }
      const row = found.rows[0];
      if (row.attempt_count >= row.max_attempts) {
        await client.query("rollback");
        return { locked: true };
      }
      if (row.token_hash !== codeHash) {
        await client.query("update app.reservapp_setup_tokens set attempt_count=attempt_count+1 where id=$1", [row.id]);
        await client.query("commit");
        return { invalid: true, attemptsRemaining: Math.max(0, row.max_attempts - row.attempt_count - 1) };
      }
      await client.query(
        "update app.reservapp_setup_tokens set token_hash=$2, expires_at=$3, attempt_count=0 where id=$1",
        [row.id, newTokenHash, newExpiresAt],
      );
      await client.query("commit");
      return { ok: true };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async activateWithToken({ tokenHash, passwordHash, sessionTokenHash, sessionExpiresAt }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const found = await client.query(
        `select t.id token_id,t.account_id,a.role,a.client_id,a.staff_id,
                coalesce(c.full_name,s.full_name) full_name
           from app.reservapp_setup_tokens t
           join app.reservapp_accounts a on a.id=t.account_id
           left join app.clients c on c.id=a.client_id
           left join app.staff s on s.id=a.staff_id
          where t.token_hash=$1 and t.consumed_at is null and t.expires_at>now()
          for update of t,a`,
        [tokenHash],
      );
      if (!found.rowCount) {
        await client.query("rollback");
        return null;
      }
      const account = found.rows[0];
      await client.query(
        `update app.reservapp_accounts set password_hash=$2,status='active',verified_at=coalesce(verified_at,now()),updated_at=now()
          where id=$1`,
        [account.account_id, passwordHash],
      );
      await client.query("update app.reservapp_setup_tokens set consumed_at=now() where id=$1", [account.token_id]);
      await client.query(
        `insert into app.reservapp_sessions (account_id,token_hash,expires_at)
         values ($1,$2,$3)`,
        [account.account_id, sessionTokenHash, sessionExpiresAt],
      );
      const draft = await client.query(
        `select * from app.reservapp_booking_drafts
          where account_id=$1 and status='pending_setup' and expires_at>now()
          order by created_at desc limit 1 for update`,
        [account.account_id],
      );
      if (draft.rowCount) {
        await client.query("update app.reservapp_booking_drafts set status='ready',updated_at=now() where id=$1", [draft.rows[0].id]);
      }
      await client.query("commit");
      return { ...account, id: account.account_id, draft: draft.rows[0] || null };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // ---------- Autorregistro diferido (0017_reservapp_pending_registrations.sql) ----------
  // Mismo problema que ya resolvían prepareSetup/verifySetupOtp/activateWithToken, pero sin
  // crear todavía ni la ficha en la ERP ni la cuenta de ReservApp: si la persona abandona el
  // formulario antes de poner su contraseña, sus datos quedan solo en esta tabla (que expira
  // sola) y nunca tocan app.clients ni app.reservapp_accounts. Ver completePendingRegistration
  // para el paso donde de verdad se crean (o se enlazan).

  async createPendingRegistration({ phone, existingClientId = null, registration = null, draft = null, tokenHash, expiresAt }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const normalizedPhone = await client.query("select app.normalize_phone($1) value", [phone]);
      // Invalida cualquier registro pendiente anterior para el mismo teléfono -- mismo patrón
      // que prepareSetup usa hoy con account_id, así que solo el intento más reciente es válido.
      await client.query(
        "update app.reservapp_pending_registrations set consumed_at=now() where phone_normalized=$1 and consumed_at is null",
        [normalizedPhone.rows[0].value],
      );
      const inserted = await client.query(
        `insert into app.reservapp_pending_registrations
          (phone_normalized,phone_original,existing_client_id,registration,draft,token_hash,expires_at)
         values ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)
         returning id`,
        [normalizedPhone.rows[0].value, phone, existingClientId, registration ? JSON.stringify(registration) : null, draft ? JSON.stringify(draft) : null, tokenHash, expiresAt],
      );
      await client.query("commit");
      return { id: inserted.rows[0].id };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Mismo patrón de "rotar en el sitio" que verifySetupOtp (ver ese método para el porqué): al
  // acertar el código, el propio token_hash se sustituye por un secreto nuevo largo (el
  // "activationTicket") en vez de marcar la fila consumida -- así completePendingRegistration
  // sirve igual para el segundo paso sin necesitar una tabla aparte.
  async verifyPendingRegistrationOtp({ phone, codeHash, newTokenHash, newExpiresAt }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const found = await client.query(
        `select id, token_hash, attempt_count, max_attempts
           from app.reservapp_pending_registrations
          where phone_normalized=app.normalize_phone($1) and consumed_at is null and expires_at>now()
          order by created_at desc limit 1
          for update`,
        [phone],
      );
      if (!found.rowCount) {
        await client.query("rollback");
        return { notFound: true };
      }
      const row = found.rows[0];
      if (row.attempt_count >= row.max_attempts) {
        await client.query("rollback");
        return { locked: true };
      }
      if (row.token_hash !== codeHash) {
        await client.query("update app.reservapp_pending_registrations set attempt_count=attempt_count+1 where id=$1", [row.id]);
        await client.query("commit");
        return { invalid: true, attemptsRemaining: Math.max(0, row.max_attempts - row.attempt_count - 1) };
      }
      await client.query(
        `update app.reservapp_pending_registrations
            set token_hash=$2, expires_at=$3, attempt_count=0, otp_verified_at=coalesce(otp_verified_at,now())
          where id=$1`,
        [row.id, newTokenHash, newExpiresAt],
      );
      await client.query("commit");
      return { ok: true };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // El paso final: consume el token, resuelve el cliente real (reusa la ficha si ya existía o la
  // crea recién ahora si es de verdad nueva) y crea la cuenta de ReservApp ya con la contraseña
  // puesta. No queda todo esto en una única transacción atómica de punta a punta (igual que
  // request-setup tampoco lo estaba antes entre createClient/ensureClientAccount/prepareSetup) --
  // se acepta como riesgo residual documentado: una caída del servidor justo entre "se creó el
  // cliente" y "se puso la contraseña" podría dejar una cuenta sin contraseña, pero solo por una
  // caída real del proceso en una ventana de milisegundos, no por abandono de la persona (que es
  // el problema que esto resuelve). No se envuelve createClient en una transacción externa
  // porque ese método lo usan otros flujos y tocar su forma añade más riesgo del que quita.
  async completePendingRegistration({ tokenHash, passwordHash, sessionTokenHash, sessionExpiresAt }) {
    const lock = await this.pool.connect();
    let pending;
    try {
      await lock.query("begin");
      const found = await lock.query(
        `select id, phone_normalized, phone_original, existing_client_id, registration, draft
           from app.reservapp_pending_registrations
          where token_hash=$1 and consumed_at is null and expires_at>now()
          for update`,
        [tokenHash],
      );
      if (!found.rowCount) {
        await lock.query("rollback");
        return null;
      }
      pending = found.rows[0];
      await lock.query("update app.reservapp_pending_registrations set consumed_at=now() where id=$1", [pending.id]);
      await lock.query("commit");
    } catch (error) {
      await lock.query("rollback").catch(() => {});
      throw error;
    } finally {
      lock.release();
    }

    // existing_client_id puede haberse borrado ("Borrar cliente", softDeleteClient) mientras el
    // OTP estaba en tránsito -- nunca se enlaza a una ficha ya borrada, se trata como si nunca
    // hubiera existido y se crea una nueva con lo que la persona escribió (si su ficha original
    // ya existía, nunca guardamos su nombre/fecha de nacimiento aparte -- ver registration más
    // abajo -- así que en ese caso no hay con qué recrearla: se le pide volver a registrarse).
    let clientId = null;
    let fullName = "";
    if (pending.existing_client_id) {
      const check = await this.pool.query("select id, full_name from app.clients where id=$1 and status <> 'deleted'", [pending.existing_client_id]);
      if (check.rowCount) { clientId = check.rows[0].id; fullName = check.rows[0].full_name; }
    }
    if (!clientId && !pending.registration) {
      throw Object.assign(
        new Error("Tu ficha ya no está disponible. Vuelve a registrarte desde el principio."),
        { code: "PENDING_REGISTRATION_CLIENT_GONE" },
      );
    }
    if (!clientId) {
      const registration = pending.registration || {};
      const legacyPayload = {
        nombre: registration.firstName, apellido: registration.lastName,
        nombreCompleto: `${registration.firstName || ""} ${registration.lastName || ""}`.trim(),
        telefono: pending.phone_original, correo: registration.email, estado: "Activo",
        origenRegistro: "RESERVAPP_CLIENTE", fechaNacimiento: registration.birthDate, sexo: registration.sex,
        direccion: registration.address, servicioPreferido: registration.preferredService,
        fechaRegistro: new Date().toISOString(), observaciones: "Creado al confirmar credenciales de ReservApp.",
      };
      const created = await this.createClient({
        firstName: registration.firstName, lastName: registration.lastName, fullName: legacyPayload.nombreCompleto,
        phone: pending.phone_original, email: registration.email, source: "RESERVAPP_CLIENTE", legacyPayload,
        birthDate: registration.birthDate, sex: registration.sex, address: registration.address, preferredService: registration.preferredService,
      });
      if (created.duplicate) {
        // Condición de carrera real: otro registro para el mismo teléfono terminó primero (dos
        // pestañas, o el personal creó la ficha mientras el OTP estaba en tránsito).
        const resolved = await this.resolveClient({ phone: pending.phone_original });
        if (!resolved) throw Object.assign(new Error("No pudimos vincular el teléfono con una ficha de cliente."), { code: "PENDING_REGISTRATION_CLIENT_CONFLICT" });
        clientId = resolved.id; fullName = resolved.full_name;
      } else {
        clientId = created.client.id; fullName = created.client.full_name;
      }
    }

    const account = await this.ensureClientAccount({ clientId, phone: pending.phone_original });
    const activated = await this.pool.query(
      `update app.reservapp_accounts set password_hash=$2,status='active',verified_at=coalesce(verified_at,now()),updated_at=now()
        where id=$1 returning id`,
      [account.id, passwordHash],
    );
    if (!activated.rowCount) throw new Error("No se pudo activar la cuenta recién creada.");
    await this.pool.query(
      "insert into app.reservapp_sessions (account_id,token_hash,expires_at) values ($1,$2,$3)",
      [account.id, sessionTokenHash, sessionExpiresAt],
    );
    // Mismo shape (snake_case) que el draft que activateWithToken saca de reservapp_booking_drafts,
    // para que complete-setup en server/app.mjs no tenga que distinguir de dónde vino -- salvo
    // que aquí no hay fila real que marcar "confirmada" (nunca se creó una en booking_drafts),
    // por eso no trae `id`.
    const draft = pending.draft
      ? {
          service_ids: pending.draft.serviceIds, staff_id: pending.draft.staffId,
          appointment_date: pending.draft.date, appointment_time: pending.draft.time,
          notes: pending.draft.notes || "", idempotency_key: pending.draft.idempotencyKey,
        }
      : null;
    return { id: account.id, account_id: account.id, role: "cliente", client_id: clientId, staff_id: null, full_name: fullName, phone_normalized: pending.phone_normalized, draft };
  }

  async markDraftConfirmed(draftId, appointmentId) {
    await this.pool.query(
      `update app.reservapp_booking_drafts
          set status='confirmed',appointment_id=$2,updated_at=now()
        where id=$1`,
      [draftId, appointmentId],
    );
  }

  async agenda({ date, account }) {
    const params = [date];
    const isClient = isClientRole(account.role);
    const clientFilter = isClient ? "and a.client_id=$2" : "";
    if (isClient) params.push(account.client_id);
    const result = await this.pool.query(
      `select a.id,a.legacy_id,a.staff_id,s.full_name staff_name,a.client_id,c.full_name client_name,
              p.phone_original client_phone,
              to_char(a.starts_at at time zone bs.timezone,'HH24:MI') start_time,
              to_char(a.ends_at at time zone bs.timezone,'HH24:MI') end_time,
              a.status,a.confirmation_status,a.deposit_status,a.deposit_amount,a.notes,a.group_id,
              coalesce(string_agg(x.service_name_snapshot, ', ' order by x.position),'Cita') services
         from app.appointments a
         left join app.staff s on s.id=a.staff_id
         left join app.clients c on c.id=a.client_id
         left join app.client_phones p on p.client_id=c.id and p.is_primary
         left join app.appointment_services x on x.appointment_id=a.id
         cross join app.business_settings bs
        where (a.starts_at at time zone bs.timezone)::date=$1::date
          and a.status not in ('cancelled','replaced') ${clientFilter}
        group by a.id,s.full_name,c.full_name,p.phone_original,bs.timezone
        order by a.starts_at,s.full_name`,
      params,
    );
    const staff = isClient
      ? []
      : (await this.pool.query("select id,full_name from app.staff where status='active' order by full_name")).rows;
    return { date, visibility: isClient ? "own" : "team", staff, appointments: result.rows };
  }

  // Cancelar desde la agenda del equipo en ReservApp (antes solo era posible desde el ERP
  // legado). Idempotente a propósito: no toca filas ya 'cancelled'/'replaced', así que un doble
  // clic o una carrera entre dos personas del equipo no revierte nada ni pisa el motivo ya
  // guardado -- devuelve null y la ruta responde 404, "ya estaba cancelada".
  async cancelAppointment({ id, reason = null }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `update app.appointments
            set status = 'cancelled',
                notes = case when $2::text is not null and $2 <> ''
                          then trim(both E'\n' from coalesce(notes,'') || E'\nCancelada: ' || $2)
                          else notes end,
                updated_at = clock_timestamp()
          where id = $1 and status not in ('cancelled','replaced')
          returning id, status, legacy_id`,
        [id, reason],
      );
      const row = result.rows[0] || null;
      // Espejo hacia el documento del ERP -- sin esto, una cita cancelada desde ReservApp seguía
      // viéndose "Programada" en la matriz del ERP, porque ese documento nunca se enteraba.
      if (row?.legacy_id) {
        await this.mirrorAppointmentToDocument(client, row.legacy_id, (doc) => { doc.estado = "Cancelada"; doc.updated_at = new Date().toISOString(); });
      }
      await client.query("commit");
      return row;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Cambio manual de estatus (Confirmada/Atendida/Programada) desde un click en la cita, tanto
  // desde ReservApp como desde el ERP (ver POST /api/reservapp/agenda/appointments/:id/status).
  // 'Retrasada' NUNCA se guarda aquí -- es puramente derivada en el frontend a partir de la hora
  // de inicio, para que nunca quede desactualizada. No permite pisar cancelled/replaced (esos
  // solo se tocan vía cancelAppointment) ni completed hacia atrás por accidente de doble click.
  async setAppointmentStatus({ id, status }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `update app.appointments
            set status = $2,
                updated_at = clock_timestamp()
          where id = $1 and status not in ('cancelled','replaced')
          returning id, status, legacy_id`,
        [id, status],
      );
      const row = result.rows[0] || null;
      if (row?.legacy_id) {
        const ESTADO_BY_STATUS = { scheduled: "Programada", confirmed: "Confirmada", completed: "Atendida" };
        const estado = ESTADO_BY_STATUS[status];
        if (estado) await this.mirrorAppointmentToDocument(client, row.legacy_id, (doc) => { doc.estado = estado; doc.updated_at = new Date().toISOString(); });
      }
      await client.query("commit");
      return row;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Vista de cliente en ReservApp: "Citas activas" (próximas, sin cancelar/reasignar) e
  // "historial" (ya pasadas o canceladas/reasignadas) -- a diferencia de agenda(), no está
  // acotada a un solo día, así que un cliente ve todas sus citas activas de un vistazo en vez de
  // tener que navegar día por día. Nunca acepta un clientId externo: siempre viene de la sesión
  // autenticada (ver GET /api/reservapp/my-appointments en server/app.mjs).
  async listClientAppointments({ clientId, scope }) {
    const isActive = scope !== "history";
    const result = await this.pool.query(
      `select a.id, a.legacy_id, a.staff_id, s.full_name staff_name,
              to_char(a.starts_at at time zone bs.timezone,'YYYY-MM-DD') date,
              to_char(a.starts_at at time zone bs.timezone,'HH24:MI') start_time,
              to_char(a.ends_at at time zone bs.timezone,'HH24:MI') end_time,
              a.status, a.confirmation_status, a.deposit_status, a.deposit_amount, a.notes,
              coalesce(string_agg(x.service_name_snapshot, ', ' order by x.position),'Cita') services
         from app.appointments a
         left join app.staff s on s.id=a.staff_id
         left join app.appointment_services x on x.appointment_id=a.id
         cross join app.business_settings bs
        where a.client_id=$1
          ${isActive
            ? "and a.starts_at >= now() and a.status not in ('cancelled','replaced')"
            : "and (a.starts_at < now() or a.status in ('cancelled','replaced'))"}
        group by a.id, s.full_name, bs.timezone
        order by a.starts_at ${isActive ? "asc" : "desc"}
        limit 100`,
      [clientId],
    );
    return result.rows;
  }

  // El cliente sube la foto del comprobante de depósito (RD$500, ya exigido desde que se crea
  // la cita -- ver deposit_status/deposit_amount en el insert de app.appointments más arriba).
  // Solo se puede subir si la cita es suya y si todavía no hay un comprobante bajo revisión o ya
  // aprobado -- después de un rechazo sí se puede volver a subir (sobrescribe la fila anterior,
  // no se guarda historial). Deja la cita en 'ComprobanteRecibido', a la espera de que el
  // personal la revise (ver reviewDepositReceipt).
  async submitDepositReceipt({ appointmentId, clientId, imageBase64, mimeType }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const aptResult = await client.query(
        `select id, client_id, legacy_id, deposit_status from app.appointments where id=$1 for update`,
        [appointmentId],
      );
      const appointment = aptResult.rows[0];
      if (!appointment || String(appointment.client_id) !== String(clientId)) {
        throw Object.assign(new Error("Esa cita no existe o no te pertenece."), { status: 404 });
      }
      if (!["Pendiente", "Rechazado"].includes(appointment.deposit_status)) {
        throw Object.assign(new Error("El comprobante de esta cita ya está en revisión o ya fue confirmado."), { status: 400 });
      }
      await client.query(
        `insert into app.appointment_deposit_receipts (appointment_id, image_data, mime_type, uploaded_at, reviewed_by, reviewed_at, review_note)
         values ($1,$2,$3,now(),null,null,null)
         on conflict (appointment_id) do update
           set image_data=excluded.image_data, mime_type=excluded.mime_type, uploaded_at=excluded.uploaded_at,
               reviewed_by=null, reviewed_at=null, review_note=null`,
        [appointmentId, imageBase64, mimeType],
      );
      const updated = await client.query(
        `update app.appointments set deposit_status='ComprobanteRecibido', updated_at=clock_timestamp()
          where id=$1 returning id, deposit_status, legacy_id`,
        [appointmentId],
      );
      const row = updated.rows[0];
      if (row?.legacy_id) {
        await this.mirrorAppointmentToDocument(client, row.legacy_id, (doc) => { doc.estadoDeposito = "ComprobanteRecibido"; doc.updated_at = new Date().toISOString(); });
      }
      await client.query("commit");
      return row;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Trae el comprobante para que el personal lo vea desde el detalle de la reserva en el ERP
  // (ver GET /api/reservapp/agenda/appointments/:id/deposit).
  async getDepositReceipt({ appointmentId }) {
    const result = await this.pool.query(
      `select appointment_id, image_data, mime_type, uploaded_at, reviewed_by, reviewed_at, review_note
         from app.appointment_deposit_receipts where appointment_id=$1`,
      [appointmentId],
    );
    return result.rows[0] || null;
  }

  // El personal aprueba o rechaza el comprobante ya subido -- mismo espejo hacia
  // app.erp_document que el resto de cambios de estatus (ver setAppointmentStatus/
  // cancelAppointment) para que la matriz del ERP no quede desactualizada.
  async reviewDepositReceipt({ appointmentId, approve, reviewedBy, note = null }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const receipt = await client.query(
        `select appointment_id from app.appointment_deposit_receipts where appointment_id=$1 for update`,
        [appointmentId],
      );
      if (!receipt.rows[0]) throw Object.assign(new Error("Todavía no hay un comprobante subido para esta cita."), { status: 400 });
      const newStatus = approve ? "Verificado" : "Rechazado";
      await client.query(
        `update app.appointment_deposit_receipts
            set reviewed_by=$2, reviewed_at=clock_timestamp(), review_note=$3
          where appointment_id=$1`,
        [appointmentId, reviewedBy, note],
      );
      const updated = await client.query(
        `update app.appointments set deposit_status=$2, updated_at=clock_timestamp()
          where id=$1 returning id, deposit_status, legacy_id`,
        [appointmentId, newStatus],
      );
      const row = updated.rows[0];
      if (!row) throw Object.assign(new Error("Esa cita no existe."), { status: 404 });
      if (row.legacy_id) {
        await this.mirrorAppointmentToDocument(client, row.legacy_id, (doc) => { doc.estadoDeposito = newStatus; doc.updated_at = new Date().toISOString(); });
      }
      await client.query("commit");
      return row;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
