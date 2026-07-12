import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportStaticSite } from '../src/export';
import { publishStorefront } from '../src/publish';
import { setup, fixtureSource } from './helpers';

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('static export', () => {
  it('writes a complete self-contained site with sitemap + robots, and gates pass', async () => {
    const { db, tenantA } = await setup();
    await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(), dataAsOf: '2026-07-11' });
    const outDir = await tmp('storefront-export-');

    const stats = await exportStaticSite({ db, tenantId: tenantA.id, outDir, config: { brandName: 'Mags Tack' } });

    expect(stats.gatesPassed).toBe(true);
    expect(stats.htmlPageCount).toBeGreaterThan(4);
    expect(stats.bytesWritten).toBeGreaterThan(0);

    for (const f of ['index.html', 'sitemap.xml', 'robots.txt', 'assets/site.css', 'assets/app.js', 'search-index/manifest.json']) {
      const s = await stat(join(outDir, f));
      expect(s.isFile(), f).toBe(true);
    }
    const index = await readFile(join(outDir, 'index.html'), 'utf8');
    expect(index).toContain('Mags Tack');
    // zero external URLs in the written index (schema.org identifiers only appear in item JSON-LD)
    expect(/https?:\/\/(?!schema\.org|www\.sitemaps\.org|www\.w3\.org)/.test(index)).toBe(false);
  });

  it('copies referenced images and never inlines them', async () => {
    const { db, tenantA } = await setup();
    await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(), dataAsOf: '2026-07-11' });
    const outDir = await tmp('storefront-export-img-');
    const imgDir = await tmp('storefront-imgsrc-');
    // The fixture references halter.jpeg and boot.jpeg.
    await writeFile(join(imgDir, 'halter.jpeg'), 'FAKEJPEG');
    await writeFile(join(imgDir, 'boot.jpeg'), 'FAKEJPEG');

    const stats = await exportStaticSite({ db, tenantId: tenantA.id, outDir, imageSourceDir: imgDir });
    expect(stats.imagesCopied).toBe(2);
    const copied = await readdir(join(outDir, 'assets', 'img'));
    expect(copied.sort()).toEqual(['boot.jpeg', 'halter.jpeg']);
    // referenced, not inlined: html points at the file, not a data: URI
    const item = await readFile(join(outDir, 'item-ellany-leather-halter.html'), 'utf8');
    expect(item).toContain('assets/img/halter.jpeg');
    expect(item).not.toContain('data:image');
  });

  it('is deterministic — same projection ⇒ byte-identical export', async () => {
    const { db, tenantA } = await setup();
    await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(), dataAsOf: '2026-07-11' });
    const a = await tmp('storefront-det-a-');
    const b = await tmp('storefront-det-b-');
    await exportStaticSite({ db, tenantId: tenantA.id, outDir: a });
    await exportStaticSite({ db, tenantId: tenantA.id, outDir: b });

    const listing = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      const walk = async (d: string, base: string) => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          const rel = base ? `${base}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(join(d, e.name), rel);
          else out.push(rel);
        }
      };
      await walk(dir, '');
      return out.sort();
    };
    const filesA = await listing(a);
    const filesB = await listing(b);
    expect(filesB).toEqual(filesA);
    for (const f of filesA) {
      const ba = await readFile(join(a, f));
      const bb = await readFile(join(b, f));
      expect(bb.equals(ba), f).toBe(true);
    }
  });
});
