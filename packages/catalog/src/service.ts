import type { Kysely } from 'kysely';
import {
  ApiError,
  applyDiscount,
  asCoreDb,
  audit,
  id,
  nowIso,
  serializeCsv,
  parseCsv,
  type Discount,
  type EventBus,
  type Pagination,
} from '@blacklabel/core';
import type {
  CatalogBarcodeRow,
  CatalogBrandRow,
  CatalogCategoryMappingRow,
  CatalogDatabase,
  CatalogDepartmentRow,
  CatalogKitComponentRow,
  CatalogKitRow,
  CatalogPriceBookRow,
  CatalogPriceEntryRow,
  CatalogProductRow,
  CatalogPromotionRow,
  CatalogVariationRow,
  ExclusionReason,
  PublicationState,
} from './schema';
import { analyzeCode, normalizeCode } from './barcode';
import { evaluateExclusion, slugify } from './mapping';

export type Db = Kysely<CatalogDatabase>;

const DEFAULT_PAGE: Pagination = { limit: 50, offset: 0 };

function boolInt(v: boolean): number {
  return v ? 1 : 0;
}

/* ================================================================== *
 * Departments (curated tree)
 * ================================================================== */

export interface DepartmentInput {
  name: string;
  slug?: string;
  parentId?: string | null;
  sort?: number;
}

export async function createDepartment(
  db: Db,
  tenantId: string,
  actor: string,
  input: DepartmentInput,
): Promise<CatalogDepartmentRow> {
  const name = input.name?.trim();
  if (!name) throw ApiError.badRequest('department name is required');
  const slug = (input.slug?.trim() || slugify(name));
  if (!slug) throw ApiError.badRequest('department slug is required');

  // slug is UNIQUE-per-tenant: check-then-insert (no ON CONFLICT).
  const clash = await db
    .selectFrom('catalog_departments')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('slug', '=', slug)
    .executeTakeFirst();
  if (clash) throw ApiError.conflict(`department slug "${slug}" already exists`);

  if (input.parentId) {
    const parent = await getDepartment(db, tenantId, input.parentId);
    if (!parent) throw ApiError.badRequest(`parent department "${input.parentId}" not found`);
  }

  const now = nowIso();
  const row: CatalogDepartmentRow = {
    id: id(),
    tenant_id: tenantId,
    name,
    slug,
    parent_id: input.parentId ?? null,
    sort: input.sort ?? 0,
    archived: 0,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('catalog_departments').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'catalog.department.created', 'catalog.department', row.id, {
    name,
    slug,
  });
  return row;
}

export async function getDepartment(
  db: Db,
  tenantId: string,
  departmentId: string,
): Promise<CatalogDepartmentRow | undefined> {
  return db
    .selectFrom('catalog_departments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', departmentId)
    .executeTakeFirst();
}

export async function listDepartments(db: Db, tenantId: string): Promise<CatalogDepartmentRow[]> {
  return db
    .selectFrom('catalog_departments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('sort')
    .orderBy('id')
    .execute();
}

export async function updateDepartment(
  db: Db,
  tenantId: string,
  actor: string,
  departmentId: string,
  patch: Partial<DepartmentInput> & { archived?: boolean },
): Promise<CatalogDepartmentRow> {
  const existing = await getDepartment(db, tenantId, departmentId);
  if (!existing) throw ApiError.notFound('department not found');
  const update: Partial<CatalogDepartmentRow> = { updated_at: nowIso() };
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.sort !== undefined) update.sort = patch.sort;
  if (patch.parentId !== undefined) {
    if (patch.parentId === departmentId) throw ApiError.badRequest('department cannot be its own parent');
    update.parent_id = patch.parentId;
  }
  if (patch.archived !== undefined) update.archived = boolInt(patch.archived);
  if (patch.slug !== undefined) {
    const slug = patch.slug.trim();
    const clash = await db
      .selectFrom('catalog_departments')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('slug', '=', slug)
      .where('id', '!=', departmentId)
      .executeTakeFirst();
    if (clash) throw ApiError.conflict(`department slug "${slug}" already exists`);
    update.slug = slug;
  }
  await db
    .updateTable('catalog_departments')
    .set(update)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', departmentId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'catalog.department.updated', 'catalog.department', departmentId, update);
  return (await getDepartment(db, tenantId, departmentId))!;
}

export interface DepartmentTreeNode extends CatalogDepartmentRow {
  children: DepartmentTreeNode[];
}

export async function departmentTree(db: Db, tenantId: string): Promise<DepartmentTreeNode[]> {
  const rows = await listDepartments(db, tenantId);
  const byId = new Map<string, DepartmentTreeNode>();
  for (const r of rows) byId.set(r.id, { ...r, children: [] });
  const roots: DepartmentTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) byId.get(node.parent_id)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/* ================================================================== *
 * Category mappings (review queue)
 * ================================================================== */

/** Ensure a mapping row exists for a source category; returns it. Idempotent. */
export async function ensureCategoryMapping(
  db: Db,
  tenantId: string,
  sourceCategoryName: string,
  decision: { departmentId: string | null; status: 'mapped' | 'needs_review'; ruleName: string },
): Promise<CatalogCategoryMappingRow> {
  const existing = await db
    .selectFrom('catalog_category_mappings')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('source_category_name', '=', sourceCategoryName)
    .executeTakeFirst();
  if (existing) return existing;
  const now = nowIso();
  const row: CatalogCategoryMappingRow = {
    id: id(),
    tenant_id: tenantId,
    source_category_name: sourceCategoryName,
    department_id: decision.departmentId,
    status: decision.status,
    rule_name: decision.ruleName,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('catalog_category_mappings').values(row).execute();
  return row;
}

export async function listCategoryMappings(
  db: Db,
  tenantId: string,
  filter: { status?: 'mapped' | 'needs_review' } = {},
  page: Pagination = DEFAULT_PAGE,
): Promise<CatalogCategoryMappingRow[]> {
  let q = db
    .selectFrom('catalog_category_mappings')
    .selectAll()
    .where('tenant_id', '=', tenantId);
  if (filter.status) q = q.where('status', '=', filter.status);
  return q.orderBy('source_category_name').orderBy('id').limit(page.limit).offset(page.offset).execute();
}

/** Approve / assign a mapping to a department (clears needs_review). */
export async function assignCategoryMapping(
  db: Db,
  tenantId: string,
  actor: string,
  mappingId: string,
  departmentId: string,
): Promise<CatalogCategoryMappingRow> {
  const mapping = await db
    .selectFrom('catalog_category_mappings')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', mappingId)
    .executeTakeFirst();
  if (!mapping) throw ApiError.notFound('category mapping not found');
  const dept = await getDepartment(db, tenantId, departmentId);
  if (!dept) throw ApiError.badRequest(`department "${departmentId}" not found`);
  await db
    .updateTable('catalog_category_mappings')
    .set({ department_id: departmentId, status: 'mapped', rule_name: 'manual_review', updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', mappingId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'catalog.category_mapping.assigned', 'catalog.category_mapping', mappingId, {
    departmentId,
  });
  return (await db
    .selectFrom('catalog_category_mappings')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', mappingId)
    .executeTakeFirst())!;
}

/* ================================================================== *
 * Brands
 * ================================================================== */

export async function ensureBrand(
  db: Db,
  tenantId: string,
  name: string,
  slug: string,
): Promise<CatalogBrandRow> {
  const existing = await db
    .selectFrom('catalog_brands')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('slug', '=', slug)
    .executeTakeFirst();
  if (existing) return existing;
  const now = nowIso();
  const row: CatalogBrandRow = {
    id: id(),
    tenant_id: tenantId,
    name,
    slug,
    extraction_rule: 'exact_prefix',
    min_items_met: 1,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('catalog_brands').values(row).execute();
  return row;
}

export async function listBrands(db: Db, tenantId: string): Promise<CatalogBrandRow[]> {
  return db
    .selectFrom('catalog_brands')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .orderBy('id')
    .execute();
}

/* ================================================================== *
 * Products
 * ================================================================== */

export interface ProductInput {
  sourceItemId: string;
  name: string;
  description?: string | null;
  departmentId?: string | null;
  brandId?: string | null;
  sourceCategoryName?: string | null;
}

export async function createProduct(
  db: Db,
  tenantId: string,
  actor: string,
  input: ProductInput,
): Promise<CatalogProductRow> {
  if (!input.sourceItemId?.trim()) throw ApiError.badRequest('sourceItemId is required');
  if (!input.name?.trim()) throw ApiError.badRequest('product name is required');
  const clash = await db
    .selectFrom('catalog_products')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('source_item_id', '=', input.sourceItemId)
    .executeTakeFirst();
  if (clash) throw ApiError.conflict(`product source_item_id "${input.sourceItemId}" already exists`);

  const exclusion = evaluateExclusion(input.name, input.sourceCategoryName ?? null);
  const now = nowIso();
  const row: CatalogProductRow = {
    id: id(),
    tenant_id: tenantId,
    source_item_id: input.sourceItemId,
    name: input.name.trim(),
    description: input.description ?? null,
    department_id: input.departmentId ?? null,
    brand_id: input.brandId ?? null,
    source_category_name: input.sourceCategoryName ?? null,
    publication_state: exclusion.excluded ? 'excluded' : 'draft',
    exclusion_reason: exclusion.reason,
    archived: 0,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('catalog_products').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'catalog.product.created', 'catalog.product', row.id, {
    sourceItemId: row.source_item_id,
    publication_state: row.publication_state,
  });
  return row;
}

export async function getProduct(
  db: Db,
  tenantId: string,
  productId: string,
): Promise<CatalogProductRow | undefined> {
  return db
    .selectFrom('catalog_products')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', productId)
    .executeTakeFirst();
}

export async function updateProduct(
  db: Db,
  tenantId: string,
  actor: string,
  productId: string,
  patch: Partial<Omit<ProductInput, 'sourceItemId'>> & { archived?: boolean },
): Promise<CatalogProductRow> {
  const existing = await getProduct(db, tenantId, productId);
  if (!existing) throw ApiError.notFound('product not found');
  const update: Partial<CatalogProductRow> = { updated_at: nowIso() };
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.description !== undefined) update.description = patch.description;
  if (patch.departmentId !== undefined) update.department_id = patch.departmentId;
  if (patch.brandId !== undefined) update.brand_id = patch.brandId;
  if (patch.sourceCategoryName !== undefined) update.source_category_name = patch.sourceCategoryName;
  if (patch.archived !== undefined) update.archived = boolInt(patch.archived);
  await db
    .updateTable('catalog_products')
    .set(update)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', productId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'catalog.product.updated', 'catalog.product', productId, update);
  return (await getProduct(db, tenantId, productId))!;
}

export async function listProducts(
  db: Db,
  tenantId: string,
  filter: { publicationState?: PublicationState; departmentId?: string; brandId?: string } = {},
  page: Pagination = DEFAULT_PAGE,
): Promise<CatalogProductRow[]> {
  let q = db.selectFrom('catalog_products').selectAll().where('tenant_id', '=', tenantId);
  if (filter.publicationState) q = q.where('publication_state', '=', filter.publicationState);
  if (filter.departmentId) q = q.where('department_id', '=', filter.departmentId);
  if (filter.brandId) q = q.where('brand_id', '=', filter.brandId);
  return q.orderBy('name').orderBy('id').limit(page.limit).offset(page.offset).execute();
}

/**
 * Search products by name substring, exact sku, or barcode (normalized/raw).
 * Deterministic order (name, id). Paginated.
 */
export async function searchProducts(
  db: Db,
  tenantId: string,
  query: string,
  page: Pagination = DEFAULT_PAGE,
): Promise<CatalogProductRow[]> {
  const q = query.trim();
  if (!q) return listProducts(db, tenantId, {}, page);
  const productIds = new Set<string>();

  const byName = await db
    .selectFrom('catalog_products')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('name', 'like', `%${q}%`)
    .execute();
  byName.forEach((r) => productIds.add(r.id));

  const norm = normalizeCode(q);
  const bySkuOrCode = await db
    .selectFrom('catalog_variations')
    .select('product_id')
    .where('tenant_id', '=', tenantId)
    .where((eb) =>
      eb.or([
        eb('sku', '=', q),
        eb(
          'id',
          'in',
          db
            .selectFrom('catalog_barcodes')
            .select('variation_id')
            .where('tenant_id', '=', tenantId)
            .where((b) =>
              b.or([b('code_raw', '=', q), ...(norm ? [b('code_normalized', '=', norm)] : [])]),
            ),
        ),
      ]),
    )
    .execute();
  bySkuOrCode.forEach((r) => productIds.add(r.product_id));

  if (productIds.size === 0) return [];
  return db
    .selectFrom('catalog_products')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', 'in', [...productIds])
    .orderBy('name')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

/* ================================================================== *
 * Variations
 * ================================================================== */

export interface VariationInput {
  productId: string;
  sourceVariationId: string;
  name?: string;
  sku?: string | null;
  priceCents?: number | null;
  priceBookId?: string | null;
  trackInventory?: boolean;
}

function assertPriceCents(price: number | null | undefined): void {
  if (price === null || price === undefined) return;
  if (!Number.isInteger(price)) throw ApiError.badRequest(`price_cents must be integer cents, got ${price}`);
  if (price < 0) throw ApiError.badRequest('price_cents must not be negative');
}

export async function createVariation(
  db: Db,
  tenantId: string,
  actor: string,
  events: EventBus,
  input: VariationInput,
): Promise<CatalogVariationRow> {
  if (!input.sourceVariationId?.trim()) throw ApiError.badRequest('sourceVariationId is required');
  assertPriceCents(input.priceCents);
  const product = await getProduct(db, tenantId, input.productId);
  if (!product) throw ApiError.badRequest(`product "${input.productId}" not found`);
  const clash = await db
    .selectFrom('catalog_variations')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('source_variation_id', '=', input.sourceVariationId)
    .executeTakeFirst();
  if (clash) throw ApiError.conflict(`variation source_variation_id "${input.sourceVariationId}" already exists`);

  const now = nowIso();
  const row: CatalogVariationRow = {
    id: id(),
    tenant_id: tenantId,
    product_id: input.productId,
    source_variation_id: input.sourceVariationId,
    name: input.name?.trim() || 'Regular',
    sku: input.sku ?? null,
    price_cents: input.priceCents ?? null,
    price_book_id: input.priceBookId ?? null,
    track_inventory: boolInt(input.trackInventory ?? true),
    archived: 0,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('catalog_variations').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'catalog.variation.created', 'catalog.variation', row.id, {
    sourceVariationId: row.source_variation_id,
  });
  await events.emit(tenantId, 'catalog.variation.changed', { v: 1, variationId: row.id });
  return row;
}

export async function getVariation(
  db: Db,
  tenantId: string,
  variationId: string,
): Promise<CatalogVariationRow | undefined> {
  return db
    .selectFrom('catalog_variations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', variationId)
    .executeTakeFirst();
}

export async function listVariations(
  db: Db,
  tenantId: string,
  filter: { productId?: string } = {},
  page: Pagination = DEFAULT_PAGE,
): Promise<CatalogVariationRow[]> {
  let q = db.selectFrom('catalog_variations').selectAll().where('tenant_id', '=', tenantId);
  if (filter.productId) q = q.where('product_id', '=', filter.productId);
  return q.orderBy('name').orderBy('id').limit(page.limit).offset(page.offset).execute();
}

export async function updateVariation(
  db: Db,
  tenantId: string,
  actor: string,
  events: EventBus,
  variationId: string,
  patch: Partial<Omit<VariationInput, 'productId' | 'sourceVariationId'>> & { archived?: boolean },
): Promise<CatalogVariationRow> {
  const existing = await getVariation(db, tenantId, variationId);
  if (!existing) throw ApiError.notFound('variation not found');
  assertPriceCents(patch.priceCents);
  const update: Partial<CatalogVariationRow> = { updated_at: nowIso() };
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.sku !== undefined) update.sku = patch.sku;
  if (patch.priceCents !== undefined) update.price_cents = patch.priceCents;
  if (patch.priceBookId !== undefined) update.price_book_id = patch.priceBookId;
  if (patch.trackInventory !== undefined) update.track_inventory = boolInt(patch.trackInventory);
  if (patch.archived !== undefined) update.archived = boolInt(patch.archived);
  await db
    .updateTable('catalog_variations')
    .set(update)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', variationId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'catalog.variation.updated', 'catalog.variation', variationId, update);
  await events.emit(tenantId, 'catalog.variation.changed', { v: 1, variationId });
  return (await getVariation(db, tenantId, variationId))!;
}

/* ================================================================== *
 * Barcodes
 * ================================================================== */

export async function addBarcode(
  db: Db,
  tenantId: string,
  actor: string,
  variationId: string,
  codeRaw: string,
  opts: { isPrimary?: boolean } = {},
): Promise<CatalogBarcodeRow> {
  const variation = await getVariation(db, tenantId, variationId);
  if (!variation) throw ApiError.badRequest(`variation "${variationId}" not found`);
  const analyzed = analyzeCode(codeRaw);
  // A given raw code is stored once per variation (idempotent): check-then-insert.
  const dupe = await db
    .selectFrom('catalog_barcodes')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('variation_id', '=', variationId)
    .where('code_raw', '=', analyzed.codeRaw)
    .executeTakeFirst();
  if (dupe) return dupe;

  const now = nowIso();
  const row: CatalogBarcodeRow = {
    id: id(),
    tenant_id: tenantId,
    variation_id: variationId,
    code_raw: analyzed.codeRaw,
    code_normalized: analyzed.codeNormalized,
    symbology: analyzed.symbology,
    checksum_valid: boolInt(analyzed.checksumValid),
    is_primary: boolInt(opts.isPrimary ?? false),
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('catalog_barcodes').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'catalog.barcode.added', 'catalog.barcode', row.id, {
    variationId,
    code_normalized: row.code_normalized,
    checksum_valid: row.checksum_valid,
  });
  return row;
}

export async function listBarcodes(
  db: Db,
  tenantId: string,
  variationId: string,
): Promise<CatalogBarcodeRow[]> {
  return db
    .selectFrom('catalog_barcodes')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('variation_id', '=', variationId)
    .orderBy('is_primary', 'desc')
    .orderBy('id')
    .execute();
}

export interface VariationMatch {
  variation: CatalogVariationRow;
  product: CatalogProductRow | undefined;
  barcode?: CatalogBarcodeRow;
}

export interface LookupResult {
  matchType: 'barcode' | 'sku' | 'name' | 'none';
  matches: VariationMatch[];
}

async function hydrateVariations(
  db: Db,
  tenantId: string,
  variations: CatalogVariationRow[],
  barcodeByVariation?: Map<string, CatalogBarcodeRow>,
): Promise<VariationMatch[]> {
  const productIds = [...new Set(variations.map((v) => v.product_id))];
  const products =
    productIds.length > 0
      ? await db
          .selectFrom('catalog_products')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('id', 'in', productIds)
          .execute()
      : [];
  const productById = new Map(products.map((p) => [p.id, p]));
  return variations.map((v) => ({
    variation: v,
    product: productById.get(v.product_id),
    barcode: barcodeByVariation?.get(v.id),
  }));
}

/**
 * Lookup by code with precedence: normalized-barcode exact (ALL matches when
 * duplicated codes exist — merge-tolerant), then exact sku, then name substring.
 */
export async function lookupByCode(db: Db, tenantId: string, code: string): Promise<LookupResult> {
  const raw = (code ?? '').trim();
  if (!raw) return { matchType: 'none', matches: [] };
  const norm = normalizeCode(raw);

  // 1) normalized barcode exact (or raw exact when the code has no digits)
  let barcodes: CatalogBarcodeRow[] = [];
  if (norm) {
    barcodes = await db
      .selectFrom('catalog_barcodes')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('code_normalized', '=', norm)
      .orderBy('variation_id')
      .orderBy('id')
      .execute();
  }
  if (barcodes.length === 0) {
    barcodes = await db
      .selectFrom('catalog_barcodes')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('code_raw', '=', raw)
      .orderBy('variation_id')
      .orderBy('id')
      .execute();
  }
  if (barcodes.length > 0) {
    const varIds = [...new Set(barcodes.map((b) => b.variation_id))];
    const variations = await db
      .selectFrom('catalog_variations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', 'in', varIds)
      .orderBy('id')
      .execute();
    const bcByVar = new Map<string, CatalogBarcodeRow>();
    for (const b of barcodes) if (!bcByVar.has(b.variation_id)) bcByVar.set(b.variation_id, b);
    return { matchType: 'barcode', matches: await hydrateVariations(db, tenantId, variations, bcByVar) };
  }

  // 2) exact sku
  const bySku = await db
    .selectFrom('catalog_variations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('sku', '=', raw)
    .orderBy('id')
    .execute();
  if (bySku.length > 0) {
    return { matchType: 'sku', matches: await hydrateVariations(db, tenantId, bySku) };
  }

  // 3) name substring fallback (product name)
  const products = await db
    .selectFrom('catalog_products')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('name', 'like', `%${raw}%`)
    .execute();
  if (products.length > 0) {
    const variations = await db
      .selectFrom('catalog_variations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('product_id', 'in', products.map((p) => p.id))
      .orderBy('id')
      .execute();
    if (variations.length > 0) {
      return { matchType: 'name', matches: await hydrateVariations(db, tenantId, variations) };
    }
  }
  return { matchType: 'none', matches: [] };
}

export interface BarcodeConflict {
  codeNormalized: string;
  variationIds: string[];
  barcodeIds: string[];
}

/** Normalized codes that resolve to more than one variation (duplicate scans). */
export async function listBarcodeConflicts(db: Db, tenantId: string): Promise<BarcodeConflict[]> {
  const rows = await db
    .selectFrom('catalog_barcodes')
    .select(['id', 'variation_id', 'code_normalized'])
    .where('tenant_id', '=', tenantId)
    .where('code_normalized', '!=', '')
    .orderBy('code_normalized')
    .orderBy('id')
    .execute();
  const byCode = new Map<string, { variationIds: Set<string>; barcodeIds: string[] }>();
  for (const r of rows) {
    let g = byCode.get(r.code_normalized);
    if (!g) {
      g = { variationIds: new Set(), barcodeIds: [] };
      byCode.set(r.code_normalized, g);
    }
    g.variationIds.add(r.variation_id);
    g.barcodeIds.push(r.id);
  }
  const conflicts: BarcodeConflict[] = [];
  for (const [codeNormalized, g] of byCode) {
    if (g.variationIds.size > 1) {
      conflicts.push({ codeNormalized, variationIds: [...g.variationIds], barcodeIds: g.barcodeIds });
    }
  }
  conflicts.sort((a, b) => (a.codeNormalized < b.codeNormalized ? -1 : 1));
  return conflicts;
}

/* ================================================================== *
 * Publication / exclusion
 * ================================================================== */

export interface PublicationCheck {
  eligible: boolean;
  reasons: string[];
  excluded: boolean;
  exclusionReason: ExclusionReason | null;
}

/** Evaluate whether a product may be published (not excluded, has dept + price). */
export async function evaluatePublication(
  db: Db,
  tenantId: string,
  productId: string,
  opts: { allowUnpriced?: boolean } = {},
): Promise<PublicationCheck> {
  const product = await getProduct(db, tenantId, productId);
  if (!product) throw ApiError.notFound('product not found');
  const exclusion = evaluateExclusion(product.name, product.source_category_name);
  const reasons: string[] = [];
  if (exclusion.excluded) reasons.push(`excluded:${exclusion.reason}`);
  if (!product.department_id) reasons.push('missing_department');
  let hasPrice = false;
  if (!opts.allowUnpriced) {
    const priced = await db
      .selectFrom('catalog_variations')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('product_id', '=', productId)
      .where('price_cents', 'is not', null)
      .executeTakeFirst();
    hasPrice = !!priced;
    if (!hasPrice) reasons.push('no_price');
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    excluded: exclusion.excluded,
    exclusionReason: exclusion.reason,
  };
}

/**
 * Transition a product's publication state.
 * - target 'published' requires evaluatePublication().eligible (never publish an
 *   excluded product; must have a department and a price unless allowUnpriced).
 * - target 'excluded' records reason 'manual' (owner override).
 * Emits catalog.publication.changed { itemIds:[productId] }.
 */
export async function setPublicationState(
  db: Db,
  tenantId: string,
  actor: string,
  events: EventBus,
  productId: string,
  target: PublicationState,
  opts: { allowUnpriced?: boolean } = {},
): Promise<CatalogProductRow> {
  const product = await getProduct(db, tenantId, productId);
  if (!product) throw ApiError.notFound('product not found');

  let exclusionReason: ExclusionReason | null = product.exclusion_reason;
  if (target === 'published') {
    const check = await evaluatePublication(db, tenantId, productId, opts);
    if (!check.eligible) {
      throw ApiError.badRequest('product is not eligible to publish', { reasons: check.reasons });
    }
    exclusionReason = null;
  } else if (target === 'excluded') {
    exclusionReason = product.exclusion_reason ?? 'manual';
  } else {
    // draft: keep any auto exclusion reason as informational, clear manual
    exclusionReason = product.exclusion_reason === 'manual' ? null : product.exclusion_reason;
  }

  await db
    .updateTable('catalog_products')
    .set({ publication_state: target, exclusion_reason: exclusionReason, updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', productId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'catalog.publication.changed', 'catalog.product', productId, {
    from: product.publication_state,
    to: target,
    exclusionReason,
  });
  await events.emit(tenantId, 'catalog.publication.changed', { v: 1, itemIds: [productId] });
  return (await getProduct(db, tenantId, productId))!;
}

/* ================================================================== *
 * Price books, entries, deterministic resolution
 * ================================================================== */

export interface PriceBookInput {
  name: string;
  currency?: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  status?: string;
}

export async function createPriceBook(
  db: Db,
  tenantId: string,
  actor: string,
  input: PriceBookInput,
): Promise<CatalogPriceBookRow> {
  if (!input.name?.trim()) throw ApiError.badRequest('price book name is required');
  const now = nowIso();
  const row: CatalogPriceBookRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    currency: input.currency ?? 'USD',
    effective_from: input.effectiveFrom ?? null,
    effective_to: input.effectiveTo ?? null,
    status: input.status ?? 'active',
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('catalog_price_books').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'catalog.price_book.created', 'catalog.price_book', row.id, {
    name: row.name,
  });
  return row;
}

export async function listPriceBooks(db: Db, tenantId: string): Promise<CatalogPriceBookRow[]> {
  return db
    .selectFrom('catalog_price_books')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .orderBy('id')
    .execute();
}

export interface PriceEntryInput {
  priceBookId: string;
  variationId: string;
  priceCents: number;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export async function addPriceEntry(
  db: Db,
  tenantId: string,
  actor: string,
  input: PriceEntryInput,
): Promise<CatalogPriceEntryRow> {
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
    throw ApiError.badRequest('priceCents must be a non-negative integer');
  }
  const book = await db
    .selectFrom('catalog_price_books')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', input.priceBookId)
    .executeTakeFirst();
  if (!book) throw ApiError.badRequest(`price book "${input.priceBookId}" not found`);
  const variation = await getVariation(db, tenantId, input.variationId);
  if (!variation) throw ApiError.badRequest(`variation "${input.variationId}" not found`);
  const now = nowIso();
  const row: CatalogPriceEntryRow = {
    id: id(),
    tenant_id: tenantId,
    price_book_id: input.priceBookId,
    variation_id: input.variationId,
    price_cents: input.priceCents,
    effective_from: input.effectiveFrom ?? null,
    effective_to: input.effectiveTo ?? null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('catalog_price_entries').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'catalog.price_entry.added', 'catalog.price_entry', row.id, {
    variationId: input.variationId,
    priceCents: input.priceCents,
  });
  return row;
}

export interface ResolvedPrice {
  priceCents: number | null;
  source: 'entry' | 'variation' | 'unset';
  priceEntryId: string | null;
  priceBookId: string | null;
}

/** Is a nullable window [from,to) open at `at`? Null bound = open-ended. */
function windowActive(from: string | null, to: string | null, at: string): boolean {
  if (from !== null && from > at) return false;
  if (to !== null && to <= at) return false;
  return true;
}

/**
 * Deterministic price resolution at instant `at` (ISO): among ACTIVE price-book
 * entries (entry window open AND its price book active + window open), pick the
 * most specific — an entry with a defined effective_from beats an open-ended
 * one; tie → latest effective_from; tie → id. No active entry → the variation's
 * base price (which may be null = "price not listed"). Future-dated entries
 * (effective_from > at) are not yet active.
 */
export async function resolvePrice(
  db: Db,
  tenantId: string,
  variationId: string,
  at: string = nowIso(),
): Promise<ResolvedPrice> {
  const variation = await getVariation(db, tenantId, variationId);
  if (!variation) throw ApiError.notFound('variation not found');

  const entries = await db
    .selectFrom('catalog_price_entries')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('variation_id', '=', variationId)
    .execute();
  const books = await db
    .selectFrom('catalog_price_books')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .execute();
  const bookById = new Map(books.map((b) => [b.id, b]));

  const active = entries.filter((e) => {
    if (!windowActive(e.effective_from, e.effective_to, at)) return false;
    const book = bookById.get(e.price_book_id);
    if (!book || book.status !== 'active') return false;
    return windowActive(book.effective_from, book.effective_to, at);
  });

  if (active.length > 0) {
    active.sort((a, b) => {
      // most specific first: defined effective_from beats null
      const af = a.effective_from;
      const bf = b.effective_from;
      if (af !== bf) {
        if (af === null) return 1;
        if (bf === null) return -1;
        return af < bf ? 1 : -1; // latest effective_from first
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const chosen = active[0];
    return {
      priceCents: chosen.price_cents,
      source: 'entry',
      priceEntryId: chosen.id,
      priceBookId: chosen.price_book_id,
    };
  }

  if (variation.price_cents !== null) {
    return { priceCents: variation.price_cents, source: 'variation', priceEntryId: null, priceBookId: null };
  }
  return { priceCents: null, source: 'unset', priceEntryId: null, priceBookId: null };
}

/* ================================================================== *
 * Promotions
 * ================================================================== */

export interface PromotionScope {
  departmentIds?: string[];
  brandIds?: string[];
  productIds?: string[];
}

export interface PromotionInput {
  name: string;
  type: 'percent_bps' | 'fixed_cents';
  value: number;
  scope?: PromotionScope;
  startsAt?: string | null;
  endsAt?: string | null;
  status?: string;
}

export async function createPromotion(
  db: Db,
  tenantId: string,
  actor: string,
  input: PromotionInput,
): Promise<CatalogPromotionRow> {
  if (!input.name?.trim()) throw ApiError.badRequest('promotion name is required');
  if (!Number.isInteger(input.value) || input.value < 0) {
    throw ApiError.badRequest('promotion value must be a non-negative integer');
  }
  if (input.type === 'percent_bps' && input.value > 10000) {
    throw ApiError.badRequest('percent_bps promotion cannot exceed 10000 bps');
  }
  const now = nowIso();
  const row: CatalogPromotionRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    type: input.type,
    value: input.value,
    scope: JSON.stringify(input.scope ?? {}),
    starts_at: input.startsAt ?? null,
    ends_at: input.endsAt ?? null,
    status: input.status ?? 'active',
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('catalog_promotions').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'catalog.promotion.created', 'catalog.promotion', row.id, {
    name: row.name,
    type: row.type,
    value: row.value,
  });
  return row;
}

export async function listPromotions(db: Db, tenantId: string): Promise<CatalogPromotionRow[]> {
  return db
    .selectFrom('catalog_promotions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .orderBy('id')
    .execute();
}

export function promotionDiscount(promotion: CatalogPromotionRow): Discount {
  return promotion.type === 'percent_bps'
    ? { bps: promotion.value }
    : { fixedCents: promotion.value };
}

/** Apply a promotion to a base price using core's applyDiscount (to the cent). */
export function applyPromotion(baseCents: number, promotion: CatalogPromotionRow): number {
  return applyDiscount(baseCents, promotionDiscount(promotion));
}

function scopeMatches(scope: PromotionScope, ctx: { departmentId?: string | null; brandId?: string | null; productId?: string }): boolean {
  const empty = !scope.departmentIds?.length && !scope.brandIds?.length && !scope.productIds?.length;
  if (empty) return true; // no scope = applies to everything
  if (scope.productIds?.length && ctx.productId && scope.productIds.includes(ctx.productId)) return true;
  if (scope.departmentIds?.length && ctx.departmentId && scope.departmentIds.includes(ctx.departmentId)) return true;
  if (scope.brandIds?.length && ctx.brandId && scope.brandIds.includes(ctx.brandId)) return true;
  return false;
}

export interface PromotedPrice {
  baseCents: number | null;
  bestCents: number | null;
  promotionId: string | null;
}

/**
 * Resolve the best promoted price for a variation at instant `at`: start from
 * resolvePrice, then apply each in-window, in-scope promotion via applyPromotion
 * and keep the lowest result. Deterministic (promotions ordered by id).
 */
export async function resolvePromotedPrice(
  db: Db,
  tenantId: string,
  variationId: string,
  at: string = nowIso(),
): Promise<PromotedPrice> {
  const resolved = await resolvePrice(db, tenantId, variationId, at);
  if (resolved.priceCents === null) return { baseCents: null, bestCents: null, promotionId: null };
  const variation = (await getVariation(db, tenantId, variationId))!;
  const product = await getProduct(db, tenantId, variation.product_id);
  const promos = await db
    .selectFrom('catalog_promotions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'active')
    .orderBy('id')
    .execute();
  let best = resolved.priceCents;
  let promotionId: string | null = null;
  for (const promo of promos) {
    if (!windowActive(promo.starts_at, promo.ends_at, at)) continue;
    const scope = JSON.parse(promo.scope) as PromotionScope;
    if (!scopeMatches(scope, { departmentId: product?.department_id, brandId: product?.brand_id, productId: variation.product_id })) {
      continue;
    }
    const candidate = applyPromotion(resolved.priceCents, promo);
    if (candidate < best) {
      best = candidate;
      promotionId = promo.id;
    }
  }
  return { baseCents: resolved.priceCents, bestCents: best, promotionId };
}

/* ================================================================== *
 * Kits / bundles
 * ================================================================== */

export async function createKit(
  db: Db,
  tenantId: string,
  actor: string,
  input: { productId: string; name?: string },
): Promise<CatalogKitRow> {
  const product = await getProduct(db, tenantId, input.productId);
  if (!product) throw ApiError.badRequest(`product "${input.productId}" not found`);
  const clash = await db
    .selectFrom('catalog_kits')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('product_id', '=', input.productId)
    .executeTakeFirst();
  if (clash) throw ApiError.conflict('a kit already exists for this product');
  const now = nowIso();
  const row: CatalogKitRow = {
    id: id(),
    tenant_id: tenantId,
    product_id: input.productId,
    name: input.name?.trim() || product.name,
    archived: 0,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('catalog_kits').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'catalog.kit.created', 'catalog.kit', row.id, { productId: input.productId });
  return row;
}

export async function addKitComponent(
  db: Db,
  tenantId: string,
  actor: string,
  kitId: string,
  variationId: string,
  quantity: number,
): Promise<CatalogKitComponentRow> {
  if (!Number.isInteger(quantity) || quantity <= 0) throw ApiError.badRequest('quantity must be a positive integer');
  const kit = await db
    .selectFrom('catalog_kits')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', kitId)
    .executeTakeFirst();
  if (!kit) throw ApiError.badRequest(`kit "${kitId}" not found`);
  const variation = await getVariation(db, tenantId, variationId);
  if (!variation) throw ApiError.badRequest(`variation "${variationId}" not found`);
  const now = nowIso();
  const row: CatalogKitComponentRow = {
    id: id(),
    tenant_id: tenantId,
    kit_id: kitId,
    variation_id: variationId,
    quantity,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('catalog_kit_components').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'catalog.kit_component.added', 'catalog.kit', kitId, {
    variationId,
    quantity,
  });
  return row;
}

export interface KitComposition {
  kit: CatalogKitRow;
  components: CatalogKitComponentRow[];
  /** Sum of component base prices × qty at `at`; null if any component price unset. */
  componentPriceCents: number | null;
}

export async function getKitComposition(
  db: Db,
  tenantId: string,
  kitId: string,
  at: string = nowIso(),
): Promise<KitComposition> {
  const kit = await db
    .selectFrom('catalog_kits')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', kitId)
    .executeTakeFirst();
  if (!kit) throw ApiError.notFound('kit not found');
  const components = await db
    .selectFrom('catalog_kit_components')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('kit_id', '=', kitId)
    .orderBy('id')
    .execute();
  let total = 0;
  let known = true;
  for (const comp of components) {
    const price = await resolvePrice(db, tenantId, comp.variation_id, at);
    if (price.priceCents === null) {
      known = false;
    } else {
      total += price.priceCents * comp.quantity;
    }
  }
  return { kit, components, componentPriceCents: known ? total : null };
}

export async function listKits(db: Db, tenantId: string): Promise<CatalogKitRow[]> {
  return db
    .selectFrom('catalog_kits')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .orderBy('id')
    .execute();
}

/* ================================================================== *
 * Label data (for the label-printer lane; rendering happens elsewhere)
 * ================================================================== */

export interface LabelRow {
  variationId: string;
  sku: string | null;
  name: string;
  priceCents: number | null;
  code128Payload: string | null;
}

/**
 * Label data for a set of variations: sku, name, resolved price, and the
 * Code 128 payload (primary barcode's normalized code, else raw, else sku).
 */
export async function labelData(
  db: Db,
  tenantId: string,
  variationIds: string[],
  at: string = nowIso(),
): Promise<LabelRow[]> {
  if (variationIds.length === 0) return [];
  const variations = await db
    .selectFrom('catalog_variations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', 'in', variationIds)
    .execute();
  const barcodes = await db
    .selectFrom('catalog_barcodes')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('variation_id', 'in', variationIds)
    .orderBy('is_primary', 'desc')
    .orderBy('id')
    .execute();
  const primaryByVar = new Map<string, CatalogBarcodeRow>();
  for (const b of barcodes) if (!primaryByVar.has(b.variation_id)) primaryByVar.set(b.variation_id, b);

  const order = new Map(variationIds.map((v, i) => [v, i]));
  variations.sort((a, b) => (order.get(a.id)! - order.get(b.id)!));

  const out: LabelRow[] = [];
  for (const v of variations) {
    const price = await resolvePrice(db, tenantId, v.id, at);
    const bc = primaryByVar.get(v.id);
    const payload = bc ? bc.code_normalized || bc.code_raw : v.sku ?? null;
    out.push({
      variationId: v.id,
      sku: v.sku,
      name: v.name,
      priceCents: price.priceCents,
      code128Payload: payload || null,
    });
  }
  return out;
}

/* ================================================================== *
 * Bulk CSV export / two-phase import
 * ================================================================== */

const CSV_COLUMNS = ['source_variation_id', 'source_item_id', 'name', 'sku', 'price_cents'] as const;

export async function exportVariationsCsv(db: Db, tenantId: string): Promise<string> {
  const rows = await db
    .selectFrom('catalog_variations as v')
    .innerJoin('catalog_products as p', (j) =>
      j.onRef('p.id', '=', 'v.product_id').on('p.tenant_id', '=', tenantId),
    )
    .select([
      'v.source_variation_id as source_variation_id',
      'p.source_item_id as source_item_id',
      'v.name as name',
      'v.sku as sku',
      'v.price_cents as price_cents',
    ])
    .where('v.tenant_id', '=', tenantId)
    .orderBy('v.source_variation_id')
    .orderBy('v.id')
    .execute();
  const records = rows.map((r) => ({
    source_variation_id: r.source_variation_id,
    source_item_id: r.source_item_id,
    name: r.name,
    sku: r.sku ?? '',
    price_cents: r.price_cents === null ? '' : String(r.price_cents),
  }));
  return serializeCsv(records, CSV_COLUMNS as unknown as string[]);
}

export interface RowError {
  row: number;
  message: string;
}

export interface ImportPreview {
  totalRows: number;
  okRows: number;
  failedRows: number;
  errors: RowError[];
  /** Parsed valid updates keyed by source_variation_id (for commit). */
  valid: { sourceVariationId: string; name?: string; sku?: string | null; priceCents?: number | null }[];
}

/** PHASE 1 — validate a CSV, reporting row-level errors; mutates nothing. */
export function previewVariationImport(csvText: string): ImportPreview {
  const records = parseCsv(csvText);
  const errors: RowError[] = [];
  const valid: ImportPreview['valid'] = [];
  records.forEach((rec, i) => {
    const rowNum = i + 2; // header is row 1
    const sourceVariationId = (rec.source_variation_id ?? '').trim();
    if (!sourceVariationId) {
      errors.push({ row: rowNum, message: 'source_variation_id is required' });
      return;
    }
    let priceCents: number | null | undefined;
    const rawPrice = (rec.price_cents ?? '').trim();
    if (rawPrice === '') {
      priceCents = null;
    } else if (!/^\d+$/.test(rawPrice)) {
      errors.push({ row: rowNum, message: `price_cents must be integer cents or blank, got "${rawPrice}"` });
      return;
    } else {
      priceCents = Number(rawPrice);
    }
    valid.push({
      sourceVariationId,
      name: rec.name !== undefined ? rec.name : undefined,
      sku: rec.sku !== undefined ? (rec.sku === '' ? null : rec.sku) : undefined,
      priceCents,
    });
  });
  return {
    totalRows: records.length,
    okRows: valid.length,
    failedRows: errors.length,
    errors,
    valid,
  };
}

export interface ImportCommitResult {
  bulkJobId: string;
  totalRows: number;
  updated: number;
  skippedUnknown: number;
  failedRows: number;
  errors: RowError[];
}

/**
 * PHASE 2 — commit a validated CSV. Applies only valid rows (idempotent update
 * keyed on source_variation_id); unknown source ids are counted, not created;
 * invalid rows are reported (never partial-silent). Records a bulk-job row.
 */
export async function commitVariationImport(
  db: Db,
  tenantId: string,
  actor: string,
  events: EventBus,
  csvText: string,
): Promise<ImportCommitResult> {
  const preview = previewVariationImport(csvText);
  let updated = 0;
  let skippedUnknown = 0;
  const changedIds: string[] = [];
  for (const v of preview.valid) {
    const existing = await db
      .selectFrom('catalog_variations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('source_variation_id', '=', v.sourceVariationId)
      .executeTakeFirst();
    if (!existing) {
      skippedUnknown += 1;
      continue;
    }
    const set: Partial<CatalogVariationRow> = { updated_at: nowIso() };
    if (v.name !== undefined && v.name.trim() !== '') set.name = v.name.trim();
    if (v.sku !== undefined) set.sku = v.sku;
    if (v.priceCents !== undefined) set.price_cents = v.priceCents;
    await db
      .updateTable('catalog_variations')
      .set(set)
      .where('tenant_id', '=', tenantId)
      .where('id', '=', existing.id)
      .execute();
    updated += 1;
    changedIds.push(existing.id);
  }

  const now = nowIso();
  const bulkJobId = id();
  await db
    .insertInto('catalog_bulk_jobs')
    .values({
      id: bulkJobId,
      tenant_id: tenantId,
      kind: 'variation_import',
      status: preview.failedRows === 0 ? 'completed' : 'completed_with_errors',
      rows_total: preview.totalRows,
      rows_ok: updated,
      rows_failed: preview.failedRows,
      errors: JSON.stringify(preview.errors),
      created_at: now,
      updated_at: now,
    })
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'catalog.bulk_job.completed', 'catalog.bulk_job', bulkJobId, {
    kind: 'variation_import',
    updated,
    failedRows: preview.failedRows,
    skippedUnknown,
  });
  for (const vid of changedIds) {
    await events.emit(tenantId, 'catalog.variation.changed', { v: 1, variationId: vid });
  }
  return {
    bulkJobId,
    totalRows: preview.totalRows,
    updated,
    skippedUnknown,
    failedRows: preview.failedRows,
    errors: preview.errors,
  };
}

export async function listBulkJobs(db: Db, tenantId: string): Promise<CatalogDatabase['catalog_bulk_jobs'][]> {
  return db
    .selectFrom('catalog_bulk_jobs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .execute();
}
