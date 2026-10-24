/**
 * portal-customer service layer.
 *
 * Cross-module READS (appointments, quotes, invoices, jobs, review requests)
 * and cross-module WRITES (quote approval events, payment intents, file
 * registration) go through the provider interfaces below. Providers are plain
 * TS interfaces over id strings — apps/api wires implementations backed by
 * the real modules (scheduling, quoting, billing, files, reviews, workflows).
 * This module NEVER touches another module's tables or imports its code.
 * A missing provider degrades to 501 (or a skip where the spec allows it).
 */
import type { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import { DateTime, IANAZone } from 'luxon';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  type Contracts,
  type EventBus,
  type Pagination,
} from '@blacklabel/core';
import type {
  PortalCustomerAccountRow,
  PortalCustomerDatabase,
  PortalCustomerLoginTokenRow,
  PortalCustomerMessageRow,
  PortalCustomerSessionRow,
  PortalCustomerUploadRow,
  PortalCustomerServiceRequestRow,
  PortalServiceRequestKind,
  PortalServiceRequestStatus,
  PortalUploadKind,
} from './schema';

export const LOGIN_TOKEN_TTL_MINUTES = 15;
export const SESSION_TTL_DAYS = 30;

type Db = Kysely<PortalCustomerDatabase>;

/* ------------------------------------------------------------------ *
 * Provider interfaces (this module's cross-module surface)
 * ------------------------------------------------------------------ */

/** A customer-visible appointment, provided by the scheduling module. */
export interface PortalAppointment {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  serviceKey?: string | null;
  notes?: string | null;
  title?: string;
  timezone?: string;
}

export interface PortalAppointmentsProvider {
  /** MUST return only appointments of (tenantId, customerId). */
  listForCustomer(tenantId: string, customerId: string): Promise<PortalAppointment[]>;
}

export interface PortalQuoteLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

/** A customer-visible quote, provided by the quoting module. */
export interface PortalQuote {
  id: string;
  customerId: string;
  status: string;
  totalCents: number;
  title?: string | null;
  expiresAt?: string | null;
  lines?: PortalQuoteLine[];
  notes?: string | null;
  subtotalCents?: number;
  discountCents?: number;
  taxCents?: number;
  revisionNumber?: number;
  /** Exact displayed customer scope; required on decisions when the provider supplies it. */
  payloadHash?: string;
}

export type QuoteDecision = 'approved' | 'declined';

export interface QuoteApprovalEventInput {
  tenantId: string;
  quoteId: string;
  customerId: string;
  decision: QuoteDecision;
  comment?: string;
  expectedPayloadHash?: string;
  /** Who acted, e.g. "portal:<accountId>". */
  actor: string;
}

export interface PortalQuotesProvider {
  listForCustomer(tenantId: string, customerId: string): Promise<PortalQuote[]>;
  /** MUST return undefined when the quote does not belong to (tenantId, customerId). */
  getForCustomer(tenantId: string, customerId: string, quoteId: string): Promise<PortalQuote | undefined>;
  /** Writes an ApprovalEvent through the quoting service; returns its id. */
  recordApprovalEvent(input: QuoteApprovalEventInput): Promise<{ id: string }>;
}

/** A customer-visible invoice, provided by the billing module. */
export interface PortalInvoice {
  id: string;
  customerId: string;
  status: string;
  totalCents: number;
  /** Amount still due, integer cents. */
  balanceCents: number;
  depositRemainingCents?: number;
  depositDueAt?: string | null;
  remindersOptedOut?: boolean;
  dueAt?: string | null;
}

export interface PortalInvoicesProvider {
  listForCustomer(tenantId: string, customerId: string): Promise<PortalInvoice[]>;
  getForCustomer(tenantId: string, customerId: string, invoiceId: string): Promise<PortalInvoice | undefined>;
  setReminderOptOut?(tenantId: string, customerId: string, invoiceId: string, optedOut: boolean): Promise<void>;
}

/** Payment-intent placeholder returned by the billing provider interface. */
export interface PaymentIntentStub {
  id: string;
  provider: string;
  invoiceId: string;
  amountCents: number;
  currency: string;
  status: 'requires_payment_method' | 'requires_action' | 'requires_confirmation' | 'succeeded' | 'canceled';
  clientSecret?: string;
  instructions?: string;
}

export interface PortalPaymentProvider {
  createPaymentIntent(input: {
    tenantId: string;
    customerId: string;
    invoiceId: string;
    amountCents: number;
    purpose?: 'deposit' | 'balance';
  }): Promise<PaymentIntentStub>;
}

export interface PortalFileRegistration {
  tenantId: string;
  customerId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  contentBase64?: string;
  kind: PortalUploadKind;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

/** Registers upload metadata with the files module; returns the file id. */
export interface PortalFilesProvider {
  registerUpload(input: PortalFileRegistration): Promise<{ id: string }>;
  listForCustomer?(tenantId: string, customerId: string): Promise<{ id: string; name: string; mime: string; sizeBytes: number; sha256: string }[]>;
  readForCustomer?(tenantId: string, customerId: string, fileId: string): Promise<{ name: string; mime: string; content: Uint8Array }>;
}

/** Customer-visible job/project status (workflows or owning module). */
export interface PortalJobStatus {
  id: string;
  title: string;
  status: string;
  updatedAt?: string | null;
  detail?: string | null;
}

export interface PortalJobsProvider {
  listForCustomer(tenantId: string, customerId: string): Promise<PortalJobStatus[]>;
  getForCustomer?(tenantId: string, customerId: string, jobId: string): Promise<PortalJobStatus | undefined>;
}

/** A pending review request surfaced from the reviews module. */
export interface PortalReviewRequest {
  id: string;
  subject?: string | null;
  requestedAt: string;
  url?: string | null;
}

export interface PortalReviewsProvider {
  listPendingForCustomer(tenantId: string, customerId: string): Promise<PortalReviewRequest[]>;
}

/** Injection bag of optional cross-module providers (wired by apps/api). */
export interface PortalCustomerProviders {
  appointments?: PortalAppointmentsProvider;
  quotes?: PortalQuotesProvider;
  invoices?: PortalInvoicesProvider;
  payments?: PortalPaymentProvider;
  files?: PortalFilesProvider;
  jobs?: PortalJobsProvider;
  reviews?: PortalReviewsProvider;
}

/**
 * Built-in payment-intent placeholder, used when no real billing payment
 * provider is wired (spec: "pay placeholder"). Charges nothing.
 */
export function stubPaymentProvider(): PortalPaymentProvider {
  return {
    async createPaymentIntent(input) {
      return {
        id: `pi_stub_${id()}`,
        provider: 'stub',
        invoiceId: input.invoiceId,
        amountCents: input.amountCents,
        currency: 'usd',
        status: 'requires_payment_method',
        clientSecret: `stub_secret_${id()}`,
      };
    },
  };
}

export function notWired(what: string): ApiError {
  return new ApiError(501, `${what} provider is not wired`, 'not_implemented');
}

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function createAccount(
  db: Db,
  events: EventBus,
  tenantId: string,
  input: { customerId: string; email: string; name: string; phone?: string },
): Promise<PortalCustomerAccountRow> {
  const email = normalizeEmail(input.email);
  const existing = await db
    .selectFrom('portal_customer_accounts')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('email', '=', email)
    .executeTakeFirst();
  if (existing) {
    throw ApiError.conflict(`a portal account already exists for ${email}`);
  }
  const now = nowIso();
  const row: PortalCustomerAccountRow = {
    id: id(),
    tenant_id: tenantId,
    customer_id: input.customerId,
    email,
    name: input.name.trim(),
    phone: input.phone?.trim() || null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('portal_customer_accounts').values(row).execute();
  await audit(asCoreDb(db), tenantId, 'system', 'portal_customer.account.created', 'portal_customer.account', row.id, {
    customerId: row.customer_id,
    email: row.email,
  });
  await events.emit(tenantId, 'portal_customer.account.created', {
    accountId: row.id,
    customerId: row.customer_id,
    email: row.email,
  });
  return row;
}

export async function getAccount(
  db: Db,
  tenantId: string,
  accountId: string,
): Promise<PortalCustomerAccountRow | undefined> {
  return db
    .selectFrom('portal_customer_accounts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', accountId)
    .executeTakeFirst();
}

export async function listAccounts(
  db: Db,
  tenantId: string,
  page: Pagination,
): Promise<PortalCustomerAccountRow[]> {
  return db
    .selectFrom('portal_customer_accounts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function updateContact(
  db: Db,
  events: EventBus,
  tenantId: string,
  accountId: string,
  patch: { name?: string; phone?: string | null; email?: string },
): Promise<PortalCustomerAccountRow> {
  const account = await getAccount(db, tenantId, accountId);
  if (!account) throw ApiError.notFound(`portal account not found: ${accountId}`);

  const set: Partial<Pick<PortalCustomerAccountRow, 'name' | 'phone' | 'email' | 'updated_at'>> = {};
  if (patch.name !== undefined) {
    if (patch.name.trim() === '') throw ApiError.badRequest('name cannot be blank');
    set.name = patch.name.trim();
  }
  if (patch.phone !== undefined) {
    set.phone = patch.phone === null || patch.phone.trim() === '' ? null : patch.phone.trim();
  }
  if (patch.email !== undefined) {
    const email = normalizeEmail(patch.email);
    if (email !== account.email) {
      const taken = await db
        .selectFrom('portal_customer_accounts')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('email', '=', email)
        .executeTakeFirst();
      if (taken) throw ApiError.conflict(`a portal account already exists for ${email}`);
    }
    set.email = email;
  }
  if (Object.keys(set).length === 0) {
    throw ApiError.badRequest('nothing to update');
  }
  set.updated_at = nowIso();
  await db
    .updateTable('portal_customer_accounts')
    .set(set)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', accountId)
    .execute();
  const updated = (await getAccount(db, tenantId, accountId))!;
  const fields = Object.keys(set).filter((k) => k !== 'updated_at');
  await audit(asCoreDb(db), tenantId, accountId, 'portal_customer.contact.updated', 'portal_customer.account', accountId, {
    fields,
  });
  await events.emit(tenantId, 'portal_customer.contact.updated', {
    accountId,
    customerId: updated.customer_id,
    fields,
  });
  return updated;
}

/* ------------------------------------------------------------------ *
 * Auth: magic-token login + sessions (no external auth deps)
 * ------------------------------------------------------------------ */

function newToken(): string {
  // Two nanoids -> 42 chars of URL-safe entropy.
  return `${id()}${id()}`;
}

/**
 * Create a single-use login token for the account behind `email`.
 * Returns undefined when no account matches (callers MUST NOT leak this to
 * the client — respond identically either way to avoid account enumeration).
 */
export async function requestLoginLink(
  db: Db,
  events: EventBus,
  tenantId: string,
  email: string,
): Promise<{ token: string; row: PortalCustomerLoginTokenRow; account: PortalCustomerAccountRow } | undefined> {
  const account = await db
    .selectFrom('portal_customer_accounts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('email', '=', normalizeEmail(email))
    .executeTakeFirst();
  if (!account) return undefined;

  const row: PortalCustomerLoginTokenRow = {
    id: id(),
    tenant_id: tenantId,
    account_id: account.id,
    token: newToken(),
    expires_at: DateTime.utc().plus({ minutes: LOGIN_TOKEN_TTL_MINUTES }).toISO()!,
    used_at: null,
    created_at: nowIso(),
  };
  await db.insertInto('portal_customer_login_tokens').values(row).execute();
  await audit(asCoreDb(db), tenantId, account.id, 'portal_customer.login_link.requested', 'portal_customer.login_token', row.id, {
    expiresAt: row.expires_at,
  });
  await events.emit(tenantId, 'portal_customer.login_link.requested', {
    accountId: account.id,
    tokenId: row.id,
    expiresAt: row.expires_at,
  });
  return { token: row.token, row, account };
}

/**
 * Exchange a single-use login token for a bearer session. 401 on unknown,
 * spent, or expired tokens. Marks the token used atomically so it can never
 * be exchanged twice.
 */
export async function exchangeLoginToken(
  db: Db,
  events: EventBus,
  tenantId: string,
  token: string,
): Promise<{ session: PortalCustomerSessionRow; account: PortalCustomerAccountRow }> {
  const invalid = () => ApiError.unauthorized('invalid or expired login token');
  const row = await db
    .selectFrom('portal_customer_login_tokens')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('token', '=', token)
    .executeTakeFirst();
  if (!row || row.used_at !== null || row.expires_at <= nowIso()) throw invalid();

  // Guarded update: only spends the token if it is still unspent.
  const spent = await db
    .updateTable('portal_customer_login_tokens')
    .set({ used_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', row.id)
    .where('used_at', 'is', null)
    .executeTakeFirst();
  if (spent.numUpdatedRows === 0n) throw invalid();

  const account = await getAccount(db, tenantId, row.account_id);
  if (!account) throw invalid();

  const session: PortalCustomerSessionRow = {
    id: id(),
    tenant_id: tenantId,
    account_id: account.id,
    token: newToken(),
    expires_at: DateTime.utc().plus({ days: SESSION_TTL_DAYS }).toISO()!,
    revoked: 0,
    created_at: nowIso(),
  };
  await db.insertInto('portal_customer_sessions').values(session).execute();
  await audit(asCoreDb(db), tenantId, account.id, 'portal_customer.session.created', 'portal_customer.session', session.id, null);
  await events.emit(tenantId, 'portal_customer.session.created', {
    accountId: account.id,
    sessionId: session.id,
    expiresAt: session.expires_at,
  });
  return { session, account };
}

/**
 * Resolve a session token to its account. Returns undefined for unknown,
 * revoked, expired, or cross-tenant tokens.
 */
export async function authenticateSession(
  db: Db,
  tenantId: string,
  sessionToken: string,
): Promise<PortalCustomerAccountRow | undefined> {
  const session = await db
    .selectFrom('portal_customer_sessions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('token', '=', sessionToken)
    .where('revoked', '=', 0)
    .where('expires_at', '>', nowIso())
    .executeTakeFirst();
  if (!session) return undefined;
  return getAccount(db, tenantId, session.account_id);
}

/** Revoke a session token (idempotent). */
export async function revokeSession(db: Db, tenantId: string, sessionToken: string): Promise<void> {
  await db
    .updateTable('portal_customer_sessions')
    .set({ revoked: 1 })
    .where('tenant_id', '=', tenantId)
    .where('token', '=', sessionToken)
    .execute();
}

/* ------------------------------------------------------------------ *
 * Quotes: view + approve/decline via the quoting provider
 * ------------------------------------------------------------------ */

export async function decideQuote(
  db: Db,
  events: EventBus,
  quotes: PortalQuotesProvider | undefined,
  tenantId: string,
  account: PortalCustomerAccountRow,
  quoteId: string,
  decision: QuoteDecision,
  comment?: string,
  expectedPayloadHash?: string,
): Promise<{ quote: PortalQuote; approvalEventId: string }> {
  if (!quotes) throw notWired('quotes');
  const quote = await quotes.getForCustomer(tenantId, account.customer_id, quoteId);
  if (!quote) throw ApiError.notFound(`quote not found: ${quoteId}`);
  if (quote.payloadHash && !expectedPayloadHash) throw ApiError.badRequest('Review the current quote before deciding; expectedPayloadHash is required.');
  if (quote.payloadHash && expectedPayloadHash !== quote.payloadHash) throw ApiError.conflict('Quote scope changed; reload and review it.');
  const { id: approvalEventId } = await quotes.recordApprovalEvent({
    tenantId,
    quoteId,
    customerId: account.customer_id,
    decision,
    comment,
    expectedPayloadHash,
    actor: `portal:${account.id}`,
  });
  const action = decision === 'approved' ? 'portal_customer.quote.approved' : 'portal_customer.quote.declined';
  await audit(asCoreDb(db), tenantId, account.id, action, 'quoting.quote', quoteId, {
    decision,
    comment: comment ?? null,
    approvalEventId,
  });
  await events.emit(tenantId, action, {
    quoteId,
    customerId: account.customer_id,
    accountId: account.id,
    approvalEventId,
    totalCents: quote.totalCents,
  });
  const updated = await quotes.getForCustomer(tenantId, account.customer_id, quoteId);
  if (!updated) throw ApiError.notFound('quote was removed after the decision');
  return { quote: updated, approvalEventId };
}

/* ------------------------------------------------------------------ *
 * Invoices: view + pay placeholder via the billing provider interface
 * ------------------------------------------------------------------ */

export async function createInvoicePaymentIntent(
  db: Db,
  events: EventBus,
  invoices: PortalInvoicesProvider | undefined,
  payments: PortalPaymentProvider | undefined,
  tenantId: string,
  account: PortalCustomerAccountRow,
  invoiceId: string,
  purpose: 'deposit' | 'balance' = 'balance',
): Promise<PaymentIntentStub> {
  if (!invoices) throw notWired('invoices');
  const invoice = await invoices.getForCustomer(tenantId, account.customer_id, invoiceId);
  if (!invoice) throw ApiError.notFound(`invoice not found: ${invoiceId}`);
  if (invoice.balanceCents <= 0) {
    throw ApiError.badRequest('invoice has no outstanding balance');
  }
  const amountCents = purpose === 'deposit' ? invoice.depositRemainingCents ?? 0 : invoice.balanceCents;
  if (amountCents <= 0) throw ApiError.badRequest('There is no outstanding deposit.');
  if (!payments) throw notWired('payments');
  const provider = payments;
  const intent = await provider.createPaymentIntent({
    tenantId,
    customerId: account.customer_id,
    invoiceId,
    amountCents,
    purpose,
  });
  await audit(asCoreDb(db), tenantId, account.id, 'portal_customer.payment_intent.created', 'billing.invoice', invoiceId, {
    paymentIntentId: intent.id,
    amountCents: intent.amountCents,
    provider: intent.provider,
  });
  await events.emit(tenantId, 'portal_customer.payment_intent.created', {
    invoiceId,
    customerId: account.customer_id,
    accountId: account.id,
    paymentIntentId: intent.id,
    amountCents: intent.amountCents,
  });
  return intent;
}

/* ------------------------------------------------------------------ *
 * Messages: portal -> business (messaging contract relay)
 * ------------------------------------------------------------------ */

export async function sendPortalMessage(
  db: Db,
  events: EventBus,
  contracts: Contracts,
  tenantId: string,
  account: PortalCustomerAccountRow,
  input: { subject?: string; body: string },
): Promise<PortalCustomerMessageRow> {
  let relayedMessageId: string | null = null;
  if (contracts.sendMessage) {
    // Create the conversation/message on the messaging module's side.
    const relayed = await contracts.sendMessage.sendMessage({
      tenantId,
      channel: 'portal',
      to: account.customer_id,
      subject: input.subject,
      body: input.body,
      relatedEntityType: 'portal_customer.account',
      relatedEntityId: account.id,
    });
    relayedMessageId = relayed.id;
  }
  const row: PortalCustomerMessageRow = {
    id: id(),
    tenant_id: tenantId,
    account_id: account.id,
    customer_id: account.customer_id,
    subject: input.subject?.trim() || null,
    body: input.body,
    relayed_message_id: relayedMessageId,
    created_at: nowIso(),
  };
  await db.insertInto('portal_customer_messages').values(row).execute();
  await audit(asCoreDb(db), tenantId, account.id, 'portal_customer.message.sent', 'portal_customer.message', row.id, {
    relayedMessageId,
  });
  await events.emit(tenantId, 'portal_customer.message.sent', {
    messageId: row.id,
    accountId: account.id,
    customerId: account.customer_id,
    relayedMessageId,
  });
  return row;
}

export async function listMessages(
  db: Db,
  tenantId: string,
  accountId: string,
  page: Pagination,
): Promise<PortalCustomerMessageRow[]> {
  return db
    .selectFrom('portal_customer_messages')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('account_id', '=', accountId)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

/* ------------------------------------------------------------------ *
 * Uploads: file/photo metadata (files provider registers the file)
 * ------------------------------------------------------------------ */

export async function recordUpload(
  db: Db,
  events: EventBus,
  files: PortalFilesProvider | undefined,
  tenantId: string,
  account: PortalCustomerAccountRow,
  input: {
    fileName: string;
    contentType: string;
    sizeBytes: number;
    contentBase64?: string;
    kind: PortalUploadKind;
    relatedEntityType?: string;
    relatedEntityId?: string;
  },
): Promise<PortalCustomerUploadRow> {
  if (!files) throw notWired('files');
  if (input.contentBase64 === undefined || input.contentBase64.length % 4 !== 0) {
    throw ApiError.badRequest('file content must be supplied as base64');
  }
  // Canonical round-trip validation is linear and remains safe at the upload
  // limit; a repeated-group regexp over multi-MB base64 overflows V8's stack.
  const content = Buffer.from(input.contentBase64, 'base64');
  if (content.toString('base64') !== input.contentBase64) throw ApiError.badRequest('file content must be supplied as canonical base64');
  if (content.byteLength !== input.sizeBytes) throw ApiError.badRequest('file size does not match its content');
  const registered = await files.registerUpload({
      tenantId,
      customerId: account.customer_id,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      contentBase64: input.contentBase64,
      kind: input.kind,
      relatedEntityType: input.relatedEntityType,
      relatedEntityId: input.relatedEntityId,
  });
  const fileId = registered.id;
  const row: PortalCustomerUploadRow = {
    id: id(),
    tenant_id: tenantId,
    account_id: account.id,
    customer_id: account.customer_id,
    file_id: fileId,
    file_name: input.fileName,
    content_type: input.contentType,
    size_bytes: input.sizeBytes,
    kind: input.kind,
    related_entity_type: input.relatedEntityType ?? null,
    related_entity_id: input.relatedEntityId ?? null,
    created_at: nowIso(),
  };
  await db.insertInto('portal_customer_uploads').values(row).execute();
  await audit(asCoreDb(db), tenantId, account.id, 'portal_customer.upload.created', 'portal_customer.upload', row.id, {
    fileId,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
  });
  await events.emit(tenantId, 'portal_customer.upload.created', {
    uploadId: row.id,
    accountId: account.id,
    customerId: account.customer_id,
    fileId,
    fileName: row.file_name,
  });
  return row;
}

export async function listUploads(
  db: Db,
  tenantId: string,
  accountId: string,
  page: Pagination,
): Promise<PortalCustomerUploadRow[]> {
  return db
    .selectFrom('portal_customer_uploads')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('account_id', '=', accountId)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

/* ---------------- customer requests, with owner-visible receipts ---------------- */

export interface CreatePortalServiceRequestInput {
  kind: PortalServiceRequestKind;
  referenceId: string;
  idempotencyKey: string;
  requestedStartsAt?: string;
  requestedEndsAt?: string;
  timezone?: string;
  note?: string;
}

function requestTime(value: string | undefined, zone: string): string | null {
  if (value === undefined) return null;
  const parsed = DateTime.fromISO(value, { zone });
  if (!parsed.isValid) throw ApiError.badRequest('requested time must be a valid ISO timestamp');
  const wallTime = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value);
  if (wallTime && parsed.toFormat("yyyy-MM-dd'T'HH:mm") !== `${wallTime[1]}T${wallTime[2]}:${wallTime[3]}`) {
    throw ApiError.badRequest('preferred local time does not exist in this timezone; choose another time');
  }
  if (wallTime && parsed.getPossibleOffsets().length > 1) {
    throw ApiError.badRequest('preferred local time occurs twice; supply an explicit UTC offset or choose another time');
  }
  return parsed.toUTC().toISO()!;
}

export async function createServiceRequest(
  db: Db,
  events: EventBus,
  providers: PortalCustomerProviders,
  tenantId: string,
  account: PortalCustomerAccountRow,
  input: CreatePortalServiceRequestInput,
): Promise<{ request: PortalCustomerServiceRequestRow; replayed: boolean }> {
  if (account.tenant_id !== tenantId) throw ApiError.notFound('portal account not found');
  if (!input.referenceId.trim() || !input.idempotencyKey.trim()) throw ApiError.badRequest('reference and request key are required');
  const zone = input.timezone ?? 'UTC';
  if (!IANAZone.isValidZone(zone)) throw ApiError.badRequest('request timezone must be a valid IANA timezone');
  const startsAt = requestTime(input.requestedStartsAt, zone);
  const inputEndsAt = requestTime(input.requestedEndsAt, zone);
  if (input.kind === 'reschedule' && startsAt === null) throw ApiError.badRequest('a reschedule request requires a preferred start time');
  if (inputEndsAt !== null && (startsAt === null || Date.parse(inputEndsAt) <= Date.parse(startsAt))) throw ApiError.badRequest('preferred end must be after preferred start');
  const note = input.note?.trim() || null;
  const hash = createHash('sha256').update(JSON.stringify({ kind: input.kind, referenceId: input.referenceId, startsAt, endsAt: inputEndsAt, timezone: zone, note })).digest('hex');
  const previous = await db.selectFrom('portal_customer_service_requests').selectAll()
    .where('tenant_id', '=', tenantId).where('account_id', '=', account.id).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
  if (previous) {
    if (previous.payload_hash !== hash) throw ApiError.conflict('request key was already used for different details');
    return { request: previous, replayed: true };
  }
  if (startsAt !== null && Date.parse(startsAt) <= Date.now()) throw ApiError.badRequest('preferred start must be in the future');
  // Provider reads precede the module transaction: providers may use the
  // shared DB connection. This is an owner-reviewed request, not a reservation.
  let sourceTitle: string;
  let endsAt = inputEndsAt;
  if (input.kind === 'repeat') {
    if (!providers.jobs) throw notWired('jobs');
    const job = providers.jobs.getForCustomer
      ? await providers.jobs.getForCustomer(tenantId, account.customer_id, input.referenceId)
      : (await providers.jobs.listForCustomer(tenantId, account.customer_id)).find((row) => row.id === input.referenceId);
    if (!job) throw ApiError.notFound('job not found');
    if (job.status !== 'completed') throw ApiError.conflict('repeat service is available after the original job is completed');
    sourceTitle = job.title;
  } else {
    if (!providers.appointments) throw notWired('appointments');
    const appointment = (await providers.appointments.listForCustomer(tenantId, account.customer_id)).find((row) => row.id === input.referenceId);
    if (!appointment) throw ApiError.notFound('appointment not found');
    if (!['requested', 'confirmed'].includes(appointment.status)) throw ApiError.conflict(`cannot request a reschedule for a ${appointment.status} appointment`);
    sourceTitle = appointment.title ?? 'Appointment';
    if (endsAt === null) endsAt = DateTime.fromISO(startsAt!, { zone: 'UTC' }).plus({ milliseconds: Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt) }).toISO();
  }
  const result = await db.transaction().execute(async (tx) => {
    const saved = await tx.selectFrom('portal_customer_service_requests').selectAll()
      .where('tenant_id', '=', tenantId).where('account_id', '=', account.id).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
    if (saved) {
      if (saved.payload_hash !== hash) throw ApiError.conflict('request key was already used for different details');
      return { request: saved, replayed: true };
    }
    // Prevent a refreshed page or second click from opening another pending
    // request for the same work. A changed request needs the owner to review it.
    const open = await tx.selectFrom('portal_customer_service_requests').selectAll()
      .where('tenant_id', '=', tenantId).where('account_id', '=', account.id)
      .where('kind', '=', input.kind).where('reference_id', '=', input.referenceId)
      .where('status', 'in', ['pending', 'acknowledged']).orderBy('created_at').orderBy('id').executeTakeFirst();
    if (open) {
      if (open.payload_hash === hash) return { request: open, replayed: true };
      throw ApiError.conflict('an open request already exists for this work; message the business to change it', { requestId: open.id });
    }
    const now = nowIso();
    const row: PortalCustomerServiceRequestRow = {
      id: id(), tenant_id: tenantId, account_id: account.id, customer_id: account.customer_id,
      kind: input.kind, reference_id: input.referenceId, source_title: sourceTitle,
      requested_starts_at: startsAt, requested_ends_at: endsAt, requested_timezone: zone,
      note, status: 'pending', response: null, version: 1, idempotency_key: input.idempotencyKey,
      payload_hash: hash, created_at: now, updated_at: now,
    };
    await tx.insertInto('portal_customer_service_requests').values(row).execute();
    await audit(asCoreDb(tx), tenantId, `portal:${account.id}`, 'portal_customer.request.created', 'portal_customer.request', row.id, { kind: row.kind, referenceId: row.reference_id });
    return { request: row, replayed: false };
  });
  if (!result.replayed) await events.emit(tenantId, 'portal_customer.request.created', {
    requestId: result.request.id, accountId: account.id, customerId: account.customer_id,
    kind: input.kind, referenceId: input.referenceId,
  });
  return result;
}

export async function listServiceRequests(
  db: Db,
  tenantId: string,
  filter: { accountId?: string; status?: PortalServiceRequestStatus },
  page: Pagination,
): Promise<PortalCustomerServiceRequestRow[]> {
  let query = db.selectFrom('portal_customer_service_requests').selectAll().where('tenant_id', '=', tenantId);
  if (filter.accountId) query = query.where('account_id', '=', filter.accountId);
  if (filter.status) query = query.where('status', '=', filter.status);
  return query.orderBy('created_at', 'desc').orderBy('id').limit(page.limit).offset(page.offset).execute();
}

export async function getServiceRequest(db: Db, tenantId: string, requestId: string): Promise<PortalCustomerServiceRequestRow> {
  const row = await db.selectFrom('portal_customer_service_requests').selectAll().where('tenant_id', '=', tenantId).where('id', '=', requestId).executeTakeFirst();
  if (!row) throw ApiError.notFound('service request not found');
  return row;
}

export async function respondServiceRequest(
  db: Db,
  events: EventBus,
  tenantId: string,
  requestId: string,
  actor: string,
  input: { status: Exclude<PortalServiceRequestStatus, 'pending'>; response?: string; expectedVersion: number },
): Promise<PortalCustomerServiceRequestRow> {
  const response = input.response?.trim() || null;
  if (['resolved', 'declined'].includes(input.status) && response === null) throw ApiError.badRequest('a customer-visible response is required to close a request');
  const updated = await db.transaction().execute(async (tx) => {
    const row = await getServiceRequest(tx, tenantId, requestId);
    if (row.version !== input.expectedVersion) throw ApiError.conflict('request changed; reload before responding');
    if (['resolved', 'declined'].includes(row.status)) throw ApiError.conflict('request is already closed');
    const now = nowIso();
    const next = { status: input.status, response, version: row.version + 1, updated_at: now };
    await tx.updateTable('portal_customer_service_requests').set(next).where('tenant_id', '=', tenantId).where('id', '=', requestId).where('version', '=', row.version).execute();
    await audit(asCoreDb(tx), tenantId, actor, 'portal_customer.request.updated', 'portal_customer.request', requestId, { before: row.status, after: input.status, response });
    return { ...row, ...next };
  });
  await events.emit(tenantId, 'portal_customer.request.updated', { requestId, accountId: updated.account_id, customerId: updated.customer_id, status: updated.status });
  return updated;
}
