import { describe, expect, it } from 'vitest';
import { asCoreDb, coreMigrations, createTenant } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  MerchantConflictError,
  MerchantExistsError,
  createDbMerchantStore,
  posServiceMigrations,
  type PosServiceDatabase,
} from '@blacklabel/pos-service';
import { sampleMerchant } from './helpers';

async function setup() {
  const db = createTestDb<PosServiceDatabase>();
  await runMigrations(db, [...coreMigrations, ...posServiceMigrations]);
  const A = (await createTenant(asCoreDb(db), { name: 'Tenant A' })).id;
  const B = (await createTenant(asCoreDb(db), { name: 'Tenant B' })).id;
  return { db, A, B, a: createDbMerchantStore(db, A), b: createDbMerchantStore(db, B) };
}

describe('pos-service database store', () => {
  it('refuses a stale write instead of overwriting a newer one', async () => {
    const { db, A, a } = await setup();
    await a.create(sampleMerchant('mer_1', 'cs_1'));
    const loaded = (await a.get('mer_1'))!;
    await a.update({ ...loaded, stage: 'onboarding' }, 1);
    await expect(a.update({ ...loaded, stage: 'account_created' }, 1)).rejects.toBeInstanceOf(MerchantConflictError);
    expect(await a.get('mer_1')).toMatchObject({ version: 2, stage: 'onboarding' });
    const row = await db.selectFrom('pos_service_merchants').selectAll().where('tenant_id', '=', A).where('id', '=', 'mer_1').executeTakeFirstOrThrow();
    expect(row).toMatchObject({ tenant_id: A, version: 2, stage: 'onboarding', livemode: 0, purchase_ref: 'cs_1', stripe_account_id: null, blocked_code: null });
    expect(JSON.parse(row.record)).toMatchObject({ id: 'mer_1', version: 2, stage: 'onboarding' });
  });

  it('keeps purchases, Stripe accounts, and the webhook ledger inside one tenant', async () => {
    const { a, b } = await setup();
    await a.create({ ...sampleMerchant('mer_a', 'cs_same'), stripeAccountId: 'acct_1Shared' });
    await expect(a.create(sampleMerchant('mer_a2', 'cs_same'))).rejects.toBeInstanceOf(MerchantExistsError);
    await b.create(sampleMerchant('mer_b', 'cs_same'));

    expect(await b.get('mer_a')).toBeNull();
    expect(await b.findByStripeAccount('acct_1Shared')).toBeNull();
    expect(await b.findByPurchaseRef('cs_same')).toMatchObject({ id: 'mer_b' });
    await expect(b.update({ ...sampleMerchant('mer_a', 'cs_same'), stage: 'live' }, 1)).rejects.toBeInstanceOf(MerchantConflictError);
    expect(await a.get('mer_a')).toMatchObject({ stage: 'purchased', version: 1 });

    expect(await a.recordEvent('evt_1')).toBe(true);
    expect(await a.recordEvent('evt_1')).toBe(false);
    expect(await a.hasEvent('evt_1')).toBe(true);
    expect(await b.hasEvent('evt_1')).toBe(false);
    expect(await b.recordEvent('evt_1')).toBe(true);
  });

  it('lists oldest first with the id as tiebreaker, one page at a time', async () => {
    const { a, b } = await setup();
    await a.create(sampleMerchant('mer_c', 'cs_c', '2026-09-15T20:00:02.000Z'));
    await a.create(sampleMerchant('mer_b', 'cs_b', '2026-09-15T20:00:01.000Z'));
    await a.create(sampleMerchant('mer_a', 'cs_a', '2026-09-15T20:00:01.000Z'));
    await b.create(sampleMerchant('mer_z', 'cs_z', '2026-09-15T20:00:00.000Z'));
    expect((await a.list()).map((m) => m.id)).toEqual(['mer_a', 'mer_b', 'mer_c']);
    expect((await a.list({ limit: 2, offset: 1 })).map((m) => m.id)).toEqual(['mer_b', 'mer_c']);
    expect((await b.list()).map((m) => m.id)).toEqual(['mer_z']);
  });
});
