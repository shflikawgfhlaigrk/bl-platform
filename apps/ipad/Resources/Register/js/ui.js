/** Reusable view building blocks (plain DOM). Keeps every screen consistent. */
import { el, clear } from './dom.js';
import { navigate } from './router.js';
import { hashFor } from '../../src/routes.mjs';
import { escapeHtml, formatDate, dataAsOf } from '../../src/format.mjs';

/** Standard screen header: one H1, a subtitle, and a row of actions. */
export function viewHeader({ title, subtitle, actions = [] }) {
  return el('div', { class: 'view-header' }, [
    el('div', { class: 'titles' }, [
      el('h1', {}, title),
      subtitle ? el('p', { class: 'view-sub' }, subtitle) : null,
    ]),
    actions.length ? el('div', { class: 'view-actions' }, actions) : null,
  ]);
}

export function button(label, { onClick, primary, danger, big, href, disabled, title } = {}) {
  const cls = ['btn', primary && 'btn-primary', danger && 'btn-danger', big && 'btn-big']
    .filter(Boolean)
    .join(' ');
  return el('button', {
    class: cls,
    type: 'button',
    disabled: disabled || false,
    title: title || null,
    onclick: (e) => {
      e.preventDefault();
      if (href) return navigate(href);
      if (onClick) onClick(e);
    },
    text: label,
  });
}

/** A metric tile: definition (info affordance), value, source/as-of, click-through. */
export function metricTile({ label, value, foot, definition, href, source }) {
  const info = definition
    ? el('span', { class: 'info-dot', role: 'img', 'aria-label': `Definition: ${definition}`, title: definition }, 'i')
    : null;
  const inner = [
    el('div', { class: 'tile-label' }, [label, info]),
    el('div', { class: 'tile-value' }, value),
    el('div', { class: 'tile-foot' }, foot || (source ? `Source: ${source}` : '')),
  ];
  if (href) {
    return el('a', { class: 'card tile', href, 'aria-label': `${label}: ${value}. Open detail.` }, inner);
  }
  return el('div', { class: 'card tile' }, inner);
}

/**
 * Empty/setup state — NEVER a blank screen. Says exactly what to do next.
 * setup: optional array of { label, done, hint } checklist items.
 */
export function emptyState({ icon = '📭', title, message, actions = [], setup = null }) {
  const kids = [
    el('div', { class: 'empty-icon', 'aria-hidden': 'true' }, icon),
    el('h2', {}, title),
    message ? el('p', {}, message) : null,
  ];
  if (setup && setup.length) {
    kids.push(
      el(
        'ul',
        { class: 'setup-list' },
        setup.map((s) =>
          el('li', {}, [
            el('span', { class: `status ${s.done ? 'done' : 'todo'}` }, s.done ? '✓' : '○'),
            el('span', {}, [el('strong', {}, s.label), s.hint ? el('div', { class: 'hint' }, s.hint) : null]),
          ]),
        ),
      ),
    );
  }
  if (actions.length) kids.push(el('div', { class: 'view-actions', style: 'justify-content:center;margin-top:16px' }, actions));
  return el('div', { class: 'empty' }, kids);
}

/**
 * A blocked-action banner surfacing the server's OWN reason verbatim, phrased
 * for a human. `missing` may be a string or list of what's needed.
 */
export function blockedBanner(reason, missing) {
  const kids = [el('strong', {}, 'Not ready yet. '), el('span', {}, reason || 'A required step is missing.')];
  if (Array.isArray(missing) && missing.length) {
    kids.push(el('ul', { style: 'margin:6px 0 0 18px' }, missing.map((m) => el('li', {}, m))));
  }
  return el('div', { class: 'blocked', role: 'note' }, kids);
}

export function errorBanner(message) {
  return el('div', { class: 'error-banner', role: 'alert' }, message);
}

/** A data table. columns: [{ key, label, num, render(row) }]. */
export function dataTable(columns, rows, { emptyMessage = 'Nothing here yet.' } = {}) {
  if (!rows || rows.length === 0) {
    return el('div', { class: 'card' }, el('p', { class: 'view-sub', style: 'margin:0' }, emptyMessage));
  }
  const thead = el(
    'thead',
    {},
    el(
      'tr',
      {},
      columns.map((c) => el('th', { class: c.num ? 'num' : null, scope: 'col' }, c.label)),
    ),
  );
  const tbody = el(
    'tbody',
    {},
    rows.map((row) =>
      el(
        'tr',
        {},
        columns.map((c) => {
          const val = c.render ? c.render(row) : row[c.key];
          const cell = el('td', { class: c.num ? 'num' : null });
          if (val && val.nodeType) cell.append(val);
          else cell.textContent = val === null || val === undefined ? '' : String(val);
          return cell;
        }),
      ),
    ),
  );
  return el('div', { class: 'table-wrap' }, el('table', { class: 'data' }, [thead, tbody]));
}

/** Priority chip. */
export function chip(text, variant) {
  return el('span', { class: `chip ${variant ? `chip-${variant}` : ''}` }, text);
}

/** Expandable evidence / formula-trace block. */
export function expandable(summaryText, contentNode) {
  return el('details', { class: 'expandable' }, [el('summary', {}, summaryText), contentNode]);
}

/** Definition list from an object of { label: value }. */
export function detailList(pairs) {
  const dl = el('dl', { class: 'detail-list' });
  for (const [k, v] of Object.entries(pairs)) {
    dl.append(el('dt', {}, k));
    const dd = el('dd', {});
    if (v && v.nodeType) dd.append(v);
    else dd.textContent = v === null || v === undefined || v === '' ? '—' : String(v);
    dl.append(dd);
  }
  return dl;
}

/** A labeled form field wrapper. */
export function field(label, control, hint) {
  const id = control.id || `f_${Math.random().toString(36).slice(2)}`;
  control.id = id;
  return el('div', { class: 'field' }, [
    el('label', { for: id }, label),
    hint ? el('div', { class: 'hint' }, hint) : null,
    control,
  ]);
}

export function input({ name, type = 'text', value = '', placeholder = '', required = false, min } = {}) {
  return el('input', { name, type, value, placeholder, required: required || false, min: min ?? null, autocomplete: 'off' });
}

export function select(name, options, value) {
  return el(
    'select',
    { name },
    options.map((o) =>
      el('option', { value: o.value, selected: o.value === value ? true : null }, o.label),
    ),
  );
}

/** A large qty stepper (default 1). onChange(qty). */
export function qtyStepper(initial = 1, onChange) {
  let qty = initial;
  const inp = el('input', { type: 'number', min: '1', value: String(qty), 'aria-label': 'Quantity', inputmode: 'numeric' });
  const set = (n) => {
    qty = Math.max(1, n | 0);
    inp.value = String(qty);
    if (onChange) onChange(qty);
  };
  inp.addEventListener('change', () => set(Number(inp.value) || 1));
  const wrap = el('div', { class: 'qty-stepper' }, [
    el('button', { class: 'btn', type: 'button', 'aria-label': 'Decrease quantity', onclick: () => set(qty - 1) }, '−'),
    inp,
    el('button', { class: 'btn', type: 'button', 'aria-label': 'Increase quantity', onclick: () => set(qty + 1) }, '+'),
  ]);
  wrap.getQty = () => qty;
  return wrap;
}

/** Section wrapper with a heading. */
export function section(title, ...nodes) {
  return el('section', { class: 'card', style: 'margin-bottom:16px' }, [
    title ? el('h2', {}, title) : null,
    ...nodes,
  ]);
}

/** Data-as-of stamp line for a screen. */
export function asOfLine(iso) {
  return el('p', { class: 'view-sub' }, dataAsOf(iso));
}

/** Render a loader with a spinner placeholder, replacing on resolve/reject. */
export async function withLoading(container, loader) {
  clear(container);
  container.append(el('div', { class: 'loading' }, 'Loading…'));
  try {
    const node = await loader();
    clear(container);
    if (node) container.append(node);
  } catch (err) {
    clear(container);
    container.append(errorBanner((err && err.message) || 'Could not load.'));
  }
}

export { hashFor, escapeHtml, formatDate };
