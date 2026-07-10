/**
 * @blacklabel/core — tenancy, users, audit, event bus, shared helpers,
 * cross-module contracts. Read /CONVENTIONS.md before building on this.
 */

// Schema (row types + CoreDatabase map)
export * from './schema';

// Migrations
export { coreMigrations } from './migrations';

// Tenant/user CRUD services
export * from './service';

// Tenant middleware + env
export { tenantMiddleware, asCoreDb } from './middleware';
export type { TenantEnv } from './middleware';

// Audit log
export { audit, listAuditEntries } from './audit';

// Event bus
export {
  EventBus,
  EVENT_NAME_PATTERN,
  KNOWN_EVENTS,
} from './events';
export type {
  EventHandler,
  EmitResult,
  PlatformEvent,
  KnownEventType,
} from './events';

// Errors
export { ApiError, errorHandler } from './errors';

// id/time helpers
export { id, nowIso } from './helpers';

// Query helpers (pagination/sort/filter)
export { parsePagination, parseSort, parseFilters } from './query';
export type { Pagination, PaginationOptions, Sort } from './query';

// CSV helpers
export { parseCsv, parseCsvRows, serializeCsv, serializeCsvRows } from './csv';

// Money math
export { applyDiscount, computeTotals } from './money';
export type { Discount, Totals, TotalsLine } from './money';

// Cross-module contracts + module deps
export type {
  Contracts,
  ModuleDeps,
  CreateTaskContract,
  CreateTaskInput,
  CreateAppointmentContract,
  CreateAppointmentInput,
  CreateInvoiceContract,
  CreateInvoiceInput,
  InvoiceLineInput,
  SendMessageContract,
  SendMessageInput,
  MessageChannel,
} from './contracts';

// Custom field definitions
export {
  defineCustomField,
  listCustomFields,
  deleteCustomField,
  CUSTOM_FIELD_KINDS,
} from './custom-fields';
