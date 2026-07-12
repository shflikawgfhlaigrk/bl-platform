/** #/customers — search, profile, consents, restock, cases, segments, merges. */
import { registerView, navigate } from '../router.js';
import { el, toast } from '../dom.js';
import { getData, getList, mutate } from '../api.js';
import { viewHeader, emptyState, dataTable, button, section, field, input, withLoading, chip, detailList } from '../ui.js';

registerView('customers', async (container, params) => {
  if (params[0]) return renderProfile(container, params[0]);
  container.append(viewHeader({ title: 'Customers', subtitle: 'Find a customer, see their history and consents.' }));

  const q = input({ name: 'q', placeholder: 'Search name, email, or phone' });
  const slot = el('div');
  container.append(section('Search', field('Search', q), button('Search', { primary: true, onClick: search })), slot);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });

  async function search() {
    await withLoading(slot, async () => {
      const term = q.value.trim();
      const query = { limit: 50 };
      if (term.includes('@')) query.email = term;
      else if (/^[0-9+()\-\s]+$/.test(term) && term) query.phone = term;
      else if (term) query.name = term;
      const list = await getList('/api/customers/profiles', query);
      const rows = list.data || [];
      if (!rows.length) return emptyState({ icon: '👤', title: term ? 'No matches' : 'Search to begin', message: term ? 'No customer matches that. Try an email or phone.' : 'Type a name, email, or phone and press Search.' });
      return dataTable(
        [
          { key: 'name', label: 'Name', render: (r) => `${r.first_name || r.firstName || ''} ${r.last_name || r.lastName || ''}`.trim() || '—' },
          { key: 'email', label: 'Email' },
          { key: 'phone', label: 'Phone' },
          { key: 'open', label: '', render: (r) => button('Open', { onClick: () => navigate(`#/customers/${r.id}`) }) },
        ],
        rows,
      );
    });
  }

  // Segments summary
  const segSlot = el('div');
  container.append(segSlot);
  try {
    const segs = (await getData('/api/customers/segments')) || [];
    if (Array.isArray(segs) && segs.length) {
      segSlot.append(section('Segments', dataTable([{ key: 'name', label: 'Segment' }, { key: 'count', label: 'Members', num: true, render: (s) => s.memberCount ?? s.count ?? '—' }], segs)));
    }
  } catch {
    /* */
  }
});

async function renderProfile(container, id) {
  container.append(viewHeader({ title: 'Customer', actions: [button('Back', { href: '#/customers' })] }));
  const slot = el('div');
  container.append(slot);
  await withLoading(slot, async () => {
    const p = await getData(`/api/customers/profiles/${id}`);
    const wrap = el('div');
    wrap.append(
      section(
        `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Customer',
        detailList({ Email: p.email || '—', Phone: p.phone || '—', Source: p.source || '—' }),
      ),
    );
    // Consents
    try {
      const consents = (await getData(`/api/customers/profiles/${id}/consents`)) || [];
      wrap.append(section('Consents', Array.isArray(consents) && consents.length
        ? dataTable([{ key: 'channel', label: 'Channel' }, { key: 'state', label: 'State', render: (c) => chip(c.state, c.state === 'granted' ? 'ok' : 'low') }], consents)
        : el('p', { class: 'view-sub' }, 'No consent on file — cannot send marketing to this customer.')));
    } catch {
      /* */
    }
    // Restock requests
    try {
      const rr = (await getList(`/api/customers/restock-requests`, {}).catch(() => ({ data: [] }))).data || [];
      const mine = rr.filter((r) => (r.profile_id || r.profileId) === id);
      if (mine.length) wrap.append(section('Restock requests', dataTable([{ key: 'variation_id', label: 'Item' }, { key: 'status', label: 'Status' }], mine)));
    } catch {
      /* */
    }
    return wrap;
  });
}
