/** #/settings — admin: identity, connections, backups, health, automation. */
import { registerView } from '../router.js';
import { el, toast } from '../dom.js';
import { getData, getList, mutate } from '../api.js';
import { viewHeader, emptyState, dataTable, button, section, field, input, select, withLoading, chip, detailList } from '../ui.js';
import { formatDateTime } from '../../../src/format.mjs';
import { parsePercentToBps } from '../../../src/cart.mjs';

registerView('settings', async (container) => {
  container.append(viewHeader({ title: 'Settings', subtitle: 'Point of sale, connections, backups, health, and automation.' }));
  const tabs = el('div', { class: 'view-actions', style: 'margin-bottom:12px' });
  const slot = el('div');
  container.append(tabs, slot);
  tabs.append(
    button('Point of sale', { onClick: () => loadPointOfSale(slot) }),
    button('Connections', { onClick: () => loadConnections(slot) }),
    button('Backups', { onClick: () => loadBackups(slot) }),
    button('Health', { onClick: () => loadHealth(slot) }),
    button('Automation', { onClick: () => loadAutomation(slot) }),
    button('Diagnostics', { onClick: () => downloadDiagnostics() }),
  );
  if (document.body.dataset.nativePos === 'true') loadPointOfSale(slot);
  else loadConnections(slot);
});

async function loadPointOfSale(slot) {
  await withLoading(slot, async () => {
    const [settings, readiness, locations, reconciliation] = await Promise.all([
      getData('/api/pos/settings'),
      getData('/api/pos/readiness'),
      getData('/api/inventory/locations'),
      getData('/api/pos/reconciliation').catch((error) => ({ unavailable: true, message: error.message })),
    ]);
    const activeLocations = (Array.isArray(locations) ? locations : [])
      .filter((location) => location.archived !== 1 && location.archived !== true);
    const currentLocationIsActive = activeLocations.some((location) => location.id === settings.defaultLocationId);
    const location = select('defaultLocationId', [
      {
        value: '',
        label: activeLocations.length ? 'Choose an active location' : 'No active inventory locations available',
      },
      ...activeLocations.map((row) => ({
        value: row.id,
        label: `${row.name}${row.kind ? ` · ${humanize(row.kind)}` : ''}`,
      })),
    ], currentLocationIsActive ? settings.defaultLocationId : '');
    location.required = true;
    location.disabled = activeLocations.length === 0;

    const tax = input({
      name: 'taxPercent',
      value: Number.isSafeInteger(settings.taxBps) ? bpsText(settings.taxBps) : '',
      placeholder: '0.00',
      required: true,
    });
    tax.setAttribute('inputmode', 'decimal');
    const receiptFooter = el('textarea', {
      name: 'receiptFooter',
      rows: 4,
      maxlength: 500,
      placeholder: 'Optional message printed at the bottom of receipts',
    }, settings.receiptFooter || '');
    const save = button('Save POS settings', {
      primary: true,
      disabled: activeLocations.length === 0,
      onClick: async () => {
        try {
          if (!location.value) throw new Error('Choose an active inventory location');
          const taxBps = parsePercentToBps(tax.value);
          await mutate('/api/pos/settings', 'PUT', {
            defaultLocationId: location.value,
            taxBps,
            receiptFooter: receiptFooter.value.trim() || null,
          });
          toast('Point-of-sale settings saved.');
          await loadPointOfSale(slot);
        } catch (error) {
          toast(error.message, 'err', 6000);
        }
      },
    });

    const blockers = Array.isArray(readiness?.blockers) ? readiness.blockers : [];
    const cardPresent = readiness?.tenders?.cardPresent || {};
    const processor = await getData('/api/pos/processor').catch(() => null);
    const cardState = cardPresent.physicalReaderVerified === true
      ? (cardPresent.enabled === true ? 'Physical reader verified and enabled' : 'Physical reader verified but disabled')
      : (cardPresent.configured === true ? 'Provider configured; physical reader not verified' : 'Provider and physical reader not configured');
    const wrap = el('div');
    wrap.append(section(
      'Register configuration',
      el('p', { class: 'view-sub' }, 'Owner/admin controls. Cashiers see the configured tax rate as read-only at the register.'),
      !activeLocations.length
        ? el('div', { class: 'blocked', role: 'note' }, 'Create an active inventory location before enabling the register.')
        : null,
      settings.defaultLocationId && !currentLocationIsActive
        ? el('div', { class: 'error-banner', role: 'alert' }, 'The saved POS location is missing or archived. Choose an active location.')
        : null,
      field('Default active inventory location', location, 'Catalog stock and register sales use this location.'),
      field('Sales tax %', tax, 'Enter 0 where no sales tax applies.'),
      field('Receipt footer', receiptFooter, 'Optional, up to 500 characters.'),
      save,
    ));
    wrap.append(section('Payment processor',
      detailList({
        'Stripe connection': processor?.connected ? `Connected · ${processor.mode === 'live' ? 'Live account' : 'Test mode'}` : 'Connection required',
        'Payment confirmations': processor?.webhookConfigured ? 'Webhook configured' : 'Webhook setup required',
      }),
      ...(processor?.readers || []).map((reader) => el('p', { class: 'view-sub' },
        `${reader.label || reader.id} · ${reader.status || 'Unknown status'} · ${reader.compatible ? 'Compatible smart reader' : 'Requires a compatible smart reader (WisePOS E or S700)'} `)),
      el('p', { class: 'view-sub' }, 'Card checkout becomes available after the smart reader is online and payment confirmations are connected.'),
      button('Check connection', { onClick: () => loadPointOfSale(slot) }),
    ));
    wrap.append(section(
      'POS readiness',
      detailList({
        'Register state': chip(readiness?.operational === true ? 'Operational' : 'Setup required', readiness?.operational === true ? 'ok' : 'high'),
        'Cash tender': chip(readiness?.tenders?.cash?.enabled === true ? 'Enabled' : 'Disabled', readiness?.tenders?.cash?.enabled === true ? 'ok' : 'low'),
        'External tender': chip(readiness?.tenders?.external?.enabled === true ? 'Enabled' : 'Disabled', readiness?.tenders?.external?.enabled === true ? 'ok' : 'low'),
        'Card-present state': chip(cardState, cardPresent.physicalReaderVerified === true && cardPresent.enabled === true ? 'ok' : 'high'),
        'Card provider': cardPresent.provider ? humanize(cardPresent.provider) : 'None',
        'Configured providers': Array.isArray(readiness?.providers) && readiness.providers.length
          ? readiness.providers.map(humanize).join(', ')
          : 'None',
      }),
      cardPresent.configured === true && cardPresent.physicalReaderVerified !== true
        ? el('p', { class: 'view-sub' }, 'Provider credentials are configured, but that does not verify a connected physical reader or a successful card-present payment.')
        : null,
      blockers.length
        ? el('div', {}, [
            el('h3', { style: 'margin-top:16px' }, 'Readiness blockers and notices'),
            el('ul', { style: 'margin:6px 0 0 18px' }, blockers.map((blocker) => el('li', {}, [
              chip(blocker.blocking ? 'Blocking' : 'Notice', blocker.blocking ? 'critical' : 'low'),
              el('span', { style: 'margin-left:8px' }, blocker.message),
            ]))),
          ])
        : el('p', { class: 'view-sub' }, 'The server reports no POS readiness blockers.'),
    ));
    const pendingEffects = Number(reconciliation?.pendingCount ?? 0);
    const reconciliationUnavailable = reconciliation?.unavailable === true;
    wrap.append(section(
      'POS reconciliation',
      el('p', { class: 'view-sub' }, 'Durable repair status for sold and returned stock, register finance entries, and cash drawer movements.'),
      reconciliationUnavailable
        ? el('div', { class: 'blocked', role: 'note' }, reconciliation.message || 'Reconciliation status is unavailable for this operator.')
        : detailList({
            Status: chip(reconciliation?.healthy === true ? 'Healthy' : 'Repair required', reconciliation?.healthy === true ? 'ok' : 'critical'),
            'Pending effects': pendingEffects,
            'Effects with errors': Number(reconciliation?.errorCount ?? 0),
            'Completed effects': Number(reconciliation?.completedCount ?? 0),
            'Total effects': Number(reconciliation?.totalCount ?? 0),
          }),
      reconciliationUnavailable
        ? null
        : button('Run POS reconciliation', {
            primary: pendingEffects > 0,
            onClick: async () => {
              try {
                await mutate('/api/pos/reconciliation/drain', 'POST', {}, { query: { limit: 200 } });
                toast('POS reconciliation completed.');
                await loadPointOfSale(slot);
              } catch (error) {
                toast(error.message, 'err', 6000);
              }
            },
          }),
    ));
    return wrap;
  });
}

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
      field('Secret', secret, document.body.dataset.nativePos === 'true' ? 'Stored encrypted on this iPad. Never shown again.' : 'Stored encrypted on this computer (AES-GCM). Never shown again.'),
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
        ? dataTable([{ key: 'created_at', label: 'When', render: (b) => formatDateTime(b.created_at || b.createdAt) }, { key: 'verified', label: 'Verified', render: (b) => chip(b.status === 'verified' ? 'yes' : 'no', b.status === 'verified' ? 'ok' : 'low') }, { key: 'download', label: 'Backup', render: (b) => b.status === 'verified' && b.encrypted ? el('a', { href: `/api/admin/backups/${encodeURIComponent(b.id)}/download`, download: 'blacklabel-backup.blbackup' }, 'Download encrypted backup') : el('span', {}, 'Unavailable') }], rows)
        : el('p', { class: 'view-sub' }, 'No backups yet. Run one before big changes.'),
      el('p', { class: 'hint', style: 'margin-top:10px' }, 'Backups are encrypted and require the installation’s recovery key. Decrypt and verify a separate copy before replacing a database. Keep the current database until recovery is confirmed.'),
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

async function downloadDiagnostics() {
  if (document.body.dataset.nativePos === 'true') {
    try {
      const diagnostics = await getData('/api/admin/diagnostics');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' }));
      a.download = 'bar-one-diagnostics.json'; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    } catch (error) { toast(error.message, 'err'); }
    return;
  }
  const a = document.createElement('a');
  a.href = '/api/admin/diagnostics';
  a.download = 'one-club-diagnostics.json';
  document.body.append(a);
  a.click();
  a.remove();
}

function bpsText(bps) {
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}`;
}

function humanize(value) {
  return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
