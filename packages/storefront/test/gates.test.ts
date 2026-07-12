import { describe, expect, it } from 'vitest';
import {
  leakageGate,
  exclusionOutputGate,
  a11yGate,
  externalUrlGate,
  brokenLinkGate,
  seoGate,
  availabilityNoCountGate,
  assertProjectionSchemaClean,
} from '../src/gates';
import { checkPalette, AA_MIN } from '../src/theme';
import { contrastRatio } from '../src/contrast';
import { makeSite, setup } from './helpers';

const okHead = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>T</title><meta name="description" content="D"><link rel="canonical" href="index.html"></head>`;
const goodPage = (main: string) =>
  `${okHead}<body><a class="skip-link" href="#main">Skip</a><header>h</header><main id="main">${main}</main><footer>f</footer></body></html>`;

describe('leakage gate', () => {
  it('passes clean output', () => {
    const r = leakageGate(makeSite([{ path: 'a.html', body: goodPage('<h1>Hi</h1><p>All good.</p>') }]));
    expect(r.pass).toBe(true);
  });
  it('catches a seeded email', () => {
    const r = leakageGate(makeSite([{ path: 'a.html', body: goodPage('<p>reach me at bob@example.com</p>') }]));
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toMatch(/email-like/);
  });
  it('catches a seeded phone number', () => {
    const r = leakageGate(makeSite([{ path: 'a.html', body: goodPage('<p>call (770) 555-1234 today</p>') }]));
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toMatch(/phone-like/);
  });
  it('does NOT false-positive on a bare digit SKU/barcode', () => {
    const r = leakageGate(makeSite([{ path: 'a.html', body: goodPage('<p>SKU 8801234567 UPC 036000291452</p>') }]));
    expect(r.pass).toBe(true);
  });
  it('catches a cross-brand reference (brand isolation)', () => {
    const r = leakageGate(makeSite([{ path: 'a.html', body: goodPage('<p>Powered by Black Label</p>') }]));
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toMatch(/cross-brand/);
  });
  it('catches a denylisted string (e.g. a customer name)', () => {
    const r = leakageGate(makeSite([{ path: 'a.html', body: goodPage('<p>Sold to Jane Rider</p>') }]), { denylist: ['Jane Rider'] });
    expect(r.pass).toBe(false);
  });
});

describe('exclusion output gate', () => {
  it('catches DNU / JPC / consignment tokens in output', () => {
    for (const tok of ['DNU - Old Bridle', 'JPC Blanket', 'Consignment Saddle']) {
      const r = exclusionOutputGate(makeSite([{ path: 'a.html', body: goodPage(`<h1>${tok}</h1>`) }]));
      expect(r.pass, tok).toBe(false);
    }
  });
  it('passes clean output', () => {
    expect(exclusionOutputGate(makeSite([{ path: 'a.html', body: goodPage('<h1>Leather Halter</h1>') }])).pass).toBe(true);
  });
});

describe('a11y gate', () => {
  it('passes a well-formed page', () => {
    const r = a11yGate(makeSite([{ path: 'a.html', body: goodPage('<h1>Title</h1><img src="assets/img/x.jpeg" alt="x">') }], ['x.jpeg']));
    expect(r.pass).toBe(true);
  });
  it('catches a missing alt attribute', () => {
    const r = a11yGate(makeSite([{ path: 'a.html', body: goodPage('<h1>T</h1><img src="assets/img/x.jpeg">') }]));
    expect(r.failures.join(' ')).toMatch(/without alt/);
  });
  it('catches an empty alt attribute', () => {
    const r = a11yGate(makeSite([{ path: 'a.html', body: goodPage('<h1>T</h1><img src="assets/img/x.jpeg" alt="">') }]));
    expect(r.failures.join(' ')).toMatch(/empty alt/);
  });
  it('catches a skipped heading level', () => {
    const r = a11yGate(makeSite([{ path: 'a.html', body: goodPage('<h1>T</h1><h3>Skipped</h3>') }]));
    expect(r.failures.join(' ')).toMatch(/heading jumps h1→h3/);
  });
  it('catches a missing skip link', () => {
    const noSkip = `${okHead}<body><header>h</header><main id="main"><h1>T</h1></main><footer>f</footer></body></html>`;
    const r = a11yGate(makeSite([{ path: 'a.html', body: noSkip }]));
    expect(r.failures.join(' ')).toMatch(/no skip link/);
  });
  it('catches an unlabeled form control', () => {
    const r = a11yGate(makeSite([{ path: 'a.html', body: goodPage('<h1>T</h1><input id="q" type="text">') }]));
    expect(r.failures.join(' ')).toMatch(/no <label for>/);
  });
  it('catches a missing lang attribute', () => {
    const noLang = goodPage('<h1>T</h1>').replace('<html lang="en">', '<html>');
    const r = a11yGate(makeSite([{ path: 'a.html', body: noLang }]));
    expect(r.failures.join(' ')).toMatch(/missing lang/);
  });
});

describe('contrast math (WCAG)', () => {
  it('computes a known ratio (black on white = 21:1)', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });
  it('every shipped palette pair meets AA 4.5:1', () => {
    const checks = checkPalette();
    for (const c of checks) expect(c.ratio, c.name).toBeGreaterThanOrEqual(AA_MIN);
  });
  it('flags a low-contrast pair', () => {
    const [c] = checkPalette([{ name: 'bad', fg: '#999999', bg: '#aaaaaa' }]);
    expect(c.pass).toBe(false);
  });
});

describe('external-url gate', () => {
  it('fails on a real external resource URL', () => {
    const r = externalUrlGate(makeSite([{ path: 'a.html', body: goodPage('<img src="https://cdn.evil.com/x.png" alt="x">') }]));
    expect(r.pass).toBe(false);
  });
  it('allows schema.org / sitemap namespace identifiers', () => {
    const r = externalUrlGate(makeSite([{ path: 'a.html', body: goodPage('<script type="application/ld+json">{"@context":"https://schema.org"}</script>') }]));
    expect(r.pass).toBe(true);
  });
});

describe('broken-link gate', () => {
  it('passes when every ref resolves', () => {
    const site = makeSite([
      { path: 'index.html', body: goodPage('<h1>H</h1><a href="item-x.html">x</a><img src="assets/img/p.jpeg" alt="p">') },
      { path: 'item-x.html', body: goodPage('<h1>X</h1>') },
    ], ['p.jpeg']);
    expect(brokenLinkGate(site).pass).toBe(true);
  });
  it('fails on a dangling internal link', () => {
    const site = makeSite([{ path: 'index.html', body: goodPage('<h1>H</h1><a href="missing.html">x</a>') }]);
    expect(brokenLinkGate(site).pass).toBe(false);
  });
  it('fails on an image whose file is not present', () => {
    const site = makeSite([{ path: 'index.html', body: goodPage('<h1>H</h1><img src="assets/img/ghost.jpeg" alt="g">') }], []);
    expect(brokenLinkGate(site).pass).toBe(false);
  });
});

describe('seo gate', () => {
  it('requires title/description/canonical and item JSON-LD', () => {
    const item = makeSite([{ path: 'item-x.html', kind: 'item', body: goodPage('<h1>X</h1>') }]);
    // no JSON-LD → fail
    expect(seoGate(item).pass).toBe(false);
  });
});

describe('availability no-count gate', () => {
  it('fails if a badge contains a digit', () => {
    const r = availabilityNoCountGate(makeSite([{ path: 'a.html', body: goodPage('<span class="badge low">3 left</span>') }]));
    expect(r.pass).toBe(false);
  });
  it('passes on state-only badges', () => {
    const r = availabilityNoCountGate(makeSite([{ path: 'a.html', body: goodPage('<span class="badge in">In stock</span><span class="badge out">Out of stock</span>') }]));
    expect(r.pass).toBe(true);
  });
});

describe('projection schema PII assertion', () => {
  it('confirms the projection tables carry no PII/cost/count columns', async () => {
    const { db } = await setup();
    const r = await assertProjectionSchemaClean(db);
    expect(r.pass).toBe(true);
    expect(r.checked).toBeGreaterThan(0);
  });
});
