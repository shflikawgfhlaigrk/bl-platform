/** #/imports — data sync status, manifests, reconciliation, quarantine. */
import { registerView } from '../router.js';
import { el, toast } from '../dom.js';
import { getData, getList, mutate } from '../api.js';
import { viewHeader, emptyState, dataTable, button, section, withLoading, chip, expandable } from '../ui.js';
import { formatDateTime } from '../../../src/format.mjs';

registerView('imports', async (container) => {
  container.append(viewHeader({ title: 'Imports', subtitle: 'Where your Square data comes in — status, manifests, and anything that needs fixing.' }));

  const slot = el('div');
  container.append(slot);

  await withLoading(slot, async () => {
    const wrap = el('div');

    // Status per kind
    try {
      const status = await getData('/api/retail/imports/status');
      wrap.append(section('Sync status', renderStatus(status)));
    } catch {
      wrap.append(section('Sync status', el('p', { class: 'view-sub' }, 'No incremental import runs yet. Historical data was loaded once from the ledger.')));
    }

    // Reconciliation
    try {
      const rec = await getData('/api/retail/imports/reconciliation');
      wrap.append(section('Reconciliation', expandable('Totals and coverage', el('pre', { style: 'white-space:pre-wrap;margin:0' }, JSON.stringify(rec, null, 2)))));
    } catch {
      /* */
    }

    // Manifests
    const manifests = (await getList('/api/retail/imports/manifests').catch(() => ({ data: [] }))).data || [];
    wrap.append(section('Import manifests', manifests.length
      ? dataTable([{ key: 'id', label: 'Manifest' }, { key: 'kind', label: 'Kind' }, { key: 'created_at', label: 'When', render: (m) => formatDateTime(m.created_at || m.createdAt) }], manifests)
      : el('p', { class: 'view-sub' }, 'No import manifests recorded yet.')));

    // Quarantine
    const quarantine = (await getList('/api/retail/quarantine').catch(() => ({ data: [] }))).data || [];
    wrap.append(section('Needs fixing (quarantine)', quarantine.length
      ? el('div', {}, quarantine.map((q) => el('div', { class: 'card', style: 'margin-bottom:10px' }, [
          el('div', { style: 'display:flex;justify-content:space-between' }, [el('strong', {}, q.kind || 'record'), chip(q.status || 'open', 'high')]),
          expandable('Show record', el('pre', { style: 'white-space:pre-wrap;margin:0' }, JSON.stringify(q.record || q, null, 2))),
          el('div', { class: 'view-actions' }, [
            button('Discard', { onClick: async () => { const reason = prompt('Why discard this record?'); if (!reason) return; try { await mutate(`/api/retail/quarantine/${q.id}/discard`, 'POST', { reason }); toast('Discarded.'); location.hash = '#/imports'; } catch (e) { toast(e.message, 'err'); } } }),
          ]),
        ])))
      : el('div', { class: 'chip chip-ok' }, 'Nothing quarantined — every record imported cleanly.')));

    return wrap;
  });
});

function renderStatus(status) {
  const kinds = status && (status.kinds || status.byKind || status);
  if (Array.isArray(kinds)) {
    return dataTable([
      { key: 'kind', label: 'Data' },
      { key: 'lastSuccessAt', label: 'Last success', render: (k) => formatDateTime(k.lastSuccessAt || k.last_success_at) },
      { key: 'stale', label: 'Fresh?', render: (k) => chip(k.stale ? 'stale' : 'fresh', k.stale ? 'high' : 'ok') },
    ], kinds);
  }
  return el('pre', { style: 'white-space:pre-wrap;margin:0' }, JSON.stringify(status, null, 2));
}
