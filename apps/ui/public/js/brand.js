/** Bar One visual identity. Merchant/account identities remain server-owned. */
import { el } from './dom.js';

export function clubBrand(className = '') {
  return el('div', { class: `club-lockup ${className}` }, [
    el('img', { src: './brand/one-club-logo.png', class: 'club-crest', alt: '', width: 64, height: 64 }),
    el('div', { class: 'club-wordmark' }, [
      el('strong', {}, 'BAR ONE'),
      el('span', {}, 'GULF SHORES'),
    ]),
  ]);
}

const paths = {
  bar: 'M4 4h16l-8 9z M12 13v7 M7 20h10',
  actions: 'M4 11 12 4l8 7v9h-6v-6h-4v6H4z',
  register: 'M4 5h16v14H4z M4 10h16 M7 15h4',
  scan: 'M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M8 8v8m4-8v8m4-8v8',
  stock: 'm3 7 9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10',
  counts: 'M9 4H5v17h14V4h-4 M9 3h6v4H9z M8 12h8m-8 4h6',
  transfers: 'M4 7h16m-4-4 4 4-4 4 M20 17H4m4-4-4 4 4 4',
  shows: 'M4 5h16v16H4z M8 3v4m8-4v4M4 10h16 M8 14h2m4 0h2',
  orders: 'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6m-6 4h6',
  buying: 'M3 4h3l2 12h10l3-8H7 M9 20h1m7 0h1',
  customers: 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M5 21v-3a7 7 0 0 1 14 0v3',
  marketing: 'M3 6h18v13H3z m0 0 9 7 9-7',
  money: 'M4 20V10h4v10m4 0V4h4v16m4 0v-6',
  team: 'M10 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M2 21v-4a5 5 0 0 1 10 0v4 M16 4a3 3 0 0 1 0 6m1 3a5 5 0 0 1 5 5v3',
  imports: 'M12 3v12m-5-5 5 5 5-5 M4 16v5h16v-5',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
};

export function navSymbol(route) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '22', height: '22', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'nav-symbol' })) svg.setAttribute(name, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[route] || paths.register);
  svg.append(path);
  return svg;
}
