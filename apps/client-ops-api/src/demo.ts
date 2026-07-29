import type { Kysely } from '@blacklabel/db';
import {
  CLIENT_OPS_CATALOG,
  ClientOpsService,
  declareOwnedSourceConnector,
  type ClientOpsDatabase,
  type InstallationDetail,
} from '@blacklabel/client-ops';
import type { EventBus } from '@blacklabel/core';

const page = { limit: 100, offset: 0 } as const;

async function ensureServiceInstallations(
  service: ClientOpsService,
  tenantId: string,
): Promise<InstallationDetail[]> {
  const current = await service.listInstallations(tenantId, page);
  const byCatalogId = new Map(current.map((installation) => [installation.catalogId, installation]));
  const details: InstallationDetail[] = [];
  for (const offering of CLIENT_OPS_CATALOG.services) {
    const existing = byCatalogId.get(offering.id);
    details.push(existing
      ? await service.getInstallation(tenantId, existing.id)
      : await service.createInstallation(tenantId, {
          catalogKind: 'service',
          catalogId: offering.id,
          engagementModelId: offering.id === 'workflow-operating-system'
            ? 'workflow-automation-sprint'
            : 'managed-ai-operations',
        }, 'demo-bootstrap'));
  }
  return details;
}

async function activateWorkflowFoundation(
  service: ClientOpsService,
  tenantId: string,
  installation: InstallationDetail,
): Promise<InstallationDetail> {
  // Black Label's OWN tenant, provisioned deliberately: this row is what makes
  // the Workflow OS foundation ready for THIS tenant. Client tenants never get
  // one automatically — each connects its own source through the connector API,
  // otherwise every client would execute against our workflows. Run it before
  // the early return so a store seeded by an older build is upgraded too.
  await declareOwnedSourceConnector(
    service, tenantId, installation.id, 'operations-system',
    'local:black-label-owned:operations-system', 'demo-bootstrap',
  );
  if (installation.status === 'active') return installation;
  for (const binding of installation.connectors) {
    if (binding.connectorId === 'operations-system') continue; // owned-source row already connected above
    await service.updateConnector(tenantId, installation.id, binding.id, {
      status: 'connected',
      credentialRef: `local:${binding.connectorId}`,
      metadata: { scope: 'local_product_starter', provider: 'black_label_owned' },
      health: { status: 'verified', checkedAt: new Date().toISOString() },
    }, 'demo-bootstrap');
  }
  for (const step of installation.onboarding) {
    await service.updateOnboardingStep(tenantId, installation.id, step.id, {
      status: 'completed',
      evidence: { source: 'local_product_starter', verified: true },
    }, 'demo-bootstrap');
  }
  return service.updateInstallation(tenantId, installation.id, { status: 'active' }, 'demo-bootstrap');
}

async function seedWorkflowEvidence(
  db: Kysely<ClientOpsDatabase>,
  service: ClientOpsService,
  tenantId: string,
  installation: InstallationDetail,
): Promise<void> {
  const existingRuns = await service.listRuns(tenantId, page, installation.id);
  if (existingRuns.length === 0) {
    const completedRequest = await service.requestRun(tenantId, {
      installationId: installation.id,
      workflowId: installation.workflows[0]!.id,
      idempotencyKey: 'demo:scheduled-operation:completed',
      input: { source: 'local_product_starter', period: 'current_month' },
    }, 'demo-bootstrap');
    await service.updateRun(tenantId, completedRequest.run.id, { status: 'running' }, 'demo-bootstrap');
    const completed = await service.updateRun(tenantId, completedRequest.run.id, {
      status: 'succeeded',
      output: { summary: 'Monthly operating package assembled and verified.', recordsProcessed: 128 },
    }, 'demo-bootstrap');
    const artifact = await service.createArtifact(tenantId, {
      installationId: installation.id,
      runId: completed.id,
      kind: 'operations_report',
      name: 'Monthly_Operations_Package.json',
      uri: `client-ops://artifacts/${completed.id}/monthly-operations-package`,
      mediaType: 'application/json',
      sha256: '6e7f55a9333b4e7dc5444b27647f4c54813e7d12af611ec3404161a6c286250f',
      metadata: { sizeBytes: 24576, verificationStatus: 'verified' },
    }, 'demo-bootstrap');
    await service.createCompletionReceipt(tenantId, {
      installationId: installation.id,
      runId: completed.id,
      summary: 'Scheduled operation completed with an immutable evidence package.',
      verification: { status: 'verified', mode: 'local_readback', externalProviderClaimed: false },
      artifactIds: [artifact.id],
    }, 'demo-bootstrap');
    await service.recordUsage(tenantId, {
      installationId: installation.id,
      runId: completed.id,
      provider: 'black-label-local',
      model: null,
      metric: 'workflow_actions',
      quantity: 12,
      unit: 'actions',
      costCents: 184,
      metadata: { source: 'local_product_starter' },
    }, 'demo-bootstrap');

    const failedRequest = await service.requestRun(tenantId, {
      installationId: installation.id,
      workflowId: installation.workflows[1]!.id,
      idempotencyKey: 'demo:exception-recovery:failed',
      input: { source: 'local_product_starter', failureClass: 'connector_readback' },
    }, 'demo-bootstrap');
    await service.updateRun(tenantId, failedRequest.run.id, { status: 'running' }, 'demo-bootstrap');
    await service.updateRun(tenantId, failedRequest.run.id, {
      status: 'failed', error: 'External readback was unavailable; no external mutation was claimed.',
    }, 'demo-bootstrap');
  }

  const existingReviews = await db.selectFrom('client_ops_review_items').select('title')
    .where('tenant_id', '=', tenantId).execute();
  const titles = new Set(existingReviews.map((review) => review.title));
  const reviewInputs = [
    ['Approve monthly client delivery', 'high'],
    ['Review connector readback exception', 'high'],
    ['Confirm next workflow package', 'medium'],
  ] as const;
  for (const [title, priority] of reviewInputs) {
    if (titles.has(title)) continue;
    await service.createReview(tenantId, {
      installationId: installation.id,
      workflowId: installation.workflows[0]!.id,
      title,
      context: { priority, source: 'local_product_starter', externalMutationPending: false },
    }, 'demo-bootstrap');
  }
}

/**
 * Idempotent local data set. All services are installed so every product lane
 * is inspectable; only the owned Workflow OS foundation is activated. External
 * phone, CRM, publisher, helpdesk, private-agent, and data adapters stay pending.
 */
export async function seedClientOpsProductStarter(
  db: Kysely<ClientOpsDatabase>,
  events: EventBus,
  tenantId: string,
): Promise<void> {
  const service = new ClientOpsService(db, events);
  const installations = await ensureServiceInstallations(service, tenantId);
  const workflowInstallation = installations.find((item) => item.catalogId === 'workflow-operating-system');
  if (!workflowInstallation) throw new Error('Workflow Operating System installation missing after seed');
  const active = await activateWorkflowFoundation(service, tenantId, workflowInstallation);
  await seedWorkflowEvidence(db, service, tenantId, active);
}
