import { createHash } from 'node:crypto';
import { ApiError, EventBus } from '@blacklabel/core';
import type { Kysely } from '@blacklabel/db';
import { addTag, createNotification, createTask, type WorkflowsDatabase } from '@blacklabel/workflows';
import { z } from 'zod';
import type {
  FoundationInvocationRequest, FoundationInvocationResult, FoundationVerificationRequest,
  FoundationVerificationResult, ServiceFoundationAdapter,
} from '../adapters';
import { canonicalManifestJson } from '../manifest';
import type { ClientOpsDatabase, ClientOpsExecutionJournalRow } from '../schema';
import { ClientOpsService, type Run } from '../service';

export type WorkflowExecutionDatabase = ClientOpsDatabase & WorkflowsDatabase;
export interface WorkflowExecutionDeps {
  db: Kysely<WorkflowExecutionDatabase>;
  events: EventBus;
}

const text = z.string().trim().min(1).max(4000);
const stepId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const stepSchema = z.discriminatedUnion('type', [
  z.object({ id: stepId, type: z.literal('create_task'), config: z.object({
    title: text, description: text.optional(), assigneeUserId: text.optional(),
    dueAt: z.string().datetime({ offset: true }).optional(),
    relatedEntityType: text.optional(), relatedEntityId: text.optional(),
  }).strict() }).strict(),
  z.object({ id: stepId, type: z.literal('notify_user'), config: z.object({
    userId: text, title: text, body: text.optional(),
  }).strict() }).strict(),
  z.object({ id: stepId, type: z.literal('add_tag'), config: z.object({
    entityType: text, entityId: text, tag: text,
  }).strict() }).strict(),
]);
const planSchema = z.object({ steps: z.array(stepSchema).min(1).max(100) });
type Step = z.infer<typeof stepSchema>;
type RefTable = 'workflows_tasks' | 'workflows_notifications' | 'workflows_tags'
  | 'client_ops_runs' | 'client_ops_review_items' | 'client_ops_execution_journal';
type Reference = { table: RefTable; id: string; sha256: string };
type JournalValue = { output: unknown; references: Reference[] };
const digest = (value: unknown): string => createHash('sha256').update(canonicalManifestJson(value)).digest('hex');

/** Local platform workflows with atomic, durable checkpoints and destination readback. */
export class WorkflowExecutionAdapter implements ServiceFoundationAdapter {
  readonly serviceId = 'workflow-operating-system';
  readonly capabilityId = 'client_ops.workflow.execute';
  readonly ownedSourceIdentifier = 'BlackLabelPlatform.workflows';
  constructor(private readonly deps?: WorkflowExecutionDeps) {}

  readiness(): 'ready' | 'declared' { return this.deps ? 'ready' : 'declared'; }

  private database(): Kysely<WorkflowExecutionDatabase> {
    if (!this.deps) throw ApiError.conflict('Workflow database is not connected');
    return this.deps.db;
  }

  private service(db = this.database()): ClientOpsService {
    return new ClientOpsService(db, new EventBus());
  }

  private async context(request: FoundationInvocationRequest): Promise<Run> {
    const run = await this.service().getRun(request.tenantId, request.runId);
    if (run.installationId !== request.installationId || digest(run.input) !== digest(request.input)) {
      throw ApiError.conflict('Invocation does not match the persisted run');
    }
    if (run.status !== 'running') throw ApiError.conflict('Workflow run is not running');
    const source = request.ownedSourceRef;
    if (!source || source.ownedSourceIdentifier !== this.ownedSourceIdentifier) {
      throw ApiError.conflict('Connect this tenant to its platform workflow database');
    }
    const bindings = await this.service().listConnectedOwnedSources(request.tenantId);
    if (!bindings.some((b) => b.bindingId === source.bindingId && b.credentialRef === source.credentialRef)) {
      throw ApiError.conflict('Workflow connection is no longer available for this tenant');
    }
    return run;
  }

  private async reference(db: Kysely<WorkflowExecutionDatabase>, tenantId: string, table: RefTable, id: string): Promise<Reference> {
    const row = await db.selectFrom(table).selectAll().where('tenant_id', '=', tenantId).where('id', '=', id).executeTakeFirst();
    if (!row) throw ApiError.conflict(`Destination record is missing: ${table}/${id}`);
    return { table, id, sha256: digest(row) };
  }

  private async checkpoint(
    request: FoundationInvocationRequest, run: Run, key: string, input: unknown,
    work: (db: Kysely<WorkflowExecutionDatabase>) => Promise<JournalValue>,
  ): Promise<ClientOpsExecutionJournalRow> {
    const requestHash = digest(input);
    return this.database().transaction().execute(async (tx) => {
      const previous = await tx.selectFrom('client_ops_execution_journal').selectAll()
        .where('tenant_id', '=', request.tenantId).where('root_run_id', '=', run.rootRunId)
        .where('action_key', '=', key).executeTakeFirst();
      if (previous) {
        if (previous.request_sha256 !== requestHash) throw ApiError.conflict('Retry changed an already checkpointed action');
        return previous;
      }
      const value = await work(tx);
      const row: ClientOpsExecutionJournalRow = {
        id: `wf-${digest([request.tenantId, run.rootRunId, key])}`,
        tenant_id: request.tenantId, installation_id: request.installationId,
        root_run_id: run.rootRunId, action_key: key, request_sha256: requestHash,
        output_json: canonicalManifestJson(value.output), references_json: canonicalManifestJson(value.references),
        created_at: new Date().toISOString(),
      };
      await tx.insertInto('client_ops_execution_journal').values(row).execute();
      return row;
    });
  }

  private plan(input: unknown): Step[] {
    const { steps } = planSchema.parse(input);
    if (new Set(steps.map((s) => s.id)).size !== steps.length) throw ApiError.badRequest('Workflow step IDs must be unique');
    return steps;
  }

  private async executeStep(request: FoundationInvocationRequest, run: Run, step: Step): Promise<ClientOpsExecutionJournalRow> {
    return this.checkpoint(request, run, `step:${step.id}`, step, async (tx) => {
      let recordId: string;
      let table: RefTable;
      // Module services write the business object and audit in this SAME transaction.
      // Module events are emitted after commit through the adapter's completion event.
      const transactionEvents = new EventBus();
      if (step.type === 'create_task') {
        if (step.config.assigneeUserId) await this.requireUser(tx, request.tenantId, step.config.assigneeUserId);
        recordId = (await createTask(tx as unknown as Kysely<WorkflowsDatabase>, transactionEvents, request.tenantId, step.config, 'client-ops-runner')).id;
        table = 'workflows_tasks';
      } else if (step.type === 'notify_user') {
        await this.requireUser(tx, request.tenantId, step.config.userId);
        recordId = (await createNotification(tx as unknown as Kysely<WorkflowsDatabase>, transactionEvents, request.tenantId, step.config, 'client-ops-runner')).id;
        table = 'workflows_notifications';
      } else {
        recordId = (await addTag(tx as unknown as Kysely<WorkflowsDatabase>, request.tenantId, step.config, 'client-ops-runner')).row.id;
        table = 'workflows_tags';
      }
      const ref = await this.reference(tx, request.tenantId, table, recordId);
      return { output: { stepId: step.id, type: step.type, recordId, table }, references: [ref] };
    });
  }

  private async requireUser(db: Kysely<WorkflowExecutionDatabase>, tenantId: string, userId: string): Promise<void> {
    const user = await db.selectFrom('users').select('id').where('tenant_id', '=', tenantId).where('id', '=', userId).executeTakeFirst();
    if (!user) throw ApiError.notFound('Workflow assignee is not a user in this tenant');
  }

  async invoke(request: FoundationInvocationRequest): Promise<FoundationInvocationResult> {
    const run = await this.context(request);
    let row: ClientOpsExecutionJournalRow;
    const key = `action:${request.actionType}`;
    switch (request.actionType) {
      case 'load_checklist': {
        const steps = this.plan(request.input);
        row = await this.checkpoint(request, run, key, steps, async () => ({
          output: { planSha256: digest(steps), steps }, references: [],
        }));
        break;
      }
      case 'execute_actions': {
        const steps = this.plan(request.input);
        const loaded = await this.database().selectFrom('client_ops_execution_journal').selectAll()
          .where('tenant_id', '=', request.tenantId).where('root_run_id', '=', run.rootRunId)
          .where('action_key', '=', 'action:load_checklist').executeTakeFirst();
        if (!loaded || loaded.request_sha256 !== digest(steps)) throw ApiError.conflict('Load the exact workflow plan before executing');
        const completed: ClientOpsExecutionJournalRow[] = [];
        for (const step of steps) completed.push(await this.executeStep(request, run, step));
        row = await this.checkpoint(request, run, key, steps, async () => ({
          output: { planSha256: digest(steps), completed: completed.map((r) => JSON.parse(r.output_json)) },
          references: completed.flatMap((r) => JSON.parse(r.references_json) as Reference[]),
        }));
        await this.deps!.events.emit(request.tenantId, 'client_ops.workflow.actions_completed', { runId: run.id, stepCount: steps.length });
        break;
      }
      case 'publish_receipt': {
        const execution = await this.database().selectFrom('client_ops_execution_journal').selectAll()
          .where('tenant_id', '=', request.tenantId).where('root_run_id', '=', run.rootRunId)
          .where('action_key', '=', 'action:execute_actions').executeTakeFirst();
        if (!execution) throw ApiError.conflict('Workflow actions have not completed');
        row = await this.checkpoint(request, run, key, request.input, async () => ({
          output: { executionId: execution.id, ...JSON.parse(execution.output_json) },
          references: JSON.parse(execution.references_json),
        }));
        break;
      }
      case 'classify_failure':
      case 'retry_run':
      case 'create_review': {
        const input = z.object({ failedRunId: text }).parse(request.input);
        const failed = await this.service().getRun(request.tenantId, input.failedRunId);
        if (failed.installationId !== request.installationId || failed.status !== 'failed') {
          throw ApiError.conflict('Recovery requires a failed run in this installation');
        }
        row = await this.checkpoint(request, run, key, input, async (tx) => {
          if (request.actionType === 'classify_failure') {
            const message = failed.error ?? '';
            const category = /credential|auth|token|connect/i.test(message) ? 'connection'
              : /timeout|unavailable|temporar/i.test(message) ? 'transient' : 'requires_review';
            return { output: { failedRunId: failed.id, error: failed.error, category }, references: [] };
          }
          if (request.actionType === 'retry_run') {
            const retry = await this.service(tx).retryRun(request.tenantId, failed.id,
              { idempotencyKey: `workflow-recovery:${run.rootRunId}:${failed.id}` }, 'client-ops-runner');
            return { output: { retryRunId: retry.run.id, state: retry.run.status, executionCompleted: false },
              references: [await this.reference(tx, request.tenantId, 'client_ops_runs', retry.run.id)] };
          }
          const review = await this.service(tx).createReview(request.tenantId, {
            installationId: request.installationId, runId: failed.id,
            title: 'Review workflow recovery', context: { error: failed.error, failedRunId: failed.id, recoveryRunId: run.id },
          }, 'client-ops-runner');
          return { output: { reviewId: review.id, state: review.status },
            references: [await this.reference(tx, request.tenantId, 'client_ops_review_items', review.id)] };
        });
        break;
      }
      default: throw ApiError.badRequest(`Workflow action is not supported: ${request.actionType}`);
    }
    return { invocationId: row.id, status: 'completed', output: JSON.parse(row.output_json),
      externalReferences: (JSON.parse(row.references_json) as Reference[]).map((ref) => `platform://${ref.table}/${ref.id}`) };
  }

  async verify(request: FoundationVerificationRequest): Promise<FoundationVerificationResult> {
    const run = await this.service().getRun(request.tenantId, request.runId);
    const row = await this.database().selectFrom('client_ops_execution_journal').selectAll()
      .where('id', '=', request.invocationId).where('tenant_id', '=', request.tenantId)
      .where('installation_id', '=', request.installationId).where('root_run_id', '=', run.rootRunId).executeTakeFirst();
    const checkedAt = new Date().toISOString();
    if (!row || row.output_json !== canonicalManifestJson(request.expected)) {
      return { verified: false, evidence: { reason: 'checkpoint absent or result differs' }, checkedAt };
    }
    const checks = [];
    for (const ref of JSON.parse(row.references_json) as Reference[]) {
      try {
        const actual = await this.reference(this.database(), request.tenantId, ref.table, ref.id);
        checks.push({ ...actual, matches: actual.sha256 === ref.sha256 });
      } catch {
        checks.push({ ...ref, matches: false });
      }
    }
    return { verified: checks.every((c) => c.matches),
      evidence: { journalId: row.id, outputSha256: digest(request.expected), destinations: checks }, checkedAt };
  }
}
