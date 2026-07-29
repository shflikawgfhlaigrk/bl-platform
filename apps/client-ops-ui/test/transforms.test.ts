import { describe, expect, it } from 'vitest';
import {
  filterPortfolioProducts,
  filterConnectors,
  formatMoney,
  listFrom,
  portfolioReadinessTone,
  statusTone,
  transformCatalogPayload,
  transformInstalledConnectors,
  transformInstalledWorkflows,
  transformPortfolioDetailPayload,
  transformPortfolioPayload,
  transformReportingPayload,
  transformSetupPayload,
} from '../public/src/transforms.mjs';

describe('client operations data transforms', () => {
  it('unwraps canonical list envelopes without inventing records', () => {
    expect(listFrom({ data: [{ id: 'one' }] })).toEqual([{ id: 'one' }]);
    expect(listFrom({ data: { records: [] } }, ['records'])).toEqual([]);
    expect(listFrom(null)).toEqual([]);
  });

  it('merges catalog offerings with real installation state', () => {
    const result = transformCatalogPayload({
      data: {
        catalog: {
          catalogVersion: '1.2.3',
          services: [{ id: 'svc', name: 'Service', summary: 'Outcome', workflows: [{ id: 'wf' }], connectors: [{ id: 'crm' }], readiness: { status: 'foundation_ready' } }],
          verticalPacks: [{ id: 'pack', name: 'Pack', workflows: [], connectors: [] }],
          engagementModels: [{ id: 'managed', name: 'Managed' }],
        },
        installations: [{ id: 'inst', catalogKind: 'service', catalogId: 'svc', status: 'active' }],
      },
    });
    expect(result.catalogVersion).toBe('1.2.3');
    expect(result.services[0]).toMatchObject({ id: 'svc', installationId: 'inst', installed: true, workflowCount: 1, connectorCount: 1 });
    expect(result.verticalPacks[0]).toMatchObject({ id: 'pack', installed: false });
  });

  it('joins installed workflows to the latest run records', () => {
    const result = transformInstalledWorkflows({
      data: {
        installations: [{ id: 'inst', name: 'Workflow OS', workflows: [{ id: 'wf', name: 'Monthly reporting', status: 'ready', enabled: true, outcome: 'Publish report' }] }],
        runs: [{ id: 'run', installationId: 'inst', workflowId: 'wf', status: 'failed', requestedAt: '2026-07-15T12:00:00Z', error: 'provider unavailable' }],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ installationId: 'inst', id: 'wf', service: 'Workflow OS', status: 'failed', runId: 'run' });
  });

  it('flattens connector bindings and filters them by status and text', () => {
    const connectors = transformInstalledConnectors({
      data: {
        installations: [{ id: 'inst', name: 'AI Front Desk', connectors: [
          { id: 'crm', label: 'CRM', status: 'connected', credentialRef: 'cred_1', required: true },
          { id: 'phone', label: 'Telephony', status: 'pending', required: true },
        ] }],
      },
    });
    expect(connectors[0]).toMatchObject({ name: 'CRM', externalRef: 'cred_1', category: 'AI Front Desk' });
    expect(filterConnectors(connectors, 'tele', 'pending').map((item) => item.id)).toEqual(['phone']);
  });

  it('preserves setup progress and reporting cost as live values', () => {
    const setup = transformSetupPayload({ data: { installations: [{ id: 'inst', name: 'Service', onboarding: [{ id: 'step', title: 'Connect CRM', status: 'completed', required: true }] }] } });
    expect(setup[0].steps[0]).toMatchObject({ id: 'step', title: 'Connect CRM', status: 'completed' });

    const reporting = transformReportingPayload({ data: {
      summary: { eventCount: 2, totalCostCents: 1234, byProvider: [{ provider: 'OpenAI', costCents: 1234 }] },
      events: [], runs: [{ id: 'run', status: 'succeeded' }], receipts: [],
    } });
    expect(reporting.summary.totalCostCents).toBe(1234);
    expect(formatMoney(reporting.summary.totalCostCents)).toBe('$12.34');
  });

  it('uses gold for positive health states and no green brand tone', () => {
    expect(statusTone('connected')).toBe('gold');
    expect(statusTone('completed')).toBe('gold');
    expect(statusTone('failed')).toBe('danger');
  });

  it('normalizes the live portfolio contract without losing evidence or packageable features', () => {
    const result = transformPortfolioPayload({
      data: {
        summary: { total: 30, newCount: 18, existingCount: 12, verifiedCount: 1, attentionCount: 27, packageableFeatureCount: 4 },
        products: [{
          key: 'app.marketing',
          sourceId: 'marketing',
          name: 'Marketing',
          aliases: ['marketing'],
          origin: 'legacy_fleet',
          kind: 'application',
          familyKey: 'existing-products',
          sellable: true,
          packageMode: 'standalone_app',
          catalogReadiness: 'not_verified',
          readiness: 'not_verified',
          readinessSummary: 'Current proof is required.',
          sourceRepo: 'BlackLabelMarketing',
          sourceRefs: ['fleet status packet'],
          requiredSuiteKeys: ['fleet.marketing.acceptance'],
          allowedSuiteKeys: ['fleet.marketing.acceptance', 'fleet.marketing.email'],
          evidence: {
            latestTestStatus: 'passed',
            latestPackageStatus: 'requested',
            passedSuiteKeys: ['fleet.marketing.acceptance'],
            missingSuiteKeys: [],
            latestTestAt: '2026-07-15T12:00:00Z',
            latestPackageAt: '2026-07-15T12:05:00Z',
          },
          features: [{
            key: 'app.marketing.feature.email-automation',
            name: 'Marketing Email Automation',
            summary: 'Individually packageable email workflow.',
            packageable: true,
            catalogReadiness: 'not_verified',
            readiness: 'not_verified',
            requiredSuiteKeys: ['fleet.marketing.email'],
            allowedSuiteKeys: ['fleet.marketing.email', 'fleet.marketing.email.security'],
            evidence: { latestTestStatus: 'not_run', latestPackageStatus: 'not_run', passedSuiteKeys: [], missingSuiteKeys: ['fleet.marketing.email'] },
          }],
        }],
      },
    });

    expect(result.summary).toEqual({ total: 30, newCount: 18, existingCount: 12, verifiedCount: 1, attentionCount: 27, packageableFeatureCount: 4 });
    expect(result.products[0]).toMatchObject({
      key: 'app.marketing',
      derivedReadiness: 'not_verified',
      sourceRepo: 'BlackLabelMarketing',
      requiredSuiteKeys: ['fleet.marketing.acceptance'],
      allowedSuiteKeys: ['fleet.marketing.acceptance', 'fleet.marketing.email'],
      latestTest: { status: 'passed', finishedAt: '2026-07-15T12:00:00Z' },
      latestPackage: { status: 'requested', verifiedAt: '2026-07-15T12:05:00Z' },
    });
    expect(result.products[0].features[0]).toMatchObject({
      key: 'app.marketing.feature.email-automation',
      packageable: true,
      requiredSuiteKeys: ['fleet.marketing.email'],
      evidence: { missingSuiteKeys: ['fleet.marketing.email'] },
    });
  });

  it('filters the portfolio by origin, type, readiness, package state, and text together', () => {
    const products = transformPortfolioPayload({ data: { products: [
      {
        key: 'app.marketing', name: 'Marketing', aliases: ['email'], origin: 'legacy_fleet', kind: 'application',
        readiness: 'not_verified', evidence: { latestPackageStatus: 'requested' }, features: [],
      },
      {
        key: 'offer.sales', name: 'Sales Operator', aliases: [], origin: 'client_ops', kind: 'operator_service',
        readiness: 'foundation_ready', evidence: { latestPackageStatus: 'not_run' }, features: [],
      },
    ] } }).products;

    expect(filterPortfolioProducts(products, {
      query: 'email', origin: 'existing', kind: 'application', readiness: 'not_verified', packageState: 'requested',
    }).map((product) => product.key)).toEqual(['app.marketing']);
    expect(filterPortfolioProducts(products, { origin: 'new' }).map((product) => product.key)).toEqual(['offer.sales']);
  });

  it('keeps portfolio readiness truth distinct from positive gold states', () => {
    expect(portfolioReadinessTone('verified_working')).toBe('gold');
    expect(portfolioReadinessTone('not_verified')).toBe('warning');
    expect(portfolioReadinessTone('design_ready')).toBe('info');
    expect(portfolioReadinessTone('private_reference')).toBe('neutral');
  });

  it('joins product detail with tenant-scoped test and package history', () => {
    const result = transformPortfolioDetailPayload(
      { data: { product: { key: 'app.marketing', name: 'Marketing', readiness: 'not_verified', evidence: {}, features: [] } } },
      { data: [{ id: 'test_1', productKey: 'app.marketing', suiteKey: 'fleet.marketing.acceptance', status: 'passed' }] },
      { data: [{ id: 'package_1', productKey: 'app.marketing', version: '2026.07.15', status: 'verified', bytes: 1024 }] },
    );
    expect(result.product.key).toBe('app.marketing');
    expect(result.testRuns[0]).toMatchObject({ id: 'test_1', suiteKey: 'fleet.marketing.acceptance', status: 'passed' });
    expect(result.packages[0]).toMatchObject({ id: 'package_1', version: '2026.07.15', status: 'verified', bytes: 1024 });
    expect(transformPortfolioPayload(null).products).toEqual([]);
  });
});
