import { describe, expect, it } from 'vitest';
import { listAuditEntries, asCoreDb } from '@blacklabel/core';
import { seedBilling } from '../src/seed';
import { api, json, setupBilling } from './helpers';

describe('memberships', () => {
  it('links a customer to a plan and walks the status lifecycle', async () => {
    const ctx = await setupBilling();
    const created: any[] = [];
    ctx.events.on('billing.membership.created', (e) => {
      created.push(e);
    });

    const res = await api(ctx.app, ctx.tenantA.id, 'POST', '/memberships', {
      customerId: 'member-1',
      planKey: 'gold',
    });
    expect(res.status).toBe(201);
    const membership = (await json(res)).data;
    expect(membership.status).toBe('active');
    expect(membership.plan_key).toBe('gold');
    expect(membership.started_at).toBeTruthy();
    expect(created).toHaveLength(1);
    expect(created[0].payload).toEqual({
      membershipId: membership.id,
      customerId: 'member-1',
      planKey: 'gold',
    });

    const canceled = await api(ctx.app, ctx.tenantA.id, 'PUT', `/memberships/${membership.id}`, {
      status: 'canceled',
      endsAt: '2026-12-31T00:00:00.000Z',
    });
    expect((await json(canceled)).data.status).toBe('canceled');
    expect((await json(await api(ctx.app, ctx.tenantA.id, 'GET', `/memberships/${membership.id}`))).data.ends_at).toBe(
      '2026-12-31T00:00:00.000Z',
    );

    const byPlan = await json(
      await api(ctx.app, ctx.tenantA.id, 'GET', '/memberships?plan_key=gold&status=canceled'),
    );
    expect(byPlan.data).toHaveLength(1);

    // Linking to a nonexistent subscription is rejected.
    const badLink = await api(ctx.app, ctx.tenantA.id, 'POST', '/memberships', {
      customerId: 'member-2',
      planKey: 'gold',
      subscriptionId: 'ghost-sub',
    });
    expect(badLink.status).toBe(400);
  });

  it("tenant B cannot read or mutate tenant A's memberships", async () => {
    const ctx = await setupBilling();
    const membership = (
      await json(
        await api(ctx.app, ctx.tenantA.id, 'POST', '/memberships', {
          customerId: 'iso-member',
          planKey: 'silver',
        }),
      )
    ).data;

    expect((await api(ctx.app, ctx.tenantB.id, 'GET', `/memberships/${membership.id}`)).status).toBe(404);
    expect(
      (await api(ctx.app, ctx.tenantB.id, 'PUT', `/memberships/${membership.id}`, { status: 'expired' }))
        .status,
    ).toBe(404);
    expect((await json(await api(ctx.app, ctx.tenantB.id, 'GET', '/memberships'))).data).toEqual([]);

    const intact = await json(await api(ctx.app, ctx.tenantA.id, 'GET', `/memberships/${membership.id}`));
    expect(intact.data.status).toBe('active');
  });
});

describe('billing accounts', () => {
  it('supports create/read/update/delete', async () => {
    const ctx = await setupBilling();
    const res = await api(ctx.app, ctx.tenantA.id, 'POST', '/accounts', {
      customerId: 'acct-cust',
      name: 'Main account',
      email: 'pay@example.test',
    });
    expect(res.status).toBe(201);
    const account = (await json(res)).data;

    const updated = await json(
      await api(ctx.app, ctx.tenantA.id, 'PUT', `/accounts/${account.id}`, {
        name: 'Renamed account',
        email: null,
      }),
    );
    expect(updated.data.name).toBe('Renamed account');
    expect(updated.data.email).toBeNull();

    const byCustomer = await json(
      await api(ctx.app, ctx.tenantA.id, 'GET', '/accounts?customer_id=acct-cust'),
    );
    expect(byCustomer.data).toHaveLength(1);

    expect((await api(ctx.app, ctx.tenantA.id, 'DELETE', `/accounts/${account.id}`)).status).toBe(200);
    expect((await api(ctx.app, ctx.tenantA.id, 'GET', `/accounts/${account.id}`)).status).toBe(404);
  });

  it('invoices validate the billing account belongs to the tenant', async () => {
    const ctx = await setupBilling();
    const bAccount = (
      await json(
        await api(ctx.app, ctx.tenantB.id, 'POST', '/accounts', {
          customerId: 'b-cust',
          name: 'B account',
        }),
      )
    ).data;

    // Tenant A cannot attach tenant B's account to its invoice.
    const res = await api(ctx.app, ctx.tenantA.id, 'POST', '/invoices', {
      customerId: 'a-cust',
      billingAccountId: bAccount.id,
      lines: [{ description: 'x', quantity: 1, unitPriceCents: 100 }],
    });
    expect(res.status).toBe(400);
  });

  it("tenant B cannot read/update/delete tenant A's accounts", async () => {
    const ctx = await setupBilling();
    const account = (
      await json(
        await api(ctx.app, ctx.tenantA.id, 'POST', '/accounts', {
          customerId: 'iso-acct',
          name: 'Isolated',
        }),
      )
    ).data;
    expect((await api(ctx.app, ctx.tenantB.id, 'GET', `/accounts/${account.id}`)).status).toBe(404);
    expect(
      (await api(ctx.app, ctx.tenantB.id, 'PUT', `/accounts/${account.id}`, { name: 'stolen' })).status,
    ).toBe(404);
    expect((await api(ctx.app, ctx.tenantB.id, 'DELETE', `/accounts/${account.id}`)).status).toBe(404);
    const intact = await json(await api(ctx.app, ctx.tenantA.id, 'GET', `/accounts/${account.id}`));
    expect(intact.data.name).toBe('Isolated');
  });
});

describe('seed + audit trail', () => {
  it('seedBilling creates a coherent demo data set', async () => {
    const ctx = await setupBilling();
    const seeded = await seedBilling(ctx.db, ctx.tenantA.id, ctx.events);

    const draft = await json(await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${seeded.draftInvoiceId}`));
    expect(draft.data.status).toBe('draft');
    const partial = await json(
      await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${seeded.partialInvoiceId}`),
    );
    expect(partial.data.status).toBe('partial');
    expect(partial.data.paid_cents).toBe(20_000);
    const paid = await json(await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${seeded.paidInvoiceId}`));
    expect(paid.data.status).toBe('paid');

    const subs = await json(await api(ctx.app, ctx.tenantA.id, 'GET', '/subscriptions'));
    expect(subs.data).toHaveLength(1);
    const memberships = await json(await api(ctx.app, ctx.tenantA.id, 'GET', '/memberships'));
    expect(memberships.data).toHaveLength(1);
    expect(memberships.data[0].subscription_id).toBe(seeded.subscriptionId);

    // Nothing leaked into tenant B.
    expect((await json(await api(ctx.app, ctx.tenantB.id, 'GET', '/invoices'))).data).toEqual([]);
  });

  it('mutations write namespaced audit entries', async () => {
    const ctx = await setupBilling();
    const invoice = (
      await json(
        await api(ctx.app, ctx.tenantA.id, 'POST', '/invoices', {
          customerId: 'audit-cust',
          lines: [{ description: 'x', quantity: 1, unitPriceCents: 1_000 }],
        }),
      )
    ).data;
    const entries = await listAuditEntries(
      asCoreDb(ctx.db),
      ctx.tenantA.id,
      'billing.invoice',
      invoice.id,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('billing.invoice.created');
    expect(entries[0].actor).toBe('system');
  });
});
