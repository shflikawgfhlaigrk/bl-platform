/** Tiny DOM helpers — no framework. */
import { escapeHtml } from '../../src/format.mjs';

export { escapeHtml };

/** Create an element with attributes + children. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Announce a message to the assertive live region (screen readers). */
export function announce(message) {
  const region = $('#live-region');
  if (region) {
    region.textContent = '';
    // force re-announcement
    requestAnimationFrame(() => (region.textContent = message));
  }
}

/** Transient visual toast. kind: 'info' | 'err' | 'warn'. */
export function toast(message, kind = 'info', ms = 3200) {
  const root = $('#toast-root');
  if (!root) return;
  const t = el('div', { class: `toast ${kind === 'info' ? '' : kind}`, role: 'status' }, message);
  root.append(t);
  announce(message);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 250);
  }, ms);
}

/** Flash the whole screen green (ok) or red (err) for scan feedback. */
export function flash(kind) {
  const f = $('#scan-flash');
  if (!f) return;
  f.classList.remove('ok', 'err');
  // reflow so re-adding the class re-triggers the transition
  void f.offsetWidth;
  f.classList.add(kind);
  setTimeout(() => f.classList.remove(kind), 220);
}
