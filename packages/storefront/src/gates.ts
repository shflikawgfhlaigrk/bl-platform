import type { Kysely } from 'kysely';
import { sql } from '@blacklabel/db';
import { checkPalette, buildCss, AA_MIN } from './theme';
import type { RenderedSite, RenderedPage } from './render';

/**
 * Build gates. Each returns a GateResult; a publish FAILS (and does not swap the
 * live projection) if ANY gate fails. Gates run over the rendered STATIC output
 * (the artifact that becomes public files); the live routes share the same
 * templates and are covered by router tests.
 */

export interface GateResult {
  name: string;
  pass: boolean;
  failures: string[];
  checked: number;
}

/** Hosts that appear only as non-fetched identifiers (JSON-LD @context, XML
 * namespaces). Browsers never dereference these, so they are not "external
 * resource loads". Everything else http(s):// is a violation. */
const IDENTIFIER_HOSTS = new Set(['schema.org', 'www.sitemaps.org', 'www.w3.org']);

const htmlPages = (site: RenderedSite): RenderedPage[] =>
  site.pages.filter((p) => p.path.endsWith('.html'));

const textPages = (site: RenderedSite): RenderedPage[] =>
  site.pages.filter((p) => /\.(html|json|xml|txt|css|js)$/.test(p.path));

/* ------------------------------- leakage ------------------------------- */

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Phone: require separators/parens so bare digit SKUs/barcodes don't false-positive.
const PHONE_RE = /(?:\+?1[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g;

export function leakageGate(
  site: RenderedSite,
  opts: { denylist?: string[]; crossBrandTerms?: string[] } = {},
): GateResult {
  const failures: string[] = [];
  let checked = 0;
  const denylist = opts.denylist ?? [];
  const crossBrand = ['black label', ...(opts.crossBrandTerms ?? [])].map((s) => s.toLowerCase());

  for (const p of textPages(site)) {
    checked++;
    const body = p.body;
    const lower = body.toLowerCase();
    for (const m of body.match(EMAIL_RE) ?? []) failures.push(`${p.path}: email-like string "${m}"`);
    for (const m of body.match(PHONE_RE) ?? []) failures.push(`${p.path}: phone-like string "${m}"`);
    for (const term of denylist) {
      if (!term) continue;
      if (lower.includes(term.toLowerCase())) failures.push(`${p.path}: denylist term "${term}"`);
    }
    for (const term of crossBrand) {
      if (lower.includes(term)) failures.push(`${p.path}: cross-brand term "${term}" (brand isolation)`);
    }
  }
  return { name: 'leakage', pass: failures.length === 0, failures, checked };
}

/* ------------------------------ exclusions ----------------------------- */

// Exclusion markers to re-grep from output. "JPC Consignment" is the excluded
// consignment category; "JPC Equestrian" is a legitimate MANUFACTURER named in
// product copy — the negative lookahead keeps the manufacturer while still
// catching the consignment marker and a bare leading "JPC" on an excluded item.
const EXCLUSION_TOKENS = [/\bDNU\b/i, /\bJPC\b(?!\s+Equestrian)/i, /consignment/i];

export function exclusionOutputGate(site: RenderedSite): GateResult {
  const failures: string[] = [];
  let checked = 0;
  for (const p of htmlPages(site)) {
    checked++;
    for (const re of EXCLUSION_TOKENS) {
      const m = p.body.match(re);
      if (m) failures.push(`${p.path}: excluded token "${m[0]}"`);
    }
  }
  return { name: 'exclusions', pass: failures.length === 0, failures, checked };
}

/* --------------------------------- a11y -------------------------------- */

function headingLevels(body: string): number[] {
  const out: number[] = [];
  for (const m of body.matchAll(/<h([1-6])[\s>]/gi)) out.push(Number(m[1]));
  return out;
}

export function a11yGate(site: RenderedSite): GateResult {
  const failures: string[] = [];
  let checked = 0;

  // Palette contrast (computed, every pair >= 4.5:1).
  for (const c of checkPalette()) {
    if (!c.pass) failures.push(`contrast ${c.name}: ${c.ratio.toFixed(2)}:1 < ${AA_MIN}:1 (${c.fg} on ${c.bg})`);
  }
  // focus-visible present in the shipped CSS.
  const css = site.byPath.get('assets/site.css')?.body ?? buildCss();
  if (!css.includes(':focus-visible')) failures.push('CSS: no :focus-visible styles');

  for (const p of htmlPages(site)) {
    checked++;
    const b = p.body;
    // lang + viewport
    if (!/<html[^>]*\blang=/i.test(b)) failures.push(`${p.path}: <html> missing lang`);
    if (!/<meta[^>]*name=["']viewport["']/i.test(b)) failures.push(`${p.path}: missing viewport meta`);
    // landmarks + skip link
    if (!/<header[\s>]/i.test(b)) failures.push(`${p.path}: no <header> landmark`);
    if (!/<main[\s>]/i.test(b)) failures.push(`${p.path}: no <main> landmark`);
    if (!/<footer[\s>]/i.test(b)) failures.push(`${p.path}: no <footer> landmark`);
    if (!/class=["']skip-link["'][^>]*href=["']#main["']/i.test(b) && !/href=["']#main["'][^>]*class=["']skip-link["']/i.test(b)) {
      failures.push(`${p.path}: no skip link to #main`);
    }
    if (!/<main[^>]*id=["']main["']/i.test(b)) failures.push(`${p.path}: <main> missing id="main"`);
    // every img has non-empty alt
    for (const m of b.matchAll(/<img\b[^>]*>/gi)) {
      const tag = m[0];
      const alt = tag.match(/\balt=["']([^"']*)["']/i);
      if (!alt) failures.push(`${p.path}: <img> without alt (${tag.slice(0, 60)})`);
      else if (alt[1].trim() === '') failures.push(`${p.path}: <img> with empty alt (${tag.slice(0, 60)})`);
    }
    // labeled controls
    const labelFors = new Set([...b.matchAll(/<label\b[^>]*\bfor=["']([^"']+)["']/gi)].map((m) => m[1]));
    for (const m of b.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
      const tag = m[0];
      const type = (tag.match(/\btype=["']([^"']+)["']/i)?.[1] ?? 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset'].includes(type)) continue;
      if (/\baria-label=/i.test(tag) || /\baria-labelledby=/i.test(tag)) continue;
      if (type === 'radio' || type === 'checkbox') continue; // wrapped in <label> by construction
      const idm = tag.match(/\bid=["']([^"']+)["']/i);
      if (!idm) failures.push(`${p.path}: form control without id/aria-label (${tag.slice(0, 50)})`);
      else if (!labelFors.has(idm[1])) failures.push(`${p.path}: control #${idm[1]} has no <label for>`);
    }
    // heading hierarchy: one h1, no skips
    const levels = headingLevels(b);
    const h1count = levels.filter((l) => l === 1).length;
    if (h1count !== 1) failures.push(`${p.path}: expected exactly one <h1>, found ${h1count}`);
    let prev = 0;
    for (const lvl of levels) {
      if (prev && lvl > prev + 1) failures.push(`${p.path}: heading jumps h${prev}→h${lvl}`);
      prev = lvl;
    }
  }
  return { name: 'a11y', pass: failures.length === 0, failures, checked };
}

/* ----------------------------- external URLs --------------------------- */

export function externalUrlGate(site: RenderedSite): GateResult {
  const failures: string[] = [];
  let checked = 0;
  for (const p of textPages(site)) {
    checked++;
    for (const m of p.body.matchAll(/https?:\/\/([^\s"'<>)]+)/gi)) {
      const host = m[1].split(/[/?#]/)[0].toLowerCase();
      if (!IDENTIFIER_HOSTS.has(host)) failures.push(`${p.path}: external URL ${m[0]}`);
    }
  }
  return { name: 'external-urls', pass: failures.length === 0, failures, checked };
}

/* ----------------------------- broken links ---------------------------- */

export function brokenLinkGate(site: RenderedSite): GateResult {
  const failures: string[] = [];
  let checked = 0;
  const exists = (target: string): boolean => {
    if (site.byPath.has(target)) return true;
    if (target.startsWith('assets/img/')) {
      const base = target.slice('assets/img/'.length);
      return site.imageRefs.has(base);
    }
    return false;
  };
  for (const p of htmlPages(site)) {
    for (const m of p.body.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) {
      const raw = m[1];
      if (/^(#|mailto:|tel:|data:|https?:|\/store\/api\/)/i.test(raw)) continue;
      const target = raw.split('#')[0].split('?')[0];
      if (!target) continue;
      checked++;
      if (!exists(target)) failures.push(`${p.path}: broken ref → ${raw}`);
    }
  }
  return { name: 'broken-links', pass: failures.length === 0, failures, checked };
}

/* --------------------------------- SEO --------------------------------- */

export function seoGate(site: RenderedSite): GateResult {
  const failures: string[] = [];
  let checked = 0;
  const contentKinds = new Set(['home', 'department', 'brand', 'item', 'search', 'cart', 'checkout', 'order_status', 'gift_cards', 'consent', 'info']);
  for (const p of htmlPages(site)) {
    if (!contentKinds.has(p.kind)) continue;
    checked++;
    if (!/<title>[^<]+<\/title>/i.test(p.body)) failures.push(`${p.path}: empty/missing <title>`);
    if (!/<meta[^>]*name=["']description["'][^>]*content=["'][^"']+["']/i.test(p.body)) failures.push(`${p.path}: missing meta description`);
    if (!/<link[^>]*rel=["']canonical["']/i.test(p.body)) failures.push(`${p.path}: missing canonical`);
    if (p.kind === 'item') {
      if (!/application\/ld\+json/i.test(p.body) || !/"@type":"Product"/.test(p.body)) {
        failures.push(`${p.path}: item page missing JSON-LD Product`);
      }
    }
  }
  if (!site.byPath.has('sitemap.xml')) failures.push('missing sitemap.xml');
  if (!site.byPath.has('robots.txt')) failures.push('missing robots.txt');
  return { name: 'seo', pass: failures.length === 0, failures, checked };
}

/* --------------------- projection PII schema assertion ----------------- */

const PII_COLUMN_DENYLIST = ['email', 'phone', 'address', 'customer_name', 'cost', 'cost_cents', 'revenue', 'on_hand', 'quantity', 'qty', 'stock_count', 'count', 'vendor'];

/** Structural gate: the projection tables must have NO PII/cost/count columns. */
export async function assertProjectionSchemaClean(db: Kysely<any>): Promise<GateResult> {
  const tables = [
    'storefront_publish_runs',
    'storefront_published_items',
    'storefront_published_variations',
    'storefront_availability',
    'storefront_pages',
  ];
  const failures: string[] = [];
  let checked = 0;
  for (const t of tables) {
    const rows = (await sql<{ name: string }>`SELECT name FROM pragma_table_info(${sql.lit(t)})`.execute(db)).rows;
    for (const r of rows) {
      checked++;
      const col = r.name.toLowerCase();
      for (const bad of PII_COLUMN_DENYLIST) {
        // exact column-name match against denylist (avoid 'price_cents' → 'cost' false hit; 'count' matches 'item_count'/'page_count' — those are RUN metadata, allow)
        if (col === bad) failures.push(`${t}.${r.name}: forbidden projection column "${bad}"`);
      }
    }
  }
  return { name: 'projection-schema', pass: failures.length === 0, failures, checked };
}

/** Availability output must be a STATE badge, never a numeric count. */
export function availabilityNoCountGate(site: RenderedSite): GateResult {
  const failures: string[] = [];
  let checked = 0;
  for (const p of htmlPages(site)) {
    for (const m of p.body.matchAll(/<span class="badge (in|low|out)">([^<]*)<\/span>/gi)) {
      checked++;
      if (/\d/.test(m[2])) failures.push(`${p.path}: availability badge contains a digit "${m[2]}"`);
    }
  }
  return { name: 'availability-no-count', pass: failures.length === 0, failures, checked };
}

/* ------------------------------ run all -------------------------------- */

export interface RunGatesOptions {
  denylist?: string[];
  crossBrandTerms?: string[];
}

/** Run every content gate over the rendered site. Deterministic order. */
export function runContentGates(site: RenderedSite, opts: RunGatesOptions = {}): GateResult[] {
  return [
    leakageGate(site, opts),
    exclusionOutputGate(site),
    a11yGate(site),
    externalUrlGate(site),
    brokenLinkGate(site),
    seoGate(site),
    availabilityNoCountGate(site),
  ];
}
