/** #/money — finance: period summary tiles, payouts, cash sessions, exports. */
import { registerView } from '../router.js';
import { el, toast } from '../dom.js';
import { getData, getList, mutate } from '../api.js';
import { viewHeader, emptyState, dataTable, button, section, field, input, metricTile, withLoading, chip } from '../ui.js';
import { formatCents } from '../../../src/money.mjs';
import { formatDateTime } from '../../../src/format.mjs';

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

registerView('money', async (container) => {
  container.append(viewHeader({ title: 'Money', subtitle: 'Sales, refunds, fees, payouts, and cash — every number defined and drillable.' }));

  const posSlot = el('div');
  container.append(posSlot);
  await loadPosLedger(posSlot);

  const period = input({ name: 'period', value: currentPeriod(), placeholder: 'YYYY-MM' });
  const tilesSlot = el('div', { style: 'margin:12px 0' });
  container.append(section('Period', field('Month (YYYY-MM)', period), button('Load', { primary: true, onClick: loadPeriod })), tilesSlot);
  period.addEventListener('change', loadPeriod);

  async function loadPeriod() {
    await withLoading(tilesSlot, async () => {
      let sum;
      try {
        sum = await getData('/api/finance/period-summary', { period: period.value.trim() });
      } catch (e) {
        return emptyState({ icon: '💵', title: 'No finance data for this period', message: e.message || 'Import payments/payouts under Imports, then reload.' });
      }
      const grid = el('div', { class: 'grid tiles' });
      const tile = (label, cents, def) => grid.append(metricTile({ label, value: cents == null ? 'unknown' : formatCents(cents), definition: def, foot: `Period ${period.value}` }));
      tile('Gross sales', sum.grossCents ?? sum.gross_cents, 'Total completed payments before refunds and fees.');
      tile('Refunds', sum.refundsCents ?? sum.refunds_cents, 'Money returned to customers this period.');
      tile('Fees', sum.feesCents ?? sum.fees_cents, 'Processor fees on payments.');
      tile('Net', sum.netCents ?? sum.net_cents, 'Gross minus refunds minus fees.');
      return grid;
    });
  }
  loadPeriod();

  // Payout matches + mismatches
  const payoutSlot = el('div');
  container.append(payoutSlot);
  await withLoading(payoutSlot, async () => {
    const list = await getList('/api/finance/payout-matches').catch(() => ({ data: [] }));
    const rows = list.data || [];
    if (!rows.length) return section('Payouts', el('p', { class: 'view-sub' }, 'No payouts reconciled yet.'));
    return section('Payout reconciliation', dataTable(
      [
        { key: 'sourcePayoutId', label: 'Payout' },
        { key: 'status', label: 'Status', render: (r) => chip(r.status || '—', r.matched ? 'ok' : 'high') },
        { key: 'deltaCents', label: 'Delta', num: true, render: (r) => (r.deltaCents != null ? formatCents(r.deltaCents) : '—') },
      ],
      rows,
    ));
  });

  // Exports
  container.append(section(
    'Accountant exports',
    el('div', { class: 'view-actions' }, ['payments', 'refunds', 'payouts', 'cash-sessions', 'tax-evidence', 'item-costs'].map((k) =>
      el('a', { class: 'btn', href: `/api/finance/exports/${k}.csv`, download: `${k}.csv` }, `${k}.csv`),
    )),
  ));

  // Cash sessions
  const cashSlot = el('div');
  container.append(cashSlot);
  await withLoading(cashSlot, async () => {
    const list = await getList('/api/finance/cash-sessions').catch(() => ({ data: [] }));
    const rows = list.data || [];
    return section('Cash sessions', rows.length
      ? dataTable([
          { key: 'drawer_ref', label: 'Drawer', render: (row) => row.drawer_ref || row.drawerRef || row.location_ref || row.locationRef || shortRef(row.id) },
          { key: 'opened_at', label: 'Opened', render: (row) => formatDateTime(row.opened_at || row.openedAt) },
          { key: 'status', label: 'Status', render: (row) => chip(humanize(row.status), row.status === 'closed' ? 'ok' : 'low') },
          { key: 'expected_cents', label: 'Expected', num: true, render: (row) => moneyOrDash(row.expected_cents ?? row.expectedCents) },
          { key: 'counted_cents', label: 'Counted', num: true, render: (row) => moneyOrDash(row.counted_cents ?? row.countedCents) },
          { key: 'variance_cents', label: 'Variance', num: true, render: (row) => moneyOrDash(row.variance_cents ?? row.varianceCents) },
        ], rows)
      : el('p', { class: 'view-sub' }, 'No cash sessions. Open one at the start of a show or register day.'));
  });
});

async function loadPosLedger(slot) {
  await withLoading(slot, async () => {
    let summary;
    let entries;
    try {
      [summary, entries] = await Promise.all([
        getData('/api/pos/finance/summary'),
        getList('/api/pos/finance/entries', { limit: 50 }),
      ]);
    } catch (error) {
      return section(
        'Register ledger',
        emptyState({
          icon: '🧾',
          title: 'Register ledger unavailable',
          message: error.message || 'Sign in as a manager or owner to view POS finance.',
        }),
      );
    }

    const grid = el('div', { class: 'grid tiles' }, [
      metricTile({
        label: 'Register sales',
        value: formatCents(summary.grossTenderedSalesCents ?? 0),
        definition: 'Captured POS tenders before completed refunds and processor fees.',
        foot: `${summary.paymentCount ?? 0} captured tender${summary.paymentCount === 1 ? '' : 's'}`,
      }),
      metricTile({
        label: 'Completed refunds',
        value: formatCents(summary.completedRefundsCents ?? 0),
        definition: 'Only POS refunds with a completed authoritative status.',
        foot: `${summary.refundCount ?? 0} completed refund${summary.refundCount === 1 ? '' : 's'}`,
      }),
      metricTile({
        label: 'Net before fees',
        value: formatCents(summary.netSalesBeforeFeesCents ?? 0),
        definition: 'Captured register tenders minus completed register refunds; processor fees are excluded.',
        foot: 'Native POS ledger',
      }),
      metricTile({
        label: 'Processor fees',
        value: summary.processorFeesCents == null ? 'unknown' : formatCents(summary.processorFeesCents),
        definition: 'Processor fees remain unknown until settlement data is connected.',
        foot: `${summary.unknownFeeEntryCount ?? 0} entr${summary.unknownFeeEntryCount === 1 ? 'y' : 'ies'} without fee data`,
      }),
      metricTile({
        label: 'Settlement net',
        value: summary.settlementNetCents == null ? 'unknown' : formatCents(summary.settlementNetCents),
        definition: 'Provider payout net after fees; never inferred from gross tender activity.',
        foot: summary.settlementNetCents == null ? 'Connect settlement evidence' : 'Provider-backed',
      }),
    ]);

    const pending = Number(summary.pendingReconciliationCount ?? 0);
    const rows = Array.isArray(entries?.data) ? entries.data : [];
    return section(
      'Register ledger',
      el('p', { class: 'view-sub' }, 'Native POS sales and completed refunds. Historical imports and provider payouts remain in the period and payout sections below.'),
      grid,
      el('p', { class: 'view-sub', style: 'margin-top:12px' }, [
        chip(pending === 0 ? 'Reconciled' : `${pending} pending repair${pending === 1 ? '' : 's'}`, pending === 0 ? 'ok' : 'high'),
        el('span', { style: 'margin-left:8px' }, 'Stock, cash drawer, and finance projections are derived from durable order facts.'),
      ]),
      dataTable([
        { key: 'occurred_at', label: 'When', render: (row) => formatDateTime(row.occurred_at) },
        { key: 'entry_type', label: 'Entry', render: (row) => chip(humanize(row.entry_type), row.entry_type === 'refund' ? 'high' : 'ok') },
        { key: 'tender_kind', label: 'Tender', render: (row) => humanize(row.tender_kind) },
        {
          key: 'amount_cents',
          label: 'Amount',
          num: true,
          render: (row) => formatCents((row.entry_type === 'refund' ? -1 : 1) * Number(row.amount_cents ?? 0)),
        },
        { key: 'fee_cents', label: 'Fee', num: true, render: (row) => row.fee_cents == null ? 'unknown' : formatCents(row.fee_cents) },
        {
          key: 'order_id',
          label: 'Order',
          render: (row) => el('a', { href: `#/orders/${row.order_id}` }, row.receipt_number || shortRef(row.order_id)),
        },
        { key: 'cashier_id', label: 'Cashier', render: (row) => row.cashier_name || shortRef(row.cashier_id) },
      ], rows, { emptyMessage: 'No completed register tenders or refunds yet.' }),
    );
  });
}

function humanize(value) {
  return String(value || '—').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortRef(value) {
  const text = String(value || '—');
  return text.length > 12 ? `${text.slice(0, 8)}…` : text;
}

function moneyOrDash(value) {
  return value === null || value === undefined ? '—' : formatCents(Number(value));
}
