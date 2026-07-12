/** #/money — finance: period summary tiles, payouts, cash sessions, exports. */
import { registerView } from '../router.js';
import { el, toast } from '../dom.js';
import { getData, getList, mutate } from '../api.js';
import { viewHeader, emptyState, dataTable, button, section, field, input, metricTile, withLoading, chip } from '../ui.js';
import { formatCents } from '../../../src/money.mjs';

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

registerView('money', async (container) => {
  container.append(viewHeader({ title: 'Money', subtitle: 'Sales, refunds, fees, payouts, and cash — every number defined and drillable.' }));

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
      ? dataTable([{ key: 'id', label: 'Session' }, { key: 'status', label: 'Status' }, { key: 'varianceCents', label: 'Variance', num: true, render: (r) => (r.varianceCents != null ? formatCents(r.varianceCents) : '—') }], rows)
      : el('p', { class: 'view-sub' }, 'No cash sessions. Open one at the start of a show or register day.'));
  });
});
