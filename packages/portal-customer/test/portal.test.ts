import { describe, expect, it } from 'vitest';
import { asCoreDb, listAuditEntries, type SendMessageInput } from '@blacklabel/core';
import type { PaymentIntentStub, PortalInvoice, PortalQuote } from '@blacklabel/portal-customer';
import {
  api,
  capture,
  createAccountViaApi,
  login,
  makeAppointmentsProvider,
  makeInvoicesProvider,
  makeQuotesProvider,
  setup,
} from './helpers';

describe('accounts', () => {
  it('POST /accounts creates an account, audits it and emits portal_customer.account.created', async () => {
    const ctx = await setup();
    const events = capture(ctx.events, 'portal_customer.account.created');
    const res = await api(ctx.app, ctx.tenantA, 'POST', '/accounts', {
      customerId: 'cust_1',
      email: 'Ada@Example.com',
      name: 'Ada',
      phone: '+1 555 0100',
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as any;
    expect(data.email).toBe('ada@example.com'); // normalized
    expect(data.customerId).toBe('cust_1');

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ accountId: data.id, customerId: 'cust_1' });

    const audits = await listAuditEntries(asCoreDb(ctx.db), ctx.tenantA, 'portal_customer.account', data.id);
    expect(audits.map((a) => a.action)).toContain('portal_customer.account.created');
  });

  it('rejects a duplicate email per tenant with 409 and invalid bodies with 400', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'dup@example.com' });
    const dup = await api(ctx.app, ctx.tenantA, 'POST', '/accounts', {
      customerId: 'c2',
      email: 'dup@example.com',
      name: 'Other',
    });
    expect(dup.status).toBe(409);
    const bad = await api(ctx.app, ctx.tenantA, 'POST', '/accounts', { email: 'x@example.com' });
    expect(bad.status).toBe(400);
  });
});

describe('contact self-management', () => {
  it('PATCH /me/contact updates own info, audits and emits portal_customer.contact.updated', async () => {
    const ctx = await setup();
    const events = capture(ctx.events, 'portal_customer.contact.updated');
    const account = await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');

    const res = await api(ctx.app, ctx.tenantA, 'PATCH', '/me/contact', {
      name: 'Ada Alvarez',
      phone: '+1 555 0199',
    }, session);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    expect(data.name).toBe('Ada Alvarez');
    expect(data.phone).toBe('+1 555 0199');

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ accountId: account.id });
    expect((events[0].payload as any).fields.sort()).toEqual(['name', 'phone']);

    const audits = await listAuditEntries(asCoreDb(ctx.db), ctx.tenantA, 'portal_customer.account', account.id);
    const entry = audits.find((a) => a.action === 'portal_customer.contact.updated');
    expect(entry).toBeTruthy();
    // The customer acted on their own behalf.
    expect(entry!.actor).toBe(account.id);
  });

  it('rejects a contact email change that collides with another account (409) and empty patches (400)', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'taken@example.com' });
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');

    const conflict = await api(ctx.app, ctx.tenantA, 'PATCH', '/me/contact', { email: 'taken@example.com' }, session);
    expect(conflict.status).toBe(409);
    const empty = await api(ctx.app, ctx.tenantA, 'PATCH', '/me/contact', {}, session);
    expect(empty.status).toBe(400);
  });
});

describe('appointments (scheduling provider)', () => {
  it('returns only the session customer’s appointments; the customer id comes from the session, never the client', async () => {
    const seed: Array<{ tenantId: string; customerId: string; appointment: any }> = [];
    const appts = makeAppointmentsProvider(seed);
    const ctx = await setup({ providers: { appointments: appts.provider } });
    seed.push(
      {
        tenantId: ctx.tenantA,
        customerId: 'cust_ada',
        appointment: { id: 'appt1', startsAt: '2026-07-11T15:00:00.000Z', endsAt: '2026-07-11T16:00:00.000Z', status: 'scheduled' },
      },
      {
        tenantId: ctx.tenantA,
        customerId: 'cust_other',
        appointment: { id: 'appt2', startsAt: '2026-07-12T15:00:00.000Z', endsAt: '2026-07-12T16:00:00.000Z', status: 'scheduled' },
      },
    );
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com', customerId: 'cust_ada' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');

    // A client-supplied customerId query param must be ignored.
    const res = await api(ctx.app, ctx.tenantA, 'GET', '/me/appointments?customerId=cust_other', undefined, session);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    expect(data.map((a: any) => a.id)).toEqual(['appt1']);
    expect(appts.calls).toEqual([{ tenantId: ctx.tenantA, customerId: 'cust_ada' }]);
  });

  it('returns 501 when no appointments provider is wired', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');
    const res = await api(ctx.app, ctx.tenantA, 'GET', '/me/appointments', undefined, session);
    expect(res.status).toBe(501);
    expect(((await res.json()) as any).error.code).toBe('not_implemented');
  });
});

describe('quotes (quoting provider)', () => {
  async function quoteSetup() {
    const seed: Array<{ tenantId: string; quote: PortalQuote }> = [];
    const provider = makeQuotesProvider(seed);
    const ctx = await setup({ providers: { quotes: provider.provider } });
    seed.push(
      { tenantId: ctx.tenantA, quote: { id: 'q1', customerId: 'cust_ada', status: 'pending', totalCents: 12550, title: 'Spring service' } },
      { tenantId: ctx.tenantA, quote: { id: 'q2', customerId: 'cust_other', status: 'pending', totalCents: 99999 } },
    );
    const account = await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com', customerId: 'cust_ada' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');
    return { ctx, provider, session, account };
  }

  it('lists and fetches only the session customer’s quotes; foreign quote ids get 404', async () => {
    const { ctx, session } = await quoteSetup();
    const list = await api(ctx.app, ctx.tenantA, 'GET', '/me/quotes', undefined, session);
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).data.map((q: any) => q.id)).toEqual(['q1']);

    const own = await api(ctx.app, ctx.tenantA, 'GET', '/me/quotes/q1', undefined, session);
    expect(own.status).toBe(200);
    expect(((await own.json()) as any).data.totalCents).toBe(12550);

    const foreign = await api(ctx.app, ctx.tenantA, 'GET', '/me/quotes/q2', undefined, session);
    expect(foreign.status).toBe(404);
  });

  it('approve records an ApprovalEvent via the quoting service and emits portal_customer.quote.approved', async () => {
    const { ctx, provider, session, account } = await quoteSetup();
    const events = capture(ctx.events, 'portal_customer.quote.approved');

    const res = await api(ctx.app, ctx.tenantA, 'POST', '/me/quotes/q1/approve', { comment: 'Looks great' }, session);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    expect(data).toMatchObject({ quoteId: 'q1', decision: 'approved', approvalEventId: 'approval_1' });

    expect(provider.approvalCalls).toHaveLength(1);
    expect(provider.approvalCalls[0]).toMatchObject({
      tenantId: ctx.tenantA,
      quoteId: 'q1',
      customerId: 'cust_ada',
      decision: 'approved',
      comment: 'Looks great',
      actor: `portal:${account.id}`,
    });

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      quoteId: 'q1',
      customerId: 'cust_ada',
      approvalEventId: 'approval_1',
      totalCents: 12550,
    });

    const audits = await listAuditEntries(asCoreDb(ctx.db), ctx.tenantA, 'quoting.quote', 'q1');
    expect(audits.map((a) => a.action)).toContain('portal_customer.quote.approved');
  });

  it('decline records the declined decision and emits portal_customer.quote.declined', async () => {
    const { ctx, provider, session } = await quoteSetup();
    const events = capture(ctx.events, 'portal_customer.quote.declined');
    const res = await api(ctx.app, ctx.tenantA, 'POST', '/me/quotes/q1/decline', { comment: 'Too pricey' }, session);
    expect(res.status).toBe(200);
    expect(provider.approvalCalls[0]).toMatchObject({ decision: 'declined', comment: 'Too pricey' });
    expect(events).toHaveLength(1);
  });

  it('returns 501 for quote routes when no quoting provider is wired', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');
    expect((await api(ctx.app, ctx.tenantA, 'GET', '/me/quotes', undefined, session)).status).toBe(501);
    expect((await api(ctx.app, ctx.tenantA, 'POST', '/me/quotes/q1/approve', {}, session)).status).toBe(501);
  });
});

describe('invoices + pay placeholder (billing provider interface)', () => {
  async function invoiceSetup(payments?: { createPaymentIntent(input: any): Promise<PaymentIntentStub> }) {
    const seed: Array<{ tenantId: string; invoice: PortalInvoice }> = [];
    const invoices = makeInvoicesProvider(seed);
    const ctx = await setup({ providers: { invoices, payments } });
    seed.push(
      { tenantId: ctx.tenantA, invoice: { id: 'inv1', customerId: 'cust_ada', status: 'open', totalCents: 45000, balanceCents: 30000 } },
      { tenantId: ctx.tenantA, invoice: { id: 'inv2', customerId: 'cust_ada', status: 'paid', totalCents: 10000, balanceCents: 0 } },
      { tenantId: ctx.tenantA, invoice: { id: 'inv3', customerId: 'cust_other', status: 'open', totalCents: 5000, balanceCents: 5000 } },
    );
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com', customerId: 'cust_ada' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');
    return { ctx, session };
  }

  it('lists own invoices and creates a payment-intent stub for the outstanding balance, to the cent', async () => {
    const { ctx, session } = await invoiceSetup();
    const events = capture(ctx.events, 'portal_customer.payment_intent.created');

    const list = await api(ctx.app, ctx.tenantA, 'GET', '/me/invoices', undefined, session);
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).data.map((i: any) => i.id)).toEqual(['inv1', 'inv2']);

    const pay = await api(ctx.app, ctx.tenantA, 'POST', '/me/invoices/inv1/pay', undefined, session);
    expect(pay.status).toBe(201);
    const { data } = (await pay.json()) as any;
    expect(data.amountCents).toBe(30000); // exact outstanding balance
    expect(data.invoiceId).toBe('inv1');
    expect(data.status).toBe('requires_payment_method');
    expect(data.provider).toBe('stub');
    expect(data.clientSecret).toBeTruthy();

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ invoiceId: 'inv1', amountCents: 30000, customerId: 'cust_ada' });
  });

  it('rejects paying a settled invoice (400), a foreign invoice (404), and 501 without a provider', async () => {
    const { ctx, session } = await invoiceSetup();
    expect((await api(ctx.app, ctx.tenantA, 'POST', '/me/invoices/inv2/pay', undefined, session)).status).toBe(400);
    expect((await api(ctx.app, ctx.tenantA, 'POST', '/me/invoices/inv3/pay', undefined, session)).status).toBe(404);

    const bare = await setup();
    await createAccountViaApi(bare.app, bare.tenantA, { email: 'ada@example.com' });
    const bareSession = await login(bare, bare.tenantA, 'ada@example.com');
    expect((await api(bare.app, bare.tenantA, 'GET', '/me/invoices', undefined, bareSession)).status).toBe(501);
    expect((await api(bare.app, bare.tenantA, 'POST', '/me/invoices/x/pay', undefined, bareSession)).status).toBe(501);
  });

  it('uses a wired billing payment provider instead of the built-in stub', async () => {
    const custom = {
      async createPaymentIntent(input: any): Promise<PaymentIntentStub> {
        return {
          id: 'pi_custom',
          provider: 'custom',
          invoiceId: input.invoiceId,
          amountCents: input.amountCents,
          currency: 'usd',
          status: 'requires_payment_method',
          clientSecret: 'cs_custom',
        };
      },
    };
    const { ctx, session } = await invoiceSetup(custom);
    const pay = await api(ctx.app, ctx.tenantA, 'POST', '/me/invoices/inv1/pay', undefined, session);
    expect(pay.status).toBe(201);
    const { data } = (await pay.json()) as any;
    expect(data.id).toBe('pi_custom');
    expect(data.provider).toBe('custom');
    expect(data.amountCents).toBe(30000);
  });
});

describe('messages (messaging contract)', () => {
  it('stores the message, relays through the messaging contract and emits portal_customer.message.sent', async () => {
    const sent: SendMessageInput[] = [];
    const ctx = await setup({
      contracts: {
        sendMessage: {
          async sendMessage(input) {
            sent.push(input);
            return { id: 'relay_1' };
          },
        },
      },
    });
    const events = capture(ctx.events, 'portal_customer.message.sent');
    const account = await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com', customerId: 'cust_ada' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');

    const res = await api(ctx.app, ctx.tenantA, 'POST', '/me/messages', { subject: 'Gate code', body: 'Use 4321.' }, session);
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as any;
    expect(data.relayed_message_id).toBe('relay_1');
    expect(data.customer_id).toBe('cust_ada');

    // The login flow relays the magic link over 'email'; the portal message itself uses 'portal'.
    const portalSends = sent.filter((s) => s.channel === 'portal');
    expect(portalSends).toHaveLength(1);
    expect(portalSends[0]).toMatchObject({ channel: 'portal', to: 'cust_ada', body: 'Use 4321.' });

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ messageId: data.id, accountId: account.id, relayedMessageId: 'relay_1' });

    const list = await api(ctx.app, ctx.tenantA, 'GET', '/me/messages', undefined, session);
    expect(((await list.json()) as any).data.map((m: any) => m.id)).toEqual([data.id]);
  });

  it('degrades gracefully without the messaging contract: message is stored locally, relay id null', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');
    const res = await api(ctx.app, ctx.tenantA, 'POST', '/me/messages', { body: 'Hello there' }, session);
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).data.relayed_message_id).toBeNull();
  });

  it('validates the message body', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');
    expect((await api(ctx.app, ctx.tenantA, 'POST', '/me/messages', { body: '' }, session)).status).toBe(400);
    expect((await api(ctx.app, ctx.tenantA, 'POST', '/me/messages', {}, session)).status).toBe(400);
  });
});

describe('uploads (files provider)', () => {
  it('registers the file with the files provider, stores metadata and emits portal_customer.upload.created', async () => {
    const registered: any[] = [];
    const ctx = await setup({
      providers: {
        files: {
          async registerUpload(input) {
            registered.push(input);
            return { id: 'file_1' };
          },
        },
      },
    });
    const events = capture(ctx.events, 'portal_customer.upload.created');
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com', customerId: 'cust_ada' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');

    const res = await api(ctx.app, ctx.tenantA, 'POST', '/me/uploads', {
      fileName: 'roof.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 12345,
      kind: 'photo',
      relatedEntityType: 'scheduling.appointment',
      relatedEntityId: 'appt1',
    }, session);
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as any;
    expect(data.file_id).toBe('file_1');
    expect(data.kind).toBe('photo');
    expect(data.related_entity_id).toBe('appt1');

    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ tenantId: ctx.tenantA, customerId: 'cust_ada', fileName: 'roof.jpg', sizeBytes: 12345 });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ uploadId: data.id, fileId: 'file_1', fileName: 'roof.jpg' });
  });

  it('stores metadata with a null file id when no files provider is wired, and validates input', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');

    const ok = await api(ctx.app, ctx.tenantA, 'POST', '/me/uploads', {
      fileName: 'notes.pdf',
      contentType: 'application/pdf',
      sizeBytes: 100,
    }, session);
    expect(ok.status).toBe(201);
    const { data } = (await ok.json()) as any;
    expect(data.file_id).toBeNull();
    expect(data.kind).toBe('document'); // default

    const bad = await api(ctx.app, ctx.tenantA, 'POST', '/me/uploads', {
      fileName: 'x', contentType: 'text/plain', sizeBytes: -5,
    }, session);
    expect(bad.status).toBe(400);

    const list = await api(ctx.app, ctx.tenantA, 'GET', '/me/uploads', undefined, session);
    expect(((await list.json()) as any).data).toHaveLength(1);
  });
});

describe('jobs & review prompts (providers)', () => {
  it('lists job/project status and pending review requests via providers, 501 without', async () => {
    const seedTenant: { id?: string } = {};
    const ctx = await setup({
      providers: {
        jobs: {
          async listForCustomer(tenantId, customerId) {
            return tenantId === seedTenant.id && customerId === 'cust_ada'
              ? [{ id: 'job1', title: 'Install', status: 'in_progress', detail: 'Phase 2 of 3' }]
              : [];
          },
        },
        reviews: {
          async listPendingForCustomer(tenantId, customerId) {
            return tenantId === seedTenant.id && customerId === 'cust_ada'
              ? [{ id: 'rr1', subject: 'How did we do?', requestedAt: '2026-07-09T00:00:00.000Z' }]
              : [];
          },
        },
      },
    });
    seedTenant.id = ctx.tenantA;
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com', customerId: 'cust_ada' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');

    const jobs = await api(ctx.app, ctx.tenantA, 'GET', '/me/jobs', undefined, session);
    expect(jobs.status).toBe(200);
    expect(((await jobs.json()) as any).data).toEqual([
      { id: 'job1', title: 'Install', status: 'in_progress', detail: 'Phase 2 of 3' },
    ]);

    const reviews = await api(ctx.app, ctx.tenantA, 'GET', '/me/reviews/pending', undefined, session);
    expect(reviews.status).toBe(200);
    expect(((await reviews.json()) as any).data.map((r: any) => r.id)).toEqual(['rr1']);

    const bare = await setup();
    await createAccountViaApi(bare.app, bare.tenantA, { email: 'ada@example.com' });
    const bareSession = await login(bare, bare.tenantA, 'ada@example.com');
    expect((await api(bare.app, bare.tenantA, 'GET', '/me/jobs', undefined, bareSession)).status).toBe(501);
    expect((await api(bare.app, bare.tenantA, 'GET', '/me/reviews/pending', undefined, bareSession)).status).toBe(501);
  });
});
