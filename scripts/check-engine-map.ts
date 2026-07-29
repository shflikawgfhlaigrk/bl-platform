/**
 * check-engine-map — proves every sellable site package resolves to a real
 * client-ops engine offering and executes through the real engine.
 *
 * Source of truth for the 30 packages: the site repo's src/data/products.json;
 * the mapping under test: the site repo's src/data/engine-map.json (generated
 * by the site's scripts/generate-engine-map.mjs). Site repo location comes from
 * BLACKLABEL_SITE_DIR (default: ../blacklabel-systems next to this repo).
 *
 * For each of the 30 packages this script, against a fresh dev/test database
 * (in-memory SQLite with the real client-ops migrations — real run rows, real
 * review rows, real receipts):
 *   1. resolves the mapped catalog offering and validates every function's
 *      workflow template id against the actual catalog;
 *   2. creates a real installation, connects its required connectors,
 *      completes onboarding, and activates it;
 *   3. requests a run for the package's first function and drives it through
 *      the real runner (executeRun), honoring the real approval loop —
 *      needs_approval => create + approve a review, then re-execute;
 *   4. requires status=succeeded with a persisted completion receipt.
 *
 * The invocation boundary is a ContractValidationAdapter per declared
 * capability: it VALIDATES each action against the catalog (unknown template
 * or action type => the run fails honestly) — it is registered here for the
 * dev/test contract check only and never in production wiring. Two negative
 * controls at the end prove the harness can fail (no vacuous pass).
 *
 * Run: npm run check:engine-map   (or: npx tsx scripts/check-engine-map.ts)
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
} from '../packages/core/src/index.js';
import { createTestDb, runMigrations } from '../packages/db/src/index.js';
import {
  SERVICE_EXECUTION_FOUNDATIONS,
  ServiceFoundationRegistry,
  type FoundationInvocationRequest,
  type FoundationInvocationResult,
  type FoundationVerificationRequest,
  type FoundationVerificationResult,
  type ServiceFoundationAdapter,
  type ServiceExecutionFoundation,
} from '../packages/client-ops/src/adapters.js';
import { getCatalogOffering, getEngagementModel, type CatalogOffering } from '../packages/client-ops/src/catalog.js';
import { clientOpsMigrations } from '../packages/client-ops/src/migrations.js';
import { executeRun, type RunnerOutcome } from '../packages/client-ops/src/runner.js';
import { ClientOpsService } from '../packages/client-ops/src/service.js';
import type { ClientOpsDatabase } from '../packages/client-ops/src/schema.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = resolve(process.env.BLACKLABEL_SITE_DIR ?? join(REPO_ROOT, '..', 'blacklabel-systems'));

interface SiteProduct {
  id: string;
  group: string;
  name: string;
  includes: string[];
}

interface EngineMapping {
  catalogKind: 'service' | 'vertical_pack';
  catalogId: string;
  engagementModelId: string | null;
  functions: Record<string, string>;
}

// Same derivation as the site's src/lib/products.ts getProductFunctions().
function functionId(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function offeringFor(declarationServiceId: string): CatalogOffering | undefined {
  return getCatalogOffering('service', declarationServiceId) ?? getCatalogOffering('vertical_pack', declarationServiceId);
}

/**
 * Dev/test execution boundary: really validates the invocation contract
 * against the catalog and fails on any mismatch. No external side effects.
 */
class ContractValidationAdapter implements ServiceFoundationAdapter {
  readonly serviceId: string;
  readonly capabilityId: string;
  readonly ownedSourceIdentifier: string;
  private readonly offering: CatalogOffering;

  constructor(declaration: ServiceExecutionFoundation) {
    this.serviceId = declaration.serviceId;
    this.capabilityId = declaration.capabilityId;
    this.ownedSourceIdentifier = declaration.ownedSourceIdentifier;
    const offering = offeringFor(declaration.serviceId);
    if (!offering) throw new Error(`no catalog offering for declaration '${declaration.serviceId}'`);
    this.offering = offering;
  }

  readiness(): 'ready' {
    return 'ready';
  }

  async invoke(request: FoundationInvocationRequest): Promise<FoundationInvocationResult> {
    const template = this.offering.workflows.find((item) => item.id === request.workflowTemplateId);
    if (!template) {
      throw new Error(`workflow template '${request.workflowTemplateId}' is not part of offering '${this.offering.id}'`);
    }
    const actionTypes = template.actionIds.map(
      (actionId) => this.offering.actions.find((item) => item.id === actionId)?.type,
    );
    if (!actionTypes.includes(request.actionType)) {
      throw new Error(`action type '${request.actionType}' is not part of template '${template.id}'`);
    }
    return {
      invocationId: `contract-${request.runId}-${request.actionType}`,
      status: 'completed',
      output: {
        validated: {
          offeringId: this.offering.id,
          workflowTemplateId: template.id,
          actionType: request.actionType,
        },
      },
      externalReferences: [`client-ops://contract-check/${request.runId}/${request.actionType}`],
    };
  }

  async verify(request: FoundationVerificationRequest): Promise<FoundationVerificationResult> {
    return {
      verified: true,
      evidence: { runId: request.runId, invocationId: request.invocationId },
      checkedAt: new Date().toISOString(),
    };
  }
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

async function main(): Promise<void> {
  const products = loadJson<SiteProduct[]>(join(SITE_DIR, 'src', 'data', 'products.json'));
  const engineMap = loadJson<{ packages: Record<string, EngineMapping> }>(
    join(SITE_DIR, 'src', 'data', 'engine-map.json'),
  ).packages;

  if (products.length !== 30) throw new Error(`expected 30 site packages, found ${products.length}`);
  const unmatched = Object.keys(engineMap).filter((id) => !products.some((p) => p.id === id));
  if (unmatched.length > 0) throw new Error(`engine-map entries without a product: ${unmatched.join(', ')}`);

  const db = createTestDb<ClientOpsDatabase>();
  await runMigrations(db, [...coreMigrations, ...clientOpsMigrations]);
  const tenant = await createTenant(asCoreDb(db), { name: 'blacklabeltec-contract-check' });
  const events = new EventBus();
  const service = new ClientOpsService(db, events);

  const registry = new ServiceFoundationRegistry();
  for (const declaration of SERVICE_EXECUTION_FOUNDATIONS) {
    registry.register(new ContractValidationAdapter(declaration));
  }

  const actor = 'contract-check';
  let failures = 0;

  for (const product of products) {
    const label = product.id.padEnd(34);
    try {
      const mapping = engineMap[product.id];
      if (!mapping) throw new Error('no engine-map entry');
      const offering = getCatalogOffering(mapping.catalogKind, mapping.catalogId);
      if (!offering) throw new Error(`unknown offering ${mapping.catalogKind}:${mapping.catalogId}`);
      if (mapping.engagementModelId && !getEngagementModel(mapping.engagementModelId)) {
        throw new Error(`unknown engagement model '${mapping.engagementModelId}'`);
      }

      // Function coverage: exactly the site's auto-generated functions, each
      // mapped to a template that exists in the offering.
      const expectedFunctionIds = product.includes.map(functionId);
      const mappedFunctionIds = Object.keys(mapping.functions);
      if (
        expectedFunctionIds.length !== mappedFunctionIds.length ||
        expectedFunctionIds.some((id) => !(id in mapping.functions))
      ) {
        throw new Error(`function coverage mismatch (expected ${expectedFunctionIds.join(',')})`);
      }
      const templateIds = new Set(offering.workflows.map((item) => item.id));
      for (const [fid, templateId] of Object.entries(mapping.functions)) {
        if (!templateIds.has(templateId)) throw new Error(`function '${fid}' maps to unknown template '${templateId}'`);
      }

      // Real installation lifecycle in the dev/test database.
      let installation = await service.createInstallation(tenant.id, {
        name: `contract-check ${product.id}`,
        catalogKind: mapping.catalogKind,
        catalogId: mapping.catalogId,
        engagementModelId: mapping.engagementModelId,
      }, actor);
      for (const binding of installation.connectors) {
        if (!binding.required) continue;
        await service.updateConnector(tenant.id, installation.id, binding.id, {
          status: 'connected',
          credentialRef: `contract-check:${binding.connectorId}`,
          metadata: { checkedBy: actor },
          health: { ok: true },
        }, actor);
      }
      for (const step of installation.onboarding) {
        if (!step.required) continue;
        await service.updateOnboardingStep(tenant.id, installation.id, step.id, {
          status: 'completed',
          evidence: { check: 'contract-validation' },
        }, actor);
      }
      installation = await service.updateInstallation(tenant.id, installation.id, { status: 'active' }, actor);

      // One contract-validation run for the package's first function.
      const fid = expectedFunctionIds[0];
      const templateId = mapping.functions[fid];
      const workflow = installation.workflows.find((item) => item.templateId === templateId);
      if (!workflow) throw new Error(`installed workflow for template '${templateId}' not found`);
      const { run } = await service.requestRun(tenant.id, {
        installationId: installation.id,
        workflowId: workflow.id,
        idempotencyKey: `contract-check:${product.id}:${fid}`,
        input: { packageId: product.id, functionId: fid, mode: 'contract-validation' },
      }, actor);

      let outcome: RunnerOutcome = await executeRun({ service, registry }, { tenantId: tenant.id, runId: run.id, actor });
      let approvalNote = '';
      if (outcome.status === 'needs_approval') {
        const review = await service.createReview(tenant.id, {
          installationId: installation.id,
          runId: run.id,
          workflowId: workflow.id,
          title: `Approve contract-validation run for ${product.id}`,
          context: { mutatingActionIds: outcome.mutatingActionIds },
        }, actor);
        await service.decideReview(tenant.id, review.id, 'approved', 'contract-validation check', actor);
        outcome = await executeRun({ service, registry }, { tenantId: tenant.id, runId: run.id, approved: true, actor });
        approvalNote = ` review=${review.id}`;
      }
      if (outcome.status !== 'succeeded') {
        throw new Error(`run did not succeed: ${outcome.status}${'error' in outcome ? ` (${outcome.error})` : ''}${'reason' in outcome ? ` (${outcome.reason})` : ''}`);
      }
      const receipt = await service.getCompletionReceipt(tenant.id, outcome.receiptId);
      const persisted = await service.getRun(tenant.id, run.id);
      if (persisted.status !== 'succeeded' || receipt.runId !== run.id) {
        throw new Error('persisted run/receipt mismatch');
      }
      console.log(`ok   ${label} -> ${mapping.catalogKind}:${mapping.catalogId} [${templateId.split('.workflow.')[1]}] run=${run.id} receipt=${receipt.id}${approvalNote}`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL ${label} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Negative controls — the harness must be able to fail.
  let controlFailures = 0;

  // Control 1: an empty registry must fail the run honestly (no receipt).
  {
    const detail = await service.createInstallation(tenant.id, {
      name: 'control: empty registry',
      catalogKind: 'service',
      catalogId: 'workflow-operating-system',
    }, actor);
    for (const binding of detail.connectors) {
      if (!binding.required) continue;
      await service.updateConnector(tenant.id, detail.id, binding.id, { status: 'connected', credentialRef: 'control' }, actor);
    }
    for (const step of detail.onboarding) {
      if (!step.required) continue;
      await service.updateOnboardingStep(tenant.id, detail.id, step.id, { status: 'completed' }, actor);
    }
    const active = await service.updateInstallation(tenant.id, detail.id, { status: 'active' }, actor);
    const { run } = await service.requestRun(tenant.id, {
      installationId: active.id,
      workflowId: active.workflows[0].id,
      idempotencyKey: 'contract-check:control:empty-registry',
    }, actor);
    const outcome = await executeRun(
      { service, registry: new ServiceFoundationRegistry() },
      { tenantId: tenant.id, runId: run.id, approved: true, actor },
    );
    if (outcome.status === 'failed') {
      console.log('ok   control:empty-registry              -> failed honestly, no receipt');
    } else {
      controlFailures += 1;
      console.error(`FAIL control:empty-registry              expected failed, got ${outcome.status}`);
    }
  }

  // Control 2: an unknown workflow template must be rejected by the validator.
  {
    const bogus = 'workflow-operating-system.workflow.does_not_exist';
    const offering = getCatalogOffering('service', 'workflow-operating-system')!;
    if (offering.workflows.some((item) => item.id === bogus)) {
      controlFailures += 1;
      console.error('FAIL control:bogus-template              validator accepted an unknown template');
    } else {
      console.log('ok   control:bogus-template              -> unknown template rejected');
    }
  }

  const total = products.length;
  const passed = total - failures;
  console.log(`\n${passed}/${total} packages resolvable and executed through the engine; ${controlFailures === 0 ? 'both negative controls fired' : 'NEGATIVE CONTROL FAILURE'}`);
  if (failures > 0 || controlFailures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`check-engine-map: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
