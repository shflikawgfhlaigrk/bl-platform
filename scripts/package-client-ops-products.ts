import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CLIENT_OPS_CATALOG } from '../packages/client-ops/src/catalog.js';

type ProductCategory = 'service' | 'vertical_pack' | 'engagement_model';

interface ProductEntry {
  ordinal: number;
  category: ProductCategory;
  categoryLabel: string;
  id: string;
  name: string;
  description: string;
  definition: unknown;
}

interface ProductIndexEntry {
  ordinal: number;
  category: ProductCategory;
  id: string;
  name: string;
  archive: string;
  archiveRoot: string;
  bytes: number;
  sha256: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPORT_NAME = `BlackLabel-Client-Operations-Products-${CLIENT_OPS_CATALOG.catalogVersion}`;
const OUTPUT_DIR = resolve(process.env.CLIENT_OPS_EXPORT_DIR ?? join(homedir(), '.codex', 'exports', EXPORT_NAME));

const ROOT_FILES = [
  '.gitignore',
  'CONTRACTS-MAGS.md',
  'CONVENTIONS.md',
  'package-lock.json',
  'package.json',
  'tsconfig.json',
  'vitest.config.ts',
] as const;

const SHARED_SOURCE_DIRECTORIES = [
  'apps/client-ops-api',
  'apps/client-ops-ui',
  'packages/client-ops',
  'packages/automation',
  'packages/core',
  'packages/db',
  'docs/client-ops',
] as const;

const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.cache',
  '.git',
  '.mypy_cache',
  '.pytest_cache',
  '.storage',
  '.turbo',
  '.vite',
  '__pycache__',
  'build',
  'cache',
  'caches',
  'coverage',
  'dist',
  'node_modules',
]);

const NORMALIZED_TIMESTAMP = new Date(`${CLIENT_OPS_CATALOG.catalogVersion}T00:00:00.000Z`);

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildProducts(): ProductEntry[] {
  let ordinal = 0;
  const products: ProductEntry[] = [];

  for (const service of CLIENT_OPS_CATALOG.services) {
    ordinal += 1;
    products.push({
      ordinal,
      category: 'service',
      categoryLabel: 'Sellable service',
      id: service.id,
      name: service.name,
      description: service.summary,
      definition: service,
    });
  }

  for (const pack of CLIENT_OPS_CATALOG.verticalPacks) {
    ordinal += 1;
    products.push({
      ordinal,
      category: 'vertical_pack',
      categoryLabel: 'Configured vertical workflow pack',
      id: pack.id,
      name: pack.name,
      description: pack.summary,
      definition: pack,
    });
  }

  for (const model of CLIENT_OPS_CATALOG.engagementModels) {
    ordinal += 1;
    products.push({
      ordinal,
      category: 'engagement_model',
      categoryLabel: 'Commercial delivery model',
      id: model.id,
      name: model.name,
      description: model.description,
      definition: model,
    });
  }

  if (products.length !== 17) {
    throw new Error(`Expected exactly 17 catalog products, found ${products.length}`);
  }
  return products;
}

function isExcluded(sourcePath: string): boolean {
  const repoRelative = relative(REPO_ROOT, sourcePath);
  const parts = repoRelative.split(sep);
  const fileName = basename(sourcePath);
  const lowerFileName = fileName.toLowerCase();

  if (parts.some((part) => EXCLUDED_DIRECTORY_NAMES.has(part.toLowerCase()))) return true;
  if (lowerFileName === '.ds_store' || lowerFileName === 'thumbs.db') return true;
  if (lowerFileName === '.env' || lowerFileName.startsWith('.env.')) return true;
  if (/(^|[-_.])(credential|credentials|secret|secrets)([-_.]|$)/i.test(fileName)) return true;
  if (/\.(?:db|sqlite|sqlite3|pem|key|p12|pfx|jks|keystore|log)$/i.test(fileName)) return true;
  if (/(?:-wal|-shm|-journal)$/i.test(fileName)) return true;
  return false;
}

async function copySourceTree(source: string, destination: string): Promise<void> {
  if (isExcluded(source)) return;
  const sourceStat = await lstat(source);

  // Packages contain source, not resolved external symlink targets.
  if (sourceStat.isSymbolicLink()) return;
  if (sourceStat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      await copySourceTree(join(source, entry.name), join(destination, entry.name));
    }
    return;
  }
  if (!sourceStat.isFile()) return;

  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function normalizeTimestamps(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await normalizeTimestamps(path);
    await utimes(path, NORMALIZED_TIMESTAMP, NORMALIZED_TIMESTAMP);
  }
  await utimes(directory, NORMALIZED_TIMESTAMP, NORMALIZED_TIMESTAMP);
}

function productRole(product: ProductEntry): string {
  if (product.category === 'service') {
    return 'A sellable service implemented on the shared Client Operations runtime.';
  }
  if (product.category === 'vertical_pack') {
    return 'A configured workflow package for a specific market, installed on the shared Client Operations runtime; it is not a separate application binary.';
  }
  return 'A commercial delivery model describing how Black Label scopes, installs, operates, and reports on the shared Client Operations runtime; it is not a separate application binary.';
}

function buildReadme(product: ProductEntry): string {
  const definition = product.definition as {
    outcomes?: string[];
    workflows?: Array<{ name: string; outcome: string }>;
    connectors?: Array<{ label: string; required: boolean }>;
    readiness?: { status: string; summary: string; dependencies: string[] };
    scope?: string[];
    deliverables?: string[];
    operatingCadence?: string[];
    idealFor?: string[];
  };
  const lines = [
    `# ${product.name}`,
    '',
    `**Category:** ${product.categoryLabel}`,
    '',
    product.description,
    '',
    productRole(product),
    '',
    '## Product selection',
    '',
    `This archive selects \`${product.id}\` from Client Operations catalog ${CLIENT_OPS_CATALOG.catalogVersion}. The complete machine-readable definition is in \`PRODUCT-MANIFEST.json\`.`,
    '',
  ];

  const addList = (heading: string, values: string[] | undefined): void => {
    if (!values || values.length === 0) return;
    lines.push(`## ${heading}`, '', ...values.map((value) => `- ${value}`), '');
  };

  addList('Outcomes', definition.outcomes);
  if (definition.workflows?.length) {
    lines.push('## Included workflows', '');
    for (const workflow of definition.workflows) {
      lines.push(`- **${workflow.name}:** ${workflow.outcome}`);
    }
    lines.push('');
  }
  if (definition.connectors?.length) {
    lines.push('## Connector requirements', '');
    for (const connector of definition.connectors) {
      lines.push(`- ${connector.label}${connector.required ? ' (required)' : ' (optional)'}`);
    }
    lines.push('');
  }
  addList('Scope', definition.scope);
  addList('Deliverables', definition.deliverables);
  addList('Operating cadence', definition.operatingCadence);
  addList('Ideal for', definition.idealFor);

  if (definition.readiness) {
    lines.push(
      '## Readiness',
      '',
      `- Status: \`${definition.readiness.status}\``,
      `- ${definition.readiness.summary}`,
      ...definition.readiness.dependencies.map((item) => `- Setup dependency: ${item}`),
      '',
    );
  }

  lines.push(
    '## Included shared runtime',
    '',
    '- Black-and-gold Client Operations operator interface',
    '- Tenant-scoped API and reusable client-operations engine',
    '- Workflow execution, pause, retry, history, and idempotency foundations',
    '- Approve, Deny, and Hold review controls',
    '- Connector health, artifacts, verification receipts, and usage reporting',
    '- Automation, core, and database packages plus operating documentation',
    '',
    '## Provider setup truth',
    '',
    'External phone, CRM, publishing, helpdesk, messaging, commerce, and other provider credentials are intentionally not bundled. Required provider adapters and client-specific credentials remain setup-required until connected and verified in the target client environment.',
    '',
    '## Run locally',
    '',
    'Requires Node.js 22 or newer.',
    '',
    '```bash',
    'npm ci',
    'npm run typecheck',
    'npm exec -- vitest run packages/client-ops/test apps/client-ops-api/test apps/client-ops-ui/test packages/automation/test',
    'npm exec -- tsx apps/client-ops-api/src/server.ts',
    '```',
    '',
    'Open `http://127.0.0.1:8470`.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

function buildManifest(product: ProductEntry): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    packageVersion: CLIENT_OPS_CATALOG.catalogVersion,
    product: {
      ordinal: product.ordinal,
      category: product.category,
      categoryLabel: product.categoryLabel,
      id: product.id,
      name: product.name,
      description: product.description,
      role: productRole(product),
      definition: product.definition,
    },
    sharedRuntime: {
      independentlyRunnable: true,
      interfaceTheme: 'black-and-gold',
      rootFiles: [...ROOT_FILES],
      sourceDirectories: [...SHARED_SOURCE_DIRECTORIES],
    },
    providerSetup: {
      credentialsBundled: false,
      externalProvidersClaimedConnected: false,
      note: 'External provider adapters and client-specific credentials remain setup-required until connected and verified.',
    },
    exclusions: [
      'node_modules and dependency caches',
      '.storage and runtime databases',
      'environment files, credentials, private keys, and certificates',
      'build output, coverage, logs, and operating-system metadata',
    ],
  };
}

async function sha256File(path: string): Promise<string> {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  try {
    for await (const chunk of handle.readableWebStream()) {
      hash.update(Buffer.from(chunk));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function assertSafeOutputDirectory(path: string): void {
  const resolved = resolve(path);
  if (resolved === resolve('/') || resolved === resolve(homedir())) {
    throw new Error(`Refusing unsafe export directory: ${resolved}`);
  }
  if (!basename(resolved).startsWith('BlackLabel-Client-Operations-Products-')) {
    throw new Error(`Export directory must start with BlackLabel-Client-Operations-Products-: ${resolved}`);
  }
}

function validateArchive(archivePath: string, archiveRoot: string): void {
  const listing = execFileSync('unzip', ['-Z1', archivePath], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  if (!listing.includes(`${archiveRoot}/README.md`)) throw new Error(`${basename(archivePath)} is missing README.md`);
  if (!listing.includes(`${archiveRoot}/PRODUCT-MANIFEST.json`)) {
    throw new Error(`${basename(archivePath)} is missing PRODUCT-MANIFEST.json`);
  }
  const unsafe = listing.find((entry) => {
    const lower = entry.toLowerCase();
    return (
      lower.includes('/node_modules/') ||
      lower.includes('/.storage/') ||
      lower.includes('/.git/') ||
      lower.includes('/.cache/') ||
      /\/(?:\.env(?:\.[^/]*)?|[^/]*\.(?:db|sqlite|sqlite3|pem|key|p12|pfx|jks|keystore))(?:$|\/)/i.test(entry) ||
      /(?:-wal|-shm|-journal)$/.test(lower)
    );
  });
  if (unsafe) throw new Error(`${basename(archivePath)} contains excluded path: ${unsafe}`);
  execFileSync('unzip', ['-tqq', archivePath], { stdio: 'pipe' });
}

async function packageProduct(product: ProductEntry, stagingRoot: string): Promise<ProductIndexEntry> {
  const sequence = String(product.ordinal).padStart(2, '0');
  const productSlug = slug(product.name);
  const archiveRoot = `BlackLabel-${sequence}-${productSlug}`;
  const packageRoot = join(stagingRoot, archiveRoot);

  await mkdir(packageRoot, { recursive: true });
  for (const rootFile of ROOT_FILES) {
    await copySourceTree(join(REPO_ROOT, rootFile), join(packageRoot, rootFile));
  }
  for (const sourceDirectory of SHARED_SOURCE_DIRECTORIES) {
    await copySourceTree(join(REPO_ROOT, sourceDirectory), join(packageRoot, sourceDirectory));
  }

  await writeFile(join(packageRoot, 'README.md'), buildReadme(product), 'utf8');
  await writeFile(
    join(packageRoot, 'PRODUCT-MANIFEST.json'),
    `${JSON.stringify(buildManifest(product), null, 2)}\n`,
    'utf8',
  );
  await normalizeTimestamps(packageRoot);

  const archive = `${sequence}-${product.category}-${productSlug}.zip`;
  const archivePath = join(OUTPUT_DIR, archive);
  execFileSync('zip', ['-q', '-X', '-r', archivePath, archiveRoot], { cwd: stagingRoot, stdio: 'pipe' });
  validateArchive(archivePath, archiveRoot);

  const archiveStat = await stat(archivePath);
  return {
    ordinal: product.ordinal,
    category: product.category,
    id: product.id,
    name: product.name,
    archive,
    archiveRoot,
    bytes: archiveStat.size,
    sha256: await sha256File(archivePath),
  };
}

async function main(): Promise<void> {
  assertSafeOutputDirectory(OUTPUT_DIR);
  const products = buildProducts();
  const stagingRoot = await mkdtemp(join(tmpdir(), 'blacklabel-client-ops-products-'));

  await rm(OUTPUT_DIR, { force: true, recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  const indexEntries: ProductIndexEntry[] = [];
  try {
    for (const product of products) {
      const indexEntry = await packageProduct(product, stagingRoot);
      indexEntries.push(indexEntry);
      await rm(join(stagingRoot, indexEntry.archiveRoot), { force: true, recursive: true });
      process.stdout.write(`Packaged ${indexEntry.ordinal}/17: ${indexEntry.archive}\n`);
    }
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
  }

  const categoryCounts = {
    service: indexEntries.filter((entry) => entry.category === 'service').length,
    vertical_pack: indexEntries.filter((entry) => entry.category === 'vertical_pack').length,
    engagement_model: indexEntries.filter((entry) => entry.category === 'engagement_model').length,
  };
  if (indexEntries.length !== 17 || categoryCounts.service !== 8 || categoryCounts.vertical_pack !== 7 || categoryCounts.engagement_model !== 2) {
    throw new Error(`Invalid packaged catalog counts: ${JSON.stringify(categoryCounts)}`);
  }

  const index = {
    schemaVersion: '1.0.0',
    catalogVersion: CLIENT_OPS_CATALOG.catalogVersion,
    title: 'Black Label Client Operations Products',
    productCount: indexEntries.length,
    categoryCounts,
    classification: {
      service: 'Sellable service implemented on the shared runtime',
      vertical_pack: 'Configured workflow package installed on the shared runtime',
      engagement_model: 'Commercial delivery model for installing or operating the shared runtime',
    },
    providerTruth: 'External provider adapters and client credentials are setup-required and are not included.',
    products: indexEntries,
  };
  await writeFile(join(OUTPUT_DIR, 'PRODUCT-INDEX.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');

  const outputEntries = await readdir(OUTPUT_DIR);
  const zipCount = outputEntries.filter((entry) => entry.endsWith('.zip')).length;
  if (zipCount !== 17) throw new Error(`Expected exactly 17 ZIP archives in output, found ${zipCount}`);
  process.stdout.write(`Verified ${zipCount} ZIP archives in ${OUTPUT_DIR}\n`);
}

await main();
