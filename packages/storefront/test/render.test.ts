import { describe, expect, it } from 'vitest';
import { renderSite, buildSearchIndex, priceLabel, itemState, type ProjectionSite, type RenderItem } from '../src/render';
import type { AvailabilityState } from '../src/schema';

function ri(over: Partial<RenderItem>): RenderItem {
  return {
    id: over.id ?? 'i1',
    sourceProductId: over.sourceProductId ?? 'p1',
    name: over.name ?? 'Item',
    description: over.description ?? null,
    departmentSlug: over.departmentSlug ?? 'tack',
    departmentName: over.departmentName ?? 'Tack',
    categoryName: over.categoryName ?? 'Cat',
    brandSlug: over.brandSlug ?? null,
    brandName: over.brandName ?? null,
    slug: over.slug ?? 'item',
    images: over.images ?? [],
    velocityRank: over.velocityRank ?? 1,
    variations: over.variations ?? [{ id: 'v1', sourceVariationId: 'sv1', name: 'A', sku: null, priceCents: 1000, state: 'in_stock' }],
  };
}

function projection(items: RenderItem[]): ProjectionSite {
  const deptMap = new Map<string, { name: string; count: number }>();
  const brandMap = new Map<string, { name: string; count: number }>();
  for (const it of items) {
    if (it.departmentSlug) {
      const d = deptMap.get(it.departmentSlug) ?? { name: it.departmentName ?? it.departmentSlug, count: 0 };
      d.count++; deptMap.set(it.departmentSlug, d);
    }
    if (it.brandSlug) {
      const b = brandMap.get(it.brandSlug) ?? { name: it.brandName ?? it.brandSlug, count: 0 };
      b.count++; brandMap.set(it.brandSlug, b);
    }
  }
  return {
    tenantId: 't1',
    dataAsOf: '2026-07-11',
    items,
    departments: [...deptMap].map(([slug, v]) => ({ slug, name: v.name, itemCount: v.count })),
    brands: [...brandMap].map(([slug, v]) => ({ slug, name: v.name, itemCount: v.count })),
  };
}

describe('render — deterministic + content', () => {
  const site = projection([
    ri({ id: 'a', slug: 'ellany-halter', name: 'Ellany Halter', brandSlug: 'ellany', brandName: 'Ellany', images: [{ path: 'data/images/h.jpeg', alt: 'Ellany halter' }],
      variations: [
        { id: 'va1', sourceVariationId: 'sv-a1', name: 'Cob', sku: 'ELL-CB', priceCents: 5900, state: 'in_stock' },
        { id: 'va2', sourceVariationId: 'sv-a2', name: 'Full', sku: 'ELL-FL', priceCents: 6200, state: 'low' },
      ] }),
    ri({ id: 'b', slug: 'polo-wraps', name: 'Polo Wraps', categoryName: 'Cat', variations: [{ id: 'vb1', sourceVariationId: 'sv-b1', name: 'Navy', sku: null, priceCents: null, state: 'unknown' }] }),
  ]);

  it('produces byte-identical output for the same projection', () => {
    const r1 = renderSite(site);
    const r2 = renderSite(site);
    expect(r1.pages.map((p) => p.path + '\n' + p.body)).toEqual(r2.pages.map((p) => p.path + '\n' + p.body));
  });

  it('renders an item page with variation prices and JSON-LD Product', () => {
    const r = renderSite(site);
    const item = r.byPath.get('item-ellany-halter.html')!;
    expect(item.body).toContain('Ellany Halter');
    expect(item.body).toContain('$59.00');
    expect(item.body).toContain('"@type":"Product"');
    expect(item.body).toContain('alt="Ellany halter"');
  });

  it('renders honest "Price not listed" for a null price and NO badge for unknown', () => {
    const r = renderSite(site);
    const item = r.byPath.get('item-polo-wraps.html')!;
    expect(item.body).toContain('Price not listed');
    // unknown availability → the hero price line carries NO badge (related items may have their own)
    expect(item.body).toMatch(/<strong>Price not listed<\/strong>\s*<\/p>/);
    // and the variation row's availability cell is an em dash, never a badge/count
    expect(item.body).toMatch(/<td><span class="muted">—<\/span><\/td>/);
  });

  it('renders a department page and a search page', () => {
    const r = renderSite(site);
    expect(r.byPath.get('department-tack.html')!.body).toContain('Tack');
    expect(r.byPath.get('search.html')!.body).toContain('id="search-page-input"');
  });

  it('emits sitemap.xml + robots.txt + a search index manifest', () => {
    const r = renderSite(site);
    expect(r.byPath.has('sitemap.xml')).toBe(true);
    expect(r.byPath.has('robots.txt')).toBe(true);
    expect(r.byPath.has('search-index/manifest.json')).toBe(true);
  });

  it('CSS asset is a single file under 50KB', () => {
    const r = renderSite(site);
    const css = r.byPath.get('assets/site.css')!;
    expect(Buffer.byteLength(css.body, 'utf8')).toBeLessThan(50 * 1024);
  });
});

describe('availability mapping — state only, never a count', () => {
  it('maps each state to the right badge (or none) and never emits a digit', () => {
    const states: AvailabilityState[] = ['in_stock', 'low', 'out', 'unknown'];
    for (const s of states) {
      const site = projection([ri({ slug: `x-${s}`, variations: [{ id: 'v', sourceVariationId: 'sv', name: 'A', sku: null, priceCents: 100, state: s }] })]);
      const body = renderSite(site).byPath.get(`item-x-${s}.html`)!.body;
      const badges = [...body.matchAll(/<span class="badge (in|low|out)">([^<]*)<\/span>/g)];
      for (const m of badges) expect(m[2]).not.toMatch(/\d/);
      if (s === 'unknown') expect(badges).toHaveLength(0);
    }
  });
  it('itemState prefers in_stock > low > out and falls back to unknown', () => {
    expect(itemState(ri({ variations: [{ id: 'v', sourceVariationId: 's', name: 'A', sku: null, priceCents: 1, state: 'out' }, { id: 'v2', sourceVariationId: 's2', name: 'B', sku: null, priceCents: 1, state: 'in_stock' }] }))).toBe('in_stock');
    expect(itemState(ri({ variations: [{ id: 'v', sourceVariationId: 's', name: 'A', sku: null, priceCents: 1, state: 'unknown' }] }))).toBe('unknown');
  });
  it('priceLabel is honest when no price is listed', () => {
    expect(priceLabel([{ id: 'v', sourceVariationId: 's', name: 'A', sku: null, priceCents: null, state: 'unknown' }])).toBe('Price not listed');
  });
});

describe('pagination cap', () => {
  it('never renders more than pageSize cards on one grid page', () => {
    const items = Array.from({ length: 55 }, (_, i) =>
      ri({ id: `p${i}`, slug: `p-${String(i).padStart(3, '0')}`, name: `Product ${i}`, velocityRank: i }),
    );
    const r = renderSite(projection(items), { pageSize: 24 });
    const page1 = r.byPath.get('department-tack.html')!.body;
    const cards = (page1.match(/<li class="card">/g) ?? []).length;
    expect(cards).toBeLessThanOrEqual(24);
    // 55 items / 24 → 3 pages
    expect(r.byPath.has('department-tack-2.html')).toBe(true);
    expect(r.byPath.has('department-tack-3.html')).toBe(true);
    expect(r.byPath.has('department-tack-4.html')).toBe(false);
  });
});

describe('search index sharding', () => {
  it('uses a single shard for a small catalog', () => {
    const idx = buildSearchIndex([ri({ slug: 'a', name: 'Alpha' }), ri({ slug: 'b', name: 'Beta' })]);
    expect(idx.manifest.sharded).toBe(false);
    expect(idx.files).toHaveLength(1);
  });
  it('shards by first letter when the index exceeds 2MB', () => {
    const big = Array.from({ length: 6000 }, (_, i) =>
      ri({ id: `b${i}`, slug: String.fromCharCode(97 + (i % 26)) + '-' + i, name: 'X'.repeat(500) + i }),
    );
    const idx = buildSearchIndex(big);
    expect(idx.manifest.sharded).toBe(true);
    expect(idx.files.length).toBeGreaterThan(1);
  });
});
