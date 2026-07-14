/**
 * export-mags-site — publish + render the Mags Tack storefront to a
 * deploy-ready, self-contained static site.
 *
 * Modes:
 *   Default             — export the existing live publish run.
 *   REPUBLISH=1         — build a fresh publish run first (supersedes live).
 *   STOCK_SNAPSHOT_PATH — per-variant stock truth (tools/pull_store_stock.py,
 *                         pulled from the shop's own public store API). With
 *                         IN_STOCK_ONLY=1 the run publishes ONLY items the
 *                         live store shows as visible with >=1 not-sold-out
 *                         variation (the client's launch rule). Implies
 *                         REPUBLISH.
 *
 *   PLATFORM_DB_PATH=/path/to/seeded-mags.db \
 *   LEDGER_DB_PATH=~/MagsTack/ledger.db \
 *   STOCK_SNAPSHOT_PATH=~/MagsTack/data/stock-snapshot.json \
 *   IN_STOCK_ONLY=1 \
 *   OUT_DIR=~/MagsTack/store-site \
 *   IMAGE_DIR=~/MagsTack/data/images-web \
 *     tsx apps/api/src/export-mags-site.ts
 *
 * Reads ONLY the tenant db + read-only ledger + the snapshot json, renders to
 * `OUT_DIR`, copies referenced images, and runs the content gates INCLUDING
 * brand isolation (crossBrandTerms) — a client site must NEVER surface Black
 * Label or any other property. Deploying the output is a founder gate; this
 * tool only produces + proves the artifact.
 *
 * Exit 0 = all gates + brand isolation pass. Exit 1 = a gate failed (do not deploy).
 */
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { asCoreDb } from '@blacklabel/core';
import { createDb } from '@blacklabel/db';
import {
  exportStaticSite,
  publishStorefront,
  type OwnIdentity,
  type SiteConfig,
  type StorefrontDatabase,
} from '@blacklabel/storefront';
import type { Kysely } from 'kysely';
import type { PlatformDatabase } from './app';
import { buildLedgerImageMap, buildPublishSource, type StockSnapshot } from './seed-mags-tenant';

const TENANT_NAME = 'Mags Tack';

/**
 * Cross-brand terms that must NEVER appear on the Mags client site (founder
 * brand-isolation directive 2026-07-12). Own brand "Mags Tack" is allowed.
 */
// Distinctive brand phrases + full domains only — NOT generic words ("sunset",
// "vigil", "academy") that legitimately occur in tack product names. Mirrors
// the founder check-brand-isolation.mjs authority (brand terms + fleet domains).
const CROSS_BRAND_TERMS = [
  'black label',
  'blacklabel',
  'blacklabelbots.com',
  'blacklabeltec.com',
  'blbestate.com',
  'blvigil.com',
  'sunsetmixing.com',
  'asgolfclothing.com',
  'gcwars.com',
  'addison simmons golf',
];

/**
 * The shop's OWN public identity — verified against the client's live site
 * (research/brand-brief.md 2026-07-14): footer mailto, contact page, and
 * Facebook all publish this email/phone; social handles from Square location.
 */
const OWN_IDENTITY: OwnIdentity = {
  emails: ['info@magsmobiletack.com'],
  phones: ['(678) 850-7910'],
  linkHosts: ['www.instagram.com', 'www.facebook.com'],
};

/**
 * Brand config. Copy rules: taglines/policy text are the client's OWN
 * published words (live site, 2026-07-14) — never an invented offer or
 * policy. The announcement bar quotes their live "Free Shipping" info tile.
 */
const SITE_CONFIG: Partial<SiteConfig> = {
  brandName: 'Mags Tack',
  tagline: 'Quality tack for every ride',
  logoFile: 'logo-mark.png',
  announcement: 'Free shipping on U.S. orders over $100 — $9 flat rate under.',
  contact: {
    phone: '(678) 850-7910',
    email: 'info@magsmobiletack.com',
    instagram: 'magsmobile',
    facebook: 'MagsMobileTack',
    city: 'Newnan, Georgia',
  },
  aboutParagraphs: [
    'Mags Tack is a family-run tack shop from Newnan, Georgia — the store that comes to you. Our mobile units set up at horse shows across the region with quality tack, rider apparel, and horse care.',
    'We carry the brands riders ask for — LeMieux, Equinavia, Chestnut Bay, Horze, TuffRider, and more — for men, women, and kids, plus the LeMieux toy line for the youngest horse lovers.',
    'You can also visit us by appointment at 28 Dogwood Rd, Newnan, GA 30263, or follow us on Facebook and Instagram to see if one of our mobile units is at a horse show near you.',
  ],
  infoPages: [
    {
      slug: 'shipping-and-returns',
      title: 'Shipping & returns',
      paragraphs: [
        'Orders are processed within 24 hours and shipped within 48 hours via USPS or UPS standard shipping.',
        'U.S. shipping is free on orders over $100 and a $9 flat rate on orders under $100.',
        'Returns are accepted within 14 days of delivery for a refund, exchange, or store credit. Items must be unused and unworn with tags attached.',
        'Please request return authorization first by emailing info@magsmobiletack.com with your order number and the items you wish to return — we will provide a return label after approval.',
        'Final-sale and clearance items are not returnable. Damaged or incorrect items must be reported within 3 days of delivery.',
      ],
    },
  ],
};

function expand(p: string): string {
  return p.replace(/^~(?=$|\/)/, os.homedir());
}

async function main(): Promise<void> {
  const dbPath = process.env.PLATFORM_DB_PATH;
  if (!dbPath) {
    console.error('PLATFORM_DB_PATH is required (a seeded tenant db with a live storefront run).');
    process.exit(2);
  }
  const outDir = expand(process.env.OUT_DIR ?? path.join(os.homedir(), 'MagsTack', 'store-site'));
  const imageDir = expand(process.env.IMAGE_DIR ?? path.join(os.homedir(), 'MagsTack', 'data', 'images-web'));
  const snapshotPath = process.env.STOCK_SNAPSHOT_PATH ? expand(process.env.STOCK_SNAPSHOT_PATH) : null;
  const inStockOnly = process.env.IN_STOCK_ONLY === '1';
  const republish = process.env.REPUBLISH === '1' || snapshotPath != null;
  const assetDir = expand(process.env.BRAND_ASSET_DIR ?? path.join(os.homedir(), 'MagsTack', 'research', 'brand-assets'));

  if (inStockOnly && !snapshotPath) {
    console.error('IN_STOCK_ONLY=1 requires STOCK_SNAPSHOT_PATH (no stock truth → no in-stock filter).');
    process.exit(2);
  }

  console.log(
    `export-mags-site\n  tenant db : ${dbPath}\n  out       : ${outDir}\n  images    : ${imageDir}\n` +
      `  stock     : ${snapshotPath ?? '(none — availability unknown)'}\n  in-stock  : ${inStockOnly}\n  republish : ${republish}`,
  );

  const db = createDb<PlatformDatabase>(dbPath);
  const tenant = await asCoreDb(db)
    .selectFrom('tenants')
    .selectAll()
    .where('name', '=', TENANT_NAME)
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirst();
  if (!tenant) {
    console.error(`Tenant "${TENANT_NAME}" not found in ${dbPath}.`);
    process.exit(1);
  }
  const sdb = db as unknown as Kysely<StorefrontDatabase>;

  if (republish) {
    const ledgerPath = expand(process.env.LEDGER_DB_PATH ?? path.join(os.homedir(), 'MagsTack', 'ledger.db'));
    const ledger = new Database(ledgerPath, { readonly: true });
    const imageMap = buildLedgerImageMap(ledger);
    ledger.close();

    let stock;
    if (snapshotPath) {
      const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as StockSnapshot;
      const variantCount = Object.keys(snapshot.variants).length;
      if (!variantCount) {
        console.error(`Stock snapshot ${snapshotPath} has no variants — refusing to publish from it.`);
        process.exit(1);
      }
      console.log(`  snapshot  : ${snapshot.as_of} — ${variantCount} variants`);
      stock = { snapshot, inStockOnly, lowThreshold: 5 };
    }

    const { source, itemCount } = await buildPublishSource(db, tenant.id, imageMap, stock);
    console.log(`\nPUBLISHING ${itemCount} items…`);
    const pub = await publishStorefront({
      db: sdb,
      tenantId: tenant.id,
      source,
      config: SITE_CONFIG,
      actor: 'export-mags-site',
      crossBrandTerms: CROSS_BRAND_TERMS,
      ownIdentity: OWN_IDENTITY,
    });
    console.log(`  run ${pub.runId} → ${pub.status} (items ${pub.itemCount}, pages ${pub.pageCount})`);
    if (pub.status !== 'live') {
      for (const g of pub.gateResults.filter((g) => !g.pass)) {
        console.error(`  FAIL ${g.name}: ${g.failures.slice(0, 5).join(' | ')}`);
      }
      console.error('PUBLISH FAILED — previous live run (if any) kept.');
      process.exit(1);
    }
  }

  const stats = await exportStaticSite({
    db: db as never,
    tenantId: tenant.id,
    outDir,
    imageSourceDir: imageDir,
    clean: true,
    runGates: true,
    config: SITE_CONFIG,
    crossBrandTerms: CROSS_BRAND_TERMS,
    ownIdentity: OWN_IDENTITY,
    extraAssets: ['logo-mark.png', 'favicon.png']
      .filter((n) => existsSync(path.join(assetDir, n)))
      .map((n) => ({ sourcePath: path.join(assetDir, n), destName: n })),
  });

  console.log(
    `\nEXPORTED run=${stats.publishRunId}\n` +
      `  pages ${stats.pageCount} (html ${stats.htmlPageCount}), ${(stats.bytesWritten / 1e6).toFixed(1)} MB\n` +
      `  images copied ${stats.imagesCopied}, missing ${stats.imagesMissing}, search shards ${stats.searchIndexShards}`,
  );
  console.log('\nCONTENT GATES:');
  for (const g of stats.gateResults) {
    console.log(`  ${g.pass ? 'PASS' : 'FAIL'}  ${g.name}${g.pass ? '' : '  — ' + g.failures.slice(0, 5).join(' | ')}`);
  }

  await db.destroy();

  if (!stats.gatesPassed) {
    console.error('\nGATES FAILED — artifact is NOT deploy-ready.');
    process.exit(1);
  }
  console.log('\nALL CONTENT + BRAND-ISOLATION GATES PASSED — artifact is deploy-ready.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
