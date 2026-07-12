import type { DashboardPageData, EffectiveWidget } from './service';

/**
 * Server-rendered, framework-free HTML dashboard. All dynamic values are
 * HTML-escaped. Layout is a responsive CSS grid; only the tenant's enabled
 * widgets render, in configured order.
 */

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtMoney(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtBps(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

function rangeLabel(range: { from?: string; to?: string }): string {
  if (!range.from && !range.to) return 'All time';
  const fmt = (iso: string) => iso.slice(0, 10);
  if (range.from && range.to) return `${fmt(range.from)} → ${fmt(range.to)}`;
  if (range.from) return `Since ${fmt(range.from)}`;
  return `Through ${fmt(range.to as string)}`;
}

function unavailableNote(available: boolean, source: string): string {
  return available
    ? ''
    : `<p class="note">Source module (${escapeHtml(source)}) not installed yet — showing zeros.</p>`;
}

function card(title: string, body: string, kicker = ''): string {
  return `<section class="card">
    <header><h2>${escapeHtml(title)}</h2>${kicker ? `<span class="kicker">${kicker}</span>` : ''}</header>
    ${body}
  </section>`;
}

function statusList(rows: { status: string; count: number }[]): string {
  if (rows.length === 0) return '<p class="empty">No records in range.</p>';
  return `<ul class="rows">${rows
    .map(
      (r) =>
        `<li><span class="label">${escapeHtml(r.status)}</span><span class="value">${fmtCount(r.count)}</span></li>`,
    )
    .join('')}</ul>`;
}

function renderWidget(w: EffectiveWidget, d: DashboardPageData): string {
  switch (w.widgetKey) {
    case 'revenue': {
      const r = d.revenue;
      const body = `
        <p class="big">$${fmtMoney(r.paidCents)}</p>
        <p class="sub">${fmtCount(r.paidCount)} paid of ${fmtCount(r.invoiceCount)} invoices</p>
        ${statusList(r.byStatus.map((s) => ({ status: `${s.status} · $${fmtMoney(s.totalCents)}`, count: s.count })))}
        ${unavailableNote(r.available, 'billing')}`;
      return card(w.name, body);
    }
    case 'leads_by_source': {
      const r = d.leadsBySource;
      const max = r.sources.reduce((m, s) => Math.max(m, s.count), 0);
      const bars =
        r.sources.length === 0
          ? '<p class="empty">No leads in range.</p>'
          : `<ul class="bars">${r.sources
              .map(
                (s) => `<li>
              <span class="label">${escapeHtml(s.source)}</span>
              <span class="bar"><i style="width:${max === 0 ? 0 : Math.round((s.count / max) * 100)}%"></i></span>
              <span class="value">${fmtCount(s.count)}</span></li>`,
              )
              .join('')}</ul>`;
      return card(w.name, `<p class="big">${fmtCount(r.totalLeads)}</p><p class="sub">leads</p>${bars}${unavailableNote(r.available, 'crm')}`);
    }
    case 'appointments': {
      const r = d.appointments;
      return card(
        w.name,
        `<p class="big">${fmtCount(r.total)}</p><p class="sub">${fmtCount(r.completed)} completed</p>${statusList(r.byStatus)}${unavailableNote(r.available, 'scheduling')}`,
      );
    }
    case 'quote_conversion': {
      const r = d.quoteConversion;
      return card(
        w.name,
        `<p class="big">${fmtBps(r.conversionBps)}</p>
         <p class="sub">${fmtCount(r.approved)} approved of ${fmtCount(r.sent)} sent</p>
         ${statusList(r.byStatus)}${unavailableNote(r.available, 'quoting')}`,
      );
    }
    case 'open_tasks': {
      const r = d.openTasks;
      return card(
        w.name,
        `<p class="big">${fmtCount(r.open)}</p><p class="sub">open of ${fmtCount(r.total)} in range</p>${statusList(r.byStatus)}${unavailableNote(r.available, 'workflows')}`,
      );
    }
    case 'employee_activity': {
      const r = d.employeeActivity;
      const rows =
        r.users.length === 0
          ? '<p class="empty">No activity in range.</p>'
          : `<table><thead><tr><th>Employee</th><th>Entries</th><th>Minutes</th><th>Work logs</th></tr></thead><tbody>${r.users
              .map(
                (u) =>
                  `<tr><td>${escapeHtml(u.employeeId)}</td><td>${fmtCount(u.timeEntryCount)}</td><td>${fmtCount(u.minutes)}</td><td>${fmtCount(u.worklogCount)}</td></tr>`,
              )
              .join('')}</tbody></table>`;
      return card(
        w.name,
        `<p class="big">${fmtCount(r.timeEntries.totalMinutes)}</p><p class="sub">tracked minutes · ${fmtCount(r.timeEntries.openCount)} open entries · ${fmtCount(r.worklogs.count)} worklogs</p>${rows}${unavailableNote(r.available, 'portal-employee')}`,
      );
    }
    case 'reviews': {
      const r = d.reviews;
      const avg = r.averageRating === null ? '—' : r.averageRating.toFixed(2);
      const dist = (['5', '4', '3', '2', '1'] as const)
        .map((k) => `<li><span class="label">${k}★</span><span class="value">${fmtCount(r.distribution[k])}</span></li>`)
        .join('');
      return card(
        w.name,
        `<p class="big">${escapeHtml(avg)}</p><p class="sub">average across ${fmtCount(r.count)} reviews</p><ul class="rows">${dist}</ul>${unavailableNote(r.available, 'reviews')}`,
      );
    }
    case 'website_traffic':
      return card(w.name, '<p class="big muted">—</p><p class="sub">No traffic source connected yet.</p>', 'coming soon');
    case 'campaign_performance':
      return card(w.name, '<p class="big muted">—</p><p class="sub">No campaign source connected yet.</p>', 'coming soon');
    case 'recent_activity': {
      const items =
        d.recentActivity.length === 0
          ? '<p class="empty">No activity yet.</p>'
          : `<ul class="feed">${d.recentActivity
              .map(
                (a) =>
                  `<li><span class="label">${escapeHtml(a.action)}</span><span class="sub">${escapeHtml(a.entityType)} · ${escapeHtml(a.actor)} · ${escapeHtml(a.createdAt.slice(0, 16).replace('T', ' '))}</span></li>`,
              )
              .join('')}</ul>`;
      return card(w.name, items);
    }
    case 'alerts': {
      const items =
        d.alerts.length === 0
          ? '<p class="empty">No alert rules defined.</p>'
          : `<ul class="rows">${d.alerts
              .map(
                (a) =>
                  `<li class="${a.triggered ? 'alert-hit' : ''}"><span class="label">${escapeHtml(a.name)}</span><span class="value">${a.triggered ? 'TRIGGERED' : a.available ? 'ok' : 'n/a'} · ${escapeHtml(String(a.value))}</span></li>`,
              )
              .join('')}</ul>`;
      return card(w.name, items);
    }
    default:
      return '';
  }
}

export function renderDashboardPage(d: DashboardPageData): string {
  const widgets = d.widgets.map((w) => renderWidget(w, d)).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(d.tenantName)} — Dashboard</title>
<style>
  :root{--bg:#f6f7f9;--card:#ffffff;--ink:#111318;--muted:#6b7280;--line:#e5e7eb;--accent:#111318;--hit:#b91c1c}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:32px 24px}
  .wrap{max-width:1200px;margin:0 auto}
  .masthead{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:24px;border-bottom:1px solid var(--line);padding-bottom:16px}
  .masthead h1{font-size:22px;font-weight:650;letter-spacing:-.01em}
  .masthead .range{color:var(--muted);font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;box-shadow:0 1px 2px rgba(17,19,24,.04)}
  .card header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px}
  .card h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .kicker{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:2px 8px}
  .big{font-size:30px;font-weight:700;letter-spacing:-.02em}
  .big.muted{color:var(--muted)}
  .sub{color:var(--muted);font-size:13px;margin-bottom:10px}
  .rows,.bars,.feed{list-style:none;font-size:13px}
  .rows li,.feed li{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-top:1px solid var(--line)}
  .feed li{flex-direction:column;gap:0}
  .bars li{display:grid;grid-template-columns:minmax(60px,1fr) 2fr auto;align-items:center;gap:10px;padding:5px 0}
  .bar{height:8px;background:var(--line);border-radius:99px;overflow:hidden}
  .bar i{display:block;height:100%;background:var(--accent);border-radius:99px}
  .label{color:var(--ink)}
  .value{color:var(--muted);font-variant-numeric:tabular-nums}
  .alert-hit .value{color:var(--hit);font-weight:600}
  .empty,.note{color:var(--muted);font-size:13px}
  .note{margin-top:10px;font-style:italic}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--muted);font-weight:500;padding:4px 8px 4px 0;border-bottom:1px solid var(--line)}
  td{padding:6px 8px 6px 0;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
  @media (max-width:640px){body{padding:16px}.big{font-size:24px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="masthead">
    <h1>${escapeHtml(d.tenantName)}</h1>
    <span class="range">${escapeHtml(rangeLabel(d.range))}</span>
  </div>
  <div class="grid">
${widgets}
  </div>
</div>
</body>
</html>`;
}
