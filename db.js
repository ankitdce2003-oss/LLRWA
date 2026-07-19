// Postgres-backed data layer. Replaces the file-based store.js used for
// VPS/Render deployments — Vercel's serverless functions have no persistent
// filesystem, so state has to live in a real database instead.
//
// Works with any standard Postgres connection string (Vercel Postgres/Neon,
// Supabase, Railway Postgres, or a local instance for development).

const { Pool } = require('pg');

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'No database connection string found. Set POSTGRES_URL (or DATABASE_URL) as an environment variable.'
  );
}

// Neon/Vercel Postgres require SSL. Local Postgres during development
// generally does not use/require it, so we only force SSL when the
// connection string doesn't point at localhost.
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5, // keep the pool small — serverless functions run many concurrent short-lived instances
});

async function initSchema() {
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS complaint_seq START 1;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS complaints (
      id TEXT PRIMARY KEY,
      tower TEXT NOT NULL,
      unit TEXT NOT NULL,
      resident_name TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      priority TEXT NOT NULL,
      description TEXT NOT NULL,
      logged_by TEXT NOT NULL,
      status TEXT NOT NULL,
      checker TEXT,
      resolution_notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      audit JSONB NOT NULL DEFAULT '[]'::jsonb
    );
  `);
}

function rowToComplaint(row) {
  return {
    id: row.id,
    tower: row.tower,
    unit: row.unit,
    residentName: row.resident_name,
    category: row.category,
    priority: row.priority,
    description: row.description,
    loggedBy: row.logged_by,
    status: row.status,
    checker: row.checker,
    resolutionNotes: row.resolution_notes,
    createdAt: row.created_at.toISOString(),
    audit: row.audit,
  };
}

module.exports = {
  initSchema,
  pool,

  // ---------- complaints ----------
  async getComplaints() {
    const { rows } = await pool.query('SELECT * FROM complaints ORDER BY created_at DESC');
    return rows.map(rowToComplaint);
  },

  async createComplaint({ tower, unit, residentName, category, priority, description, loggedBy, auditEntry }) {
    const { rows } = await pool.query(`SELECT nextval('complaint_seq') AS n`);
    const id = 'LL-' + String(rows[0].n).padStart(4, '0');
    const audit = [auditEntry];
    const { rows: inserted } = await pool.query(
      `INSERT INTO complaints (id, tower, unit, resident_name, category, priority, description, logged_by, status, audit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Pending Review',$9::jsonb)
       RETURNING *`,
      [id, tower, unit, residentName || '', category, priority, description, loggedBy, JSON.stringify(audit)]
    );
    return rowToComplaint(inserted[0]);
  },

  // Fetches the row, applies `mutate(row)` to compute new field values, and
  // writes them back inside a transaction with a row lock — this keeps
  // concurrent approve/return/etc. calls from racing each other.
  async updateComplaint(id, expectedStatuses, mutate) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM complaints WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return { error: 'not_found' };
      }
      const current = rowToComplaint(rows[0]);
      if (expectedStatuses && !expectedStatuses.includes(current.status)) {
        await client.query('ROLLBACK');
        return { error: 'bad_status', current };
      }
      const changes = mutate(current);
      const nextAudit = current.audit.concat([changes.auditEntry]);
      const { rows: updated } = await client.query(
        `UPDATE complaints
         SET status = $1, checker = $2, resolution_notes = $3, audit = $4::jsonb
         WHERE id = $5
         RETURNING *`,
        [changes.status, changes.checker ?? current.checker, changes.resolutionNotes ?? current.resolutionNotes, JSON.stringify(nextAudit), id]
      );
      await client.query('COMMIT');
      return { complaint: rowToComplaint(updated[0]) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};
