import type { Kysely } from '@blacklabel/db';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  type EventBus,
  type Pagination,
} from '@blacklabel/core';
import { canonicalManifestJson } from './manifest';
import {
  CLIENT_OPS_PORTFOLIO,
  getPortfolioFeature,
  getPortfolioProduct,
  type PortfolioFeatureDefinition,
  type PortfolioProductDefinition,
  type PortfolioReadiness,
} from './portfolio';
import type {
  ClientOpsDatabase,
  ClientOpsPortfolioPackageRow,
  ClientOpsPortfolioTestRunRow,
  PortfolioTargetKind,
} from './schema';

export interface PortfolioTestRun {
  id: string;
  productKey: string;
  targetKind: PortfolioTargetKind;
  targetKey: string;
  suiteKey: string;
  status: ClientOpsPortfolioTestRunRow['status'];
  requestedBy: string;
  sourceRevision: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  durationMs: number | null;
  summary: string | null;
  evidence: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioPackage {
  id: string;
  productKey: string;
  targetKind: PortfolioTargetKind;
  targetKey: string;
  version: string;
  status: ClientOpsPortfolioPackageRow['status'];
  requestedBy: string;
  artifactUri: string | null;
  sha256: string | null;
  bytes: number | null;
  manifest: unknown;
  builtAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioEvidenceSummary {
  latestTestStatus: ClientOpsPortfolioTestRunRow['status'] | 'not_run';
  latestPackageStatus: ClientOpsPortfolioPackageRow['status'] | 'not_run' | 'not_applicable';
  passedSuiteKeys: string[];
  missingSuiteKeys: string[];
  latestTestAt: string | null;
  latestPackageAt: string | null;
}

export interface PortfolioFeatureView extends PortfolioFeatureDefinition {
  readiness: PortfolioReadiness;
  evidence: PortfolioEvidenceSummary;
}

export interface PortfolioProductView extends Omit<PortfolioProductDefinition, 'features'> {
  readiness: PortfolioReadiness;
  evidence: PortfolioEvidenceSummary;
  features: PortfolioFeatureView[];
}

export interface PortfolioSummary {
  total: number;
  newCount: number;
  existingCount: number;
  verifiedCount: number;
  attentionCount: number;
  packageableFeatureCount: number;
}

type TargetDefinition = {
  product: PortfolioProductDefinition;
  targetKind: PortfolioTargetKind;
  targetKey: string;
  catalogReadiness: PortfolioReadiness;
  requiredSuiteKeys: string[];
  allowedSuiteKeys: string[];
  packageRequired: boolean;
};

function mapTestRun(row: ClientOpsPortfolioTestRunRow): PortfolioTestRun {
  return {
    id: row.id,
    productKey: row.product_key,
    targetKind: row.target_kind,
    targetKey: row.target_key,
    suiteKey: row.suite_key,
    status: row.status,
    requestedBy: row.requested_by,
    sourceRevision: row.source_revision,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    summary: row.summary,
    evidence: JSON.parse(row.evidence_json) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPackage(row: ClientOpsPortfolioPackageRow): PortfolioPackage {
  return {
    id: row.id,
    productKey: row.product_key,
    targetKind: row.target_kind,
    targetKey: row.target_key,
    version: row.version,
    status: row.status,
    requestedBy: row.requested_by,
    artifactUri: row.artifact_uri,
    sha256: row.sha256,
    bytes: row.bytes,
    manifest: JSON.parse(row.manifest_json) as unknown,
    builtAt: row.built_at,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function latestBySuite(rows: ClientOpsPortfolioTestRunRow[]): Map<string, ClientOpsPortfolioTestRunRow> {
  const result = new Map<string, ClientOpsPortfolioTestRunRow>();
  for (const row of rows) {
    if (!result.has(row.suite_key)) result.set(row.suite_key, row);
  }
  return result;
}

function deriveEvidence(
  definition: TargetDefinition,
  tests: ClientOpsPortfolioTestRunRow[],
  packages: ClientOpsPortfolioPackageRow[],
): { readiness: PortfolioReadiness; evidence: PortfolioEvidenceSummary } {
  if (definition.catalogReadiness === 'retired_merged' || definition.catalogReadiness === 'private_reference') {
    return {
      readiness: definition.catalogReadiness,
      evidence: {
        latestTestStatus: 'not_run', latestPackageStatus: 'not_applicable', passedSuiteKeys: [],
        missingSuiteKeys: [], latestTestAt: null, latestPackageAt: null,
      },
    };
  }

  const latestTests = latestBySuite(tests);
  const requiredRows = definition.requiredSuiteKeys
    .map((suiteKey) => latestTests.get(suiteKey))
    .filter((row): row is ClientOpsPortfolioTestRunRow => row !== undefined);
  const passedSuiteKeys = definition.requiredSuiteKeys
    .filter((suiteKey) => latestTests.get(suiteKey)?.status === 'passed');
  const missingSuiteKeys = definition.requiredSuiteKeys
    .filter((suiteKey) => latestTests.get(suiteKey)?.status !== 'passed');
  const latestTest = tests[0];
  const latestPackage = packages[0];
  const hasFailure = requiredRows.some((row) => row.status === 'failed' || row.status === 'blocked')
    || latestPackage?.status === 'failed'
    || latestPackage?.status === 'blocked';
  const testsPassed = missingSuiteKeys.length === 0;
  const packagePassed = !definition.packageRequired || latestPackage?.status === 'verified';
  const readiness: PortfolioReadiness = hasFailure
    ? 'failed'
    : testsPassed && packagePassed
      ? 'verified_working'
      : definition.catalogReadiness;

  return {
    readiness,
    evidence: {
      latestTestStatus: latestTest?.status ?? 'not_run',
      latestPackageStatus: definition.packageRequired ? (latestPackage?.status ?? 'not_run') : 'not_applicable',
      passedSuiteKeys,
      missingSuiteKeys,
      latestTestAt: latestTest?.finished_at ?? latestTest?.updated_at ?? null,
      latestPackageAt: latestPackage?.verified_at ?? latestPackage?.updated_at ?? null,
    },
  };
}

function validateTarget(
  productKey: string,
  targetKind: PortfolioTargetKind = 'product',
  targetKey?: string,
): TargetDefinition {
  const product = getPortfolioProduct(productKey);
  if (!product) throw ApiError.notFound('portfolio product not found');
  if (targetKind === 'product') {
    if (targetKey !== undefined && targetKey !== product.key) throw ApiError.badRequest('targetKey does not match product');
    return {
      product,
      targetKind,
      targetKey: product.key,
      catalogReadiness: product.catalogReadiness,
      requiredSuiteKeys: product.requiredSuiteKeys,
      allowedSuiteKeys: product.allowedSuiteKeys,
      packageRequired: product.packageMode !== 'private_reference' && product.catalogReadiness !== 'retired_merged',
    };
  }
  if (!targetKey) throw ApiError.badRequest('targetKey is required for a feature');
  const feature = getPortfolioFeature(product, targetKey);
  if (!feature) throw ApiError.notFound('portfolio feature not found');
  return {
    product,
    targetKind,
    targetKey: feature.key,
    catalogReadiness: feature.catalogReadiness,
    requiredSuiteKeys: feature.requiredSuiteKeys,
    allowedSuiteKeys: feature.allowedSuiteKeys,
    packageRequired: feature.packageable,
  };
}

export class PortfolioService {
  constructor(
    private readonly db: Kysely<ClientOpsDatabase>,
    private readonly events: EventBus,
  ) {}

  private async evidenceRows(tenantId: string): Promise<{
    tests: ClientOpsPortfolioTestRunRow[];
    packages: ClientOpsPortfolioPackageRow[];
  }> {
    const [tests, packages] = await Promise.all([
      this.db.selectFrom('client_ops_portfolio_test_runs').selectAll()
        .where('tenant_id', '=', tenantId).orderBy('created_at', 'desc').orderBy('id', 'desc').execute(),
      this.db.selectFrom('client_ops_portfolio_packages').selectAll()
        .where('tenant_id', '=', tenantId).orderBy('created_at', 'desc').orderBy('id', 'desc').execute(),
    ]);
    return { tests, packages };
  }

  private view(
    product: PortfolioProductDefinition,
    tests: ClientOpsPortfolioTestRunRow[],
    packages: ClientOpsPortfolioPackageRow[],
  ): PortfolioProductView {
    const productTests = tests.filter((row) => row.product_key === product.key && row.target_kind === 'product');
    const productPackages = packages.filter((row) => row.product_key === product.key && row.target_kind === 'product');
    const productEvidence = deriveEvidence(validateTarget(product.key), productTests, productPackages);
    const features = product.features.map((feature) => {
      const target = validateTarget(product.key, 'feature', feature.key);
      const featureEvidence = deriveEvidence(
        target,
        tests.filter((row) => row.product_key === product.key && row.target_kind === 'feature' && row.target_key === feature.key),
        packages.filter((row) => row.product_key === product.key && row.target_kind === 'feature' && row.target_key === feature.key),
      );
      return { ...feature, ...featureEvidence };
    });
    return { ...product, ...productEvidence, features };
  }

  async listPortfolio(tenantId: string): Promise<{ summary: PortfolioSummary; products: PortfolioProductView[] }> {
    const { tests, packages } = await this.evidenceRows(tenantId);
    const products = CLIENT_OPS_PORTFOLIO.map((product) => this.view(product, tests, packages));
    return {
      summary: {
        total: products.length,
        newCount: products.filter((product) => product.origin !== 'legacy_fleet').length,
        existingCount: products.filter((product) => product.origin === 'legacy_fleet').length,
        verifiedCount: products.filter((product) => product.readiness === 'verified_working').length,
        attentionCount: products.filter((product) => !['verified_working', 'retired_merged', 'private_reference'].includes(product.readiness)).length,
        packageableFeatureCount: products.flatMap((product) => product.features).filter((feature) => feature.packageable).length,
      },
      products,
    };
  }

  async getProduct(tenantId: string, productKey: string): Promise<PortfolioProductView> {
    const product = getPortfolioProduct(productKey);
    if (!product) throw ApiError.notFound('portfolio product not found');
    const { tests, packages } = await this.evidenceRows(tenantId);
    return this.view(product, tests, packages);
  }

  async listTestRuns(tenantId: string, productKey: string, page: Pagination): Promise<PortfolioTestRun[]> {
    validateTarget(productKey);
    const rows = await this.db.selectFrom('client_ops_portfolio_test_runs').selectAll()
      .where('tenant_id', '=', tenantId).where('product_key', '=', productKey)
      .orderBy('created_at', 'desc').orderBy('id', 'desc')
      .limit(page.limit).offset(page.offset).execute();
    return rows.map(mapTestRun);
  }

  async requestTestRun(
    tenantId: string,
    productKey: string,
    input: { suiteKey: string; targetKind?: PortfolioTargetKind; targetKey?: string; sourceRevision?: string },
    actor = 'system',
  ): Promise<PortfolioTestRun> {
    const target = validateTarget(productKey, input.targetKind, input.targetKey);
    if (!target.allowedSuiteKeys.includes(input.suiteKey)) throw ApiError.badRequest('suiteKey is not allowlisted for this target');
    if (target.allowedSuiteKeys.length === 0) throw ApiError.conflict('this portfolio target does not accept test requests');
    const timestamp = nowIso();
    const row: ClientOpsPortfolioTestRunRow = {
      id: id(), tenant_id: tenantId, product_key: productKey, target_kind: target.targetKind,
      target_key: target.targetKey, suite_key: input.suiteKey, status: 'queued', requested_by: actor,
      source_revision: input.sourceRevision?.trim() || null, started_at: null, finished_at: null,
      exit_code: null, duration_ms: null, summary: null, evidence_json: '{}',
      created_at: timestamp, updated_at: timestamp,
    };
    await this.db.insertInto('client_ops_portfolio_test_runs').values(row).execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'client_ops.portfolio_test.requested', 'client_ops.portfolio_test', row.id, {
      productKey, targetKind: row.target_kind, targetKey: row.target_key, suiteKey: row.suite_key,
    });
    await this.events.emit(tenantId, 'client_ops.portfolio_test.requested', {
      testRunId: row.id, productKey, targetKind: row.target_kind, targetKey: row.target_key, suiteKey: row.suite_key,
    });
    return mapTestRun(row);
  }

  async listPackages(tenantId: string, productKey: string, page: Pagination): Promise<PortfolioPackage[]> {
    validateTarget(productKey);
    const rows = await this.db.selectFrom('client_ops_portfolio_packages').selectAll()
      .where('tenant_id', '=', tenantId).where('product_key', '=', productKey)
      .orderBy('created_at', 'desc').orderBy('id', 'desc')
      .limit(page.limit).offset(page.offset).execute();
    return rows.map(mapPackage);
  }

  async requestPackage(
    tenantId: string,
    productKey: string,
    input: { version: string; targetKind?: PortfolioTargetKind; targetKey?: string },
    actor = 'system',
  ): Promise<PortfolioPackage> {
    const target = validateTarget(productKey, input.targetKind, input.targetKey);
    if (!target.packageRequired) throw ApiError.conflict('this portfolio target is not individually packageable');
    const timestamp = nowIso();
    const row: ClientOpsPortfolioPackageRow = {
      id: id(), tenant_id: tenantId, product_key: productKey, target_kind: target.targetKind,
      target_key: target.targetKey, version: input.version, status: 'requested', requested_by: actor,
      artifact_uri: null, sha256: null, bytes: null,
      manifest_json: canonicalManifestJson({ productKey, targetKind: target.targetKind, targetKey: target.targetKey, version: input.version }),
      built_at: null, verified_at: null, created_at: timestamp, updated_at: timestamp,
    };
    await this.db.insertInto('client_ops_portfolio_packages').values(row).execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'client_ops.portfolio_package.requested', 'client_ops.portfolio_package', row.id, {
      productKey, targetKind: row.target_kind, targetKey: row.target_key, version: row.version,
    });
    await this.events.emit(tenantId, 'client_ops.portfolio_package.requested', {
      packageId: row.id, productKey, targetKind: row.target_kind, targetKey: row.target_key, version: row.version,
    });
    return mapPackage(row);
  }
}
