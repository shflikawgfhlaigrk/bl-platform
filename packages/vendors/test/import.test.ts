import { describe, expect, it } from 'vitest';
import { setup, headers } from './helpers';
import {
  createVendor,
  setCost,
  previewPriceListImport,
  commitPriceListImport,
  currentCost,
  listImportJobs,
} from '../src/service';

const CSV = [
  'sku,price,pack,variation',
  'SKU1,12.50,6,var_1', // valid
  'SKU2,9.99,12,var_2', // valid
  'SKU3,notanumber,3,var_3', // bad cost
  'SKU4,5.00,zero,var_4', // bad case pack
  ',3.00,1,var_5', // missing sku
  'SKU6,4.00,2,', // missing variation (row_variation mode)
].join('\n');

const rowVariationConfig = {
  columns: { vendorSku: 'sku', cost: 'price', casePack: 'pack', variation: 'variation' },
  variationMatch: 'row_variation' as const,
  costFormat: 'dollars' as const,
};

describe('vendors price-list CSV import (two-phase)', () => {
  it('preview flags row-level errors and does not persist', async () => {
    const { db, tenantA } = await setup();
    const vendor = await createVendor(db, tenantA.id, 'system', { name: 'V' });

    const preview = await previewPriceListImport(db, tenantA.id, vendor.id, CSV, rowVariationConfig);
    expect(preview.rowsTotal).toBe(6);
    expect(preview.rowsValid).toBe(2);
    expect(preview.rowsError).toBe(4);

    // Row 1 valid, cost parsed dollars→cents.
    expect(preview.rows[0].errors).toEqual([]);
    expect(preview.rows[0].costCents).toBe(1250);
    expect(preview.rows[0].casePackQty).toBe(6);
    expect(preview.rows[0].variationId).toBe('var_1');
    // Row 3 bad cost.
    expect(preview.rows[2].errors.some((e) => e.includes('invalid cost'))).toBe(true);
    // Row 4 bad case pack.
    expect(preview.rows[3].errors.some((e) => e.includes('invalid case pack'))).toBe(true);
    // Row 5 missing sku.
    expect(preview.rows[4].errors.some((e) => e.includes('vendor sku'))).toBe(true);
    // Row 6 missing variation.
    expect(preview.rows[5].errors.some((e) => e.includes('variation'))).toBe(true);

    // Nothing persisted.
    expect(await currentCost(db, tenantA.id, 'var_1', vendor.id)).toBeUndefined();
  });

  it('commit persists only valid rows and records an import job with errors JSON', async () => {
    const { db, tenantA } = await setup();
    const vendor = await createVendor(db, tenantA.id, 'system', { name: 'V' });

    const result = await commitPriceListImport(
      db,
      tenantA.id,
      'importer',
      vendor.id,
      CSV,
      rowVariationConfig,
      '2026-06-01T00:00:00.000Z',
    );
    expect(result.rowsTotal).toBe(6);
    expect(result.rowsValid).toBe(2);
    expect(result.rowsError).toBe(4);
    expect(result.rowsCommitted).toBe(2);

    expect((await currentCost(db, tenantA.id, 'var_1', vendor.id))!.cost_cents).toBe(1250);
    expect((await currentCost(db, tenantA.id, 'var_2', vendor.id))!.cost_cents).toBe(999);

    const jobs = await listImportJobs(db, tenantA.id, vendor.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].rows_committed).toBe(2);
    const errs = JSON.parse(jobs[0].errors);
    expect(errs).toHaveLength(4);
    expect(errs[0]).toHaveProperty('rowNumber');
    expect(errs[0]).toHaveProperty('errors');
  });

  it('vendor_sku match mode resolves via existing open catalog entries', async () => {
    const { db, tenantA } = await setup();
    const vendor = await createVendor(db, tenantA.id, 'system', { name: 'V' });
    // Seed a mapping: vendor_sku SKU1 → var_1.
    await setCost(db, tenantA.id, 'system', vendor.id, {
      variationId: 'var_1',
      vendorSku: 'SKU1',
      costCents: 100,
      casePackQty: 1,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });

    const csv = ['sku,price,pack', 'SKU1,20.00,6', 'SKU_UNKNOWN,5.00,1'].join('\n');
    const preview = await previewPriceListImport(db, tenantA.id, vendor.id, csv, {
      columns: { vendorSku: 'sku', cost: 'price', casePack: 'pack' },
      variationMatch: 'vendor_sku',
    });
    expect(preview.rows[0].variationId).toBe('var_1');
    expect(preview.rows[0].errors).toEqual([]);
    expect(preview.rows[1].errors.some((e) => e.includes('no variation mapping'))).toBe(true);

    // Commit updates the cost (closing the seed) → currentCost is 2000.
    await commitPriceListImport(db, tenantA.id, 'system', vendor.id, csv, {
      columns: { vendorSku: 'sku', cost: 'price', casePack: 'pack' },
      variationMatch: 'vendor_sku',
    }, '2026-07-01T00:00:00.000Z');
    expect((await currentCost(db, tenantA.id, 'var_1', vendor.id))!.cost_cents).toBe(2000);
  });

  it('import endpoints work through the router', async () => {
    const { app, db, tenantA } = await setup();
    const vendor = await createVendor(db, tenantA.id, 'system', { name: 'V' });
    const preview = await app.request(`/vendors/${vendor.id}/import/preview`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ csv: CSV, config: rowVariationConfig }),
    });
    expect(preview.status).toBe(200);
    expect(((await preview.json() as any)).data.rowsValid).toBe(2);

    const commit = await app.request(`/vendors/${vendor.id}/import/commit`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ csv: CSV, config: rowVariationConfig }),
    });
    expect(commit.status).toBe(201);
    expect(((await commit.json() as any)).data.rowsCommitted).toBe(2);
  });
});
