/**
 * files module — tenant-scoped business logic.
 * Every query filters by tenant_id; every mutation is audited and (where it
 * matters cross-module) emits a domain event AFTER the write succeeds.
 */
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  ApiError,
  EventBus,
  asCoreDb,
  audit,
  id,
  nowIso,
  type Pagination,
  type Sort,
  type UserRole,
} from '@blacklabel/core';
import type {
  FileVisibility,
  FilesAssetRow,
  FilesDatabase,
  FilesFolderRow,
  FilesLinkRow,
  FilesPermissionRow,
  FilesUploadSessionRow,
  PermissionGranteeType,
} from './schema';
import { StorageError, newStorageKey, type StorageProvider } from './storage';
import { assertFileSize } from './upload-limits';

type Db = Kysely<FilesDatabase>;

/* ------------------------------------------------------------------ *
 * Validation helpers (no secrets / no user-controlled paths)
 * ------------------------------------------------------------------ */

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,49}$/i;
/** 1–2 lowercase dot-separated segments, e.g. "customer" or "crm.customer". */
const ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;

export const FILE_VISIBILITIES: readonly FileVisibility[] = ['private', 'tenant', 'public'];
const USER_ROLES: readonly UserRole[] = ['owner', 'admin', 'member'];

/**
 * Filenames are display metadata ONLY — they are never used as storage paths
 * and never appear in download URLs (those are id-based). Still, reject
 * anything path-like or containing control characters so a filename can never
 * be abused downstream.
 */
export function assertSafeFilename(raw: string): string {
  const name = raw.trim();
  if (name === '') throw ApiError.badRequest('file name is required');
  if (name.length > 255) throw ApiError.badRequest('file name too long (max 255 chars)');
  if (name === '.' || name === '..') throw ApiError.badRequest('invalid file name');
  // eslint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f\u007f]/.test(name)) {
    throw ApiError.badRequest('file name may not contain path separators or control characters');
  }
  return name;
}

function assertMime(mime: string): string {
  const m = mime.trim().toLowerCase();
  if (!MIME_PATTERN.test(m)) throw ApiError.badRequest(`invalid mime type: ${mime}`);
  return m;
}

function normalizeTags(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return '[]';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (!TAG_PATTERN.test(tag)) {
      throw ApiError.badRequest(`invalid tag "${raw}" (letters/digits/_/-, max 50 chars)`);
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return JSON.stringify(out);
}

export function parseTags(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function assertEntityRef(entityType: string, entityId: string): void {
  if (!ENTITY_TYPE_PATTERN.test(entityType)) {
    throw ApiError.badRequest(`invalid entity_type: ${entityType}`);
  }
  if (!entityId || entityId.trim() === '') {
    throw ApiError.badRequest('entity_id is required');
  }
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/* ------------------------------------------------------------------ *
 * Actors & permission checks
 * ------------------------------------------------------------------ */

export interface FilesActor {
  /** Core user id, or null for the trusted system/back-office actor. */
  userId: string | null;
  role: UserRole | null;
  isSystem: boolean;
}

export const SYSTEM_ACTOR: FilesActor = { userId: null, role: null, isSystem: true };

/** Audit "actor" string for an actor. */
export function actorLabel(actor: FilesActor): string {
  return actor.userId ?? 'system';
}

/**
 * Resolve the acting user from the `x-user-id` header value.
 * - absent header -> trusted system actor (integration/back-office calls)
 * - unknown user id (in this tenant) -> 401
 */
export async function resolveActor(
  db: Db,
  tenantId: string,
  userId: string | undefined | null,
): Promise<FilesActor> {
  if (!userId || userId.trim() === '') return SYSTEM_ACTOR;
  const user = await db
    .selectFrom('users')
    .select(['id', 'role'])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) throw ApiError.unauthorized(`unknown user: ${userId}`);
  return { userId: user.id, role: user.role, isSystem: false };
}

export type AccessMode = 'read' | 'write';

function actorHasImplicitAccess(actor: FilesActor, file: FilesAssetRow): boolean {
  if (actor.isSystem) return true;
  if (actor.role === 'owner' || actor.role === 'admin') return true;
  if (actor.userId !== null && file.uploaded_by === actor.userId) return true;
  return false;
}

/** Grant rows matching this actor (user grant or role grant). */
async function findGrants(
  db: Db,
  tenantId: string,
  actor: FilesActor,
  fileId?: string,
): Promise<FilesPermissionRow[]> {
  if (actor.userId === null || actor.role === null) return [];
  let q = db
    .selectFrom('files_permissions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where((eb) =>
      eb.or([
        eb.and([eb('grantee_type', '=', 'user'), eb('grantee', '=', actor.userId!)]),
        eb.and([eb('grantee_type', '=', 'role'), eb('grantee', '=', actor.role!)]),
      ]),
    );
  if (fileId !== undefined) q = q.where('file_id', '=', fileId);
  return q.orderBy('created_at').orderBy('id').execute();
}

/**
 * The permission rule (spec): owner/admin (and the trusted system actor, and
 * the uploader) get full access; everyone else needs a grant. Additionally,
 * `visibility: tenant|public` opens READ to all tenant users.
 * Throws ApiError.forbidden() when access is denied.
 */
export async function assertFileAccess(
  db: Db,
  tenantId: string,
  actor: FilesActor,
  file: FilesAssetRow,
  mode: AccessMode,
): Promise<void> {
  if (actorHasImplicitAccess(actor, file)) return;
  if (mode === 'read' && (file.visibility === 'tenant' || file.visibility === 'public')) return;
  const grants = await findGrants(db, tenantId, actor, file.id);
  const allowed = mode === 'read' ? grants.length > 0 : grants.some((g) => g.can_write === 1);
  if (!allowed) {
    throw ApiError.forbidden(`no ${mode} access to file ${file.id}`);
  }
}

/* ------------------------------------------------------------------ *
 * Folders (nested)
 * ------------------------------------------------------------------ */

async function getFolder(db: Db, tenantId: string, folderId: string) {
  return db
    .selectFrom('files_folders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', folderId)
    .executeTakeFirst();
}

async function assertFolderExists(db: Db, tenantId: string, folderId: string): Promise<void> {
  const folder = await getFolder(db, tenantId, folderId);
  if (!folder) throw ApiError.badRequest(`folder not found: ${folderId}`);
}

export async function createFolder(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: FilesActor,
  input: { name: string; parent_id?: string | null },
): Promise<FilesFolderRow> {
  const name = assertSafeFilename(input.name);
  const parentId = input.parent_id ?? null;
  if (parentId !== null) await assertFolderExists(db, tenantId, parentId);
  const now = nowIso();
  const row: FilesFolderRow = {
    id: id(),
    tenant_id: tenantId,
    parent_id: parentId,
    name,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('files_folders').values(row).execute();
  await audit(asCoreDb(db), tenantId, actorLabel(actor), 'files.folder.created', 'files.folder', row.id, {
    name,
    parent_id: parentId,
  });
  await events.emit(tenantId, 'files.folder.created', { folderId: row.id, name, parentId });
  return row;
}

export async function listFolders(
  db: Db,
  tenantId: string,
  page: Pagination,
): Promise<FilesFolderRow[]> {
  return db
    .selectFrom('files_folders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export interface FolderTreeNode extends FilesFolderRow {
  children: FolderTreeNode[];
}

/** Full folder tree for a tenant (roots first, children sorted by name). */
export async function folderTree(db: Db, tenantId: string): Promise<FolderTreeNode[]> {
  const rows = await db
    .selectFrom('files_folders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .orderBy('id')
    .execute();
  const nodes = new Map<string, FolderTreeNode>();
  for (const row of rows) nodes.set(row.id, { ...row, children: [] });
  const roots: FolderTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id === null ? undefined : nodes.get(node.parent_id);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Walk up from `startId`; throws if `forbiddenId` appears among ancestors. */
async function assertNoCycle(
  db: Db,
  tenantId: string,
  startId: string,
  forbiddenId: string,
): Promise<void> {
  let current: string | null = startId;
  const seen = new Set<string>();
  while (current !== null) {
    if (current === forbiddenId) {
      throw ApiError.badRequest('folder cannot be moved inside itself');
    }
    if (seen.has(current)) return; // pre-existing cycle; don't loop forever
    seen.add(current);
    const parent = await getFolder(db, tenantId, current);
    current = parent?.parent_id ?? null;
  }
}

export async function updateFolder(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: FilesActor,
  folderId: string,
  patch: { name?: string; parent_id?: string | null },
): Promise<FilesFolderRow> {
  const folder = await getFolder(db, tenantId, folderId);
  if (!folder) throw ApiError.notFound(`folder not found: ${folderId}`);

  const set: Partial<Pick<FilesFolderRow, 'name' | 'parent_id' | 'updated_at'>> = {};
  if (patch.name !== undefined) set.name = assertSafeFilename(patch.name);
  if (patch.parent_id !== undefined) {
    if (patch.parent_id !== null) {
      if (patch.parent_id === folderId) throw ApiError.badRequest('folder cannot be its own parent');
      await assertFolderExists(db, tenantId, patch.parent_id);
      await assertNoCycle(db, tenantId, patch.parent_id, folderId);
    }
    set.parent_id = patch.parent_id;
  }
  if (Object.keys(set).length === 0) return folder;
  set.updated_at = nowIso();

  await db
    .updateTable('files_folders')
    .set(set)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', folderId)
    .execute();
  const updated = (await getFolder(db, tenantId, folderId))!;
  await audit(asCoreDb(db), tenantId, actorLabel(actor), 'files.folder.updated', 'files.folder', folderId, {
    before: { name: folder.name, parent_id: folder.parent_id },
    after: { name: updated.name, parent_id: updated.parent_id },
  });
  await events.emit(tenantId, 'files.folder.updated', { folderId });
  return updated;
}

export async function deleteFolder(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: FilesActor,
  folderId: string,
): Promise<void> {
  const folder = await getFolder(db, tenantId, folderId);
  if (!folder) throw ApiError.notFound(`folder not found: ${folderId}`);
  const child = await db
    .selectFrom('files_folders')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('parent_id', '=', folderId)
    .executeTakeFirst();
  if (child) throw ApiError.conflict('folder has subfolders — move or delete them first');
  const file = await db
    .selectFrom('files_assets')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('folder_id', '=', folderId)
    .executeTakeFirst();
  if (file) throw ApiError.conflict('folder contains files — move or delete them first');
  // A pending upload session targets this folder: deleting it now would let the
  // later /complete create a file with a dangling folder_id.
  const pendingUpload = await db
    .selectFrom('files_upload_sessions')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('folder_id', '=', folderId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (pendingUpload) {
    throw ApiError.conflict('folder is the target of a pending upload — complete or abort it first');
  }

  await db
    .deleteFrom('files_folders')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', folderId)
    .execute();
  await audit(asCoreDb(db), tenantId, actorLabel(actor), 'files.folder.deleted', 'files.folder', folderId, {
    name: folder.name,
  });
  await events.emit(tenantId, 'files.folder.deleted', { folderId });
}

/* ------------------------------------------------------------------ *
 * Upload sessions (init -> complete two-step)
 * ------------------------------------------------------------------ */

export interface InitUploadInput {
  name: string;
  mime: string;
  folder_id?: string | null;
  visibility?: FileVisibility;
  tags?: string[];
}

export async function initUpload(
  db: Db,
  tenantId: string,
  actor: FilesActor,
  input: InitUploadInput,
): Promise<FilesUploadSessionRow> {
  const name = assertSafeFilename(input.name);
  const mime = assertMime(input.mime);
  const folderId = input.folder_id ?? null;
  if (folderId !== null) await assertFolderExists(db, tenantId, folderId);
  const row: FilesUploadSessionRow = {
    id: id(),
    tenant_id: tenantId,
    folder_id: folderId,
    name,
    mime,
    visibility: input.visibility ?? 'private',
    tags: normalizeTags(input.tags),
    status: 'pending',
    // The storage key is random, server-generated — NEVER derived from the
    // client-supplied filename.
    storage_key: newStorageKey(),
    created_by: actorLabel(actor),
    file_id: null,
    created_at: nowIso(),
    completed_at: null,
  };
  await db.insertInto('files_upload_sessions').values(row).execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actorLabel(actor),
    'files.upload.initiated',
    'files.upload_session',
    row.id,
    { name, mime },
  );
  return row;
}

export async function getUploadSession(
  db: Db,
  tenantId: string,
  sessionId: string,
): Promise<FilesUploadSessionRow> {
  const session = await db
    .selectFrom('files_upload_sessions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', sessionId)
    .executeTakeFirst();
  if (!session) throw ApiError.notFound(`upload session not found: ${sessionId}`);
  return session;
}

function assertSessionActor(session: FilesUploadSessionRow, actor: FilesActor): void {
  if (actor.isSystem || actor.role === 'owner' || actor.role === 'admin') return;
  if (session.created_by !== actor.userId) {
    throw ApiError.forbidden('only the upload initiator (or an admin) may act on this session');
  }
}

export async function completeUpload(
  db: Db,
  events: EventBus,
  storage: StorageProvider,
  tenantId: string,
  actor: FilesActor,
  sessionId: string,
  content: Uint8Array,
): Promise<FilesAssetRow> {
  const session = await getUploadSession(db, tenantId, sessionId);
  assertSessionActor(session, actor);
  if (session.status !== 'pending') {
    throw ApiError.conflict(`upload session is ${session.status}, expected pending`);
  }

  assertFileSize(content.byteLength);
  await storage.put(session.storage_key, content);

  const now = nowIso();
  const file: FilesAssetRow = {
    id: id(),
    tenant_id: tenantId,
    folder_id: session.folder_id,
    name: session.name,
    mime: session.mime,
    size_bytes: content.byteLength,
    sha256: sha256Hex(content),
    storage_key: session.storage_key,
    uploaded_by: session.created_by,
    visibility: session.visibility,
    tags: session.tags,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('files_assets').values(file).execute();
  await db
    .updateTable('files_upload_sessions')
    .set({ status: 'completed', file_id: file.id, completed_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', sessionId)
    .execute();

  await audit(asCoreDb(db), tenantId, actorLabel(actor), 'files.file.uploaded', 'files.file', file.id, {
    name: file.name,
    mime: file.mime,
    size_bytes: file.size_bytes,
    sha256: file.sha256,
  });
  await events.emit(tenantId, 'files.file.uploaded', {
    fileId: file.id,
    name: file.name,
    mime: file.mime,
    sizeBytes: file.size_bytes,
    sha256: file.sha256,
    folderId: file.folder_id,
    uploadedBy: file.uploaded_by,
  });
  return file;
}

export async function abortUpload(
  db: Db,
  tenantId: string,
  actor: FilesActor,
  sessionId: string,
): Promise<FilesUploadSessionRow> {
  const session = await getUploadSession(db, tenantId, sessionId);
  assertSessionActor(session, actor);
  if (session.status !== 'pending') {
    throw ApiError.conflict(`upload session is ${session.status}, expected pending`);
  }
  await db
    .updateTable('files_upload_sessions')
    .set({ status: 'aborted' })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', sessionId)
    .execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actorLabel(actor),
    'files.upload.aborted',
    'files.upload_session',
    sessionId,
  );
  return { ...session, status: 'aborted' };
}

/* ------------------------------------------------------------------ *
 * File assets
 * ------------------------------------------------------------------ */

export async function getFileOrThrow(
  db: Db,
  tenantId: string,
  fileId: string,
): Promise<FilesAssetRow> {
  const file = await db
    .selectFrom('files_assets')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', fileId)
    .executeTakeFirst();
  if (!file) throw ApiError.notFound(`file not found: ${fileId}`);
  return file;
}

export interface FileSearch {
  /** Substring match on name. */
  name?: string;
  mime?: string;
  tag?: string;
  folder_id?: string;
  visibility?: string;
  /** Linked-entity filter — both must be provided together. */
  entity_type?: string;
  entity_id?: string;
}

/**
 * Metadata search. Members (non-admin) only see files they could read:
 * tenant/public visibility, their own uploads, or explicit grants.
 */
export async function listFiles(
  db: Db,
  tenantId: string,
  actor: FilesActor,
  search: FileSearch,
  page: Pagination,
  sort: Sort,
): Promise<FilesAssetRow[]> {
  let q = db.selectFrom('files_assets').selectAll().where('tenant_id', '=', tenantId);

  if (search.name) q = q.where('name', 'like', `%${search.name}%`);
  if (search.mime) q = q.where('mime', '=', search.mime.toLowerCase());
  if (search.folder_id) q = q.where('folder_id', '=', search.folder_id);
  if (search.visibility) q = q.where('visibility', '=', search.visibility as FileVisibility);
  if (search.tag) {
    const tag = search.tag.trim().toLowerCase();
    if (!TAG_PATTERN.test(tag)) throw ApiError.badRequest(`invalid tag filter: ${search.tag}`);
    // tags is a JSON array string like ["a","b"] — a quoted-tag LIKE is exact.
    q = q.where('tags', 'like', `%"${tag}"%`);
  }

  const hasType = search.entity_type !== undefined && search.entity_type !== '';
  const hasId = search.entity_id !== undefined && search.entity_id !== '';
  if (hasType !== hasId) {
    throw ApiError.badRequest('entity_type and entity_id must be provided together');
  }
  if (hasType && hasId) {
    assertEntityRef(search.entity_type!, search.entity_id!);
    const linked = await db
      .selectFrom('files_links')
      .select('file_id')
      .where('tenant_id', '=', tenantId)
      .where('entity_type', '=', search.entity_type!)
      .where('entity_id', '=', search.entity_id!)
      .execute();
    const ids = [...new Set(linked.map((r) => r.file_id))];
    if (ids.length === 0) return [];
    q = q.where('id', 'in', ids);
  }

  // Visibility scoping for plain members: readable files only.
  if (!actor.isSystem && actor.role === 'member') {
    const grants = await findGrants(db, tenantId, actor);
    const grantedIds = [...new Set(grants.map((g) => g.file_id))];
    q = q.where((eb) =>
      eb.or([
        eb('visibility', 'in', ['tenant', 'public'] as FileVisibility[]),
        eb('uploaded_by', '=', actor.userId!),
        ...(grantedIds.length > 0 ? [eb('id', 'in', grantedIds)] : []),
      ]),
    );
  }

  return q
    .orderBy(sort.column as 'created_at', sort.direction)
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export interface UpdateFilePatch {
  name?: string;
  folder_id?: string | null;
  visibility?: FileVisibility;
  tags?: string[];
}

export async function updateFile(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: FilesActor,
  fileId: string,
  patch: UpdateFilePatch,
): Promise<FilesAssetRow> {
  const file = await getFileOrThrow(db, tenantId, fileId);
  const set: Partial<
    Pick<FilesAssetRow, 'name' | 'folder_id' | 'visibility' | 'tags' | 'updated_at'>
  > = {};
  if (patch.name !== undefined) set.name = assertSafeFilename(patch.name);
  if (patch.folder_id !== undefined) {
    if (patch.folder_id !== null) await assertFolderExists(db, tenantId, patch.folder_id);
    set.folder_id = patch.folder_id;
  }
  if (patch.visibility !== undefined) set.visibility = patch.visibility;
  if (patch.tags !== undefined) set.tags = normalizeTags(patch.tags);
  if (Object.keys(set).length === 0) return file;
  set.updated_at = nowIso();

  await db
    .updateTable('files_assets')
    .set(set)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', fileId)
    .execute();
  const updated = await getFileOrThrow(db, tenantId, fileId);
  await audit(asCoreDb(db), tenantId, actorLabel(actor), 'files.file.updated', 'files.file', fileId, {
    before: { name: file.name, folder_id: file.folder_id, visibility: file.visibility, tags: file.tags },
    after: {
      name: updated.name,
      folder_id: updated.folder_id,
      visibility: updated.visibility,
      tags: updated.tags,
    },
  });
  await events.emit(tenantId, 'files.file.updated', { fileId });
  return updated;
}

export async function deleteFile(
  db: Db,
  events: EventBus,
  storage: StorageProvider,
  tenantId: string,
  actor: FilesActor,
  fileId: string,
): Promise<void> {
  const file = await getFileOrThrow(db, tenantId, fileId);
  await db.deleteFrom('files_links').where('tenant_id', '=', tenantId).where('file_id', '=', fileId).execute();
  await db
    .deleteFrom('files_permissions')
    .where('tenant_id', '=', tenantId)
    .where('file_id', '=', fileId)
    .execute();
  await db.deleteFrom('files_assets').where('tenant_id', '=', tenantId).where('id', '=', fileId).execute();
  await storage.delete(file.storage_key);
  await audit(asCoreDb(db), tenantId, actorLabel(actor), 'files.file.deleted', 'files.file', fileId, {
    name: file.name,
    sha256: file.sha256,
  });
  await events.emit(tenantId, 'files.file.deleted', { fileId });
}

/** Raw content bytes for a file (permission checks happen in the router). */
export async function readFileContent(
  storage: StorageProvider,
  file: FilesAssetRow,
): Promise<Uint8Array> {
  try {
    return await storage.get(file.storage_key);
  } catch (err) {
    if (err instanceof StorageError && err.code === 'not_found') {
      throw ApiError.notFound(`stored content missing for file ${file.id}`);
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Links (file -> polymorphic entity)
 * ------------------------------------------------------------------ */

export async function attachLink(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: FilesActor,
  fileId: string,
  input: { entity_type: string; entity_id: string },
): Promise<FilesLinkRow> {
  await getFileOrThrow(db, tenantId, fileId);
  const entityType = input.entity_type.trim().toLowerCase();
  const entityId = input.entity_id.trim();
  assertEntityRef(entityType, entityId);
  const existing = await db
    .selectFrom('files_links')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('file_id', '=', fileId)
    .where('entity_type', '=', entityType)
    .where('entity_id', '=', entityId)
    .executeTakeFirst();
  if (existing) {
    throw ApiError.conflict('file is already linked to this entity');
  }
  const row: FilesLinkRow = {
    id: id(),
    tenant_id: tenantId,
    file_id: fileId,
    entity_type: entityType,
    entity_id: entityId,
    created_at: nowIso(),
  };
  await db.insertInto('files_links').values(row).execute();
  await audit(asCoreDb(db), tenantId, actorLabel(actor), 'files.file.linked', 'files.link', row.id, {
    file_id: fileId,
    entity_type: entityType,
    entity_id: entityId,
  });
  await audit(asCoreDb(db), tenantId, actorLabel(actor), 'files.file.linked', 'files.file', fileId, {
    link_id: row.id, entity_type: entityType, entity_id: entityId,
  });
  await events.emit(tenantId, 'files.file.linked', { fileId, entityType, entityId });
  return row;
}

export async function detachLink(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: FilesActor,
  fileId: string,
  linkId: string,
): Promise<void> {
  const link = await db
    .selectFrom('files_links')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('file_id', '=', fileId)
    .where('id', '=', linkId)
    .executeTakeFirst();
  if (!link) throw ApiError.notFound(`link not found: ${linkId}`);
  await db.deleteFrom('files_links').where('tenant_id', '=', tenantId).where('id', '=', linkId).execute();
  await audit(asCoreDb(db), tenantId, actorLabel(actor), 'files.file.unlinked', 'files.link', linkId, {
    file_id: fileId,
    entity_type: link.entity_type,
    entity_id: link.entity_id,
  });
  await audit(asCoreDb(db), tenantId, actorLabel(actor), 'files.file.unlinked', 'files.file', fileId, {
    link_id: linkId, entity_type: link.entity_type, entity_id: link.entity_id,
  });
  await events.emit(tenantId, 'files.file.unlinked', {
    fileId,
    entityType: link.entity_type,
    entityId: link.entity_id,
  });
}

export async function listLinksForFile(
  db: Db,
  tenantId: string,
  fileId: string,
): Promise<FilesLinkRow[]> {
  await getFileOrThrow(db, tenantId, fileId);
  return db
    .selectFrom('files_links')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('file_id', '=', fileId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/* ------------------------------------------------------------------ *
 * Permissions (per-file role/principal grants)
 * ------------------------------------------------------------------ */

export interface GrantPermissionInput {
  grantee_type: PermissionGranteeType;
  grantee: string;
  can_write?: boolean;
}

export async function grantPermission(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: FilesActor,
  fileId: string,
  input: GrantPermissionInput,
): Promise<FilesPermissionRow> {
  await getFileOrThrow(db, tenantId, fileId);
  const grantee = input.grantee.trim();
  if (grantee === '') throw ApiError.badRequest('grantee is required');
  if (input.grantee_type === 'role') {
    if (!USER_ROLES.includes(grantee as UserRole)) {
      throw ApiError.badRequest(`unknown role: ${grantee}`, { allowed: USER_ROLES });
    }
  } else {
    const user = await db
      .selectFrom('users')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', grantee)
      .executeTakeFirst();
    if (!user) throw ApiError.badRequest(`no such user in tenant: ${grantee}`);
  }
  const existing = await db
    .selectFrom('files_permissions')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('file_id', '=', fileId)
    .where('grantee_type', '=', input.grantee_type)
    .where('grantee', '=', grantee)
    .executeTakeFirst();
  if (existing) throw ApiError.conflict('an identical grant already exists for this file');

  const row: FilesPermissionRow = {
    id: id(),
    tenant_id: tenantId,
    file_id: fileId,
    grantee_type: input.grantee_type,
    grantee,
    can_write: input.can_write ? 1 : 0,
    created_at: nowIso(),
  };
  await db.insertInto('files_permissions').values(row).execute();
  await audit(asCoreDb(db), tenantId, actorLabel(actor), 'files.permission.granted', 'files.permission', row.id, {
    file_id: fileId,
    grantee_type: row.grantee_type,
    grantee: row.grantee,
    can_write: row.can_write,
  });
  await audit(asCoreDb(db), tenantId, actorLabel(actor), 'files.permission.granted', 'files.file', fileId, {
    permission_id: row.id, grantee_type: row.grantee_type, grantee: row.grantee, can_write: row.can_write,
  });
  await events.emit(tenantId, 'files.permission.granted', {
    fileId,
    permissionId: row.id,
    granteeType: row.grantee_type,
    grantee: row.grantee,
    canWrite: row.can_write === 1,
  });
  return row;
}

export async function revokePermission(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: FilesActor,
  fileId: string,
  permissionId: string,
): Promise<void> {
  const perm = await db
    .selectFrom('files_permissions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('file_id', '=', fileId)
    .where('id', '=', permissionId)
    .executeTakeFirst();
  if (!perm) throw ApiError.notFound(`permission not found: ${permissionId}`);
  await db
    .deleteFrom('files_permissions')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', permissionId)
    .execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actorLabel(actor),
    'files.permission.revoked',
    'files.permission',
    permissionId,
    { file_id: fileId, grantee_type: perm.grantee_type, grantee: perm.grantee },
  );
  await audit(asCoreDb(db), tenantId, actorLabel(actor), 'files.permission.revoked', 'files.file', fileId, {
    permission_id: permissionId, grantee_type: perm.grantee_type, grantee: perm.grantee,
  });
  await events.emit(tenantId, 'files.permission.revoked', { fileId, permissionId });
}

export async function listPermissions(
  db: Db,
  tenantId: string,
  fileId: string,
): Promise<FilesPermissionRow[]> {
  await getFileOrThrow(db, tenantId, fileId);
  return db
    .selectFrom('files_permissions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('file_id', '=', fileId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}
