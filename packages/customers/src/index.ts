/**
 * @blacklabel/customers — customer identity, consent, preferences,
 * deterministic segments, suppressions, restock requests, and service cases.
 *
 * Sits on top of crm customer rows-of-record; references them by
 * `crm_customer_id` STRING only (no crm import/join/FK).
 *
 * Catalog events emitted (module.entity.verb; payloads carry v:1, ids only,
 * NEVER PII):
 *   customers.consent.changed   { v:1, customerId, channel, state }
 *   customers.restock.requested { v:1, variationId, customerId? }
 *
 * Seeding entry points (integrator calls these — this module cannot read crm):
 *   importProfiles(db, tenantId, rows[{crmCustomerId,email,phone,firstName,lastName}])
 *     idempotent on crm_customer_id.
 *   seedBuiltinSegments(db, tenantId, { vipThresholdCents?, lapsedLifetimeCents? })
 *
 * Segment evaluation contract: evaluateSegmentAndPersist(db, tenantId,
 * segmentId, statsInputMap, now?) where statsInputMap is
 *   { [profileId]: { lifetimeCents, orderCount, lastOrderAt, firstOrderAt,
 *                    categoryTop, region, emailConsentState, ... } }.
 */
export const MODULE_KEY = 'customers' as const;

// Migrations
export { customersMigrations } from './migrations';

// Router factory
export { customersRouter } from './router';

// Public types
export type {
  CustomersDatabase,
  CustomersProfileRow,
  CustomersMergeRow,
  CustomersConsentRow,
  CustomersConsentTokenRow,
  CustomersPreferenceRow,
  CustomersSuppressionRow,
  CustomersSegmentRow,
  CustomersSegmentMemberRow,
  CustomersRestockRequestRow,
  CustomersServiceCaseRow,
  CustomersServiceCaseNoteRow,
  CustomerSource,
  ConsentChannel,
  ConsentState,
  SuppressionScope,
  SuppressionReason,
  MergeStatus,
  RestockStatus,
  ServiceCaseKind,
  ServiceCaseStatus,
} from './schema';
export {
  CUSTOMER_SOURCES,
  CONSENT_CHANNELS,
  CONSENT_STATES,
  SUPPRESSION_SCOPES,
  SUPPRESSION_REASONS,
  RESTOCK_STATUSES,
  SERVICE_CASE_KINDS,
  SERVICE_CASE_STATUSES,
  MERGE_CHILD_TABLES,
} from './schema';

// Pure helpers other layers may need (id-string / stats world only)
export {
  normalizeEmail,
  normalizePhone,
  normalizeSuppressionValue,
  hashInputs,
  stableStringify,
} from './normalize';
export {
  evaluateSegment,
  matchesRules,
  evaluatePredicate,
  builtinSegments,
  SEGMENT_OPS,
} from './segments';
export type {
  SegmentRules,
  SegmentPredicate,
  SegmentOp,
  ProfileStats,
  StatsInputMap,
  SegmentEvaluation,
  BuiltinSegmentDef,
} from './segments';

// Service functions (integrator seeding + programmatic use)
export {
  importProfiles,
  seedBuiltinSegments,
  isSuppressed,
  resolveIdentities,
  evaluateSegmentAndPersist,
} from './service';
export type { ImportRow, ImportSummary, ProfileInput, ConsentInput, EvaluateResult } from './service';
