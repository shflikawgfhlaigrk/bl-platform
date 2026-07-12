/** #/orders — unified orders: list, detail, pay, fulfill, refund, print. */
import { registerView, navigate } from '../router.js';
import { el, toast } from '../dom.js';
import { getData, getList, mutate, newIdempotencyKey } from '../api.js';
import { viewHeader, emptyState, dataTable, button, section, field, input, select, withLoading, chip, detailList } from '../ui.js';
import { formatCents } from '../../../src/money.mjs';
import { formatDate } from '../../../src/format.mjs';

registerView('orders', async (container, params) => {
  if (params[0]) return renderOrder(container, params[0]);
  container.append(viewHeader({ title: 'Orders', subtitle: 'Every sale in one place — in person, online, and manual.', actions: [button('New manual order', { primary: true, onClick: () => createOrder() })] }));

  const filterStatus = select('status', [{ value: '', label: 'All statuses' }, { value: 'open', label: 'Open' }, { value: 'paid', label: 'Paid' }, { value: 'fulfilled', label: 'Fulfilled' }, { value: 'canceled', label: 'Canceled' }], '');
  const slot = el('div');
  container.append(section('Filter', field('Status', filterStatus)), slot);
  filterStatus.addEventListener('change', load);

  async function load() {
    await withLoading(slot, async () => {
      const list = await getList('/api/orders/orders', { limit: 100, status: filterStatus.value || undefined });
      const rows = list.data || [];
      if (!rows.length) return emptyState({ icon: '🧾', title: 'No orders yet', message: 'In-person sales import from Square; you can also create a manual, phone, or invoice order here.' });
      return dataTable(
        [
          { key: 'id', label: 'Order', render: (r) => (r.id || '').slice(0, 8) },
          { key: 'channel', label: 'Channel' },
          { key: 'status', label: 'Status', render: (r) => chip(r.status || 'open', 'medium') },
          { key: 'totalCents', label: 'Total', num: true, render: (r) => formatCents(r.totalCents ?? r.total_cents ?? 0) },
          { key: 'created_at', label: 'Date', render: (r) => formatDate(r.created_at || r.createdAt) },
          { key: 'open', label: '', render: (r) => button('Open', { onClick: () => navigate(`#/orders/${r.id}`) }) },
        ],
        rows,
      );
    });
  }
  load();

  async function createOrder() {
    try {
      const res = await mutate('/api/orders/orders', 'POST', { channel: 'manual', lines: [] });
      const o = res.data || res;
      navigate(`#/orders/${o.id}`);
    } catch (e) {
      toast(e.message, 'err');
    }
  }
});

async function renderOrder(container, id) {
  container.append(viewHeader({ title: 'Order', actions: [button('Back', { href: '#/orders' }), button('Pick list', { onClick: () => window.print() }), button('Packing slip', { onClick: () => window.print() })] }));
  const slot = el('div');
  container.append(slot);

  async function refresh() {
    await withLoading(slot, async () => {
      const o = await getData(`/api/orders/orders/${id}`);
      const lines = o.lines || [];
      const wrap = el('div');
      wrap.append(
        section(
          `Order ${chipText(o.status)}`,
          detailList({
            Channel: o.channel,
            Status: chip(o.status || 'open', 'medium'),
            Subtotal: formatCents(o.subtotalCents ?? o.subtotal_cents ?? 0),
            Tax: formatCents(o.taxCents ?? o.tax_cents ?? 0),
            Total: formatCents(o.totalCents ?? o.total_cents ?? 0),
          }),
          el('div', { class: 'view-actions', style: 'margin-top:10px' }, [
            o.status !== 'paid' && o.status !== 'fulfilled' ? button('Reserve stock', { onClick: () => act('reserve') }) : null,
            o.status !== 'paid' && o.status !== 'fulfilled' ? button('Take payment (cash)', { primary: true, onClick: () => payCash(o) }) : null,
            button('Refund…', { onClick: () => startRefund(o) }),
          ]),
        ),
      );
      wrap.append(
        section(
          'Lines',
          dataTable(
            [
              { key: 'description', label: 'Item' },
              { key: 'qty', label: 'Qty', num: true },
              { key: 'unitPriceCents', label: 'Unit', num: true, render: (l) => formatCents(l.unitPriceCents ?? l.unit_price_cents ?? 0) },
              { key: 'lineTotalCents', label: 'Total', num: true, render: (l) => formatCents(l.lineTotalCents ?? l.line_total_cents ?? (l.qty * (l.unitPriceCents ?? 0))) },
            ],
            lines,
            { emptyMessage: 'No lines on this order.' },
          ),
        ),
      );
      return wrap;

      async function act(a) {
        try {
          await mutate(`/api/orders/orders/${id}/${a}`, 'POST', {});
          toast('Done.');
          refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      }
      async function payCash(order) {
        const amount = order.totalCents ?? order.total_cents ?? 0;
        try {
          await mutate(`/api/orders/orders/${id}/pay`, 'POST', { tenders: [{ kind: 'cash', amountCents: amount, idempotencyKey: newIdempotencyKey() }] });
          toast('Payment recorded.');
          refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      }
      async function startRefund() {
        toast('Open a specific tender to refund from the order detail (per-line disposition supported).', 'warn');
      }
    });
  }
  refresh();
}

function chipText(s) {
  return s ? s : 'open';
}
