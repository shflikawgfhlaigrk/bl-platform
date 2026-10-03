import type { ClientOpsService, InstallationDetail, Run } from './service';
import {
  SERVICE_EXECUTION_FOUNDATIONS,
  ServiceFoundationRegistry,
  type FoundationInvocationResult,
  type FoundationVerificationResult,
} from './adapters';
import { resolveTenantFoundation } from './tenant-foundations';

/**
 * Execution runner — the missing engine that drives a `requested` run to a real,
 * evidenced terminal state. It NEVER fabricates success: a run only reaches
 * `succeeded` (with a completion receipt) if every action was actually invoked
 * through a connected, ready ServiceFoundationAdapter. If no adapter is
 * connected, the registry throws 501 and the run fails honestly.
 *
 * External-state-mutating workflows require an explicit `approved` decision
 * before the runner will invoke them; otherwise it returns `needs_approval`
 * and leaves the run untouched (the route/review layer owns creating the
 * review and re-invoking with `approved: true`).
 */

export interface RunnerDeps {
  service: ClientOpsService;
  registry: ServiceFoundationRegistry;
}

export interface RunnerArgs {
  tenantId: string;
  runId: string;
  /** Set true only when an approving review for this run has been decided. */
  approved?: boolean;
  actor?: string;
}

interface NormalizedAction {
  id: string;
  type: string;
  mutatesExternalState: boolean;
}

export type RunnerOutcome =
  | { status: 'needs_approval'; run: Run; mutatingActionIds: string[] }
  | { status: 'not_ready'; run: Run; reason: string }
  | { status: 'failed'; run: Run; error: string; results: ActionResult[] }
  | { status: 'succeeded'; run: Run; receiptId: string; results: ActionResult[] };

export type ActionResult = { actionId: string } & FoundationInvocationResult;

/** Defensive: installed workflow actions are stored as `unknown[]`; fail closed on mutation. */
function normalizeActions(raw: unknown): NormalizedAction[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((item, index) => {
    const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    return {
      id: typeof obj.id === 'string' ? obj.id : `action-${index}`,
      type: typeof obj.type === 'string' ? obj.type : 'unknown',
      // Unknown provenance ⇒ treat as mutating so it can never auto-run without approval.
      mutatesExternalState:
        typeof obj.mutatesExternalState === 'boolean' ? obj.mutatesExternalState : true,
    };
  });
}

function capabilityForService(catalogId: string): string | undefined {
  return SERVICE_EXECUTION_FOUNDATIONS.find((f) => f.serviceId === catalogId)?.capabilityId;
}

export async function executeRun(deps: RunnerDeps, args: RunnerArgs): Promise<RunnerOutcome> {
  const { service, registry } = deps;
  const { tenantId, runId } = args;
  const actor = args.actor ?? 'client-ops-runner';

  const run = await service.getRun(tenantId, runId);
  if (run.status !== 'requested') {
    throw new Error(`run ${runId} is not runnable (status=${run.status})`);
  }

  const installation: InstallationDetail = await service.getInstallation(tenantId, run.installationId);
  const workflow = installation.workflows.find((w) => w.id === run.workflowId);
  const verifications: Array<{ actionId: string; invocationId: string } & FoundationVerificationResult> = [];

  const fail = async (error: string, results: ActionResult[] = []): Promise<RunnerOutcome> => {
    const failed = await service.updateRun(tenantId, runId, { status: 'failed', output: { results, verifications }, error }, actor);
    return { status: 'failed', run: failed, error, results };
  };

  if (!workflow) return fail('installed workflow not found for run');

  if (!installation.readiness.ready) {
    const reason = [
      installation.readiness.pendingRequiredConnectorIds.length
        ? `pending connectors: ${installation.readiness.pendingRequiredConnectorIds.join(', ')}`
        : '',
      installation.readiness.incompleteRequiredStepIds.length
        ? `incomplete onboarding: ${installation.readiness.incompleteRequiredStepIds.join(', ')}`
        : '',
    ].filter(Boolean).join('; ') || 'installation not ready';
    return { status: 'not_ready', run, reason };
  }

  const capabilityId = capabilityForService(installation.catalogId);
  if (!capabilityId) {
    return fail(`no execution foundation declared for service '${installation.catalogId}'`);
  }

  // Tenant isolation gate. The live adapters bind to Black Label's own sources,
  // so a tenant that has not connected its OWN source for this capability must
  // stop here — awaiting connection, never silently executing against our data.
  // An unregistered or not-ready adapter is left alone so registry.invoke can
  // still fail honestly (501/409) exactly as before.
  const foundation = await resolveTenantFoundation(service, tenantId, capabilityId, registry, run.installationId);
  if (foundation?.connectionStatus === 'awaiting_connection') {
    return {
      status: 'not_ready',
      run,
      reason: `awaiting client connection: this tenant has no connected connector for owned source '${foundation.ownedSourceIdentifier}'`,
    };
  }
  const ownedSourceRef = foundation?.ownedSourceConnection ?? undefined;

  const actions = normalizeActions(workflow.actions);
  if (actions.length === 0) return fail('workflow has no actions to execute');

  const mutatingActionIds = actions.filter((a) => a.mutatesExternalState).map((a) => a.id);
  if (mutatingActionIds.length > 0 && !args.approved) {
    // Do not run, do not fabricate. Await an explicit approved review.
    return { status: 'needs_approval', run, mutatingActionIds };
  }

  await service.updateRun(tenantId, runId, { status: 'running' }, actor);

  const results: ActionResult[] = [];
  for (const action of actions) {
    let result: FoundationInvocationResult;
    try {
      result = await registry.invoke(capabilityId, {
        tenantId,
        installationId: run.installationId,
        runId,
        workflowTemplateId: workflow.templateId,
        actionType: action.type,
        input: run.input,
        // Adapters must reach the client's own instance through this ref.
        ownedSourceRef,
      });
    } catch (err) {
      // e.g. 501 "adapter not connected" — honest failure, never a fake receipt.
      const message = err instanceof Error ? err.message : String(err);
      return fail(`action '${action.id}' could not execute: ${message}`, results);
    }
    results.push({ actionId: action.id, ...result });
    if (result.status === 'failed') {
      return fail(`action '${action.id}' failed`, results);
    }
    if (result.status === 'accepted') {
      // Async foundation: leave the run 'running'; a later callback finalizes it.
      return { status: 'not_ready', run: await service.getRun(tenantId, runId), reason: `action '${action.id}' accepted for async completion` };
    }
    // An adapter's completion claim is not destination verification. Every
    // completed action must be read back before it can enter a success receipt.
    try {
      const verification = await registry.verify(capabilityId, {
        tenantId,
        installationId: run.installationId,
        runId: run.id,
        invocationId: result.invocationId,
        expected: result.output,
        ownedSourceRef,
      });
      verifications.push({ actionId: action.id, invocationId: result.invocationId, ...verification });
      if (verification.verified !== true || !Number.isFinite(Date.parse(verification.checkedAt))) {
        return fail(`action '${action.id}' did not pass result verification`, results);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(`action '${action.id}' could not be verified: ${message}`, results);
    }
  }

  const externalReferences = [...new Set(results.flatMap((r) => r.externalReferences))].sort();
  const succeeded = await service.updateRun(
    tenantId,
    runId,
    { status: 'succeeded', output: { results, verifications } },
    actor,
  );
  const receipt = await service.createCompletionReceipt(
    tenantId,
    {
      installationId: run.installationId,
      runId,
      summary: `${workflow.name}: ${actions.length} action(s) completed via ${capabilityId}`,
      verification: {
        capabilityId,
        invocationIds: results.map((r) => r.invocationId),
        externalReferences,
        actions: verifications,
      },
      artifactIds: [],
    },
    actor,
  );

  return { status: 'succeeded', run: succeeded, receiptId: receipt.id, results };
}
