import { describe, expect, it } from 'vitest';
import { id, nowIso } from '@blacklabel/core';
import { CLIENT_OPS_PORTFOLIO } from '../src';
import { headers, setup } from './helpers';

describe('client-ops product portfolio', () => {
  it('has exactly 18 new offerings and 12 existing products with no source-claim verification', async () => {
    expect(CLIENT_OPS_PORTFOLIO).toHaveLength(30);
    expect(new Set(CLIENT_OPS_PORTFOLIO.map((product) => product.key)).size).toBe(30);
    expect(CLIENT_OPS_PORTFOLIO.filter((product) => product.origin !== 'legacy_fleet')).toHaveLength(18);
    expect(CLIENT_OPS_PORTFOLIO.filter((product) => product.origin === 'legacy_fleet')).toHaveLength(12);
    expect(CLIENT_OPS_PORTFOLIO.some((product) => product.catalogReadiness === 'verified_working')).toBe(false);

    const marketing = CLIENT_OPS_PORTFOLIO.find((product) => product.key === 'app.marketing');
    expect(marketing?.features.map((feature) => feature.key)).toContain('app.marketing.feature.email-automation');
    expect(CLIENT_OPS_PORTFOLIO.find((product) => product.key === 'app.lead-database')?.catalogReadiness).toBe('retired_merged');
    expect(CLIENT_OPS_PORTFOLIO.find((product) => product.key === 'reference.ace')?.catalogReadiness).toBe('private_reference');

    const { app, tenantA } = await setup();
    const response = await app.request('/portfolio', { headers: headers(tenantA) });
    expect(response.status).toBe(200);
    const data = ((await response.json()) as any).data;
    expect(data.summary).toMatchObject({ total: 30, newCount: 18, existingCount: 12, verifiedCount: 0 });
    expect(data.products).toHaveLength(30);
    expect(data.products.find((product: any) => product.key === 'product.black-label-assistance')).toMatchObject({
      readiness: 'design_ready', evidence: { latestTestStatus: 'not_run', latestPackageStatus: 'not_run' },
    });
  });

  it('queues only allowlisted product and feature tests and records audit events', async () => {
    const { app, db, tenantA, events } = await setup();
    const seen: string[] = [];
    events.on('*', (event) => {
      seen.push(event.type);
    });

    const queued = await app.request('/portfolio/app.marketing/test-runs', {
      method: 'POST', headers: headers(tenantA),
      body: JSON.stringify({ suiteKey: 'fleet.marketing.acceptance', targetKind: 'product' }),
    });
    expect(queued.status).toBe(202);
    expect(((await queued.json()) as any).data).toMatchObject({ status: 'queued', suiteKey: 'fleet.marketing.acceptance' });

    const featureQueued = await app.request('/portfolio/app.marketing/test-runs', {
      method: 'POST', headers: headers(tenantA),
      body: JSON.stringify({
        suiteKey: 'fleet.marketing.email', targetKind: 'feature',
        targetKey: 'app.marketing.feature.email-automation',
      }),
    });
    expect(featureQueued.status).toBe(202);

    const arbitrary = await app.request('/portfolio/app.marketing/test-runs', {
      method: 'POST', headers: headers(tenantA),
      body: JSON.stringify({ suiteKey: 'shell.rm-everything' }),
    });
    expect(arbitrary.status).toBe(400);

    const privatePackage = await app.request('/portfolio/reference.ace/packages', {
      method: 'POST', headers: headers(tenantA), body: JSON.stringify({ version: '1.0.0' }),
    });
    expect(privatePackage.status).toBe(409);
    expect(seen).toEqual(['client_ops.portfolio_test.requested', 'client_ops.portfolio_test.requested']);
    const audits = await db.selectFrom('audit_log').select(['action']).where('tenant_id', '=', tenantA.id)
      .where('action', '=', 'client_ops.portfolio_test.requested').execute();
    expect(audits).toHaveLength(2);
  });

  it('derives verified_working only from tenant-scoped passed acceptance and verified package evidence', async () => {
    const { app, db, tenantA, tenantB } = await setup();
    const timestamp = nowIso();
    await db.insertInto('client_ops_portfolio_test_runs').values({
      id: id(), tenant_id: tenantA.id, product_key: 'app.signals', target_kind: 'product', target_key: 'app.signals',
      suite_key: 'fleet.signals.acceptance', status: 'passed', requested_by: 'acceptance-runner',
      source_revision: 'abc123', started_at: timestamp, finished_at: timestamp, exit_code: 0, duration_ms: 42,
      summary: 'Acceptance passed', evidence_json: '{"receipt":"test-receipt"}', created_at: timestamp, updated_at: timestamp,
    }).execute();
    await db.insertInto('client_ops_portfolio_test_runs').values({
      id: id(), tenant_id: tenantA.id, product_key: 'app.signals', target_kind: 'product', target_key: 'app.signals',
      suite_key: 'fleet.signals.security', status: 'passed', requested_by: 'security-runner',
      source_revision: 'abc123', started_at: timestamp, finished_at: timestamp, exit_code: 0, duration_ms: 43,
      summary: 'Hardcoded-secret and security gates passed', evidence_json: '{"receipt":"security-receipt"}', created_at: timestamp, updated_at: timestamp,
    }).execute();
    await db.insertInto('client_ops_portfolio_packages').values({
      id: id(), tenant_id: tenantA.id, product_key: 'app.signals', target_kind: 'product', target_key: 'app.signals',
      version: '1.0.0', status: 'verified', requested_by: 'package-runner', artifact_uri: 'artifact://signals/1.0.0',
      sha256: 'a'.repeat(64), bytes: 1024, manifest_json: '{"verified":true}', built_at: timestamp,
      verified_at: timestamp, created_at: timestamp, updated_at: timestamp,
    }).execute();

    const alpha = await app.request('/portfolio/app.signals', { headers: headers(tenantA) });
    expect(((await alpha.json()) as any).data.product).toMatchObject({
      readiness: 'verified_working',
      evidence: { passedSuiteKeys: ['fleet.signals.acceptance', 'fleet.signals.security'], missingSuiteKeys: [], latestPackageStatus: 'verified' },
    });
    const beta = await app.request('/portfolio/app.signals', { headers: headers(tenantB) });
    expect(((await beta.json()) as any).data.product).toMatchObject({
      readiness: 'not_verified', evidence: { latestTestStatus: 'not_run', latestPackageStatus: 'not_run' },
    });
  });

  it('keeps a failed required gate visible even when a package is verified', async () => {
    const { app, db, tenantA } = await setup();
    const timestamp = nowIso();
    await db.insertInto('client_ops_portfolio_test_runs').values({
      id: id(), tenant_id: tenantA.id, product_key: 'app.academy', target_kind: 'product', target_key: 'app.academy',
      suite_key: 'fleet.academy.acceptance', status: 'failed', requested_by: 'acceptance-runner',
      source_revision: null, started_at: timestamp, finished_at: timestamp, exit_code: 1, duration_ms: 10,
      summary: 'Buyer path failed', evidence_json: '{}', created_at: timestamp, updated_at: timestamp,
    }).execute();
    const response = await app.request('/portfolio/app.academy', { headers: headers(tenantA) });
    expect(((await response.json()) as any).data.product.readiness).toBe('failed');
  });
});
