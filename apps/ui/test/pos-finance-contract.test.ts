import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const money = readFileSync(path.resolve(here, '../public/js/views/money.js'), 'utf8');

describe('POS finance owner UI static contract', () => {
  it('loads the native register summary and drill-down entries', () => {
    expect(money).toContain("getData('/api/pos/finance/summary')");
    expect(money).toContain("getList('/api/pos/finance/entries'");
    expect(money).toContain("'Register ledger'");
    expect(money).toContain('grossTenderedSalesCents');
    expect(money).toContain('completedRefundsCents');
    expect(money).toContain('netSalesBeforeFeesCents');
  });

  it('keeps unknown provider economics explicit and surfaces repair status', () => {
    expect(money).toContain("summary.processorFeesCents == null ? 'unknown'");
    expect(money).toContain("summary.settlementNetCents == null ? 'unknown'");
    expect(money).toContain('pendingReconciliationCount');
    expect(money).toContain("pending === 0 ? 'Reconciled'");
  });

  it('renders source-linked entries without turning refund amounts positive', () => {
    expect(money).toContain("row.entry_type === 'refund' ? -1 : 1");
    for (const field of ['occurred_at', 'tender_kind', 'amount_cents', 'fee_cents', 'order_id', 'receipt_number', 'cashier_id', 'cashier_name']) {
      expect(money).toContain(field);
    }
  });

  it('renders persisted snake-case drawer totals including a true zero variance', () => {
    expect(money).toContain('row.expected_cents ?? row.expectedCents');
    expect(money).toContain('row.counted_cents ?? row.countedCents');
    expect(money).toContain('row.variance_cents ?? row.varianceCents');
    expect(money).toContain("value === null || value === undefined ? '—' : formatCents(Number(value))");
  });
});
