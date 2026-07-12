import {
  asCoreDb,
  audit,
  id,
  nowIso,
  type EventBus,
} from '@blacklabel/core';
import type {
  CatalogBarcodeRow,
  CatalogBrandRow,
  CatalogDepartmentRow,
  CatalogProductRow,
  CatalogVariationRow,
  ExclusionReason,
  PublicationState,
  Symbology,
} from './schema';
import type { Db } from './service';
import { analyzeCode } from './barcode';
import {
  DEPARTMENT_TREE,
  evaluateExclusion,
  extractBrand,
  mapCategory,
  slugify,
} from './mapping';

/* ------------------------------------------------------------------ *
 * Ledger-shaped input (matches ~/MagsTack/ledger.db catalog_items +
 * item_variations; the integrator feeds these rows in).
 * ------------------------------------------------------------------ */

export interface LedgerVariation {
  sourceVariationId: string;
  name?: string | null;
  sku?: string | null;
  /** Raw UPC as typed (may contain spaces / be a bad check digit). */
  upc?: string | null;
  /** Digits-only UPC (advisory; the plan re-derives from `upc`). */
  upcNormalized?: string | null;
  priceCents?: number | null;
  trackInventory?: boolean;
}

export interface LedgerItem {
  sourceItemId: string;
  name: string;
  description?: string | null;
  categoryName?: string | null;
  variations: LedgerVariation[];
}

/* ------------------------------------------------------------------ *
 * Plan shapes
 * ------------------------------------------------------------------ */

export interface PlannedBarcode {
  codeRaw: string;
  codeNormalized: string;
  symbology: Symbology;
  checksumValid: boolean;
}

export interface PlannedVariation {
  sourceVariationId: string;
  name: string;
  sku: string | null;
  priceCents: number | null;
  trackInventory: boolean;
  barcodes: PlannedBarcode[];
}

export interface PlannedProduct {
  sourceItemId: string;
  name: string;
  description: string | null;
  sourceCategoryName: string | null;
  departmentSlug: string | null;
  brandName: string | null;
  brandSlug: string | null;
  publicationState: PublicationState;
  exclusionReason: ExclusionReason | null;
  variations: PlannedVariation[];
}

export interface PlannedCategoryMapping {
  sourceCategoryName: string;
  departmentSlug: string | null;
  status: 'mapped' | 'needs_review';
  ruleName: string;
}

export interface ImportPlanStats {
  items: number;
  variations: number;
  skus: number;
  upcs: number;
  badCheckDigits: number;
  duplicateNormalizedUpcs: number;
  excluded: number;
  needsReviewCategories: number;
}

export interface ImportPlan {
  departments: typeof DEPARTMENT_TREE;
  categoryMappings: PlannedCategoryMapping[];
  brands: { name: string; slug: string }[];
  products: PlannedProduct[];
  stats: ImportPlanStats;
}

/**
 * Pure mapping of ledger-shaped catalog rows into catalog rows + barcodes +
 * mapping decisions. Deterministic and side-effect-free — the integrator (and
 * tests) can inspect the whole plan before anything touches the database.
 */
export function buildImportPlan(items: LedgerItem[]): ImportPlan {
  const categoryMappings = new Map<string, PlannedCategoryMapping>();
  const brands = new Map<string, { name: string; slug: string }>();
  const products: PlannedProduct[] = [];

  let variationCount = 0;
  let skuCount = 0;
  let upcCount = 0;
  let badCheckDigits = 0;
  let excluded = 0;
  const normalizedOwners = new Map<string, Set<string>>(); // normalized code -> variation ids

  for (const item of items) {
    const category = item.categoryName ?? null;
    const decision = mapCategory(category);
    if (category !== null && category.trim() !== '' && !categoryMappings.has(category)) {
      categoryMappings.set(category, {
        sourceCategoryName: category,
        departmentSlug: decision.department,
        status: decision.status,
        ruleName: decision.ruleName,
      });
    }

    const brand = extractBrand(item.name);
    if (brand) brands.set(brand.slug, { name: brand.name, slug: brand.slug });

    const exclusion = evaluateExclusion(item.name, category);
    if (exclusion.excluded) excluded += 1;

    const plannedVariations: PlannedVariation[] = [];
    for (const v of item.variations) {
      variationCount += 1;
      if (v.sku != null && v.sku !== '') skuCount += 1;
      const barcodes: PlannedBarcode[] = [];
      if (v.upc != null && v.upc !== '') {
        upcCount += 1;
        const analyzed = analyzeCode(v.upc);
        if ((analyzed.symbology === 'upca' || analyzed.symbology === 'ean13') && !analyzed.checksumValid) {
          badCheckDigits += 1;
        }
        if (analyzed.codeNormalized !== '') {
          let owners = normalizedOwners.get(analyzed.codeNormalized);
          if (!owners) {
            owners = new Set();
            normalizedOwners.set(analyzed.codeNormalized, owners);
          }
          owners.add(v.sourceVariationId);
        }
        barcodes.push({
          codeRaw: analyzed.codeRaw,
          codeNormalized: analyzed.codeNormalized,
          symbology: analyzed.symbology,
          checksumValid: analyzed.checksumValid,
        });
      }
      plannedVariations.push({
        sourceVariationId: v.sourceVariationId,
        name: (v.name ?? '').trim() || 'Regular',
        sku: v.sku ?? null,
        priceCents: v.priceCents ?? null,
        trackInventory: v.trackInventory ?? true,
        barcodes,
      });
    }

    products.push({
      sourceItemId: item.sourceItemId,
      name: item.name,
      description: item.description ?? null,
      sourceCategoryName: category,
      departmentSlug: decision.status === 'mapped' ? decision.department : null,
      brandName: brand?.name ?? null,
      brandSlug: brand?.slug ?? null,
      publicationState: exclusion.excluded ? 'excluded' : 'draft',
      exclusionReason: exclusion.reason,
      variations: plannedVariations,
    });
  }

  let duplicateNormalizedUpcs = 0;
  for (const owners of normalizedOwners.values()) {
    if (owners.size > 1) duplicateNormalizedUpcs += 1;
  }
  const needsReviewCategories = [...categoryMappings.values()].filter((m) => m.status === 'needs_review').length;

  return {
    departments: DEPARTMENT_TREE,
    categoryMappings: [...categoryMappings.values()].sort((a, b) =>
      a.sourceCategoryName < b.sourceCategoryName ? -1 : 1,
    ),
    brands: [...brands.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1)),
    products,
    stats: {
      items: items.length,
      variations: variationCount,
      skus: skuCount,
      upcs: upcCount,
      badCheckDigits,
      duplicateNormalizedUpcs,
      excluded,
      needsReviewCategories,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Idempotent apply (keyed on preserved source ids)
 * ------------------------------------------------------------------ */

export interface ImportResult {
  departmentsInserted: number;
  categoryMappingsInserted: number;
  brandsInserted: number;
  productsInserted: number;
  productsUpdated: number;
  variationsInserted: number;
  variationsUpdated: number;
  barcodesInserted: number;
  stats: ImportPlanStats;
}

function boolInt(v: boolean): number {
  return v ? 1 : 0;
}

/**
 * Idempotent import of ledger rows into the catalog for one tenant. Re-running
 * with the same data UPDATES in place (never duplicates) — everything is keyed
 * on the preserved Square source ids (source_item_id, source_variation_id) and
 * on (variation, raw code) for barcodes. Publication is NEVER downgraded on
 * re-run: an owner-published product stays published (unless it becomes
 * excluded by law).
 */
export async function importFromLedger(
  db: Db,
  tenantId: string,
  items: LedgerItem[],
  opts: { actor?: string; events?: EventBus } = {},
): Promise<ImportResult> {
  const actor = opts.actor ?? 'system';
  const plan = buildImportPlan(items);

  const result = await db.transaction().execute(async (trx): Promise<ImportResult> => {
    const now = nowIso();
    const t = trx as unknown as Db;

    // 1) Departments (ensure the curated tree; check-then-insert by slug).
    const deptRows = await t
      .selectFrom('catalog_departments')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .execute();
    const deptIdBySlug = new Map<string, string>(deptRows.map((d) => [d.slug, d.id]));
    let departmentsInserted = 0;
    for (const seed of plan.departments) {
      if (deptIdBySlug.has(seed.slug)) continue;
      const row: CatalogDepartmentRow = {
        id: id(),
        tenant_id: tenantId,
        name: seed.name,
        slug: seed.slug,
        parent_id: seed.parent ? deptIdBySlug.get(seed.parent) ?? null : null,
        sort: seed.sort,
        archived: 0,
        created_at: now,
        updated_at: now,
      };
      await t.insertInto('catalog_departments').values(row).execute();
      deptIdBySlug.set(seed.slug, row.id);
      departmentsInserted += 1;
    }

    // 2) Category mappings (check-then-insert by source name).
    const existingMappings = new Set(
      (
        await t
          .selectFrom('catalog_category_mappings')
          .select('source_category_name')
          .where('tenant_id', '=', tenantId)
          .execute()
      ).map((r) => r.source_category_name),
    );
    let categoryMappingsInserted = 0;
    for (const m of plan.categoryMappings) {
      if (existingMappings.has(m.sourceCategoryName)) continue;
      await t
        .insertInto('catalog_category_mappings')
        .values({
          id: id(),
          tenant_id: tenantId,
          source_category_name: m.sourceCategoryName,
          department_id: m.departmentSlug ? deptIdBySlug.get(m.departmentSlug) ?? null : null,
          status: m.status,
          rule_name: m.ruleName,
          created_at: now,
          updated_at: now,
        })
        .execute();
      categoryMappingsInserted += 1;
    }

    // 3) Brands (check-then-insert by slug).
    const brandRows = await t
      .selectFrom('catalog_brands')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .execute();
    const brandIdBySlug = new Map<string, string>(brandRows.map((b: CatalogBrandRow) => [b.slug, b.id]));
    let brandsInserted = 0;
    for (const b of plan.brands) {
      if (brandIdBySlug.has(b.slug)) continue;
      const row: CatalogBrandRow = {
        id: id(),
        tenant_id: tenantId,
        name: b.name,
        slug: b.slug,
        extraction_rule: 'exact_prefix',
        min_items_met: 1,
        created_at: now,
        updated_at: now,
      };
      await t.insertInto('catalog_brands').values(row).execute();
      brandIdBySlug.set(b.slug, row.id);
      brandsInserted += 1;
    }

    // 4) Products (upsert by source_item_id).
    const productRows = await t
      .selectFrom('catalog_products')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .execute();
    const productBySource = new Map<string, CatalogProductRow>(
      productRows.map((p) => [p.source_item_id, p]),
    );
    let productsInserted = 0;
    let productsUpdated = 0;
    const productIdBySource = new Map<string, string>();

    for (const p of plan.products) {
      const deptId = p.departmentSlug ? deptIdBySlug.get(p.departmentSlug) ?? null : null;
      const brandId = p.brandSlug ? brandIdBySlug.get(p.brandSlug) ?? null : null;
      const existing = productBySource.get(p.sourceItemId);
      if (!existing) {
        const row: CatalogProductRow = {
          id: id(),
          tenant_id: tenantId,
          source_item_id: p.sourceItemId,
          name: p.name,
          description: p.description,
          department_id: deptId,
          brand_id: brandId,
          source_category_name: p.sourceCategoryName,
          publication_state: p.publicationState,
          exclusion_reason: p.exclusionReason,
          archived: 0,
          created_at: now,
          updated_at: now,
        };
        await t.insertInto('catalog_products').values(row).execute();
        productIdBySource.set(p.sourceItemId, row.id);
        productsInserted += 1;
      } else {
        // Preserve owner publication; only enforce exclusion by law.
        let publicationState = existing.publication_state;
        let exclusionReason = existing.exclusion_reason;
        if (p.exclusionReason) {
          publicationState = 'excluded';
          exclusionReason = p.exclusionReason;
        } else if (existing.publication_state === 'excluded' && existing.exclusion_reason !== 'manual') {
          publicationState = 'draft';
          exclusionReason = null;
        }
        await t
          .updateTable('catalog_products')
          .set({
            name: p.name,
            description: p.description,
            department_id: deptId,
            brand_id: brandId,
            source_category_name: p.sourceCategoryName,
            publication_state: publicationState,
            exclusion_reason: exclusionReason,
            updated_at: now,
          })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', existing.id)
          .execute();
        productIdBySource.set(p.sourceItemId, existing.id);
        productsUpdated += 1;
      }
    }

    // 5) Variations (upsert by source_variation_id).
    const variationRows = await t
      .selectFrom('catalog_variations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .execute();
    const variationBySource = new Map<string, CatalogVariationRow>(
      variationRows.map((v) => [v.source_variation_id, v]),
    );
    let variationsInserted = 0;
    let variationsUpdated = 0;
    const variationIdBySource = new Map<string, string>();

    for (const p of plan.products) {
      const productId = productIdBySource.get(p.sourceItemId)!;
      for (const v of p.variations) {
        const existing = variationBySource.get(v.sourceVariationId);
        if (!existing) {
          const row: CatalogVariationRow = {
            id: id(),
            tenant_id: tenantId,
            product_id: productId,
            source_variation_id: v.sourceVariationId,
            name: v.name,
            sku: v.sku,
            price_cents: v.priceCents,
            price_book_id: null,
            track_inventory: boolInt(v.trackInventory),
            archived: 0,
            created_at: now,
            updated_at: now,
          };
          await t.insertInto('catalog_variations').values(row).execute();
          variationIdBySource.set(v.sourceVariationId, row.id);
          variationsInserted += 1;
        } else {
          await t
            .updateTable('catalog_variations')
            .set({
              product_id: productId,
              name: v.name,
              sku: v.sku,
              price_cents: v.priceCents,
              updated_at: now,
            })
            .where('tenant_id', '=', tenantId)
            .where('id', '=', existing.id)
            .execute();
          variationIdBySource.set(v.sourceVariationId, existing.id);
          variationsUpdated += 1;
        }
      }
    }

    // 6) Barcodes (check-then-insert by (variation, raw code)).
    const barcodeRows = await t
      .selectFrom('catalog_barcodes')
      .select(['variation_id', 'code_raw'])
      .where('tenant_id', '=', tenantId)
      .execute();
    const barcodeKey = (variationId: string, raw: string) => `${variationId} ${raw}`;
    const existingBarcodes = new Set(barcodeRows.map((b) => barcodeKey(b.variation_id, b.code_raw)));
    let barcodesInserted = 0;
    for (const p of plan.products) {
      for (const v of p.variations) {
        const variationId = variationIdBySource.get(v.sourceVariationId)!;
        for (const bc of v.barcodes) {
          const key = barcodeKey(variationId, bc.codeRaw);
          if (existingBarcodes.has(key)) continue;
          existingBarcodes.add(key);
          const row: CatalogBarcodeRow = {
            id: id(),
            tenant_id: tenantId,
            variation_id: variationId,
            code_raw: bc.codeRaw,
            code_normalized: bc.codeNormalized,
            symbology: bc.symbology,
            checksum_valid: boolInt(bc.checksumValid),
            is_primary: boolInt(v.barcodes.indexOf(bc) === 0),
            created_at: now,
            updated_at: now,
          };
          await t.insertInto('catalog_barcodes').values(row).execute();
          barcodesInserted += 1;
        }
      }
    }

    await audit(asCoreDb(t), tenantId, actor, 'catalog.import.completed', 'catalog.import', tenantId, {
      productsInserted,
      productsUpdated,
      variationsInserted,
      variationsUpdated,
      barcodesInserted,
    });

    return {
      departmentsInserted,
      categoryMappingsInserted,
      brandsInserted,
      productsInserted,
      productsUpdated,
      variationsInserted,
      variationsUpdated,
      barcodesInserted,
      stats: plan.stats,
    };
  });

  if (opts.events) {
    const itemIds = plan.products.map((p) => p.sourceItemId);
    await opts.events.emit(tenantId, 'catalog.publication.changed', { v: 1, itemIds });
  }
  return result;
}
