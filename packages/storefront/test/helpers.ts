import { EventBus, asCoreDb, coreMigrations, createTenant, id, nowIso } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { storefrontMigrations } from '../src/migrations';
import type { StorefrontDatabase, AvailabilityState } from '../src/schema';
import type { PublishItemInput, PublishSource } from '../src/publish';
import type { RenderedSite, RenderedPage } from '../src/render';

/** Full DB (core + storefront) + two tenants + an event bus. */
export async function setup() {
  const db = createTestDb<StorefrontDatabase>();
  await runMigrations(db, [...coreMigrations, ...storefrontMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Alpha Tack' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Beta Tack' });
  const events = new EventBus();
  return { db, tenantA, tenantB, events };
}

/** Projection-ONLY DB: storefront tables migrated, NO core tables at all.
 * Used to prove the public router never queries a private/core table. */
export async function projectionOnlyDb() {
  const db = createTestDb<StorefrontDatabase>();
  await runMigrations(db, [...storefrontMigrations]);
  return db;
}

const AVAIL: Record<string, AvailabilityState> = {
  'sv-halter-1': 'in_stock',
  'sv-halter-2': 'low',
  'sv-brush-1': 'out',
  'sv-polo-1': 'unknown',
  'sv-boot-1': 'in_stock',
};

/** A deterministic fixture catalog: departments, brands, prices, states, images. */
export function fixtureItems(): PublishItemInput[] {
  return [
    {
      sourceProductId: 'p-halter',
      name: 'Ellany Leather Halter',
      description: 'Padded leather halter for the show ring.',
      departmentSlug: 'tack',
      departmentName: 'Tack',
      categoryName: 'Halters',
      brandSlug: 'ellany',
      brandName: 'Ellany',
      publicationState: 'published',
      velocityRank: 1,
      images: [{ path: 'data/images/halter.jpeg', alt: 'Ellany leather halter' }],
      variations: [
        { sourceVariationId: 'sv-halter-1', name: 'Cob', sku: 'ELL-HAL-CB', priceCents: 5900 },
        { sourceVariationId: 'sv-halter-2', name: 'Full', sku: 'ELL-HAL-FL', priceCents: 6200 },
      ],
    },
    {
      sourceProductId: 'p-brush',
      name: 'TuffRider Dandy Brush',
      description: null,
      departmentSlug: 'horse-care',
      departmentName: 'Horse Care',
      categoryName: 'Grooming',
      brandSlug: 'tuffrider',
      brandName: 'TuffRider',
      publicationState: 'published',
      velocityRank: 5,
      images: [],
      variations: [{ sourceVariationId: 'sv-brush-1', name: 'One size', sku: null, priceCents: 1200 }],
    },
    {
      sourceProductId: 'p-polo',
      name: 'LeMieux Polo Wraps',
      description: 'Set of four polo wraps.',
      departmentSlug: 'tack',
      departmentName: 'Tack',
      categoryName: 'Leg Protection',
      brandSlug: 'lemieux',
      brandName: 'LeMieux',
      publicationState: 'published',
      velocityRank: 3,
      images: [],
      // no price → honest "Price not listed"
      variations: [{ sourceVariationId: 'sv-polo-1', name: 'Navy', sku: 'LM-POLO-NV', priceCents: null }],
    },
    {
      sourceProductId: 'p-boot',
      name: 'Ariat Paddock Boot',
      description: 'Durable paddock boot.',
      departmentSlug: 'apparel',
      departmentName: 'Apparel',
      categoryName: 'Footwear',
      brandSlug: 'ariat',
      brandName: 'Ariat',
      publicationState: 'published',
      velocityRank: 2,
      images: [{ path: 'data/images/boot.jpeg', alt: 'Ariat paddock boot' }],
      variations: [{ sourceVariationId: 'sv-boot-1', name: 'US 8', sku: 'AR-PB-8', priceCents: 12995 }],
    },
  ];
}

export function fixtureSource(items = fixtureItems(), avail = AVAIL): PublishSource {
  return {
    listPublishableItems: () => items,
    availabilityFor: (ids) => Object.fromEntries(ids.map((i) => [i, avail[i] ?? 'unknown'])),
  };
}

/** Build many items to exercise pagination + search sharding. */
export function bulkItems(n: number): PublishItemInput[] {
  return Array.from({ length: n }, (_, i) => ({
    sourceProductId: `bulk-${i}`,
    name: `Bulk Product ${String(i).padStart(4, '0')}`,
    departmentSlug: 'tack',
    departmentName: 'Tack',
    categoryName: 'Misc',
    publicationState: 'published' as const,
    velocityRank: i,
    images: [],
    variations: [{ sourceVariationId: `bulk-sv-${i}`, name: 'One size', sku: `B-${i}`, priceCents: 1000 + i }],
  }));
}

/** Wrap raw HTML pages into a RenderedSite for gate unit tests. */
export function makeSite(pages: Array<Partial<RenderedPage> & { path: string; body: string }>, imageRefs: string[] = []): RenderedSite {
  const full: RenderedPage[] = pages.map((p) => ({
    path: p.path,
    body: p.body,
    contentType: p.contentType ?? 'text/html; charset=utf-8',
    title: p.title ?? 'T',
    description: p.description ?? 'D',
    kind: p.kind ?? 'info',
  }));
  return { pages: full, byPath: new Map(full.map((p) => [p.path, p])), imageRefs: new Set(imageRefs), assetRefs: new Set<string>() };
}

/** Seed a live projection directly (no audit/gates) into a projection-only db. */
export async function seedLiveProjection(
  db: Awaited<ReturnType<typeof projectionOnlyDb>>,
  tenantId: string,
  items = fixtureItems(),
  avail = AVAIL,
): Promise<string> {
  const runId = id();
  const now = nowIso();
  await db.insertInto('storefront_publish_runs').values({
    id: runId, tenant_id: tenantId, status: 'live', data_as_of: '2026-07-11', item_count: items.length,
    variation_count: 0, page_count: 0, checksum: 'seed', duration_ms: 0, gate_results: '[]', failures: '[]',
    error: null, created_at: now, updated_at: now,
  }).execute();
  for (const it of items) {
    const itemId = id();
    await db.insertInto('storefront_published_items').values({
      id: itemId, tenant_id: tenantId, publish_run_id: runId, source_product_id: it.sourceProductId,
      name: it.name, description: it.description ?? null, department_slug: it.departmentSlug ?? null,
      department_name: it.departmentName ?? null, category_name: it.categoryName ?? null,
      brand_slug: it.brandSlug ?? null, brand_name: it.brandName ?? null, slug: it.sourceProductId,
      images: JSON.stringify(it.images ?? []), velocity_rank: it.velocityRank ?? 1000, created_at: now,
    }).execute();
    let sort = 0;
    for (const v of it.variations) {
      const vId = id();
      await db.insertInto('storefront_published_variations').values({
        id: vId, tenant_id: tenantId, publish_run_id: runId, item_id: itemId,
        source_variation_id: v.sourceVariationId, name: v.name, sku: v.sku ?? null,
        price_cents: v.priceCents ?? null, sort: sort++, created_at: now,
      }).execute();
      await db.insertInto('storefront_availability').values({
        id: id(), tenant_id: tenantId, publish_run_id: runId, variation_id: vId,
        state: avail[v.sourceVariationId] ?? 'unknown', created_at: now,
      }).execute();
    }
  }
  return runId;
}
