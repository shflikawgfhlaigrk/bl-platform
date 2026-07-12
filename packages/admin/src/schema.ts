import type { CoreDatabase } from '@blacklabel/core';

/**
 * admin module schema — operations/administration for Mags Commerce OS.
 *
 * Owns: encrypted integration credentials, business-identity settings, health
 * check runs, encrypted backup orchestration records, and the operational job
 * history the UI surfaces. Every table is tenant-scoped and prefixed `admin_`.
 *
 * Secret material NEVER lives in a readable column: credential payloads are
 * AES-256-GCM ciphertext (see crypto.ts); the display shape is a masked JSON
 * blob computed at save. The master key is supplied by the integrator at
 * service construction and is NEVER stored in the database.
 */

export type CredentialProvider =
  | 'smtp'
  | 'imap'
  | 'square'
  | 'stripe'
  | 'shipping'
  | 'custom';

export type CredentialStatus = 'untested' | 'ok' | 'failed';

/** An encrypted integration credential. Plaintext exists only after decrypt. */
export interface AdminCredentialRow {
  id: string;
  tenant_id: string;
  name: string;
  provider: CredentialProvider;
  /**
   * AES-256-GCM ciphertext, base64 of concat(iv[12] + authTag[16] + ct).
   * NEVER appears in logs, exports, list endpoints, or error messages.
   */
  payload_encrypted: string;
  /** Display-only masked shape, JSON text, e.g. {"host":"smtp.x.com","user":"a***@x.com"}. */
  fields_masked: string;
  status: CredentialStatus;
  /** ISO-8601 UTC of the last testConnection, or null if never tested. */
  last_tested_at: string | null;
  /** ISO-8601 UTC expiry, or null if the credential does not expire. */
  expires_at: string | null;
  /** id of the credential this one was rotated FROM, or null. */
  rotated_from: string | null;
  /** ISO-8601 UTC when archived (rotated-out or soft-deleted), else null. */
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Singleton-per-tenant business identity + operational defaults. */
export interface AdminSettingsRow {
  id: string;
  tenant_id: string;
  /** JSON text: { name, postalAddress, timezone, quietHours }. */
  data: string;
  created_at: string;
  updated_at: string;
}

/** One health-check run (a batch of probe executions). */
export interface AdminHealthRunRow {
  id: string;
  tenant_id: string;
  started_at: string;
  finished_at: string;
  /** 0/1 — every probe ok. */
  overall_ok: number;
  total: number;
  ok_count: number;
  /** Count of critical probes that were not ok. */
  critical_failures: number;
  created_at: string;
}

/** One probe result inside a health run. */
export interface AdminHealthRowRow {
  id: string;
  tenant_id: string;
  run_id: string;
  name: string;
  /** 0/1 — was this probe declared critical. */
  critical: number;
  /** 0/1 — probe outcome. */
  ok: number;
  /** JSON text detail (never contains secrets — probes return operational facts). */
  detail: string | null;
  created_at: string;
}

export type BackupStatus =
  | 'created'
  | 'verified'
  | 'failed_verification'
  | 'pruned';

/** One backup artifact record (file ops performed by an injected provider). */
export interface AdminBackupRow {
  id: string;
  tenant_id: string;
  path: string;
  bytes: number;
  sha256: string;
  /** 0/1 — whether the artifact on disk is encrypted. */
  encrypted: number;
  status: BackupStatus;
  /** JSON text: integrity + count-comparison detail, or null. */
  detail: string | null;
  verified_at: string | null;
  created_at: string;
}

export type JobKind = 'import' | 'export' | 'backup' | 'health' | 'publish';
export type JobStatus = 'running' | 'done' | 'failed';

/** Operational job history — one place the UI shows what ran and how it ended. */
export interface AdminJobRow {
  id: string;
  tenant_id: string;
  kind: JobKind;
  status: JobStatus;
  /** JSON text detail (redact secrets before writing). */
  detail: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
}

export interface AdminDatabase extends CoreDatabase {
  admin_credentials: AdminCredentialRow;
  admin_settings: AdminSettingsRow;
  admin_health_runs: AdminHealthRunRow;
  admin_health_rows: AdminHealthRowRow;
  admin_backups: AdminBackupRow;
  admin_jobs: AdminJobRow;
}
