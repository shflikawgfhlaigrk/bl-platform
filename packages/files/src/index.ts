/**
 * @blacklabel/files — File/Document Vault: metadata + storage adapters,
 * nested folders, polymorphic entity links, two-step upload sessions,
 * per-file permissions, tags, and metadata search.
 *
 * DOMAIN EVENTS emitted by this module (module-internal, catalog-compatible
 * naming per /CONVENTIONS.md §8):
 * - `files.file.uploaded`       { fileId, name, mime, sizeBytes, sha256, folderId, uploadedBy }
 * - `files.file.updated`        { fileId }
 * - `files.file.deleted`        { fileId }
 * - `files.file.linked`         { fileId, entityType, entityId }
 * - `files.file.unlinked`       { fileId, entityType, entityId }
 * - `files.folder.created`      { folderId, name, parentId }
 * - `files.folder.updated`      { folderId }
 * - `files.folder.deleted`      { folderId }
 * - `files.permission.granted`  { fileId, permissionId, granteeType, grantee, canWrite }
 * - `files.permission.revoked`  { fileId, permissionId }
 */
export const MODULE_KEY = 'files' as const;

// Migrations
export { filesMigrations } from './migrations';

// Router factory (+ its deps shape)
export { filesRouter, type FilesModuleDeps } from './router';

// Public row/database types
export type {
  FilesDatabase,
  FilesAssetRow,
  FilesFolderRow,
  FilesLinkRow,
  FilesUploadSessionRow,
  FilesPermissionRow,
  FileVisibility,
  UploadSessionStatus,
  PermissionGranteeType,
} from './schema';

// Storage adapter contract + implementations (apps/api wires a real provider)
export {
  LocalDiskStorageProvider,
  MemoryStorageProvider,
  S3StorageProvider,
  StorageError,
  STORAGE_KEY_PATTERN,
  assertStorageKey,
  newStorageKey,
} from './storage';
export type { StorageProvider, S3StorageConfig, StorageErrorCode } from './storage';

// Seed helper
export { seedFiles } from './seed';
export type { SeedFilesOptions, SeedFilesResult } from './seed';
