import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV, navRoutes, missingViews, parseHash, DEFAULT_ROUTE, hashFor } from '../src/routes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const viewsDir = path.resolve(here, '../public/js/views');

/** Statically discover which routes actually have a registered view by
 *  scanning the view files for `registerView('<route>', ...)`. */
function registeredRoutesFromDisk(): string[] {
  const files = readdirSync(viewsDir).filter((f) => f.endsWith('.js'));
  const routes: string[] = [];
  for (const f of files) {
    const src = readFileSync(path.join(viewsDir, f), 'utf8');
    for (const m of src.matchAll(/registerView\(\s*['"]([\w-]+)['"]/g)) {
      routes.push(m[1]);
    }
  }
  return routes;
}

describe('route table completeness', () => {
  const registered = registeredRoutesFromDisk();

  it('every nav item has a registered view (no dead links)', () => {
    const missing = missingViews(registered);
    expect(missing, `nav routes with no view file: ${missing.join(', ')}`).toEqual([]);
  });

  it('every nav route resolves to exactly one view file', () => {
    for (const route of navRoutes()) {
      const count = registered.filter((r) => r === route).length;
      expect(count, `route "${route}" registered ${count} times`).toBe(1);
    }
  });

  it('the default route exists and is registered', () => {
    expect(navRoutes()).toContain(DEFAULT_ROUTE);
    expect(registered).toContain(DEFAULT_ROUTE);
  });

  it('nav has no duplicate routes and every item has a plain-language label', () => {
    const seen = new Set<string>();
    for (const n of NAV) {
      expect(seen.has(n.route), `duplicate nav route ${n.route}`).toBe(false);
      seen.add(n.route);
      expect(n.label.length).toBeGreaterThan(0);
      expect(n.primary.length).toBeGreaterThan(0);
    }
  });

  it('parseHash extracts route + params and defaults sensibly', () => {
    expect(parseHash('#/scan')).toEqual({ route: 'scan', params: [] });
    expect(parseHash('#/counts/abc123')).toEqual({ route: 'counts', params: ['abc123'] });
    expect(parseHash('')).toEqual({ route: DEFAULT_ROUTE, params: [] });
    expect(parseHash('#/')).toEqual({ route: DEFAULT_ROUTE, params: [] });
  });

  it('hashFor round-trips', () => {
    expect(hashFor('orders')).toBe('#/orders');
    expect(hashFor('orders', 'o123')).toBe('#/orders/o123');
  });
});
