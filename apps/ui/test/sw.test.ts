import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const swPath = path.resolve(here, '../public/sw.js');
const src = readFileSync(swPath, 'utf8');

describe('service worker cache discipline (stale-SW trap)', () => {
  it('declares a single versioned CACHE_NAME constant', () => {
    const matches = [...src.matchAll(/const\s+CACHE_NAME\s*=\s*['"]([^'"]+)['"]/g)];
    expect(matches, 'exactly one CACHE_NAME constant').toHaveLength(1);
    // The name must carry a version suffix so a deploy can bump it.
    expect(matches[0][1]).toMatch(/-v\d+/);
  });

  it('carries the loud BUMP reminder so deploys do not ship a stale shell', () => {
    expect(src).toMatch(/BUMP THIS ON EVERY DEPLOY/i);
  });

  it('deletes non-current caches on activate (cache busting works)', () => {
    expect(src).toMatch(/caches\.delete/);
    expect(src).toMatch(/k !== CACHE_NAME/);
  });

  it('never caches API responses as authoritative (network-first for /api/)', () => {
    expect(src).toMatch(/pathname\.startsWith\('\/api\/'\)/);
  });

  it('caches the app shell entry points', () => {
    for (const asset of ['./', './index.html', './app.css', './js/app.js']) {
      expect(src.includes(`'${asset}'`), `shell should list ${asset}`).toBe(true);
    }
  });
});
