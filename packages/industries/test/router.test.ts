import { describe, expect, it } from 'vitest';
import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type PlatformEvent,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  getIndustryConfig,
  industriesMigrations,
  industriesRouter,
  type IndustriesDatabase,
} from '@blacklabel/industries';

async function setup() {
  const db = createTestDb<IndustriesDatabase>();
  await runMigrations(db, [...coreMigrations, ...industriesMigrations]);
  const events = new EventBus();
  const tenantA = await createTenant(asCoreDb(db), { name: 'Tenant A' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Tenant B' });
  const app = industriesRouter({ db, events, contracts: {} });
  return { db, events, tenantA, tenantB, app };
}

function headers(tenantId: string): Record<string, string> {
  return { 'x-tenant-id': tenantId };
}

describe('industries router', () => {
  it('requires the x-tenant-id header', async () => {
    const { app } = await setup();
    const res = await app.request('/');
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('tenant_header_missing');
  });

  it('rejects an unknown tenant', async () => {
    const { app } = await setup();
    const res = await app.request('/', { headers: headers('no-such-tenant') });
    expect(res.status).toBe(404);
  });

  it('GET / lists all industries in the canonical list envelope', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/', { headers: headers(tenantA.id) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toHaveLength(11);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.data[0]).toMatchObject({
      key: 'construction',
      label: 'Construction',
    });
    expect(body.data[0].counts.leadStages).toBeGreaterThanOrEqual(2);
  });

  it('GET / paginates', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/?limit=3&offset=8', { headers: headers(tenantA.id) });
    const body = (await res.json()) as any;
    expect(body.limit).toBe(3);
    expect(body.offset).toBe(8);
    expect(body.data.map((i: any) => i.key)).toEqual(['spa-wellness', 'tack-retail', 'window-cleaning']);
  });

  it('GET /:key returns the full config; 404 for unknown', async () => {
    const { app, tenantA } = await setup();
    const ok = await app.request('/law-firm', { headers: headers(tenantA.id) });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as any;
    expect(body.data.key).toBe('law-firm');
    expect(body.data.terminology.job).toBe('Matter');
    expect(body.data.leadStages.length).toBeGreaterThanOrEqual(2);

    const missing = await app.request('/underwater-basket-weaving', {
      headers: headers(tenantA.id),
    });
    expect(missing.status).toBe(404);
    const err = (await missing.json()) as any;
    expect(err.error.code).toBe('not_found');
  });

  it('GET /applied is 404 before any industry is applied', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/applied', { headers: headers(tenantA.id) });
    expect(res.status).toBe(404);
  });

  it('POST /:key/apply seeds the tenant and returns the applied state', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/window-cleaning/apply', {
      method: 'POST',
      headers: headers(tenantA.id),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.industryKey).toBe('window-cleaning');
    expect(body.data.leadStages.map((s: any) => s.key)).toEqual(
      getIndustryConfig('window-cleaning')!.leadStages.map((s) => s.key),
    );

    const applied = await app.request('/applied', { headers: headers(tenantA.id) });
    expect(applied.status).toBe(200);
    const appliedBody = (await applied.json()) as any;
    expect(appliedBody.data.industryKey).toBe('window-cleaning');
    expect(appliedBody.data.terminology.team_member).toBe('Technician');
  });

  it('POST /:key/apply is idempotent through the router', async () => {
    const { app, db, tenantA } = await setup();
    const first = await app.request('/hvac/apply', {
      method: 'POST',
      headers: headers(tenantA.id),
    });
    const second = await app.request('/hvac/apply', {
      method: 'POST',
      headers: headers(tenantA.id),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const rows = await db
      .selectFrom('industries_lead_stages')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .execute();
    expect(rows).toHaveLength(getIndustryConfig('hvac')!.leadStages.length);
  });

  it('POST /:key/apply 404s for an unknown industry', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/not-an-industry/apply', {
      method: 'POST',
      headers: headers(tenantA.id),
    });
    expect(res.status).toBe(404);
  });

  it('POST /:key/apply rejects a malformed JSON body', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/hvac/apply', {
      method: 'POST',
      headers: { ...headers(tenantA.id), 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('POST /:key/apply accepts an actor and records it in the audit log', async () => {
    const { app, db, tenantA } = await setup();
    const res = await app.request('/restaurant/apply', {
      method: 'POST',
      headers: { ...headers(tenantA.id), 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'user-42' }),
    });
    expect(res.status).toBe(200);

    const entries = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('action', '=', 'industries.industry.applied')
      .execute();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor).toBe('user-42');
  });

  it('emits industries.industry.applied through the router', async () => {
    const { app, events, tenantA } = await setup();
    const received: PlatformEvent[] = [];
    events.on('industries.industry.applied', (event) => {
      received.push(event);
    });

    await app.request('/spa-wellness/apply', { method: 'POST', headers: headers(tenantA.id) });

    expect(received).toHaveLength(1);
    expect(received[0]!.tenantId).toBe(tenantA.id);
    expect(received[0]!.payload).toEqual({ industryKey: 'spa-wellness' });
  });

  it('GET /terminology returns the tenant map after apply, 404 before', async () => {
    const { app, tenantA } = await setup();
    const before = await app.request('/terminology', { headers: headers(tenantA.id) });
    expect(before.status).toBe(404);

    await app.request('/medical-dental/apply', {
      method: 'POST',
      headers: headers(tenantA.id),
    });
    const after = await app.request('/terminology', { headers: headers(tenantA.id) });
    expect(after.status).toBe(200);
    const body = (await after.json()) as any;
    expect(body.data.customer).toBe('Patient');
    expect(body.data.invoice).toBe('Statement');
  });

  it("tenant isolation: B gets 404 on /applied after A applies, and B's apply leaves A untouched", async () => {
    const { app, tenantA, tenantB } = await setup();
    await app.request('/construction/apply', { method: 'POST', headers: headers(tenantA.id) });

    const bApplied = await app.request('/applied', { headers: headers(tenantB.id) });
    expect(bApplied.status).toBe(404);
    const bTerms = await app.request('/terminology', { headers: headers(tenantB.id) });
    expect(bTerms.status).toBe(404);

    await app.request('/law-firm/apply', { method: 'POST', headers: headers(tenantB.id) });

    const aApplied = await app.request('/applied', { headers: headers(tenantA.id) });
    const aBody = (await aApplied.json()) as any;
    expect(aBody.data.industryKey).toBe('construction');
    expect(aBody.data.terminology.quote).toBe('Bid');
    expect(aBody.data.leadStages.map((s: any) => s.key)).toEqual(
      getIndustryConfig('construction')!.leadStages.map((s) => s.key),
    );

    const bBody = (await (
      await app.request('/applied', { headers: headers(tenantB.id) })
    ).json()) as any;
    expect(bBody.data.industryKey).toBe('law-firm');
  });
});
