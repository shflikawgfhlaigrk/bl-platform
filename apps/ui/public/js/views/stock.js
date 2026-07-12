/** #/stock — on-hand, locations, movement history, reorder points, reservations. */
import { registerView } from '../router.js';
import { el, clear, toast } from '../dom.js';
import { getData, getList, mutate } from '../api.js';
import { viewHeader, emptyState, dataTable, button, section, field, input, select, withLoading, chip } from '../ui.js';
import { formatDateTime } from '../../../src/format.mjs';

const LOCATION_KINDS = ['warehouse', 'trailer', 'show', 'fulfillment_staging', 'reserved', 'damaged', 'quarantine', 'custom'];

registerView('stock', async (container) => {
  container.append(viewHeader({ title: 'Stock', subtitle: 'What you have, where it is, and what moved.' }));

  let locations = [];
  try {
    locations = (await getData('/api/inventory/locations')) || [];
  } catch {
    locations = [];
  }

  const body = el('div');
  container.append(body);

  if (!locations.length) {
    clear(body);
    body.append(newLocationCard(() => reload()));
    body.append(
      emptyState({
        icon: '📦',
        title: 'No locations yet',
        message: 'Add the places you keep stock — a warehouse, the trailer, each show. Then count items into them.',
      }),
    );
    return;
  }

  const locFilter = select('locationFilter', locations.map((l) => ({ value: l.id, label: `${l.name} (${l.kind})` })), locations[0].id);
  const search = input({ name: 'q', placeholder: 'Search item / SKU' });
  const tableSlot = el('div');

  container.append(
    section(
      'On hand',
      el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin-bottom:12px' }, [
        field('Location', locFilter),
        field('Search', search),
        button('Conservation check', { onClick: runConservation }),
      ]),
      tableSlot,
    ),
    newLocationCard(() => reload()),
  );

  locFilter.addEventListener('change', loadStock);
  search.addEventListener('input', () => loadStock());

  async function loadStock() {
    await withLoading(tableSlot, async () => {
      const rows = normalize(await getData('/api/inventory/stock', { locationId: locFilter.value }));
      const q = search.value.trim().toLowerCase();
      const filtered = q
        ? rows.filter((r) => `${r.name || ''} ${r.sku || ''} ${r.variationId || ''}`.toLowerCase().includes(q))
        : rows;
      if (!filtered.length) {
        return emptyState({ icon: '🗒️', title: 'Nothing counted here yet', message: 'Scan items into this location on the Scan screen — the app never guesses a count.' });
      }
      return dataTable(
        [
          { key: 'name', label: 'Item', render: (r) => r.name || r.variationId },
          { key: 'sku', label: 'SKU' },
          { key: 'onHand', label: 'On hand', num: true, render: (r) => onHand(r) },
          { key: 'flags', label: '', render: (r) => flags(r) },
          { key: 'hist', label: '', render: (r) => button('History', { onClick: () => showHistory(r) }) },
        ],
        filtered,
      );
    });
  }

  async function showHistory(r) {
    const list = await getList('/api/inventory/movements', { variationId: r.variationId, limit: 50 });
    const rows = list.data || [];
    const modal = section(
      `Movement history — ${r.name || r.variationId}`,
      dataTable(
        [
          { key: 'created_at', label: 'When', render: (m) => formatDateTime(m.created_at || m.createdAt) },
          { key: 'reason', label: 'Reason' },
          { key: 'delta', label: 'Change', num: true, render: (m) => (m.delta > 0 ? `+${m.delta}` : String(m.delta)) },
          { key: 'note', label: 'Note' },
        ],
        rows,
        { emptyMessage: 'No movements recorded.' },
      ),
      button('Close', { onClick: () => modal.remove() }),
    );
    tableSlot.before(modal);
  }

  async function runConservation() {
    try {
      const report = await getData('/api/inventory/conservation');
      const ok = report && (report.ok === true || report.conserved === true || (Array.isArray(report.violations) && report.violations.length === 0));
      toast(ok ? 'Conservation check passed — every unit is accounted for.' : 'Conservation check found discrepancies. See details.', ok ? 'info' : 'warn');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function reload() {
    location.hash = '#/stock';
  }

  loadStock();
});

function newLocationCard(onDone) {
  const name = input({ name: 'name', placeholder: 'e.g. Warehouse' });
  const kind = select('kind', LOCATION_KINDS.map((k) => ({ value: k, label: k })), 'warehouse');
  return section(
    'Add a location',
    field('Name', name),
    field('Kind', kind),
    button('Add location', {
      primary: true,
      onClick: async () => {
        if (!name.value.trim()) return toast('Name is required', 'warn');
        try {
          await mutate('/api/inventory/locations', 'POST', { name: name.value.trim(), kind: kind.value });
          toast('Location added.');
          onDone();
        } catch (e) {
          toast(e.message, 'err');
        }
      },
    }),
  );
}

function normalize(rows) {
  if (Array.isArray(rows)) return rows;
  if (rows && Array.isArray(rows.rows)) return rows.rows;
  return [];
}
function onHand(r) {
  const v = r.onHand ?? r.quantity ?? r.qty ?? r.on_hand;
  return v === null || v === undefined ? 'not counted' : String(v);
}
function flags(r) {
  const wrap = el('span');
  if (r.oversold || (typeof r.onHand === 'number' && r.onHand < 0)) wrap.append(chip('Oversold', 'critical'));
  if (r.belowReorder || r.low) wrap.append(chip('Low', 'high'));
  return wrap;
}
