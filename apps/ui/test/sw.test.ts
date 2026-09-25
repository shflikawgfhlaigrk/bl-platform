import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const swPath = path.resolve(here, '../public/sw.js');
const src = readFileSync(swPath, 'utf8');

describe('service worker cache discipline (stale-SW trap)', () => {
  it('declares a single versioned CACHE_NAME constant', () => {
    const matches = [...src.matchAll(/const\s+CACHE_NAME\s*=\s*['"]([^'"]+)['"]/g)];
    expect(matches, 'exactly one CACHE_NAME constant').toHaveLength(1);
    // The name must carry a version suffix so a deploy can bump it.
    expect(matches[0][1]).toMatch(/^one-club-shell-v\d+$/);
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

  it('loads updated register code on the first reload and retains an offline shell fallback', async () => {
    const handlers: Record<string, Function> = {};
    let offline = false;
    const old = new Response('old shell');
    runInNewContext(src, { URL, Response, self: { addEventListener: (type: string, handler: Function) => { handlers[type] = handler; } },
      caches: { match: async () => old, open: async () => ({ put: async () => {} }) },
      fetch: async () => { if (offline) throw new Error('Offline'); return new Response('current shell'); },
    });
    async function request(path: string) {
      let response: Promise<Response> | undefined;
      handlers.fetch({ request: new Request(`https://venue.test${path}`), respondWith: (value: Promise<Response>) => { response = value; } });
      return await response!;
    }
    expect(await (await request('/js/views/bar.js')).text()).toBe('current shell');
    offline = true;
    expect(await (await request('/js/views/bar.js')).text()).toBe('old shell');
    const api = await request('/api/pos/bar/state');
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ error: { code: 'offline' } });
  });

  it('precaches every runtime view and browser-independent module needed offline', () => {
    const publicDir = path.resolve(here, '../public');
    const expected = [
      ...readdirSync(path.join(publicDir, 'js/views'))
        .filter((file) => file.endsWith('.js'))
        .map((file) => './js/views/' + file),
      ...readdirSync(path.join(publicDir, 'src'))
        .filter((file) => file.endsWith('.mjs'))
        .map((file) => './src/' + file),
      './js/ui.js',
    ];
    for (const asset of expected) {
      expect(src.includes("'" + asset + "'"), 'shell should precache ' + asset).toBe(true);
    }
  });
});
