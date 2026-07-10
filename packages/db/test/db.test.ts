import { describe, expect, it } from 'vitest';
import { createTestDb, runMigrations, sql, type Migration } from '@blacklabel/db';

function tableMigration(name: string, table: string, log?: string[]): Migration {
  return {
    name,
    up: async (db) => {
      log?.push(name);
      await db.schema
        .createTable(table)
        .addColumn('id', 'text', (c) => c.primaryKey())
        .execute();
    },
  };
}

describe('createTestDb', () => {
  it('returns a working in-memory Kysely instance', async () => {
    const db = createTestDb();
    const result = await sql<{ answer: number }>`select 1 + 1 as answer`.execute(db);
    expect(result.rows[0]?.answer).toBe(2);
    await db.destroy();
  });

  it('returns isolated databases per call', async () => {
    const a = createTestDb();
    const b = createTestDb();
    await runMigrations(a, [tableMigration('t.0001_only_in_a', 'only_in_a')]);
    const tablesInB = await b.introspection.getTables();
    expect(tablesInB.map((t) => t.name)).not.toContain('only_in_a');
    await a.destroy();
    await b.destroy();
  });
});

describe('runMigrations', () => {
  it('applies migrations in array order and records bookkeeping', async () => {
    const db = createTestDb();
    const order: string[] = [];
    const result = await runMigrations(db, [
      tableMigration('m.0001_first', 'first_table', order),
      tableMigration('m.0002_second', 'second_table', order),
      tableMigration('m.0003_third', 'third_table', order),
    ]);

    expect(order).toEqual(['m.0001_first', 'm.0002_second', 'm.0003_third']);
    expect(result.applied).toEqual(['m.0001_first', 'm.0002_second', 'm.0003_third']);
    expect(result.skipped).toEqual([]);

    const rows = await sql<{ name: string }>`select name from _migrations order by name`.execute(db);
    expect(rows.rows.map((r) => r.name)).toEqual(['m.0001_first', 'm.0002_second', 'm.0003_third']);
    await db.destroy();
  });

  it('is idempotent — a second run applies nothing', async () => {
    const db = createTestDb();
    const migrations = [tableMigration('m.0001_first', 'first_table')];
    await runMigrations(db, migrations);
    const second = await runMigrations(db, migrations);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['m.0001_first']);
    await db.destroy();
  });

  it('applies only newly appended migrations on later runs', async () => {
    const db = createTestDb();
    const order: string[] = [];
    const m1 = tableMigration('m.0001_first', 'first_table', order);
    const m2 = tableMigration('m.0002_second', 'second_table', order);
    await runMigrations(db, [m1]);
    const result = await runMigrations(db, [m1, m2]);
    expect(result.applied).toEqual(['m.0002_second']);
    expect(result.skipped).toEqual(['m.0001_first']);
    expect(order).toEqual(['m.0001_first', 'm.0002_second']);
    await db.destroy();
  });

  it('rejects duplicate migration names before running anything', async () => {
    const db = createTestDb();
    const order: string[] = [];
    await expect(
      runMigrations(db, [
        tableMigration('m.0001_dup', 'a_table', order),
        tableMigration('m.0001_dup', 'b_table', order),
      ]),
    ).rejects.toThrow(/duplicate migration name/);
    expect(order).toEqual([]);
    await db.destroy();
  });
});
