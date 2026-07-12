/** #/shows — horse-show planning, manifest builder (print), closeout. */
import { registerView, navigate } from '../router.js';
import { el, toast } from '../dom.js';
import { getData, getList, mutate } from '../api.js';
import { viewHeader, emptyState, dataTable, button, section, field, input, select, withLoading, chip, detailList, expandable } from '../ui.js';
import { formatDate, formatCents } from '../ui.js';

registerView('shows', async (container, params) => {
  if (params[0]) return renderShow(container, params[0]);
  container.append(viewHeader({ title: 'Shows', subtitle: 'Plan a show, pack the trailer, close it out.' }));

  const createSlot = el('div');
  const listSlot = el('div');
  container.append(createSlot, listSlot);

  // Need a venue to create a show.
  let venues = [];
  try {
    venues = (await getList('/api/shows/venues')).data || [];
  } catch {
    /* */
  }

  createSlot.append(newShowCard(venues));

  await withLoading(listSlot, async () => {
    const list = await getList('/api/shows/shows', { limit: 100 }).catch(() => ({ data: [] }));
    const rows = list.data || [];
    if (!rows.length) return emptyState({ icon: '🎪', title: 'No shows scheduled', message: 'Add a venue and a show above. Manifests, load-out, and closeout all hang off a show.' });
    return section(
      'Shows',
      dataTable(
        [
          { key: 'name', label: 'Show' },
          { key: 'startsOn', label: 'Starts', render: (r) => formatDate(r.startsOn || r.starts_on) },
          { key: 'status', label: 'Status', render: (r) => chip(r.status || 'planned', 'medium') },
          { key: 'open', label: '', render: (r) => button('Open', { onClick: () => navigate(`#/shows/${r.id}`) }) },
        ],
        rows,
      ),
    );
  });
});

function newShowCard(venues) {
  if (!venues.length) {
    const vname = input({ name: 'name', placeholder: 'Venue name' });
    const vstate = input({ name: 'state', placeholder: 'State (e.g. GA)' });
    return section(
      'Add a venue first',
      field('Venue name', vname),
      field('State', vstate),
      button('Add venue', {
        primary: true,
        onClick: async () => {
          try {
            await mutate('/api/shows/venues', 'POST', { name: vname.value.trim(), state: (vstate.value.trim() || 'NA').slice(0, 2).toUpperCase() });
            toast('Venue added.');
            navigate('#/shows');
          } catch (e) {
            toast(e.message, 'err');
          }
        },
      }),
    );
  }
  const venue = select('venue', venues.map((v) => ({ value: v.id, label: v.name })), venues[0].id);
  const name = input({ name: 'name', placeholder: 'Show name' });
  const starts = input({ name: 'startsOn', type: 'date' });
  const ends = input({ name: 'endsOn', type: 'date' });
  return section(
    'Add a show',
    field('Venue', venue),
    field('Name', name),
    el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' }, [field('Starts', starts), field('Ends', ends)]),
    button('Create show', {
      primary: true,
      onClick: async () => {
        if (!name.value.trim() || !starts.value) return toast('Name and start date required', 'warn');
        try {
          const res = await mutate('/api/shows/shows', 'POST', { venueId: venue.value, name: name.value.trim(), startsOn: starts.value, endsOn: ends.value || starts.value });
          const s = res.data || res;
          navigate(`#/shows/${s.id}`);
        } catch (e) {
          toast(e.message, 'err');
        }
      },
    }),
  );
}

async function renderShow(container, id) {
  container.append(viewHeader({ title: 'Show', actions: [button('Back', { href: '#/shows' }), button('Print manifest', { onClick: () => window.print() })] }));
  const slot = el('div');
  container.append(slot);

  async function refresh() {
    await withLoading(slot, async () => {
      const show = await getData(`/api/shows/shows/${id}`);
      const wrap = el('div');
      wrap.append(
        section(
          show.name || 'Show',
          detailList({
            Status: chip(show.status || 'planned', 'medium'),
            Starts: formatDate(show.startsOn || show.starts_on),
            Ends: formatDate(show.endsOn || show.ends_on),
            'Booth fee': show.boothFeeCents != null ? formatCents(show.boothFeeCents) : '—',
          }),
          el('div', { class: 'view-actions', style: 'margin-top:10px' }, transitions(show, id, refresh)),
        ),
      );

      // Manifests
      const manifests = (await getList(`/api/shows/shows/${id}/manifests`).catch(() => ({ data: [] }))).data || [];
      wrap.append(
        section(
          'Packing manifests',
          manifests.length
            ? dataTable([{ key: 'id', label: 'Manifest' }, { key: 'status', label: 'Status' }], manifests)
            : el('p', { class: 'view-sub' }, 'No manifest yet. Build one from a template on the Buying/Shows workflow.'),
        ),
      );

      // Closeout P&L (missing inputs listed honestly)
      try {
        const pnl = await getData(`/api/shows/shows/${id}/pnl`);
        wrap.append(section('Show P&L', renderPnl(pnl)));
      } catch {
        wrap.append(section('Show P&L', el('div', { class: 'blocked' }, 'P&L is available after closeout inputs (sales, cash, fees, costs) are entered.')));
      }
      return wrap;
    });
  }
  refresh();
}

function transitions(show, id, refresh) {
  const flow = ['planned', 'packing', 'active', 'returned', 'closing', 'closed'];
  const idx = flow.indexOf(show.status);
  const next = idx >= 0 && idx < flow.length - 1 ? flow[idx + 1] : null;
  const btns = [];
  if (next) {
    btns.push(button(`Advance to "${next}"`, {
      primary: true,
      onClick: async () => {
        try {
          await mutate(`/api/shows/shows/${id}/transition`, 'POST', { to: next });
          refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      },
    }));
  }
  return btns;
}

function renderPnl(pnl) {
  const missing = pnl.missingInputs || pnl.missing || [];
  const wrap = el('div');
  wrap.append(detailList({
    Revenue: pnl.revenueCents != null ? formatCents(pnl.revenueCents) : 'unknown',
    'Gross margin': pnl.grossMarginCents != null ? formatCents(pnl.grossMarginCents) : 'unknown',
    Units: pnl.units ?? '—',
  }));
  if (missing.length) wrap.append(el('div', { class: 'blocked' }, [el('strong', {}, 'Missing inputs: '), missing.join(', ')]));
  return wrap;
}
