import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { filesMigrations, type FilesDatabase } from '@blacklabel/files';

describe('files migrations', () => {
  it('apply on a fresh db (after core) and create all module tables', async () => {
    const db = createTestDb<FilesDatabase>();
    const result = await runMigrations(db, [...coreMigrations, ...filesMigrations]);
    expect(result.applied).toContain('files.0001_files_tables');

    // Every table is queryable (empty).
    expect(await db.selectFrom('files_folders').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('files_assets').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('files_links').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('files_upload_sessions').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('files_permissions').selectAll().execute()).toEqual([]);
  });

  it('are idempotent on re-run', async () => {
    const db = createTestDb<FilesDatabase>();
    await runMigrations(db, [...coreMigrations, ...filesMigrations]);
    const second = await runMigrations(db, [...coreMigrations, ...filesMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('files.0001_files_tables');
  });
});
