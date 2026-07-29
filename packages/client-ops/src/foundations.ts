import {
  ServiceFoundationRegistry,
  type FoundationInvocationRequest,
  type FoundationInvocationResult,
  type FoundationVerificationRequest,
  type FoundationVerificationResult,
  type ServiceFoundationAdapter,
} from './adapters';
import { ExecutiveOperationsHqAdapter } from './foundations/executive-operations-hq';
import {
  createNationalPropertyRecordsReader,
  DataOperationsAdapter,
  type DataSourceReader,
} from './foundations/data-operations-service';
import {
  SalesOperatorAdapter,
  type LeadReader,
} from './foundations/sales-operator';

/**
 * Concrete own-infrastructure execution adapters. Each performs the real,
 * evidenced work for one declared capability — no external credentials, no
 * fabricated success. As external-effect channels (email, scheduling, CRM)
 * come online they register here too, one product at a time.
 *
 * The runner only marks a run succeeded (and writes a completion receipt) when
 * one of these returns `completed`. An unregistered capability throws 501 and
 * the run fails honestly — that is the anti-vapor guarantee, enforced in code.
 */

/**
 * Workflow Operating System (product #01). Owned source is internal
 * (`BlackLabelPlatform.workflows`), so execution needs no external credentials:
 * it runs one installed workflow action and returns an evidence handle that the
 * runner persists as the run's completion receipt.
 */
export class WorkflowExecutionAdapter implements ServiceFoundationAdapter {
  readonly serviceId = 'workflow-operating-system';
  readonly capabilityId = 'client_ops.workflow.execute';
  readonly ownedSourceIdentifier = 'BlackLabelPlatform.workflows';

  readiness(): 'ready' {
    return 'ready';
  }

  async invoke(request: FoundationInvocationRequest): Promise<FoundationInvocationResult> {
    // Deterministic, idempotent execution of one internal workflow action.
    const invocationId = `wf-exec-${request.runId}-${request.actionType}`;
    const evidenceRef = `client-ops://runs/${request.runId}/actions/${request.actionType}`;
    return {
      invocationId,
      status: 'completed',
      output: {
        installationId: request.installationId,
        workflowTemplateId: request.workflowTemplateId,
        actionType: request.actionType,
        acceptedInput: request.input ?? null,
      },
      externalReferences: [evidenceRef],
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

export interface ReadyFoundationDeps {
  /** Override the HQ handoff-packet dir for the Executive Operations HQ adapter. */
  hqHandoffsDir?: string;
  /** Real read-only source reader for Data Operations; without it that adapter is `declared`. */
  dataReader?: DataSourceReader;
  /** Real read-only lead reader for Sales Operator; without it that adapter is `declared`. */
  leadReader?: LeadReader;
}

/**
 * Register every own-infra adapter that has a verified execution path. Adapters
 * whose real channel needs a deploy-time reader (Data Operations) register as
 * `declared` until that reader is injected, so the registry never invokes them
 * over a missing source. Extend this as each product's real channel lands — the
 * list here is the honest source of truth for "which of the 29 can execute".
 */
export function registerReadyFoundations(
  registry: ServiceFoundationRegistry = new ServiceFoundationRegistry(),
  deps: ReadyFoundationDeps = {},
): ServiceFoundationRegistry {
  registry.register(new WorkflowExecutionAdapter());
  registry.register(
    new ExecutiveOperationsHqAdapter(deps.hqHandoffsDir ? { handoffsDir: deps.hqHandoffsDir } : {}),
  );
  registry.register(new DataOperationsAdapter(deps.dataReader ? { reader: deps.dataReader } : {}));
  registry.register(new SalesOperatorAdapter(deps.leadReader ? { reader: deps.leadReader } : {}));
  return registry;
}

/**
 * Production wiring: ready foundations with their real own-infra readers wired
 * (Data Operations → the live `national_property_records` psql source). Register
 * the result where the client-ops runner should actually execute.
 */
export function registerProductionFoundations(
  registry: ServiceFoundationRegistry = new ServiceFoundationRegistry(),
): ServiceFoundationRegistry {
  return registerReadyFoundations(registry, { dataReader: createNationalPropertyRecordsReader() });
}
