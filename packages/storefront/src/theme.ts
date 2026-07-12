import { contrastRatio } from './contrast';

/**
 * The storefront palette — the SINGLE source of truth for color. The a11y
 * contrast gate iterates PALETTE_PAIRS and fails the build if any pair is below
 * WCAG AA 4.5:1, so the CSS below can only ship colors that actually pass.
 */

export const AA_MIN = 4.5;

/** Light theme tokens. */
export const LIGHT = {
  bg: '#faf6ef',
  surface: '#ffffff',
  text: '#241d18',
  muted: '#57493d',
  link: '#6b4a2b',
  onPrimary: '#ffffff',
  primary: '#6b4a2b',
  inStockFg: '#173a17',
  inStockBg: '#dcefdc',
  lowFg: '#5a3d07',
  lowBg: '#f6ebcf',
  outFg: '#5a1717',
  outBg: '#f3dcdc',
} as const;

/** Dark theme tokens. */
export const DARK = {
  bg: '#17120d',
  surface: '#211a13',
  text: '#f3ede2',
  muted: '#c6b8a6',
  link: '#e0ad50',
  onPrimary: '#17120d',
  primary: '#e0ad50',
  inStockFg: '#bfe6bf',
  inStockBg: '#1c3320',
  lowFg: '#f0d69a',
  lowBg: '#3a2f16',
  outFg: '#f0c4c4',
  outBg: '#3a1e1e',
} as const;

export interface PalettePair {
  name: string;
  fg: string;
  bg: string;
}

/** Every foreground/background pair that renders text-sized content. */
export const PALETTE_PAIRS: PalettePair[] = [
  { name: 'light/body', fg: LIGHT.text, bg: LIGHT.bg },
  { name: 'light/body-surface', fg: LIGHT.text, bg: LIGHT.surface },
  { name: 'light/muted', fg: LIGHT.muted, bg: LIGHT.bg },
  { name: 'light/muted-surface', fg: LIGHT.muted, bg: LIGHT.surface },
  { name: 'light/link', fg: LIGHT.link, bg: LIGHT.bg },
  { name: 'light/link-surface', fg: LIGHT.link, bg: LIGHT.surface },
  { name: 'light/primary-button', fg: LIGHT.onPrimary, bg: LIGHT.primary },
  { name: 'light/badge-in', fg: LIGHT.inStockFg, bg: LIGHT.inStockBg },
  { name: 'light/badge-low', fg: LIGHT.lowFg, bg: LIGHT.lowBg },
  { name: 'light/badge-out', fg: LIGHT.outFg, bg: LIGHT.outBg },
  { name: 'dark/body', fg: DARK.text, bg: DARK.bg },
  { name: 'dark/body-surface', fg: DARK.text, bg: DARK.surface },
  { name: 'dark/muted', fg: DARK.muted, bg: DARK.bg },
  { name: 'dark/muted-surface', fg: DARK.muted, bg: DARK.surface },
  { name: 'dark/link', fg: DARK.link, bg: DARK.bg },
  { name: 'dark/link-surface', fg: DARK.link, bg: DARK.surface },
  { name: 'dark/primary-button', fg: DARK.onPrimary, bg: DARK.primary },
  { name: 'dark/badge-in', fg: DARK.inStockFg, bg: DARK.inStockBg },
  { name: 'dark/badge-low', fg: DARK.lowFg, bg: DARK.lowBg },
  { name: 'dark/badge-out', fg: DARK.outFg, bg: DARK.outBg },
];

export interface ContrastCheck extends PalettePair {
  ratio: number;
  pass: boolean;
}

/** Compute the contrast ratio for every palette pair (used by the a11y gate). */
export function checkPalette(pairs: PalettePair[] = PALETTE_PAIRS): ContrastCheck[] {
  return pairs.map((p) => {
    const ratio = contrastRatio(p.fg, p.bg);
    return { ...p, ratio, pass: ratio >= AA_MIN };
  });
}

/**
 * The complete stylesheet — hand-built, no frameworks/CDNs/webfonts. System
 * font stack, mobile-first, light + dark via prefers-color-scheme, visible
 * focus, reduced-motion honored. Must stay < 50KB (asserted by a gate/test).
 */
export function buildCss(): string {
  const vars = (t: Record<string, string>) => `
  --bg:${t.bg};--surface:${t.surface};--text:${t.text};--muted:${t.muted};
  --link:${t.link};--primary:${t.primary};--on-primary:${t.onPrimary};
  --in-fg:${t.inStockFg};--in-bg:${t.inStockBg};--low-fg:${t.lowFg};--low-bg:${t.lowBg};
  --out-fg:${t.outFg};--out-bg:${t.outBg};`;
  return `
:root{${vars(LIGHT)}
  --maxw:64rem;--radius:10px;--gap:1rem;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
:root[data-theme="dark"]{${vars(DARK)}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${vars(DARK)}}}
*{box-sizing:border-box}
html{font-family:var(--font);font-size:17px;line-height:1.5;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text)}
img{max-width:100%;height:auto;display:block}
a{color:var(--link);text-decoration:underline;text-underline-offset:2px}
a:hover{text-decoration:none}
h1,h2,h3{line-height:1.2;margin:0 0 .5em;font-weight:700;letter-spacing:-.01em}
h1{font-size:1.8rem}h2{font-size:1.35rem}h3{font-size:1.05rem}
p{margin:0 0 1em}
:focus-visible{outline:3px solid var(--primary);outline-offset:2px;border-radius:3px}
.skip-link{position:absolute;left:-999px;top:0;background:var(--primary);color:var(--on-primary);
  padding:.6rem 1rem;z-index:100;text-decoration:none}
.skip-link:focus{left:.5rem;top:.5rem}
.wrap{max-width:var(--maxw);margin:0 auto;padding:0 1rem}
header.site{border-bottom:1px solid var(--muted);background:var(--surface)}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-top:.8rem;padding-bottom:.8rem;flex-wrap:wrap}
.brand{font-size:1.3rem;font-weight:800;color:var(--text);text-decoration:none;letter-spacing:.02em}
.brand small{display:block;font-size:.62rem;font-weight:600;color:var(--muted);letter-spacing:.18em;text-transform:uppercase}
nav.primary ul{list-style:none;display:flex;gap:1rem;margin:0;padding:0;flex-wrap:wrap}
nav.primary a{color:var(--text)}
.searchbar{display:flex;gap:.5rem;flex:1 1 14rem;min-width:12rem}
.searchbar input{flex:1;padding:.55rem .7rem;border:1px solid var(--muted);border-radius:var(--radius);
  background:var(--surface);color:var(--text);font-size:1rem}
.btn{display:inline-block;background:var(--primary);color:var(--on-primary);border:0;border-radius:var(--radius);
  padding:.6rem 1rem;font-size:1rem;font-weight:600;cursor:pointer;text-decoration:none}
.btn:hover{filter:brightness(1.06)}
.btn.secondary{background:var(--surface);color:var(--text);border:1px solid var(--muted)}
main{padding:1.5rem 0 3rem;min-height:60vh}
.hero{background:var(--surface);border:1px solid var(--muted);border-radius:var(--radius);padding:1.5rem;margin-bottom:1.5rem}
.muted{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(9rem,1fr));gap:var(--gap)}
.card{background:var(--surface);border:1px solid var(--muted);border-radius:var(--radius);overflow:hidden;display:flex;flex-direction:column}
.card a.body{padding:.7rem;color:var(--text);text-decoration:none;display:block}
.card .t{font-weight:600;font-size:.92rem}
.card .price{color:var(--muted);font-size:.86rem;margin-top:.25rem}
.imgbox{aspect-ratio:1/1;background:var(--bg);display:flex;align-items:center;justify-content:center;overflow:hidden}
.imgbox .ph{color:var(--muted);font-size:.8rem;padding:.5rem;text-align:center}
.badge{display:inline-block;font-size:.72rem;font-weight:700;padding:.15rem .5rem;border-radius:999px;text-transform:uppercase;letter-spacing:.03em}
.badge.in{color:var(--in-fg);background:var(--in-bg)}
.badge.low{color:var(--low-fg);background:var(--low-bg)}
.badge.out{color:var(--out-fg);background:var(--out-bg)}
table.variations{width:100%;border-collapse:collapse;margin:1rem 0}
table.variations caption{text-align:left;font-weight:700;margin-bottom:.4rem}
table.variations th,table.variations td{text-align:left;padding:.5rem;border-bottom:1px solid var(--muted)}
.deptgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(11rem,1fr));gap:var(--gap)}
.deptgrid a{display:block;background:var(--surface);border:1px solid var(--muted);border-radius:var(--radius);
  padding:1rem;color:var(--text);text-decoration:none;font-weight:600}
.pager{display:flex;gap:.5rem;align-items:center;margin:1.5rem 0;flex-wrap:wrap}
.item-layout{display:grid;grid-template-columns:1fr;gap:1.5rem}
@media(min-width:48rem){.item-layout{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.gallery{display:flex;flex-direction:column;gap:.6rem}
.crumbs{font-size:.85rem;margin-bottom:1rem}
.crumbs a{color:var(--muted)}
label{display:block;font-weight:600;margin:.8rem 0 .3rem}
input,select,textarea{font:inherit}
.field{width:100%;padding:.55rem .7rem;border:1px solid var(--muted);border-radius:var(--radius);background:var(--surface);color:var(--text)}
.note{background:var(--surface);border:1px solid var(--muted);border-left:4px solid var(--primary);border-radius:var(--radius);padding:1rem;margin:1rem 0}
footer.site{border-top:1px solid var(--muted);background:var(--surface);padding:2rem 0;margin-top:2rem;color:var(--muted);font-size:.85rem}
footer.site a{color:var(--link)}
#search-results{list-style:none;margin:1rem 0;padding:0}
#search-results li{border-bottom:1px solid var(--muted)}
#search-results a{display:block;padding:.6rem 0;color:var(--text);text-decoration:none}
#search-results a:hover .t{text-decoration:underline}
.cart-line{display:flex;justify-content:space-between;gap:1rem;padding:.6rem 0;border-bottom:1px solid var(--muted)}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`.trim();
}
