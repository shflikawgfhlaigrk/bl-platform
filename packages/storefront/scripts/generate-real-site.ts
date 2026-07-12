/**
 * generate-real-site.ts — build the REAL Mags Tack storefront from the local
 * ledger and prove every gate on real data.
 *
 * Integrator-land script (scripts/ is allowed to import catalog directly for
 * the exclusion law + category/brand mapping). READ-ONLY on ~/MagsTack/ledger.db.
 * Writes ONLY to ~/MagsTack/store-site/ (the generated static export). The
 * projection lives in an in-memory platform DB — nothing else is written.
 *
 * Run:  npx tsx packages/storefront/scripts/generate-real-site.ts
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import { coreMigrations, createTenant, asCoreDb } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  evaluateExclusion,
  mapCategory,
  extractBrand,
  DEPARTMENT_TREE,
} from '@blacklabel/catalog';
import {
  storefrontMigrations,
  publishStorefront,
  exportStaticSite,
  type PublishItemInput,
  type PublishSource,
  type StorefrontDatabase,
} from '../src/index';

const HOME = homedir();
const LEDGER = join(HOME, 'MagsTack', 'ledger.db');
const IMAGES_DIR = join(HOME, 'MagsTack', 'data', 'images');
const OUT_DIR = join(HOME, 'MagsTack', 'store-site');
const DATA_AS_OF = '2026-07-11'; // MAX(created_at) of the ledger, not wall-clock

const DEPT_NAME = new Map(DEPARTMENT_TREE.map((d) => [d.slug, d.name]));

interface LedgerVariation { id: string; name: string | null; price_cents: number | null; sku: string | null }
interface LedgerItem {
  id: string; name: string | null; description: string | null;
  category_name: string | null; image_ids: string | null;
}

function loadSource(): { source: PublishSource; stats: { total: number; excluded: number; published: number; withImage: number } } {
  const db = new SqliteDatabase(LEDGER, { readonly: true, fileMustExist: true });
  try {
    const items = db.prepare('SELECT id, name, description, category_name, image_ids FROM catalog_items').all() as LedgerItem[];
    const varsByItem = new Map<string, LedgerVariation[]>();
    for (const v of db.prepare('SELECT id, item_id, name, price_cents, sku FROM item_variations').all() as Array<LedgerVariation & { item_id: string }>) {
      (varsByItem.get(v.item_id) ?? varsByItem.set(v.item_id, []).get(v.item_id)!).push(v);
    }
    const imageFile = new Map<string, string>();
    for (const im of db.prepare('SELECT id, local_file, exists_locally FROM images').all() as Array<{ id: string; local_file: string | null; exists_locally: number }>) {
      if (im.exists_locally && im.local_file) imageFile.set(im.id, im.local_file.split('/').pop()!);
    }
    // Velocity: units sold per item (real, from order_line_items). Rank asc = hottest.
    const velocity = new Map<string, number>();
    for (const r of db.prepare(
      `SELECT iv.item_id AS item_id, SUM(CAST(oli.quantity AS REAL)) AS qty
       FROM order_line_items oli JOIN item_variations iv ON iv.id = oli.catalog_object_id
       GROUP BY iv.item_id`,
    ).all() as Array<{ item_id: string; qty: number }>) {
      velocity.set(r.item_id, r.qty ?? 0);
    }
    const ranked = [...velocity.entries()].sort((a, b) => b[1] - a[1]);
    const rankOf = new Map<string, number>();
    ranked.forEach(([itemId], i) => rankOf.set(itemId, i + 1));

    let excluded = 0;
    let withImage = 0;
    const publishable: PublishItemInput[] = [];
    // The storefront output law is word-boundary DNU/JPC/consignment — and that
    // boundary applies to the derived SLUG too (`z_DNU -…` → slug `z-dnu-…`,
    // where `-dnu-` IS boundaried). catalog's evaluateExclusion is prefix-only
    // for DNU (underscore is a word char, so it misses `z_DNU` = 129 items).
    // Token-split the name on non-alphanumerics (the same basis slugs use) and
    // reject any 'dnu'/'jpc' token or a 'consignment' substring, so the
    // projection never contains anything the output gate would (correctly) reject.
    const tokenExcluded = (name: string): boolean => {
      const toks = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      return toks.includes('dnu') || toks.includes('jpc') || name.toLowerCase().includes('consignment');
    };
    for (const it of items) {
      const nm = it.name ?? '';
      if (evaluateExclusion(it.name, it.category_name).excluded || tokenExcluded(nm)) { excluded++; continue; }
      const cat = mapCategory(it.category_name);
      const brand = extractBrand(it.name);
      const imgIds: string[] = it.image_ids ? (JSON.parse(it.image_ids) as string[]) : [];
      const images = imgIds
        .map((id) => imageFile.get(id))
        .filter((f): f is string => !!f)
        .slice(0, 4)
        .map((f) => ({ path: `data/images/${f}`, alt: (it.name ?? 'Product').trim() }));
      if (images.length) withImage++;
      publishable.push({
        sourceProductId: it.id,
        name: (it.name ?? 'Unnamed product').trim(),
        description: it.description,
        departmentSlug: cat.department,
        departmentName: cat.department ? DEPT_NAME.get(cat.department) ?? cat.department : null,
        categoryName: it.category_name,
        brandSlug: brand?.slug ?? null,
        brandName: brand?.name ?? null,
        publicationState: 'published',
        velocityRank: rankOf.get(it.id) ?? 1_000_000,
        images,
        variations: (varsByItem.get(it.id) ?? []).map((v) => ({
          sourceVariationId: v.id,
          name: (v.name ?? 'Option').trim(),
          sku: v.sku,
          priceCents: v.price_cents,
        })),
      });
    }
    const source: PublishSource = {
      listPublishableItems: () => publishable,
      // Honest: no real stock counts exist yet → every variation is 'unknown' (NO badge).
      availabilityFor: (ids) => Object.fromEntries(ids.map((i) => [i, 'unknown' as const])),
    };
    return { source, stats: { total: items.length, excluded, published: publishable.length, withImage } };
  } finally {
    db.close();
  }
}

async function main() {
  console.log('=== Mags Tack storefront — real generation ===');
  console.log('ledger:', LEDGER, '(read-only)');
  const { source, stats } = loadSource();
  console.log(`catalog items: ${stats.total} | excluded (DNU/JPC/consignment): ${stats.excluded} | publishable: ${stats.published} | with local image: ${stats.withImage}`);

  const db = createTestDb<StorefrontDatabase>();
  await runMigrations(db, [...coreMigrations, ...storefrontMigrations]);
  const tenant = await createTenant(asCoreDb(db), { name: 'Mags Tack' });

  console.log('\n--- publish pipeline ---');
  const res = await publishStorefront({
    db,
    tenantId: tenant.id,
    source,
    dataAsOf: DATA_AS_OF,
    config: { brandName: 'Mags Tack', tagline: 'Mobile tack shop for the horse-show circuit' },
  });
  console.log(`status: ${res.status} | items: ${res.itemCount} | variations: ${res.variationCount} | pages: ${res.pageCount} | checksum: ${res.checksum.slice(0, 16)}… | ${res.durationMs}ms`);
  for (const g of res.gateResults) {
    console.log(`  [${g.pass ? 'PASS' : 'FAIL'}] ${g.name} (${g.checked} checked${g.pass ? '' : `, ${g.failures.length} failures`})`);
    if (!g.pass) g.failures.slice(0, 5).forEach((f) => console.log(`         - ${f}`));
  }
  if (res.status !== 'live') {
    console.error('PUBLISH FAILED — projection not swapped live.');
    process.exit(1);
  }

  console.log('\n--- static export ---');
  const ex = await exportStaticSite({
    db,
    tenantId: tenant.id,
    outDir: OUT_DIR,
    imageSourceDir: IMAGES_DIR,
    config: { brandName: 'Mags Tack', tagline: 'Mobile tack shop for the horse-show circuit' },
  });
  console.log(`out: ${ex.outDir}`);
  console.log(`pages: ${ex.pageCount} (html: ${ex.htmlPageCount}) | bytes: ${(ex.bytesWritten / 1e6).toFixed(1)} MB | images copied: ${ex.imagesCopied} (missing: ${ex.imagesMissing}) | search shards: ${ex.searchIndexShards}`);
  for (const g of ex.gateResults) console.log(`  [${g.pass ? 'PASS' : 'FAIL'}] ${g.name} (${g.checked} checked)`);
  console.log(`export gates: ${ex.gatesPassed ? 'ALL PASS' : 'FAILED'}`);

  // --- 5-item spot check vs ledger SQL ---
  console.log('\n--- spot-check: 5 item pages vs ledger SQL ---');
  const led = new SqliteDatabase(LEDGER, { readonly: true });
  const fs = await import('node:fs/promises');
  try {
    const ids = (led.prepare(
      `SELECT ci.id FROM catalog_items ci WHERE ci.name NOT LIKE 'DNU%' AND ci.name NOT LIKE 'z_DNU%'
       AND LOWER(COALESCE(ci.category_name,'')) <> 'jpc consignment'
       AND LOWER(ci.name) NOT LIKE '%consignment%' AND LOWER(' '||ci.name||' ') NOT LIKE '% jpc %'
       ORDER BY ci.id`,
    ).all() as Array<{ id: string }>).map((r) => r.id);
    const picks = [ids[0], ids[Math.floor(ids.length / 4)], ids[Math.floor(ids.length / 2)], ids[Math.floor((3 * ids.length) / 4)], ids[ids.length - 1]];
    const items = await import('../src/publish').then((m) => m.readProjection(db, tenant.id, res.runId));
    const bySource = new Map(items.items.map((i) => [i.sourceProductId, i]));
    for (const sid of picks) {
      const row = led.prepare('SELECT name FROM catalog_items WHERE id=?').get(sid) as { name: string };
      const prices = (led.prepare('SELECT price_cents FROM item_variations WHERE item_id=? AND price_cents IS NOT NULL ORDER BY price_cents').all(sid) as Array<{ price_cents: number }>).map((r) => r.price_cents);
      const proj = bySource.get(sid);
      const page = proj ? await fs.readFile(join(OUT_DIR, `item-${proj.slug}.html`), 'utf8').catch(() => '') : '';
      const priceStr = prices.length
        ? (prices[0] === prices[prices.length - 1] ? money(prices[0]) : `${money(prices[0])} – ${money(prices[prices.length - 1])}`)
        : 'Price not listed';
      const nameOk = page.includes(escapeHtml(row.name.trim()));
      const priceOk = page.includes(escapeHtml(priceStr)) || (prices.length === 0 && page.includes('Price not listed'));
      console.log(`  ${sid}`);
      console.log(`    ledger name : ${row.name}`);
      console.log(`    ledger price: ${priceStr}`);
      console.log(`    page name match : ${nameOk ? 'YES' : 'NO'} | page price match: ${priceOk ? 'YES' : 'NO'}`);
    }
  } finally {
    led.close();
  }
  console.log('\nDONE.');
}

function money(cents: number): string {
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
