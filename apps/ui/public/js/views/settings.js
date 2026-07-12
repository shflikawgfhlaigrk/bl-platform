/** #/settings — admin: identity, connections, backups, health, automation. */
import { registerView } from '../router.js';
import { el, toast } from '../dom.js';
import { getData, getList, mutate } from '../api.js';
import { viewHeader, emptyState, dataTable, button, section, field, input, withLoading, chip } from '../ui.js';
import { formatDateTime } from '../../../src/format.mjs';

registerView('settings', async (container) => {
  container.append(viewHeader({ title: 'Settings', subtitle: 'Connections, backups, health, and automation.' }));
  const tabs = el('div', { class: 'view-actions', style: 'margin-bottom:12px' });
  const slot = el('div');
  container.append(tabs, slot);
  tabs.append(
    button('Connections', { onClick: () => loadConnections(slot) }),
    button('Backups', { onClick: () => loadBackups(slot) }),
    button('Health', { onClick: () => loadHealth(slot) }),
    button('Automation', { onClick: () => loadAutomation(slot) }),
    button('Diagnostics', { onClick: () => downloadDiagnostics() }),
  );
  loadConnections(slot);
});

async function loadConnections(slot) {
  await withLoading(slot, async () => {
    const list = await getList('/api/admin/credentials').catch(() => ({ data: [] }));
    const rows = list.data || [];
    let expiring = [];
    try {
      expiring = (await getData('/api/admin/credentials/expiring', { days: 14 })) || [];
    } catch {
      /* */
    }
    const name = input({ name: 'name', placeholder: 'e.g. Square' });
    const provider = input({ name: 'provider', placeholder: 'provider key (e.g. smtp, square)' });
    const secret = input({ name: 'secret', placeholder: 'secret / token' });
    const wrap = el('div');
    if (Array.isArray(expiring) && expiring.length) {
      wrap.append(el('div', { class: 'blocked' }, [el('strong', {}, 'Expiring soon: '), expiring.map((c) => c.name || c.id).join(', ')]));
    }
    wrap.append(section(
      'Add a connection',
      field('Name', name),
      field('Provider', provider, 'The kind of connection (SMTP for email, Square for payments, …).'),
      field('Secret', secret, 'Stored encrypted on this computer (AES-GCM). Never shown again.'),
      button('Save connection', {
        primary: true,
        onClick: async () => {
          if (!name.value.trim() || !provider.value.trim()) return toast('Name and provider required', 'warn');
          try {
            await mutate('/api/admin/credentials', 'POST', { name: name.value.trim(), provider: provider.value.trim(), payload: { secret: secret.value } });
            toast('Connection saved (encrypted).');
            loadConnections(slot);
          } catch (e) {
            toast(e.message, 'err');
          }
        },
      }),
    ));
    wrap.append(section('Connections', rows.length
      ? dataTable([
          { key: 'name', label: 'Name' },
          { key: 'provider', label: 'Provider' },
          { key: 'masked', label: 'Secret', render: () => chip('•••• stored', 'ok') },
          { key: 'test', label: '', render: (c) => button('Test', { onClick: () => testConn(c.id) }) },
        ], rows)
      : el('p', { class: 'view-sub' }, 'No connections yet. Email and payments stay off until connected.')));
    return wrap;
  });
}

async function testConn(id) {
  try {
    await mutate(`/api/admin/credentials/${id}/test`, 'POST', {});
    toast('Connection test passed.');
  } catch (e) {
    toast(e.status === 501 ? 'No tester wired for this provider yet.' : e.message, 'warn');
  }
}

async function loadBackups(slot) {
  await withLoading(slot, async () => {
    const list = await getList('/api/admin/backups').catch(() => ({ data: [] }));
    const rows = list.data || [];
    const wrap = el('div');
    wrap.append(section('Backups',
      el('div', { class: 'view-actions' }, [
        button('Run backup now', { primary: true, onClick: async () => { try { await mutate('/api/admin/backups/run', 'POST', { encrypted: true }); toast('Backup started.'); loadBackups(slot); } catch (e) { toast(e.status === 501 ? 'Backup provider not available in this session.' : e.message, 'warn'); } } }),
      ]),
      rows.length
        ? dataTable([{ key: 'created_at', label: 'When', render: (b) => formatDateTime(b.created_at || b.createdAt) }, { key: 'verified', label: 'Verified', render: (b) => chip(b.verified ? 'yes' : 'no', b.verified ? 'ok' : 'low') }], rows)
        : el('p', { class: 'view-sub' }, 'No backups yet. Run one before big changes.'),
      el('p', { class: 'hint', style: 'margin-top:10px' }, 'To restore: stop the app, replace the database file with the verified backup, and restart. Keep a copy of the current file first.'),
    ));
    return wrap;
  });
}

async function loadHealth(slot) {
  await withLoading(slot, async () => {
    let runs = [];
    try {
      await mutate('/api/admin/health/run', 'POST', {});
      runs = (await getList('/api/admin/health/runs')).data || [];
    } catch {
      /* */
    }
    if (!runs.length) return emptyState({ icon: '🩺', title: 'No health checks yet', message: 'Health checks watch the database, disk, backups, imports, and outbox.' });
    const latest = runs[0];
    const checks = latest.checks || latest.results || [];
    return section('Health', Array.isArray(checks) && checks.length
      ? dataTable([{ key: 'name', label: 'Check' }, { key: 'status', label: 'Status', render: (c) => chip(c.status || c.ok ? 'ok' : 'fail', (c.status === 'ok' || c.ok) ? 'ok' : 'critical') }], checks)
      : el('p', { class: 'view-sub' }, 'Health ran; no detail rows returned.'));
  });
}

async function loadAutomation(slot) {
  await withLoading(slot, async () => {
    const rules = (await getList('/api/automation/rules').catch(() => ({ data: [] }))).data || [];
    const dead = (await getList('/api/automation/outbox/dead').catch(() => ({ data: [] }))).data || [];
    const wrap = el('div');
    wrap.append(section('Automation rules', rules.length
      ? dataTable([{ key: 'name', label: 'Rule' }, { key: 'triggerEvent', label: 'When' }, { key: 'policy', label: 'Policy', render: (r) => chip(r.policy || 'disabled', r.policy === 'automatic' ? 'ok' : 'low') }], rules)
      : el('p', { class: 'view-sub' }, 'No automation rules configured.')));
    wrap.append(section('Dead letters', dead.length
      ? dataTable([{ key: 'id', label: 'Item' }, { key: 'error', label: 'Error' }, { key: 'replay', label: '', render: (d) => button('Replay', { onClick: async () => { try { await mutate(`/api/automation/outbox/${d.id}/replay`, 'POST', {}); toast('Replayed.'); loadAutomation(slot); } catch (e) { toast(e.message, 'err'); } } }) }], dead)
      : el('p', { class: 'view-sub' }, 'No dead-letter items — nothing failed delivery.')));
    return wrap;
  });
}

function downloadDiagnostics() {
  const a = document.createElement('a');
  a.href = '/api/admin/diagnostics';
  a.download = 'mags-diagnostics.json';
  document.body.append(a);
  a.click();
  a.remove();
}
