/**
 * Row types for the files module. All tables are prefixed `files_` and carry
 * `tenant_id` (see /CONVENTIONS.md §3/§5).
 *
 * - booleans are INTEGER 0/1
 * - timestamps are ISO-8601 UTC text
 * - `tags` is a JSON-serialized string[] stored as TEXT
 */
import type { CoreDatabase } from '@blacklabel/core';

/** Who can see a file without an explicit grant (within its tenant). */
export type FileVisibility = 'private' | 'tenant' | 'public';

/** Two-step upload lifecycle: init -> complete (or abort). */
export type UploadSessionStatus = 'pending' | 'completed' | 'aborted';

/** A permission grant targets either a core user role or a single user id. */
export type PermissionGranteeType = 'role' | 'user';

export interface FilesFolderRow {
  id: string;
  tenant_id: string;
  /** Parent folder id, or null for a root folder. */
  parent_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface FilesAssetRow {
  id: string;
  tenant_id: string;
  /** Containing folder, or null for the vault root. */
  folder_id: string | null;
  /** Display filename (validated: no path separators/control chars). */
  name: string;
  mime: string;
  size_bytes: number;
  /** Hex SHA-256 of the stored content, computed server-side. */
  sha256: string;
  /**
   * Opaque random storage key (never derived from user input, never exposed
   * in API responses or URLs).
   */
  storage_key: string;
  /** User id of the uploader, or "system". */
  uploaded_by: string;
  visibility: FileVisibility;
  /** JSON string[] of tags. */
  tags: string;
  created_at: string;
  updated_at: string;
}

export interface FilesLinkRow {
  id: string;
  tenant_id: string;
  file_id: string;
  /**
   * Polymorphic target, referenced by id string ONLY (cross-module rule),
   * e.g. "crm.customer", "scheduling.appointment", "quoting.quote",
   * "billing.invoice", "messaging.message".
   */
  entity_type: string;
  entity_id: string;
  created_at: string;
}

export interface FilesUploadSessionRow {
  id: string;
  tenant_id: string;
  folder_id: string | null;
  name: string;
  mime: string;
  visibility: FileVisibility;
  /** JSON string[] of tags to apply on completion. */
  tags: string;
  status: UploadSessionStatus;
  /** Pre-allocated random storage key; content lands here on complete. */
  storage_key: string;
  /** User id that initiated the upload, or "system". */
  created_by: string;
  /** Set when status = completed. */
  file_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface FilesPermissionRow {
  id: string;
  tenant_id: string;
  file_id: string;
  grantee_type: PermissionGranteeType;
  /** Role name ("owner" | "admin" | "member") or a user id. */
  grantee: string;
  /** 0/1 — whether the grant also allows mutations. */
  can_write: number;
  created_at: string;
}

export interface FilesDatabase extends CoreDatabase {
  files_folders: FilesFolderRow;
  files_assets: FilesAssetRow;
  files_links: FilesLinkRow;
  files_upload_sessions: FilesUploadSessionRow;
  files_permissions: FilesPermissionRow;
}
