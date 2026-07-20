// Postgres-backed data layer for the painting project tracker.

const { Pool } = require('pg');

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'No database connection string found. Set POSTGRES_URL (or DATABASE_URL) as an environment variable.'
  );
}

const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
});

async function initSchema() {
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS task_seq START 1;`);
  // Base table with just the columns that have existed since day one.
  // CREATE TABLE IF NOT EXISTS is a no-op if the table already exists —
  // which is exactly the trap that caused this bug: an older deployment's
  // table stuck around with an outdated set of columns, and nothing ever
  // added the newer ones to it. The ALTER TABLE block below fixes that by
  // adding any column the current code expects but the table doesn't have
  // yet, every time the app starts — so schema changes in future updates
  // self-repair automatically instead of silently failing like this did.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      audit JSONB NOT NULL DEFAULT '[]'::jsonb
    );
  `);
  const expectedColumns = [
    ['work_location', "TEXT NOT NULL DEFAULT ''"],
    ['work_location_other', "TEXT NOT NULL DEFAULT ''"],
    ['tower', "TEXT NOT NULL DEFAULT ''"],
    ['flat_number', "TEXT NOT NULL DEFAULT ''"],
    ['contractor_name', "TEXT NOT NULL DEFAULT ''"],
    ['description', "TEXT NOT NULL DEFAULT ''"],
    ['logged_by', "TEXT NOT NULL DEFAULT ''"],
    ['status', "TEXT NOT NULL DEFAULT 'Assigned to Contractor'"],
    ['checker', 'TEXT'],
  ];
  for (const [name, definition] of expectedColumns) {
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ${name} ${definition};`);
  }

  // Any other column the current code doesn't know about — leftovers from
  // an older schema version (e.g. "category"/"priority"/"location_detail"
  // from an earlier iteration of this app) — might still carry a NOT NULL
  // constraint that would block every insert, since new rows never
  // populate them. Relax any such constraint automatically instead of
  // requiring a manual fix each time the schema evolves.
  const currentColumnNames = new Set(['id', 'created_at', 'audit', ...expectedColumns.map(([name]) => name)]);
  const { rows: notNullCols } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'tasks' AND is_nullable = 'NO'`
  );
  for (const { column_name } of notNullCols) {
    if (!currentColumnNames.has(column_name)) {
      await pool.query(`ALTER TABLE tasks ALTER COLUMN "${column_name}" DROP NOT NULL;`);
    }
  }
}

function rowToTask(row) {
  return {
    id: row.id,
    workLocation: row.work_location,
    workLocationOther: row.work_location_other,
    tower: row.tower,
    flatNumber: row.flat_number,
    contractorName: row.contractor_name,
    description: row.description,
    loggedBy: row.logged_by,
    status: row.status,
    checker: row.checker,
    createdAt: row.created_at.toISOString(),
    audit: row.audit,
  };
}

const norm = (s) => (s || '').trim().toLowerCase();

module.exports = {
  initSchema,
  pool,

  async getTasks() {
    const { rows } = await pool.query('SELECT * FROM tasks ORDER BY created_at DESC');
    return rows.map(rowToTask);
  },

  // Admin-only: permanently removes a task. Returns the deleted task's id,
  // or null if no task with that id existed.
  async deleteTask(id) {
    const { rows } = await pool.query('DELETE FROM tasks WHERE id = $1 RETURNING id', [id]);
    return rows[0] ? rows[0].id : null;
  },

  // Returns an existing non-Approved task that matches the same work
  // location, tower, flat number, and scope of work — used to block
  // logging an exact duplicate while one is already active.
  async findActiveDuplicate({ workLocation, workLocationOther, tower, flatNumber, description }) {
    const { rows } = await pool.query(
      `SELECT id FROM tasks
       WHERE status <> 'Approved'
         AND lower(trim(work_location)) = $1
         AND lower(trim(work_location_other)) = $2
         AND lower(trim(tower)) = $3
         AND lower(trim(flat_number)) = $4
         AND lower(trim(description)) = $5
       LIMIT 1`,
      [norm(workLocation), norm(workLocationOther), norm(tower), norm(flatNumber), norm(description)]
    );
    return rows[0] ? rows[0].id : null;
  },

  async createTask({ workLocation, workLocationOther, tower, flatNumber, contractorName, description, loggedBy, auditEntry }) {
    const { rows } = await pool.query(`SELECT nextval('task_seq') AS n`);
    const id = 'PT-' + String(rows[0].n).padStart(4, '0');
    const { rows: inserted } = await pool.query(
      `INSERT INTO tasks (id, work_location, work_location_other, tower, flat_number, contractor_name, description, logged_by, status, audit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Assigned to Contractor',$9::jsonb)
       RETURNING *`,
      [id, workLocation, workLocationOther || '', tower || '', flatNumber || '', contractorName || '', description, loggedBy, JSON.stringify([auditEntry])]
    );
    return rowToTask(inserted[0]);
  },

  // Admin-only: directly overwrite any provided fields and/or status,
  // bypassing the normal workflow-order restriction entirely.
  async adminUpdateTask(id, fields, auditEntry) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return { error: 'not_found' };
      }
      const current = rowToTask(rows[0]);
      const next = {
        workLocation: fields.workLocation ?? current.workLocation,
        workLocationOther: fields.workLocationOther ?? current.workLocationOther,
        tower: fields.tower ?? current.tower,
        flatNumber: fields.flatNumber ?? current.flatNumber,
        contractorName: fields.contractorName ?? current.contractorName,
        description: fields.description ?? current.description,
        status: fields.status ?? current.status,
      };
      const nextAudit = current.audit.concat([auditEntry]);
      const { rows: updated } = await client.query(
        `UPDATE tasks
         SET work_location=$1, work_location_other=$2, tower=$3, flat_number=$4,
             contractor_name=$5, description=$6, status=$7, audit=$8::jsonb
         WHERE id=$9
         RETURNING *`,
        [next.workLocation, next.workLocationOther, next.tower, next.flatNumber, next.contractorName, next.description, next.status, JSON.stringify(nextAudit), id]
      );
      await client.query('COMMIT');
      return { task: rowToTask(updated[0]) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // Fetches the row, applies `mutate(row)` to compute new field values, and
  // writes them back inside a transaction with a row lock so concurrent
  // actions on the same task can't race each other.
  async updateTask(id, expectedStatuses, mutate) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return { error: 'not_found' };
      }
      const current = rowToTask(rows[0]);
      if (expectedStatuses && !expectedStatuses.includes(current.status)) {
        await client.query('ROLLBACK');
        return { error: 'bad_status', current };
      }
      const changes = mutate(current);
      const nextAudit = current.audit.concat([changes.auditEntry]);
      const { rows: updated } = await client.query(
        `UPDATE tasks
         SET status = $1, checker = $2, audit = $3::jsonb
         WHERE id = $4
         RETURNING *`,
        [changes.status, changes.checker ?? current.checker, JSON.stringify(nextAudit), id]
      );
      await client.query('COMMIT');
      return { task: rowToTask(updated[0]) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};
