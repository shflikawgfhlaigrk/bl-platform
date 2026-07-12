import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@blacklabel/core';
import { fixtureImport, headers, setup } from './helpers';
import { importSales, linkCustomer, salesSummary } from '../src/service';

describe('retail import (idempotent, to the cent)', () => {
  it('imports payments/lines/refunds via the router and records an import run', async () => {
    const { app, tenantA } = await setup();

    const res = await app.request('/import', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify(fixtureImport()),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.paymentsInserted).toBe(4);
    expect(body.data.linesInserted).toBe(4);
    expect(body.data.refundsInserted).toBe(1);
    // Completed gross = 12550 + 4999 + 20000 (FAILED payment excluded), exact.
    expect(body.data.completedGrossCentsAfter).toBe(37549);

    const runs = await app.request('/import-runs', { headers: headers(tenantA) });
    const runsBody = (await runs.json()) as any;
    expect(runsBody.data).toHaveLength(1);
    expect(runsBody.data[0].completed_gross_cents_after).toBe(37549);
  });

  it('re-importing the same export is a no-op (skips by source id)', async () => {
    const { db, events, tenantA } = await setup();
    const first = await importSales(db, events, tenantA.id, 'system', fixtureImport());
    expect(first.paymentsInserted).toBe(4);

    const second = await importSales(db, events, tenantA.id, 'system', fixtureImport());
    expect(second.paymentsInserted).toBe(0);
    expect(second.paymentsSkipped).toBe(4);
    expect(second.linesInserted).toBe(0);
    expect(second.refundsInserted).toBe(0);
    // Gross unchanged after the re-run.
    expect(second.completedGrossCentsAfter).toBe(first.completedGrossCentsAfter);
  });

  it('summary respects the paid_at range and computes the average ticket exactly', async () => {
    const { db, events, tenantA } = await setup();
    await importSales(db, events, tenantA.id, 'system', fixtureImport());

    const all = await salesSummary(db, tenantA.id);
    expect(all.paymentCount).toBe(3);
    expect(all.grossCents).toBe(37549);
    expect(all.averageTicketCents).toBe(Math.round(37549 / 3));

    const week1 = await salesSummary(db, tenantA.id, {
      from: '2026-03-07T00:00:00.000Z',
      to: '2026-03-08T23:59:59.999Z',
    });
    expect(week1.paymentCount).toBe(2);
    expect(week1.grossCents).toBe(12550 + 4999);
  });

  it('emits retail.import.completed after the write', async () => {
    const { db, events, tenantA } = await setup();
    const seen: PlatformEvent[] = [];
    events.on('retail.import.completed', (e) => {
      seen.push(e);
    });
    const result = await importSales(db, events, tenantA.id, 'system', fixtureImport());
    expect(seen).toHaveLength(1);
    expect(seen[0].tenantId).toBe(tenantA.id);
    expect(seen[0].payload).toEqual({
      importRunId: result.importRunId,
      payments: 4,
      orderLines: 4,
      refunds: 1,
    });
  });

  it('links POS customers to crm ids exactly once and conflicts on relink', async () => {
    const { db, tenantA } = await setup();
    const link = await linkCustomer(db, tenantA.id, 'cust_1', 'crm_abc');
    const again = await linkCustomer(db, tenantA.id, 'cust_1', 'crm_abc');
    expect(again.id).toBe(link.id);
    await expect(linkCustomer(db, tenantA.id, 'cust_1', 'crm_OTHER')).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('retail tenant isolation', () => {
  it('tenant B sees none of tenant A data and cannot read across', async () => {
    const { app, db, events, tenantA, tenantB } = await setup();
    await importSales(db, events, tenantA.id, 'system', fixtureImport());

    for (const path of ['/payments', '/import-runs', '/customer-links']) {
      const res = await app.request(path, { headers: headers(tenantB) });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).data).toEqual([]);
    }

    const summary = await app.request('/summary', { headers: headers(tenantB) });
    expect(((await summary.json()) as any).data.grossCents).toBe(0);

    // A's data untouched.
    const aSummary = await salesSummary(db, tenantA.id);
    expect(aSummary.grossCents).toBe(37549);
  });

  it('requires the tenant header (400) and a real tenant (404)', async () => {
    const { app } = await setup();
    const missing = await app.request('/payments');
    expect(missing.status).toBe(400);
    const unknown = await app.request('/payments', { headers: { 'x-tenant-id': 'nope' } });
    expect(unknown.status).toBe(404);
  });

  it('the same POS source id can exist in two tenants independently', async () => {
    const { db, events, tenantA, tenantB } = await setup();
    await importSales(db, events, tenantA.id, 'system', fixtureImport());
    const result = await importSales(db, events, tenantB.id, 'system', fixtureImport());
    expect(result.paymentsInserted).toBe(4);
    expect((await salesSummary(db, tenantB.id)).grossCents).toBe(37549);
  });
});
