import { mkdir, writeFile, copyFile, access, rm, lstat } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import type { Kysely } from 'kysely';
import type { StorefrontDatabase } from './schema';
import { renderSite, type SiteConfig } from './render';
import { readProjection, getLiveRun } from './publish';
import { runContentGates, type GateResult, type OwnIdentity } from './gates';

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
  /** The shop's own public contact identity — exempted by the leakage/link gates. */
  ownIdentity?: OwnIdentity;
  /** Extra static assets copied to assets/<destName> (e.g. the logo). */
  extraAssets?: Array<{ sourcePath: string; destName: string }>;
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

function exportDestination(root: string, path: string): string {
  const parts = path.split('/');
  if (!path || isAbsolute(path) || /[\\:\u0000-\u001f\u007f]/.test(path) ||
      parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe export path: ${JSON.stringify(path)}`);
  }
  const dest = resolve(root, path);
  const rel = relative(resolve(root), dest);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Unsafe export path: ${JSON.stringify(path)}`);
  }
  return dest;
}

async function rejectExistingSymlinks(root: string, dest: string): Promise<void> {
  let current = resolve(root);
  const parts = relative(current, dest).split(sep);
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = join(current, parts[i]);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Unsafe export path: symbolic link at ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
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

  // Validate the entire output plan before clean can remove an existing site.
  // Catalog-derived paths and extra asset destinations never select a parent.
  const paths = [
    ...rendered.pages.map((page) => page.path),
    ...[...rendered.imageRefs].map((name) => `assets/img/${name}`),
    ...[...rendered.assetRefs].map((name) => `assets/${name}`),
    ...(opts.extraAssets ?? []).map((asset) => `assets/${asset.destName}`),
  ];
  for (const path of new Set(paths)) {
    const dest = exportDestination(outDir, path);
    await rejectExistingSymlinks(outDir, dest);
  }

  if (opts.clean !== false) {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });

  let bytesWritten = 0;
  for (const page of rendered.pages) {
    const dest = exportDestination(outDir, page.path);
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
        await copyFile(src, exportDestination(outDir, `assets/img/${base}`));
        imagesCopied++;
      } else {
        imagesMissing++;
      }
    }
  }

  for (const asset of opts.extraAssets ?? []) {
    const dest = exportDestination(outDir, `assets/${asset.destName}`);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(asset.sourcePath, dest);
  }

  const searchIndexShards = rendered.pages.filter((p) => /^search-index\/.+\.json$/.test(p.path) && p.path !== 'search-index/manifest.json').length;

  let gateResults: GateResult[] = [];
  let gatesPassed = true;
  if (opts.runGates !== false) {
    gateResults = runContentGates(rendered, { denylist: opts.denylist, crossBrandTerms: opts.crossBrandTerms, ownIdentity: opts.ownIdentity });
    // Every asset the render references must actually have been copied.
    const assetFailures: string[] = [];
    for (const name of [...rendered.assetRefs].sort()) {
      if (!(await fileExists(join(outDir, 'assets', name)))) assetFailures.push(`assets/${name} referenced but not copied (extraAssets)`);
    }
    gateResults.push({ name: 'asset-files', pass: assetFailures.length === 0, failures: assetFailures, checked: rendered.assetRefs.size });
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
