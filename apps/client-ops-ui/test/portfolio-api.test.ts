import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTenantId } from '../public/js/api.js';
import { clientOpsApi } from '../public/js/client-ops-api.js';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  setTenantId(null);
  vi.unstubAllGlobals();
});

describe('client operations portfolio API client', () => {
  it('uses the exact encoded read endpoints and tenant context', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ data: {} });
    }));
    setTenantId('tenant_test');

    await clientOpsApi.portfolio();
    await clientOpsApi.portfolioProduct('app/marketing');
    await clientOpsApi.portfolioTestRuns('app/marketing');
    await clientOpsApi.portfolioPackages('app/marketing');

    expect(calls.map((call) => call.url)).toEqual([
      '/api/client-ops/portfolio',
      '/api/client-ops/portfolio/app%2Fmarketing',
      '/api/client-ops/portfolio/app%2Fmarketing/test-runs',
      '/api/client-ops/portfolio/app%2Fmarketing/packages',
    ]);
    expect(calls.every((call) => (call.init.headers as Record<string, string>)['x-tenant-id'] === 'tenant_test')).toBe(true);
  });

  it('posts allowlisted suite and versioned package targets with mutation headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ data: { status: 'queued' } });
    }));

    await clientOpsApi.runPortfolioTest('app.marketing', 'fleet.marketing.email', {
      targetKind: 'feature',
      targetKey: 'app.marketing.feature.email-automation',
      sourceRevision: 'abc123',
    });
    await clientOpsApi.buildPortfolioPackage('app.marketing', '2026.07.15', {
      targetKind: 'feature',
      targetKey: 'app.marketing.feature.email-automation',
    });

    expect(calls[0].url).toBe('/api/client-ops/portfolio/app.marketing/test-runs');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      suiteKey: 'fleet.marketing.email',
      targetKind: 'feature',
      targetKey: 'app.marketing.feature.email-automation',
      sourceRevision: 'abc123',
    });
    expect(calls[1].url).toBe('/api/client-ops/portfolio/app.marketing/packages');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      version: '2026.07.15',
      targetKind: 'feature',
      targetKey: 'app.marketing.feature.email-automation',
    });
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(call.init.method).toBe('POST');
      expect(headers['content-type']).toBe('application/json');
      expect(headers['x-mags-csrf']).toBe('1');
      expect(headers['idempotency-key']).toBeTruthy();
    }
  });
});
