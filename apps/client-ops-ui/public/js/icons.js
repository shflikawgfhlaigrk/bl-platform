const NS = 'http://www.w3.org/2000/svg';

const paths = {
  overview: ['<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'],
  products: ['<path d="m4 8 8-5 8 5-8 5-8-5Z"/><path d="m4 12 8 5 8-5M4 16l8 5 8-5"/>'],
  services: ['<circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M8.4 6h7.2M6 8.4v7.2M18 8.4v7.2M8.4 18h7.2"/>'],
  workflows: ['<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M18 8v3.5l-4.5 4.5M6 8v3.5l4.5 4.5"/>'],
  review: ['<path d="M4 5h16v14H4z"/><path d="m4 7 8 6 8-6M8 17h8"/>'],
  integrations: ['<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M19.1 4.9l-2.8 2.8M7.7 16.3l-2.8 2.8"/>'],
  artifacts: ['<path d="M5 4h11l3 3v13H5z"/><path d="M16 4v4h4M8 12h8M8 16h6"/>'],
  reports: ['<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'],
  setup: ['<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>'],
  menu: ['<path d="M4 6h16M4 12h16M4 18h16"/>'],
  collapse: ['<path d="m13 17-5-5 5-5M19 17l-5-5 5-5"/>'],
  close: ['<path d="m6 6 12 12M18 6 6 18"/>'],
  chevron: ['<path d="m9 18 6-6-6-6"/>'],
  refresh: ['<path d="M20 6v5h-5M4 18v-5h5"/><path d="M18.1 9A7 7 0 0 0 6.3 6.3L4 11M5.9 15a7 7 0 0 0 11.8 2.7L20 13"/>'],
  play: ['<path d="m8 5 11 7-11 7z"/>'],
  pause: ['<path d="M8 5v14M16 5v14"/>'],
  retry: ['<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'],
  check: ['<path d="m5 12 4 4L19 6"/>'],
  deny: ['<path d="M6 6l12 12M18 6 6 18"/>'],
  hold: ['<circle cx="12" cy="12" r="9"/><path d="M9 9v6M15 9v6"/>'],
  search: ['<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'],
  filter: ['<path d="M4 5h16l-6 7v6l-4 2v-8z"/>'],
  headset: ['<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><path d="M4 14h3v6H5a1 1 0 0 1-1-1v-5ZM20 14h-3v6h2a1 1 0 0 0 1-1v-5Z"/>'],
  sales: ['<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/><path d="m5 7 5-4 5 4 5-5"/>'],
  marketing: ['<path d="M3 11v4h4l8 4V7L7 11H3Z"/><path d="m17 9 3-2M17 17l3 2M7 15l1 5"/>'],
  support: ['<path d="M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v5H5a1 1 0 0 1-1-1v-4ZM20 14h-3v5h2a1 1 0 0 0 1-1v-4ZM17 19c0 2-2 3-5 3"/>'],
  building: ['<path d="M4 21V7l8-4 8 4v14M8 9h2M14 9h2M8 13h2M14 13h2M8 17h2M14 17h2M2 21h20"/>'],
  lock: ['<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>'],
  database: ['<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/>'],
  file: ['<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h5"/>'],
  external: ['<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v7H4V6h7"/>'],
  connector: ['<path d="M8 12h8M6 9v6M18 9v6"/><path d="M6 12H3v7h6v-3M18 12h3v7h-6v-3"/>'],
  clock: ['<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
  alert: ['<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5M12 17h.01"/>'],
  info: ['<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>'],
  empty: ['<path d="M4 7h16v12H4z"/><path d="M8 7V5h8v2M4 12h5l1.5 2h3L15 12h5"/>'],
  tooth: ['<path d="M12 4c-3-3-8-1-8 4 0 3 2 5 3 9 .5 2 1 4 2.5 4s1.5-5 2.5-5 1 5 2.5 5 2-2 2.5-4c1-4 3-6 3-9 0-5-5-7-8-4Z"/>'],
  home: ['<path d="m3 11 9-7 9 7M5 10v10h14V10M9 20v-6h6v6"/>'],
  tool: ['<path d="M14.7 6.3a5 5 0 0 0-6.5 6.5L3 18l3 3 5.2-5.2a5 5 0 0 0 6.5-6.5l-3 3-3-3 3-3Z"/>'],
  gavel: ['<path d="m14 5 5 5M12 7l5 5M4 20h10M13 4l-3 3 7 7 3-3-7-7ZM5 16l8-8"/>'],
  cart: ['<path d="M3 4h2l2 11h10l3-7H6M9 20h.01M17 20h.01"/>'],
  star: ['<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>'],
  receipt: ['<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6M9 16h4"/>'],
};

export function icon(name, options = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('class', `icon${options.className ? ` ${options.className}` : ''}`);
  if (options.label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', options.label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  svg.innerHTML = (paths[name] || paths.empty).join('');
  return svg;
}

export function hydrateIcons(root = document) {
  for (const slot of root.querySelectorAll('[data-icon]')) {
    slot.replaceChildren(icon(slot.dataset.icon));
  }
}
