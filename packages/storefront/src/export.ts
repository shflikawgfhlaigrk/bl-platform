import { mkdir, writeFile, copyFile, access, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Kysely } from 'kysely';
import type { StorefrontDatabase } from './schema';
import { renderSite, type SiteConfig } from './render';
import { readProjection, getLiveRun } from './publish';
import { runContentGates, type GateResult } from './gates';

type Db = Kysely<StorefrontDatabase>;

export interface ExportOptions {
  db: Db;
  tenantId: string;
  outDir: string;
  /** Which run to export. Defaults to the live run. */
  publishRunId?: string;
  config?: Partial<SiteConfig>;
  /** Directory of source images; referenced basenames are copied to assets/img/. */
  imageSourceDir?: string;
  /** Wipe outDir first (default true). */
  clean?: boolean;
  /** Re-run content gates on the written export (default true). */
  runGates?: boolean;
  denylist?: string[];
  crossBrandTerms?: string[];
}

export interface ExportStats {
  outDir: string;
  publishRunId: string;
  pageCount: number;
  htmlPageCount: number;
  bytesWritten: number;
  imagesCopied: number;
  imagesMissing: number;
  searchIndexShards: number;
  gateResults: GateResult[];
  gatesPassed: boolean;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Render the projection to a self-contained static site under `outDir`.
 * Works over file:// (flat pages, relative links, zero external URLs).
 * Deterministic: same projection + config → byte-identical files.
 */
export async function exportStaticSite(opts: ExportOptions): Promise<ExportStats> {
  const { db, tenantId, outDir } = opts;
  const runId = opts.publishRunId ?? (await getLiveRun(db, tenantId))?.id;
  if (!runId) throw new Error('exportStaticSite: no live run to export (publish first)');

  const site = await readProjection(db, tenantId, runId);
  const rendered = renderSite(site, { ...opts.config, mode: 'static' });

  if (opts.clean !== false) {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });

  let bytesWritten = 0;
  for (const page of rendered.pages) {
    const dest = join(outDir, page.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, page.body, 'utf8');
    bytesWritten += Buffer.byteLength(page.body, 'utf8');
  }

  // Copy referenced images (never inlined). Missing → item already renders a
  // text placeholder, so a missing source image is not a broken link.
  let imagesCopied = 0;
  let imagesMissing = 0;
  if (opts.imageSourceDir) {
    const imgDir = join(outDir, 'assets', 'img');
    await mkdir(imgDir, { recursive: true });
    for (const base of [...rendered.imageRefs].sort()) {
      const src = join(opts.imageSourceDir, base);
      if (await fileExists(src)) {
        await copyFile(src, join(imgDir, base));
        imagesCopied++;
      } else {
        imagesMissing++;
      }
    }
  }

  const searchIndexShards = rendered.pages.filter((p) => /^search-index\/.+\.json$/.test(p.path) && p.path !== 'search-index/manifest.json').length;

  let gateResults: GateResult[] = [];
  let gatesPassed = true;
  if (opts.runGates !== false) {
    gateResults = runContentGates(rendered, { denylist: opts.denylist, crossBrandTerms: opts.crossBrandTerms });
    gatesPassed = gateResults.every((g) => g.pass);
  }

  return {
    outDir,
    publishRunId: runId,
    pageCount: rendered.pages.length,
    htmlPageCount: rendered.pages.filter((p) => p.path.endsWith('.html')).length,
    bytesWritten,
    imagesCopied,
    imagesMissing,
    searchIndexShards,
    gateResults,
    gatesPassed,
  };
}
