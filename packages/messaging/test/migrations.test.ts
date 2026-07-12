import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { messagingMigrations, type MessagingDatabase } from '@blacklabel/messaging';

describe('messaging migrations', () => {
  it('applies cleanly on a fresh db after core migrations', async () => {
    const db = createTestDb<MessagingDatabase>();
    const result = await runMigrations(db, [...coreMigrations, ...messagingMigrations]);
    for (const m of messagingMigrations) {
      expect(result.applied).toContain(m.name);
    }
    // every messaging table is queryable and empty
    expect(await db.selectFrom('messaging_channels').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('messaging_conversations').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('messaging_messages').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('messaging_templates').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('messaging_participants').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('messaging_assignments').selectAll().execute()).toEqual([]);
  });

  it('is idempotent on re-run', async () => {
    const db = createTestDb<MessagingDatabase>();
    await runMigrations(db, [...coreMigrations, ...messagingMigrations]);
    const second = await runMigrations(db, [...coreMigrations, ...messagingMigrations]);
    expect(second.applied).toEqual([]);
    for (const m of messagingMigrations) {
      expect(second.skipped).toContain(m.name);
    }
  });

  it('uses globally-unique, module-prefixed migration names', () => {
    const names = messagingMigrations.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^messaging\.\d{4}_[a-z0-9_]+$/);
    }
  });
});
