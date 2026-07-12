/** #/buying — vendors + purchasing: reorder suggestions, draft POs, receiving. */
import { registerView, navigate } from '../router.js';
import { el, toast } from '../dom.js';
import { getData, getList, mutate } from '../api.js';
import { viewHeader, emptyState, dataTable, button, section, field, input, withLoading, chip, expandable, detailList } from '../ui.js';
import { formatCents } from '../../../src/money.mjs';

registerView('buying', async (container, params) => {
  if (params[0] === 'po' && params[1]) return renderPo(container, params[1]);

  container.append(viewHeader({ title: 'Buying', subtitle: 'Vendors, reorder suggestions, and purchase orders — every quantity shows its formula.' }));

  const tabs = el('div', { class: 'view-actions', style: 'margin-bottom:12px' });
  const slot = el('div');
  container.append(tabs, slot);

  const show = { vendors: () => loadVendors(slot), suggestions: () => loadSuggestions(slot), pos: () => loadPos(slot) };
  tabs.append(
    button('Vendors', { onClick: show.vendors }),
    button('Reorder suggestions', { onClick: show.suggestions }),
    button('Purchase orders', { onClick: show.pos }),
  );
  show.vendors();
});

async function loadVendors(slot) {
  await withLoading(slot, async () => {
    const list = await getList('/api/vendors/vendors', { limit: 100 }).catch(() => ({ data: [] }));
    const rows = list.data || [];
    const name = input({ name: 'name', placeholder: 'New vendor name' });
    const create = section(
      'Add a vendor',
      field('Name', name),
      button('Add vendor', {
        primary: true,
        onClick: async () => {
          if (!name.value.trim()) return;
          try {
            await mutate('/api/vendors/vendors', 'POST', { name: name.value.trim() });
            toast('Vendor added.');
            loadVendors(slot);
          } catch (e) {
            toast(e.message, 'err');
          }
        },
      }),
    );
    const wrap = el('div');
    wrap.append(create);
    wrap.append(
      section(
        'Vendors',
        rows.length
          ? dataTable([{ key: 'name', label: 'Vendor' }, { key: 'leadTimeDays', label: 'Lead time (days)', num: true }], rows)
          : el('p', { class: 'view-sub' }, 'No vendors yet.'),
      ),
    );
    return wrap;
  });
}

async function loadSuggestions(slot) {
  await withLoading(slot, async () => {
    const list = await getList('/api/purchasing/suggestions', { limit: 100 }).catch(() => ({ data: [] }));
    const rows = list.data || [];
    if (!rows.length) return emptyState({ icon: '🛒', title: 'No reorder suggestions', message: 'Set reorder policies (in Stock) and run suggestions. Each suggestion prints the exact formula and inputs used.' });
    return section(
      'Reorder suggestions',
      el('div', {}, rows.map((s) => el('div', { class: 'card', style: 'margin-bottom:10px' }, [
        el('div', { style: 'display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px' }, [
          el('strong', {}, s.variationId || s.variation_id),
          chip(`Suggest ${s.suggestedQty ?? s.suggested_qty ?? '?'}`, 'medium'),
        ]),
        s.formula || s.inputs
          ? expandable('Why this quantity', el('pre', { style: 'white-space:pre-wrap;margin:0' }, JSON.stringify(s.formula || s.inputs, null, 2)))
          : null,
        button('Accept into a PO', {
          onClick: async () => {
            const cost = prompt('Unit cost in cents?');
            if (!cost) return;
            try {
              await mutate(`/api/purchasing/suggestions/${s.id}/accept`, 'POST', { unitCostCents: Number(cost) });
              toast('Added to a draft PO.');
              loadPos(slot);
            } catch (e) {
              toast(e.message, 'err');
            }
          },
        }),
      ]))),
    );
  });
}

async function loadPos(slot) {
  await withLoading(slot, async () => {
    const list = await getList('/api/purchasing/purchase-orders', { limit: 100 }).catch(() => ({ data: [] }));
    const rows = list.data || [];
    if (!rows.length) return emptyState({ icon: '🧾', title: 'No purchase orders', message: 'Accept a reorder suggestion, or create a PO from a vendor, to get started.' });
    return section(
      'Purchase orders',
      dataTable(
        [
          { key: 'id', label: 'PO' },
          { key: 'status', label: 'Status', render: (r) => chip(r.status || 'draft', 'medium') },
          { key: 'totalCents', label: 'Total', num: true, render: (r) => (r.totalCents != null ? formatCents(r.totalCents) : '—') },
          { key: 'open', label: '', render: (r) => button('Open', { onClick: () => navigate(`#/buying/po/${r.id}`) }) },
        ],
        rows,
      ),
    );
  });
}

async function renderPo(container, id) {
  container.append(viewHeader({ title: 'Purchase order', actions: [button('Back', { href: '#/buying' }), button('Print', { onClick: () => window.print() })] }));
  const slot = el('div');
  container.append(slot);
  async function refresh() {
    await withLoading(slot, async () => {
      const po = await getData(`/api/purchasing/purchase-orders/${id}`);
      const lines = po.lines || [];
      const wrap = el('div');
      wrap.append(
        section(
          `PO ${po.status || ''}`,
          detailList({ Vendor: po.vendorId, Total: po.totalCents != null ? formatCents(po.totalCents) : '—' }),
          el('div', { class: 'view-actions', style: 'margin-top:8px' }, [
            po.status === 'draft' ? button('Submit for approval', { onClick: () => act('submit') }) : null,
            po.status === 'submitted' || po.status === 'pending_approval' ? button('Approve', { primary: true, onClick: () => act('approve') }) : null,
            button('Receive all as ordered', { onClick: () => receiveAll(po) }),
          ]),
          dataTable(
            [
              { key: 'variationId', label: 'Item' },
              { key: 'qtyOrdered', label: 'Ordered', num: true, render: (l) => l.qtyOrdered ?? l.qty_ordered },
              { key: 'unitCostCents', label: 'Unit cost', num: true, render: (l) => formatCents(l.unitCostCents ?? l.unit_cost_cents ?? 0) },
            ],
            lines,
          ),
        ),
      );
      return wrap;

      async function act(a) {
        try {
          await mutate(`/api/purchasing/purchase-orders/${id}/${a}`, 'POST', {});
          refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      }
      async function receiveAll(po2) {
        const receiptLines = (po2.lines || []).map((l) => ({ poLineId: l.id, qtyReceived: l.qtyOrdered ?? l.qty_ordered, condition: 'ok', final: true }));
        if (!receiptLines.length) return toast('No lines to receive', 'warn');
        try {
          await mutate(`/api/purchasing/purchase-orders/${id}/receipts`, 'POST', { lines: receiptLines });
          toast('Received into stock.');
          refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      }
    });
  }
  refresh();
}
