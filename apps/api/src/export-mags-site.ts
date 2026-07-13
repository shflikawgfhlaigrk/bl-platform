/**
 * export-mags-site — render the Mags Tack storefront projection to a
 * deploy-ready, self-contained static site.
 *
 * Reads ONLY the storefront projection tables of a seeded tenant db (the live
 * publish run), renders to `OUT_DIR`, copies referenced images from
 * `IMAGE_DIR`, and re-runs the content gates INCLUDING brand isolation
 * (crossBrandTerms) — a client site must NEVER surface Black Label or any
 * other property. Deploying the output is a founder gate; this tool only
 * produces + proves the artifact.
 *
 *   PLATFORM_DB_PATH=/path/to/seeded-mags.db \
 *   OUT_DIR=~/MagsTack/store-site \
 *   IMAGE_DIR=~/MagsTack/data/images \
 *     tsx apps/api/src/export-mags-site.ts
 *
 * Exit 0 = all gates + brand isolation pass. Exit 1 = a gate failed (do not deploy).
 */
import os from 'node:os';
import path from 'node:path';
import { asCoreDb } from '@blacklabel/core';
import { createDb } from '@blacklabel/db';
import { exportStaticSite } from '@blacklabel/storefront';
import type { PlatformDatabase } from './app';

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
  const imageDir = expand(process.env.IMAGE_DIR ?? path.join(os.homedir(), 'MagsTack', 'data', 'images'));

  console.log(`export-mags-site\n  tenant db : ${dbPath}\n  out       : ${outDir}\n  images    : ${imageDir}`);

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

  const stats = await exportStaticSite({
    db: db as never,
    tenantId: tenant.id,
    outDir,
    imageSourceDir: imageDir,
    clean: true,
    runGates: true,
    crossBrandTerms: CROSS_BRAND_TERMS,
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
