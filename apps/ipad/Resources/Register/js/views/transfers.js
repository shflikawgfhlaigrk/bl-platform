/** #/transfers — move stock between locations: create, ship, receive by line. */
import { registerView, navigate } from '../router.js';
import { el, toast } from '../dom.js';
import { getData, getList, mutate } from '../api.js';
import { viewHeader, emptyState, dataTable, button, section, field, input, select, withLoading, chip } from '../ui.js';

registerView('transfers', async (container, params) => {
  if (params[0]) return renderTransfer(container, params[0]);

  container.append(viewHeader({ title: 'Transfers', subtitle: 'Send stock from one location to another, then receive it.' }));

  let locations = [];
  try {
    locations = (await getData('/api/inventory/locations')) || [];
  } catch {
    /* */
  }
  if (locations.length < 2) {
    container.append(emptyState({ icon: '🔁', title: 'Need at least two locations', message: 'A transfer moves stock between two places. Add another location in Stock.', actions: [button('Go to Stock', { primary: true, href: '#/stock' })] }));
    return;
  }

  const from = select('from', locations.map((l) => ({ value: l.id, label: l.name })), locations[0].id);
  const to = select('to', locations.map((l) => ({ value: l.id, label: l.name })), locations[1].id);
  const varId = input({ name: 'variationId', placeholder: 'Variation id' });
  const qty = input({ name: 'qty', type: 'number', value: '1' });
  const lines = [];
  const lineSlot = el('div');

  const renderLines = () => {
    lineSlot.replaceChildren(dataTable([{ key: 'variationId', label: 'Item' }, { key: 'qtySent', label: 'Qty', num: true }], lines, { emptyMessage: 'Add items to send.' }));
  };
  renderLines();

  container.append(
    section(
      'New transfer',
      el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' }, [field('From', from), field('To', to)]),
      el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:end' }, [
        field('Item', varId),
        field('Qty', qty),
        button('Add line', {
          onClick: () => {
            if (!varId.value.trim()) return;
            lines.push({ variationId: varId.value.trim(), qtySent: Number(qty.value) || 1 });
            varId.value = '';
            renderLines();
          },
        }),
      ]),
      lineSlot,
      button('Create transfer', {
        primary: true,
        onClick: async () => {
          if (!lines.length) return toast('Add at least one item', 'warn');
          if (from.value === to.value) return toast('From and To must differ', 'warn');
          try {
            const res = await mutate('/api/inventory/transfers', 'POST', { fromLocationId: from.value, toLocationId: to.value, lines });
            const t = res.data || res;
            navigate(`#/transfers/${t.id}`);
          } catch (e) {
            toast(e.message, 'err');
          }
        },
      }),
    ),
  );
});

async function renderTransfer(container, id) {
  container.append(viewHeader({ title: 'Transfer', subtitle: 'Ship it, then receive each line — discrepancies are flagged.', actions: [button('Back', { href: '#/transfers' })] }));
  const slot = el('div');
  container.append(slot);

  async function refresh() {
    await withLoading(slot, async () => {
      const t = await getData(`/api/inventory/transfers/${id}`);
      const lines = t.lines || [];
      const wrap = el('div');
      wrap.append(
        section(
          `Status: ${t.status || 'draft'}`,
          el('div', { class: 'view-actions' }, [
            button('Ship', { primary: t.status === 'draft', onClick: () => act('ship') }),
          ]),
          dataTable(
            [
              { key: 'variationId', label: 'Item' },
              { key: 'qtySent', label: 'Sent', num: true, render: (l) => l.qtySent ?? l.qty_sent },
              { key: 'qtyReceived', label: 'Received', num: true, render: (l) => receiveCell(l) },
              { key: 'disc', label: 'Discrepancy', num: true, render: (l) => disc(l) },
            ],
            lines,
          ),
          button('Receive entered quantities', { primary: true, onClick: receiveAll }),
        ),
      );
      return wrap;

      function receiveCell(l) {
        const inp = el('input', { type: 'number', value: l.qtyReceived ?? '', style: 'width:90px', 'aria-label': 'Received quantity' });
        inp.dataset.lineId = l.id;
        return inp;
      }
      async function receiveAll() {
        const receipts = Array.from(slot.querySelectorAll('input[data-line-id]'))
          .map((i) => ({ lineId: i.dataset.lineId, qtyReceived: Number(i.value) }))
          .filter((r) => Number.isFinite(r.qtyReceived));
        if (!receipts.length) return toast('Enter received quantities', 'warn');
        try {
          await mutate(`/api/inventory/transfers/${id}/receive`, 'POST', { receipts });
          toast('Received.');
          refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      }
      async function act(a) {
        try {
          await mutate(`/api/inventory/transfers/${id}/${a}`, 'POST', {});
          refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      }
    });
  }
  refresh();
}

function disc(l) {
  const sent = l.qtySent ?? l.qty_sent ?? 0;
  const rec = l.qtyReceived;
  if (rec === null || rec === undefined) return '—';
  const d = rec - sent;
  return d === 0 ? chip('ok', 'ok') : chip(d > 0 ? `+${d}` : String(d), 'high');
}
