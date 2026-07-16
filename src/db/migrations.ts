import type Database from "better-sqlite3";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial durable state",
    sql: `
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        remote_conversation_id TEXT NULL,
        remote_url TEXT NULL,
        remote_title TEXT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'provisioning', 'idle', 'running', 'needs_attention',
          'delete_pending', 'delete_failed', 'deleted_local',
          'deleted_remote', 'orphaned', 'error'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT NULL,
        remote_deleted_at TEXT NULL,
        last_error_code TEXT NULL,
        last_error_message TEXT NULL
      );

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
        operation_type TEXT NOT NULL CHECK (operation_type IN (
          'create_thread', 'send_message', 'delete_thread'
        )),
        input_text TEXT NULL,
        input_sha256 TEXT NULL,
        idempotency_key TEXT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'queued', 'navigating', 'submitting', 'running',
          'needs_attention', 'succeeded', 'failed', 'timed_out',
          'interrupted', 'cancelled'
        )),
        phase TEXT NOT NULL,
        submission_state TEXT NOT NULL CHECK (submission_state IN (
          'not_started', 'typed', 'submitted_unconfirmed', 'confirmed'
        )),
        delete_remote_requested INTEGER NOT NULL DEFAULT 0 CHECK (
          delete_remote_requested IN (0, 1)
        ),
        delete_remote_permitted INTEGER NOT NULL DEFAULT 0 CHECK (
          delete_remote_permitted IN (0, 1)
        ),
        final_response TEXT NULL,
        error_code TEXT NULL,
        error_message TEXT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT NULL,
        completed_at TEXT NULL
      );

      CREATE UNIQUE INDEX runs_idempotency_scope_unique
        ON runs(thread_id, operation_type, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE INDEX runs_queue_order
        ON runs(state, created_at, id);

      CREATE INDEX runs_thread_history
        ON runs(thread_id, created_at, id);

      CREATE TABLE run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX run_events_run_order
        ON run_events(run_id, id);

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        artifact_type TEXT NOT NULL CHECK (artifact_type IN (
          'screenshot', 'html', 'trace', 'dom_fragment'
        )),
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        created_at TEXT NOT NULL
      );

      CREATE INDEX artifacts_run_order
        ON artifacts(run_id, created_at, id);
    `,
  },
];

interface MigrationRow {
  readonly version: number;
}

export function applyMigrations(
  database: Database.Database,
  now: () => string,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedVersions = new Set(
    database
      .prepare<[], MigrationRow>(
        "SELECT version FROM schema_migrations ORDER BY version",
      )
      .all()
      .map((row) => row.version),
  );

  const latestKnownVersion = MIGRATIONS.at(-1)?.version ?? 0;
  const unknownVersion = [...appliedVersions].find(
    (version) => version > latestKnownVersion,
  );
  if (unknownVersion !== undefined) {
    throw new Error(
      `Database migration version ${unknownVersion} is newer than this application`,
    );
  }

  const insertMigration = database.prepare<{
    version: number;
    name: string;
    appliedAt: string;
  }>(`
    INSERT INTO schema_migrations(version, name, applied_at)
    VALUES (@version, @name, @appliedAt)
  `);

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    database.transaction(() => {
      database.exec(migration.sql);
      insertMigration.run({
        version: migration.version,
        name: migration.name,
        appliedAt: now(),
      });
    })();
  }
}

export function getLatestMigrationVersion(): number {
  return MIGRATIONS.at(-1)?.version ?? 0;
}
