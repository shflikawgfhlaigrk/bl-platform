import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ServiceFoundationRegistry, type FoundationInvocationRequest } from '../src/adapters';
import {
  createSqlLeadReader,
  LEAD_BY_ID_SQL,
  SalesOperatorAdapter,
  type LeadReader,
  type SalesLead,
  type SqlRunner,
} from '../src/foundations/sales-operator';
import { executeRun } from '../src/runner';
import { ClientOpsService } from '../src/service';
import { createInstallation, createRun, headers, setup } from './helpers';

/**
 * Runtime proof for the Sales Operator execution adapter
 * (service `sales-operator`, capability `client_ops.sales.process_lead`,
 * owned source `BlackLabelLeadsAPI`). Mirrors foundations-data-operations-service.test.ts
 * but drives a `sales-operator` installation.
 *
 * The adapter does ONE READ-ONLY unit of lead work over an owned source. In production the
 * injected reader is `createSqlLeadReader(run)`, which SELECTs one provenance-linked row from
 * the real `leads` table on psql :5433 (db `blacklabel`, ~580k rows). Here we inject a
 * DETERMINISTIC in-memory reader over a SYNTHETIC, PII-free lead with the same shape, so every
 * validate/enrich/route/mask assertion is exact and hermetic — nothing is hardcoded in the
 * adapter, and no real prospect data is committed.
 *
 * The two safety-critical properties proven end-to-end through the real runner:
 *   (a) a read-only run reaches `succeeded` and writes a real, persisted completion receipt;
 *   (b) a mutating step (`upsert_lead`) gates to `accepted`, so the runner halts the run
 *       `not_ready` with ZERO completion receipts — a gated send can never masquerade as done.
 */

/**
 * A SYNTHETIC, PII-free lead mirroring the psql `leads` schema. `example-roofing.test` /
 * 555-line number are reserved fictional values — NOT a real prospect. `email_status:'verified'`
 * is the stored registry convention the adapter honestly relabels to `'listed'` on the way out.
 */
const FIXTURE_LEAD: SalesLead = {
  id: 'lead-1',
  name: 'Example Roofing Co',
  category_norm: 'roofing',
  subtype: 'roofing_contractor',
  contact_name: 'Test Person',
  email: 'jordan@example-roofing.test',
  email_status: 'verified',
  phone: '4045550137',
  website: 'https://example-roofing.test',
  city: 'Smyrna',
  state: 'GA',
  region: 'Georgia',
  deliverability_tier: 'personal',
  source: 'osm_places',
};

const RAW_EMAIL = FIXTURE_LEAD.email as string;
const RAW_PHONE = FIXTURE_LEAD.phone as string;
const RAW_CONTACT = FIXTURE_LEAD.contact_name as string;
const MASKED_EMAIL = 'j•••@example-roofing.test';
const MASKED_PHONE = '••••••••37';

/** Deterministic, read-only reader: returns the fixture for its id, null otherwise (proves absence handling). */
function deterministicReader(): LeadReader {
  return {
    async getLeadById(id: string): Promise<SalesLead | null> {
      return id === FIXTURE_LEAD.id ? { ...FIXTURE_LEAD } : null;
    },
  };
}

function directRequest(overrides: Partial<FoundationInvocationRequest> = {}): FoundationInvocationRequest {
  return {
    tenantId: 't1',
    installationId: 'i1',
    runId: 'r-direct',
    workflowTemplateId: 'lead_intake',
    actionType: 'process_lead',
    input: { leadId: 'lead-1' },
    ...overrides,
  };
}

/**
 * Activate an installation for a specific catalog offering. `createActiveInstallation`
 * in ./helpers hardcodes `workflow-operating-system`, so this reproduces its
 * connector/onboarding/activate dance while overriding the catalogId — the documented
 * way to build a `sales-operator` install through the harness.
 */
async function createActiveInstallationFor(
  app: Awaited<ReturnType<typeof setup>>['app'],
  tenant: { id: string },
  catalogId: string,
) {
  const installation = await createInstallation(app, tenant, { catalogId });
  for (const binding of installation.connectors) {
    if (!binding.required) continue;
    const response = await app.request(`/installations/${installation.id}/connectors/${binding.id}`, {
      method: 'PATCH',
      headers: headers(tenant),
      body: JSON.stringify({
        status: 'connected',
        credentialRef: `test:${binding.connectorId}`,
        metadata: { accountId: 'demo-account' },
        health: { ok: true },
      }),
    });
    if (response.status !== 200) throw new Error(`connect binding failed: ${response.status} ${await response.text()}`);
  }
  for (const step of installation.onboarding) {
    if (!step.required) continue;
    const response = await app.request(`/installations/${installation.id}/onboarding/${step.id}`, {
      method: 'PATCH',
      headers: headers(tenant),
      body: JSON.stringify({ status: 'completed', evidence: { verified: true } }),
    });
    if (response.status !== 200) throw new Error(`complete onboarding failed: ${response.status} ${await response.text()}`);
  }
  const response = await app.request(`/installations/${installation.id}`, {
    method: 'PATCH',
    headers: headers(tenant),
    body: JSON.stringify({ status: 'active' }),
  });
  if (response.status !== 200) throw new Error(`activate installation failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { data: any }).data;
}

/** POST a run against an explicit workflow id (helpers.createRun hardcodes workflows[0]). */
async function requestRunAgainst(
  app: Awaited<ReturnType<typeof setup>>['app'],
  tenant: { id: string },
  installationId: string,
  workflowId: string,
  input: unknown,
  idempotencyKey: string,
) {
  const response = await app.request('/runs', {
    method: 'POST',
    headers: headers(tenant),
    body: JSON.stringify({ installationId, workflowId, idempotencyKey, input }),
  });
  if (response.status !== 201) throw new Error(`create run failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { data: any }).data;
}

/**
 * Seed a purely READ-ONLY installed workflow (validate→enrich→route) into an active
 * sales-operator installation. Both catalog sales workflows terminate in a write step
 * (`upsert_lead` / `send_followup`) that the adapter must gate to `accepted`, so no catalog
 * workflow can reach `succeeded`; this seeds the all-read-only action sequence needed to
 * exercise the adapter's completion path through the real runner + service persistence.
 */
async function seedReadOnlyWorkflow(
  db: Awaited<ReturnType<typeof setup>>['db'],
  tenant: { id: string },
  installationId: string,
): Promise<string> {
  const workflowId = randomUUID();
  const now = new Date().toISOString();
  const actions = [
    { id: 'ro-1', name: 'Validate lead', type: 'validate_lead', description: 'Read-only validation.', connectorId: null, mutatesExternalState: false },
    { id: 'ro-2', name: 'Enrich lead', type: 'enrich_lead', description: 'Read-only enrichment.', connectorId: null, mutatesExternalState: false },
    { id: 'ro-3', name: 'Route lead', type: 'route_lead', description: 'Read-only routing.', connectorId: null, mutatesExternalState: false },
  ];
  await db
    .insertInto('client_ops_installed_workflows')
    .values({
      id: workflowId,
      tenant_id: tenant.id,
      installation_id: installationId,
      template_id: 'sales-operator.workflow.readonly_lead_pipeline',
      name: 'Read-only lead pipeline',
      outcome: 'A provenance-linked lead is validated, enriched, and routed read-only.',
      trigger_json: JSON.stringify({
        id: 'sales-operator.trigger.readonly_lead_pipeline',
        name: 'Read-only lead',
        type: 'event',
        description: 'Internal read-only pipeline.',
        eventType: 'sales.lead.readonly',
      }),
      actions_json: JSON.stringify(actions),
      approval_json: JSON.stringify({ id: 'sales-operator.approval.readonly_lead_pipeline', name: 'No approval', when: 'never', decisions: [] }),
      enabled: 1,
      status: 'ready',
      created_at: now,
      updated_at: now,
    })
    .execute();
  return workflowId;
}

describe('sales-operator foundation adapter', () => {
  it('drives a requested read-only sales run to success and writes a real, persisted completion receipt', async () => {
    const { db, events, app, tenantA } = await setup();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallationFor(app, tenantA, 'sales-operator');
    expect(installation.catalogId).toBe('sales-operator');

    const workflowId = await seedReadOnlyWorkflow(db, tenantA, installation.id);
    const run = await requestRunAgainst(app, tenantA, installation.id, workflowId, { leadId: 'lead-1' }, 'sales-ro-run-1');
    expect(run.status).toBe('requested');

    const adapter = new SalesOperatorAdapter({ reader: deterministicReader() });
    expect(adapter.readiness()).toBe('ready');

    const registry = new ServiceFoundationRegistry();
    registry.register(adapter);

    const outcome = await executeRun(
      { service, registry },
      { tenantId: tenantA.id, runId: run.id, approved: true },
    );

    expect(outcome.status).toBe('succeeded');

    // State change is real and persisted, not a returned literal.
    const persisted = await service.getRun(tenantA.id, run.id);
    expect(persisted.status).toBe('succeeded');

    if (outcome.status === 'succeeded') {
      const receipt = await service.getCompletionReceipt(tenantA.id, outcome.receiptId);
      expect(receipt.runId).toBe(run.id);
      expect(receipt.summary).toContain('client_ops.sales.process_lead');
      // Evidence deep-links to the module-owned lead the read-only pipeline processed.
      expect(JSON.stringify(receipt.verification)).toContain('blacklabel://BlackLabelLeadsAPI/leads/lead-1');

      // Output is derived from the injected lead — prove it is real, masked, and honestly labeled.
      const firstResult = outcome.results[0];
      expect(firstResult).toBeDefined();
      const output = firstResult.output as {
        readOnly: boolean;
        lead: { email: string | null; email_status: string; phone: string | null; contact_name: null };
        validation: { contactable: boolean };
      };
      expect(output.readOnly).toBe(true);
      expect(output.validation.contactable).toBe(true);
      expect(output.lead.email).toBe(MASKED_EMAIL);
      expect(output.lead.phone).toBe(MASKED_PHONE);
      expect(output.lead.contact_name).toBeNull();
      // §5.1: the stored 'verified' is relabeled to the honest 'listed' — never re-surfaced.
      expect(output.lead.email_status).toBe('listed');

      // No raw PII (email / phone / contact name) or the 'verified' overclaim survives anywhere.
      const serialized = JSON.stringify(outcome.results);
      expect(serialized).not.toContain(RAW_EMAIL);
      expect(serialized).not.toContain(RAW_PHONE);
      expect(serialized).not.toContain(RAW_CONTACT);
      expect(serialized).not.toContain('verified');
      expect(serialized).toContain(MASKED_EMAIL);
    }
  });

  it('gates a mutating step to accepted — run goes not_ready with zero completion receipts', async () => {
    const { db, events, app, tenantA } = await setup();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallationFor(app, tenantA, 'sales-operator');
    // Catalog `lead_intake` = [validate_lead(RO), enrich_lead(RO), upsert_lead(WRITE)]; it sorts first.
    const leadIntake = installation.workflows.find((w: any) => w.templateId.endsWith('lead_intake'));
    expect(leadIntake).toBeDefined();
    const run = await requestRunAgainst(app, tenantA, installation.id, leadIntake.id, { leadId: 'lead-1' }, 'sales-mut-run-1');

    const registry = new ServiceFoundationRegistry();
    registry.register(new SalesOperatorAdapter({ reader: deterministicReader() }));

    // approved:true bypasses the runner's pre-invoke approval gate, so the write step is actually
    // reached and the ADAPTER's own accepted-gate is what halts the run.
    const outcome = await executeRun(
      { service, registry },
      { tenantId: tenantA.id, runId: run.id, approved: true },
    );

    expect(outcome.status).toBe('not_ready');
    if (outcome.status === 'not_ready') {
      expect(outcome.reason).toContain('accepted');
    }

    // The run never reached a terminal success, and NO completion receipt was minted.
    const persisted = await service.getRun(tenantA.id, run.id);
    expect(persisted.status).not.toBe('succeeded');
    await expect(service.listCompletionReceipts(tenantA.id, { limit: 10, offset: 0 })).resolves.toHaveLength(0);
  });

  it('fails honestly with no receipt when no adapter is connected — never fabricates success', async () => {
    const { db, events, app, tenantA } = await setup();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallationFor(app, tenantA, 'sales-operator');
    const run = await createRun(app, tenantA, installation);

    const outcome = await executeRun(
      { service, registry: new ServiceFoundationRegistry() },
      { tenantId: tenantA.id, runId: run.id, approved: true },
    );

    expect(outcome.status).toBe('failed');
    const persisted = await service.getRun(tenantA.id, run.id);
    expect(persisted.status).toBe('failed');
    await expect(service.listCompletionReceipts(tenantA.id, { limit: 10, offset: 0 })).resolves.toHaveLength(0);
  });

  it('is declared and fails honestly when no lead reader is wired — the anti-vapor guarantee', async () => {
    const declared = new SalesOperatorAdapter();
    expect(declared.readiness()).toBe('declared');
    // Identity still matches the declaration, so it registers…
    const registry = new ServiceFoundationRegistry();
    registry.register(declared);
    // …but the registry refuses to invoke a not-ready adapter (never a fake completion).
    await expect(registry.invoke('client_ops.sales.process_lead', directRequest())).rejects.toThrow();
    // A direct invoke on the declared adapter returns an honest failure, not an invented lead.
    const failed = await declared.invoke(directRequest());
    expect(failed.status).toBe('failed');
    expect(failed.externalReferences).toHaveLength(0);
  });

  it('processes one provenance-linked lead read-only (masked, honestly labeled) and gates every send', async () => {
    const registry = new ServiceFoundationRegistry();
    registry.register(new SalesOperatorAdapter(deterministicReader()));

    // Read-only action → completed, with masked PII and the honest 'listed' relabel.
    const done = await registry.invoke('client_ops.sales.process_lead', directRequest({ actionType: 'process_lead' }));
    expect(done.status).toBe('completed');
    const out = done.output as {
      readOnly: boolean;
      lead: { id: string; email: string | null; email_status: string; phone: string | null; contact_name: null; deliverability_tier: string | null };
      validation: { contactable: boolean; hasContactableEmail: boolean; hasCurrentPhone: boolean };
      routing: { channel: string; nextStep: string };
    };
    expect(out.readOnly).toBe(true);
    expect(out.lead.id).toBe('lead-1');
    expect(out.lead.email).toBe(MASKED_EMAIL);
    expect(out.lead.phone).toBe(MASKED_PHONE);
    expect(out.lead.contact_name).toBeNull();
    expect(out.lead.email_status).toBe('listed');
    expect(out.lead.deliverability_tier).toBe('personal');
    expect(out.validation).toMatchObject({ contactable: true, hasContactableEmail: true, hasCurrentPhone: true });
    expect(out.routing.channel).toBe('personal_email');
    expect(done.externalReferences).toContain('blacklabel://BlackLabelLeadsAPI/leads/lead-1');
    // No overclaim and no raw PII escapes the read-only surface.
    expect(JSON.stringify(done)).not.toContain('verified');
    expect(JSON.stringify(done)).not.toContain(RAW_EMAIL);

    // Send / write action → ACCEPTED (computed proposal, dispatched:false), NEVER completed.
    const send = await registry.invoke('client_ops.sales.process_lead', directRequest({ runId: 'r-send', actionType: 'send_followup' }));
    expect(send.status).toBe('accepted');
    const sendOut = send.output as { dispatched: boolean; gated: boolean };
    expect(sendOut.dispatched).toBe(false);
    expect(sendOut.gated).toBe(true);

    // Unrecognized action → also gated to accepted (fail-safe: unknown never completes).
    const unknown = await registry.invoke('client_ops.sales.process_lead', directRequest({ runId: 'r-unknown', actionType: 'frobnicate_lead' }));
    expect(unknown.status).toBe('accepted');

    // Absent lead on a read-only action → honest failure, not a fabricated row.
    const absent = await registry.invoke('client_ops.sales.process_lead', directRequest({ runId: 'r-absent', actionType: 'validate_lead', input: { leadId: 'missing-999' } }));
    expect(absent.status).toBe('failed');
    expect(absent.externalReferences).toHaveLength(0);
  });

  it('production wiring: createSqlLeadReader issues one parameterized SELECT and maps owned columns', async () => {
    // LEAD_BY_ID_SQL is a single parameterized read — no driver, no writes, no interpolation.
    expect(LEAD_BY_ID_SQL).toContain('SELECT');
    expect(LEAD_BY_ID_SQL).toContain('FROM leads WHERE id = $1');
    expect(LEAD_BY_ID_SQL).not.toMatch(/insert|update|delete|;/i);

    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const fakeRunner: SqlRunner = async (sql, params) => {
      calls.push({ sql, params });
      return [
        {
          id: 2108,
          name: 'Owned Source Row',
          category_norm: 'restaurant',
          subtype: 'restaurant',
          contact_name: 'redacted',
          email: 'owner@some-domain.test',
          email_status: 'verified',
          phone: '4045550137',
          website: null,
          city: 'Smyrna',
          state: 'GA',
          region: 'Georgia',
          deliverability_tier: 'personal',
          source: 'osm_places',
        },
      ];
    };
    const reader = createSqlLeadReader(fakeRunner);
    const lead = await reader.getLeadById('2108');
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe(LEAD_BY_ID_SQL);
    expect(calls[0].params).toEqual(['2108']);
    expect(lead).toMatchObject({ id: '2108', category_norm: 'restaurant', email_status: 'verified', deliverability_tier: 'personal' });

    // Empty result set → null (never a fabricated lead).
    const emptyReader = createSqlLeadReader(async () => []);
    await expect(emptyReader.getLeadById('does-not-exist')).resolves.toBeNull();
  });
});
