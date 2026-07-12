/** #/actions — the home screen: "What needs attention now" + KPI tiles. */
import { registerView, navigate } from '../router.js';
import { el, clear, toast } from '../dom.js';
import { getData, getList, mutate } from '../api.js';
import {
  viewHeader, metricTile, emptyState, dataTable, chip, expandable, button,
  detailList, section, withLoading, errorBanner,
} from '../ui.js';
import { formatCents } from '../../../src/money.mjs';
import { relativeTime, formatDate, priorityRank, priorityLabel } from '../../../src/format.mjs';
import { phraseReport } from '../../../src/gates.mjs';

const PRIORITY_VARIANT = { critical: 'critical', high: 'high', medium: 'medium', low: 'low' };

async function loadTiles() {
  const grid = el('div', { class: 'grid tiles' });
  try {
    const summary = await getData('/api/dashboard/export');
    const metrics = (summary && summary.metrics) || [];
    let shown = 0;
    for (const m of metrics) {
      if (m.available === false) continue; // NO fabricated numbers — omit unavailable tiles.
      const isMoney = m.unit === 'cents';
      const value = isMoney ? formatCents(Number(m.value) || 0) : String(m.value ?? '—');
      grid.append(
        metricTile({
          label: m.name || m.key,
          value,
          definition: m.definition || `Metric "${m.key}" from your sales history.`,
          source: 'Dashboard',
          foot: 'Source: Dashboard · click to open Money',
          href: '#/money',
        }),
      );
      shown++;
    }
    if (!shown) return null;
  } catch {
    return null;
  }
  return grid;
}

function actionRow(a, refresh) {
  const priority = a.priority || 'medium';
  const evidence = a.evidence
    ? expandable('Why this is here', el('pre', { style: 'white-space:pre-wrap;margin:0' }, prettyEvidence(a.evidence)))
    : null;
  const actionsRow = el('div', { class: 'view-actions', style: 'margin-top:8px' }, [
    a.deepLink ? button('Open', { href: toHash(a.deepLink) }) : null,
    button('Resolve', {
      primary: true,
      onClick: async () => {
        try {
          await mutate(`/api/actions/${a.id}/resolve`, 'POST', { kind: 'manual' });
          toast('Marked resolved.');
          refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      },
    }),
    button('Snooze', {
      onClick: async () => {
        const reason = prompt('Snooze — why? (required)');
        if (!reason) return; // reason required
        const until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        try {
          await mutate(`/api/actions/${a.id}/snooze`, 'POST', { until, reason });
          toast('Snoozed for 1 day.');
          refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      },
    }),
    button('Assign', {
      onClick: async () => {
        const ownerUserId = prompt('Assign to which user id?');
        if (!ownerUserId) return;
        try {
          await mutate(`/api/actions/${a.id}/assign`, 'POST', { ownerUserId });
          toast('Assigned.');
          refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      },
    }),
    button('Comment', {
      onClick: async () => {
        const body = prompt('Add a note:');
        if (!body) return;
        try {
          await mutate(`/api/actions/${a.id}/comments`, 'POST', { body });
          toast('Note added.');
        } catch (e) {
          toast(e.message, 'err');
        }
      },
    }),
  ]);
  return el('div', { class: 'card', style: 'margin-bottom:10px' }, [
    el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' }, [
      chip(priorityLabel(priority), PRIORITY_VARIANT[priority]),
      el('strong', { style: 'flex:1 1 auto' }, a.title || a.kind || 'Action'),
      a.dueAt ? el('span', { class: 'view-sub', style: 'margin:0' }, `Due ${formatDate(a.dueAt)}`) : null,
    ]),
    a.body ? el('p', { style: 'margin:6px 0 0' }, a.body) : null,
    evidence,
    actionsRow,
  ]);
}

function prettyEvidence(ev) {
  try {
    return typeof ev === 'string' ? ev : JSON.stringify(ev, null, 2);
  } catch {
    return String(ev);
  }
}

function toHash(deepLink) {
  if (!deepLink) return '#/actions';
  if (deepLink.startsWith('#')) return deepLink;
  // Map an API-ish deep link to a UI route best-effort.
  if (deepLink.includes('order')) return '#/orders';
  if (deepLink.includes('purchase') || deepLink.includes('po')) return '#/buying';
  if (deepLink.includes('count')) return '#/counts';
  if (deepLink.includes('show')) return '#/shows';
  if (deepLink.includes('transfer')) return '#/transfers';
  return '#/actions';
}

/** Setup checklist for a fresh install with no actions — tells the owner what to do. */
async function setupChecklist() {
  const items = [];
  // Outreach gates (honest, verbatim).
  try {
    const gates = await getData('/api/outreach/settings/gates');
    const report = phraseReport(gates);
    items.push({
      label: 'Turn on customer email',
      done: report.allOpen,
      hint: report.allOpen ? 'All email gates are open.' : `${report.blockedCount} step(s) left in Marketing → Setup.`,
    });
  } catch {
    /* module cold */
  }
  // Inventory: any locations yet?
  try {
    const locs = await getData('/api/inventory/locations');
    items.push({
      label: 'Set up stock locations',
      done: Array.isArray(locs) && locs.length > 0,
      hint: Array.isArray(locs) && locs.length ? `${locs.length} location(s) ready.` : 'Add warehouse / trailer in Stock.',
    });
  } catch {
    /* */
  }
  // Backups configured?
  try {
    const backups = await getList('/api/admin/backups');
    items.push({
      label: 'Take your first backup',
      done: backups.data && backups.data.length > 0,
      hint: backups.data && backups.data.length ? 'Backups exist.' : 'Run one in Settings → Backups.',
    });
  } catch {
    /* */
  }
  return items;
}

registerView('actions', async (container) => {
  container.append(
    viewHeader({
      title: 'Action Center',
      subtitle: 'What needs your attention right now.',
      actions: [button('Refresh', { onClick: () => navigate('#/actions') })],
    }),
  );

  const tilesSlot = el('div', { style: 'margin-bottom:18px' });
  container.append(tilesSlot);
  loadTiles().then((g) => {
    if (g) tilesSlot.append(g);
  });

  const queueSlot = el('div');
  container.append(queueSlot);

  async function refresh() {
    await withLoading(queueSlot, async () => {
      // Process any due snoozes first (wake-due on load).
      try {
        await mutate('/api/actions/wake-due', 'POST', {});
      } catch {
        /* non-fatal */
      }
      let counts = null;
      try {
        counts = await getData('/api/actions/counts');
      } catch {
        /* */
      }
      const list = await getList('/api/actions', { limit: 100 });
      const rows = (list.data || []).slice().sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));

      if (rows.length === 0) {
        const setup = await setupChecklist();
        const allDone = setup.every((s) => s.done);
        return emptyState({
          icon: allDone ? '✅' : '🧭',
          title: allDone ? "All clear — nothing needs attention." : 'You are set up — a few things to finish',
          message: allDone
            ? 'When something needs a decision (low stock, a mismatch, an approval), it shows up here.'
            : 'Finish these to get the most out of Mags OS. Nothing here is guessed — each item is a real setup step.',
          setup: setup.length ? setup : null,
        });
      }

      const wrap = el('div', {});
      if (counts) {
        wrap.append(
          section(
            'Attention summary',
            el('div', { class: 'grid tiles' }, summaryTiles(counts)),
          ),
        );
      }
      wrap.append(el('h2', {}, `Queue (${rows.length})`));
      for (const a of rows) wrap.append(actionRow(a, refresh));
      return wrap;
    });
  }

  refresh();
});

function summaryTiles(counts) {
  // counts shape is best-effort: { total, byPriority:{critical,...} } or a map.
  const tiles = [];
  const byPriority = counts.byPriority || counts.priorities || null;
  if (byPriority) {
    for (const [p, n] of Object.entries(byPriority)) {
      if (!n) continue;
      tiles.push(metricTile({ label: priorityLabel(p), value: String(n), foot: 'open actions' }));
    }
  } else if (typeof counts.total === 'number') {
    tiles.push(metricTile({ label: 'Open actions', value: String(counts.total), foot: 'need attention' }));
  }
  return tiles;
}
