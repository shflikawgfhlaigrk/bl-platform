import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@blacklabel/core';
import { listAuditEntries } from '@blacklabel/core';
import { asCoreDb } from '@blacklabel/core';
import { setup, squareOrder, squarePayment } from './helpers';
import type { ImportBatch } from '../src/contract';
import {
  discardQuarantine,
  getManifestDetail,
  importStatus,
  lastSuccessfulImportAt,
  listManifests,
  listQuarantine,
  reconciliation,
  repairQuarantine,
  runImportBatch,
} from '../src/import-service';

function paymentsBatch(records: unknown[]): ImportBatch {
  return { source: 'square_export', kind: 'payments', records, sourceMeta: { fetchedAt: '2026-07-12T00:00:00.000Z' } };
}

describe('pipeline — manifest lifecycle & idempotent re-import', () => {
  it('records a done manifest with accurate counts', async () => {
    const { db, events, tenantA } = await setup();
    const batch = paymentsBatch([squarePayment('p1', 1000), squarePayment('p2', 2000)]);
    const res = await runImportBatch(db, events, tenantA.id, 'system', batch);
    expect(res.status).toBe('done');
    expect(res.recordCount).toBe(2);
    expect(res.accepted).toBe(2);
    expect(res.updated).toBe(0);
    expect(res.skippedDuplicates).toBe(0);
    expect(res.quarantined).toBe(0);

    const manifests = await listManifests(db, tenantA.id);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].status).toBe('done');
    expect(manifests[0].finished_at).not.toBeNull();
  });

  it('re-importing the same batch is a no-op (all skipped_duplicates, gross unchanged) — journey 2', async () => {
    const { db, events, tenantA } = await setup();
    const batch = paymentsBatch([squarePayment('p1', 1000), squarePayment('p2', 2000)]);
    const first = await runImportBatch(db, events, tenantA.id, 'system', batch);
    expect(first.accepted).toBe(2);
    expect(first.reconGrossCents).toBe(3000);

    const second = await runImportBatch(db, events, tenantA.id, 'system', batch);
    expect(second.accepted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skippedDuplicates).toBe(2);
    // Row count + gross never duplicate.
    const rows = await db.selectFrom('retail_payments').selectAll().where('tenant_id', '=', tenantA.id).execute();
    expect(rows).toHaveLength(2);
    expect(second.reconGrossCents).toBe(3000);
  });

  it('collapses in-batch duplicate source ids (later wins) and updates on changed re-import', async () => {
    const { db, events, tenantA } = await setup();
    // Same id twice in one batch — later wins, one row.
    await runImportBatch(db, events, tenantA.id, 'system', paymentsBatch([squarePayment('p1', 1000), squarePayment('p1', 1500)]));
    let rows = await db.selectFrom('retail_payments').selectAll().where('tenant_id', '=', tenantA.id).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe(1500);

    // Re-import with a real change → updated, still one row.
    const changed = await runImportBatch(db, events, tenantA.id, 'system', paymentsBatch([squarePayment('p1', 1800)]));
    expect(changed.updated).toBe(1);
    rows = await db.selectFrom('retail_payments').selectAll().where('tenant_id', '=', tenantA.id).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe(1800);
  });

  it('orders lane never duplicates lines on re-import', async () => {
    const { db, events, tenantA } = await setup();
    const batch: ImportBatch = { source: 'square_export', kind: 'orders', records: [squareOrder('o1', 1307)], sourceMeta: { fetchedAt: 'x' } };
    await runImportBatch(db, events, tenantA.id, 'system', batch);
    await runImportBatch(db, events, tenantA.id, 'system', batch);
    const lines = await db.selectFrom('retail_order_lines').selectAll().where('tenant_id', '=', tenantA.id).where('source_order_id', '=', 'o1').execute();
    expect(lines).toHaveLength(1);
    const orders = await db.selectFrom('retail_orders').selectAll().where('tenant_id', '=', tenantA.id).execute();
    expect(orders).toHaveLength(1);
  });
});

describe('pipeline — quarantine (never silent) + event + repair + discard', () => {
  it('quarantines malformed records, emits the event, and never silently skips', async () => {
    const { db, events, tenantA } = await setup();
    const seen: PlatformEvent[] = [];
    events.on('retail.import.quarantined', (e) => {
      seen.push(e);
    });

    const batch = paymentsBatch([
      squarePayment('p1', 1000), // valid
      { id: 'bad', created_at: 'x', status: 'COMPLETED' }, // missing amount_money → quarantine
    ]);
    const res = await runImportBatch(db, events, tenantA.id, 'system', batch);
    expect(res.accepted).toBe(1);
    expect(res.quarantined).toBe(1);

    const q = await listQuarantine(db, tenantA.id);
    expect(q).toHaveLength(1);
    expect(q[0].status).toBe('quarantined');
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toMatchObject({ v: 1, kind: 'payments', quarantineId: q[0].id, manifestId: res.manifestId });
  });

  it('repairs a quarantined record: re-validate → upsert → mark repaired', async () => {
    const { db, events, tenantA } = await setup();
    await runImportBatch(db, events, tenantA.id, 'system', paymentsBatch([{ id: 'p9', created_at: 'x', status: 'COMPLETED' }]));
    const [q] = await listQuarantine(db, tenantA.id);
    expect(q.status).toBe('quarantined');

    const repaired = await repairQuarantine(db, events, tenantA.id, 'owner', q.id, squarePayment('p9', 4200));
    expect(repaired.status).toBe('repaired');
    const rows = await db.selectFrom('retail_payments').selectAll().where('tenant_id', '=', tenantA.id).where('source_id', '=', 'p9').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe(4200);
  });

  it('rejects a repair that still fails validation, and discards with a reason', async () => {
    const { db, events, tenantA } = await setup();
    await runImportBatch(db, events, tenantA.id, 'system', paymentsBatch([{ id: 'p9', bad: true }]));
    const [q] = await listQuarantine(db, tenantA.id);

    await expect(repairQuarantine(db, events, tenantA.id, 'owner', q.id, { still: 'bad' })).rejects.toMatchObject({ status: 400 });

    const discarded = await discardQuarantine(db, tenantA.id, 'owner', q.id, 'garbage export row');
    expect(discarded.status).toBe('discarded');
    expect(JSON.parse(discarded.errors).discardReason).toBe('garbage export row');
  });

  it('manifest detail carries a quarantine summary', async () => {
    const { db, events, tenantA } = await setup();
    const res = await runImportBatch(db, events, tenantA.id, 'system', paymentsBatch([squarePayment('p1', 1000), { id: 'bad' }]));
    const detail = await getManifestDetail(db, tenantA.id, res.manifestId);
    expect(detail.quarantineSummary.quarantined).toBe(1);
  });
});

describe('pipeline — reconciliation & staleness', () => {
  it('reports a match, then emits reconciliation_failed on a forced mismatch', async () => {
    const { db, events, tenantA } = await setup();
    await runImportBatch(db, events, tenantA.id, 'system', paymentsBatch([squarePayment('p1', 1000), squarePayment('p2', 2000)]));

    const clean = await reconciliation(db, events, tenantA.id);
    const pay = clean.find((r) => r.kind === 'payments')!;
    expect(pay.ok).toBe(true);
    expect(pay.actualGrossCents).toBe(3000);

    // Force drift: tamper a payment row directly (bypassing the pipeline).
    const failures: PlatformEvent[] = [];
    events.on('retail.import.reconciliation_failed', (e) => {
      failures.push(e);
    });
    await db.updateTable('retail_payments').set({ amount_cents: 999999 }).where('tenant_id', '=', tenantA.id).where('source_id', '=', 'p1').execute();

    const dirty = await reconciliation(db, events, tenantA.id);
    expect(dirty.find((r) => r.kind === 'payments')!.ok).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0].payload).toMatchObject({ v: 1, kind: 'payments', expectedGrossCents: 3000 });
  });

  it('lastSuccessfulImportAt / importStatus reflect the last done manifest', async () => {
    const { db, events, tenantA } = await setup();
    expect(await lastSuccessfulImportAt(db, tenantA.id, 'payments')).toBeNull();
    await runImportBatch(db, events, tenantA.id, 'system', paymentsBatch([squarePayment('p1', 1000)]));
    expect(await lastSuccessfulImportAt(db, tenantA.id, 'payments')).not.toBeNull();

    const status = await importStatus(db, tenantA.id);
    const pay = status.find((s) => s.kind === 'payments')!;
    expect(pay.manifestCount).toBe(1);
    expect(pay.totalAccepted).toBe(1);
    const orders = status.find((s) => s.kind === 'orders')!;
    expect(orders.lastSuccessAt).toBeNull();
  });
});

describe('pipeline — tenancy & audit', () => {
  it('keeps every new entity tenant-scoped', async () => {
    const { db, events, tenantA, tenantB } = await setup();
    await runImportBatch(db, events, tenantA.id, 'system', paymentsBatch([squarePayment('p1', 1000)]));

    // The SAME source id imports independently in tenant B.
    const b = await runImportBatch(db, events, tenantB.id, 'system', paymentsBatch([squarePayment('p1', 1000)]));
    expect(b.accepted).toBe(1);

    // B sees none of A's manifests/quarantine/payments.
    expect(await listManifests(db, tenantB.id)).toHaveLength(1);
    const bPayments = await db.selectFrom('retail_payments').selectAll().where('tenant_id', '=', tenantB.id).execute();
    expect(bPayments).toHaveLength(1);
    expect(bPayments[0].source_id).toBe('p1');
    // A untouched.
    const aPayments = await db.selectFrom('retail_payments').selectAll().where('tenant_id', '=', tenantA.id).execute();
    expect(aPayments).toHaveLength(1);
  });

  it('audits every import and quarantine mutation', async () => {
    const { db, events, tenantA } = await setup();
    const res = await runImportBatch(db, events, tenantA.id, 'owner', paymentsBatch([squarePayment('p1', 1000)]));
    const entries = await listAuditEntries(asCoreDb(db), tenantA.id, 'retail.import_manifest', res.manifestId);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].action).toBe('retail.import_manifest.imported');
    expect(entries[0].actor).toBe('owner');
  });
});
