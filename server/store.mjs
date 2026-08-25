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
  if (businessClosedToday || (settings.holidayClosures || []).includes(dateStr) || dateExceptionClosed) return null;
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
      this.pool.query(`select id, name, category, base_price, duration_minutes
        from app.services where status = 'active' order by category nulls last, name`),
      this.pool.query(`select id, full_name from app.staff where status = 'active' order by full_name`),
      this.pool.query(`select timezone, settings from app.business_settings where id = true`),
    ]);
    return {
      services: services.rows.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category || "Servicios",
        price: Number(row.base_price),
        durationMinutes: Number(row.duration_minutes),
      })),
      staff: staff.rows.map((row) => ({ id: row.id, name: row.full_name })),
      schedule: settings.rows[0] || { timezone: "America/Santo_Domingo", settings: {} },
      // Banner promocional configurable (Fase 6) -- null si nunca se publicó ninguno, para que
      // ReservApp se vea exactamente igual que antes de que existiera esta función.
      banner: settings.rows[0]?.settings?.banner || null,
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

  async setStaffScheduleException({ staffId, date, startTime, endTime, available, reason }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from app.staff_schedule_exceptions where staff_id=$1 and exception_date=$2", [staffId, date]);
      const inserted = await client.query(
        `insert into app.staff_schedule_exceptions (staff_id, exception_date, start_time, end_time, available, reason)
         values ($1,$2,$3,$4,$5,$6) returning id, staff_id, exception_date, start_time, end_time, available, reason`,
        [staffId, date, startTime, endTime, available, reason || null],
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
    const mappings = await this.pool.query(
      `select staff_id, service_id from app.staff_services
        where staff_id = any($1::uuid[])`,
      [staff.map((item) => item.id)],
    );
    if (mappings.rowCount) {
      staff = staff.filter((person) => {
        const mapped = new Set(mappings.rows.filter((row) => row.staff_id === person.id).map((row) => row.service_id));
        return selectedIds.every((id) => mapped.has(id));
      });
    }
    if (!staff.length) return { missing: "staff_services" };
    // Horario/ausencias por colaboradora -- opt-in: una colaboradora sin ninguna fila propia en
    // staff_weekly_schedules sigue el horario general del negocio como siempre (así se comportaba
    // esto antes de que existiera esta tabla). Solo quien tiene AL MENOS una fila propia queda
    // sujeta a "si no hay fila para hoy, hoy no trabaja" -- y una excepción puntual (vacaciones,
    // medio día, etc.) siempre gana sobre el horario semanal, tenga fila o no.
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
    const staffWindows = new Map();
    for (const person of staff) {
      const exception = exceptionByStaff.get(person.id);
      if (exception) {
        staffWindows.set(person.id, exception.available
          ? { open: exception.start_time?.slice(0, 5) || opening, close: exception.end_time?.slice(0, 5) || closing }
          : null);
        continue;
      }
      if (optedIn.has(person.id)) {
        const today = todayByStaff.get(person.id);
        staffWindows.set(person.id, today ? { open: today.start_time.slice(0, 5), close: today.end_time.slice(0, 5) } : null);
        continue;
      }
      staffWindows.set(person.id, { open: opening, close: closing });
    }
    staff = staff.filter((person) => staffWindows.get(person.id));
    if (!staff.length) return { date, slots: [], closed: true };
    const busy = await this.pool.query(
      `select staff_id, starts_at, ends_at from app.appointments
       where staff_id = any($1::uuid[]) and status not in ('cancelled','replaced')
         and confirmation_status is distinct from 'EspacioLiberado'
         and starts_at < (($2::date + interval '1 day')::timestamp at time zone $3)
         and ends_at > ($2::date::timestamp at time zone $3)`,
      [staff.map((item) => item.id), date, timezone],
    );
    const toMinutes = (clock) => {
      const [hour, minute] = clock.split(":").map(Number);
      return hour * 60 + minute;
    };
    const now = Date.now();
    const latest = now + maxDays * 86_400_000;
    const slots = [];
    for (const person of staff) {
      const personBusy = busy.rows.filter((row) => row.staff_id === person.id);
      const window = staffWindows.get(person.id);
      for (let minute = toMinutes(window.open); minute + durationMinutes <= toMinutes(window.close); minute += interval) {
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

  async createClient(input) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const normalizedPhone = await client.query("select app.normalize_phone($1) value", [input.phone]);
      const duplicate = await client.query(
        `select c.id, c.full_name, 'phone' matched_by from app.client_phones p join app.clients c on c.id=p.client_id
          where p.phone_normalized=$1
         union all
         select c.id, c.full_name, 'email' matched_by from app.clients c
          where $2 <> '' and lower(c.email)=lower($2)
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
        where lower(c.full_name) like lower($1)
           or ($2 <> '' and p.phone_normalized like '%' || app.normalize_phone($2) || '%')
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
          where c.id=$1`, [input.clientId]),
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

  // Confirma la asistencia de una cita (respuesta de la clienta por WhatsApp vía el Chatbot
  // Bridge, o el botón "Confirmar cita en salón" del ERP legado). Si el horario ya fue tomado por
  // otra cita (esta quedó "EspacioLiberado" y alguien más reservó exactamente esa colaboradora +
  // horario mientras tanto), rechaza con alreadyReassigned:true para que quien llama le pida a la
  // clienta elegir otro horario -- nunca resucita una cita por encima de una reserva nueva.
  async confirmAppointmentAttendance({ legacyId }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const current = await client.query(
        `select id, legacy_id, staff_id, starts_at, ends_at, status, confirmation_status
           from app.appointments where legacy_id=$1 for update`,
        [legacyId],
      );
      const apt = current.rows[0];
      if (!apt) {
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
      await client.query(
        `update app.appointments set confirmation_status='HoraConfirmada', updated_at=clock_timestamp() where id=$1`,
        [apt.id],
      );
      await this.mirrorAppointmentToDocument(client, legacyId, (row) => {
        row.estadoConfirmacion = "HoraConfirmada";
        row.updated_at = new Date().toISOString();
      });
      await client.query("commit");
      return { confirmed: true };
    } catch (error) {
      await client.query("rollback").catch(() => {});
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
       values (app.normalize_phone($1),$2,'clienta')
       on conflict (phone_normalized) do update set updated_at=now()
       returning *`,
      [phone, clientId],
    );
    if (result.rows[0].role !== "clienta" || result.rows[0].client_id !== clientId) {
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
        where ra.role <> 'clienta'
        order by s.full_name`,
    );
    return result.rows;
  }

  async listClientsForAdmin({ query = "", limit = 200 } = {}) {
    const search = `%${query.trim()}%`;
    const result = await this.pool.query(
      `select c.id, c.full_name, c.status, c.email, p.phone_original client_phone,
              ra.id account_id, ra.status account_status
         from app.clients c
         left join app.client_phones p on p.client_id = c.id and p.is_primary
         left join app.reservapp_accounts ra on ra.client_id = c.id
        where ($1 = '' or c.full_name ilike $2 or p.phone_original ilike $2)
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
        where id = $1 and role <> 'clienta'
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

  // "Bloquear" tiene que impedir el login de verdad, no solo marcar la ficha -- el login
  // (POST /auth/login) exige reservapp_accounts.status='active', que es una tabla aparte de
  // app.clients. Si la clienta ya tiene cuenta de ReservApp, se suspende/reactiva junto con el
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
          where client_id = $1 and role = 'clienta' and status in ('active','suspended')`,
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
  // clienta nueva antes de registrarla. Cualquier código activo anterior
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
    const clientFilter = account.role === "clienta" ? "and a.client_id=$2" : "";
    if (account.role === "clienta") params.push(account.client_id);
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
    const staff = account.role === "clienta"
      ? []
      : (await this.pool.query("select id,full_name from app.staff where status='active' order by full_name")).rows;
    return { date, visibility: account.role === "clienta" ? "own" : "team", staff, appointments: result.rows };
  }
}
