/**
 * Tenant-scoped customers business logic.
 *
 * Every mutation is tenant-scoped, audited via core `audit(...)`, and (where a
 * catalog event exists) emits AFTER the write. NO PII in event payloads.
 *
 * Cross-module: crm customers are referenced by `crm_customer_id` string only.
 * This module never imports/joins/FKs crm tables.
 */
import type { Kysely } from 'kysely';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  type EventBus,
  type Pagination,
} from '@blacklabel/core';
import type {
  ConsentChannel,
  ConsentState,
  CustomersConsentRow,
  CustomersDatabase,
  CustomersMergeRow,
  CustomersPreferenceRow,
  CustomersProfileRow,
  CustomersRestockRequestRow,
  CustomersSegmentMemberRow,
  CustomersSegmentRow,
  CustomersServiceCaseNoteRow,
  CustomersServiceCaseRow,
  CustomersSuppressionRow,
  CustomerSource,
  RestockStatus,
  ServiceCaseKind,
  ServiceCaseStatus,
  SuppressionReason,
  SuppressionScope,
} from './schema';
import { MERGE_CHILD_TABLES } from './schema';
import { normalizeEmail, normalizePhone, normalizeSuppressionValue } from './normalize';
import {
  builtinSegments,
  evaluateSegment,
  type SegmentRules,
  type StatsInputMap,
} from './segments';

type Db = Kysely<CustomersDatabase>;
const anyDb = (db: Db) => db as Kysely<any>;

/* ------------------------------------------------------------------ *
 * Profiles
 * ------------------------------------------------------------------ */

export interface ProfileInput {
  crmCustomerId?: string | null;
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  source?: CustomerSource;
}

export async function createProfile(
  db: Db,
  tenantId: string,
  actor: string,
  input: ProfileInput,
): Promise<CustomersProfileRow> {
  const now = nowIso();
  const row: CustomersProfileRow = {
    id: id(),
    tenant_id: tenantId,
    crm_customer_id: input.crmCustomerId ?? null,
    email_normalized: normalizeEmail(input.email),
    phone_normalized: normalizePhone(input.phone),
    first_name: input.firstName ?? null,
    last_name: input.lastName ?? null,
    source: input.source ?? 'staff',
    merged_into: null,
    created_at: now,
    updated_at: now,
  };
  if (row.crm_customer_id) {
    const clash = await db
      .selectFrom('customers_profiles')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('crm_customer_id', '=', row.crm_customer_id)
      .executeTakeFirst();
    if (clash) {
      throw ApiError.conflict(`profile already exists for crm customer ${row.crm_customer_id}`);
    }
  }
  await db.insertInto('customers_profiles').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'customers.profile.created', 'customers.profile', row.id);
  return row;
}

export async function getProfile(
  db: Db,
  tenantId: string,
  profileId: string,
): Promise<CustomersProfileRow | undefined> {
  return db
    .selectFrom('customers_profiles')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', profileId)
    .executeTakeFirst();
}

export async function mustGetProfile(
  db: Db,
  tenantId: string,
  profileId: string,
): Promise<CustomersProfileRow> {
  const p = await getProfile(db, tenantId, profileId);
  if (!p) throw ApiError.notFound(`profile not found: ${profileId}`);
  return p;
}

export interface ProfileSearch {
  page: Pagination;
  email?: string;
  phone?: string;
  name?: string;
  includeMerged?: boolean;
}

export async function searchProfiles(
  db: Db,
  tenantId: string,
  params: ProfileSearch,
): Promise<CustomersProfileRow[]> {
  let q = db.selectFrom('customers_profiles').selectAll().where('tenant_id', '=', tenantId);
  if (!params.includeMerged) q = q.where('merged_into', 'is', null);
  if (params.email) q = q.where('email_normalized', '=', normalizeEmail(params.email));
  if (params.phone) q = q.where('phone_normalized', '=', normalizePhone(params.phone));
  if (params.name) {
    const like = `%${params.name.toLowerCase()}%`;
    q = q.where((eb) =>
      eb.or([
        eb(eb.fn('lower', ['first_name']), 'like', like),
        eb(eb.fn('lower', ['last_name']), 'like', like),
      ]),
    );
  }
  return q
    .orderBy('created_at')
    .orderBy('id')
    .limit(params.page.limit)
    .offset(params.page.offset)
    .execute();
}

export async function updateProfile(
  db: Db,
  tenantId: string,
  actor: string,
  profileId: string,
  patch: ProfileInput,
): Promise<CustomersProfileRow> {
  await mustGetProfile(db, tenantId, profileId);
  const set: Record<string, string | null> = { updated_at: nowIso() };
  if (patch.email !== undefined) set.email_normalized = normalizeEmail(patch.email);
  if (patch.phone !== undefined) set.phone_normalized = normalizePhone(patch.phone);
  if (patch.firstName !== undefined) set.first_name = patch.firstName ?? null;
  if (patch.lastName !== undefined) set.last_name = patch.lastName ?? null;
  if (patch.crmCustomerId !== undefined) set.crm_customer_id = patch.crmCustomerId ?? null;
  await db
    .updateTable('customers_profiles')
    .set(set)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', profileId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'customers.profile.updated', 'customers.profile', profileId);
  return mustGetProfile(db, tenantId, profileId);
}

/* ------------------------------------------------------------------ *
 * Seeding — idempotent import keyed on crm_customer_id
 * ------------------------------------------------------------------ */

export interface ImportRow {
  crmCustomerId: string;
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export interface ImportSummary {
  imported: number;
  updated: number;
  ids: string[];
}

/**
 * Idempotent import keyed on crm_customer_id: re-running updates the existing
 * profile in place, never duplicates. Runs in one transaction.
 */
export async function importProfiles(
  db: Db,
  tenantId: string,
  rows: ImportRow[],
): Promise<ImportSummary> {
  const summary: ImportSummary = { imported: 0, updated: 0, ids: [] };
  await db.transaction().execute(async (trx) => {
    for (const r of rows) {
      if (!r.crmCustomerId) throw ApiError.badRequest('importProfiles: crmCustomerId is required');
      const existing = await trx
        .selectFrom('customers_profiles')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('crm_customer_id', '=', r.crmCustomerId)
        .executeTakeFirst();
      const now = nowIso();
      if (existing) {
        await trx
          .updateTable('customers_profiles')
          .set({
            email_normalized: normalizeEmail(r.email),
            phone_normalized: normalizePhone(r.phone),
            first_name: r.firstName ?? null,
            last_name: r.lastName ?? null,
            updated_at: now,
          })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', existing.id)
          .execute();
        summary.updated += 1;
        summary.ids.push(existing.id);
      } else {
        const row: CustomersProfileRow = {
          id: id(),
          tenant_id: tenantId,
          crm_customer_id: r.crmCustomerId,
          email_normalized: normalizeEmail(r.email),
          phone_normalized: normalizePhone(r.phone),
          first_name: r.firstName ?? null,
          last_name: r.lastName ?? null,
          source: 'square_import',
          merged_into: null,
          created_at: now,
          updated_at: now,
        };
        await trx.insertInto('customers_profiles').values(row).execute();
        summary.imported += 1;
        summary.ids.push(row.id);
      }
    }
  });
  return summary;
}

/* ------------------------------------------------------------------ *
 * Identity resolution -> non-destructive merge proposals
 * ------------------------------------------------------------------ */

type MatchField = 'email' | 'phone' | 'name_zip';

export interface ResolveOptions {
  /** Optional profileId -> zip map enabling the name+zip precedence rule. */
  zips?: Record<string, string>;
}

/**
 * Deterministic identity resolution over the tenant's ACTIVE profiles.
 * Precedence: exact normalized email > exact normalized phone > exact
 * (first+last name, case-insensitive) + zip. Groups matching profiles and
 * writes `customers_merges` rows with status 'proposed' — NEVER destructive.
 * Idempotent: an existing proposed/applied pair is not re-proposed.
 */
export async function resolveIdentities(
  db: Db,
  tenantId: string,
  actor: string,
  options: ResolveOptions = {},
): Promise<CustomersMergeRow[]> {
  const profiles = await db
    .selectFrom('customers_profiles')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('merged_into', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .execute();

  // Union-find over profile index.
  const parent = profiles.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const groupBy = (keyOf: (p: CustomersProfileRow, i: number) => string | null) => {
    const buckets = new Map<string, number[]>();
    profiles.forEach((p, i) => {
      const k = keyOf(p, i);
      if (k == null) return;
      const arr = buckets.get(k);
      if (arr) arr.push(i);
      else buckets.set(k, [i]);
    });
    for (const idxs of buckets.values()) {
      for (let j = 1; j < idxs.length; j += 1) union(idxs[0]!, idxs[j]!);
    }
  };

  groupBy((p) => p.email_normalized);
  groupBy((p) => p.phone_normalized);
  const zips = options.zips ?? {};
  groupBy((p) => {
    const zip = zips[p.id];
    if (!zip) return null;
    if (!p.first_name && !p.last_name) return null;
    return `${(p.first_name ?? '').toLowerCase()} ${(p.last_name ?? '').toLowerCase()} ${zip}`;
  });

  // Highest-precedence matched field between two profiles.
  const matchOf = (a: CustomersProfileRow, b: CustomersProfileRow): { field: MatchField; value: string } | null => {
    if (a.email_normalized && a.email_normalized === b.email_normalized) {
      return { field: 'email', value: a.email_normalized };
    }
    if (a.phone_normalized && a.phone_normalized === b.phone_normalized) {
      return { field: 'phone', value: a.phone_normalized };
    }
    const za = zips[a.id];
    const zb = zips[b.id];
    if (
      za &&
      zb &&
      za === zb &&
      (a.first_name ?? '').toLowerCase() === (b.first_name ?? '').toLowerCase() &&
      (a.last_name ?? '').toLowerCase() === (b.last_name ?? '').toLowerCase() &&
      (a.first_name || a.last_name)
    ) {
      return { field: 'name_zip', value: `${a.first_name ?? ''} ${a.last_name ?? ''} ${za}`.trim() };
    }
    return null;
  };

  // Build groups.
  const groups = new Map<number, number[]>();
  profiles.forEach((_, i) => {
    const root = find(i);
    const arr = groups.get(root);
    if (arr) arr.push(i);
    else groups.set(root, [i]);
  });

  const created: CustomersMergeRow[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    // Winner = earliest (profiles already ordered by created_at,id).
    const winner = profiles[idxs[0]!]!;
    for (let j = 1; j < idxs.length; j += 1) {
      const loser = profiles[idxs[j]!]!;
      const matched = matchOf(winner, loser) ?? { field: 'email' as MatchField, value: '' };
      const dupe = await db
        .selectFrom('customers_merges')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('winner_profile_id', '=', winner.id)
        .where('loser_profile_id', '=', loser.id)
        .where('status', 'in', ['proposed', 'applied'])
        .executeTakeFirst();
      if (dupe) continue;
      const now = nowIso();
      const row: CustomersMergeRow = {
        id: id(),
        tenant_id: tenantId,
        winner_profile_id: winner.id,
        loser_profile_id: loser.id,
        evidence: JSON.stringify({ matched }),
        status: 'proposed',
        applied_at: null,
        undone_at: null,
        created_at: now,
        updated_at: now,
      };
      await db.insertInto('customers_merges').values(row).execute();
      await audit(asCoreDb(db), tenantId, actor, 'customers.merge.proposed', 'customers.merge', row.id);
      created.push(row);
    }
  }
  return created;
}

export async function getMerge(
  db: Db,
  tenantId: string,
  mergeId: string,
): Promise<CustomersMergeRow | undefined> {
  return db
    .selectFrom('customers_merges')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', mergeId)
    .executeTakeFirst();
}

export async function listMerges(
  db: Db,
  tenantId: string,
  status?: string,
): Promise<CustomersMergeRow[]> {
  let q = db.selectFrom('customers_merges').selectAll().where('tenant_id', '=', tenantId);
  if (status) q = q.where('status', '=', status as CustomersMergeRow['status']);
  return q.orderBy('created_at').orderBy('id').execute();
}

/** Apply a proposed merge: re-point loser's child rows to winner (non-destructive). */
export async function applyMerge(
  db: Db,
  tenantId: string,
  actor: string,
  mergeId: string,
): Promise<CustomersMergeRow> {
  return db.transaction().execute(async (trx) => {
    const merge = await trx
      .selectFrom('customers_merges')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', mergeId)
      .executeTakeFirst();
    if (!merge) throw ApiError.notFound(`merge not found: ${mergeId}`);
    if (merge.status !== 'proposed') {
      throw ApiError.conflict(`merge ${mergeId} is ${merge.status}, only 'proposed' can be applied`);
    }
    const loser = await trx
      .selectFrom('customers_profiles')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', merge.loser_profile_id)
      .executeTakeFirst();
    if (!loser) throw ApiError.notFound(`loser profile not found: ${merge.loser_profile_id}`);

    const repointed: Record<string, string[]> = {};
    for (const table of MERGE_CHILD_TABLES) {
      const rows = await (trx as Kysely<any>)
        .selectFrom(table)
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('profile_id', '=', merge.loser_profile_id)
        .execute();
      const ids = rows.map((r: { id: string }) => r.id);
      repointed[table] = ids;
      if (ids.length > 0) {
        await (trx as Kysely<any>)
          .updateTable(table)
          .set({ profile_id: merge.winner_profile_id })
          .where('tenant_id', '=', tenantId)
          .where('id', 'in', ids)
          .execute();
      }
    }

    const now = nowIso();
    await trx
      .updateTable('customers_profiles')
      .set({ merged_into: merge.winner_profile_id, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', merge.loser_profile_id)
      .execute();

    const evidence = JSON.parse(merge.evidence) as Record<string, unknown>;
    evidence.applied = { repointed, loserPriorMergedInto: loser.merged_into };
    await trx
      .updateTable('customers_merges')
      .set({ status: 'applied', applied_at: now, updated_at: now, evidence: JSON.stringify(evidence) })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', mergeId)
      .execute();

    await audit(asCoreDb(trx as Kysely<any>), tenantId, actor, 'customers.merge.applied', 'customers.merge', mergeId, {
      winner: merge.winner_profile_id,
      loser: merge.loser_profile_id,
    });
    const out = await trx
      .selectFrom('customers_merges')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', mergeId)
      .executeTakeFirstOrThrow();
    return out;
  });
}

/** Undo an applied merge: restore loser's child rows and merged_into EXACTLY. */
export async function undoMerge(
  db: Db,
  tenantId: string,
  actor: string,
  mergeId: string,
): Promise<CustomersMergeRow> {
  return db.transaction().execute(async (trx) => {
    const merge = await trx
      .selectFrom('customers_merges')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', mergeId)
      .executeTakeFirst();
    if (!merge) throw ApiError.notFound(`merge not found: ${mergeId}`);
    if (merge.status !== 'applied') {
      throw ApiError.conflict(`merge ${mergeId} is ${merge.status}, only 'applied' can be undone`);
    }
    const evidence = JSON.parse(merge.evidence) as {
      applied?: { repointed: Record<string, string[]>; loserPriorMergedInto: string | null };
    };
    const applied = evidence.applied;
    if (!applied) throw ApiError.conflict('merge has no applied evidence to undo');

    for (const table of MERGE_CHILD_TABLES) {
      const ids = applied.repointed[table] ?? [];
      if (ids.length > 0) {
        await (trx as Kysely<any>)
          .updateTable(table)
          .set({ profile_id: merge.loser_profile_id })
          .where('tenant_id', '=', tenantId)
          .where('id', 'in', ids)
          .execute();
      }
    }

    const now = nowIso();
    await trx
      .updateTable('customers_profiles')
      .set({ merged_into: applied.loserPriorMergedInto, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', merge.loser_profile_id)
      .execute();
    await trx
      .updateTable('customers_merges')
      .set({ status: 'undone', undone_at: now, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', mergeId)
      .execute();
    await audit(asCoreDb(trx as Kysely<any>), tenantId, actor, 'customers.merge.undone', 'customers.merge', mergeId);
    return trx
      .selectFrom('customers_merges')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', mergeId)
      .executeTakeFirstOrThrow();
  });
}

/* ------------------------------------------------------------------ *
 * Consents — append-only history + double-opt-in
 * ------------------------------------------------------------------ */

export interface ConsentInput {
  channel: ConsentChannel;
  state: ConsentState;
  textShown?: string | null;
  source?: CustomerSource | null;
  ip?: string | null;
  userAgent?: string | null;
  evidence?: unknown;
}

async function insertConsent(
  db: Db,
  tenantId: string,
  actor: string,
  events: EventBus | undefined,
  profileId: string,
  input: ConsentInput,
): Promise<CustomersConsentRow> {
  const now = nowIso();
  // Monotonic sequence per (profile, channel): strictly orders consent history
  // even when two changes land in the same millisecond.
  const prev = await db
    .selectFrom('customers_consents')
    .select('seq')
    .where('tenant_id', '=', tenantId)
    .where('profile_id', '=', profileId)
    .where('channel', '=', input.channel)
    .orderBy('seq', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  const row: CustomersConsentRow = {
    id: id(),
    tenant_id: tenantId,
    profile_id: profileId,
    channel: input.channel,
    state: input.state,
    text_shown: input.textShown ?? null,
    source: input.source ?? null,
    ip: input.ip ?? null,
    user_agent: input.userAgent ?? null,
    occurred_at: now,
    evidence: input.evidence === undefined ? null : JSON.stringify(input.evidence),
    seq: (prev?.seq ?? 0) + 1,
    created_at: now,
  };
  await db.insertInto('customers_consents').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'customers.consent.changed', 'customers.consent', row.id, {
    profileId,
    channel: input.channel,
    state: input.state,
  });
  // Catalog event — ids/channel/state only, NEVER PII.
  if (events) {
    await events.emit(tenantId, 'customers.consent.changed', {
      v: 1,
      customerId: profileId,
      channel: input.channel,
      state: input.state,
    });
  }
  return row;
}

async function invalidateConsentTokens(
  db: Db,
  tenantId: string,
  profileId: string,
  channel: ConsentChannel,
  consumedAt: string,
): Promise<void> {
  await db
    .updateTable('customers_consent_tokens')
    .set({ consumed_at: consumedAt })
    .where('tenant_id', '=', tenantId)
    .where('profile_id', '=', profileId)
    .where('channel', '=', channel)
    .where('consumed_at', 'is', null)
    .execute();
}

async function emitConsentChanged(
  events: EventBus | undefined,
  tenantId: string,
  consent: CustomersConsentRow,
): Promise<void> {
  if (!events) return;
  await events.emit(tenantId, 'customers.consent.changed', {
    v: 1,
    customerId: consent.profile_id,
    channel: consent.channel,
    state: consent.state,
  });
}

/** Record a consent change (grant/withdraw/pending). Appends a history row. */
export async function recordConsent(
  db: Db,
  tenantId: string,
  actor: string,
  events: EventBus | undefined,
  profileId: string,
  input: ConsentInput,
): Promise<CustomersConsentRow> {
  await mustGetProfile(db, tenantId, profileId);
  const consent = await db.transaction().execute(async (trx) => {
    await invalidateConsentTokens(trx as Db, tenantId, profileId, input.channel, nowIso());
    return insertConsent(trx as Db, tenantId, actor, undefined, profileId, input);
  });
  await emitConsentChanged(events, tenantId, consent);
  return consent;
}

export async function consentHistory(
  db: Db,
  tenantId: string,
  profileId: string,
  channel?: ConsentChannel,
): Promise<CustomersConsentRow[]> {
  let q = db
    .selectFrom('customers_consents')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('profile_id', '=', profileId);
  if (channel) q = q.where('channel', '=', channel);
  return q.orderBy('seq', 'desc').orderBy('occurred_at', 'desc').orderBy('id', 'desc').execute();
}

/** Current consent state for a channel = latest row by occurred_at then id. */
export async function currentConsent(
  db: Db,
  tenantId: string,
  profileId: string,
  channel: ConsentChannel,
): Promise<ConsentState | null> {
  const row = await db
    .selectFrom('customers_consents')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('profile_id', '=', profileId)
    .where('channel', '=', channel)
    .orderBy('seq', 'desc')
    .orderBy('occurred_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  return row ? row.state : null;
}

export interface StartDoubleOptInResult {
  consent: CustomersConsentRow;
  token: string;
  expiresAt: string;
}

/**
 * Start double-opt-in: append a `pending_double_opt_in` consent row and mint a
 * confirmation token. Grant only happens via confirmDoubleOptIn(token).
 */
export async function startDoubleOptIn(
  db: Db,
  tenantId: string,
  actor: string,
  events: EventBus | undefined,
  profileId: string,
  input: { channel: ConsentChannel; textShown?: string | null; source?: CustomerSource | null; ttlMinutes?: number; ip?: string | null; userAgent?: string | null },
): Promise<StartDoubleOptInResult> {
  await mustGetProfile(db, tenantId, profileId);
  const token = id();
  const now = Date.parse(nowIso());
  const ttl = (input.ttlMinutes ?? 1440) * 60_000;
  const expiresAt = new Date(now + ttl).toISOString();
  const consent = await db.transaction().execute(async (trx) => {
    await invalidateConsentTokens(trx as Db, tenantId, profileId, input.channel, nowIso());
    const pending = await insertConsent(trx as Db, tenantId, actor, undefined, profileId, {
      channel: input.channel,
      state: 'pending_double_opt_in',
      textShown: input.textShown ?? null,
      source: input.source ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    await trx
      .insertInto('customers_consent_tokens')
      .values({
        id: id(),
        tenant_id: tenantId,
        profile_id: profileId,
        channel: input.channel,
        token,
        expires_at: expiresAt,
        consumed_at: null,
        created_at: nowIso(),
      })
      .execute();
    return pending;
  });
  await emitConsentChanged(events, tenantId, consent);
  return { consent, token, expiresAt };
}

/** Confirm double-opt-in via token: pending -> granted. Rejects expired/used/unknown tokens. */
export async function confirmDoubleOptIn(
  db: Db,
  tenantId: string,
  actor: string,
  events: EventBus | undefined,
  token: string,
): Promise<CustomersConsentRow> {
  // Do the token-consume + consent-insert atomically, but DEFER the domain
  // event until AFTER commit. Emitting inside the transaction deadlocks: the
  // automation '*' subscriber enqueues every event to the outbox via its own
  // db.transaction(), and the better-sqlite3 dialect serializes transactions —
  // a nested open would wait forever on the still-open outer transaction.
  const consent = await db.transaction().execute(async (trx) => {
    const tokenRow = await trx
      .selectFrom('customers_consent_tokens')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('token', '=', token)
      .executeTakeFirst();
    if (!tokenRow) throw ApiError.notFound('invalid confirmation token');
    if (tokenRow.consumed_at) throw ApiError.conflict('confirmation token already used');
    if (Date.parse(tokenRow.expires_at) < Date.parse(nowIso())) {
      throw ApiError.conflict('confirmation token expired');
    }
    const state = await currentConsent(
      trx as Db,
      tenantId,
      tokenRow.profile_id,
      tokenRow.channel,
    );
    if (state !== 'pending_double_opt_in') {
      throw ApiError.conflict('confirmation token is no longer pending');
    }
    await trx
      .updateTable('customers_consent_tokens')
      .set({ consumed_at: nowIso() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', tokenRow.id)
      .execute();
    // events=undefined → insertConsent writes + audits but does NOT emit here.
    return insertConsent(trx as Db, tenantId, actor, undefined, tokenRow.profile_id, {
      channel: tokenRow.channel,
      state: 'granted',
      source: 'storefront',
      evidence: { confirmedTokenId: tokenRow.id },
    });
  });
  // Post-commit emit — same payload insertConsent would have emitted.
  await emitConsentChanged(events, tenantId, consent);
  return consent;
}

/* ------------------------------------------------------------------ *
 * Preferences
 * ------------------------------------------------------------------ */

export async function setPreference(
  db: Db,
  tenantId: string,
  actor: string,
  profileId: string,
  key: string,
  value: unknown,
): Promise<CustomersPreferenceRow> {
  await mustGetProfile(db, tenantId, profileId);
  const serialized = JSON.stringify(value);
  const existing = await db
    .selectFrom('customers_preferences')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('profile_id', '=', profileId)
    .where('key', '=', key)
    .executeTakeFirst();
  const now = nowIso();
  if (existing) {
    await db
      .updateTable('customers_preferences')
      .set({ value: serialized, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', existing.id)
      .execute();
  } else {
    await db
      .insertInto('customers_preferences')
      .values({
        id: id(),
        tenant_id: tenantId,
        profile_id: profileId,
        key,
        value: serialized,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }
  await audit(asCoreDb(db), tenantId, actor, 'customers.preference.set', 'customers.preference', `${profileId}:${key}`);
  return db
    .selectFrom('customers_preferences')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('profile_id', '=', profileId)
    .where('key', '=', key)
    .executeTakeFirstOrThrow();
}

export async function listPreferences(
  db: Db,
  tenantId: string,
  profileId: string,
): Promise<CustomersPreferenceRow[]> {
  return db
    .selectFrom('customers_preferences')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('profile_id', '=', profileId)
    .orderBy('key')
    .orderBy('id')
    .execute();
}

/* ------------------------------------------------------------------ *
 * Suppressions
 * ------------------------------------------------------------------ */

export async function addSuppression(
  db: Db,
  tenantId: string,
  actor: string,
  scope: SuppressionScope,
  value: string,
  reason: SuppressionReason,
): Promise<CustomersSuppressionRow> {
  const normalized = normalizeSuppressionValue(scope, value);
  if (!normalized) throw ApiError.badRequest(`cannot normalize ${scope} value`);
  const existing = await db
    .selectFrom('customers_suppressions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('scope', '=', scope)
    .where('value_normalized', '=', normalized)
    .executeTakeFirst();
  if (existing) return existing;
  const row: CustomersSuppressionRow = {
    id: id(),
    tenant_id: tenantId,
    scope,
    value_normalized: normalized,
    reason,
    created_at: nowIso(),
  };
  await db.insertInto('customers_suppressions').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'customers.suppression.added', 'customers.suppression', row.id, { scope, reason });
  return row;
}

export async function removeSuppression(
  db: Db,
  tenantId: string,
  actor: string,
  scope: SuppressionScope,
  value: string,
): Promise<void> {
  const normalized = normalizeSuppressionValue(scope, value);
  if (!normalized) throw ApiError.badRequest(`cannot normalize ${scope} value`);
  const res = await db
    .deleteFrom('customers_suppressions')
    .where('tenant_id', '=', tenantId)
    .where('scope', '=', scope)
    .where('value_normalized', '=', normalized)
    .executeTakeFirst();
  if (res.numDeletedRows === 0n) throw ApiError.notFound('suppression not found');
  await audit(asCoreDb(db), tenantId, actor, 'customers.suppression.removed', 'customers.suppression', `${scope}:${normalized}`);
}

export async function listSuppressions(
  db: Db,
  tenantId: string,
  scope?: SuppressionScope,
): Promise<CustomersSuppressionRow[]> {
  let q = db.selectFrom('customers_suppressions').selectAll().where('tenant_id', '=', tenantId);
  if (scope) q = q.where('scope', '=', scope);
  return q.orderBy('created_at').orderBy('id').execute();
}

/** Global suppression check (consumed by outreach later). */
export async function isSuppressed(
  db: Db,
  tenantId: string,
  scope: SuppressionScope,
  value: string,
): Promise<boolean> {
  const normalized = normalizeSuppressionValue(scope, value);
  if (!normalized) return false;
  const row = await db
    .selectFrom('customers_suppressions')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('scope', '=', scope)
    .where('value_normalized', '=', normalized)
    .executeTakeFirst();
  return !!row;
}

/* ------------------------------------------------------------------ *
 * Segments — definitions as data + reproducible evaluation
 * ------------------------------------------------------------------ */

export async function seedBuiltinSegments(
  db: Db,
  tenantId: string,
  config: { vipThresholdCents?: number; lapsedLifetimeCents?: number } = {},
): Promise<CustomersSegmentRow[]> {
  const out: CustomersSegmentRow[] = [];
  for (const def of builtinSegments(config)) {
    const existing = await db
      .selectFrom('customers_segments')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('name', '=', def.name)
      .executeTakeFirst();
    if (existing) {
      out.push(existing);
      continue;
    }
    const now = nowIso();
    const row: CustomersSegmentRow = {
      id: id(),
      tenant_id: tenantId,
      name: def.name,
      rules: JSON.stringify(def.rules),
      builtin: 1,
      created_at: now,
      updated_at: now,
    };
    await db.insertInto('customers_segments').values(row).execute();
    out.push(row);
  }
  return out;
}

export async function createSegment(
  db: Db,
  tenantId: string,
  actor: string,
  name: string,
  rules: SegmentRules,
): Promise<CustomersSegmentRow> {
  const clash = await db
    .selectFrom('customers_segments')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('name', '=', name)
    .executeTakeFirst();
  if (clash) throw ApiError.conflict(`segment already exists: ${name}`);
  const now = nowIso();
  const row: CustomersSegmentRow = {
    id: id(),
    tenant_id: tenantId,
    name,
    rules: JSON.stringify(rules),
    builtin: 0,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('customers_segments').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'customers.segment.created', 'customers.segment', row.id);
  return row;
}

export async function listSegments(db: Db, tenantId: string): Promise<CustomersSegmentRow[]> {
  return db
    .selectFrom('customers_segments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .orderBy('id')
    .execute();
}

export async function getSegment(
  db: Db,
  tenantId: string,
  segmentId: string,
): Promise<CustomersSegmentRow> {
  const row = await db
    .selectFrom('customers_segments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', segmentId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`segment not found: ${segmentId}`);
  return row;
}

export async function updateSegment(
  db: Db,
  tenantId: string,
  actor: string,
  segmentId: string,
  rules: SegmentRules,
): Promise<CustomersSegmentRow> {
  await getSegment(db, tenantId, segmentId);
  await db
    .updateTable('customers_segments')
    .set({ rules: JSON.stringify(rules), updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', segmentId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'customers.segment.updated', 'customers.segment', segmentId);
  return getSegment(db, tenantId, segmentId);
}

export async function deleteSegment(
  db: Db,
  tenantId: string,
  actor: string,
  segmentId: string,
): Promise<void> {
  const seg = await getSegment(db, tenantId, segmentId);
  if (seg.builtin) throw ApiError.conflict('cannot delete a built-in segment');
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('customers_segment_members').where('tenant_id', '=', tenantId).where('segment_id', '=', segmentId).execute();
    await trx.deleteFrom('customers_segments').where('tenant_id', '=', tenantId).where('id', '=', segmentId).execute();
  });
  await audit(asCoreDb(db), tenantId, actor, 'customers.segment.deleted', 'customers.segment', segmentId);
}

export interface EvaluateResult {
  segmentId: string;
  members: string[];
  inputsHash: string;
  computedAt: string;
}

/**
 * Evaluate a segment against a caller-supplied stats input map and persist the
 * membership projection. Pure evaluation + reproducible hash: same inputs
 * -> same members + same inputs_hash. Membership is a recomputable projection,
 * so it is replaced (not business history).
 */
export async function evaluateSegmentAndPersist(
  db: Db,
  tenantId: string,
  segmentId: string,
  stats: StatsInputMap,
  clock: string = nowIso(),
): Promise<EvaluateResult> {
  const seg = await getSegment(db, tenantId, segmentId);
  const rules = JSON.parse(seg.rules) as SegmentRules;
  const { members, inputsHash } = evaluateSegment(rules, stats, clock);
  const computedAt = nowIso();
  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom('customers_segment_members')
      .where('tenant_id', '=', tenantId)
      .where('segment_id', '=', segmentId)
      .execute();
    for (const profileId of members) {
      const memberRow: CustomersSegmentMemberRow = {
        id: id(),
        tenant_id: tenantId,
        segment_id: segmentId,
        profile_id: profileId,
        computed_at: computedAt,
        inputs_hash: inputsHash,
        created_at: computedAt,
      };
      await trx.insertInto('customers_segment_members').values(memberRow).execute();
    }
  });
  return { segmentId, members, inputsHash, computedAt };
}

export async function listSegmentMembers(
  db: Db,
  tenantId: string,
  segmentId: string,
): Promise<CustomersSegmentMemberRow[]> {
  return db
    .selectFrom('customers_segment_members')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('segment_id', '=', segmentId)
    .orderBy('profile_id')
    .orderBy('id')
    .execute();
}

/* ------------------------------------------------------------------ *
 * Restock requests
 * ------------------------------------------------------------------ */

export async function createRestockRequest(
  db: Db,
  tenantId: string,
  actor: string,
  events: EventBus | undefined,
  input: { variationId: string; profileId?: string | null; source?: CustomerSource },
): Promise<CustomersRestockRequestRow> {
  if (input.profileId) await mustGetProfile(db, tenantId, input.profileId);
  const now = nowIso();
  const row: CustomersRestockRequestRow = {
    id: id(),
    tenant_id: tenantId,
    profile_id: input.profileId ?? null,
    variation_id: input.variationId,
    source: input.source ?? 'storefront',
    status: 'open',
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('customers_restock_requests').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'customers.restock.requested', 'customers.restock_request', row.id, {
    variationId: input.variationId,
  });
  if (events) {
    const payload: { v: 1; variationId: string; customerId?: string } = { v: 1, variationId: input.variationId };
    if (row.profile_id) payload.customerId = row.profile_id;
    await events.emit(tenantId, 'customers.restock.requested', payload);
  }
  return row;
}

export async function updateRestockStatus(
  db: Db,
  tenantId: string,
  actor: string,
  requestId: string,
  status: RestockStatus,
): Promise<CustomersRestockRequestRow> {
  const res = await db
    .updateTable('customers_restock_requests')
    .set({ status, updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', requestId)
    .executeTakeFirst();
  if (res.numUpdatedRows === 0n) throw ApiError.notFound(`restock request not found: ${requestId}`);
  await audit(asCoreDb(db), tenantId, actor, 'customers.restock.status_changed', 'customers.restock_request', requestId, { status });
  return db
    .selectFrom('customers_restock_requests')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', requestId)
    .executeTakeFirstOrThrow();
}

export async function listRestockRequests(
  db: Db,
  tenantId: string,
  filters: { variationId?: string; status?: RestockStatus } = {},
): Promise<CustomersRestockRequestRow[]> {
  let q = db.selectFrom('customers_restock_requests').selectAll().where('tenant_id', '=', tenantId);
  if (filters.variationId) q = q.where('variation_id', '=', filters.variationId);
  if (filters.status) q = q.where('status', '=', filters.status);
  return q.orderBy('created_at').orderBy('id').execute();
}

/* ------------------------------------------------------------------ *
 * Service cases + notes
 * ------------------------------------------------------------------ */

export async function createServiceCase(
  db: Db,
  tenantId: string,
  actor: string,
  input: { profileId: string; kind: ServiceCaseKind; body: string; assignedTo?: string | null },
): Promise<CustomersServiceCaseRow> {
  await mustGetProfile(db, tenantId, input.profileId);
  const now = nowIso();
  const row: CustomersServiceCaseRow = {
    id: id(),
    tenant_id: tenantId,
    profile_id: input.profileId,
    kind: input.kind,
    body: input.body,
    status: 'open',
    assigned_to: input.assignedTo ?? null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('customers_service_cases').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'customers.service_case.created', 'customers.service_case', row.id);
  return row;
}

export async function updateServiceCase(
  db: Db,
  tenantId: string,
  actor: string,
  caseId: string,
  patch: { status?: ServiceCaseStatus; assignedTo?: string | null },
): Promise<CustomersServiceCaseRow> {
  const set: Record<string, string | null> = { updated_at: nowIso() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.assignedTo !== undefined) set.assigned_to = patch.assignedTo ?? null;
  const res = await db
    .updateTable('customers_service_cases')
    .set(set)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', caseId)
    .executeTakeFirst();
  if (res.numUpdatedRows === 0n) throw ApiError.notFound(`service case not found: ${caseId}`);
  await audit(asCoreDb(db), tenantId, actor, 'customers.service_case.updated', 'customers.service_case', caseId, patch);
  return db
    .selectFrom('customers_service_cases')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', caseId)
    .executeTakeFirstOrThrow();
}

export async function listServiceCases(
  db: Db,
  tenantId: string,
  filters: { status?: ServiceCaseStatus; profileId?: string } = {},
): Promise<CustomersServiceCaseRow[]> {
  let q = db.selectFrom('customers_service_cases').selectAll().where('tenant_id', '=', tenantId);
  if (filters.status) q = q.where('status', '=', filters.status);
  if (filters.profileId) q = q.where('profile_id', '=', filters.profileId);
  return q.orderBy('created_at').orderBy('id').execute();
}

export async function addCaseNote(
  db: Db,
  tenantId: string,
  actor: string,
  caseId: string,
  body: string,
): Promise<CustomersServiceCaseNoteRow> {
  const kase = await db
    .selectFrom('customers_service_cases')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', caseId)
    .executeTakeFirst();
  if (!kase) throw ApiError.notFound(`service case not found: ${caseId}`);
  const row: CustomersServiceCaseNoteRow = {
    id: id(),
    tenant_id: tenantId,
    case_id: caseId,
    body,
    author: actor,
    created_at: nowIso(),
  };
  await db.insertInto('customers_service_case_notes').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'customers.service_case.note_added', 'customers.service_case', caseId);
  return row;
}

export async function listCaseNotes(
  db: Db,
  tenantId: string,
  caseId: string,
): Promise<CustomersServiceCaseNoteRow[]> {
  return db
    .selectFrom('customers_service_case_notes')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('case_id', '=', caseId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}
