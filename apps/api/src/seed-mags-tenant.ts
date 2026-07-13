/**
 * seed-mags-tenant — idempotent population of the NEW Mags Commerce OS module
 * tables (catalog / customers / finance / loyalty / inventory / workforce /
 * storefront) for the REAL "Mags Tack" tenant, from the verified Square-shaped
 * source ledger (~/MagsTack/ledger.db).
 *
 * It is the wave-5 companion to import-square-ledger.ts (which seeded crm +
 * retail from the same ledger). This script:
 *   1. resolves the EXISTING 'Mags Tack' tenant (never creates a second one),
 *      seeds workforce builtin roles + owner (via app.seedTenant).
 *   2. creates the five inventory locations if absent + wires api_config
 *      default/damaged/quarantine location ids.
 *   3. catalog.importFromLedger from catalog_items + item_variations.
 *   4. customers.importProfiles keyed to crm ids via retail_customer_links,
 *      then seedBuiltinSegments.
 *   5. finance.import{Payments,Refunds,Payouts,Disputes} from the ledger.
 *   6. loyalty gift cards (real balances) + finance liability snapshot.
 *   7. storefront first projection (publishStorefront) — non-excluded catalog.
 *   8. a final reconciliation gate block: every count vs its recomputed source
 *      truth; ANY mismatch exits non-zero.
 *
 * IDEMPOTENT end to end: re-running inserts nothing new (each step prints
 * 'unchanged'). It only READS the ledger (mode=ro) and only WRITES the tenant
 * db. It never touches a network and never fabricates a number: an unknown fee
 * or a zero-balance gift card is reported honestly, not invented.
 *
 * Run from the repo root:
 *   PLATFORM_DB_PATH=/path/to/mags-tack.db LEDGER_DB_PATH=~/MagsTack/ledger.db \
 *     npm --workspace @blacklabel/api run seed-mags
 */
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import type { Kysely } from 'kysely';
import { asCoreDb, nowIso } from '@blacklabel/core';
import { createDb, runMigrations } from '@blacklabel/db';
import {
  importFromLedger,
  type LedgerItem,
  type CatalogDatabase,
} from '@blacklabel/catalog';
import {
  importProfiles,
  seedBuiltinSegments,
  normalizeEmail,
  normalizePhone,
  type ImportRow,
  type CustomersDatabase,
} from '@blacklabel/customers';
import {
  importPayments,
  importRefunds,
  importPayouts,
  importDisputes,
  recordLiabilitySnapshot,
  type ImportPaymentInput,
  type ImportRefundInput,
  type ImportPayoutInput,
  type ImportDisputeInput,
  type FinanceSourceKind,
  type FinanceDatabase,
} from '@blacklabel/finance';
import {
  issueGiftCard,
  giftCardLiability,
  type LoyaltyDatabase,
} from '@blacklabel/loyalty';
import {
  createLocation,
  verifyConservation,
  type LocationKind,
  type InventoryDatabase,
} from '@blacklabel/inventory';
import {
  publishStorefront,
  getLiveRun,
  storefrontMigrations,
  type PublishItemInput,
  type PublishSource,
  type StorefrontDatabase,
} from '@blacklabel/storefront';
import { createApp, type PlatformApp, type PlatformDatabase } from './app';
import type { ApiDatabase } from './migrations';
import { CONFIG_KEYS, setConfig } from './config';

const ACTOR = 'seed-mags-tenant';
const TENANT_NAME = 'Mags Tack';

/** Narrow the one shared db to a module's view (same pattern as app.ts). */
function as<T>(d: Kysely<PlatformDatabase>): Kysely<T> {
  return d as unknown as Kysely<T>;
}

const blankToNull = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

/* ================================================================== *
 * Ledger row shapes + reader (main-only; the seed steps take arrays)
 * ================================================================== */

export interface LedgerCustomer {
  id: string;
  given_name: string | null;
  family_name: string | null;
  email: string | null;
  phone: string | null;
}
export interface LedgerPayment {
  id: string;
  created_at: string | null;
  status: string | null;
  amount_cents: number | null;
  source_type: string | null;
  card_brand: string | null;
  processing_fee_cents: number | null;
  order_id: string | null;
}
export interface LedgerRefund {
  id: string;
  created_at: string | null;
  status: string | null;
  amount_cents: number | null;
  payment_id: string | null;
}
export interface LedgerPayout {
  id: string;
  created_at: string | null;
  status: string | null;
  amount_cents: number | null;
}
export interface LedgerDispute {
  id: string;
  created_at: string | null;
  state: string | null;
  amount_cents: number | null;
  payment_id: string | null;
}
export interface LedgerGiftCard {
  id: string;
  state: string | null;
  balance_cents: number | null;
}

export interface LedgerData {
  items: LedgerItem[];
  customers: LedgerCustomer[];
  payments: LedgerPayment[];
  refunds: LedgerRefund[];
  payouts: LedgerPayout[];
  disputes: LedgerDispute[];
  giftCards: LedgerGiftCard[];
}

/** Read every table this seed needs out of the read-only ledger into arrays. */
export function readLedger(ledger: Database.Database): LedgerData {
  const catalogItems = ledger
    .prepare('SELECT id, name, description, category_name FROM catalog_items ORDER BY id')
    .all() as { id: string; name: string | null; description: string | null; category_name: string | null }[];
  const variations = ledger
    .prepare(
      'SELECT id, item_id, name, price_cents, sku, upc, upc_normalized FROM item_variations ORDER BY item_id, id',
    )
    .all() as {
    id: string;
    item_id: string;
    name: string | null;
    price_cents: number | null;
    sku: string | null;
    upc: string | null;
    upc_normalized: string | null;
  }[];

  const varsByItem = new Map<string, LedgerItem['variations']>();
  for (const v of variations) {
    let arr = varsByItem.get(v.item_id);
    if (!arr) {
      arr = [];
      varsByItem.set(v.item_id, arr);
    }
    arr.push({
      sourceVariationId: v.id,
      name: v.name,
      sku: v.sku,
      upc: v.upc,
      upcNormalized: v.upc_normalized,
      priceCents: v.price_cents,
      // ledger has no track_inventory column → importer default (true) applies.
    });
  }
  const items: LedgerItem[] = catalogItems.map((ci) => ({
    sourceItemId: ci.id,
    name: ci.name ?? '(unnamed item)',
    description: ci.description,
    categoryName: ci.category_name,
    variations: varsByItem.get(ci.id) ?? [],
  }));

  return {
    items,
    customers: ledger
      .prepare('SELECT id, given_name, family_name, email, phone FROM customers ORDER BY id')
      .all() as LedgerCustomer[],
    payments: ledger
      .prepare(
        'SELECT id, created_at, status, amount_cents, source_type, card_brand, processing_fee_cents, order_id FROM payments ORDER BY id',
      )
      .all() as LedgerPayment[],
    refunds: ledger
      .prepare('SELECT id, created_at, status, amount_cents, payment_id FROM refunds ORDER BY id')
      .all() as LedgerRefund[],
    payouts: ledger
      .prepare('SELECT id, created_at, status, amount_cents FROM payouts ORDER BY id')
      .all() as LedgerPayout[],
    disputes: ledger
      .prepare('SELECT id, created_at, state, amount_cents, payment_id FROM disputes ORDER BY id')
      .all() as LedgerDispute[],
    giftCards: ledger
      .prepare('SELECT id, state, balance_cents FROM gift_cards ORDER BY id')
      .all() as LedgerGiftCard[],
  };
}

/* ================================================================== *
 * Pure mappers (unit-tested directly)
 * ================================================================== */

/** Square source_type/card_brand → finance tender kind (never fabricated). */
export function mapSourceKind(
  sourceType: string | null | undefined,
  cardBrand: string | null | undefined,
): FinanceSourceKind {
  if ((cardBrand ?? '').toUpperCase() === 'SQUARE_GIFT_CARD') return 'gift_card';
  switch ((sourceType ?? '').toUpperCase()) {
    case 'CARD':
      return 'card';
    case 'CASH':
      return 'cash';
    case 'WALLET':
      return 'wallet';
    case 'EXTERNAL':
    default:
      return 'external';
  }
}

export interface PaymentBuild {
  inputs: ImportPaymentInput[];
  withFee: number;
  withoutFee: number;
  unusable: number;
}

/**
 * Map ledger payments → finance import inputs. Fee honesty: Square records a
 * per-payment processing fee, but only on SOME rows. When the fee is NULL the
 * cost is UNKNOWN — we import fee_cents=0 (schema is NOT NULL) and COUNT it as
 * "without fee" rather than inventing a non-zero number. net = amount - fee.
 */
export function buildPaymentInputs(rows: LedgerPayment[]): PaymentBuild {
  const inputs: ImportPaymentInput[] = [];
  let withFee = 0;
  let withoutFee = 0;
  let unusable = 0;
  for (const p of rows) {
    if (!p.created_at || !p.status || p.amount_cents === null) {
      unusable += 1;
      continue;
    }
    const hasFee = p.processing_fee_cents !== null && p.processing_fee_cents !== undefined;
    const feeCents = hasFee ? (p.processing_fee_cents as number) : 0;
    if (hasFee) withFee += 1;
    else withoutFee += 1;
    inputs.push({
      sourcePaymentId: p.id,
      orderRef: blankToNull(p.order_id),
      amountCents: p.amount_cents,
      feeCents,
      netCents: p.amount_cents - feeCents,
      sourceKind: mapSourceKind(p.source_type, p.card_brand),
      cardBrand: blankToNull(p.card_brand),
      status: p.status,
      occurredAt: p.created_at,
    });
  }
  return { inputs, withFee, withoutFee, unusable };
}

export function buildRefundInputs(rows: LedgerRefund[]): { inputs: ImportRefundInput[]; unusable: number } {
  const inputs: ImportRefundInput[] = [];
  let unusable = 0;
  for (const r of rows) {
    if (!r.created_at || r.amount_cents === null || !r.payment_id) {
      unusable += 1;
      continue;
    }
    inputs.push({
      sourceRefundId: r.id,
      paymentRef: r.payment_id,
      amountCents: r.amount_cents,
      occurredAt: r.created_at,
    });
  }
  return { inputs, unusable };
}

export function buildPayoutInputs(rows: LedgerPayout[]): { inputs: ImportPayoutInput[]; unusable: number } {
  const inputs: ImportPayoutInput[] = [];
  let unusable = 0;
  for (const p of rows) {
    if (!p.created_at || !p.status || p.amount_cents === null) {
      unusable += 1;
      continue;
    }
    inputs.push({
      sourcePayoutId: p.id,
      amountCents: p.amount_cents,
      status: p.status,
      paidAt: p.created_at,
    });
  }
  return { inputs, unusable };
}

export function buildDisputeInputs(rows: LedgerDispute[]): { inputs: ImportDisputeInput[]; unusable: number } {
  const inputs: ImportDisputeInput[] = [];
  let unusable = 0;
  for (const d of rows) {
    if (!d.created_at || !d.state || d.amount_cents === null) {
      unusable += 1;
      continue;
    }
    inputs.push({
      sourceDisputeId: d.id,
      paymentRef: blankToNull(d.payment_id),
      amountCents: d.amount_cents,
      status: d.state,
      occurredAt: d.created_at,
    });
  }
  return { inputs, unusable };
}

/**
 * Build customers.importProfiles rows, joining each ledger (Square) customer to
 * its crm id via the retail_customer_links map that import-square-ledger wrote.
 * A ledger customer with no link is skipped and counted (never fabricated).
 */
export function buildCustomerImportRows(
  customers: LedgerCustomer[],
  linkBySource: Map<string, string>,
): { rows: ImportRow[]; unlinked: number } {
  const rows: ImportRow[] = [];
  let unlinked = 0;
  for (const c of customers) {
    const crmId = linkBySource.get(c.id);
    if (!crmId) {
      unlinked += 1;
      continue;
    }
    rows.push({
      crmCustomerId: crmId,
      email: blankToNull(c.email),
      phone: blankToNull(c.phone),
      firstName: blankToNull(c.given_name),
      lastName: blankToNull(c.family_name),
    });
  }
  return { rows, unlinked };
}

/* ================================================================== *
 * Gate harness
 * ================================================================== */

export interface GateCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function runGates(checks: GateCheck[], log: (s: string) => void = console.log): number {
  let failures = 0;
  for (const c of checks) {
    log(`${c.ok ? 'GATE PASS' : 'GATE FAIL'}  ${c.name}  ${c.detail}`);
    if (!c.ok) failures += 1;
  }
  return failures;
}

/* ================================================================== *
 * Seed steps (each idempotent; take the shared db + parsed arrays)
 * ================================================================== */

export const LOCATION_SEEDS: { name: string; kind: LocationKind; configKey?: string }[] = [
  { name: 'Warehouse', kind: 'warehouse', configKey: CONFIG_KEYS.defaultLocation },
  { name: 'Trailer', kind: 'trailer' },
  { name: 'Damaged', kind: 'damaged', configKey: CONFIG_KEYS.damagedLocation },
  { name: 'Quarantine', kind: 'quarantine', configKey: CONFIG_KEYS.quarantineLocation },
  { name: 'Fulfillment Staging', kind: 'fulfillment_staging' },
];

export interface LocationSeedResult {
  created: number;
  existing: number;
  ids: Record<string, string>;
}

export async function seedLocations(
  db: Kysely<PlatformDatabase>,
  tenantId: string,
): Promise<LocationSeedResult> {
  const idb = as<InventoryDatabase>(db);
  const ids: Record<string, string> = {};
  let created = 0;
  let existing = 0;
  for (const seed of LOCATION_SEEDS) {
    const found = await idb
      .selectFrom('inventory_locations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('name', '=', seed.name)
      .orderBy('id')
      .executeTakeFirst();
    let locId: string;
    if (found) {
      locId = found.id;
      existing += 1;
    } else {
      const row = await createLocation(idb, tenantId, ACTOR, { name: seed.name, kind: seed.kind });
      locId = row.id;
      created += 1;
    }
    ids[seed.name] = locId;
    if (seed.configKey) await setConfig(as<ApiDatabase>(db), tenantId, seed.configKey, locId);
  }
  return { created, existing, ids };
}

export async function seedCatalog(
  db: Kysely<PlatformDatabase>,
  tenantId: string,
  items: LedgerItem[],
  events: PlatformApp['events'],
) {
  return importFromLedger(as<CatalogDatabase>(db), tenantId, items, { actor: ACTOR, events });
}

export async function seedCustomers(
  db: Kysely<PlatformDatabase>,
  tenantId: string,
  customers: LedgerCustomer[],
) {
  // Read the square→crm mapping the retail import wrote.
  const links = await db
    .selectFrom('retail_customer_links')
    .select(['source_id', 'crm_customer_id'])
    .where('tenant_id', '=', tenantId)
    .execute();
  const linkBySource = new Map(links.map((l) => [l.source_id, l.crm_customer_id]));
  const { rows, unlinked } = buildCustomerImportRows(customers, linkBySource);
  const summary = await importProfiles(as<CustomersDatabase>(db), tenantId, rows);
  const segments = await seedBuiltinSegments(as<CustomersDatabase>(db), tenantId);
  return { summary, unlinked, linkCount: links.length, segments: segments.length };
}

export interface FinanceSeedResult {
  payments: Awaited<ReturnType<typeof importPayments>>;
  refunds: Awaited<ReturnType<typeof importRefunds>>;
  payouts: Awaited<ReturnType<typeof importPayouts>>;
  disputes: Awaited<ReturnType<typeof importDisputes>>;
  build: PaymentBuild;
  refundUnusable: number;
  payoutUnusable: number;
  disputeUnusable: number;
}

export async function seedFinance(
  db: Kysely<PlatformDatabase>,
  tenantId: string,
  data: Pick<LedgerData, 'payments' | 'refunds' | 'payouts' | 'disputes'>,
  events: PlatformApp['events'],
): Promise<FinanceSeedResult> {
  const fdb = as<FinanceDatabase>(db);
  const build = buildPaymentInputs(data.payments);
  const refund = buildRefundInputs(data.refunds);
  const payout = buildPayoutInputs(data.payouts);
  const dispute = buildDisputeInputs(data.disputes);
  const payments = await importPayments(fdb, events, tenantId, ACTOR, build.inputs);
  const refunds = await importRefunds(fdb, events, tenantId, ACTOR, refund.inputs);
  const payouts = await importPayouts(fdb, events, tenantId, ACTOR, payout.inputs);
  const disputes = await importDisputes(fdb, events, tenantId, ACTOR, dispute.inputs);
  return {
    payments,
    refunds,
    payouts,
    disputes,
    build,
    refundUnusable: refund.unusable,
    payoutUnusable: payout.unusable,
    disputeUnusable: dispute.unusable,
  };
}

export interface GiftCardSeedResult {
  issued: number;
  existing: number;
  zeroBalanceSkipped: number;
  nonActiveSkipped: number;
  issuedCents: number;
  liabilityCents: number;
}

/**
 * Issue a loyalty gift card per ACTIVE ledger gift card that carries a positive
 * balance, using the real Square GAN (the ledger's gift-card id) as the code so
 * re-runs are idempotent. Zero-balance ACTIVE cards cannot be issued (issue
 * requires >0) and are reported, not invented. Then record the finance liability
 * snapshot = the summed outstanding balance.
 */
export async function seedGiftCards(
  db: Kysely<PlatformDatabase>,
  tenantId: string,
  cards: LedgerGiftCard[],
): Promise<GiftCardSeedResult> {
  const ldb = as<LoyaltyDatabase>(db);
  let issued = 0;
  let existing = 0;
  let zeroBalanceSkipped = 0;
  let nonActiveSkipped = 0;
  let issuedCents = 0;
  for (const gc of cards) {
    if ((gc.state ?? '').toUpperCase() !== 'ACTIVE') {
      nonActiveSkipped += 1;
      continue;
    }
    const bal = gc.balance_cents ?? 0;
    if (bal <= 0) {
      zeroBalanceSkipped += 1;
      continue;
    }
    const clash = await ldb
      .selectFrom('loyalty_gift_cards')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('code', '=', gc.id)
      .executeTakeFirst();
    if (clash) {
      existing += 1;
      issuedCents += bal;
      continue;
    }
    await issueGiftCard(ldb, tenantId, ACTOR, { code: gc.id, initialCents: bal });
    issued += 1;
    issuedCents += bal;
  }

  const liability = await giftCardLiability(ldb, tenantId);
  // Snapshot is append-only history; record one per run only when the value
  // changed from the latest snapshot (idempotent trend line).
  const fdb = as<FinanceDatabase>(db);
  const latest = await fdb
    .selectFrom('finance_liability_snapshots')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('source', '=', 'square_import')
    .orderBy('as_of', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (!latest || latest.outstanding_cents !== liability.outstandingCents) {
    await recordLiabilitySnapshot(fdb, tenantId, ACTOR, {
      outstandingCents: liability.outstandingCents,
      source: 'square_import',
      asOf: nowIso(),
    });
  }

  return {
    issued,
    existing,
    zeroBalanceSkipped,
    nonActiveSkipped,
    issuedCents,
    liabilityCents: liability.outstandingCents,
  };
}

export interface StorefrontSeedResult {
  published: boolean;
  itemCount: number;
  variationCount: number;
  pageCount: number;
  status: string;
  failures: string[];
  runId: string | null;
}

/** Build a PublishSource from the tenant's non-excluded catalog (published). */
/** One storefront product image: local basename + non-empty alt (a11y gate). */
export type PublishImage = { path: string; alt: string };

/**
 * Build a source-item-id → images map from the read-only ledger. Resolves each
 * product's `image_ids` JSON to the locally-downloaded file basenames (only
 * images with exists_locally=1), alt-texted with the product name so the
 * storefront a11y gate (every <img> needs non-empty alt) passes. Products
 * without a local image map to [] and render their text placeholder.
 */
export function buildLedgerImageMap(ledger: Database.Database): Map<string, PublishImage[]> {
  // image id → local file basename (only files actually on disk).
  const basenameById = new Map<string, string>();
  for (const row of ledger
    .prepare("SELECT id, local_file FROM images WHERE exists_locally=1 AND local_file IS NOT NULL AND local_file!=''")
    .all() as { id: string; local_file: string }[]) {
    const base = row.local_file.split('/').pop();
    if (base) basenameById.set(row.id, base);
  }

  const map = new Map<string, PublishImage[]>();
  for (const item of ledger
    .prepare("SELECT id, name, image_ids FROM catalog_items WHERE image_ids IS NOT NULL AND image_ids!='' AND image_ids!='[]'")
    .all() as { id: string; name: string | null; image_ids: string }[]) {
    let ids: string[];
    try {
      ids = JSON.parse(item.image_ids) as string[];
    } catch {
      continue;
    }
    const alt = (item.name ?? 'Product').trim() || 'Product';
    const imgs: PublishImage[] = [];
    for (const id of ids) {
      const base = basenameById.get(id);
      if (base) imgs.push({ path: base, alt: imgs.length === 0 ? alt : `${alt} — photo ${imgs.length + 1}` });
    }
    if (imgs.length) map.set(item.id, imgs);
  }
  return map;
}

export async function buildPublishSource(
  db: Kysely<PlatformDatabase>,
  tenantId: string,
  imageMap?: Map<string, PublishImage[]>,
): Promise<{ source: PublishSource; itemCount: number; itemsWithImages: number }> {
  const cdb = as<CatalogDatabase>(db);
  const depts = await cdb.selectFrom('catalog_departments').selectAll().where('tenant_id', '=', tenantId).execute();
  const brands = await cdb.selectFrom('catalog_brands').selectAll().where('tenant_id', '=', tenantId).execute();
  const deptById = new Map(depts.map((d) => [d.id, d]));
  const brandById = new Map(brands.map((b) => [b.id, b]));

  const products = await cdb
    .selectFrom('catalog_products')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('archived', '=', 0)
    .where('publication_state', '!=', 'excluded')
    .orderBy('id')
    .execute();
  const variations = await cdb
    .selectFrom('catalog_variations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('archived', '=', 0)
    .orderBy('product_id')
    .orderBy('id')
    .execute();
  const varsByProduct = new Map<string, typeof variations>();
  for (const v of variations) {
    let arr = varsByProduct.get(v.product_id);
    if (!arr) {
      arr = [];
      varsByProduct.set(v.product_id, arr);
    }
    arr.push(v);
  }

  const items: PublishItemInput[] = products.map((p) => {
    const dept = p.department_id ? deptById.get(p.department_id) : undefined;
    const brand = p.brand_id ? brandById.get(p.brand_id) : undefined;
    return {
      sourceProductId: p.source_item_id,
      name: p.name,
      description: p.description,
      departmentSlug: dept?.slug ?? null,
      departmentName: dept?.name ?? null,
      categoryName: p.source_category_name,
      brandSlug: brand?.slug ?? null,
      brandName: brand?.name ?? null,
      // First projection publishes every non-excluded product.
      publicationState: 'published' as const,
      images: imageMap?.get(p.source_item_id) ?? [],
      variations: (varsByProduct.get(p.id) ?? []).map((v) => ({
        sourceVariationId: v.source_variation_id,
        name: v.name,
        sku: v.sku,
        priceCents: v.price_cents,
      })),
    };
  });

  const source: PublishSource = {
    listPublishableItems: () => items,
    // No stock counts exist in the source → every variation is honestly 'unknown'.
    availabilityFor: () => ({}),
  };
  const itemsWithImages = items.filter((i) => (i.images?.length ?? 0) > 0).length;
  return { source, itemCount: items.length, itemsWithImages };
}

export async function seedStorefront(
  db: Kysely<PlatformDatabase>,
  tenantId: string,
  events: PlatformApp['events'],
  imageMap?: Map<string, PublishImage[]>,
): Promise<StorefrontSeedResult & { itemsWithImages?: number }> {
  const sdb = as<StorefrontDatabase>(db);
  // storefront is a wave-3 projection lane not yet wired into apps/api's
  // allMigrations; the seed owns its projection tables (idempotent).
  await runMigrations(sdb, storefrontMigrations);
  const existingLive = await getLiveRun(sdb, tenantId);
  if (existingLive) {
    return {
      published: false,
      itemCount: existingLive.item_count,
      variationCount: existingLive.variation_count,
      pageCount: existingLive.page_count,
      status: existingLive.status,
      failures: [],
      runId: existingLive.id,
    };
  }
  const { source, itemsWithImages } = await buildPublishSource(db, tenantId, imageMap);
  const res = await publishStorefront({ db: sdb, tenantId, source, events, actor: ACTOR });
  return {
    published: true,
    itemCount: res.itemCount,
    variationCount: res.variationCount,
    pageCount: res.pageCount,
    status: res.status,
    failures: res.failures,
    runId: res.runId,
    itemsWithImages,
  };
}

/* ================================================================== *
 * main
 * ================================================================== */

async function main(): Promise<void> {
  const dbPath = process.env.PLATFORM_DB_PATH;
  if (!dbPath) {
    console.error('PLATFORM_DB_PATH is required (the tenant db to seed).');
    process.exit(2);
  }
  const ledgerPath = (process.env.LEDGER_DB_PATH ?? path.join(os.homedir(), 'MagsTack', 'ledger.db')).replace(
    /^~(?=$|\/)/,
    os.homedir(),
  );

  console.log(`seed-mags-tenant\n  tenant db : ${dbPath}\n  ledger    : ${ledgerPath} (read-only)`);

  const ledger = new Database(ledgerPath, { readonly: true, fileMustExist: true });
  const db = createDb<PlatformDatabase>(dbPath);
  const platform = await createApp({ db, disableRateLimit: true });
  const { events } = platform;

  /* ---- 1. tenant + owner + roles ---- */
  const tenant = await asCoreDb(db)
    .selectFrom('tenants')
    .selectAll()
    .where('name', '=', TENANT_NAME)
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirst();
  if (!tenant) {
    console.error(`Tenant "${TENANT_NAME}" not found — run import-square-ledger first. Refusing to create a second tenant.`);
    process.exit(1);
  }
  const tenantId = tenant.id;
  const seededOwner = await platform.seedTenant(tenantId, { ownerName: 'Owner', actor: ACTOR });
  console.log(
    `\n[1] tenant "${tenant.name}" id=${tenantId} | owner=${seededOwner.ownerUserId} (${seededOwner.createdOwner ? 'created' : 'existing'}) | builtin roles seeded`,
  );

  /* ---- read the ledger into arrays ---- */
  const data = readLedger(ledger);

  /* ---- 2. inventory locations ---- */
  const loc = await seedLocations(db, tenantId);
  console.log(
    `[2] locations: created ${loc.created}, existing ${loc.existing}${loc.created === 0 ? ' (unchanged)' : ''} | default=${loc.ids['Warehouse']} damaged=${loc.ids['Damaged']} quarantine=${loc.ids['Quarantine']}`,
  );

  /* ---- 3. catalog ---- */
  const cat = await seedCatalog(db, tenantId, data.items, events);
  const catUnchanged = cat.productsInserted === 0 && cat.variationsInserted === 0 && cat.barcodesInserted === 0;
  console.log(
    `[3] catalog: items ${cat.stats.items} (ins ${cat.productsInserted}, upd ${cat.productsUpdated}), ` +
      `variations ${cat.stats.variations} (ins ${cat.variationsInserted}, upd ${cat.variationsUpdated}), ` +
      `skus ${cat.stats.skus}, upcs ${cat.stats.upcs}, barcodes-ins ${cat.barcodesInserted}, ` +
      `excluded ${cat.stats.excluded}, needs_review_categories ${cat.stats.needsReviewCategories}${catUnchanged ? ' (unchanged)' : ''}`,
  );

  /* ---- 4. customers ---- */
  const cust = await seedCustomers(db, tenantId, data.customers);
  const custUnchanged = cust.summary.imported === 0;
  console.log(
    `[4] customers: profiles imported ${cust.summary.imported}, updated ${cust.summary.updated} ` +
      `(links ${cust.linkCount}, unlinked ${cust.unlinked}) | segments ${cust.segments}${custUnchanged ? ' (unchanged)' : ''}`,
  );

  /* ---- 5. finance ---- */
  const fin = await seedFinance(db, tenantId, data, events);
  const finUnchanged =
    fin.payments.inserted === 0 && fin.refunds.inserted === 0 && fin.payouts.inserted === 0 && fin.disputes.inserted === 0;
  console.log(
    `[5] finance: payments ins ${fin.payments.inserted}/upd ${fin.payments.updated}/skip ${fin.payments.skipped} ` +
      `(with-fee ${fin.build.withFee}, without-fee ${fin.build.withoutFee}); ` +
      `refunds ins ${fin.refunds.inserted}; payouts ins ${fin.payouts.inserted}; disputes ins ${fin.disputes.inserted}` +
      `${finUnchanged ? ' (unchanged)' : ''}`,
  );

  /* ---- 6. gift cards + liability ---- */
  const gift = await seedGiftCards(db, tenantId, data.giftCards);
  console.log(
    `[6] gift cards: issued ${gift.issued}, already-present ${gift.existing}, zero-balance-skipped ${gift.zeroBalanceSkipped}, ` +
      `non-active-skipped ${gift.nonActiveSkipped} | outstanding liability ${gift.liabilityCents}¢${gift.issued === 0 ? ' (unchanged)' : ''}`,
  );

  /* ---- 7. storefront (with product images from the ledger) ---- */
  const imageMap = buildLedgerImageMap(ledger);
  const store = await seedStorefront(db, tenantId, events, imageMap);
  console.log(
    `[7] storefront: ${store.published ? 'published' : 'unchanged (live run exists)'} run=${store.runId} ` +
      `status=${store.status} items=${store.itemCount} variations=${store.variationCount} pages=${store.pageCount} ` +
      `items-with-images=${store.itemsWithImages ?? 0} (image map ${imageMap.size} products)` +
      (store.failures.length ? ` FAILURES=${store.failures.slice(0, 5).join('; ')}` : ''),
  );

  /* ================= 8. reconciliation gate block ================= */
  console.log('\n[8] RECONCILIATION');

  // Recompute source truths straight from the ledger.
  const src = {
    catalogItems: (ledger.prepare('SELECT COUNT(*) n FROM catalog_items').get() as { n: number }).n,
    variations: (ledger.prepare('SELECT COUNT(*) n FROM item_variations').get() as { n: number }).n,
    skus: (ledger.prepare("SELECT COUNT(*) n FROM item_variations WHERE sku IS NOT NULL AND sku!=''").get() as { n: number }).n,
    upcs: (ledger.prepare("SELECT COUNT(*) n FROM item_variations WHERE upc IS NOT NULL AND upc!=''").get() as { n: number }).n,
    customers: (ledger.prepare('SELECT COUNT(*) n FROM customers').get() as { n: number }).n,
    completedGross: (
      ledger.prepare("SELECT COALESCE(SUM(amount_cents),0) g FROM payments WHERE status='COMPLETED'").get() as { g: number }
    ).g,
    feeTotal: (
      ledger.prepare('SELECT COALESCE(SUM(processing_fee_cents),0) f FROM payments').get() as { f: number }
    ).f,
    refunds: (ledger.prepare('SELECT COUNT(*) n FROM refunds').get() as { n: number }).n,
    payouts: (ledger.prepare('SELECT COUNT(*) n FROM payouts').get() as { n: number }).n,
    payoutsPaid: (ledger.prepare("SELECT COUNT(*) n FROM payouts WHERE status='PAID'").get() as { n: number }).n,
    payoutsSent: (ledger.prepare("SELECT COUNT(*) n FROM payouts WHERE status='SENT'").get() as { n: number }).n,
    disputes: (ledger.prepare('SELECT COUNT(*) n FROM disputes').get() as { n: number }).n,
    giftActive: (ledger.prepare("SELECT COUNT(*) n FROM gift_cards WHERE state='ACTIVE'").get() as { n: number }).n,
    giftBal: (
      ledger.prepare("SELECT COALESCE(SUM(balance_cents),0) b FROM gift_cards WHERE state='ACTIVE'").get() as { b: number }
    ).b,
  };
  // Expected email/phone via the SAME normalization the profile importer uses.
  let expEmail = 0;
  let expPhone = 0;
  for (const c of data.customers) {
    if (normalizeEmail(blankToNull(c.email)) !== null) expEmail += 1;
    if (normalizePhone(blankToNull(c.phone)) !== null) expPhone += 1;
  }

  // Read back the tenant db.
  const count = async (table: keyof PlatformDatabase, extra?: (q: any) => any): Promise<number> => {
    let q = db.selectFrom(table as any).select((eb) => eb.fn.countAll<number>().as('n')).where('tenant_id', '=', tenantId);
    if (extra) q = extra(q);
    const r = await q.executeTakeFirst();
    return Number((r as { n: number } | undefined)?.n ?? 0);
  };
  const sum = async (table: keyof PlatformDatabase, col: string, extra?: (q: any) => any): Promise<number> => {
    let q = db.selectFrom(table as any).select((eb) => eb.fn.sum<number>(col as any).as('s')).where('tenant_id', '=', tenantId);
    if (extra) q = extra(q);
    const r = await q.executeTakeFirst();
    return Number((r as { s: number | null } | undefined)?.s ?? 0);
  };

  const tProducts = await count('catalog_products');
  const tVariations = await count('catalog_variations');
  const tSkus = await count('catalog_variations', (q) => q.where('sku', 'is not', null).where('sku', '!=', ''));
  const tBarcodes = await count('catalog_barcodes');
  const tExcluded = await count('catalog_products', (q) => q.where('publication_state', '=', 'excluded'));
  const tProfiles = await count('customers_profiles');
  const tEmail = await count('customers_profiles', (q) => q.where('email_normalized', 'is not', null));
  const tPhone = await count('customers_profiles', (q) => q.where('phone_normalized', 'is not', null));
  const tPayments = await count('finance_payments');
  const tCompletedGross = await sum('finance_payments', 'amount_cents', (q) => q.where('status', '=', 'COMPLETED'));
  const tFeeTotal = await sum('finance_payments', 'fee_cents');
  const tRefunds = await count('finance_refunds');
  const tPayouts = await count('finance_payouts');
  const tPayoutsPaid = await count('finance_payouts', (q) => q.where('status', '=', 'PAID'));
  const tPayoutsSent = await count('finance_payouts', (q) => q.where('status', '=', 'SENT'));
  const tDisputes = await count('finance_disputes');
  const tGiftActive = await count('loyalty_gift_cards', (q) => q.where('status', '=', 'active'));
  const live = await getLiveRun(as<StorefrontDatabase>(db), tenantId);

  const checks: GateCheck[] = [
    { name: 'catalog-items', ok: tProducts === src.catalogItems, detail: `tenant=${tProducts} ledger=${src.catalogItems}` },
    { name: 'catalog-variations', ok: tVariations === src.variations, detail: `tenant=${tVariations} ledger=${src.variations}` },
    { name: 'catalog-skus', ok: tSkus === src.skus, detail: `tenant=${tSkus} ledger=${src.skus}` },
    { name: 'catalog-upcs(barcodes)', ok: tBarcodes === src.upcs, detail: `tenant_barcodes=${tBarcodes} ledger_upcs=${src.upcs}` },
    { name: 'customer-profiles', ok: tProfiles === src.customers, detail: `tenant=${tProfiles} ledger=${src.customers}` },
    { name: 'customer-email', ok: tEmail === expEmail, detail: `tenant=${tEmail} expected(normalized)=${expEmail} raw=359` },
    { name: 'customer-phone', ok: tPhone === expPhone, detail: `tenant=${tPhone} expected(normalized)=${expPhone} raw=853` },
    { name: 'finance-payments-rows', ok: tPayments === fin.build.inputs.length, detail: `tenant=${tPayments} usable=${fin.build.inputs.length}` },
    { name: 'finance-completed-gross', ok: tCompletedGross === src.completedGross, detail: `tenant=${tCompletedGross} ledger=${src.completedGross}` },
    { name: 'finance-fee-total', ok: tFeeTotal === src.feeTotal, detail: `tenant=${tFeeTotal} ledger=${src.feeTotal} (with-fee ${fin.build.withFee}, without ${fin.build.withoutFee})` },
    { name: 'finance-refunds', ok: tRefunds === src.refunds, detail: `tenant=${tRefunds} ledger=${src.refunds}` },
    { name: 'finance-payouts', ok: tPayouts === src.payouts, detail: `tenant=${tPayouts} ledger=${src.payouts}` },
    { name: 'finance-payouts-paid', ok: tPayoutsPaid === src.payoutsPaid, detail: `tenant=${tPayoutsPaid} ledger=${src.payoutsPaid}` },
    { name: 'finance-payouts-sent', ok: tPayoutsSent === src.payoutsSent, detail: `tenant=${tPayoutsSent} ledger=${src.payoutsSent}` },
    { name: 'finance-disputes', ok: tDisputes === src.disputes, detail: `tenant=${tDisputes} ledger=${src.disputes}` },
    {
      name: 'giftcard-liability',
      ok: gift.liabilityCents === src.giftBal,
      detail: `outstanding=${gift.liabilityCents} ledger_active_bal=${src.giftBal} | issued_cards=${tGiftActive} (source ACTIVE=${src.giftActive}, zero-bal=${gift.zeroBalanceSkipped})`,
    },
    { name: 'storefront-live-run', ok: live != null && live.status === 'live', detail: `run=${live?.id ?? 'none'} status=${live?.status ?? 'none'} items=${live?.item_count ?? 0}` },
    { name: 'storefront-published=non-excluded', ok: live != null && live.item_count === tProducts - tExcluded, detail: `live_items=${live?.item_count ?? 0} non_excluded_products=${tProducts - tExcluded}` },
  ];

  // Inventory conservation (trivially ok — no movements yet).
  const conservation = await verifyConservation(as<InventoryDatabase>(db), tenantId);
  checks.push({ name: 'inventory-conservation', ok: conservation.ok, detail: `ok=${conservation.ok} drift=${conservation.drift.length}` });

  const failures = runGates(checks);

  // Total table counts (informational).
  console.log(
    `\nTABLE TOTALS  catalog_products=${tProducts} catalog_variations=${tVariations} catalog_barcodes=${tBarcodes} ` +
      `customers_profiles=${tProfiles} finance_payments=${tPayments} finance_refunds=${tRefunds} finance_payouts=${tPayouts} ` +
      `finance_disputes=${tDisputes} loyalty_gift_cards=${tGiftActive} storefront_items=${live?.item_count ?? 0}`,
  );

  ledger.close();
  platform.detachEngine();
  await db.destroy();

  if (failures > 0) {
    console.error(`\n${failures} GATE(S) FAILED — the seed is NOT verified.`);
    process.exit(1);
  }
  console.log('\nALL GATES PASSED — Mags tenant seeded and verified against the ledger.');
}

// Only run when invoked directly (tests import the functions above).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith('seed-mags-tenant.ts');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
