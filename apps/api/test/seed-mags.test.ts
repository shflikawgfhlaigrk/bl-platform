/**
 * seed-mags-tenant unit + integration tests.
 *
 * Runs the seed's exported FUNCTIONS against in-memory dbs with small synthetic
 * fixtures (never the real ledger / tenant db). Proves:
 *   - idempotency (run twice → zero new inserts),
 *   - the crm-link join (square customer id → crm id via retail_customer_links),
 *   - gift-card real-GAN import (code = ledger gan; re-run mints no duplicate),
 *   - the fee-absent honesty path (null source fee → fee 0, counted 'without'),
 *   - the gate-failure exit path (a mismatched expectation → failures > 0).
 */
import { describe, it, expect } from 'vitest';
import { asCoreDb, createTenant, id, nowIso } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { createApp, type PlatformDatabase } from '../src/app';
import {
  buildCustomerImportRows,
  buildPaymentInputs,
  mapSourceKind,
  runGates,
  seedLocations,
  seedCatalog,
  seedCustomers,
  seedFinance,
  seedGiftCards,
  seedStorefront,
  type GateCheck,
  type LedgerCustomer,
  type LedgerGiftCard,
  type LedgerPayment,
} from '../src/seed-mags-tenant';
import type { LedgerItem } from '@blacklabel/catalog';
import { getConfig, CONFIG_KEYS } from '../src/config';

async function boot() {
  const db = createTestDb<PlatformDatabase>();
  const platform = await createApp({ db });
  const tenant = await createTenant(asCoreDb(db), { name: 'Mags Tack' });
  await platform.seedTenant(tenant.id, { actor: 'test' });
  return { db, platform, tenantId: tenant.id };
}

/** Insert a retail_customer_links mapping row directly (no FK, string ref). */
async function link(db: PlatformDatabase extends never ? never : any, tenantId: string, sourceId: string, crmId: string) {
  await db
    .insertInto('retail_customer_links')
    .values({ id: id(), tenant_id: tenantId, source_id: sourceId, crm_customer_id: crmId, created_at: nowIso() })
    .execute();
}

const ITEMS: LedgerItem[] = [
  {
    sourceItemId: 'item-1',
    name: 'Blue Nylon Halter',
    description: 'A durable halter.',
    categoryName: 'Halters',
    variations: [
      { sourceVariationId: 'var-1a', name: 'Small', sku: 'HAL-S', upc: '036000291452', priceCents: 1999 },
      { sourceVariationId: 'var-1b', name: 'Large', sku: 'HAL-L', upc: null, priceCents: 2199 },
    ],
  },
  {
    sourceItemId: 'item-2',
    name: 'Leather Bridle',
    description: null,
    categoryName: 'Bridles',
    variations: [{ sourceVariationId: 'var-2a', name: 'Regular', sku: 'BRI-1', upc: null, priceCents: 8999 }],
  },
];

const CUSTOMERS: LedgerCustomer[] = [
  { id: 'sq-cust-1', given_name: 'Jane', family_name: 'Rider', email: 'JANE@EXAMPLE.COM', phone: '(555) 123-4567' },
  { id: 'sq-cust-2', given_name: 'No', family_name: 'Link', email: 'orphan@example.com', phone: null },
];

const PAYMENTS: LedgerPayment[] = [
  // with fee
  { id: 'pay-1', created_at: '2025-01-02T10:00:00Z', status: 'COMPLETED', amount_cents: 10000, source_type: 'CARD', card_brand: 'VISA', processing_fee_cents: 290, order_id: 'ord-1' },
  // without fee (fee unknown in source)
  { id: 'pay-2', created_at: '2025-01-03T10:00:00Z', status: 'COMPLETED', amount_cents: 5000, source_type: 'CASH', card_brand: null, processing_fee_cents: null, order_id: null },
  // failed (still imported; not in completed gross)
  { id: 'pay-3', created_at: '2025-01-04T10:00:00Z', status: 'FAILED', amount_cents: 2000, source_type: 'CARD', card_brand: 'MASTERCARD', processing_fee_cents: null, order_id: null },
];

const GIFT_CARDS: LedgerGiftCard[] = [
  { id: 'gftc:aaa', state: 'ACTIVE', balance_cents: 5000 },
  { id: 'gftc:bbb', state: 'ACTIVE', balance_cents: 2500 },
  { id: 'gftc:zero', state: 'ACTIVE', balance_cents: 0 },
  { id: 'gftc:pend', state: 'PENDING', balance_cents: 0 },
];

describe('seed-mags pure mappers', () => {
  it('maps Square source types to finance tender kinds', () => {
    expect(mapSourceKind('CARD', 'VISA')).toBe('card');
    expect(mapSourceKind('CASH', null)).toBe('cash');
    expect(mapSourceKind('EXTERNAL', null)).toBe('external');
    expect(mapSourceKind('WALLET', null)).toBe('wallet');
    expect(mapSourceKind('CARD', 'SQUARE_GIFT_CARD')).toBe('gift_card');
    expect(mapSourceKind(null, null)).toBe('external');
  });

  it('fee-absent honesty: null source fee → fee 0, net = amount, counted "without"', () => {
    const { inputs, withFee, withoutFee, unusable } = buildPaymentInputs(PAYMENTS);
    expect(unusable).toBe(0);
    expect(inputs).toHaveLength(3);
    expect(withFee).toBe(1);
    expect(withoutFee).toBe(2);
    const p1 = inputs.find((p) => p.sourcePaymentId === 'pay-1')!;
    expect(p1.feeCents).toBe(290);
    expect(p1.netCents).toBe(9710);
    const p2 = inputs.find((p) => p.sourcePaymentId === 'pay-2')!;
    expect(p2.feeCents).toBe(0); // unknown, NOT fabricated
    expect(p2.netCents).toBe(5000); // net = amount - 0
  });

  it('crm-link join maps square ids to crm ids and counts the unlinked', () => {
    const linkMap = new Map([['sq-cust-1', 'crm-1']]);
    const { rows, unlinked } = buildCustomerImportRows(CUSTOMERS, linkMap);
    expect(unlinked).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ crmCustomerId: 'crm-1', email: 'JANE@EXAMPLE.COM', firstName: 'Jane' });
  });

  it('gate harness counts failures', () => {
    const checks: GateCheck[] = [
      { name: 'ok', ok: true, detail: '' },
      { name: 'bad', ok: false, detail: 'mismatch' },
    ];
    expect(runGates(checks, () => {})).toBe(1);
    expect(runGates([{ name: 'ok', ok: true, detail: '' }], () => {})).toBe(0);
  });
});

describe('seed-mags integration (in-memory)', () => {
  it('seeds locations idempotently and wires api_config', async () => {
    const { db, tenantId } = await boot();
    const r1 = await seedLocations(db, tenantId);
    expect(r1.created).toBe(5);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfgDb = db as any;
    expect(await getConfig(cfgDb, tenantId, CONFIG_KEYS.defaultLocation)).toBe(r1.ids['Warehouse']);
    expect(await getConfig(cfgDb, tenantId, CONFIG_KEYS.damagedLocation)).toBe(r1.ids['Damaged']);
    expect(await getConfig(cfgDb, tenantId, CONFIG_KEYS.quarantineLocation)).toBe(r1.ids['Quarantine']);
    const r2 = await seedLocations(db, tenantId);
    expect(r2.created).toBe(0); // unchanged
    expect(r2.existing).toBe(5);
  });

  it('seeds catalog + customers + finance + gift cards + storefront, twice, with zero dupes', async () => {
    const { db, platform, tenantId } = await boot();
    const { events } = platform;
    await link(db, tenantId, 'sq-cust-1', 'crm-1');

    // ---- run 1 ----
    const cat1 = await seedCatalog(db, tenantId, ITEMS, events);
    expect(cat1.productsInserted).toBe(2);
    expect(cat1.variationsInserted).toBe(3);
    expect(cat1.stats.skus).toBe(3);
    expect(cat1.stats.upcs).toBe(1);
    expect(cat1.barcodesInserted).toBe(1);

    const cust1 = await seedCustomers(db, tenantId, CUSTOMERS);
    expect(cust1.summary.imported).toBe(1); // only the linked one
    expect(cust1.unlinked).toBe(1);
    expect(cust1.segments).toBeGreaterThan(0);

    const fin1 = await seedFinance(db, tenantId, { payments: PAYMENTS, refunds: [], payouts: [], disputes: [] }, events);
    expect(fin1.payments.inserted).toBe(3);

    const gift1 = await seedGiftCards(db, tenantId, GIFT_CARDS);
    expect(gift1.issued).toBe(2); // two positive-balance ACTIVE
    expect(gift1.zeroBalanceSkipped).toBe(1);
    expect(gift1.nonActiveSkipped).toBe(1);
    expect(gift1.liabilityCents).toBe(7500);

    const store1 = await seedStorefront(db, tenantId, events);
    expect(store1.published).toBe(true);
    expect(store1.status).toBe('live');
    expect(store1.itemCount).toBe(2); // both non-excluded
    expect(store1.failures).toEqual([]);

    // gift-card issued under the REAL gan as its code
    const card = await db
      .selectFrom('loyalty_gift_cards')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('code', '=', 'gftc:aaa')
      .executeTakeFirst();
    expect(card?.initial_cents).toBe(5000);

    // exactly one liability snapshot after run 1
    const snaps1 = await db
      .selectFrom('finance_liability_snapshots')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .execute();
    expect(snaps1).toHaveLength(1);
    expect(snaps1[0].outstanding_cents).toBe(7500);

    // ---- run 2: everything idempotent ----
    const cat2 = await seedCatalog(db, tenantId, ITEMS, events);
    expect(cat2.productsInserted).toBe(0);
    expect(cat2.variationsInserted).toBe(0);
    expect(cat2.barcodesInserted).toBe(0);

    const cust2 = await seedCustomers(db, tenantId, CUSTOMERS);
    expect(cust2.summary.imported).toBe(0);

    const fin2 = await seedFinance(db, tenantId, { payments: PAYMENTS, refunds: [], payouts: [], disputes: [] }, events);
    expect(fin2.payments.inserted).toBe(0);
    expect(fin2.payments.skipped).toBe(3);

    const gift2 = await seedGiftCards(db, tenantId, GIFT_CARDS);
    expect(gift2.issued).toBe(0); // no new cards
    expect(gift2.existing).toBe(2);
    expect(gift2.liabilityCents).toBe(7500);

    const store2 = await seedStorefront(db, tenantId, events);
    expect(store2.published).toBe(false); // live run already exists

    // still exactly one snapshot, one gift card per gan, N catalog rows
    const snaps2 = await db.selectFrom('finance_liability_snapshots').selectAll().where('tenant_id', '=', tenantId).execute();
    expect(snaps2).toHaveLength(1);
    const cards = await db.selectFrom('loyalty_gift_cards').selectAll().where('tenant_id', '=', tenantId).execute();
    expect(cards).toHaveLength(2);
    const products = await db.selectFrom('catalog_products').selectAll().where('tenant_id', '=', tenantId).execute();
    expect(products).toHaveLength(2);
  });

  it('completed gross + fee total reconcile to the source arithmetic', async () => {
    const { db, platform, tenantId } = await boot();
    await seedFinance(db, tenantId, { payments: PAYMENTS, refunds: [], payouts: [], disputes: [] }, platform.events);
    const gross = await db
      .selectFrom('finance_payments')
      .select((eb) => eb.fn.sum<number>('amount_cents').as('s'))
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'COMPLETED')
      .executeTakeFirst();
    expect(Number(gross?.s)).toBe(15000); // 10000 + 5000 (FAILED excluded)
    const fees = await db
      .selectFrom('finance_payments')
      .select((eb) => eb.fn.sum<number>('fee_cents').as('s'))
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    expect(Number(fees?.s)).toBe(290); // only the one real fee
  });
});
