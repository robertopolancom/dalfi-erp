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
