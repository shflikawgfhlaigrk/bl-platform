import { escapeHtml } from './html';
import type { OwnerDashboardData, OwnerWeekPoint } from './owner';

/**
 * Owner dashboard page — written for a non-technical shop owner: whole
 * dollars, plain labels, every panel either shows real computed numbers or
 * says honestly that the data is not there yet. No scripts, no external
 * resources, server-rendered.
 */

/** Whole-dollar display with standard rounding: 12345 → "$123". */
function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const whole = Math.floor((Math.abs(cents) + 50) / 100);
  return `${sign}$${whole.toLocaleString('en-US')}`;
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** "2026-07-11" → "Jul 11, 2026" (deterministic, no locale surprises). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(localDate: string): string {
  const [y, m, d] = localDate.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function fmtMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

function card(title: string, body: string, kicker = ''): string {
  return `<section class="card">
    <header><h2>${escapeHtml(title)}</h2>${kicker ? `<span class="kicker">${escapeHtml(kicker)}</span>` : ''}</header>
    ${body}
  </section>`;
}

function changeLine(pctChange: number | null, lastYear: string): string {
  if (pctChange === null) return `<p class="sub">Last year: ${lastYear}</p>`;
  const word = pctChange >= 0 ? 'up' : 'down';
  const cls = pctChange >= 0 ? 'up' : 'down';
  return `<p class="sub">Last year: ${lastYear} — <span class="${cls}">${word} ${Math.abs(pctChange).toFixed(1)}%</span></p>`;
}

function bars(rows: { label: string; valueCents: number; note?: string }[]): string {
  const max = rows.reduce((m, r) => Math.max(m, r.valueCents), 0);
  return `<ul class="bars">${rows
    .map(
      (r) => `<li>
      <span class="label">${escapeHtml(r.label)}</span>
      <span class="bar"><i style="width:${max === 0 ? 0 : Math.round((r.valueCents / max) * 100)}%"></i></span>
      <span class="value">${dollars(r.valueCents)}${r.note ? ` <small>${escapeHtml(r.note)}</small>` : ''}</span></li>`,
    )
    .join('')}</ul>`;
}

function weeklyTrendCard(weeks: OwnerWeekPoint[]): string {
  if (weeks.length === 0) return card('Weekly sales', '<p class="empty">No weeks to show yet.</p>');
  const body = bars(
    weeks.map((w) => ({
      label: `wk end ${fmtDate(w.weekEnding).replace(/, \d+$/, '')}`,
      valueCents: w.grossCents,
      note: w.partial ? 'so far' : `${w.paymentCount} sales`,
    })),
  );
  return card('Weekly sales', body, 'last 12 weeks');
}

export function renderOwnerDashboardPage(d: OwnerDashboardData): string {
  const cards: string[] = [];

  if (!d.available) {
    cards.push(
      card(
        'No sales data yet',
        `<p class="empty">Sales have not been imported into this dashboard yet.
         Once the Square export is imported, every panel here fills in with real numbers —
         nothing on this page is ever estimated or made up.</p>`,
      ),
    );
  } else {
    /* Year so far */
    if (d.ytd) {
      const ly =
        d.ytd.lastYearGrossCents === null
          ? 'no data (records start later)'
          : `${dollars(d.ytd.lastYearGrossCents)} (through ${fmtDate(d.ytd.lastYearThroughLocalDate)})`;
      cards.push(
        card(
          `${d.ytd.year} so far`,
          `<p class="big">${dollars(d.ytd.grossCents)}</p>
           <p class="sub">Jan 1 through ${fmtDate(d.ytd.throughLocalDate)}</p>
           ${changeLine(d.ytd.pctChange, ly)}`,
        ),
      );
    }

    /* All time */
    cards.push(
      card(
        'All time',
        `<p class="big">${dollars(d.allTime.grossCents)}</p>
         <p class="sub">${fmtCount(d.allTime.paymentCount)} sales · average sale ${
           d.allTime.averageTicketCents === null ? 'no data' : dollars(d.allTime.averageTicketCents)
         }</p>
         <ul class="rows">${d.yearly
           .map(
             (y) =>
               `<li><span class="label">${y.year}</span><span class="value">${dollars(y.grossCents)} · ${fmtCount(y.paymentCount)} sales</span></li>`,
           )
           .join('')}</ul>`,
      ),
    );

    /* Forecast */
    if (d.forecast.available) {
      const f = d.forecast;
      const monthRows = f.monthly
        .map(
          (m) =>
            `<li><span class="label">${escapeHtml(fmtMonth(m.month))}</span><span class="value">${dollars(m.forecastCents)} <small>(${m.weeks} wk${m.weeks === 1 ? '' : 's'})</small></span></li>`,
        )
        .join('');
      const totalForecast = f.weekly.reduce((a, w) => a + w.forecastCents, 0);
      const backtestRows = f.backtest.weeks
        .map(
          (w) =>
            `<tr><td>${escapeHtml(fmtDate(w.weekEnding))}</td><td>${dollars(w.actualCents)}</td><td>${dollars(w.forecastCents)}</td><td>${
              w.errorPct === null ? '—' : `${w.errorPct.toFixed(1)}%`
            }</td></tr>`,
        )
        .join('');
      cards.push(
        card(
          'Rest-of-year forecast',
          `<p class="big">${dollars(totalForecast)}</p>
           <p class="sub">expected sales from next week through year end</p>
           <ul class="rows">${monthRows}</ul>
           <details><summary>How this number is made (and how wrong it usually is)</summary>
             <p class="note">${escapeHtml(f.method)} Recent trend factor: ${f.growthFactorPct.toFixed(1)}% of the same weeks last year.</p>
             <p class="note">Typical miss over the last ${f.backtest.weeks.length} completed weeks: <strong>${
               f.backtest.mapePct === null ? 'not measurable' : `±${f.backtest.mapePct.toFixed(1)}%`
             }</strong>${f.backtest.zeroActualWeeks > 0 ? ` (${f.backtest.zeroActualWeeks} zero-sale weeks excluded)` : ''}.</p>
             <table><thead><tr><th>Week ending</th><th>Actual</th><th>Forecast</th><th>Miss</th></tr></thead><tbody>${backtestRows}</tbody></table>
           </details>`,
          'no AI — arithmetic on your own history',
        ),
      );
    } else {
      cards.push(
        card('Rest-of-year forecast', `<p class="empty">${escapeHtml(d.forecast.reason)}</p>`),
      );
    }

    cards.push(weeklyTrendCard(d.weeklyTrend));

    /* Day-of-week mix */
    cards.push(
      card(
        'Best days',
        bars(
          d.dayOfWeek.map((r) => ({
            label: r.weekday,
            valueCents: r.grossCents,
            note: `${r.paymentSharePct.toFixed(0)}% of sales`,
          })),
        ),
        'all time',
      ),
    );

    /* Top sellers */
    const itemRows = (items: { name: string; quantity: number; revenueCents: number }[]) =>
      items.length === 0
        ? '<p class="empty">No itemized sales in this window.</p>'
        : `<table><thead><tr><th>Item</th><th>Sold</th><th>Revenue</th></tr></thead><tbody>${items
            .map(
              (i) =>
                `<tr><td>${escapeHtml(i.name)}</td><td>${fmtCount(Math.round(i.quantity))}</td><td>${dollars(i.revenueCents)}</td></tr>`,
            )
            .join('')}</tbody></table>`;
    cards.push(card('Top sellers', itemRows(d.topItems12mo), 'last 12 months'));
    cards.push(
      card(
        'Top categories',
        d.topCategories12mo.length === 0
          ? '<p class="empty">No itemized sales in this window.</p>'
          : `<ul class="rows">${d.topCategories12mo
              .map(
                (c) =>
                  `<li><span class="label">${escapeHtml(c.name)}</span><span class="value">${dollars(c.revenueCents)}</span></li>`,
              )
              .join('')}</ul>`,
        'last 12 months',
      ),
    );

    /* Customers */
    const cu = d.customers;
    cards.push(
      card(
        'Customers',
        cu.available
          ? `<p class="big">${fmtCount(cu.total)}</p>
             <ul class="rows">
               <li><span class="label">With an email address</span><span class="value">${fmtCount(cu.withEmail)}${cu.emailPct === null ? '' : ` (${cu.emailPct.toFixed(1)}%)`}</span></li>
               <li><span class="label">With a phone number</span><span class="value">${fmtCount(cu.withPhone)}</span></li>
               <li><span class="label">Repeat buyers (of known buyers)</span><span class="value">${cu.repeatRatePct === null ? 'no data' : `${cu.repeatRatePct.toFixed(1)}%`}</span></li>
               <li><span class="label">Sales tied to a known customer</span><span class="value">${cu.identifiedPaymentPct === null ? 'no data' : `${cu.identifiedPaymentPct.toFixed(1)}%`}</span></li>
             </ul>
             ${cu.emailPct !== null && cu.emailPct < 20 ? '<p class="note">Only a small slice of customers have an email on file — growing this is the single biggest marketing opportunity.</p>' : ''}`
          : '<p class="empty">Customer records have not been imported yet.</p>',
      ),
    );

    /* Refunds & fees */
    cards.push(
      card(
        'Refunds & card fees',
        `<ul class="rows">
           <li><span class="label">Refunds, last 12 months</span><span class="value">${fmtCount(d.refunds.last12moCount)} · ${dollars(d.refunds.last12moCents)}</span></li>
           <li><span class="label">Refunds, all time</span><span class="value">${fmtCount(d.refunds.allTimeCount)} · ${dollars(d.refunds.allTimeCents)}</span></li>
           <li><span class="label">Processing fees, all time</span><span class="value">${dollars(d.fees.totalCents)}${
             d.fees.effectiveBps === null ? '' : ` (${(d.fees.effectiveBps / 100).toFixed(2)}% of sales)`
           }</span></li>
         </ul>
         ${
           d.fees.paymentsWithFeeData < d.fees.paymentsTotal
             ? `<p class="note">Fee data exists on ${fmtCount(d.fees.paymentsWithFeeData)} of ${fmtCount(d.fees.paymentsTotal)} payments; the fee total covers only those.</p>`
             : ''
         }`,
      ),
    );

    /* Inventory */
    cards.push(
      card(
        'Inventory',
        d.inventory.available
          ? `<p class="big">${fmtCount(d.inventory.unitsOnHand)}</p>
             <p class="sub">units on hand across ${fmtCount(d.inventory.trackedItems)} counted items${
               d.inventory.oversoldItems > 0 ? ` · <strong>${fmtCount(d.inventory.oversoldItems)} oversold</strong>` : ''
             }</p>`
          : `<p class="big muted">not yet counted</p>
             <p class="sub">Stock counting has not started. Nothing is estimated —
             this panel fills in when the first real count happens.</p>`,
      ),
    );

    /* Outreach — ships cold, honestly */
    cards.push(
      card(
        'Email outreach',
        `<p class="big muted">off</p>
         <p class="sub">No mailbox is connected and nothing sends. This stays off
         until it is deliberately set up and armed.</p>`,
        'not configured',
      ),
    );

    /* Data & imports */
    const li = d.imports.lastRun;
    cards.push(
      card(
        'Data & imports',
        li
          ? `<ul class="rows">
               <li><span class="label">Last import</span><span class="value">${escapeHtml(li.finishedAt.slice(0, 16).replace('T', ' '))} UTC</span></li>
               <li><span class="label">Source</span><span class="value">${escapeHtml(li.source)}</span></li>
               <li><span class="label">Rows added</span><span class="value">${fmtCount(li.paymentsInserted)} payments · ${fmtCount(li.linesInserted)} lines · ${fmtCount(li.refundsInserted)} refunds</span></li>
               <li><span class="label">Total sales after import</span><span class="value">${dollars(li.completedGrossCentsAfter)}</span></li>
               <li><span class="label">Import runs recorded</span><span class="value">${fmtCount(d.imports.runCount)}</span></li>
             </ul>`
          : '<p class="empty">No import has been recorded yet.</p>',
      ),
    );
  }

  const asOf = d.dataAsOfLocalDate
    ? `Data as of ${fmtDate(d.dataAsOfLocalDate)} · records start ${d.dataFirstLocalDate ? fmtDate(d.dataFirstLocalDate) : '—'} · days are Eastern Time`
    : 'No data imported yet';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(d.tenantName)} — Owner Dashboard</title>
<style>
  :root{--bg:#f6f7f9;--card:#ffffff;--ink:#111318;--muted:#6b7280;--line:#e5e7eb;--accent:#111318;--up:#166534;--down:#b91c1c}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:32px 24px}
  .wrap{max-width:1200px;margin:0 auto}
  .masthead{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:24px;border-bottom:1px solid var(--line);padding-bottom:16px}
  .masthead h1{font-size:24px;font-weight:650;letter-spacing:-.01em}
  .masthead .range{color:var(--muted);font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;box-shadow:0 1px 2px rgba(17,19,24,.04)}
  .card header{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:12px}
  .card h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .kicker{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:2px 8px;white-space:nowrap}
  .big{font-size:34px;font-weight:700;letter-spacing:-.02em}
  .big.muted{color:var(--muted);font-size:26px}
  .sub{color:var(--muted);font-size:14px;margin-bottom:10px}
  .up{color:var(--up);font-weight:600}
  .down{color:var(--down);font-weight:600}
  .rows,.bars{list-style:none;font-size:14px}
  .rows li{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-top:1px solid var(--line)}
  .bars li{display:grid;grid-template-columns:minmax(96px,1fr) 2fr auto;align-items:center;gap:10px;padding:5px 0}
  .bar{height:9px;background:var(--line);border-radius:99px;overflow:hidden}
  .bar i{display:block;height:100%;background:var(--accent);border-radius:99px}
  .label{color:var(--ink)}
  .value{color:var(--muted);font-variant-numeric:tabular-nums;text-align:right}
  .value small,.sub small{color:var(--muted);font-size:11px}
  .empty,.note{color:var(--muted);font-size:14px}
  .note{margin-top:10px}
  details{margin-top:10px;font-size:13px}
  summary{cursor:pointer;color:var(--muted)}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
  th{text-align:left;color:var(--muted);font-weight:500;padding:4px 8px 4px 0;border-bottom:1px solid var(--line)}
  td{padding:6px 8px 6px 0;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
  @media (max-width:640px){body{padding:16px}.big{font-size:28px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="masthead">
    <h1>${escapeHtml(d.tenantName)} — Owner Dashboard</h1>
    <span class="range">${escapeHtml(asOf)}</span>
  </div>
  <div class="grid">
${cards.join('\n')}
  </div>
</div>
</body>
</html>`;
}
