import type { Kysely } from 'kysely';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  parseCsv,
  type Pagination,
} from '@blacklabel/core';
import type {
  VendorRow,
  VendorStatus,
  VendorCatalogEntryRow,
  VendorImportJobRow,
  VendorsDatabase,
} from './schema';

type Db = Kysely<VendorsDatabase>;

/* ------------------------------------------------------------------ *
 * Vendors CRUD
 * ------------------------------------------------------------------ */

export interface VendorContact {
  name?: string;
  email?: string;
  phone?: string;
  role?: string;
}

export interface VendorAddress {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postal?: string;
  country?: string;
}

export interface CreateVendorInput {
  name: string;
  contacts?: VendorContact[];
  address?: VendorAddress;
  accountNumber?: string | null;
  paymentTerms?: string | null;
  leadTimeDays?: number;
  minimumOrderCents?: number;
  freeFreightThresholdCents?: number | null;
}

export interface UpdateVendorInput {
  name?: string;
  contacts?: VendorContact[];
  address?: VendorAddress;
  accountNumber?: string | null;
  paymentTerms?: string | null;
  leadTimeDays?: number;
  minimumOrderCents?: number;
  freeFreightThresholdCents?: number | null;
  status?: VendorStatus;
}

export async function createVendor(
  db: Db,
  tenantId: string,
  actor: string,
  input: CreateVendorInput,
): Promise<VendorRow> {
  if (!input.name.trim()) throw ApiError.badRequest('vendor name is required');
  const now = nowIso();
  const row: VendorRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    contacts: JSON.stringify(input.contacts ?? []),
    address: JSON.stringify(input.address ?? {}),
    account_number: input.accountNumber ?? null,
    payment_terms: input.paymentTerms ?? null,
    lead_time_days: input.leadTimeDays ?? 0,
    minimum_order_cents: input.minimumOrderCents ?? 0,
    free_freight_threshold_cents: input.freeFreightThresholdCents ?? null,
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('vendors_vendors').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'vendors.vendor.created', 'vendors.vendor', row.id, {
    name: row.name,
  });
  return row;
}

export async function getVendor(
  db: Db,
  tenantId: string,
  vendorId: string,
): Promise<VendorRow | undefined> {
  return db
    .selectFrom('vendors_vendors')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', vendorId)
    .executeTakeFirst();
}

export async function requireVendor(db: Db, tenantId: string, vendorId: string): Promise<VendorRow> {
  const v = await getVendor(db, tenantId, vendorId);
  if (!v) throw ApiError.notFound(`vendor "${vendorId}" not found`);
  return v;
}

export async function listVendors(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
  status?: VendorStatus,
): Promise<VendorRow[]> {
  let q = db.selectFrom('vendors_vendors').selectAll().where('tenant_id', '=', tenantId);
  if (status) q = q.where('status', '=', status);
  return q.orderBy('name').orderBy('id').limit(page.limit).offset(page.offset).execute();
}

export async function updateVendor(
  db: Db,
  tenantId: string,
  actor: string,
  vendorId: string,
  input: UpdateVendorInput,
): Promise<VendorRow> {
  const existing = await requireVendor(db, tenantId, vendorId);
  const patch: Partial<VendorRow> = { updated_at: nowIso() };
  if (input.name !== undefined) {
    if (!input.name.trim()) throw ApiError.badRequest('vendor name cannot be empty');
    patch.name = input.name.trim();
  }
  if (input.contacts !== undefined) patch.contacts = JSON.stringify(input.contacts);
  if (input.address !== undefined) patch.address = JSON.stringify(input.address);
  if (input.accountNumber !== undefined) patch.account_number = input.accountNumber;
  if (input.paymentTerms !== undefined) patch.payment_terms = input.paymentTerms;
  if (input.leadTimeDays !== undefined) patch.lead_time_days = input.leadTimeDays;
  if (input.minimumOrderCents !== undefined) patch.minimum_order_cents = input.minimumOrderCents;
  if (input.freeFreightThresholdCents !== undefined)
    patch.free_freight_threshold_cents = input.freeFreightThresholdCents;
  if (input.status !== undefined) patch.status = input.status;

  await db
    .updateTable('vendors_vendors')
    .set(patch)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', vendorId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'vendors.vendor.updated', 'vendors.vendor', vendorId, {
    before: existing,
    patch,
  });
  return (await getVendor(db, tenantId, vendorId))!;
}

/** Archive (soft) — vendors are never hard-deleted (append-only cost history). */
export async function archiveVendor(
  db: Db,
  tenantId: string,
  actor: string,
  vendorId: string,
): Promise<VendorRow> {
  return updateVendor(db, tenantId, actor, vendorId, { status: 'archived' });
}

/* ------------------------------------------------------------------ *
 * Catalog entries — effective-dated cost history
 * ------------------------------------------------------------------ */

export interface SetCostInput {
  variationId: string;
  vendorSku: string;
  costCents: number;
  casePackQty: number;
  /** ISO-8601 UTC; defaults to now. */
  effectiveFrom?: string;
}

/**
 * Record a new cost for (vendor, variation). Preserves history: the currently
 * open entry (if any) is closed by stamping its `effective_to` to the new
 * `effective_from`, then a new open entry is inserted. All in one transaction.
 */
export async function setCost(
  db: Db,
  tenantId: string,
  actor: string,
  vendorId: string,
  input: SetCostInput,
): Promise<VendorCatalogEntryRow> {
  await requireVendor(db, tenantId, vendorId);
  if (!input.variationId.trim()) throw ApiError.badRequest('variationId is required');
  if (!input.vendorSku.trim()) throw ApiError.badRequest('vendorSku is required');
  if (!Number.isInteger(input.costCents) || input.costCents < 0)
    throw ApiError.badRequest('costCents must be a non-negative integer');
  if (!Number.isInteger(input.casePackQty) || input.casePackQty < 1)
    throw ApiError.badRequest('casePackQty must be a positive integer');
  const effectiveFrom = input.effectiveFrom ?? nowIso();

  const row = await db.transaction().execute(async (trx) => {
    const open = await trx
      .selectFrom('vendors_catalog_entries')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('vendor_id', '=', vendorId)
      .where('variation_id', '=', input.variationId)
      .where('effective_to', 'is', null)
      .executeTakeFirst();
    if (open) {
      if (effectiveFrom < open.effective_from) {
        throw ApiError.badRequest(
          `effectiveFrom ${effectiveFrom} precedes the open cost's effective_from ${open.effective_from}`,
        );
      }
      await trx
        .updateTable('vendors_catalog_entries')
        .set({ effective_to: effectiveFrom })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', open.id)
        .execute();
    }
    const entry: VendorCatalogEntryRow = {
      id: id(),
      tenant_id: tenantId,
      vendor_id: vendorId,
      variation_id: input.variationId,
      vendor_sku: input.vendorSku,
      cost_cents: input.costCents,
      case_pack_qty: input.casePackQty,
      effective_from: effectiveFrom,
      effective_to: null,
      created_at: nowIso(),
    };
    await trx.insertInto('vendors_catalog_entries').values(entry).execute();
    return entry;
  });

  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'vendors.catalog_entry.created',
    'vendors.catalog_entry',
    row.id,
    { variationId: row.variation_id, costCents: row.cost_cents, vendorId },
  );
  return row;
}

/** Full cost history for (vendor, variation), oldest first. */
export async function catalogHistory(
  db: Db,
  tenantId: string,
  vendorId: string,
  variationId: string,
): Promise<VendorCatalogEntryRow[]> {
  return db
    .selectFrom('vendors_catalog_entries')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('vendor_id', '=', vendorId)
    .where('variation_id', '=', variationId)
    .orderBy('effective_from')
    .orderBy('id')
    .execute();
}

export async function listCatalogEntries(
  db: Db,
  tenantId: string,
  vendorId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<VendorCatalogEntryRow[]> {
  return db
    .selectFrom('vendors_catalog_entries')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('vendor_id', '=', vendorId)
    .orderBy('variation_id')
    .orderBy('effective_from')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

/**
 * Deterministic current cost for (variation, vendor) at instant `at`
 * (default now). A record is active when `effective_from <= at` and
 * (`effective_to` is null OR `at < effective_to`). At a boundary instant the
 * NEW record (whose effective_from equals the boundary) wins.
 */
export async function currentCost(
  db: Db,
  tenantId: string,
  variationId: string,
  vendorId: string,
  at: string = nowIso(),
): Promise<VendorCatalogEntryRow | undefined> {
  const candidates = await db
    .selectFrom('vendors_catalog_entries')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('vendor_id', '=', vendorId)
    .where('variation_id', '=', variationId)
    .where('effective_from', '<=', at)
    .orderBy('effective_from', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return candidates.find((c) => c.effective_to === null || at < c.effective_to);
}

/* ------------------------------------------------------------------ *
 * Price-list CSV import — two-phase (preview → commit)
 * ------------------------------------------------------------------ *
 * XLSX is intentionally unsupported (no third-party deps): export the sheet to
 * CSV first, then import the CSV.
 */

export type VariationMatch = 'vendor_sku' | 'row_variation';

export interface ImportMappingConfig {
  /** CSV header names to read each field from. */
  columns: {
    vendorSku: string;
    cost: string;
    casePack: string;
    /** Header carrying the variation id / sku / upc, when variationMatch = 'row_variation'. */
    variation?: string;
  };
  /**
   * 'vendor_sku'   → resolve variation_id from an existing open catalog entry
   *                  for (vendor, vendor_sku) — the vendor-SKU mapping table.
   * 'row_variation'→ the row's `variation` column IS the variation id string
   *                  (sku/upc passed in the rows).
   */
  variationMatch: VariationMatch;
  /** How the `cost` column is expressed. Default 'dollars' (e.g. "12.50"). */
  costFormat?: 'dollars' | 'cents';
}

export interface ImportPreviewRow {
  rowNumber: number;
  vendorSku: string | null;
  variationId: string | null;
  costCents: number | null;
  casePackQty: number | null;
  errors: string[];
}

export interface ImportPreview {
  vendorId: string;
  rowsTotal: number;
  rowsValid: number;
  rowsError: number;
  rows: ImportPreviewRow[];
}

function parseCostToCents(raw: string, format: 'dollars' | 'cents'): number | null {
  const s = raw.trim().replace(/[$,]/g, '');
  if (s === '') return null;
  if (format === 'cents') {
    if (!/^-?\d+$/.test(s)) return null;
    return Number(s);
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

function parseIntStrict(raw: string): number | null {
  const s = raw.trim();
  if (!/^-?\d+$/.test(s)) return null;
  return Number(s);
}

/**
 * Phase 1: parse + validate the CSV into per-row results without persisting
 * anything. Resolves each variation per the mapping config; every row carries
 * its own `errors` array so the owner sees exactly what failed.
 */
export async function previewPriceListImport(
  db: Db,
  tenantId: string,
  vendorId: string,
  csvText: string,
  config: ImportMappingConfig,
): Promise<ImportPreview> {
  await requireVendor(db, tenantId, vendorId);
  const costFormat = config.costFormat ?? 'dollars';
  const records = parseCsv(csvText);

  // vendor_sku → variation_id map from existing open catalog entries.
  const skuMap = new Map<string, string>();
  if (config.variationMatch === 'vendor_sku') {
    const entries = await db
      .selectFrom('vendors_catalog_entries')
      .select(['vendor_sku', 'variation_id'])
      .where('tenant_id', '=', tenantId)
      .where('vendor_id', '=', vendorId)
      .where('effective_to', 'is', null)
      .execute();
    for (const e of entries) skuMap.set(e.vendor_sku, e.variation_id);
  }

  const rows: ImportPreviewRow[] = records.map((rec, idx) => {
    const errors: string[] = [];
    const vendorSku = (rec[config.columns.vendorSku] ?? '').trim();
    if (vendorSku === '') errors.push(`missing "${config.columns.vendorSku}" (vendor sku)`);

    const costCents = parseCostToCents(rec[config.columns.cost] ?? '', costFormat);
    if (costCents === null) errors.push(`invalid cost "${rec[config.columns.cost] ?? ''}"`);
    else if (costCents < 0) errors.push('cost must be >= 0');

    const casePackQty = parseIntStrict(rec[config.columns.casePack] ?? '');
    if (casePackQty === null) errors.push(`invalid case pack "${rec[config.columns.casePack] ?? ''}"`);
    else if (casePackQty < 1) errors.push('case pack must be >= 1');

    let variationId: string | null = null;
    if (config.variationMatch === 'row_variation') {
      const key = config.columns.variation;
      const v = key ? (rec[key] ?? '').trim() : '';
      if (v === '') errors.push('missing variation id in row');
      else variationId = v;
    } else {
      const mapped = vendorSku !== '' ? skuMap.get(vendorSku) : undefined;
      if (!mapped) errors.push(`no variation mapping for vendor sku "${vendorSku}"`);
      else variationId = mapped;
    }

    return {
      rowNumber: idx + 1,
      vendorSku: vendorSku === '' ? null : vendorSku,
      variationId,
      costCents,
      casePackQty,
      errors,
    };
  });

  const rowsError = rows.filter((r) => r.errors.length > 0).length;
  return {
    vendorId,
    rowsTotal: rows.length,
    rowsValid: rows.length - rowsError,
    rowsError,
    rows,
  };
}

export interface ImportCommitResult {
  importJobId: string;
  rowsTotal: number;
  rowsValid: number;
  rowsError: number;
  rowsCommitted: number;
}

/**
 * Phase 2: re-run the preview and persist ONLY the valid rows (each via the
 * effective-dated `setCost` path, closing prior open costs). Records an
 * import-job row with counts + the row-level errors JSON.
 */
export async function commitPriceListImport(
  db: Db,
  tenantId: string,
  actor: string,
  vendorId: string,
  csvText: string,
  config: ImportMappingConfig,
  effectiveFrom: string = nowIso(),
): Promise<ImportCommitResult> {
  const preview = await previewPriceListImport(db, tenantId, vendorId, csvText, config);

  let committed = 0;
  for (const r of preview.rows) {
    if (r.errors.length > 0) continue;
    await setCost(db, tenantId, actor, vendorId, {
      variationId: r.variationId!,
      vendorSku: r.vendorSku!,
      costCents: r.costCents!,
      casePackQty: r.casePackQty!,
      effectiveFrom,
    });
    committed += 1;
  }

  const job: VendorImportJobRow = {
    id: id(),
    tenant_id: tenantId,
    vendor_id: vendorId,
    status: 'committed',
    rows_total: preview.rowsTotal,
    rows_valid: preview.rowsValid,
    rows_error: preview.rowsError,
    rows_committed: committed,
    errors: JSON.stringify(
      preview.rows
        .filter((r) => r.errors.length > 0)
        .map((r) => ({ rowNumber: r.rowNumber, errors: r.errors })),
    ),
    created_at: nowIso(),
  };
  await db.insertInto('vendors_import_jobs').values(job).execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'vendors.import_job.committed',
    'vendors.import_job',
    job.id,
    { vendorId, committed, rowsError: preview.rowsError },
  );

  return {
    importJobId: job.id,
    rowsTotal: preview.rowsTotal,
    rowsValid: preview.rowsValid,
    rowsError: preview.rowsError,
    rowsCommitted: committed,
  };
}

export async function listImportJobs(
  db: Db,
  tenantId: string,
  vendorId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<VendorImportJobRow[]> {
  return db
    .selectFrom('vendors_import_jobs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('vendor_id', '=', vendorId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}
