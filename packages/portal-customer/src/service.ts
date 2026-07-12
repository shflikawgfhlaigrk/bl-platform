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
import { DateTime } from 'luxon';
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
}

export type QuoteDecision = 'approved' | 'declined';

export interface QuoteApprovalEventInput {
  tenantId: string;
  quoteId: string;
  customerId: string;
  decision: QuoteDecision;
  comment?: string;
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
  dueAt?: string | null;
}

export interface PortalInvoicesProvider {
  listForCustomer(tenantId: string, customerId: string): Promise<PortalInvoice[]>;
  getForCustomer(tenantId: string, customerId: string, invoiceId: string): Promise<PortalInvoice | undefined>;
}

/** Payment-intent placeholder returned by the billing provider interface. */
export interface PaymentIntentStub {
  id: string;
  provider: string;
  invoiceId: string;
  amountCents: number;
  currency: string;
  status: 'requires_payment_method';
  clientSecret: string;
}

export interface PortalPaymentProvider {
  createPaymentIntent(input: {
    tenantId: string;
    customerId: string;
    invoiceId: string;
    amountCents: number;
  }): Promise<PaymentIntentStub>;
}

export interface PortalFileRegistration {
  tenantId: string;
  customerId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  kind: PortalUploadKind;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

/** Registers upload metadata with the files module; returns the file id. */
export interface PortalFilesProvider {
  registerUpload(input: PortalFileRegistration): Promise<{ id: string }>;
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
): Promise<{ quote: PortalQuote; approvalEventId: string }> {
  if (!quotes) throw notWired('quotes');
  const quote = await quotes.getForCustomer(tenantId, account.customer_id, quoteId);
  if (!quote) throw ApiError.notFound(`quote not found: ${quoteId}`);
  const { id: approvalEventId } = await quotes.recordApprovalEvent({
    tenantId,
    quoteId,
    customerId: account.customer_id,
    decision,
    comment,
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
  return { quote, approvalEventId };
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
): Promise<PaymentIntentStub> {
  if (!invoices) throw notWired('invoices');
  const invoice = await invoices.getForCustomer(tenantId, account.customer_id, invoiceId);
  if (!invoice) throw ApiError.notFound(`invoice not found: ${invoiceId}`);
  if (invoice.balanceCents <= 0) {
    throw ApiError.badRequest('invoice has no outstanding balance');
  }
  const provider = payments ?? stubPaymentProvider();
  const intent = await provider.createPaymentIntent({
    tenantId,
    customerId: account.customer_id,
    invoiceId,
    amountCents: invoice.balanceCents,
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
    kind: PortalUploadKind;
    relatedEntityType?: string;
    relatedEntityId?: string;
  },
): Promise<PortalCustomerUploadRow> {
  let fileId: string | null = null;
  if (files) {
    const registered = await files.registerUpload({
      tenantId,
      customerId: account.customer_id,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      kind: input.kind,
      relatedEntityType: input.relatedEntityType,
      relatedEntityId: input.relatedEntityId,
    });
    fileId = registered.id;
  }
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
