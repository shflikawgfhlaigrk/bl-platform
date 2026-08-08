import type { AvailabilityState } from './schema';
import { buildCss } from './theme';

/**
 * Deterministic server-rendered templates shared by the STATIC EXPORT and the
 * LIVE routes. Given the same ProjectionSite + config, `renderSite` returns
 * byte-identical output — there is no wall-clock in any page; the "data as of"
 * stamp comes from the publish run (`site.dataAsOf`).
 *
 * All pages are FLAT files at the export root (`item-<slug>.html`,
 * `department-<slug>.html`, …) so every internal link is a simple relative
 * filename that resolves both over file:// and under the live `/store/` base.
 */

/* ----------------------------- data model ------------------------------ */

export interface RenderVariation {
  id: string;
  sourceVariationId: string;
  name: string;
  sku: string | null;
  priceCents: number | null;
  state: AvailabilityState;
}

export interface RenderItem {
  id: string;
  sourceProductId: string;
  name: string;
  description: string | null;
  departmentSlug: string | null;
  departmentName: string | null;
  categoryName: string | null;
  brandSlug: string | null;
  brandName: string | null;
  slug: string;
  images: Array<{ path: string; alt: string }>;
  velocityRank: number;
  variations: RenderVariation[];
}

export interface RenderFacet {
  slug: string;
  name: string;
  itemCount: number;
}

export interface ProjectionSite {
  tenantId: string;
  dataAsOf: string;
  items: RenderItem[];
  departments: RenderFacet[];
  brands: RenderFacet[];
}

/** The shop's own public contact identity (renders in footer/about/checkout). */
export interface SiteContactConfig {
  phone?: string;
  email?: string;
  /** Instagram handle, no @. */
  instagram?: string;
  /** Facebook page path after facebook.com/. */
  facebook?: string;
  /** Public locality line, e.g. 'Newnan, Georgia'. Never a street address. */
  city?: string;
}

export interface SiteConfig {
  /** The storefront brand — NEVER another property's name. */
  brandName: string;
  tagline: string;
  /** Canonical URL base. Default '' = relative canonicals (same-origin, no external). */
  canonicalBase: string;
  pageSize: number;
  /** Configured low-stock language (no count). */
  lowStockLabel: string;
  /** 'static' export vs 'live' server — governs checkout/consent/restock copy. */
  mode: 'static' | 'live';
  featuredLimit: number;
  relatedLimit: number;
  /** Logo image basename under assets/ ('' = text-only brand). */
  logoFile: string;
  /**
   * Full-bleed homepage hero image basename under assets/ ('' = branded
   * gradient band, no photo). Rendered decorative (aria-hidden); the headline
   * is real text over it.
   */
  heroImage: string;
  /**
   * Announcement bar text. '' = bar hidden. POLICY: only client-confirmed
   * offers/notices go here — never an invented promotion.
   */
  announcement: string;
  /** Shop contact identity; empty object = no contact rendered. */
  contact: SiteContactConfig;
  /** Escaped-at-render about paragraphs (client story). */
  aboutParagraphs: string[];
  /** Number of brand links in the homepage brand row (by sales rank). 0 = hidden. */
  brandRowLimit: number;
  /**
   * Extra informational pages (shipping/returns/privacy/terms). POLICY: only
   * the client's own published policy text — never an invented policy.
   */
  infoPages: Array<{ slug: string; title: string; paragraphs: string[] }>;
  /**
   * Shipping/returns figures emitted as merchant-listing structured data on
   * item pages. POLICY: values must mirror the client's published policy
   * (infoPages) — never an invented rate or window. Omit to emit none.
   * Requires canonicalBase (Google needs absolute offer URLs).
   */
  merchantListing?: {
    /** ISO 3166-1 alpha-2 country the policy applies to, e.g. 'US'. */
    applicableCountry: string;
    currency: string;
    /** Order value (cents) strictly above which shipping is free ("over $100"). */
    freeShippingThresholdCents: number;
    /** Flat shipping rate (cents) below the threshold. */
    flatRateCents: number;
    /** Max handling time in days (order placed → handed to carrier). */
    handlingDaysMax: number;
    /** Return window in days from delivery. */
    returnDays: number;
  };
}

export const DEFAULT_CONFIG: SiteConfig = {
  brandName: 'Mags Tack',
  tagline: 'Mobile tack shop for the horse-show circuit',
  canonicalBase: '',
  pageSize: 24,
  lowStockLabel: 'Low stock',
  mode: 'static',
  featuredLimit: 12,
  relatedLimit: 6,
  logoFile: '',
  heroImage: '',
  announcement: '',
  contact: {},
  aboutParagraphs: [],
  brandRowLimit: 10,
  infoPages: [],
};

export interface RenderedPage {
  path: string;
  contentType: string;
  body: string;
  title: string;
  description: string;
  kind: string;
}

export interface RenderedSite {
  pages: RenderedPage[];
  byPath: Map<string, RenderedPage>;
  /** image basenames referenced by any item page (for the export image copier). */
  imageRefs: Set<string>;
  /** extra asset basenames referenced under assets/ (e.g. the logo) — the
   * export must copy these via extraAssets. */
  assetRefs: Set<string>;
  /** Hostname of canonicalBase ('' when canonicals are relative). Self-URL
   * references on this host are not external-resource loads. */
  selfHost: string;
}

/* ------------------------------- helpers ------------------------------- */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Price label for a set of variations. NULL prices are honestly "not listed". */
export function priceLabel(variations: RenderVariation[]): string {
  const prices = variations.map((v) => v.priceCents).filter((p): p is number => p != null);
  if (prices.length === 0) return 'Price not listed';
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? money(min) : `${money(min)} – ${money(max)}`;
}

/** Item-level availability = best variation state. `unknown` → no badge. */
export function itemState(item: RenderItem): AvailabilityState {
  const order: AvailabilityState[] = ['in_stock', 'low', 'out'];
  for (const s of order) if (item.variations.some((v) => v.state === s)) return s;
  return 'unknown';
}

export function availabilityBadge(state: AvailabilityState, lowLabel: string): string {
  switch (state) {
    case 'in_stock':
      return '<span class="badge in">In stock</span>';
    case 'low':
      return `<span class="badge low">${escapeHtml(lowLabel)}</span>`;
    case 'out':
      return '<span class="badge out">Out of stock</span>';
    case 'unknown':
    default:
      return ''; // honest: no badge, never a default "in stock", never a count
  }
}

function imageBasename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** Public extensionless route for a generated file. The host 308-redirects
 * `*.html` to the pretty route, so absolute canonicals/sitemap entries must
 * point at the pretty form or every indexed URL is a redirect. */
function publicPath(file: string): string {
  return file === 'index.html' ? '' : file.replace(/\.html$/, '');
}

/** Two-word brands render the second word in the accent color (logo style). */
function brandWordmark(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length !== 2) return escapeHtml(name);
  return `${escapeHtml(words[0])} <span class="accent">${escapeHtml(words[1])}</span>`;
}

/** Footer/about contact line from the configured shop identity. */
function contactLine(cfg: SiteConfig): string {
  const c = cfg.contact;
  const parts: string[] = [];
  if (c.phone) {
    const tel = c.phone.replace(/[^+\d]/g, '');
    parts.push(`<a href="tel:${escapeHtml(tel)}">${escapeHtml(c.phone)}</a>`);
  }
  if (c.email) parts.push(`<a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a>`);
  if (c.instagram) parts.push(`<a href="https://www.instagram.com/${escapeHtml(c.instagram)}" rel="noopener">Instagram</a>`);
  if (c.facebook) parts.push(`<a href="https://www.facebook.com/${escapeHtml(c.facebook)}" rel="noopener">Facebook</a>`);
  return parts.length ? `<p>${parts.join(' · ')}</p>` : '';
}

/* --------------------------- page chrome ------------------------------- */

interface LayoutInput {
  cfg: SiteConfig;
  site: ProjectionSite;
  title: string;
  description: string;
  canonicalFile: string;
  bodyHtml: string;
  jsonLd?: string;
  navDepartments: RenderFacet[];
}

function layout(i: LayoutInput): string {
  const { cfg, site, navDepartments } = i;
  const canonical = cfg.canonicalBase
    ? `${cfg.canonicalBase.replace(/\/$/, '')}/${publicPath(i.canonicalFile)}`
    : i.canonicalFile;
  const nav = navDepartments
    .map((d) => `<li><a href="department-${escapeHtml(d.slug)}.html">${escapeHtml(d.name)}</a></li>`)
    .join('');
  const jsonLd = i.jsonLd
    ? `\n<script type="application/ld+json">${i.jsonLd}</script>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(i.title)}</title>
<meta name="description" content="${escapeHtml(i.description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<link rel="stylesheet" href="assets/site.css">
${cfg.logoFile ? '<link rel="icon" type="image/png" href="assets/favicon.png">' : ''}${jsonLd}
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
${cfg.announcement ? `<p class="announce">${escapeHtml(cfg.announcement)}</p>` : ''}
<header class="site">
  <div class="wrap">
    <a class="brand" href="index.html">${cfg.logoFile ? `<img src="assets/${escapeHtml(cfg.logoFile)}" alt="" aria-hidden="true" width="42" height="42">` : ''}<span>${brandWordmark(cfg.brandName)}<small>${escapeHtml(cfg.tagline)}</small></span></a>
    <form class="searchbar" role="search" action="search.html" method="get">
      <label class="visually-hidden" for="q">Search products</label>
      <input id="q" name="q" type="search" placeholder="Search products" autocomplete="off">
      <button class="btn" type="submit">Search</button>
    </form>
    <nav class="primary" aria-label="Departments"><ul>${nav}<li><a href="cart.html">Cart</a></li></ul></nav>
  </div>
</header>
<main id="main" class="wrap" tabindex="-1">
${i.bodyHtml}
</main>
<footer class="site">
  <div class="wrap">
    <p>${escapeHtml(cfg.brandName)} — ${escapeHtml(cfg.tagline)}.${cfg.contact.city ? ` ${escapeHtml(cfg.contact.city)}.` : ''}</p>
    ${contactLine(cfg)}
    <p><a href="gift-cards.html">Gift cards</a> · <a href="order-status.html">Order status</a> · <a href="consent.html">Email updates</a> · <a href="about.html">About</a>${cfg.infoPages.map((ip) => ` · <a href="${escapeHtml(ip.slug)}.html">${escapeHtml(ip.title)}</a>`).join('')}</p>
    <p class="muted">Availability shown as in-stock / low / out only. Prices in USD. Data as of ${escapeHtml(site.dataAsOf)}.</p>
  </div>
  <script src="assets/app.js" defer></script>
</footer>
</body>
</html>`;
}

/* ------------------------- item card fragment -------------------------- */

function itemCard(item: RenderItem, cfg: SiteConfig): string {
  const badge = availabilityBadge(itemState(item), cfg.lowStockLabel);
  const img = item.images[0];
  const imgHtml = img
    ? `<img src="assets/img/${escapeHtml(imageBasename(img.path))}" alt="${escapeHtml(img.alt)}" loading="lazy" width="300" height="300">`
    : `<span class="ph">${escapeHtml(item.name)}</span>`;
  return `<li class="card">
  <a class="body" href="item-${escapeHtml(item.slug)}.html">
    <span class="imgbox">${imgHtml}</span>
    <span class="t">${escapeHtml(item.name)}</span>
    <span class="price">${escapeHtml(priceLabel(item.variations))}</span>
    ${badge}
  </a>
</li>`;
}

/* ------------------------------ ordering ------------------------------- */

function byVelocityThenSlug(a: RenderItem, b: RenderItem): number {
  if (a.velocityRank !== b.velocityRank) return a.velocityRank - b.velocityRank;
  if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out.length ? out : [[]];
}

/* ------------------------- search index -------------------------------- */

interface SearchEntry {
  s: string; // slug
  n: string; // name
  d: string; // department slug
  b: string; // brand slug
  p: string; // price label
}

export interface SearchIndexResult {
  files: Array<{ path: string; json: string }>;
  manifest: { sharded: boolean; shards: string[] };
}

const SEARCH_SHARD_THRESHOLD = 2 * 1024 * 1024; // 2MB

export function buildSearchIndex(items: RenderItem[]): SearchIndexResult {
  const entries: SearchEntry[] = items
    .slice()
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((it) => ({
      s: it.slug,
      n: it.name,
      d: it.departmentSlug ?? '',
      b: it.brandSlug ?? '',
      p: priceLabel(it.variations),
    }));

  const full = JSON.stringify(entries);
  if (full.length <= SEARCH_SHARD_THRESHOLD) {
    return {
      files: [{ path: 'search-index/all.json', json: full }],
      manifest: { sharded: false, shards: ['all'] },
    };
  }
  // Shard by first letter of slug (deterministic).
  const buckets = new Map<string, SearchEntry[]>();
  for (const e of entries) {
    const c = e.s.charAt(0);
    const key = /[a-z]/.test(c) ? c : /[0-9]/.test(c) ? '0' : '_';
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(e);
  }
  const shards = [...buckets.keys()].sort();
  return {
    files: shards.map((k) => ({ path: `search-index/${k}.json`, json: JSON.stringify(buckets.get(k)!) })),
    manifest: { sharded: true, shards },
  };
}

/* ------------------------------- app.js -------------------------------- */

function appJs(): string {
  // Cart via localStorage + keyboard-accessible client-side search. No external anything.
  return `"use strict";
var CART_KEY="magstack.cart.v1";
function cartGet(){try{return JSON.parse(localStorage.getItem(CART_KEY)||"[]")}catch(e){return[]}}
function cartSet(c){localStorage.setItem(CART_KEY,JSON.stringify(c))}
function cartCount(){return cartGet().reduce(function(n,l){return n+l.qty},0)}
function addToCart(vid,name,price){var c=cartGet();var f=c.filter(function(l){return l.vid===vid})[0];
 if(f){f.qty++}else{c.push({vid:vid,name:name,price:price,qty:1})}cartSet(c);renderCart();
 var s=document.getElementById("cart-status");if(s){s.textContent=name+" added to cart. "+cartCount()+" item(s) in cart."}}
function setQty(vid,qty){var c=cartGet().map(function(l){if(l.vid===vid)l.qty=Math.max(0,qty);return l}).filter(function(l){return l.qty>0});cartSet(c);renderCart()}
function money(c){var s=c<0?"-":"";c=Math.abs(c);return s+"$"+Math.floor(c/100)+"."+String(c%100).padStart(2,"0")}
function renderCart(){var el=document.getElementById("cart-lines");if(!el)return;var c=cartGet();
 if(!c.length){el.innerHTML='<p class="muted">Your cart is empty.</p>';var t=document.getElementById("cart-total");if(t)t.textContent="";return}
 var html="";var total=0;c.forEach(function(l){var line=(l.price!=null)?l.price*l.qty:null;if(line!=null)total+=line;
  html+='<div class="cart-line"><span>'+l.name+' × <label class="visually-hidden" for="q_'+l.vid+'">quantity</label>'
   +'<input id="q_'+l.vid+'" class="field" style="width:4rem;display:inline-block" type="number" min="0" value="'+l.qty+'" onchange="setQty(\\''+l.vid+'\\',parseInt(this.value||0))"></span>'
   +'<span>'+(l.price!=null?money(line):"Price not listed")+'</span></div>'});
 el.innerHTML=html;var t=document.getElementById("cart-total");if(t)t.textContent="Subtotal: "+money(total)}
function updateCartBadges(){var n=cartCount();document.querySelectorAll("[data-cart-count]").forEach(function(e){e.textContent=n})}
// search
function runSearch(entries,q){q=q.trim().toLowerCase();if(!q)return[];var pre=[],word=[],sub=[];
 entries.forEach(function(e){var n=e.n.toLowerCase();if(n.indexOf(q)===0)pre.push(e);
  else if(n.split(/[^a-z0-9]+/).indexOf(q)>=0)word.push(e);else if(n.indexOf(q)>=0)sub.push(e)});
 return pre.concat(word).concat(sub).slice(0,100)}
function initSearch(){var box=document.getElementById("search-page-input");if(!box)return;
 var params=new URLSearchParams(location.search);var q0=params.get("q")||"";box.value=q0;
 fetch("search-index/manifest.json").then(function(r){return r.json()}).then(function(m){
  return Promise.all(m.shards.map(function(k){return fetch("search-index/"+k+".json").then(function(r){return r.json()})}))
 }).then(function(parts){var all=[].concat.apply([],parts);
  function go(){var res=runSearch(all,box.value);var ul=document.getElementById("search-results");
   ul.innerHTML=res.map(function(e){return '<li><a href="item-'+e.s+'.html"><span class="t">'+e.n+'</span> <span class="muted">'+e.p+'</span></a></li>'}).join("");
   var st=document.getElementById("search-status");if(st)st.textContent=res.length+" result(s)"}
  box.addEventListener("input",go);if(q0)go()})}
document.addEventListener("DOMContentLoaded",function(){renderCart();updateCartBadges();initSearch()});
window.addToCart=addToCart;window.setQty=setQty;`;
}

/* ------------------------------ pages ---------------------------------- */

export function renderSite(site: ProjectionSite, config?: Partial<SiteConfig>): RenderedSite {
  const cfg: SiteConfig = { ...DEFAULT_CONFIG, ...config };
  const pages: RenderedPage[] = [];
  const imageRefs = new Set<string>();
  const navDepartments = site.departments.slice().sort((a, b) => (a.name < b.name ? -1 : 1));

  const bySlug = new Map(site.items.map((it) => [it.slug, it]));
  const add = (p: RenderedPage) => pages.push(p);

  const collectImages = (it: RenderItem) => {
    for (const im of it.images) imageRefs.add(imageBasename(im.path));
  };
  site.items.forEach(collectImages);

  /* Home — featured grid leads with photographed items so it never renders as a
     wall of gray placeholders; velocity order is preserved within each group. */
  const featured = site.items
    .slice()
    .sort((a, b) => {
      const ai = a.images.length ? 0 : 1;
      const bi = b.images.length ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return byVelocityThenSlug(a, b);
    })
    .slice(0, cfg.featuredLimit);
  const deptGrid = navDepartments
    .map((d) => `<a href="department-${escapeHtml(d.slug)}.html">${escapeHtml(d.name)} <span class="muted">(${d.itemCount})</span></a>`)
    .join('');
  // Brand row: brands ranked by their best-selling item (min velocity rank).
  const brandBest = new Map<string, number>();
  for (const it of site.items) {
    if (!it.brandSlug) continue;
    const cur = brandBest.get(it.brandSlug);
    if (cur === undefined || it.velocityRank < cur) brandBest.set(it.brandSlug, it.velocityRank);
  }
  const topBrands = site.brands
    .filter((b) => brandBest.has(b.slug))
    .sort((a, b) => (brandBest.get(a.slug)! - brandBest.get(b.slug)!) || (a.slug < b.slug ? -1 : 1))
    .slice(0, cfg.brandRowLimit);
  const brandRow = topBrands.length
    ? `<h2 id="brands">Shop by brand</h2>
<nav class="brandrow" aria-labelledby="brands">${topBrands.map((b) => `<a href="brand-${escapeHtml(b.slug)}.html">${escapeHtml(b.name)}</a>`).join('')}</nav>`
    : '';
  const c = cfg.contact;
  const trustStrip = `<div class="trust">
<div><strong>On the show circuit</strong>Find our trailer at horse shows across the region — follow along${c.instagram ? ` at <a href="https://www.instagram.com/${escapeHtml(c.instagram)}" rel="noopener">@${escapeHtml(c.instagram)}</a>` : ''}.</div>
<div><strong>Family-run</strong>A real tack shop${c.city ? ` from ${escapeHtml(c.city)}` : ''} — talk to people who ride.</div>
<div><strong>Ask us anything</strong>${c.phone ? `Call or text <a href="tel:${escapeHtml(c.phone.replace(/[^+\d]/g, ''))}">${escapeHtml(c.phone)}</a>` : 'Reach out'}${c.email ? ` or email <a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a>` : ''}.</div>
</div>`;
  const heroInner = `<div class="hero-inner"><p class="kicker">Tack · Apparel · Horse care</p><h1>${escapeHtml(cfg.tagline)}</h1><p>Durable tack and riding essentials built for horse and rider — from a family-run shop that comes to you.</p><p><a class="btn" href="#featured">Shop bestsellers</a> <a class="btn secondary" href="about.html">Our story</a></p></div>`;
  const heroBlock = cfg.heroImage
    ? `<section class="hero-photo" aria-label="${escapeHtml(cfg.brandName)}"><img class="hero-bg" src="assets/${escapeHtml(cfg.heroImage)}" alt="" aria-hidden="true" width="1600" height="720">${heroInner}</section>`
    : `<section class="hero-band" aria-label="${escapeHtml(cfg.brandName)}">${heroInner}</section>`;
  const homeBody = `${heroBlock}
${trustStrip}
${brandRow}
<h2>Departments</h2>
<nav class="deptgrid" aria-label="Shop by department">${deptGrid}</nav>
<h2 id="featured">Featured</h2>
<ul class="grid" aria-labelledby="featured">${featured.map((it) => itemCard(it, cfg)).join('')}</ul>`;
  add({
    path: 'index.html',
    contentType: 'text/html; charset=utf-8',
    kind: 'home',
    title: `${cfg.brandName} — ${cfg.tagline}`,
    description: `${cfg.brandName}: ${cfg.tagline}. Shop tack, apparel and horse care.`,
    body: layout({ cfg, site, navDepartments, title: `${cfg.brandName} — ${cfg.tagline}`, description: `${cfg.brandName}: ${cfg.tagline}.`, canonicalFile: 'index.html', bodyHtml: homeBody }),
  });

  /* Department pages (paginated) */
  for (const dept of navDepartments) {
    const deptItems = site.items.filter((it) => it.departmentSlug === dept.slug).sort(byVelocityThenSlug);
    const pagesOfItems = chunk(deptItems, cfg.pageSize);
    pagesOfItems.forEach((pageItems, idx) => {
      const pageNo = idx + 1;
      const file = pageNo === 1 ? `department-${dept.slug}.html` : `department-${dept.slug}-${pageNo}.html`;
      const prev = pageNo === 2 ? `department-${dept.slug}.html` : pageNo > 2 ? `department-${dept.slug}-${pageNo - 1}.html` : null;
      const next = pageNo < pagesOfItems.length ? `department-${dept.slug}-${pageNo + 1}.html` : null;
      const pager = `<nav class="pager" aria-label="Pagination">${prev ? `<a class="btn secondary" href="${prev}">Previous</a>` : ''}<span class="muted">Page ${pageNo} of ${pagesOfItems.length}</span>${next ? `<a class="btn secondary" href="${next}">Next</a>` : ''}</nav>`;
      const title = `${dept.name} — ${cfg.brandName}${pageNo > 1 ? ` (page ${pageNo})` : ''}`;
      const body = `<p class="crumbs"><a href="index.html">Home</a> / ${escapeHtml(dept.name)}</p>
<h1>${escapeHtml(dept.name)}</h1>
<p class="muted">${deptItems.length} item(s)</p>
<ul class="grid">${pageItems.map((it) => itemCard(it, cfg)).join('')}</ul>
${pager}`;
      add({
        path: file,
        contentType: 'text/html; charset=utf-8',
        kind: 'department',
        title,
        description: `Shop ${dept.name} at ${cfg.brandName}.`,
        body: layout({ cfg, site, navDepartments, title, description: `Shop ${dept.name} at ${cfg.brandName}.`, canonicalFile: file, bodyHtml: body }),
      });
    });
  }

  /* Brand facet pages */
  for (const brand of site.brands.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const brandItems = site.items.filter((it) => it.brandSlug === brand.slug).sort(byVelocityThenSlug);
    if (brandItems.length === 0) continue;
    const file = `brand-${brand.slug}.html`;
    const title = `${brand.name} — ${cfg.brandName}`;
    const body = `<p class="crumbs"><a href="index.html">Home</a> / Brands / ${escapeHtml(brand.name)}</p>
<h1>${escapeHtml(brand.name)}</h1>
<p class="muted">${brandItems.length} item(s)</p>
<ul class="grid">${brandItems.slice(0, cfg.pageSize).map((it) => itemCard(it, cfg)).join('')}</ul>`;
    add({ path: file, contentType: 'text/html; charset=utf-8', kind: 'brand', title, description: `${brand.name} products at ${cfg.brandName}.`, body: layout({ cfg, site, navDepartments, title, description: `${brand.name} products at ${cfg.brandName}.`, canonicalFile: file, bodyHtml: body }) });
  }

  /* Item pages */
  for (const item of site.items) {
    const file = `item-${item.slug}.html`;
    const gallery = item.images.length
      ? `<div class="gallery">${item.images.map((im) => `<span class="imgbox"><img src="assets/img/${escapeHtml(imageBasename(im.path))}" alt="${escapeHtml(im.alt)}" width="600" height="600"></span>`).join('')}</div>`
      : `<div class="imgbox"><span class="ph">No image available</span></div>`;
    // Note: SKUs are internal identifiers and are NEVER rendered publicly
    // (they leak internal codes and collide with phone-number detection).
    const rows = item.variations
      .map((v) => `<tr><td>${escapeHtml(v.name)}</td><td>${v.priceCents != null ? escapeHtml(money(v.priceCents)) : '<span class="muted">Price not listed</span>'}</td><td>${availabilityBadge(v.state, cfg.lowStockLabel) || '<span class="muted">—</span>'}</td><td>${v.state === 'out' ? '<span class="muted">Unavailable</span>' : `<button class="btn" type="button" onclick="addToCart('${escapeHtml(v.id)}','${escapeHtml(item.name)} ${escapeHtml(v.name)}',${v.priceCents != null ? v.priceCents : 'null'})">Add to cart</button>`}</td></tr>`)
      .join('');
    const related = site.items
      .filter((o) => o.id !== item.id && o.categoryName && o.categoryName === item.categoryName)
      .sort(byVelocityThenSlug)
      .slice(0, cfg.relatedLimit);
    const relatedHtml = related.length
      ? `<h2>Related items</h2><ul class="grid">${related.map((r) => itemCard(r, cfg)).join('')}</ul>`
      : '';
    const restock =
      cfg.mode === 'live'
        ? `<p><button class="btn secondary" type="button" onclick="document.getElementById('restock').hidden=!document.getElementById('restock').hidden">Request restock</button></p>
<form id="restock" hidden method="post" action="/store/api/restock-request"><label for="rvid">Variation</label><select id="rvid" name="variationId" class="field">${item.variations.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}</option>`).join('')}</select><label for="remail">Your email (optional)</label><input id="remail" class="field" type="email" name="email"><p><button class="btn" type="submit">Notify me</button></p></form>`
        : cfg.contact.email
          ? `<p class="muted">Looking for a size or color you don't see? Email <a href="mailto:${escapeHtml(cfg.contact.email)}">${escapeHtml(cfg.contact.email)}</a>${cfg.contact.phone ? ` or call/text <a href="tel:${escapeHtml(cfg.contact.phone.replace(/[^+\d]/g, ''))}">${escapeHtml(cfg.contact.phone)}</a>` : ''} — we restock often.</p>`
          : `<p class="muted">Looking for a size you don't see? Ask us at a show — we restock often.</p>`;
    const urlBase = cfg.canonicalBase ? cfg.canonicalBase.replace(/\/$/, '') : '';
    const itemUrl = urlBase ? `${urlBase}/${publicPath(file)}` : undefined;
    const ml = cfg.merchantListing;
    // Shipping/returns per offer — figures come from cfg.merchantListing which
    // mirrors the published policy page (never invented here). The rate is
    // price-dependent: free at/above the published threshold, flat below it.
    const offerExtras = (priceCents: number) => ({
      ...(itemUrl ? { url: itemUrl } : {}),
      ...(ml
        ? {
            shippingDetails: {
              '@type': 'OfferShippingDetails',
              shippingRate: {
                '@type': 'MonetaryAmount',
                value: (priceCents > ml.freeShippingThresholdCents ? 0 : ml.flatRateCents / 100).toFixed(2),
                currency: ml.currency,
              },
              shippingDestination: { '@type': 'DefinedRegion', addressCountry: ml.applicableCountry },
              deliveryTime: {
                '@type': 'ShippingDeliveryTime',
                handlingTime: { '@type': 'QuantitativeValue', minValue: 0, maxValue: ml.handlingDaysMax, unitCode: 'DAY' },
              },
            },
            hasMerchantReturnPolicy: {
              '@type': 'MerchantReturnPolicy',
              applicableCountry: ml.applicableCountry,
              returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
              merchantReturnDays: ml.returnDays,
              returnMethod: 'https://schema.org/ReturnByMail',
            },
          }
        : {}),
    });
    // Variations often share a price; identical (price, availability) pairs
    // collapse to one Offer so the markup lists distinct offers, not sizes.
    const seenOffers = new Set<string>();
    const offers = item.variations
      .filter((v) => v.priceCents != null)
      .map((v) => ({
        priceCents: v.priceCents!,
        availability:
          v.state === 'out'
            ? 'https://schema.org/OutOfStock'
            : v.state === 'unknown'
              ? 'https://schema.org/LimitedAvailability'
              : 'https://schema.org/InStock',
      }))
      .filter((o) => {
        const key = `${o.priceCents}|${o.availability}`;
        if (seenOffers.has(key)) return false;
        seenOffers.add(key);
        return true;
      })
      .map((o) => ({
        '@type': 'Offer',
        priceCurrency: 'USD',
        price: (o.priceCents / 100).toFixed(2),
        availability: o.availability,
        ...offerExtras(o.priceCents),
      }));
    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: item.name,
      ...(itemUrl ? { url: itemUrl } : {}),
      ...(urlBase && item.images.length
        ? { image: item.images.map((im) => `${urlBase}/assets/img/${imageBasename(im.path)}`) }
        : {}),
      ...(item.brandName ? { brand: { '@type': 'Brand', name: item.brandName } } : {}),
      ...(item.description ? { description: item.description } : {}),
      offers,
    });
    const body = `<p class="crumbs"><a href="index.html">Home</a>${item.departmentSlug ? ` / <a href="department-${escapeHtml(item.departmentSlug)}.html">${escapeHtml(item.departmentName ?? '')}</a>` : ''}${item.brandSlug ? ` / <a href="brand-${escapeHtml(item.brandSlug)}.html">${escapeHtml(item.brandName ?? '')}</a>` : ''}</p>
<div class="item-layout">
  <div>${gallery}</div>
  <div>
    <h1>${escapeHtml(item.name)}</h1>
    <p class="price"><strong>${escapeHtml(priceLabel(item.variations))}</strong> ${availabilityBadge(itemState(item), cfg.lowStockLabel)}</p>
    ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}
    <table class="variations"><caption>Options</caption><thead><tr><th scope="col">Option</th><th scope="col">Price</th><th scope="col">Availability</th><th scope="col"><span class="visually-hidden">Add to cart</span></th></tr></thead><tbody>${rows}</tbody></table>
    <p id="cart-status" role="status" aria-live="polite" class="muted"></p>
    ${restock}
  </div>
</div>
${relatedHtml}`;
    add({ path: file, contentType: 'text/html; charset=utf-8', kind: 'item', title: `${item.name} — ${cfg.brandName}`, description: item.description ? item.description.slice(0, 155) : `${item.name} at ${cfg.brandName}.`, body: layout({ cfg, site, navDepartments, title: `${item.name} — ${cfg.brandName}`, description: item.description ? item.description.slice(0, 155) : `${item.name} at ${cfg.brandName}.`, canonicalFile: file, bodyHtml: body, jsonLd }) });
  }

  /* Search page */
  const searchBody = `<h1>Search</h1>
<form role="search" onsubmit="return false"><label for="search-page-input">Search products</label><input id="search-page-input" class="field" type="search" autocomplete="off" aria-describedby="search-status"></form>
<p id="search-status" role="status" aria-live="polite" class="muted"></p>
<ul id="search-results"></ul>`;
  add({ path: 'search.html', contentType: 'text/html; charset=utf-8', kind: 'search', title: `Search — ${cfg.brandName}`, description: `Search ${cfg.brandName} products.`, body: layout({ cfg, site, navDepartments, title: `Search — ${cfg.brandName}`, description: `Search ${cfg.brandName} products.`, canonicalFile: 'search.html', bodyHtml: searchBody }) });

  /* Cart */
  const cartBody = `<h1>Your cart</h1>
<div id="cart-lines"></div>
<p id="cart-total" class="price"></p>
<p><a class="btn" href="checkout.html">Checkout</a> <a class="btn secondary" href="index.html">Keep shopping</a></p>`;
  add({ path: 'cart.html', contentType: 'text/html; charset=utf-8', kind: 'cart', title: `Cart — ${cfg.brandName}`, description: 'Your shopping cart.', body: layout({ cfg, site, navDepartments, title: `Cart — ${cfg.brandName}`, description: 'Your shopping cart.', canonicalFile: 'cart.html', bodyHtml: cartBody }) });

  /* Checkout */
  const checkoutBody =
    cfg.mode === 'live'
      ? `<h1>Checkout</h1>
<div id="cart-lines"></div><p id="cart-total" class="price"></p>
<form method="post" action="/store/api/orders" id="checkout-form">
  <label for="co-name">Name</label><input id="co-name" class="field" name="name" autocomplete="name">
  <label for="co-email">Email</label><input id="co-email" class="field" type="email" name="email" autocomplete="email">
  <fieldset><legend>Fulfillment</legend>
    <label><input type="radio" name="fulfillment" value="pickup" checked> Pickup at show</label>
    <label><input type="radio" name="fulfillment" value="ship"> Ship to me</label>
  </fieldset>
  <p><button class="btn" type="submit">Place order</button></p>
</form>
<p class="note">Live-local mode: this posts your order to the Mags OS server, which reserves stock. Hosted card payment is a separate, approval-gated step.</p>`
      : `<h1>Checkout</h1>
<div id="cart-lines"></div><p id="cart-total" class="price"></p>
<p class="note">Online card checkout is opening soon. Your cart is saved on this device — ${cfg.contact.email ? `email your list to <a href="mailto:${escapeHtml(cfg.contact.email)}">${escapeHtml(cfg.contact.email)}</a>${cfg.contact.phone ? ` or call/text <a href="tel:${escapeHtml(cfg.contact.phone.replace(/[^+\d]/g, ''))}">${escapeHtml(cfg.contact.phone)}</a>` : ''} and we'll get you taken care of, or ` : ''}find our trailer at a show near you.</p>`;
  add({ path: 'checkout.html', contentType: 'text/html; charset=utf-8', kind: 'checkout', title: `Checkout — ${cfg.brandName}`, description: 'Checkout.', body: layout({ cfg, site, navDepartments, title: `Checkout — ${cfg.brandName}`, description: 'Checkout.', canonicalFile: 'checkout.html', bodyHtml: checkoutBody }) });

  /* Order status */
  const orderBody =
    cfg.mode === 'live'
      ? `<h1>Order status</h1>
<form method="get" action="/store/api/order-status">
  <label for="os-id">Order number</label><input id="os-id" class="field" name="orderId">
  <label for="os-email">Email on the order</label><input id="os-email" class="field" type="email" name="email">
  <p><button class="btn" type="submit">Look up</button></p>
</form>`
      : `<h1>Order status</h1><p class="note">Order lookup is available when this shop is running in live mode.</p>`;
  add({ path: 'order-status.html', contentType: 'text/html; charset=utf-8', kind: 'order_status', title: `Order status — ${cfg.brandName}`, description: 'Check your order status.', body: layout({ cfg, site, navDepartments, title: `Order status — ${cfg.brandName}`, description: 'Check your order status.', canonicalFile: 'order-status.html', bodyHtml: orderBody }) });

  /* Consent capture */
  const consentBody =
    cfg.mode === 'live'
      ? `<h1>Email updates</h1>
<form method="post" action="/store/api/consent">
  <label for="cs-email">Email</label><input id="cs-email" class="field" type="email" name="email" required>
  <p><label><input type="checkbox" name="agree" required> I want ${escapeHtml(cfg.brandName)} email updates and understand I can unsubscribe anytime.</label></p>
  <p><button class="btn" type="submit">Sign me up</button></p>
</form>
<p class="muted">Double opt-in: we send a confirmation link before any list add.</p>`
      : `<h1>Email updates</h1><p class="note">Come see us at a show to sign up for ${escapeHtml(cfg.brandName)} email updates, or sign up on the live site. We use double opt-in and you can unsubscribe anytime.</p>`;
  add({ path: 'consent.html', contentType: 'text/html; charset=utf-8', kind: 'consent', title: `Email updates — ${cfg.brandName}`, description: 'Sign up for email updates.', body: layout({ cfg, site, navDepartments, title: `Email updates — ${cfg.brandName}`, description: 'Sign up for email updates.', canonicalFile: 'consent.html', bodyHtml: consentBody }) });

  /* Gift cards */
  const giftBody = `<h1>Gift cards</h1>
<p>${escapeHtml(cfg.brandName)} gift cards are available at our booth on the show circuit. Ask any staff member — they make a great gift for the rider in your life.</p>
<p class="muted">Online gift-card purchase opens with hosted payments.</p>`;
  add({ path: 'gift-cards.html', contentType: 'text/html; charset=utf-8', kind: 'gift_cards', title: `Gift cards — ${cfg.brandName}`, description: 'Gift cards.', body: layout({ cfg, site, navDepartments, title: `Gift cards — ${cfg.brandName}`, description: 'Gift cards.', canonicalFile: 'gift-cards.html', bodyHtml: giftBody }) });

  /* About */
  const aboutParas = cfg.aboutParagraphs.length
    ? cfg.aboutParagraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')
    : `<p>${escapeHtml(cfg.brandName)} is a ${escapeHtml(cfg.tagline)}. Find us at horse shows across the region with tack, apparel and horse care for every rider.</p>`;
  const aboutBody = `<h1>About ${escapeHtml(cfg.brandName)}</h1>
${aboutParas}
${contactLine(cfg)}`;
  add({ path: 'about.html', contentType: 'text/html; charset=utf-8', kind: 'info', title: `About — ${cfg.brandName}`, description: `About ${cfg.brandName}.`, body: layout({ cfg, site, navDepartments, title: `About — ${cfg.brandName}`, description: `About ${cfg.brandName}.`, canonicalFile: 'about.html', bodyHtml: aboutBody }) });

  /* Info / policy pages (client-authored text via config) */
  for (const ip of cfg.infoPages) {
    const body = `<h1>${escapeHtml(ip.title)}</h1>
${ip.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}`;
    add({ path: `${ip.slug}.html`, contentType: 'text/html; charset=utf-8', kind: 'info', title: `${ip.title} — ${cfg.brandName}`, description: `${ip.title}.`, body: layout({ cfg, site, navDepartments, title: `${ip.title} — ${cfg.brandName}`, description: `${ip.title}.`, canonicalFile: `${ip.slug}.html`, bodyHtml: body }) });
  }

  /* 404 */
  const notFoundBody = `<h1>Page not found</h1><p>We couldn't find that page. <a href="index.html">Return home</a>.</p>`;
  add({ path: '404.html', contentType: 'text/html; charset=utf-8', kind: 'info', title: `Not found — ${cfg.brandName}`, description: 'Page not found.', body: layout({ cfg, site, navDepartments, title: `Not found — ${cfg.brandName}`, description: 'Page not found.', canonicalFile: '404.html', bodyHtml: notFoundBody }) });

  /* CSS + app.js */
  // (buildCss imported lazily to avoid a cycle at module top.)
  return finalize(pages, imageRefs, site, cfg, bySlug);
}

function finalize(
  pages: RenderedPage[],
  imageRefs: Set<string>,
  site: ProjectionSite,
  cfg: SiteConfig,
  _bySlug: Map<string, RenderItem>,
): RenderedSite {
  // Assets
  pages.push({ path: 'assets/site.css', contentType: 'text/css; charset=utf-8', kind: 'asset', title: '', description: '', body: buildCss() });
  pages.push({ path: 'assets/app.js', contentType: 'text/javascript; charset=utf-8', kind: 'asset', title: '', description: '', body: appJs() });

  // Search index + manifest
  const search = buildSearchIndex(site.items);
  for (const f of search.files) pages.push({ path: f.path, contentType: 'application/json; charset=utf-8', kind: 'search_index', title: '', description: '', body: f.json });
  pages.push({ path: 'search-index/manifest.json', contentType: 'application/json; charset=utf-8', kind: 'search_index', title: '', description: '', body: JSON.stringify(search.manifest) });

  // sitemap.xml (only content pages, deterministic order)
  const contentKinds = new Set(['home', 'department', 'brand', 'item', 'search', 'cart', 'checkout', 'order_status', 'gift_cards', 'consent', 'info']);
  const urls = pages
    // 404.html is kind 'info' but must never be sitemapped.
    .filter((p) => contentKinds.has(p.kind) && p.path !== '404.html')
    .map((p) => (cfg.canonicalBase ? `${cfg.canonicalBase.replace(/\/$/, '')}/${publicPath(p.path)}` : p.path))
    .sort();
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${escapeHtml(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
  pages.push({ path: 'sitemap.xml', contentType: 'application/xml; charset=utf-8', kind: 'sitemap', title: '', description: '', body: sitemap });

  // robots.txt
  const robots = `User-agent: *\nAllow: /\nSitemap: ${cfg.canonicalBase ? `${cfg.canonicalBase.replace(/\/$/, '')}/sitemap.xml` : 'sitemap.xml'}\n`;
  pages.push({ path: 'robots.txt', contentType: 'text/plain; charset=utf-8', kind: 'robots', title: '', description: '', body: robots });

  const byPath = new Map(pages.map((p) => [p.path, p]));
  const assetRefs = new Set<string>();
  if (cfg.logoFile) {
    assetRefs.add(cfg.logoFile);
    assetRefs.add('favicon.png');
  }
  const selfHost = cfg.canonicalBase ? new URL(cfg.canonicalBase).hostname.toLowerCase() : '';
  return { pages, byPath, imageRefs, assetRefs, selfHost };
}
