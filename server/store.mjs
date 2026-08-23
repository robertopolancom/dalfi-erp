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

  async availability({ serviceId, serviceIds, staffId, date }) {
    const catalog = await this.catalog();
    const selectedIds = uniqueServiceIds(serviceIds?.length ? serviceIds : serviceId);
    const services = selectedIds.map((id) => catalog.services.find((item) => item.id === id)).filter(Boolean);
    if (!selectedIds.length || services.length !== selectedIds.length) return { missing: "service" };
    const durationMinutes = services.reduce((sum, item) => sum + item.durationMinutes, 0);
    const totalPrice = services.reduce((sum, item) => sum + item.price, 0);
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
      for (let minute = toMinutes(opening); minute + durationMinutes <= toMinutes(closing); minute += interval) {
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
      const settingsResult = await client.query("select timezone from app.business_settings where id=true");
      const timezone = settingsResult.rows[0]?.timezone || "America/Santo_Domingo";
      const startResult = await client.query("select ($1::date + $2::time)::timestamp at time zone $3 starts_at", [input.date, input.time, timezone]);
      const startsAt = startResult.rows[0].starts_at;
      const endsAt = new Date(new Date(startsAt).getTime() + durationMinutes * 60_000);
      const id = legacyId("RES");
      const legacyPayload = {
        reservaID: id, fecha: input.date, hora: input.time, horaFin: input.endTime,
        clienteID: customer.legacy_id, clienteNombre: customer.full_name,
        telefono: customer.phone_original || "", correo: customer.email || "",
        clienteProvisional: false, canalOrigen: input.source, creadoPor: input.createdBy || null,
        servicioID: services[0].legacy_id, servicio: services.map((item) => item.name).join(", "),
        servicios: services.map((item) => ({ servicioID: item.legacy_id, nombre: item.name, cantidad: 1, duracionMin: Number(item.duration_minutes), precio: Number(item.base_price) })),
        colaboradorID: staff.legacy_id, colaboradorNombre: staff.full_name,
        duracionMin: durationMinutes, bloqueoGlobal: false,
        estado: "Programada", estadoConfirmacion: "Pendiente", estadoDeposito: "Pendiente",
        montoDeposito: 500, observaciones: input.notes || "",
        idempotencyKey: input.idempotencyKey,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      const inserted = await client.query(
        `insert into app.appointments
          (legacy_id,idempotency_key,client_id,staff_id,starts_at,ends_at,status,confirmation_status,
           deposit_status,deposit_amount,source_channel,notes,legacy_payload,group_id)
         values ($1,$2,$3,$4,$5,$6,'scheduled','Pendiente','Pendiente',500,$7,$8,$9::jsonb,$10)
         returning id, legacy_id, starts_at, ends_at`,
        [id, input.idempotencyKey, customer.id, staff.id, startsAt, endsAt, input.source, input.notes || "", JSON.stringify(legacyPayload), input.groupId || null],
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
              to_char(a.starts_at at time zone bs.timezone,'HH24:MI') start_time,
              to_char(a.ends_at at time zone bs.timezone,'HH24:MI') end_time,
              a.status,a.confirmation_status,
              coalesce(string_agg(x.service_name_snapshot, ', ' order by x.position),'Cita') services
         from app.appointments a
         left join app.staff s on s.id=a.staff_id
         left join app.clients c on c.id=a.client_id
         left join app.appointment_services x on x.appointment_id=a.id
         cross join app.business_settings bs
        where (a.starts_at at time zone bs.timezone)::date=$1::date
          and a.status not in ('cancelled','replaced') ${clientFilter}
        group by a.id,s.full_name,c.full_name,bs.timezone
        order by a.starts_at,s.full_name`,
      params,
    );
    const staff = account.role === "clienta"
      ? []
      : (await this.pool.query("select id,full_name from app.staff where status='active' order by full_name")).rows;
    return { date, visibility: account.role === "clienta" ? "own" : "team", staff, appointments: result.rows };
  }
}
