/**
 * Demo/seed data for the files module. Industry-neutral sample vault:
 * a small folder tree, a few uploaded documents, entity links, and one
 * role grant. Uses the in-memory storage provider by default so seeding
 * never touches disk unless the caller injects a real adapter.
 */
import type { Kysely } from 'kysely';
import { EventBus, id } from '@blacklabel/core';
import type { FilesAssetRow, FilesDatabase, FilesFolderRow } from './schema';
import { MemoryStorageProvider, type StorageProvider } from './storage';
import {
  SYSTEM_ACTOR,
  attachLink,
  completeUpload,
  createFolder,
  grantPermission,
  initUpload,
} from './service';

export interface SeedFilesOptions {
  storage?: StorageProvider;
  events?: EventBus;
}

export interface SeedFilesResult {
  folders: FilesFolderRow[];
  files: FilesAssetRow[];
  linkCount: number;
  permissionCount: number;
}

async function uploadDemo(
  db: Kysely<FilesDatabase>,
  events: EventBus,
  storage: StorageProvider,
  tenantId: string,
  input: { name: string; mime: string; folderId: string | null; visibility?: 'private' | 'tenant' | 'public'; tags?: string[]; content: string },
): Promise<FilesAssetRow> {
  const session = await initUpload(db, tenantId, SYSTEM_ACTOR, {
    name: input.name,
    mime: input.mime,
    folder_id: input.folderId,
    visibility: input.visibility,
    tags: input.tags,
  });
  return completeUpload(
    db,
    events,
    storage,
    tenantId,
    SYSTEM_ACTOR,
    session.id,
    new TextEncoder().encode(input.content),
  );
}

export async function seedFiles(
  db: Kysely<FilesDatabase>,
  tenantId: string,
  options: SeedFilesOptions = {},
): Promise<SeedFilesResult> {
  const storage = options.storage ?? new MemoryStorageProvider();
  const events = options.events ?? new EventBus();

  const documents = await createFolder(db, events, tenantId, SYSTEM_ACTOR, { name: 'Documents' });
  const contracts = await createFolder(db, events, tenantId, SYSTEM_ACTOR, {
    name: 'Contracts',
    parent_id: documents.id,
  });
  const media = await createFolder(db, events, tenantId, SYSTEM_ACTOR, { name: 'Media' });

  const welcome = await uploadDemo(db, events, storage, tenantId, {
    name: 'welcome-guide.pdf',
    mime: 'application/pdf',
    folderId: documents.id,
    visibility: 'tenant',
    tags: ['onboarding', 'guide'],
    content: 'Demo welcome guide content',
  });
  const agreement = await uploadDemo(db, events, storage, tenantId, {
    name: 'service-agreement.pdf',
    mime: 'application/pdf',
    folderId: contracts.id,
    visibility: 'private',
    tags: ['contract'],
    content: 'Demo service agreement content',
  });
  const logo = await uploadDemo(db, events, storage, tenantId, {
    name: 'logo.png',
    mime: 'image/png',
    folderId: media.id,
    visibility: 'public',
    tags: ['brand'],
    content: 'not-really-a-png',
  });

  // Cross-module references are id strings only.
  const demoCustomerId = id();
  const demoQuoteId = id();
  await attachLink(db, events, tenantId, SYSTEM_ACTOR, welcome.id, {
    entity_type: 'crm.customer',
    entity_id: demoCustomerId,
  });
  await attachLink(db, events, tenantId, SYSTEM_ACTOR, agreement.id, {
    entity_type: 'quoting.quote',
    entity_id: demoQuoteId,
  });

  await grantPermission(db, events, tenantId, SYSTEM_ACTOR, agreement.id, {
    grantee_type: 'role',
    grantee: 'member',
    can_write: false,
  });

  return {
    folders: [documents, contracts, media],
    files: [welcome, agreement, logo],
    linkCount: 2,
    permissionCount: 1,
  };
}
