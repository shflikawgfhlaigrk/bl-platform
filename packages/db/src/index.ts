/**
 * @blacklabel/db — SQLite (better-sqlite3) + Kysely database layer.
 *
 * - createDb(path)  : file-backed database (WAL, foreign keys ON)
 * - createTestDb()  : in-memory database for tests
 * - runMigrations() : idempotent, deterministic-order migration runner
 *
 * See /CONVENTIONS.md ("Database & migrations") for how modules register
 * their migrations.
 */
import SqliteDatabase from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';

// Re-export the Kysely surface modules need, so they never import 'kysely'
// with a mismatched instance.
export { Kysely, sql, SqliteDialect } from 'kysely';
export type {
  Insertable,
  Selectable,
  Updateable,
  Transaction,
} from 'kysely';

function makeKysely<DB>(database: InstanceType<typeof SqliteDatabase>): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new SqliteDialect({ database }),
  });
}

/**
 * Open (or create) a file-backed SQLite database.
 * Pass the row-type map of your module as the generic, e.g.
 * `createDb<CoreDatabase & CrmDatabase>('.storage/platform.db')`.
 */
export function createDb<DB = unknown>(path: string): Kysely<DB> {
  const database = new SqliteDatabase(path);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  return makeKysely<DB>(database);
}

/**
 * In-memory SQLite database for tests. Each call returns a fresh, empty db.
 */
export function createTestDb<DB = unknown>(): Kysely<DB> {
  const database = new SqliteDatabase(':memory:');
  database.pragma('foreign_keys = ON');
  return makeKysely<DB>(database);
}

/**
 * A single migration. Names must be globally unique and follow
 * `<module>.<NNNN>_<description>` (e.g. "core.0001_core_tables",
 * "crm.0001_leads"). Migrations are append-only: never edit or reorder a
 * migration that has shipped.
 */
export interface Migration {
  name: string;
  up: (db: Kysely<any>) => Promise<void>;
}

export interface MigrationResult {
  /** Names applied by THIS run, in execution order. */
  applied: string[];
  /** Names skipped because they were already recorded in _migrations. */
  skipped: string[];
}

interface MigrationsTable {
  _migrations: { name: string; applied_at: string };
}

/**
 * Run migrations in the exact order given (deterministic: array order).
 * Bookkeeping lives in a `_migrations` table; already-applied migrations are
 * skipped, so calling this repeatedly is idempotent. Duplicate names are a
 * programmer error and throw before anything runs.
 */
export async function runMigrations(
  db: Kysely<any>,
  migrations: readonly Migration[],
): Promise<MigrationResult> {
  const seen = new Set<string>();
  for (const m of migrations) {
    if (!m.name || typeof m.name !== 'string') {
      throw new Error('runMigrations: every migration needs a non-empty string name');
    }
    if (seen.has(m.name)) {
      throw new Error(`runMigrations: duplicate migration name "${m.name}"`);
    }
    seen.add(m.name);
  }

  await db.schema
    .createTable('_migrations')
    .ifNotExists()
    .addColumn('name', 'text', (c) => c.primaryKey())
    .addColumn('applied_at', 'text', (c) => c.notNull())
    .execute();

  const bookkeeping = db as Kysely<MigrationsTable>;
  const done = new Set(
    (await bookkeeping.selectFrom('_migrations').select('name').execute()).map((r) => r.name),
  );

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.name)) {
      skipped.push(migration.name);
      continue;
    }
    await migration.up(db);
    await bookkeeping
      .insertInto('_migrations')
      .values({ name: migration.name, applied_at: new Date().toISOString() })
      .execute();
    applied.push(migration.name);
  }
  return { applied, skipped };
}
