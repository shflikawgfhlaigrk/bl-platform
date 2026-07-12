import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import { id, nowIso, audit, asCoreDb, type EventBus } from '@blacklabel/core';
import type { AvailabilityState, PublishRunStatus, StorefrontDatabase } from './schema';
import { renderSite, type ProjectionSite, type RenderItem, type RenderFacet, type SiteConfig } from './render';
import { runContentGates, assertProjectionSchemaClean, type GateResult } from './gates';

type Db = Kysely<StorefrontDatabase>;

/* --------------------------- PublishSource ----------------------------- */

export interface PublishVariationInput {
  sourceVariationId: string;
  name: string;
  sku?: string | null;
  priceCents?: number | null;
}

export interface PublishItemInput {
  sourceProductId: string;
  name: string;
  description?: string | null;
  departmentSlug?: string | null;
  departmentName?: string | null;
  categoryName?: string | null;
  brandSlug?: string | null;
  brandName?: string | null;
  /** MUST be 'published' — the fill gate rejects anything else. */
  publicationState: 'draft' | 'published' | 'excluded';
  exclusionReason?: string | null;
  /** Optional pre-computed slug; otherwise derived deterministically. */
  slug?: string;
  images?: Array<{ path: string; alt: string }>;
  /** Lower = more featured. Defaults to a large number (unfeatured). */
  velocityRank?: number | null;
  variations: PublishVariationInput[];
}

/**
 * The ONLY bridge from private catalog/inventory into the projection. The
 * integrator implements this feeding from the catalog + inventory modules; the
 * storefront package never imports those packages.
 */
export interface PublishSource {
  listPublishableItems(): PublishItemInput[] | Promise<PublishItemInput[]>;
  availabilityFor(
    variationIds: string[],
  ): Record<string, AvailabilityState> | Promise<Record<string, AvailabilityState>>;
}

/* ------------------------------ helpers -------------------------------- */

export function slugify(input: string): string {
  return (input || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

/* ---------------------------- projection read -------------------------- */

/** Read one publish run's projection rows into a render-ready ProjectionSite. */
export async function readProjection(
  db: Db,
  tenantId: string,
  publishRunId: string,
): Promise<ProjectionSite> {
  const run = await db
    .selectFrom('storefront_publish_runs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', publishRunId)
    .executeTakeFirst();
  if (!run) throw new Error(`readProjection: run ${publishRunId} not found for tenant`);

  const itemRows = await db
    .selectFrom('storefront_published_items')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('publish_run_id', '=', publishRunId)
    .orderBy('velocity_rank')
    .orderBy('slug')
    .orderBy('id')
    .execute();

  const varRows = await db
    .selectFrom('storefront_published_variations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('publish_run_id', '=', publishRunId)
    .orderBy('item_id')
    .orderBy('sort')
    .orderBy('id')
    .execute();

  const availRows = await db
    .selectFrom('storefront_availability')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('publish_run_id', '=', publishRunId)
    .execute();
  const availByVar = new Map(availRows.map((a) => [a.variation_id, a.state as AvailabilityState]));

  const varsByItem = new Map<string, typeof varRows>();
  for (const v of varRows) {
    (varsByItem.get(v.item_id) ?? varsByItem.set(v.item_id, []).get(v.item_id)!).push(v);
  }

  const items: RenderItem[] = itemRows.map((r) => ({
    id: r.id,
    sourceProductId: r.source_product_id,
    name: r.name,
    description: r.description,
    departmentSlug: r.department_slug,
    departmentName: r.department_name,
    categoryName: r.category_name,
    brandSlug: r.brand_slug,
    brandName: r.brand_name,
    slug: r.slug,
    images: JSON.parse(r.images) as Array<{ path: string; alt: string }>,
    velocityRank: r.velocity_rank,
    variations: (varsByItem.get(r.id) ?? []).map((v) => ({
      id: v.id,
      sourceVariationId: v.source_variation_id,
      name: v.name,
      sku: v.sku,
      priceCents: v.price_cents,
      state: availByVar.get(v.id) ?? 'unknown',
    })),
  }));

  const departments = facetsFrom(items, (it) => (it.departmentSlug ? { slug: it.departmentSlug, name: it.departmentName ?? it.departmentSlug } : null));
  const brands = facetsFrom(items, (it) => (it.brandSlug ? { slug: it.brandSlug, name: it.brandName ?? it.brandSlug } : null));

  return { tenantId, dataAsOf: run.data_as_of, items, departments, brands };
}

function facetsFrom(items: RenderItem[], pick: (it: RenderItem) => { slug: string; name: string } | null): RenderFacet[] {
  const map = new Map<string, { name: string; count: number }>();
  for (const it of items) {
    const f = pick(it);
    if (!f) continue;
    const cur = map.get(f.slug);
    if (cur) cur.count++;
    else map.set(f.slug, { name: f.name, count: 1 });
  }
  return [...map.entries()]
    .map(([slug, v]) => ({ slug, name: v.name, itemCount: v.count }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/* ------------------------------ checksum ------------------------------- */

function computeChecksum(items: RenderItem[], dataAsOf: string): string {
  const payload = {
    dataAsOf,
    items: items
      .map((it) => ({
        p: it.sourceProductId,
        n: it.name,
        d: it.description,
        ds: it.departmentSlug,
        bs: it.brandSlug,
        c: it.categoryName,
        s: it.slug,
        vr: it.velocityRank,
        img: it.images.map((i) => [i.path, i.alt]),
        v: it.variations.map((v) => [v.sourceVariationId, v.name, v.sku, v.priceCents, v.state]),
      }))
      .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0)),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/* ------------------------------ publish -------------------------------- */

export interface PublishOptions {
  db: Db;
  tenantId: string;
  source: PublishSource;
  config?: Partial<SiteConfig>;
  events?: EventBus;
  actor?: string;
  /** Deterministic "data as of" stamp (defaults to nowIso()). */
  dataAsOf?: string;
  denylist?: string[];
  crossBrandTerms?: string[];
}

export interface PublishResult {
  runId: string;
  status: PublishRunStatus;
  itemCount: number;
  variationCount: number;
  pageCount: number;
  checksum: string;
  durationMs: number;
  gateResults: GateResult[];
  failures: string[];
  /** The run that stayed live if this publish failed (rollback-by-default). */
  liveRunId: string | null;
}

/**
 * Publish the projection and swap it live ONLY if every gate passes. On any
 * gate failure the run is marked `failed` and the previous live run stays live
 * (rollback-by-default). Idempotent inputs → identical checksum.
 */
export async function publishStorefront(opts: PublishOptions): Promise<PublishResult> {
  const { db, tenantId, source, events, actor = 'system' } = opts;
  const started = Date.now();
  const dataAsOf = opts.dataAsOf ?? nowIso();
  const runId = id();
  const now = nowIso();

  const inputs = await source.listPublishableItems();

  // --- Fill gate: exclusion law. Only 'published' items may enter the projection.
  const fillFailures: string[] = [];
  for (const it of inputs) {
    if (it.publicationState !== 'published') {
      fillFailures.push(`item ${it.sourceProductId} (${it.name}): publication_state=${it.publicationState} must not enter projection`);
    }
  }

  const prevLive = await getLiveRun(db, tenantId);

  // Write the run row (pending) so a failed publish still leaves a record.
  const runBase = {
    id: runId,
    tenant_id: tenantId,
    status: 'pending' as PublishRunStatus,
    data_as_of: dataAsOf,
    item_count: 0,
    variation_count: 0,
    page_count: 0,
    checksum: '',
    duration_ms: 0,
    gate_results: '[]',
    failures: '[]',
    error: null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('storefront_publish_runs').values(runBase).execute();

  const finishFailed = async (gateResults: GateResult[], failures: string[], error: string | null): Promise<PublishResult> => {
    await db
      .updateTable('storefront_publish_runs')
      .set({ status: 'failed', gate_results: JSON.stringify(gateResults), failures: JSON.stringify(failures), error, duration_ms: Date.now() - started, updated_at: nowIso() })
      .where('id', '=', runId)
      .where('tenant_id', '=', tenantId)
      .execute();
    await audit(asCoreDb(db), tenantId, actor, 'storefront.publish.failed', 'storefront.publish_run', runId, { failures: failures.slice(0, 20) });
    if (events) await events.emit(tenantId, 'storefront.publish.failed', { v: 1, runId, failureCount: failures.length });
    return { runId, status: 'failed', itemCount: 0, variationCount: 0, pageCount: 0, checksum: '', durationMs: Date.now() - started, gateResults, failures, liveRunId: prevLive?.id ?? null };
  };

  if (fillFailures.length) {
    return finishFailed([{ name: 'exclusion-fill', pass: false, failures: fillFailures, checked: inputs.length }], fillFailures, 'exclusion fill gate failed');
  }

  // --- Insert projection rows.
  const usedSlugs = new Set<string>();
  /** generated variation id → its source variation id (for availability mapping). */
  const varIdToSource: Array<{ id: string; sourceId: string }> = [];
  const itemRows: StorefrontDatabase['storefront_published_items'][] = [];
  const varRows: StorefrontDatabase['storefront_published_variations'][] = [];
  for (const it of inputs) {
    const itemId = id();
    let slug = it.slug ? slugify(it.slug) : slugify(it.name);
    if (usedSlugs.has(slug)) slug = `${slug}-${slugify(it.sourceProductId).slice(0, 8)}`;
    let guard = 2;
    while (usedSlugs.has(slug)) slug = `${slug}-${guard++}`;
    usedSlugs.add(slug);

    itemRows.push({
      id: itemId,
      tenant_id: tenantId,
      publish_run_id: runId,
      source_product_id: it.sourceProductId,
      name: it.name,
      description: it.description ?? null,
      department_slug: it.departmentSlug ?? null,
      department_name: it.departmentName ?? null,
      category_name: it.categoryName ?? null,
      brand_slug: it.brandSlug ?? null,
      brand_name: it.brandName ?? null,
      slug,
      images: JSON.stringify(it.images ?? []),
      velocity_rank: it.velocityRank ?? 1_000_000,
      created_at: now,
    });
    it.variations.forEach((v, i) => {
      const vId = id();
      varIdToSource.push({ id: vId, sourceId: v.sourceVariationId });
      varRows.push({
        id: vId,
        tenant_id: tenantId,
        publish_run_id: runId,
        item_id: itemId,
        source_variation_id: v.sourceVariationId,
        name: v.name,
        sku: v.sku ?? null,
        price_cents: v.priceCents ?? null,
        sort: i,
        created_at: now,
      });
    });
  }
  if (itemRows.length) await insertChunked(db, 'storefront_published_items', itemRows);
  if (varRows.length) await insertChunked(db, 'storefront_published_variations', varRows);

  // Availability (state only). The source is queried by its OWN (source)
  // variation ids and returns states keyed the same way; we map to projection ids.
  const sourceVarIds = varIdToSource.map((x) => x.sourceId);
  const availMap = sourceVarIds.length ? await source.availabilityFor(sourceVarIds) : {};
  const availRows = varIdToSource.map((x) => ({
    id: id(),
    tenant_id: tenantId,
    publish_run_id: runId,
    variation_id: x.id,
    state: (availMap[x.sourceId] ?? 'unknown') as AvailabilityState,
    created_at: now,
  }));
  if (availRows.length) await insertChunked(db, 'storefront_availability', availRows);

  // --- Read the projection back and render.
  const site = await readProjection(db, tenantId, runId);
  const checksum = computeChecksum(site.items, dataAsOf);
  const rendered = renderSite(site, { ...opts.config, mode: 'static' });

  // --- Gates.
  const schemaGate = await assertProjectionSchemaClean(db);
  const contentGates = runContentGates(rendered, { denylist: opts.denylist, crossBrandTerms: opts.crossBrandTerms });
  const gateResults = [schemaGate, ...contentGates];
  const failures = gateResults.flatMap((g) => g.failures);

  const variationCount = varRows.length;
  const pageCountAll = rendered.pages.length;

  // Persist page records (routing/SEO) for content pages.
  const pageRecords = rendered.pages
    .filter((p) => p.path.endsWith('.html'))
    .map((p) => ({
      id: id(),
      tenant_id: tenantId,
      publish_run_id: runId,
      path: p.path,
      title: p.title,
      description: p.description,
      kind: p.kind,
      created_at: now,
    }));
  if (pageRecords.length) await insertChunked(db, 'storefront_pages', pageRecords);

  if (failures.length) {
    return finishFailed(gateResults, failures, 'content gate(s) failed');
  }

  // --- All gates pass: swap live.
  if (prevLive) {
    await db.updateTable('storefront_publish_runs').set({ status: 'superseded', updated_at: nowIso() }).where('id', '=', prevLive.id).where('tenant_id', '=', tenantId).execute();
  }
  await db
    .updateTable('storefront_publish_runs')
    .set({
      status: 'live',
      item_count: itemRows.length,
      variation_count: variationCount,
      page_count: pageRecords.length,
      checksum,
      duration_ms: Date.now() - started,
      gate_results: JSON.stringify(gateResults),
      failures: '[]',
      updated_at: nowIso(),
    })
    .where('id', '=', runId)
    .where('tenant_id', '=', tenantId)
    .execute();

  await audit(asCoreDb(db), tenantId, actor, 'storefront.publish.completed', 'storefront.publish_run', runId, { itemCount: itemRows.length, variationCount, checksum });
  if (events) await events.emit(tenantId, 'storefront.publish.completed', { v: 1, runId, itemCount: itemRows.length });

  return {
    runId,
    status: 'live',
    itemCount: itemRows.length,
    variationCount,
    pageCount: pageCountAll,
    checksum,
    durationMs: Date.now() - started,
    gateResults,
    failures: [],
    liveRunId: runId,
  };
}

/** Insert rows in bounded chunks (SQLite variable limit safety). */
async function insertChunked<T extends keyof StorefrontDatabase & string>(
  db: Db,
  table: T,
  rows: StorefrontDatabase[T][],
  size = 200,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await db.insertInto(table).values(rows.slice(i, i + size) as any).execute();
  }
}

/* ------------------------------ live/rollback -------------------------- */

export async function getLiveRun(db: Db, tenantId: string) {
  return db
    .selectFrom('storefront_publish_runs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'live')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
}

export async function listPublishRuns(db: Db, tenantId: string, limit = 50) {
  return db
    .selectFrom('storefront_publish_runs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
}

/** Roll the live projection back to a prior (successful) run. */
export async function rollbackToRun(
  db: Db,
  tenantId: string,
  targetRunId: string,
  actor = 'system',
): Promise<{ liveRunId: string }> {
  const target = await db
    .selectFrom('storefront_publish_runs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', targetRunId)
    .executeTakeFirst();
  if (!target) throw new Error(`rollbackToRun: run ${targetRunId} not found`);
  if (target.status === 'failed' || target.status === 'pending') {
    throw new Error(`rollbackToRun: run ${targetRunId} never passed gates (status=${target.status})`);
  }
  const current = await getLiveRun(db, tenantId);
  if (current && current.id !== targetRunId) {
    await db.updateTable('storefront_publish_runs').set({ status: 'rolled_back', updated_at: nowIso() }).where('id', '=', current.id).where('tenant_id', '=', tenantId).execute();
  }
  await db.updateTable('storefront_publish_runs').set({ status: 'live', updated_at: nowIso() }).where('id', '=', targetRunId).where('tenant_id', '=', tenantId).execute();
  await audit(asCoreDb(db), tenantId, actor, 'storefront.publish.rolled_back', 'storefront.publish_run', targetRunId, { from: current?.id ?? null });
  return { liveRunId: targetRunId };
}
