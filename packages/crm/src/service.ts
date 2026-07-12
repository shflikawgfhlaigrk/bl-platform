/**
 * Tenant-scoped CRM business logic. Every mutation:
 *   1. writes the row (tenant-scoped),
 *   2. appends to the audit log (core helper),
 *   3. appends timeline events (own entity + mirrored to the linked customer),
 *   4. emits domain events AFTER the write.
 */
import type { Kysely } from 'kysely';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  listCustomFields,
  nowIso,
  parseCsv,
  serializeCsv,
  type EventBus,
  type Pagination,
  type Sort,
} from '@blacklabel/core';
import type {
  CrmCompanyRow,
  CrmContactRow,
  CrmCustomerRow,
  CrmDatabase,
  CrmDealRow,
  CrmJobRow,
  CrmLeadRow,
  CrmLeadStageRow,
  CrmNoteRow,
  CrmSourceAttributionRow,
  CrmTaggableRow,
  CrmTagRow,
  CrmTaskRow,
  CrmTimelineEventRow,
  CrmAttachmentRow,
} from './schema';
import { CRM_ENTITY_TYPES, type CrmEntityType } from './schema';

type Db = Kysely<CrmDatabase>;
/** Untyped view for generic (table-name-parameterized) queries. */
const anyDb = (db: Db) => db as Kysely<any>;

export interface ListParams {
  page: Pagination;
  sort?: Sort;
  filters?: Record<string, string>;
  /** Case-insensitive substring search over the entity's search columns. */
  q?: string;
}

export interface ImportResult {
  imported: number;
  ids: string[];
  errors: { row: number; message: string }[];
}

/* ------------------------------------------------------------------ *
 * Entity definitions (drive generic CRUD, search, timeline, events)
 * ------------------------------------------------------------------ */

export interface CrmEntityDef {
  /** Short key used in mirrored timeline event names ("lead.stage_changed"). */
  key: string;
  table: keyof CrmDatabase & string;
  entityType: CrmEntityType;
  searchColumns: readonly string[];
  filterColumns: readonly string[];
  sortColumns: readonly string[];
  /** Column holding a crm_customers id — mirrored timeline target. */
  customerLink?: string;
  /** Domain event emitted on create, with { [eventIdKey]: id }. */
  createdEvent?: string;
  eventIdKey?: string;
}

export const ENTITY_DEFS = {
  company: {
    key: 'company',
    table: 'crm_companies',
    entityType: 'crm.company',
    searchColumns: ['name', 'domain', 'email', 'phone'],
    filterColumns: ['owner_user_id', 'domain'],
    sortColumns: ['name', 'created_at', 'updated_at'],
  },
  customer: {
    key: 'customer',
    table: 'crm_customers',
    entityType: 'crm.customer',
    searchColumns: ['name', 'email', 'phone', 'address'],
    filterColumns: ['status', 'company_id', 'owner_user_id'],
    sortColumns: ['name', 'status', 'created_at', 'updated_at'],
    createdEvent: 'crm.customer.created',
    eventIdKey: 'customerId',
  },
  contact: {
    key: 'contact',
    table: 'crm_contacts',
    entityType: 'crm.contact',
    searchColumns: ['first_name', 'last_name', 'email', 'phone', 'title'],
    filterColumns: ['customer_id', 'company_id', 'owner_user_id'],
    sortColumns: ['first_name', 'last_name', 'created_at', 'updated_at'],
    customerLink: 'customer_id',
  },
  lead: {
    key: 'lead',
    table: 'crm_leads',
    entityType: 'crm.lead',
    searchColumns: ['name', 'email', 'phone', 'source'],
    filterColumns: ['stage', 'source', 'customer_id', 'company_id', 'owner_user_id'],
    sortColumns: ['name', 'stage', 'value_cents', 'created_at', 'updated_at'],
    customerLink: 'customer_id',
    createdEvent: 'crm.lead.created',
    eventIdKey: 'leadId',
  },
  deal: {
    key: 'deal',
    table: 'crm_deals',
    entityType: 'crm.deal',
    searchColumns: ['title'],
    filterColumns: ['status', 'customer_id', 'lead_id', 'company_id', 'owner_user_id'],
    sortColumns: ['title', 'status', 'value_cents', 'expected_close_at', 'created_at', 'updated_at'],
    customerLink: 'customer_id',
    createdEvent: 'crm.deal.created',
    eventIdKey: 'dealId',
  },
  job: {
    key: 'job',
    table: 'crm_jobs',
    entityType: 'crm.job',
    searchColumns: ['title', 'description'],
    filterColumns: ['status', 'customer_id', 'deal_id', 'owner_user_id'],
    sortColumns: ['title', 'status', 'starts_at', 'created_at', 'updated_at'],
    customerLink: 'customer_id',
    createdEvent: 'crm.job.created',
    eventIdKey: 'jobId',
  },
} as const satisfies Record<string, CrmEntityDef>;

const DEFS_BY_ENTITY_TYPE: Record<string, CrmEntityDef> = Object.fromEntries(
  Object.values(ENTITY_DEFS).map((d) => [d.entityType, d]),
);

export function isCrmEntityType(value: string): value is CrmEntityType {
  return (CRM_ENTITY_TYPES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Timeline
 * ------------------------------------------------------------------ */

export async function addTimelineEvent(
  db: Db,
  tenantId: string,
  entityType: string,
  entityId: string,
  eventType: string,
  actor: string,
  data?: unknown,
): Promise<CrmTimelineEventRow> {
  const row: CrmTimelineEventRow = {
    id: id(),
    tenant_id: tenantId,
    entity_type: entityType,
    entity_id: entityId,
    event_type: eventType,
    actor,
    data: data === undefined ? null : JSON.stringify(data),
    created_at: nowIso(),
  };
  await db.insertInto('crm_timeline_events').values(row).execute();
  return row;
}

/** Timeline on the entity itself + mirrored onto the linked customer. */
async function timelineWithMirror(
  db: Db,
  tenantId: string,
  def: CrmEntityDef,
  row: Record<string, unknown>,
  eventType: string,
  actor: string,
  data: Record<string, unknown>,
): Promise<void> {
  await addTimelineEvent(db, tenantId, def.entityType, String(row.id), eventType, actor, data);
  const customerId = def.customerLink ? row[def.customerLink] : undefined;
  if (customerId && typeof customerId === 'string') {
    await addTimelineEvent(db, tenantId, 'crm.customer', customerId, `${def.key}.${eventType}`, actor, {
      ...data,
      [`${def.key}Id`]: row.id,
    });
  }
}

export async function listTimeline(
  db: Db,
  tenantId: string,
  entityType: string,
  entityId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<CrmTimelineEventRow[]> {
  return db
    .selectFrom('crm_timeline_events')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('entity_type', '=', entityType)
    .where('entity_id', '=', entityId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

/* ------------------------------------------------------------------ *
 * Custom fields (definitions live in core; values live on our rows)
 * ------------------------------------------------------------------ */

/**
 * Validate a custom_fields object against the tenant's core definitions for
 * this entity type and serialize it. Unknown keys are a 400.
 */
async function serializeCustomFields(
  db: Db,
  tenantId: string,
  entityType: string,
  input: Record<string, unknown> | undefined,
): Promise<string | null | undefined> {
  if (input === undefined) return undefined;
  const defs = await listCustomFields(asCoreDb(db), tenantId, entityType);
  const allowed = new Set(defs.map((d) => d.key));
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw ApiError.badRequest(`unknown custom field "${key}" for ${entityType}`, {
        allowed: [...allowed].sort(),
      });
    }
  }
  return JSON.stringify(input);
}

/* ------------------------------------------------------------------ *
 * Generic CRUD core
 * ------------------------------------------------------------------ */

async function genericGet(
  db: Db,
  tenantId: string,
  def: CrmEntityDef,
  entityId: string,
): Promise<Record<string, unknown> | undefined> {
  return anyDb(db)
    .selectFrom(def.table)
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', entityId)
    .executeTakeFirst();
}

async function genericMustGet(
  db: Db,
  tenantId: string,
  def: CrmEntityDef,
  entityId: string,
): Promise<Record<string, unknown>> {
  const row = await genericGet(db, tenantId, def, entityId);
  if (!row) throw ApiError.notFound(`${def.entityType} not found: ${entityId}`);
  return row;
}

async function genericList(
  db: Db,
  tenantId: string,
  def: CrmEntityDef,
  params: ListParams,
): Promise<Record<string, unknown>[]> {
  let qb = anyDb(db).selectFrom(def.table).selectAll().where('tenant_id', '=', tenantId);
  for (const [column, value] of Object.entries(params.filters ?? {})) {
    qb = qb.where(column, '=', value);
  }
  const q = params.q?.trim();
  if (q && def.searchColumns.length > 0) {
    // lower() on both sides: case-insensitive on SQLite AND Postgres.
    const needle = `%${q.toLowerCase()}%`;
    qb = qb.where((eb: any) =>
      eb.or(def.searchColumns.map((column) => eb(eb.fn('lower', [column]), 'like', needle))),
    );
  }
  const sort = params.sort ?? { column: 'created_at', direction: 'desc' as const };
  return qb
    .orderBy(sort.column, sort.direction)
    .orderBy('id')
    .limit(params.page.limit)
    .offset(params.page.offset)
    .execute();
}

async function genericCreate(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  def: CrmEntityDef,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const now = nowIso();
  const row: Record<string, unknown> = {
    id: id(),
    tenant_id: tenantId,
    created_at: now,
    updated_at: now,
    ...values,
  };
  await anyDb(db).insertInto(def.table).values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, `${def.entityType}.created`, def.entityType, String(row.id), {
    after: values,
  });
  await timelineWithMirror(db, tenantId, def, row, 'created', actor, {});
  if (def.createdEvent && def.eventIdKey) {
    await events.emit(tenantId, def.createdEvent, { [def.eventIdKey]: row.id });
  }
  return row;
}

async function genericUpdate(
  db: Db,
  tenantId: string,
  actor: string,
  def: CrmEntityDef,
  entityId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const before = await genericMustGet(db, tenantId, def, entityId);
  const keys = Object.keys(patch);
  if (keys.length === 0) return before;
  await anyDb(db)
    .updateTable(def.table)
    .set({ ...patch, updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', entityId)
    .execute();
  const after = await genericMustGet(db, tenantId, def, entityId);
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    if (before[key] !== after[key]) changed[key] = { from: before[key], to: after[key] };
  }
  await audit(asCoreDb(db), tenantId, actor, `${def.entityType}.updated`, def.entityType, entityId, {
    changed,
  });
  await timelineWithMirror(db, tenantId, def, after, 'updated', actor, { fields: keys });
  return after;
}

async function genericDelete(
  db: Db,
  tenantId: string,
  actor: string,
  def: CrmEntityDef,
  entityId: string,
): Promise<void> {
  const before = await genericMustGet(db, tenantId, def, entityId);
  await anyDb(db)
    .deleteFrom(def.table)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', entityId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, `${def.entityType}.deleted`, def.entityType, entityId, {
    before,
  });
  const customerId = def.customerLink ? before[def.customerLink] : undefined;
  if (customerId && typeof customerId === 'string') {
    await addTimelineEvent(db, tenantId, 'crm.customer', customerId, `${def.key}.deleted`, actor, {
      [`${def.key}Id`]: entityId,
    });
  }
}

/** Assert a referenced CRM entity exists in this tenant (404 otherwise). */
export async function assertEntityExists(
  db: Db,
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  if (!isCrmEntityType(entityType)) {
    throw ApiError.badRequest(`unknown entity_type "${entityType}"`, {
      allowed: CRM_ENTITY_TYPES,
    });
  }
  const def = DEFS_BY_ENTITY_TYPE[entityType];
  await genericMustGet(db, tenantId, def, entityId);
}

const nn = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/* ------------------------------------------------------------------ *
 * Companies
 * ------------------------------------------------------------------ */

export interface CompanyInput {
  name?: string;
  domain?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  owner_user_id?: string | null;
  custom_fields?: Record<string, unknown>;
}

export async function createCompany(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: CompanyInput,
): Promise<CrmCompanyRow> {
  if (!input.name?.trim()) throw ApiError.badRequest('company name is required');
  const custom = await serializeCustomFields(db, tenantId, 'crm.company', input.custom_fields);
  return (await genericCreate(db, events, tenantId, actor, ENTITY_DEFS.company, {
    name: input.name.trim(),
    domain: nn(input.domain),
    email: nn(input.email),
    phone: nn(input.phone),
    address: nn(input.address),
    owner_user_id: nn(input.owner_user_id),
    custom_fields: custom ?? null,
  })) as unknown as CrmCompanyRow;
}

export async function updateCompany(
  db: Db,
  tenantId: string,
  actor: string,
  companyId: string,
  patch: CompanyInput,
): Promise<CrmCompanyRow> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw ApiError.badRequest('company name cannot be blank');
    set.name = patch.name.trim();
  }
  for (const k of ['domain', 'email', 'phone', 'address', 'owner_user_id'] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  const custom = await serializeCustomFields(db, tenantId, 'crm.company', patch.custom_fields);
  if (custom !== undefined) set.custom_fields = custom;
  return (await genericUpdate(db, tenantId, actor, ENTITY_DEFS.company, companyId, set)) as unknown as CrmCompanyRow;
}

/* ------------------------------------------------------------------ *
 * Customers
 * ------------------------------------------------------------------ */

export const CUSTOMER_STATUSES = ['active', 'inactive', 'archived'] as const;

export interface CustomerInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  status?: string;
  company_id?: string | null;
  owner_user_id?: string | null;
  custom_fields?: Record<string, unknown>;
}

/** Service-level guard: the CSV import path does not go through zod. */
function assertCustomerStatus(status: string): void {
  if (!(CUSTOMER_STATUSES as readonly string[]).includes(status)) {
    throw ApiError.badRequest(`invalid customer status "${status}"`, {
      allowed: CUSTOMER_STATUSES,
    });
  }
}

export async function createCustomer(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: CustomerInput,
): Promise<CrmCustomerRow> {
  if (!input.name?.trim()) throw ApiError.badRequest('customer name is required');
  if (input.status !== undefined) assertCustomerStatus(input.status);
  const custom = await serializeCustomFields(db, tenantId, 'crm.customer', input.custom_fields);
  return (await genericCreate(db, events, tenantId, actor, ENTITY_DEFS.customer, {
    name: input.name.trim(),
    email: nn(input.email),
    phone: nn(input.phone),
    address: nn(input.address),
    status: input.status ?? 'active',
    company_id: nn(input.company_id),
    owner_user_id: nn(input.owner_user_id),
    custom_fields: custom ?? null,
  })) as unknown as CrmCustomerRow;
}

export async function updateCustomer(
  db: Db,
  tenantId: string,
  actor: string,
  customerId: string,
  patch: CustomerInput,
): Promise<CrmCustomerRow> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw ApiError.badRequest('customer name cannot be blank');
    set.name = patch.name.trim();
  }
  if (patch.status !== undefined) assertCustomerStatus(patch.status);
  for (const k of ['email', 'phone', 'address', 'status', 'company_id', 'owner_user_id'] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  const custom = await serializeCustomFields(db, tenantId, 'crm.customer', patch.custom_fields);
  if (custom !== undefined) set.custom_fields = custom;
  return (await genericUpdate(db, tenantId, actor, ENTITY_DEFS.customer, customerId, set)) as unknown as CrmCustomerRow;
}

/* ------------------------------------------------------------------ *
 * Contacts
 * ------------------------------------------------------------------ */

export interface ContactInput {
  first_name?: string;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  customer_id?: string | null;
  company_id?: string | null;
  owner_user_id?: string | null;
  custom_fields?: Record<string, unknown>;
}

export async function createContact(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: ContactInput,
): Promise<CrmContactRow> {
  if (!input.first_name?.trim()) throw ApiError.badRequest('contact first_name is required');
  const custom = await serializeCustomFields(db, tenantId, 'crm.contact', input.custom_fields);
  return (await genericCreate(db, events, tenantId, actor, ENTITY_DEFS.contact, {
    first_name: input.first_name.trim(),
    last_name: nn(input.last_name),
    email: nn(input.email),
    phone: nn(input.phone),
    title: nn(input.title),
    customer_id: nn(input.customer_id),
    company_id: nn(input.company_id),
    owner_user_id: nn(input.owner_user_id),
    custom_fields: custom ?? null,
  })) as unknown as CrmContactRow;
}

export async function updateContact(
  db: Db,
  tenantId: string,
  actor: string,
  contactId: string,
  patch: ContactInput,
): Promise<CrmContactRow> {
  const set: Record<string, unknown> = {};
  if (patch.first_name !== undefined) {
    if (!patch.first_name.trim()) throw ApiError.badRequest('contact first_name cannot be blank');
    set.first_name = patch.first_name.trim();
  }
  for (const k of ['last_name', 'email', 'phone', 'title', 'customer_id', 'company_id', 'owner_user_id'] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  const custom = await serializeCustomFields(db, tenantId, 'crm.contact', patch.custom_fields);
  if (custom !== undefined) set.custom_fields = custom;
  return (await genericUpdate(db, tenantId, actor, ENTITY_DEFS.contact, contactId, set)) as unknown as CrmContactRow;
}

/* ------------------------------------------------------------------ *
 * Lead stages (per-tenant configurable, sensible defaults)
 * ------------------------------------------------------------------ */

export const DEFAULT_LEAD_STAGES = [
  'new',
  'contacted',
  'qualified',
  'quoted',
  'won',
  'lost',
] as const;

const STAGE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface LeadStage {
  key: string;
  label: string;
  sort_order: number;
}

/** The tenant's configured stage list, or the defaults if none configured. */
export async function listLeadStages(db: Db, tenantId: string): Promise<LeadStage[]> {
  const rows = await db
    .selectFrom('crm_lead_stages')
    .select(['key', 'label', 'sort_order'])
    .where('tenant_id', '=', tenantId)
    .orderBy('sort_order')
    .orderBy('id')
    .execute();
  if (rows.length > 0) return rows;
  return DEFAULT_LEAD_STAGES.map((key, i) => ({ key, label: key, sort_order: i }));
}

export async function leadStageKeys(db: Db, tenantId: string): Promise<string[]> {
  return (await listLeadStages(db, tenantId)).map((s) => s.key);
}

/** Replace the tenant's lead stage list. */
export async function setLeadStages(
  db: Db,
  tenantId: string,
  actor: string,
  stages: { key: string; label?: string }[],
): Promise<LeadStage[]> {
  if (stages.length === 0) throw ApiError.badRequest('at least one lead stage is required');
  const seen = new Set<string>();
  for (const s of stages) {
    if (!STAGE_KEY_PATTERN.test(s.key)) {
      throw ApiError.badRequest(`invalid stage key "${s.key}" (want ${STAGE_KEY_PATTERN})`);
    }
    if (seen.has(s.key)) throw ApiError.badRequest(`duplicate stage key "${s.key}"`);
    seen.add(s.key);
  }
  await db.deleteFrom('crm_lead_stages').where('tenant_id', '=', tenantId).execute();
  const now = nowIso();
  const rows: CrmLeadStageRow[] = stages.map((s, i) => ({
    id: id(),
    tenant_id: tenantId,
    key: s.key,
    label: s.label ?? s.key,
    sort_order: i,
    created_at: now,
  }));
  for (const row of rows) {
    await db.insertInto('crm_lead_stages').values(row).execute();
  }
  await audit(asCoreDb(db), tenantId, actor, 'crm.lead_stages.replaced', 'crm.lead_stages', tenantId, {
    stages: rows.map((r) => r.key),
  });
  return rows.map(({ key, label, sort_order }) => ({ key, label, sort_order }));
}

/* ------------------------------------------------------------------ *
 * Leads
 * ------------------------------------------------------------------ */

export interface LeadInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  stage?: string;
  value_cents?: number | null;
  customer_id?: string | null;
  contact_id?: string | null;
  company_id?: string | null;
  owner_user_id?: string | null;
  custom_fields?: Record<string, unknown>;
}

async function assertValidStage(db: Db, tenantId: string, stage: string): Promise<void> {
  const keys = await leadStageKeys(db, tenantId);
  if (!keys.includes(stage)) {
    throw ApiError.badRequest(`invalid lead stage "${stage}"`, { allowed: keys });
  }
}

/** Service-level guard: the CSV import path does not go through zod. */
function assertValueCents(value: number | null | undefined): void {
  if (value != null && (!Number.isInteger(value) || value < 0)) {
    throw ApiError.badRequest('value_cents must be a non-negative integer');
  }
}

export async function createLead(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: LeadInput,
): Promise<CrmLeadRow> {
  if (!input.name?.trim()) throw ApiError.badRequest('lead name is required');
  assertValueCents(input.value_cents);
  const keys = await leadStageKeys(db, tenantId);
  const stage = input.stage ?? keys[0];
  if (!keys.includes(stage)) {
    throw ApiError.badRequest(`invalid lead stage "${stage}"`, { allowed: keys });
  }
  const custom = await serializeCustomFields(db, tenantId, 'crm.lead', input.custom_fields);
  return (await genericCreate(db, events, tenantId, actor, ENTITY_DEFS.lead, {
    name: input.name.trim(),
    email: nn(input.email),
    phone: nn(input.phone),
    source: nn(input.source),
    stage,
    value_cents: nn(input.value_cents),
    customer_id: nn(input.customer_id),
    contact_id: nn(input.contact_id),
    company_id: nn(input.company_id),
    owner_user_id: nn(input.owner_user_id),
    custom_fields: custom ?? null,
  })) as unknown as CrmLeadRow;
}

export async function updateLead(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  leadId: string,
  patch: LeadInput,
): Promise<CrmLeadRow> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw ApiError.badRequest('lead name cannot be blank');
    set.name = patch.name.trim();
  }
  assertValueCents(patch.value_cents);
  for (const k of [
    'email',
    'phone',
    'source',
    'value_cents',
    'customer_id',
    'contact_id',
    'company_id',
    'owner_user_id',
  ] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  const custom = await serializeCustomFields(db, tenantId, 'crm.lead', patch.custom_fields);
  if (custom !== undefined) set.custom_fields = custom;

  let lead = (await genericUpdate(db, tenantId, actor, ENTITY_DEFS.lead, leadId, set)) as unknown as CrmLeadRow;
  if (patch.stage !== undefined && patch.stage !== lead.stage) {
    lead = await changeLeadStage(db, events, tenantId, actor, leadId, patch.stage);
  }
  return lead;
}

/** Move a lead to a new stage. Emits crm.lead.stage_changed. */
export async function changeLeadStage(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  leadId: string,
  stage: string,
): Promise<CrmLeadRow> {
  const lead = (await genericMustGet(db, tenantId, ENTITY_DEFS.lead, leadId)) as unknown as CrmLeadRow;
  await assertValidStage(db, tenantId, stage);
  if (lead.stage === stage) return lead;
  await db
    .updateTable('crm_leads')
    .set({ stage, updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', leadId)
    .execute();
  const after = (await genericMustGet(db, tenantId, ENTITY_DEFS.lead, leadId)) as unknown as CrmLeadRow;
  await audit(asCoreDb(db), tenantId, actor, 'crm.lead.stage_changed', 'crm.lead', leadId, {
    from: lead.stage,
    to: stage,
  });
  await timelineWithMirror(db, tenantId, ENTITY_DEFS.lead, after as unknown as Record<string, unknown>, 'stage_changed', actor, {
    from: lead.stage,
    to: stage,
  });
  await events.emit(tenantId, 'crm.lead.stage_changed', { leadId, from: lead.stage, to: stage });
  return after;
}

/* ------------------------------------------------------------------ *
 * Deals
 * ------------------------------------------------------------------ */

export const DEAL_STATUSES = ['open', 'won', 'lost'] as const;

export interface DealInput {
  title?: string;
  status?: string;
  value_cents?: number;
  customer_id?: string | null;
  lead_id?: string | null;
  company_id?: string | null;
  owner_user_id?: string | null;
  expected_close_at?: string | null;
  custom_fields?: Record<string, unknown>;
}

export async function createDeal(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: DealInput,
): Promise<CrmDealRow> {
  if (!input.title?.trim()) throw ApiError.badRequest('deal title is required');
  const custom = await serializeCustomFields(db, tenantId, 'crm.deal', input.custom_fields);
  return (await genericCreate(db, events, tenantId, actor, ENTITY_DEFS.deal, {
    title: input.title.trim(),
    status: input.status ?? 'open',
    value_cents: input.value_cents ?? 0,
    customer_id: nn(input.customer_id),
    lead_id: nn(input.lead_id),
    company_id: nn(input.company_id),
    owner_user_id: nn(input.owner_user_id),
    expected_close_at: nn(input.expected_close_at),
    custom_fields: custom ?? null,
  })) as unknown as CrmDealRow;
}

export async function updateDeal(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  dealId: string,
  patch: DealInput,
): Promise<CrmDealRow> {
  const before = (await genericMustGet(db, tenantId, ENTITY_DEFS.deal, dealId)) as unknown as CrmDealRow;
  const set: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw ApiError.badRequest('deal title cannot be blank');
    set.title = patch.title.trim();
  }
  for (const k of [
    'status',
    'value_cents',
    'customer_id',
    'lead_id',
    'company_id',
    'owner_user_id',
    'expected_close_at',
  ] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  const custom = await serializeCustomFields(db, tenantId, 'crm.deal', patch.custom_fields);
  if (custom !== undefined) set.custom_fields = custom;
  const after = (await genericUpdate(db, tenantId, actor, ENTITY_DEFS.deal, dealId, set)) as unknown as CrmDealRow;
  if (patch.status !== undefined && patch.status !== before.status) {
    await events.emit(tenantId, 'crm.deal.stage_changed', {
      dealId,
      from: before.status,
      to: after.status,
      valueCents: after.value_cents,
    });
  }
  return after;
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

export interface JobInput {
  title?: string;
  description?: string | null;
  status?: string;
  customer_id?: string | null;
  deal_id?: string | null;
  owner_user_id?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  custom_fields?: Record<string, unknown>;
}

export async function createJob(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: JobInput,
): Promise<CrmJobRow> {
  if (!input.title?.trim()) throw ApiError.badRequest('job title is required');
  const custom = await serializeCustomFields(db, tenantId, 'crm.job', input.custom_fields);
  return (await genericCreate(db, events, tenantId, actor, ENTITY_DEFS.job, {
    title: input.title.trim(),
    description: nn(input.description),
    status: input.status ?? 'planned',
    customer_id: nn(input.customer_id),
    deal_id: nn(input.deal_id),
    owner_user_id: nn(input.owner_user_id),
    starts_at: nn(input.starts_at),
    ends_at: nn(input.ends_at),
    custom_fields: custom ?? null,
  })) as unknown as CrmJobRow;
}

export async function updateJob(
  db: Db,
  tenantId: string,
  actor: string,
  jobId: string,
  patch: JobInput,
): Promise<CrmJobRow> {
  const set: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw ApiError.badRequest('job title cannot be blank');
    set.title = patch.title.trim();
  }
  for (const k of ['description', 'status', 'customer_id', 'deal_id', 'owner_user_id', 'starts_at', 'ends_at'] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  const custom = await serializeCustomFields(db, tenantId, 'crm.job', patch.custom_fields);
  if (custom !== undefined) set.custom_fields = custom;
  return (await genericUpdate(db, tenantId, actor, ENTITY_DEFS.job, jobId, set)) as unknown as CrmJobRow;
}

/* ------------------------------------------------------------------ *
 * Generic entity facade for router CRUD (get/list/delete)
 * ------------------------------------------------------------------ */

export const getEntity = genericGet;
export const mustGetEntity = genericMustGet;
export const listEntities = genericList;
export const deleteEntity = genericDelete;

/* ------------------------------------------------------------------ *
 * Notes
 * ------------------------------------------------------------------ */

export async function createNote(
  db: Db,
  tenantId: string,
  actor: string,
  input: { entity_type: string; entity_id: string; body: string; author_user_id?: string | null },
): Promise<CrmNoteRow> {
  await assertEntityExists(db, tenantId, input.entity_type, input.entity_id);
  const now = nowIso();
  const row: CrmNoteRow = {
    id: id(),
    tenant_id: tenantId,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    body: input.body,
    author_user_id: nn(input.author_user_id),
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('crm_notes').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'crm.note.created', 'crm.note', row.id, { after: input });
  await addTimelineEvent(db, tenantId, input.entity_type, input.entity_id, 'note_added', actor, {
    noteId: row.id,
  });
  return row;
}

export async function getNote(db: Db, tenantId: string, noteId: string): Promise<CrmNoteRow | undefined> {
  return db
    .selectFrom('crm_notes')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', noteId)
    .executeTakeFirst();
}

export async function listNotes(
  db: Db,
  tenantId: string,
  params: ListParams,
): Promise<CrmNoteRow[]> {
  let qb = db.selectFrom('crm_notes').selectAll().where('tenant_id', '=', tenantId);
  for (const [column, value] of Object.entries(params.filters ?? {})) {
    qb = qb.where(column as 'entity_type' | 'entity_id' | 'author_user_id', '=', value);
  }
  const q = params.q?.trim();
  if (q) qb = qb.where((eb) => eb(eb.fn('lower', ['body']), 'like', `%${q.toLowerCase()}%`));
  const sort = params.sort ?? { column: 'created_at' as const, direction: 'desc' as const };
  return qb
    .orderBy(sort.column as 'created_at', sort.direction)
    .orderBy('id')
    .limit(params.page.limit)
    .offset(params.page.offset)
    .execute();
}

export async function updateNote(
  db: Db,
  tenantId: string,
  actor: string,
  noteId: string,
  patch: { body?: string },
): Promise<CrmNoteRow> {
  const before = await getNote(db, tenantId, noteId);
  if (!before) throw ApiError.notFound(`crm.note not found: ${noteId}`);
  if (patch.body !== undefined) {
    await db
      .updateTable('crm_notes')
      .set({ body: patch.body, updated_at: nowIso() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', noteId)
      .execute();
    await audit(asCoreDb(db), tenantId, actor, 'crm.note.updated', 'crm.note', noteId, {
      changed: { body: { from: before.body, to: patch.body } },
    });
  }
  const after = await getNote(db, tenantId, noteId);
  if (!after) throw ApiError.notFound(`crm.note not found: ${noteId}`);
  return after;
}

export async function deleteNote(db: Db, tenantId: string, actor: string, noteId: string): Promise<void> {
  const before = await getNote(db, tenantId, noteId);
  if (!before) throw ApiError.notFound(`crm.note not found: ${noteId}`);
  await db.deleteFrom('crm_notes').where('tenant_id', '=', tenantId).where('id', '=', noteId).execute();
  await audit(asCoreDb(db), tenantId, actor, 'crm.note.deleted', 'crm.note', noteId, { before });
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

export interface TaskInput {
  title?: string;
  description?: string | null;
  due_at?: string | null;
  assignee_user_id?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
}

export async function createTask(
  db: Db,
  tenantId: string,
  actor: string,
  input: TaskInput,
): Promise<CrmTaskRow> {
  if (!input.title?.trim()) throw ApiError.badRequest('task title is required');
  if ((input.entity_type == null) !== (input.entity_id == null)) {
    throw ApiError.badRequest('entity_type and entity_id must be provided together');
  }
  if (input.entity_type && input.entity_id) {
    await assertEntityExists(db, tenantId, input.entity_type, input.entity_id);
  }
  const now = nowIso();
  const row: CrmTaskRow = {
    id: id(),
    tenant_id: tenantId,
    title: input.title.trim(),
    description: nn(input.description),
    status: 'open',
    due_at: nn(input.due_at),
    assignee_user_id: nn(input.assignee_user_id),
    entity_type: nn(input.entity_type),
    entity_id: nn(input.entity_id),
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('crm_tasks').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'crm.task.created', 'crm.task', row.id, { after: input });
  if (row.entity_type && row.entity_id) {
    await addTimelineEvent(db, tenantId, row.entity_type, row.entity_id, 'task_created', actor, {
      taskId: row.id,
      title: row.title,
    });
  }
  return row;
}

export async function getTask(db: Db, tenantId: string, taskId: string): Promise<CrmTaskRow | undefined> {
  return db
    .selectFrom('crm_tasks')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', taskId)
    .executeTakeFirst();
}

export async function listTasks(db: Db, tenantId: string, params: ListParams): Promise<CrmTaskRow[]> {
  let qb = db.selectFrom('crm_tasks').selectAll().where('tenant_id', '=', tenantId);
  for (const [column, value] of Object.entries(params.filters ?? {})) {
    qb = qb.where(column as 'status' | 'assignee_user_id' | 'entity_type' | 'entity_id', '=', value as never);
  }
  const q = params.q?.trim();
  if (q) qb = qb.where((eb) => eb(eb.fn('lower', ['title']), 'like', `%${q.toLowerCase()}%`));
  const sort = params.sort ?? { column: 'created_at' as const, direction: 'desc' as const };
  return qb
    .orderBy(sort.column as 'created_at', sort.direction)
    .orderBy('id')
    .limit(params.page.limit)
    .offset(params.page.offset)
    .execute();
}

export async function updateTask(
  db: Db,
  tenantId: string,
  actor: string,
  taskId: string,
  patch: TaskInput,
): Promise<CrmTaskRow> {
  const before = await getTask(db, tenantId, taskId);
  if (!before) throw ApiError.notFound(`crm.task not found: ${taskId}`);
  const set: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw ApiError.badRequest('task title cannot be blank');
    set.title = patch.title.trim();
  }
  for (const k of ['description', 'due_at', 'assignee_user_id'] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  if (Object.keys(set).length > 0) {
    set.updated_at = nowIso();
    await db
      .updateTable('crm_tasks')
      .set(set as never)
      .where('tenant_id', '=', tenantId)
      .where('id', '=', taskId)
      .execute();
    await audit(asCoreDb(db), tenantId, actor, 'crm.task.updated', 'crm.task', taskId, {
      fields: Object.keys(set),
    });
  }
  const after = await getTask(db, tenantId, taskId);
  if (!after) throw ApiError.notFound(`crm.task not found: ${taskId}`);
  return after;
}

/** Complete a task (idempotent). Emits crm.task.completed. */
export async function completeTask(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  taskId: string,
): Promise<CrmTaskRow> {
  const task = await getTask(db, tenantId, taskId);
  if (!task) throw ApiError.notFound(`crm.task not found: ${taskId}`);
  if (task.status === 'completed') return task;
  const now = nowIso();
  await db
    .updateTable('crm_tasks')
    .set({ status: 'completed', completed_at: now, updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', taskId)
    .execute();
  const after = await getTask(db, tenantId, taskId);
  if (!after) throw ApiError.notFound(`crm.task not found: ${taskId}`);
  await audit(asCoreDb(db), tenantId, actor, 'crm.task.completed', 'crm.task', taskId);
  if (after.entity_type && after.entity_id) {
    await addTimelineEvent(db, tenantId, after.entity_type, after.entity_id, 'task_completed', actor, {
      taskId,
    });
  }
  await events.emit(tenantId, 'crm.task.completed', { taskId });
  return after;
}

export async function deleteTask(db: Db, tenantId: string, actor: string, taskId: string): Promise<void> {
  const before = await getTask(db, tenantId, taskId);
  if (!before) throw ApiError.notFound(`crm.task not found: ${taskId}`);
  await db.deleteFrom('crm_tasks').where('tenant_id', '=', tenantId).where('id', '=', taskId).execute();
  await audit(asCoreDb(db), tenantId, actor, 'crm.task.deleted', 'crm.task', taskId, { before });
}

/* ------------------------------------------------------------------ *
 * Tags + taggables
 * ------------------------------------------------------------------ */

export async function createTag(
  db: Db,
  tenantId: string,
  actor: string,
  input: { name: string; color?: string | null },
): Promise<CrmTagRow> {
  const name = input.name.trim();
  if (!name) throw ApiError.badRequest('tag name is required');
  const existing = await db
    .selectFrom('crm_tags')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('name', '=', name)
    .executeTakeFirst();
  if (existing) throw ApiError.conflict(`tag "${name}" already exists`);
  const row: CrmTagRow = {
    id: id(),
    tenant_id: tenantId,
    name,
    color: nn(input.color),
    created_at: nowIso(),
  };
  await db.insertInto('crm_tags').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'crm.tag.created', 'crm.tag', row.id, { after: { name } });
  return row;
}

export async function getTag(db: Db, tenantId: string, tagId: string): Promise<CrmTagRow | undefined> {
  return db
    .selectFrom('crm_tags')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', tagId)
    .executeTakeFirst();
}

export async function listTags(db: Db, tenantId: string, params: ListParams): Promise<CrmTagRow[]> {
  let qb = db.selectFrom('crm_tags').selectAll().where('tenant_id', '=', tenantId);
  const q = params.q?.trim();
  if (q) qb = qb.where((eb) => eb(eb.fn('lower', ['name']), 'like', `%${q.toLowerCase()}%`));
  const sort = params.sort ?? { column: 'name' as const, direction: 'asc' as const };
  return qb
    .orderBy(sort.column as 'name', sort.direction)
    .orderBy('id')
    .limit(params.page.limit)
    .offset(params.page.offset)
    .execute();
}

export async function updateTag(
  db: Db,
  tenantId: string,
  actor: string,
  tagId: string,
  patch: { name?: string; color?: string | null },
): Promise<CrmTagRow> {
  const before = await getTag(db, tenantId, tagId);
  if (!before) throw ApiError.notFound(`crm.tag not found: ${tagId}`);
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw ApiError.badRequest('tag name cannot be blank');
    set.name = name;
  }
  if (patch.color !== undefined) set.color = patch.color;
  if (Object.keys(set).length > 0) {
    await db
      .updateTable('crm_tags')
      .set(set as never)
      .where('tenant_id', '=', tenantId)
      .where('id', '=', tagId)
      .execute();
    await audit(asCoreDb(db), tenantId, actor, 'crm.tag.updated', 'crm.tag', tagId, { fields: Object.keys(set) });
  }
  const after = await getTag(db, tenantId, tagId);
  if (!after) throw ApiError.notFound(`crm.tag not found: ${tagId}`);
  return after;
}

export async function deleteTag(db: Db, tenantId: string, actor: string, tagId: string): Promise<void> {
  const before = await getTag(db, tenantId, tagId);
  if (!before) throw ApiError.notFound(`crm.tag not found: ${tagId}`);
  await db.deleteFrom('crm_taggables').where('tenant_id', '=', tenantId).where('tag_id', '=', tagId).execute();
  await db.deleteFrom('crm_tags').where('tenant_id', '=', tenantId).where('id', '=', tagId).execute();
  await audit(asCoreDb(db), tenantId, actor, 'crm.tag.deleted', 'crm.tag', tagId, { before });
}

/** Attach a tag to an entity (idempotent). */
export async function attachTag(
  db: Db,
  tenantId: string,
  actor: string,
  tagId: string,
  entityType: string,
  entityId: string,
): Promise<CrmTaggableRow> {
  const tag = await getTag(db, tenantId, tagId);
  if (!tag) throw ApiError.notFound(`crm.tag not found: ${tagId}`);
  await assertEntityExists(db, tenantId, entityType, entityId);
  const existing = await db
    .selectFrom('crm_taggables')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('tag_id', '=', tagId)
    .where('entity_type', '=', entityType)
    .where('entity_id', '=', entityId)
    .executeTakeFirst();
  if (existing) return existing;
  const row: CrmTaggableRow = {
    id: id(),
    tenant_id: tenantId,
    tag_id: tagId,
    entity_type: entityType,
    entity_id: entityId,
    created_at: nowIso(),
  };
  await db.insertInto('crm_taggables').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'crm.tag.attached', 'crm.tag', tagId, {
    entityType,
    entityId,
  });
  await addTimelineEvent(db, tenantId, entityType, entityId, 'tag_attached', actor, {
    tagId,
    name: tag.name,
  });
  return row;
}

export async function detachTag(
  db: Db,
  tenantId: string,
  actor: string,
  tagId: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  const result = await db
    .deleteFrom('crm_taggables')
    .where('tenant_id', '=', tenantId)
    .where('tag_id', '=', tagId)
    .where('entity_type', '=', entityType)
    .where('entity_id', '=', entityId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) {
    throw ApiError.notFound(`tag ${tagId} is not attached to ${entityType}:${entityId}`);
  }
  await audit(asCoreDb(db), tenantId, actor, 'crm.tag.detached', 'crm.tag', tagId, {
    entityType,
    entityId,
  });
}

/** Tags attached to one entity (join inside our own module is allowed). */
export async function listEntityTags(
  db: Db,
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<CrmTagRow[]> {
  return db
    .selectFrom('crm_taggables')
    .innerJoin('crm_tags', 'crm_tags.id', 'crm_taggables.tag_id')
    .selectAll('crm_tags')
    .where('crm_taggables.tenant_id', '=', tenantId)
    .where('crm_tags.tenant_id', '=', tenantId)
    .where('crm_taggables.entity_type', '=', entityType)
    .where('crm_taggables.entity_id', '=', entityId)
    .orderBy('crm_tags.name')
    .orderBy('crm_tags.id')
    .execute();
}

/* ------------------------------------------------------------------ *
 * Attachment references (file itself lives in the files module)
 * ------------------------------------------------------------------ */

export async function createAttachment(
  db: Db,
  tenantId: string,
  actor: string,
  input: {
    entity_type: string;
    entity_id: string;
    file_id: string;
    filename: string;
    mime_type?: string | null;
    size_bytes?: number | null;
  },
): Promise<CrmAttachmentRow> {
  await assertEntityExists(db, tenantId, input.entity_type, input.entity_id);
  const row: CrmAttachmentRow = {
    id: id(),
    tenant_id: tenantId,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    file_id: input.file_id,
    filename: input.filename,
    mime_type: nn(input.mime_type),
    size_bytes: nn(input.size_bytes),
    created_at: nowIso(),
  };
  await db.insertInto('crm_attachments').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'crm.attachment.created', 'crm.attachment', row.id, {
    after: input,
  });
  await addTimelineEvent(db, tenantId, input.entity_type, input.entity_id, 'attachment_added', actor, {
    attachmentId: row.id,
    filename: row.filename,
  });
  return row;
}

export async function getAttachment(
  db: Db,
  tenantId: string,
  attachmentId: string,
): Promise<CrmAttachmentRow | undefined> {
  return db
    .selectFrom('crm_attachments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', attachmentId)
    .executeTakeFirst();
}

export async function listAttachments(
  db: Db,
  tenantId: string,
  params: ListParams,
): Promise<CrmAttachmentRow[]> {
  let qb = db.selectFrom('crm_attachments').selectAll().where('tenant_id', '=', tenantId);
  for (const [column, value] of Object.entries(params.filters ?? {})) {
    qb = qb.where(column as 'entity_type' | 'entity_id', '=', value);
  }
  const q = params.q?.trim();
  if (q) qb = qb.where((eb) => eb(eb.fn('lower', ['filename']), 'like', `%${q.toLowerCase()}%`));
  const sort = params.sort ?? { column: 'created_at' as const, direction: 'desc' as const };
  return qb
    .orderBy(sort.column as 'created_at', sort.direction)
    .orderBy('id')
    .limit(params.page.limit)
    .offset(params.page.offset)
    .execute();
}

export async function updateAttachment(
  db: Db,
  tenantId: string,
  actor: string,
  attachmentId: string,
  patch: { filename?: string },
): Promise<CrmAttachmentRow> {
  const before = await getAttachment(db, tenantId, attachmentId);
  if (!before) throw ApiError.notFound(`crm.attachment not found: ${attachmentId}`);
  if (patch.filename !== undefined) {
    if (!patch.filename.trim()) throw ApiError.badRequest('filename cannot be blank');
    await db
      .updateTable('crm_attachments')
      .set({ filename: patch.filename.trim() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', attachmentId)
      .execute();
    await audit(asCoreDb(db), tenantId, actor, 'crm.attachment.updated', 'crm.attachment', attachmentId, {
      changed: { filename: { from: before.filename, to: patch.filename.trim() } },
    });
  }
  const after = await getAttachment(db, tenantId, attachmentId);
  if (!after) throw ApiError.notFound(`crm.attachment not found: ${attachmentId}`);
  return after;
}

export async function deleteAttachment(
  db: Db,
  tenantId: string,
  actor: string,
  attachmentId: string,
): Promise<void> {
  const before = await getAttachment(db, tenantId, attachmentId);
  if (!before) throw ApiError.notFound(`crm.attachment not found: ${attachmentId}`);
  await db
    .deleteFrom('crm_attachments')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', attachmentId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'crm.attachment.deleted', 'crm.attachment', attachmentId, {
    before,
  });
}

/* ------------------------------------------------------------------ *
 * Source attributions
 * ------------------------------------------------------------------ */

export async function createSourceAttribution(
  db: Db,
  tenantId: string,
  actor: string,
  input: {
    entity_type: string;
    entity_id: string;
    source: string;
    medium?: string | null;
    campaign?: string | null;
    detail?: string | null;
  },
): Promise<CrmSourceAttributionRow> {
  await assertEntityExists(db, tenantId, input.entity_type, input.entity_id);
  if (!input.source.trim()) throw ApiError.badRequest('source is required');
  const row: CrmSourceAttributionRow = {
    id: id(),
    tenant_id: tenantId,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    source: input.source.trim(),
    medium: nn(input.medium),
    campaign: nn(input.campaign),
    detail: nn(input.detail),
    created_at: nowIso(),
  };
  await db.insertInto('crm_source_attributions').values(row).execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'crm.source_attribution.created',
    'crm.source_attribution',
    row.id,
    { after: input },
  );
  return row;
}

export async function getSourceAttribution(
  db: Db,
  tenantId: string,
  attributionId: string,
): Promise<CrmSourceAttributionRow | undefined> {
  return db
    .selectFrom('crm_source_attributions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', attributionId)
    .executeTakeFirst();
}

export async function listSourceAttributions(
  db: Db,
  tenantId: string,
  params: ListParams,
): Promise<CrmSourceAttributionRow[]> {
  let qb = db.selectFrom('crm_source_attributions').selectAll().where('tenant_id', '=', tenantId);
  for (const [column, value] of Object.entries(params.filters ?? {})) {
    qb = qb.where(column as 'entity_type' | 'entity_id' | 'source', '=', value);
  }
  const q = params.q?.trim();
  if (q) {
    const needle = `%${q.toLowerCase()}%`;
    qb = qb.where((eb) =>
      eb.or([
        eb(eb.fn('lower', ['source']), 'like', needle),
        eb(eb.fn('lower', ['campaign']), 'like', needle),
      ]),
    );
  }
  const sort = params.sort ?? { column: 'created_at' as const, direction: 'desc' as const };
  return qb
    .orderBy(sort.column as 'created_at', sort.direction)
    .orderBy('id')
    .limit(params.page.limit)
    .offset(params.page.offset)
    .execute();
}

export async function updateSourceAttribution(
  db: Db,
  tenantId: string,
  actor: string,
  attributionId: string,
  patch: { source?: string; medium?: string | null; campaign?: string | null; detail?: string | null },
): Promise<CrmSourceAttributionRow> {
  const before = await getSourceAttribution(db, tenantId, attributionId);
  if (!before) throw ApiError.notFound(`crm.source_attribution not found: ${attributionId}`);
  const set: Record<string, unknown> = {};
  if (patch.source !== undefined) {
    if (!patch.source.trim()) throw ApiError.badRequest('source cannot be blank');
    set.source = patch.source.trim();
  }
  for (const k of ['medium', 'campaign', 'detail'] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  if (Object.keys(set).length > 0) {
    await db
      .updateTable('crm_source_attributions')
      .set(set as never)
      .where('tenant_id', '=', tenantId)
      .where('id', '=', attributionId)
      .execute();
    await audit(
      asCoreDb(db),
      tenantId,
      actor,
      'crm.source_attribution.updated',
      'crm.source_attribution',
      attributionId,
      { fields: Object.keys(set) },
    );
  }
  const after = await getSourceAttribution(db, tenantId, attributionId);
  if (!after) throw ApiError.notFound(`crm.source_attribution not found: ${attributionId}`);
  return after;
}

export async function deleteSourceAttribution(
  db: Db,
  tenantId: string,
  actor: string,
  attributionId: string,
): Promise<void> {
  const before = await getSourceAttribution(db, tenantId, attributionId);
  if (!before) throw ApiError.notFound(`crm.source_attribution not found: ${attributionId}`);
  await db
    .deleteFrom('crm_source_attributions')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', attributionId)
    .execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'crm.source_attribution.deleted',
    'crm.source_attribution',
    attributionId,
    { before },
  );
}

/* ------------------------------------------------------------------ *
 * CSV import/export (customers, contacts, leads)
 * ------------------------------------------------------------------ */

export type CsvKind = 'customers' | 'contacts' | 'leads';

export const CSV_COLUMNS: Record<CsvKind, readonly string[]> = {
  customers: ['id', 'name', 'email', 'phone', 'address', 'status', 'company_id', 'owner_user_id', 'created_at'],
  contacts: [
    'id',
    'first_name',
    'last_name',
    'email',
    'phone',
    'title',
    'customer_id',
    'company_id',
    'owner_user_id',
    'created_at',
  ],
  leads: [
    'id',
    'name',
    'email',
    'phone',
    'source',
    'stage',
    'value_cents',
    'customer_id',
    'contact_id',
    'company_id',
    'owner_user_id',
    'created_at',
  ],
};

const CSV_TABLE: Record<CsvKind, 'crm_customers' | 'crm_contacts' | 'crm_leads'> = {
  customers: 'crm_customers',
  contacts: 'crm_contacts',
  leads: 'crm_leads',
};

export async function exportCsv(db: Db, tenantId: string, kind: CsvKind): Promise<string> {
  const rows = await anyDb(db)
    .selectFrom(CSV_TABLE[kind])
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return serializeCsv(rows as Record<string, unknown>[], CSV_COLUMNS[kind]);
}

/** Columns accepted on import (id/created_at are generated, never imported). */
const IMPORTABLE: Record<CsvKind, readonly string[]> = {
  customers: ['name', 'email', 'phone', 'address', 'status', 'company_id', 'owner_user_id'],
  contacts: ['first_name', 'last_name', 'email', 'phone', 'title', 'customer_id', 'company_id', 'owner_user_id'],
  leads: [
    'name',
    'email',
    'phone',
    'source',
    'stage',
    'value_cents',
    'customer_id',
    'contact_id',
    'company_id',
    'owner_user_id',
  ],
};

/**
 * Header-mapped CSV import. Headers are normalized (trimmed, lowercased,
 * spaces -> underscores); unknown headers are ignored; blank cells are
 * treated as absent. Invalid rows are skipped and reported.
 */
export async function importCsv(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  kind: CsvKind,
  text: string,
): Promise<ImportResult> {
  let records: Record<string, string>[];
  try {
    records = parseCsv(text);
  } catch (err) {
    throw ApiError.badRequest(`invalid CSV: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result: ImportResult = { imported: 0, ids: [], errors: [] };
  const allowed = IMPORTABLE[kind];
  for (let i = 0; i < records.length; i += 1) {
    const rowNumber = i + 2; // header is row 1
    const raw = records[i];
    const input: Record<string, unknown> = {};
    for (const [header, value] of Object.entries(raw)) {
      const key = header.trim().toLowerCase().replace(/\s+/g, '_');
      if (!allowed.includes(key)) continue;
      if (value === '') continue;
      input[key] = key === 'value_cents' ? Number(value) : value;
    }
    if (input.value_cents !== undefined && !Number.isInteger(input.value_cents)) {
      result.errors.push({ row: rowNumber, message: 'value_cents must be an integer' });
      continue;
    }
    try {
      let created: { id: string };
      if (kind === 'customers') {
        created = await createCustomer(db, events, tenantId, actor, input as CustomerInput);
      } else if (kind === 'contacts') {
        created = await createContact(db, events, tenantId, actor, input as ContactInput);
      } else {
        created = await createLead(db, events, tenantId, actor, input as LeadInput);
      }
      result.imported += 1;
      result.ids.push(created.id);
    } catch (err) {
      result.errors.push({
        row: rowNumber,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
