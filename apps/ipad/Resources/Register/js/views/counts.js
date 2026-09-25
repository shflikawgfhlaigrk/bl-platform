/** #/counts — stock count sessions: start, count lines, variance, approve, close. */
import { registerView, navigate } from '../router.js';
import { el, toast } from '../dom.js';
import { getData, getList, mutate } from '../api.js';
import { viewHeader, emptyState, dataTable, button, section, field, input, select, withLoading, chip } from '../ui.js';
import { formatDateTime } from '../../../src/format.mjs';

registerView('counts', async (container, params) => {
  if (params[0]) return renderSession(container, params[0]);

  container.append(
    viewHeader({
      title: 'Counts',
      subtitle: 'Count your stock. Blind counts hide the expected number until you approve.',
      actions: [button('Print count sheet', { onClick: () => window.print() })],
    }),
  );

  const startSlot = el('div');
  const listSlot = el('div');
  container.append(startSlot, listSlot);

  let locations = [];
  try {
    locations = (await getData('/api/inventory/locations')) || [];
  } catch {
    /* */
  }

  if (locations.length) {
    const loc = select('loc', locations.map((l) => ({ value: l.id, label: `${l.name} (${l.kind})` })), locations[0].id);
    const kind = select('kind', [{ value: 'full', label: 'Full count' }, { value: 'cycle', label: 'Cycle count' }], 'full');
    const blind = el('input', { type: 'checkbox', id: 'blind', style: 'width:auto;min-height:auto' });
    startSlot.append(
      section(
        'Start a count',
        field('Location', loc),
        field('Kind', kind),
        el('label', { style: 'display:flex;gap:8px;align-items:center' }, [blind, 'Blind count (hide expected quantities)']),
        el('div', { style: 'margin-top:10px' }, button('Start count', {
          primary: true,
          onClick: async () => {
            try {
              const res = await mutate('/api/inventory/count-sessions', 'POST', { locationId: loc.value, kind: kind.value, blind: blind.checked });
              const s = res.data || res;
              navigate(`#/counts/${s.id}`);
            } catch (e) {
              toast(e.message, 'err');
            }
          },
        })),
      ),
    );
  } else {
    startSlot.append(emptyState({ icon: '📋', title: 'Add a location first', message: 'You count into a location. Create one in Stock.', actions: [button('Go to Stock', { primary: true, href: '#/stock' })] }));
  }

  await withLoading(listSlot, async () => {
    const list = await getList('/api/inventory/count-sessions').catch(() => ({ data: [] }));
    const rows = list.data || [];
    if (!rows.length) return section('Recent counts', el('p', { class: 'view-sub' }, 'No counts yet. Start one above.'));
    return section(
      'Recent counts',
      dataTable(
        [
          { key: 'created_at', label: 'Started', render: (r) => formatDateTime(r.created_at || r.createdAt) },
          { key: 'kind', label: 'Kind' },
          { key: 'status', label: 'Status', render: (r) => chip(r.status || 'open', statusVariant(r.status)) },
          { key: 'open', label: '', render: (r) => button('Open', { onClick: () => navigate(`#/counts/${r.id}`) }) },
        ],
        rows,
      ),
    );
  });
});

async function renderSession(container, id) {
  container.append(viewHeader({ title: 'Count session', subtitle: 'Scan or add items, enter counts, then approve and close.', actions: [button('Back', { href: '#/counts' })] }));
  const slot = el('div');
  container.append(slot);

  async function refresh() {
    await withLoading(slot, async () => {
      const session = await getData(`/api/inventory/count-sessions/${id}`);
      const lines = (await getData(`/api/inventory/count-sessions/${id}/lines`)) || [];
      const blind = session.blind;
      const addVar = input({ name: 'variationId', placeholder: 'Variation id to add' });
      const wrap = el('div');
      wrap.append(
        section(
          `Session — ${session.status || 'open'}`,
          el('div', { style: 'display:flex;gap:8px;align-items:end;flex-wrap:wrap' }, [
            field('Add item', addVar),
            button('Add line', {
              onClick: async () => {
                if (!addVar.value.trim()) return;
                try {
                  await mutate(`/api/inventory/count-sessions/${id}/lines`, 'POST', { variationId: addVar.value.trim() });
                  refresh();
                } catch (e) {
                  toast(e.message, 'err');
                }
              },
            }),
          ]),
          dataTable(
            [
              { key: 'variationId', label: 'Item', render: (l) => l.variationId || l.variation_id },
              { key: 'counted', label: 'Counted', num: true, render: (l) => countedCell(l, id, refresh) },
              { key: 'variance', label: 'Variance', num: true, render: (l) => (blind ? chip('hidden (blind)', 'low') : varianceCell(l)) },
              { key: 'approve', label: '', render: (l) => (l.approved ? chip('approved', 'ok') : button('Approve', { onClick: () => approve(l) })) },
            ],
            lines,
            { emptyMessage: 'No lines yet — add or scan items.' },
          ),
        ),
      );
      const signer = input({ name: 'signedBy', placeholder: 'Your name' });
      wrap.append(
        section(
          'Close out',
          field('Signed by', signer),
          button('Approve & close', {
            primary: true,
            onClick: async () => {
              if (!signer.value.trim()) return toast('Sign-off name required', 'warn');
              try {
                await mutate(`/api/inventory/count-sessions/${id}/close`, 'POST', { signedBy: signer.value.trim() });
                toast('Count closed and signed.');
                navigate('#/counts');
              } catch (e) {
                toast(e.message, 'err');
              }
            },
          }),
        ),
      );
      return wrap;

      async function approve(l) {
        try {
          await mutate(`/api/inventory/count-sessions/${id}/lines/${l.id}`, 'PATCH', { approved: true });
          refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      }
    });
  }
  refresh();
}

function countedCell(l, id, refresh) {
  const val = l.countedQty ?? l.counted_qty;
  const inp = el('input', { type: 'number', value: val ?? '', style: 'width:90px', 'aria-label': 'Counted quantity' });
  inp.addEventListener('change', async () => {
    try {
      await mutate(`/api/inventory/count-sessions/${id}/lines/${l.id}`, 'PATCH', { countedQty: Number(inp.value) });
      refresh();
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  return inp;
}
function varianceCell(l) {
  const v = l.variance ?? l.varianceQty;
  if (v === null || v === undefined) return '—';
  return chip(v > 0 ? `+${v}` : String(v), v === 0 ? 'ok' : 'high');
}
function statusVariant(s) {
  return { open: 'medium', review: 'high', closed: 'ok', abandoned: 'low', paused: 'low' }[s] || 'low';
}
