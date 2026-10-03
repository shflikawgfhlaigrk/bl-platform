import type { Kysely } from 'kysely';
import { ApiError, type Contracts, type EventBus } from '@blacklabel/core';
import { ENTITY_DEFS, getEntity, listEntities, updateLead, type CrmDatabase } from '@blacklabel/crm';
import { createSchedulingContext, listAppointments, getAppointment, getCalendar, type SchedulingDatabase, type SchedulingRouterOptions } from '@blacklabel/scheduling';
import { getQuote, listQuotes, approveQuote, declineQuote, quotePayloadHash, type QuotingDatabase, type QuoteWithDetails } from '@blacklabel/quoting';
import { listInvoices, getInvoice, getCollectionPlan, setCollectionPlan, createPaymentIntent, defaultPaymentProviders, type BillingDatabase, type BillingRouterOptions, type InvoiceDto } from '@blacklabel/billing';
import { listRequests, getRequestLink, type ReviewsDatabase } from '@blacklabel/reviews';
import { initUpload, completeUpload, attachLink, listFiles, getFileOrThrow, readFileContent, SYSTEM_ACTOR, type FilesDatabase, type StorageProvider } from '@blacklabel/files';
import { getAccount, type PortalCustomerProviders, type PortalQuote, type PortalCustomerDatabase } from '@blacklabel/portal-customer';
import type { WorkflowEngineOptions } from '@blacklabel/workflows';
import { authenticateEmployeeToken, getAssignmentForActor, addJobPhoto, listJobPhotos, type PortalEmployeeDatabase } from '@blacklabel/portal-employee';

const pageSize = 200;
export const isBusinessPortalRoute = (url: string) => /^\/api\/portal-customer\/(?:auth\/(?:request-link|exchange|logout)|me(?:\/.*)?|ui(?:\/.*)?)$/.test(url)
  || /^\/api\/portal-employee\/portal(?:\/.*)?$/.test(url)
  || /^\/api\/reviews\/public\/requests\/[^/]+(?:\/(?:submit|opt-out))?$/.test(url);
async function collect<T>(load: (page: { limit: number; offset: number }) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const rows = await load({ limit: pageSize, offset }); all.push(...rows);
    if (rows.length < pageSize) return all;
  }
}
const visibleQuote = (status: string) => status !== 'draft';
const quoteView = ({ quote, lines }: QuoteWithDetails): PortalQuote => ({ id: quote.id, customerId: quote.customer_id,
  status: quote.status, totalCents: quote.total_cents, title: quote.title, expiresAt: quote.valid_until,
  notes: quote.notes, subtotalCents: quote.subtotal_cents, discountCents: quote.discount_cents, taxCents: quote.tax_cents,
  revisionNumber: quote.revision_number, payloadHash: quotePayloadHash(quote, lines),
  lines: lines.map((line) => ({ description: line.description, quantity: line.quantity, unitPriceCents: line.effective_unit_price_cents, totalCents: line.total_cents })) });
const invoiceView = async (db: Kysely<BillingDatabase>, tenantId: string, invoice: InvoiceDto) => {
  const collection = await getCollectionPlan(db, tenantId, invoice.id);
  return { id: invoice.id, customerId: invoice.customer_id, status: invoice.status, totalCents: invoice.total_cents,
    balanceCents: collection.balanceCents, depositRemainingCents: collection.depositRemainingCents, depositDueAt: collection.plan?.deposit_due_at ?? null, remindersOptedOut: !!collection.plan?.opted_out,
    dueAt: collection.plan?.balance_due_at ?? invoice.due_at };
};

/** Cross-module bindings live at composition; each module retains its own tenant-scoped storage. */
export function businessPortalProviders(db: Kysely<any>, events: EventBus, contracts: Contracts, storage: StorageProvider,
  scheduling: SchedulingRouterOptions = {}, billing: BillingRouterOptions = {}): PortalCustomerProviders {
  const schedulingCtx = createSchedulingContext({ db: db as Kysely<SchedulingDatabase>, events, ...scheduling });
  const quotingCtx = (tenantId: string, actor = 'system') => ({ db: db as Kysely<QuotingDatabase>, events, contracts, tenantId, actor });
  const customerQuote = async (tenantId: string, customerId: string, quoteId: string) => {
    try {
      const quote = await getQuote(quotingCtx(tenantId), quoteId);
      return quote.quote.customer_id === customerId && visibleQuote(quote.quote.status) ? quoteView(quote) : undefined;
    } catch (error) { if (error instanceof ApiError && error.status === 404) return undefined; throw error; }
  };
  const customerInvoice = async (tenantId: string, customerId: string, invoiceId: string) => {
    const result = await getInvoice(db as Kysely<BillingDatabase>, tenantId, invoiceId);
    return result?.invoice.customer_id === customerId && result.invoice.portal_visible && result.invoice.status !== 'draft' ? invoiceView(db as Kysely<BillingDatabase>, tenantId, result.invoice) : undefined;
  };
  // An explicit portal.customer link is a sharing decision. A CRM link alone never exposes an internal file.
  const customerFiles = (tenantId: string, customerId: string) => collect((page) => listFiles(db as Kysely<FilesDatabase>, tenantId,
    SYSTEM_ACTOR, { entity_type: 'portal.customer', entity_id: customerId }, page, { column: 'created_at', direction: 'desc' }));
  return {
    appointments: { listForCustomer: async (tenantId, customerId) => Promise.all((await collect((page) => listAppointments(schedulingCtx, tenantId, { customerId }, page)))
      .map(async (row) => ({ id: row.id, startsAt: row.starts_at, endsAt: row.ends_at, status: row.status, title: row.title,
        timezone: (await getCalendar(schedulingCtx, tenantId, row.calendar_id)).timezone, serviceKey: row.appointment_type_id }))) },
    quotes: {
      listForCustomer: async (tenantId, customerId) => {
        const rows = await collect((page) => listQuotes(quotingCtx(tenantId), { page, filters: { customer_id: customerId } }));
        return Promise.all(rows.filter((row) => visibleQuote(row.status)).map(async (row) => quoteView(await getQuote(quotingCtx(tenantId), row.id))));
      },
      getForCustomer: customerQuote,
      recordApprovalEvent: async (input) => {
        if (!await customerQuote(input.tenantId, input.customerId, input.quoteId)) throw ApiError.notFound('quote not found');
        const account = await getAccount(db as Kysely<PortalCustomerDatabase>, input.tenantId, input.actor.replace(/^portal:/, ''));
        if (!account || account.customer_id !== input.customerId) throw ApiError.notFound('portal account not found');
        const ctx = quotingCtx(input.tenantId, input.actor);
        const result = input.decision === 'approved' ? await approveQuote(ctx, input.quoteId, { signerName: account.name, note: input.comment, expectedPayloadHash: input.expectedPayloadHash })
          : await declineQuote(ctx, input.quoteId, { signerName: account.name, note: input.comment, expectedPayloadHash: input.expectedPayloadHash });
        const approval = result.approvalEvents.filter((event) => event.event_type === input.decision).at(-1);
        if (!approval || result.quote.status !== input.decision) throw ApiError.conflict('quote decision readback did not match');
        return { id: approval.id };
      },
    },
    invoices: { listForCustomer: async (tenantId, customerId) => Promise.all((await collect((page) => listInvoices(db as Kysely<BillingDatabase>, tenantId,
      page, { customer_id: customerId, portal_visible: 'true' }))).filter((row) => row.status !== 'draft').map(row => invoiceView(db as Kysely<BillingDatabase>, tenantId, row))), getForCustomer: customerInvoice,
      setReminderOptOut: async (tenantId, customerId, invoiceId, optedOut) => {
        if (!await customerInvoice(tenantId, customerId, invoiceId)) throw ApiError.notFound('Invoice not found.');
        const collection = await getCollectionPlan(db as Kysely<BillingDatabase>, tenantId, invoiceId);
        await setCollectionPlan({ db: db as Kysely<BillingDatabase>, events }, tenantId, `customer:${customerId}`, invoiceId, {
          depositCents: collection.plan?.deposit_cents ?? 0, depositDueAt: collection.plan?.deposit_due_at ?? null,
          balanceDueAt: collection.plan?.balance_due_at ?? null, optedOut });
      } },
    payments: { createPaymentIntent: async (input) => {
      if (!await customerInvoice(input.tenantId, input.customerId, input.invoiceId)) throw ApiError.notFound('invoice not found');
      const registry = new Map((billing.providers ?? defaultPaymentProviders).map((provider) => [provider.key, provider]));
      const result = await createPaymentIntent({ db: db as Kysely<BillingDatabase>, events }, registry, input.tenantId, input.invoiceId, 'manual', input.purpose ?? 'balance');
      if (result.amountCents !== input.amountCents) throw ApiError.conflict('invoice balance changed; reload it before payment');
      return { id: result.intentId, provider: result.provider, invoiceId: input.invoiceId, amountCents: result.amountCents,
        currency: 'usd', status: result.status, clientSecret: result.clientSecret, instructions: result.instructions };
    } },
    jobs: {
      listForCustomer: async (tenantId, customerId) => (await collect((page) => listEntities(db as Kysely<CrmDatabase>, tenantId,
        ENTITY_DEFS.job, { page, filters: { customer_id: customerId } }))).map((row) => ({ id: String(row.id), title: String(row.title), status: String(row.status), updatedAt: String(row.updated_at) })),
      getForCustomer: async (tenantId, customerId, jobId) => {
        const row = await getEntity(db as Kysely<CrmDatabase>, tenantId, ENTITY_DEFS.job, jobId);
        return row?.customer_id === customerId ? { id: String(row.id), title: String(row.title), status: String(row.status), updatedAt: String(row.updated_at) } : undefined;
      },
    },
    reviews: { listPendingForCustomer: async (tenantId, customerId) => {
      const rows = await collect((page) => listRequests(db as Kysely<ReviewsDatabase>, tenantId, { customerId }, page));
      return Promise.all(rows.filter((row) => !['completed', 'opted_out'].includes(row.status)).map(async (row) => ({ id: row.id,
        requestedAt: row.created_at, url: `/review#${(await getRequestLink(db as Kysely<ReviewsDatabase>, tenantId, row.id)).token}` })));
    } },
    files: {
      registerUpload: async (input) => {
        if (input.contentBase64 === undefined) throw ApiError.badRequest('file content is required');
        const content = Buffer.from(input.contentBase64, 'base64');
        if (content.length !== input.sizeBytes || content.length > 10 * 1024 * 1024) throw ApiError.badRequest('file size is invalid');
        // Validate any optional related record before storing bytes or metadata.
        if (input.relatedEntityType || input.relatedEntityId) {
          let owns = false;
          if (input.relatedEntityType === 'crm.customer') owns = input.relatedEntityId === input.customerId;
          if (input.relatedEntityType === 'quoting.quote') owns = !!await customerQuote(input.tenantId, input.customerId, input.relatedEntityId!);
          if (input.relatedEntityType === 'billing.invoice') owns = !!await customerInvoice(input.tenantId, input.customerId, input.relatedEntityId!);
          if (input.relatedEntityType === 'scheduling.appointment') owns = (await getAppointment(schedulingCtx, input.tenantId, input.relatedEntityId!)).customer_id === input.customerId;
          if (input.relatedEntityType === 'crm.job') owns = (await getEntity(db as Kysely<CrmDatabase>, input.tenantId, ENTITY_DEFS.job, input.relatedEntityId!))?.customer_id === input.customerId;
          if (!owns) throw ApiError.notFound('related customer record not found');
        }
        const actor = { userId: `portal-customer:${input.customerId}`, role: null, isSystem: true };
        const session = await initUpload(db as Kysely<FilesDatabase>, input.tenantId, actor, { name: input.fileName, mime: input.contentType, visibility: 'private' });
        const file = await completeUpload(db as Kysely<FilesDatabase>, events, storage, input.tenantId, actor, session.id, content);
        const readback = await readFileContent(storage, file);
        if (!Buffer.from(readback).equals(content)) throw ApiError.conflict('stored file readback differs from the upload');
        for (const entity_type of ['crm.customer', 'portal.customer']) await attachLink(db as Kysely<FilesDatabase>, events, input.tenantId, actor, file.id,
          { entity_type, entity_id: input.customerId });
        if (input.relatedEntityType && input.relatedEntityId) await attachLink(db as Kysely<FilesDatabase>, events, input.tenantId, actor, file.id,
          { entity_type: input.relatedEntityType, entity_id: input.relatedEntityId });
        return { id: file.id };
      },
      listForCustomer: async (tenantId, customerId) => (await customerFiles(tenantId, customerId)).map((file) => ({ id: file.id, name: file.name, mime: file.mime, sizeBytes: file.size_bytes, sha256: file.sha256 })),
      readForCustomer: async (tenantId, customerId, fileId) => {
        if (!(await customerFiles(tenantId, customerId)).some((file) => file.id === fileId)) throw ApiError.notFound('file not found');
        const file = await getFileOrThrow(db as Kysely<FilesDatabase>, tenantId, fileId);
        return { name: file.name, mime: file.mime, content: await readFileContent(storage, file) };
      },
    },
  };
}

export function businessLeadStages(db: Kysely<CrmDatabase>, events: EventBus): NonNullable<WorkflowEngineOptions['leadStages']> {
  return { update: async (input) => {
    const before = await getEntity(db, input.tenantId, ENTITY_DEFS.lead, input.leadId);
    if (!before) throw ApiError.notFound('lead not found');
    if (before.stage !== input.stage) await updateLead(db, events, input.tenantId, input.actor, input.leadId, { stage: input.stage });
    const after = await getEntity(db, input.tenantId, ENTITY_DEFS.lead, input.leadId);
    return { leadId: String(after?.id), stage: String(after?.stage) };
  } };
}

/** Employee files are authorized against the assignment before entering the vault. */
export function businessEmployeeFiles(db: Kysely<any>, events: EventBus, storage: StorageProvider) {
  const employeeDb = db as Kysely<PortalEmployeeDatabase>, fileDb = db as Kysely<FilesDatabase>;
  const actorFor = async (tenantId: string, token: string, assignmentId: string) => {
    const employee = await authenticateEmployeeToken(employeeDb, tenantId, token);
    if (!employee) throw ApiError.unauthorized('Sign in with your team access key.');
    await getAssignmentForActor(employeeDb, tenantId, employee, assignmentId); return employee;
  };
  return {
    upload: async (input: { tenantId: string; token: string; assignmentId: string; name: string; mime: string; contentBase64: string; caption?: string }) => {
      const employee = await actorFor(input.tenantId, input.token, input.assignmentId);
      const bytes = Buffer.from(input.contentBase64, 'base64');
      if (!bytes.length || bytes.length > 10 * 1024 * 1024 || bytes.toString('base64') !== input.contentBase64) throw ApiError.badRequest('Invalid photo size or content.');
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!(input.mime === 'image/jpeg' && jpeg || input.mime === 'image/png' && png || input.mime === 'image/webp' && webp)) throw ApiError.badRequest('Choose a JPEG, PNG or WebP photo.');
      const actor = { userId: `portal-employee:${employee.id}`, role: null, isSystem: true };
      const session = await initUpload(fileDb, input.tenantId, actor, { name: input.name, mime: input.mime, visibility: 'private' });
      const file = await completeUpload(fileDb, events, storage, input.tenantId, actor, session.id, bytes);
      if (!Buffer.from(await readFileContent(storage, file)).equals(bytes)) throw ApiError.conflict('Stored photo readback differs.');
      await attachLink(fileDb, events, input.tenantId, actor, file.id, { entity_type: 'portal_employee.assignment', entity_id: input.assignmentId });
      const photo = await addJobPhoto(employeeDb, input.tenantId, employee, input.assignmentId, { fileId: file.id, caption: input.caption });
      return { photo, sha256: file.sha256, bytes: file.size_bytes };
    },
    read: async (input: { tenantId: string; token: string; assignmentId: string; fileId: string }) => {
      await actorFor(input.tenantId, input.token, input.assignmentId);
      const photos = await listJobPhotos(employeeDb, input.tenantId, input.assignmentId);
      if (!photos.some(photo => photo.file_id === input.fileId)) throw ApiError.notFound('Photo not found in this assignment.');
      const file = await getFileOrThrow(fileDb, input.tenantId, input.fileId);
      // Employee-written/legacy photo rows cannot grant vault access. Require
      // the upload creator and assignment link minted by the file service.
      if (!photos.some(photo => photo.file_id === file.id && file.uploaded_by === `portal-employee:${photo.employee_id}`)) {
        throw ApiError.notFound('Photo not found in this assignment.');
      }
      const link = await fileDb.selectFrom('files_links').select('id')
        .where('tenant_id', '=', input.tenantId).where('file_id', '=', file.id)
        .where('entity_type', '=', 'portal_employee.assignment').where('entity_id', '=', input.assignmentId)
        .executeTakeFirst();
      if (!link) throw ApiError.notFound('Photo not found in this assignment.');
      return { content: await readFileContent(storage, file), mime: file.mime, name: file.name };
    },
  };
}
