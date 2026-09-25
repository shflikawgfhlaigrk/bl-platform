import {
  ServiceFoundationRegistry,
} from './adapters';
import { WorkflowExecutionAdapter, type WorkflowExecutionDeps } from './foundations/workflow-execution';
export { WorkflowExecutionAdapter } from './foundations/workflow-execution';
import { ExecutiveOperationsHqAdapter, type ExecutiveOperationsHqConfig } from './foundations/executive-operations-hq';
import {
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
export interface ReadyFoundationDeps {
  /** The buyer's tenant-scoped workflow tables and event bus. Required for execution. */
  workflow?: WorkflowExecutionDeps;
  /** Server-validated tenant/installation mappings for HQ packet sources. */
  hq?: ExecutiveOperationsHqConfig;
  /** @deprecated Ignored; an unbound directory cannot authorize a tenant. */
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
  registry.register(new WorkflowExecutionAdapter(deps.workflow));
  registry.register(
    new ExecutiveOperationsHqAdapter(deps.hq),
  );
  registry.register(new DataOperationsAdapter(deps.dataReader ? { reader: deps.dataReader } : {}));
  registry.register(new SalesOperatorAdapter(deps.leadReader ? { reader: deps.leadReader } : {}));
  return registry;
}

/**
 * Production wiring takes explicit buyer dependencies. It never attaches the
 * owner's property database or another tenant's process-wide data by default.
 */
export function registerProductionFoundations(
  registry: ServiceFoundationRegistry = new ServiceFoundationRegistry(),
  deps: ReadyFoundationDeps = {},
): ServiceFoundationRegistry {
  return registerReadyFoundations(registry, deps);
}
