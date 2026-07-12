/**
 * @blacklabel/admin — operations & administration for Mags Commerce OS.
 *
 * Owns: encrypted integration credentials (AES-256-GCM at rest), business
 * identity + operational settings (single source), health checks, encrypted
 * backup/restore orchestration, diagnostics bundle + audit export, structured
 * redacted logging, and operational job history.
 *
 * Secret material NEVER appears in logs, exports, list endpoints, or error
 * messages — only masked shapes leave the module; decrypt is a single audited
 * service method.
 *
 * Internal events emitted (documented per CONTRACTS §2):
 *   - admin.credential.expiring  { v, credentialId, provider, expiresAt }  → credential_expiring action
 *   - admin.backup.failed        { v, backupId, reason }                    → backup_overdue action
 *
 * Router deps extend ModuleDeps with masterKey/tester/healthService/
 * backupProvider/countProbe/retention/diagnostics (see AdminRouterDeps).
 */

export { adminMigrations } from './migrations';
export { adminRouter } from './router';
export type { AdminRouterDeps } from './router';

// Credentials
export {
  CredentialsService,
  CREDENTIAL_PROVIDERS,
  toMasked,
} from './credentials';
export type {
  MaskedCredential,
  DecryptedCredential,
  SaveCredentialInput,
  CredentialTester,
} from './credentials';

// Crypto + masking (encryptFile/decryptFile for backup/diagnostic file work)
export {
  normalizeKey,
  encryptString,
  decryptString,
  encryptJson,
  decryptJson,
  encryptFile,
  decryptFile,
  maskEmail,
  maskPayload,
} from './crypto';

// Redaction + structured logger (exported for apps/api)
export { redact, createLogger } from './redaction';
export type {
  RedactOptions,
  Logger,
  LoggerOptions,
  LogFields,
  LogRecord,
  LogLevel,
} from './redaction';

// Health
export {
  HealthService,
  backupFreshness,
  importFreshness,
  outboxDepth,
  diskFree,
} from './health';
export type { HealthProbe, ProbeResult, HealthRunReport } from './health';

// Settings
export {
  SettingsService,
  settingsSchema,
  postalAddressSchema,
  quietHoursSchema,
  parseSettingsRow,
} from './settings';
export type { AdminSettings } from './settings';

// Backups
export {
  BackupService,
  selectBackupsToPrune,
  countsMatch,
} from './backups';
export type {
  BackupProvider,
  CountProbe,
  RunBackupOptions,
  RetentionPolicy,
} from './backups';

// Diagnostics + audit export
export { assembleDiagnostics, exportAuditCsv } from './diagnostics';
export type {
  DiagnosticsInput,
  DiagnosticBundle,
  AuditExportFilters,
} from './diagnostics';

// Jobs
export { recordJob, listJobs } from './jobs';

// Schema
export type {
  AdminDatabase,
  AdminCredentialRow,
  AdminSettingsRow,
  AdminHealthRunRow,
  AdminHealthRowRow,
  AdminBackupRow,
  AdminJobRow,
  CredentialProvider,
  CredentialStatus,
  BackupStatus,
  JobKind,
  JobStatus,
} from './schema';
