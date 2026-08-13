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
    };
  }

  async availability({ serviceId, staffId, date }) {
    const catalog = await this.catalog();
    const service = catalog.services.find((item) => item.id === serviceId);
    if (!service) return { missing: "service" };
    const settings = catalog.schedule.settings || {};
    const timezone = catalog.schedule.timezone || "America/Santo_Domingo";
    const opening = settings.defaultOpeningTime || "09:00";
    const closing = settings.defaultClosingTime || "18:00";
    const interval = Math.max(5, Number(settings.defaultSlotIntervalMinutes) || 15);
    const minNotice = Math.max(0, Number(settings.minimumBookingNoticeMinutes) || 30);
    const maxDays = Math.max(1, Number(settings.maximumAdvanceBookingDays) || 60);
    const weekday = new Date(`${date}T12:00:00-04:00`).getDay();
    const weekDays = Array.isArray(settings.weekDays) ? settings.weekDays : [1, 2, 3, 4, 5, 6];
    if (!weekDays.includes(weekday) || (settings.holidayClosures || []).includes(date)) {
      return { date, slots: [], closed: true };
    }
    const staff = staffId ? catalog.staff.filter((item) => item.id === staffId) : catalog.staff;
    if (!staff.length) return { missing: "staff" };
    const busy = await this.pool.query(
      `select staff_id, starts_at, ends_at from app.appointments
       where staff_id = any($1::uuid[]) and status not in ('cancelled','replaced')
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
      for (let minute = toMinutes(opening); minute + service.durationMinutes <= toMinutes(closing); minute += interval) {
        const hour = String(Math.floor(minute / 60)).padStart(2, "0");
        const min = String(minute % 60).padStart(2, "0");
        const start = new Date(`${date}T${hour}:${min}:00-04:00`);
        const end = new Date(start.getTime() + service.durationMinutes * 60_000);
        if (start.getTime() < now + minNotice * 60_000 || start.getTime() > latest) continue;
        const overlaps = personBusy.some((row) => start < new Date(row.ends_at) && end > new Date(row.starts_at));
        if (!overlaps) slots.push({ staffId: person.id, staffName: person.name, time: `${hour}:${min}` });
      }
    }
    return { date, timezone, durationMinutes: service.durationMinutes, slots };
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
          (legacy_id, full_name, first_name, last_name, email, registration_source, legacy_payload)
         values ($1,$2,$3,$4,nullif($5,''),$6,$7::jsonb) returning id, legacy_id, full_name`,
        [id, input.fullName, input.firstName, input.lastName || "", input.email || "", input.source, JSON.stringify(input.legacyPayload)],
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
      const [serviceResult, staffResult, clientResult] = await Promise.all([
        client.query("select id, legacy_id, name, duration_minutes, base_price from app.services where id=$1 and status='active'", [input.serviceId]),
        client.query("select id, legacy_id, full_name from app.staff where id=$1 and status='active'", [input.staffId]),
        client.query(`select c.id, c.legacy_id, c.full_name, c.email, p.phone_original
          from app.clients c left join app.client_phones p on p.client_id=c.id and p.is_primary
          where c.id=$1`, [input.clientId]),
      ]);
      const service = serviceResult.rows[0];
      const staff = staffResult.rows[0];
      const customer = clientResult.rows[0];
      if (!service || !staff || !customer) {
        await client.query("rollback");
        return { missing: !customer ? "client" : !service ? "service" : "staff" };
      }
      const settingsResult = await client.query("select timezone from app.business_settings where id=true");
      const timezone = settingsResult.rows[0]?.timezone || "America/Santo_Domingo";
      const startResult = await client.query("select ($1::date + $2::time)::timestamp at time zone $3 starts_at", [input.date, input.time, timezone]);
      const startsAt = startResult.rows[0].starts_at;
      const endsAt = new Date(new Date(startsAt).getTime() + Number(service.duration_minutes) * 60_000);
      const id = legacyId("RES");
      const legacyPayload = {
        reservaID: id, fecha: input.date, hora: input.time, horaFin: input.endTime,
        clienteID: customer.legacy_id, clienteNombre: customer.full_name,
        telefono: customer.phone_original || "", correo: customer.email || "",
        clienteProvisional: false, canalOrigen: input.source,
        servicioID: service.legacy_id, servicio: service.name,
        servicios: [{ servicioID: service.legacy_id, nombre: service.name, cantidad: 1, duracionMin: Number(service.duration_minutes) }],
        colaboradorID: staff.legacy_id, colaboradorNombre: staff.full_name,
        duracionMin: Number(service.duration_minutes), bloqueoGlobal: false,
        estado: "Programada", estadoConfirmacion: "Pendiente", estadoDeposito: "Pendiente",
        montoDeposito: 500, observaciones: input.notes || "",
        idempotencyKey: input.idempotencyKey,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      const inserted = await client.query(
        `insert into app.appointments
          (legacy_id,idempotency_key,client_id,staff_id,starts_at,ends_at,status,confirmation_status,
           deposit_status,deposit_amount,source_channel,notes,legacy_payload)
         values ($1,$2,$3,$4,$5,$6,'scheduled','Pendiente','Pendiente',500,$7,$8,$9::jsonb)
         returning id, legacy_id, starts_at, ends_at`,
        [id, input.idempotencyKey, customer.id, staff.id, startsAt, endsAt, input.source, input.notes || "", JSON.stringify(legacyPayload)],
      );
      await client.query(
        `insert into app.appointment_services
          (appointment_id,service_id,legacy_service_id,service_name_snapshot,duration_minutes,price_snapshot,position)
         values ($1,$2,$3,$4,$5,$6,1)`,
        [inserted.rows[0].id, service.id, service.legacy_id, service.name, service.duration_minutes, service.base_price],
      );
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
}
