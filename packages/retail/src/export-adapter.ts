import { ApiError } from '@blacklabel/core';
import { isImportKind, type ImportBatch, type ImportKind } from './contract';

/**
 * Adapter 1 — EXPORT DROP.
 *
 * Turns a founder-dropped Square JSON export file into the normalized
 * ImportBatch. This is the ONLY fresh-data lane the product ships enabled:
 * files land out-of-band (see ~/MagsTack/tools/import_incoming.py for the
 * Python precedent) — no network is ever touched here.
 *
 * Accepted payload shapes per Square's exports (mirrors import_incoming.py):
 *   - a bare JSON array of objects, or
 *   - a dict wrapping that array under its standard Square key.
 */

/** The dict wrapper keys Square uses per kind (first match wins). */
const LIST_KEYS: Record<ImportKind, string[]> = {
  payments: ['payments'],
  orders: ['orders'],
  customers: ['customers'],
  catalog: ['objects', 'catalog'],
  gift_cards: ['gift_cards'],
  payouts: ['payouts'],
  disputes: ['disputes'],
  invoices: ['invoices'],
  inventory_counts: ['counts', 'inventory_counts', 'inventory'],
  refunds: ['refunds'],
};

/** Pull the record array out of a parsed export payload; throw on junk. */
export function extractRecords(payload: unknown, kind: ImportKind): unknown[] {
  let records: unknown;
  if (Array.isArray(payload)) {
    records = payload;
  } else if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const key = LIST_KEYS[kind].find((k) => k in obj);
    if (!key) {
      throw ApiError.badRequest(
        `export payload has none of the expected keys ${JSON.stringify(LIST_KEYS[kind])}`,
      );
    }
    records = obj[key];
  } else {
    throw ApiError.badRequest('export payload is neither a JSON array nor an object');
  }
  if (!Array.isArray(records)) {
    throw ApiError.badRequest('export payload records is not an array');
  }
  return records;
}

/**
 * Parse a raw export file's JSON text into an ImportBatch. Structural
 * failures (bad JSON, wrong shape) throw here; per-record validation happens
 * downstream in the pipeline (so malformed rows quarantine, not abort).
 */
export function parseExportFile(
  kind: string,
  jsonText: string,
  opts: { fileName?: string; fetchedAt?: string } = {},
): ImportBatch {
  if (!isImportKind(kind)) {
    throw ApiError.badRequest(`unknown import kind "${kind}"`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw ApiError.badRequest('export file is not valid JSON');
  }
  const records = extractRecords(payload, kind);
  return {
    source: 'square_export',
    kind,
    records,
    sourceMeta: {
      fileName: opts.fileName,
      fetchedAt: opts.fetchedAt ?? new Date().toISOString(),
    },
  };
}
