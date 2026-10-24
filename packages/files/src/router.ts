/**
 * files module HTTP router. Mounted by apps/api at /api/files.
 *
 * Tenant comes ONLY from core's tenantMiddleware (`x-tenant-id` header).
 * The acting user (for permission checks + audit) comes from the optional
 * `x-user-id` header: absent = trusted system actor; unknown id = 401.
 *
 * SECRETS: storage keys never appear in any response body or URL. Downloads
 * are id-based: GET /files/:id/content.
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  listAuditEntries,
  parseFilters,
  parsePagination,
  parseSort,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type {
  FilesAssetRow,
  FilesDatabase,
  FilesFolderRow,
  FilesUploadSessionRow,
} from './schema';
import { LocalDiskStorageProvider, type StorageProvider } from './storage';
import { decodeUpload } from './upload-limits';
import {
  abortUpload,
  assertFileAccess,
  attachLink,
  completeUpload,
  createFolder,
  deleteFile,
  deleteFolder,
  detachLink,
  folderTree,
  getFileOrThrow,
  getUploadSession,
  grantPermission,
  initUpload,
  listFiles,
  listFolders,
  listLinksForFile,
  listPermissions,
  parseTags,
  readFileContent,
  exportEvidence,
  resolveActor,
  revokePermission,
  updateFile,
  updateFolder,
  type AccessMode,
} from './service';

export interface FilesModuleDeps extends ModuleDeps<FilesDatabase> {
  /**
   * Storage adapter. Defaults to the local-disk adapter rooted at
   * `.storage/files`. Tests and cloud deployments inject their own.
   */
  storage?: StorageProvider;
}

/* ------------------------------------------------------------------ *
 * Request schemas (zod) — ZodError -> 400 via core errorHandler
 * ------------------------------------------------------------------ */

const visibilitySchema = z.enum(['private', 'tenant', 'public']);
const tagsSchema = z.array(z.string().min(1).max(50)).max(32);

const createFolderSchema = z.object({
  name: z.string().min(1).max(255),
  parent_id: z.string().min(1).nullish(),
});

const updateFolderSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  parent_id: z.string().min(1).nullable().optional(),
});

const initUploadSchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().min(3).max(255),
  folder_id: z.string().min(1).nullish(),
  visibility: visibilitySchema.optional(),
  tags: tagsSchema.optional(),
});

const completeUploadSchema = z.object({
  /** Raw file bytes, base64-encoded (in-process transport). */
  content_base64: z.string(),
});

const updateFileSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  folder_id: z.string().min(1).nullable().optional(),
  visibility: visibilitySchema.optional(),
  tags: tagsSchema.optional(),
});

const attachLinkSchema = z.object({
  entity_type: z.string().min(1).max(100),
  entity_id: z.string().min(1).max(100),
});

const grantPermissionSchema = z.object({
  grantee_type: z.enum(['role', 'user']),
  grantee: z.string().min(1).max(100),
  can_write: z.boolean().optional(),
});

/* ------------------------------------------------------------------ *
 * Serialization — public shapes NEVER include storage_key
 * ------------------------------------------------------------------ */

function filePublic(row: FilesAssetRow) {
  const { storage_key: _secret, tags, ...rest } = row;
  return { ...rest, tags: parseTags(tags), download_path: `/files/${row.id}/content` };
}

function sessionPublic(row: FilesUploadSessionRow) {
  const { storage_key: _secret, tags, ...rest } = row;
  return { ...rest, tags: parseTags(tags) };
}

function folderPublic(row: FilesFolderRow) {
  return row;
}

async function jsonBody(c: Context<TenantEnv, string>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw ApiError.badRequest('invalid JSON body');
  }
}

export function filesRouter(deps: FilesModuleDeps): Hono<TenantEnv> {
  const { db, events } = deps;
  const storage = deps.storage ?? new LocalDiskStorageProvider('.storage/files');

  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  const actorOf = (c: Context<TenantEnv, string>) =>
    resolveActor(db, c.get('tenantId'), c.req.header('x-user-id'));
  app.get('/evidence',async c=>{
    const input=z.object({entity_type:z.string().min(1).max(100),entity_id:z.string().min(1).max(200)}).parse(c.req.query());
    const packet=await exportEvidence(db,storage,c.get('tenantId'),await actorOf(c),input.entity_type,input.entity_id);
    c.header('Content-Disposition','attachment; filename="job-evidence.json"');
    return c.json({data:packet});
  });

  /**
   * Permission-check middleware for /files/:id routes: owner/admin/system and
   * the uploader have full access; other users need visibility (read) or an
   * explicit grant. Denials -> 403; missing file -> 404.
   */
  const requireFileAccess = (mode: AccessMode): MiddlewareHandler<TenantEnv> => {
    return async (c, next) => {
      const tenantId = c.get('tenantId');
      const fileId = c.req.param('id');
      if (!fileId) throw ApiError.badRequest('file id is required');
      const actor = await actorOf(c);
      const file = await getFileOrThrow(db, tenantId, fileId);
      await assertFileAccess(db, tenantId, actor, file, mode);
      await next();
    };
  };

  /* ---------------- Folders ---------------- */

  app.get('/folders', async (c) => {
    const page = parsePagination(c.req.query());
    await actorOf(c); // 401 for unknown users
    const data = await listFolders(db, c.get('tenantId'), page);
    return c.json({ data: data.map(folderPublic), limit: page.limit, offset: page.offset });
  });

  app.get('/folders/tree', async (c) => {
    await actorOf(c);
    const data = await folderTree(db, c.get('tenantId'));
    return c.json({ data });
  });

  app.post('/folders', async (c) => {
    const body = createFolderSchema.parse(await jsonBody(c));
    const actor = await actorOf(c);
    const folder = await createFolder(db, events, c.get('tenantId'), actor, body);
    return c.json({ data: folderPublic(folder) }, 201);
  });

  app.patch('/folders/:id', async (c) => {
    const body = updateFolderSchema.parse(await jsonBody(c));
    const actor = await actorOf(c);
    const folder = await updateFolder(db, events, c.get('tenantId'), actor, c.req.param('id'), body);
    return c.json({ data: folderPublic(folder) });
  });

  app.delete('/folders/:id', async (c) => {
    const actor = await actorOf(c);
    await deleteFolder(db, events, c.get('tenantId'), actor, c.req.param('id'));
    return c.json({ data: { id: c.req.param('id'), deleted: true } });
  });

  /* ---------------- Upload sessions (init -> complete) ---------------- */

  app.post('/uploads', async (c) => {
    const body = initUploadSchema.parse(await jsonBody(c));
    const actor = await actorOf(c);
    const session = await initUpload(db, c.get('tenantId'), actor, body);
    return c.json({ data: sessionPublic(session) }, 201);
  });

  app.get('/uploads/:id', async (c) => {
    await actorOf(c);
    const session = await getUploadSession(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: sessionPublic(session) });
  });

  app.post('/uploads/:id/complete', async (c) => {
    const body = completeUploadSchema.parse(await jsonBody(c));
    const actor = await actorOf(c);
    const content = decodeUpload(body.content_base64);
    const file = await completeUpload(
      db,
      events,
      storage,
      c.get('tenantId'),
      actor,
      c.req.param('id'),
      content,
    );
    return c.json({ data: filePublic(file) }, 201);
  });

  app.post('/uploads/:id/abort', async (c) => {
    const actor = await actorOf(c);
    const session = await abortUpload(db, c.get('tenantId'), actor, c.req.param('id'));
    return c.json({ data: sessionPublic(session) });
  });

  /* ---------------- Files: search, metadata, content ---------------- */

  app.get('/files', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const sort = parseSort(query, ['name', 'mime', 'size_bytes', 'created_at', 'updated_at'], {
      column: 'created_at',
      direction: 'desc',
    })!;
    const filters = parseFilters(query, [
      'name',
      'mime',
      'tag',
      'folder_id',
      'visibility',
      'entity_type',
      'entity_id',
    ]);
    const actor = await actorOf(c);
    const data = await listFiles(db, c.get('tenantId'), actor, filters, page, sort);
    return c.json({ data: data.map(filePublic), limit: page.limit, offset: page.offset });
  });

  /** Files linked to a given entity: GET /links?entity_type=&entity_id= */
  app.get('/links', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    if (!query.entity_type || !query.entity_id) {
      throw ApiError.badRequest('entity_type and entity_id query params are required');
    }
    const actor = await actorOf(c);
    const data = await listFiles(
      db,
      c.get('tenantId'),
      actor,
      { entity_type: query.entity_type, entity_id: query.entity_id },
      page,
      { column: 'created_at', direction: 'desc' },
    );
    return c.json({ data: data.map(filePublic), limit: page.limit, offset: page.offset });
  });

  app.get('/files/:id', requireFileAccess('read'), async (c) => {
    const file = await getFileOrThrow(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: filePublic(file) });
  });

  app.get('/files/:id/content', requireFileAccess('read'), async (c) => {
    const file = await getFileOrThrow(db, c.get('tenantId'), c.req.param('id'));
    const bytes = await readFileContent(storage, file);
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const safeName = file.name.replace(/["\\\r\n]/g, '_');
    return c.body(body as ArrayBuffer, 200, {
      'content-type': file.mime,
      'content-length': String(bytes.byteLength),
      'content-disposition': `attachment; filename="${safeName}"`,
    });
  });

  app.get('/files/:id/audit', requireFileAccess('read'), async (c) => {
    const entries = await listAuditEntries(asCoreDb(db), c.get('tenantId'), 'files.file', c.req.param('id'));
    return c.json({ data: entries });
  });

  app.patch('/files/:id', requireFileAccess('write'), async (c) => {
    const body = updateFileSchema.parse(await jsonBody(c));
    const actor = await actorOf(c);
    const file = await updateFile(db, events, c.get('tenantId'), actor, c.req.param('id'), body);
    return c.json({ data: filePublic(file) });
  });

  app.delete('/files/:id', requireFileAccess('write'), async (c) => {
    const actor = await actorOf(c);
    await deleteFile(db, events, storage, c.get('tenantId'), actor, c.req.param('id'));
    return c.json({ data: { id: c.req.param('id'), deleted: true } });
  });

  /* ---------------- Links (attach/detach) ---------------- */

  app.get('/files/:id/links', requireFileAccess('read'), async (c) => {
    const data = await listLinksForFile(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data });
  });

  app.post('/files/:id/links', requireFileAccess('write'), async (c) => {
    const body = attachLinkSchema.parse(await jsonBody(c));
    const actor = await actorOf(c);
    const link = await attachLink(db, events, c.get('tenantId'), actor, c.req.param('id'), body);
    return c.json({ data: link }, 201);
  });

  app.delete('/files/:id/links/:linkId', requireFileAccess('write'), async (c) => {
    const actor = await actorOf(c);
    await detachLink(db, events, c.get('tenantId'), actor, c.req.param('id'), c.req.param('linkId'));
    return c.json({ data: { id: c.req.param('linkId'), deleted: true } });
  });

  /* ---------------- Permissions ---------------- */

  app.get('/files/:id/permissions', requireFileAccess('write'), async (c) => {
    const data = await listPermissions(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data });
  });

  app.post('/files/:id/permissions', requireFileAccess('write'), async (c) => {
    const body = grantPermissionSchema.parse(await jsonBody(c));
    const actor = await actorOf(c);
    const permission = await grantPermission(db, events, c.get('tenantId'), actor, c.req.param('id'), body);
    return c.json({ data: permission }, 201);
  });

  app.delete('/files/:id/permissions/:permId', requireFileAccess('write'), async (c) => {
    const actor = await actorOf(c);
    await revokePermission(db, events, c.get('tenantId'), actor, c.req.param('id'), c.req.param('permId'));
    return c.json({ data: { id: c.req.param('permId'), deleted: true } });
  });

  return app;
}
