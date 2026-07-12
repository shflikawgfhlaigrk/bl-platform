import { describe, expect, it } from 'vitest';
import { asCoreDb, coreMigrations, createTenant, EventBus } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  MemoryStorageProvider,
  filesMigrations,
  seedFiles,
  type FilesDatabase,
} from '@blacklabel/files';

describe('seedFiles', () => {
  it('seeds folders, files, links and a grant — all tenant-scoped, content stored', async () => {
    const db = createTestDb<FilesDatabase>();
    await runMigrations(db, [...coreMigrations, ...filesMigrations]);
    const tenantA = await createTenant(asCoreDb(db), { name: 'Seed A' });
    const tenantB = await createTenant(asCoreDb(db), { name: 'Seed B' });

    const storage = new MemoryStorageProvider();
    const events = new EventBus();
    const result = await seedFiles(db, tenantA.id, { storage, events });

    expect(result.folders).toHaveLength(3);
    expect(result.files).toHaveLength(3);
    expect(result.linkCount).toBe(2);
    expect(result.permissionCount).toBe(1);

    // rows really exist, scoped to tenant A
    const files = await db
      .selectFrom('files_assets')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .execute();
    expect(files).toHaveLength(3);
    for (const f of files) {
      expect(f.tenant_id).toBe(tenantA.id);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await storage.exists(f.storage_key)).toBe(true);
    }
    expect(storage.size()).toBe(3);

    // tenant B sees nothing
    const bFiles = await db
      .selectFrom('files_assets')
      .selectAll()
      .where('tenant_id', '=', tenantB.id)
      .execute();
    expect(bFiles).toEqual([]);

    // second tenant seeds independently
    await seedFiles(db, tenantB.id, { storage: new MemoryStorageProvider(), events });
    const bFilesAfter = await db
      .selectFrom('files_assets')
      .selectAll()
      .where('tenant_id', '=', tenantB.id)
      .execute();
    expect(bFilesAfter).toHaveLength(3);
    // ... and A's rows are untouched
    expect(
      await db.selectFrom('files_assets').selectAll().where('tenant_id', '=', tenantA.id).execute(),
    ).toHaveLength(3);
  });
});
