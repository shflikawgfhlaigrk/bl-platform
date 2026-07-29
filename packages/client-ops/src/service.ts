import type { Kysely } from '@blacklabel/db';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  type EventBus,
  type Pagination,
} from '@blacklabel/core';
import {
  getCatalogOffering,
  getEngagementModel,
  type CatalogOffering,
} from './catalog';
import { canonicalManifestJson, CLIENT_OPS_MANIFEST_SHA256 } from './manifest';
import { assertSafeConnectorMetadata } from './connector-security';
import { OWNED_SOURCE_METADATA_KEY } from './tenant-foundations';
import type { OwnedSourceConnection } from './adapters';
import type {
  CatalogKind,
  ClientOpsArtifactRow,
  ClientOpsCompletionReceiptRow,
  ClientOpsConnectorBindingRow,
  ClientOpsDatabase,
  ClientOpsInstallationRow,
  ClientOpsInstalledWorkflowRow,
  ClientOpsOnboardingStepRow,
  ClientOpsReviewItemRow,
  ClientOpsRunRow,
  ClientOpsUsageEventRow,
  ConnectorStatus,
  InstallationStatus,
  InstalledWorkflowStatus,
  OnboardingStatus,
  ReviewStatus,
  RunStatus,
} from './schema';

export interface InstallationWorkflow {
  id: string;
  templateId: string;
  name: string;
  outcome: string;
  trigger: unknown;
  actions: unknown[];
  approval: unknown;
  enabled: boolean;
  status: InstalledWorkflowStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorBinding {
  id: string;
  connectorId: string;
  label: string;
  required: boolean;
  status: ConnectorStatus;
  credentialRef: string | null;
  metadata: Record<string, unknown>;
  health: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface OnboardingStep {
  id: string;
  templateId: string;
  position: number;
  title: string;
  description: string;
  required: boolean;
  status: OnboardingStatus;
  evidence: unknown;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstallationReadiness {
  ready: boolean;
  pendingRequiredConnectorIds: string[];
  incompleteRequiredStepIds: string[];
  blockedWorkflowIds: string[];
}

export interface Installation {
  id: string;
  name: string;
  catalogKind: CatalogKind;
  catalogId: string;
  engagementModelId: string | null;
  manifestSha256: string;
  status: InstallationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface InstallationDetail extends Installation {
  workflows: InstallationWorkflow[];
  connectors: ConnectorBinding[];
  onboarding: OnboardingStep[];
  readiness: InstallationReadiness;
}

export interface Run {
  id: string;
  installationId: string;
  workflowId: string;
  idempotencyKey: string;
  rootRunId: string;
  retryOfRunId: string | null;
  attempt: number;
  status: RunStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewItem {
  id: string;
  installationId: string;
  runId: string | null;
  workflowId: string | null;
  title: string;
  context: unknown;
  status: ReviewStatus;
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Artifact {
  id: string;
  installationId: string;
  runId: string | null;
  reviewItemId: string | null;
  kind: string;
  name: string;
  uri: string;
  mediaType: string;
  sha256: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface CompletionReceipt {
  id: string;
  installationId: string;
  runId: string;
  summary: string;
  verification: unknown;
  artifactIds: string[];
  createdAt: string;
}

export interface UsageEvent {
  id: string;
  installationId: string;
  runId: string | null;
  provider: string;
  model: string | null;
  metric: string;
  quantity: number;
  unit: string;
  costCents: number;
  occurredAt: string;
  metadata: unknown;
  createdAt: string;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function mapInstallation(row: ClientOpsInstallationRow): Installation {
  return {
    id: row.id,
    name: row.name,
    catalogKind: row.catalog_kind,
    catalogId: row.catalog_id,
    engagementModelId: row.engagement_model_id,
    manifestSha256: row.manifest_sha256,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkflow(row: ClientOpsInstalledWorkflowRow): InstallationWorkflow {
  return {
    id: row.id,
    templateId: row.template_id,
    name: row.name,
    outcome: row.outcome,
    trigger: parseJson(row.trigger_json),
    actions: parseJson<unknown[]>(row.actions_json),
    approval: parseJson(row.approval_json),
    enabled: row.enabled === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConnector(row: ClientOpsConnectorBindingRow): ConnectorBinding {
  return {
    id: row.id,
    connectorId: row.connector_id,
    label: row.label,
    required: row.required === 1,
    status: row.status,
    credentialRef: row.credential_ref,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json),
    health: row.health_json === null ? null : parseJson<Record<string, unknown>>(row.health_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOnboarding(row: ClientOpsOnboardingStepRow): OnboardingStep {
  return {
    id: row.id,
    templateId: row.template_id,
    position: row.position,
    title: row.title,
    description: row.description,
    required: row.required === 1,
    status: row.status,
    evidence: row.evidence_json === null ? null : parseJson(row.evidence_json),
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: ClientOpsRunRow): Run {
  return {
    id: row.id,
    installationId: row.installation_id,
    workflowId: row.workflow_id,
    idempotencyKey: row.idempotency_key,
    rootRunId: row.root_run_id,
    retryOfRunId: row.retry_of_run_id,
    attempt: row.attempt,
    status: row.status,
    input: parseJson(row.input_json),
    output: row.output_json === null ? null : parseJson(row.output_json),
    error: row.error,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReview(row: ClientOpsReviewItemRow): ReviewItem {
  return {
    id: row.id,
    installationId: row.installation_id,
    runId: row.run_id,
    workflowId: row.workflow_id,
    title: row.title,
    context: parseJson(row.context_json),
    status: row.status,
    decisionNote: row.decision_note,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapArtifact(row: ClientOpsArtifactRow): Artifact {
  return {
    id: row.id,
    installationId: row.installation_id,
    runId: row.run_id,
    reviewItemId: row.review_item_id,
    kind: row.kind,
    name: row.name,
    uri: row.uri,
    mediaType: row.media_type,
    sha256: row.sha256,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

function mapReceipt(row: ClientOpsCompletionReceiptRow): CompletionReceipt {
  return {
    id: row.id,
    installationId: row.installation_id,
    runId: row.run_id,
    summary: row.summary,
    verification: parseJson(row.verification_json),
    artifactIds: parseJson<string[]>(row.artifact_ids_json),
    createdAt: row.created_at,
  };
}

function mapUsage(row: ClientOpsUsageEventRow): UsageEvent {
  return {
    id: row.id,
    installationId: row.installation_id,
    runId: row.run_id,
    provider: row.provider,
    model: row.model,
    metric: row.metric,
    quantity: row.quantity,
    unit: row.unit,
    costCents: row.cost_cents,
    occurredAt: row.occurred_at,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  const result = {} as Record<T, number>;
  for (const value of [...values].sort()) result[value] = (result[value] ?? 0) + 1;
  return result;
}

export interface CreateInstallationInput {
  name?: string;
  catalogKind: CatalogKind;
  catalogId: string;
  engagementModelId?: string | null;
}

export interface UpdateInstallationInput {
  name?: string;
  status?: Exclude<InstallationStatus, 'archived'>;
  engagementModelId?: string | null;
}

export class ClientOpsService {
  constructor(
    private readonly db: Kysely<ClientOpsDatabase>,
    private readonly events: EventBus,
  ) {}

  private async installationRow(tenantId: string, installationId: string): Promise<ClientOpsInstallationRow> {
    const row = await this.db
      .selectFrom('client_ops_installations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', installationId)
      .executeTakeFirst();
    if (!row) throw ApiError.notFound('installation not found');
    return row;
  }

  private async workflowRow(tenantId: string, workflowId: string): Promise<ClientOpsInstalledWorkflowRow> {
    const row = await this.db
      .selectFrom('client_ops_installed_workflows')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', workflowId)
      .executeTakeFirst();
    if (!row) throw ApiError.notFound('installed workflow not found');
    return row;
  }

  private async runRow(tenantId: string, runId: string): Promise<ClientOpsRunRow> {
    const row = await this.db
      .selectFrom('client_ops_runs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!row) throw ApiError.notFound('run not found');
    return row;
  }

  async createInstallation(
    tenantId: string,
    input: CreateInstallationInput,
    actor = 'system',
  ): Promise<InstallationDetail> {
    const offering = getCatalogOffering(input.catalogKind, input.catalogId);
    if (!offering) throw ApiError.notFound('catalog offering not found');
    if (input.engagementModelId !== undefined && input.engagementModelId !== null && !getEngagementModel(input.engagementModelId)) {
      throw ApiError.badRequest('unknown engagement model');
    }
    const installationId = id();
    const timestamp = nowIso();
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('client_ops_installations').values({
        id: installationId,
        tenant_id: tenantId,
        name: input.name?.trim() || offering.name,
        catalog_kind: input.catalogKind,
        catalog_id: offering.id,
        engagement_model_id: input.engagementModelId ?? null,
        manifest_sha256: CLIENT_OPS_MANIFEST_SHA256,
        status: 'onboarding',
        created_at: timestamp,
        updated_at: timestamp,
      }).execute();

      for (const template of offering.workflows) {
        const trigger = offering.triggers.find((item) => item.id === template.triggerId);
        const approval = offering.approvals.find((item) => item.id === template.approvalId);
        const actions = template.actionIds.map((actionId) => offering.actions.find((item) => item.id === actionId));
        if (!trigger || !approval || actions.some((item) => item === undefined)) {
          throw new Error(`invalid catalog references for ${template.id}`);
        }
        await trx.insertInto('client_ops_installed_workflows').values({
          id: id(), tenant_id: tenantId, installation_id: installationId,
          template_id: template.id, name: template.name, outcome: template.outcome,
          trigger_json: canonicalManifestJson(trigger),
          actions_json: canonicalManifestJson(actions),
          approval_json: canonicalManifestJson(approval),
          enabled: 1, status: 'ready', created_at: timestamp, updated_at: timestamp,
        }).execute();
      }
      for (const item of offering.connectors) {
        await trx.insertInto('client_ops_connector_bindings').values({
          id: id(), tenant_id: tenantId, installation_id: installationId,
          connector_id: item.id, label: item.label, required: item.required ? 1 : 0,
          status: 'pending', credential_ref: null, metadata_json: '{}', health_json: null,
          created_at: timestamp, updated_at: timestamp,
        }).execute();
      }
      for (const [position, step] of offering.onboarding.entries()) {
        await trx.insertInto('client_ops_onboarding_steps').values({
          id: id(), tenant_id: tenantId, installation_id: installationId,
          template_id: step.id, position, title: step.title, description: step.description,
          required: step.required ? 1 : 0, status: 'pending', evidence_json: null,
          completed_at: null, created_at: timestamp, updated_at: timestamp,
        }).execute();
      }
    });
    await audit(asCoreDb(this.db), tenantId, actor, 'client_ops.installation.created', 'client_ops.installation', installationId, {
      catalogKind: input.catalogKind,
      catalogId: input.catalogId,
      workflowCount: offering.workflows.length,
      connectorCount: offering.connectors.length,
      onboardingStepCount: offering.onboarding.length,
      manifestSha256: CLIENT_OPS_MANIFEST_SHA256,
    });
    await this.events.emit(tenantId, 'client_ops.installation.created', { installationId, catalogKind: input.catalogKind, catalogId: input.catalogId });
    return this.getInstallation(tenantId, installationId);
  }

  /**
   * Every connector row through which THIS tenant has connected one of its own
   * owned sources: status connected, its own credential ref, and metadata that
   * names the owned source. Per-tenant execution readiness resolves off this
   * list alone — a tenant with no row here must never reach an adapter bound to
   * Black Label's sources.
   */
  async listConnectedOwnedSources(tenantId: string): Promise<OwnedSourceConnection[]> {
    const rows = await this.db.selectFrom('client_ops_connector_bindings').selectAll()
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'connected')
      .orderBy('created_at').orderBy('id')
      .execute();
    const connections: OwnedSourceConnection[] = [];
    for (const row of rows) {
      const credentialRef = row.credential_ref?.trim() ?? '';
      // No credential ref means no client-owned access path; refuse to treat it
      // as a connection rather than falling back to our own credentials.
      if (credentialRef === '') continue;
      const declared = parseJson<Record<string, unknown>>(row.metadata_json)[OWNED_SOURCE_METADATA_KEY];
      if (typeof declared !== 'string' || declared.trim() === '') continue;
      connections.push({
        ownedSourceIdentifier: declared.trim(),
        bindingId: row.id,
        installationId: row.installation_id,
        connectorId: row.connector_id,
        credentialRef,
      });
    }
    return connections;
  }

  async listInstallations(tenantId: string, page: Pagination): Promise<Installation[]> {
    const rows = await this.db.selectFrom('client_ops_installations').selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'desc').orderBy('id', 'asc')
      .limit(page.limit).offset(page.offset).execute();
    return rows.map(mapInstallation);
  }

  async getInstallation(tenantId: string, installationId: string): Promise<InstallationDetail> {
    const installation = await this.installationRow(tenantId, installationId);
    const [workflowRows, connectorRows, onboardingRows] = await Promise.all([
      this.db.selectFrom('client_ops_installed_workflows').selectAll()
        .where('tenant_id', '=', tenantId).where('installation_id', '=', installationId)
        .orderBy('template_id', 'asc').orderBy('id', 'asc').execute(),
      this.db.selectFrom('client_ops_connector_bindings').selectAll()
        .where('tenant_id', '=', tenantId).where('installation_id', '=', installationId)
        .orderBy('connector_id', 'asc').orderBy('id', 'asc').execute(),
      this.db.selectFrom('client_ops_onboarding_steps').selectAll()
        .where('tenant_id', '=', tenantId).where('installation_id', '=', installationId)
        .orderBy('position', 'asc').orderBy('id', 'asc').execute(),
    ]);
    const workflows = workflowRows.map(mapWorkflow);
    const connectors = connectorRows.map(mapConnector);
    const onboarding = onboardingRows.map(mapOnboarding);
    const readiness: InstallationReadiness = {
      pendingRequiredConnectorIds: connectors.filter((item) => item.required && item.status !== 'connected').map((item) => item.id).sort(),
      incompleteRequiredStepIds: onboarding.filter((item) => item.required && item.status !== 'completed').map((item) => item.id).sort(),
      blockedWorkflowIds: workflows.filter((item) => !item.enabled || item.status !== 'ready').map((item) => item.id).sort(),
      ready: false,
    };
    readiness.ready = readiness.pendingRequiredConnectorIds.length === 0
      && readiness.incompleteRequiredStepIds.length === 0
      && readiness.blockedWorkflowIds.length === 0;
    return { ...mapInstallation(installation), workflows, connectors, onboarding, readiness };
  }

  async updateInstallation(
    tenantId: string,
    installationId: string,
    input: UpdateInstallationInput,
    actor = 'system',
  ): Promise<InstallationDetail> {
    const before = await this.getInstallation(tenantId, installationId);
    if (before.status === 'archived') throw ApiError.conflict('archived installations cannot be changed');
    if (input.engagementModelId !== undefined && input.engagementModelId !== null && !getEngagementModel(input.engagementModelId)) {
      throw ApiError.badRequest('unknown engagement model');
    }
    if (input.status === 'active' && !before.readiness.ready) {
      throw ApiError.conflict('installation is not ready for activation', before.readiness);
    }
    const patch: Partial<ClientOpsInstallationRow> = { updated_at: nowIso() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.status !== undefined) patch.status = input.status;
    if (input.engagementModelId !== undefined) patch.engagement_model_id = input.engagementModelId;
    await this.db.updateTable('client_ops_installations').set(patch)
      .where('tenant_id', '=', tenantId).where('id', '=', installationId).execute();
    const after = await this.getInstallation(tenantId, installationId);
    await audit(asCoreDb(this.db), tenantId, actor, 'client_ops.installation.updated', 'client_ops.installation', installationId, {
      before: { name: before.name, status: before.status, engagementModelId: before.engagementModelId },
      after: { name: after.name, status: after.status, engagementModelId: after.engagementModelId },
    });
    await this.events.emit(tenantId, 'client_ops.installation.updated', { installationId, status: after.status });
    return after;
  }

  async archiveInstallation(tenantId: string, installationId: string, actor = 'system'): Promise<InstallationDetail> {
    const before = await this.installationRow(tenantId, installationId);
    if (before.status !== 'archived') {
      const timestamp = nowIso();
      await this.db.transaction().execute(async (trx) => {
        await trx.updateTable('client_ops_installations').set({ status: 'archived', updated_at: timestamp })
          .where('tenant_id', '=', tenantId).where('id', '=', installationId).execute();
        await trx.updateTable('client_ops_installed_workflows').set({ enabled: 0, status: 'paused', updated_at: timestamp })
          .where('tenant_id', '=', tenantId).where('installation_id', '=', installationId).execute();
      });
      await audit(asCoreDb(this.db), tenantId, actor, 'client_ops.installation.archived', 'client_ops.installation', installationId, { beforeStatus: before.status });
      await this.events.emit(tenantId, 'client_ops.installation.archived', { installationId });
    }
    return this.getInstallation(tenantId, installationId);
  }

  async updateWorkflow(
    tenantId: string,
    installationId: string,
    workflowId: string,
    input: { enabled?: boolean; status?: InstalledWorkflowStatus },
    actor = 'system',
  ): Promise<InstallationWorkflow> {
    await this.installationRow(tenantId, installationId);
    const before = await this.workflowRow(tenantId, workflowId);
    if (before.installation_id !== installationId) throw ApiError.notFound('installed workflow not found');
    const timestamp = nowIso();
    const patch: Partial<ClientOpsInstalledWorkflowRow> = { updated_at: timestamp };
    if (input.enabled !== undefined) patch.enabled = input.enabled ? 1 : 0;
    if (input.status !== undefined) patch.status = input.status;
    await this.db.updateTable('client_ops_installed_workflows').set(patch)
      .where('tenant_id', '=', tenantId).where('id', '=', workflowId).where('installation_id', '=', installationId).execute();
    const after = await this.workflowRow(tenantId, workflowId);
    await audit(asCoreDb(this.db), tenantId, actor, 'client_ops.workflow.updated', 'client_ops.workflow', workflowId, { before: { enabled: before.enabled === 1, status: before.status }, after: { enabled: after.enabled === 1, status: after.status } });
    await this.events.emit(tenantId, 'client_ops.workflow.updated', { installationId, workflowId, enabled: after.enabled === 1, status: after.status });
    return mapWorkflow(after);
  }

  async updateConnector(
    tenantId: string,
    installationId: string,
    bindingId: string,
    input: { status?: ConnectorStatus; credentialRef?: string | null; metadata?: Record<string, unknown>; health?: Record<string, unknown> | null },
    actor = 'system',
  ): Promise<ConnectorBinding> {
    await this.installationRow(tenantId, installationId);
    const before = await this.db.selectFrom('client_ops_connector_bindings').selectAll()
      .where('tenant_id', '=', tenantId).where('installation_id', '=', installationId).where('id', '=', bindingId).executeTakeFirst();
    if (!before) throw ApiError.notFound('connector binding not found');
    const patch: Partial<ClientOpsConnectorBindingRow> = { updated_at: nowIso() };
    if (input.status !== undefined) patch.status = input.status;
    if (input.credentialRef !== undefined) patch.credential_ref = input.credentialRef;
    if (input.metadata !== undefined) {
      assertSafeConnectorMetadata(input.metadata);
      patch.metadata_json = canonicalManifestJson(input.metadata);
    }
    if (input.health !== undefined) {
      if (input.health !== null) assertSafeConnectorMetadata(input.health);
      patch.health_json = input.health === null ? null : canonicalManifestJson(input.health);
    }
    await this.db.updateTable('client_ops_connector_bindings').set(patch)
      .where('tenant_id', '=', tenantId).where('installation_id', '=', installationId).where('id', '=', bindingId).execute();
    const after = await this.db.selectFrom('client_ops_connector_bindings').selectAll()
      .where('tenant_id', '=', tenantId).where('installation_id', '=', installationId).where('id', '=', bindingId).executeTakeFirstOrThrow();
    await audit(asCoreDb(this.db), tenantId, actor, 'client_ops.connector.updated', 'client_ops.connector', bindingId, {
      before: { status: before.status, credentialRef: before.credential_ref },
      after: { status: after.status, credentialRef: after.credential_ref },
      metadataChanged: input.metadata !== undefined,
      healthChanged: input.health !== undefined,
    });
    await this.events.emit(tenantId, 'client_ops.connector.updated', { installationId, bindingId, connectorId: after.connector_id, status: after.status });
    return mapConnector(after);
  }

  async updateOnboardingStep(
    tenantId: string,
    installationId: string,
    stepId: string,
    input: { status: OnboardingStatus; evidence?: unknown },
    actor = 'system',
  ): Promise<OnboardingStep> {
    await this.installationRow(tenantId, installationId);
    const before = await this.db.selectFrom('client_ops_onboarding_steps').selectAll()
      .where('tenant_id', '=', tenantId).where('installation_id', '=', installationId).where('id', '=', stepId).executeTakeFirst();
    if (!before) throw ApiError.notFound('onboarding step not found');
    const timestamp = nowIso();
    await this.db.updateTable('client_ops_onboarding_steps').set({
      status: input.status,
      evidence_json: input.evidence === undefined ? before.evidence_json : canonicalManifestJson(input.evidence),
      completed_at: input.status === 'completed' ? timestamp : null,
      updated_at: timestamp,
    }).where('tenant_id', '=', tenantId).where('installation_id', '=', installationId).where('id', '=', stepId).execute();
    const after = await this.db.selectFrom('client_ops_onboarding_steps').selectAll()
      .where('tenant_id', '=', tenantId).where('installation_id', '=', installationId).where('id', '=', stepId).executeTakeFirstOrThrow();
    await audit(asCoreDb(this.db), tenantId, actor, 'client_ops.onboarding.updated', 'client_ops.onboarding_step', stepId, { beforeStatus: before.status, afterStatus: after.status });
    await this.events.emit(tenantId, 'client_ops.onboarding.updated', { installationId, stepId, status: after.status });
    return mapOnboarding(after);
  }

  async requestRun(
    tenantId: string,
    input: { installationId: string; workflowId: string; idempotencyKey: string; input?: unknown },
    actor = 'system',
  ): Promise<{ run: Run; created: boolean }> {
    const serializedInput = canonicalManifestJson(input.input ?? {});
    const existing = await this.db.selectFrom('client_ops_runs').selectAll()
      .where('tenant_id', '=', tenantId).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
    if (existing) {
      if (existing.installation_id !== input.installationId || existing.workflow_id !== input.workflowId || existing.input_json !== serializedInput) {
        throw ApiError.conflict('idempotency key already used for a different run request');
      }
      return { run: mapRun(existing), created: false };
    }
    const installation = await this.installationRow(tenantId, input.installationId);
    if (installation.status !== 'active') throw ApiError.conflict('installation must be active before requesting a run');
    const installedWorkflow = await this.workflowRow(tenantId, input.workflowId);
    if (installedWorkflow.installation_id !== input.installationId) throw ApiError.notFound('installed workflow not found');
    if (installedWorkflow.enabled !== 1 || installedWorkflow.status !== 'ready') throw ApiError.conflict('installed workflow is not runnable');
    const runId = id();
    const timestamp = nowIso();
    const row: ClientOpsRunRow = {
      id: runId, tenant_id: tenantId, installation_id: input.installationId,
      workflow_id: input.workflowId, idempotency_key: input.idempotencyKey,
      root_run_id: runId, retry_of_run_id: null, attempt: 1, status: 'requested',
      input_json: serializedInput, output_json: null, error: null, requested_at: timestamp,
      started_at: null, finished_at: null, created_at: timestamp, updated_at: timestamp,
    };
    await this.db.insertInto('client_ops_runs').values(row).execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'client_ops.run.requested', 'client_ops.run', runId, { installationId: input.installationId, workflowId: input.workflowId, idempotencyKey: input.idempotencyKey });
    await this.events.emit(tenantId, 'client_ops.run.requested', { runId, installationId: input.installationId, workflowId: input.workflowId, attempt: 1 });
    return { run: mapRun(row), created: true };
  }

  async retryRun(
    tenantId: string,
    runId: string,
    input: { idempotencyKey: string; input?: unknown },
    actor = 'system',
  ): Promise<{ run: Run; created: boolean }> {
    const parent = await this.runRow(tenantId, runId);
    if (parent.status !== 'failed') throw ApiError.conflict('only failed runs can be retried');
    const serializedInput = input.input === undefined ? parent.input_json : canonicalManifestJson(input.input);
    const existing = await this.db.selectFrom('client_ops_runs').selectAll()
      .where('tenant_id', '=', tenantId).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
    if (existing) {
      if (existing.retry_of_run_id !== parent.id || existing.input_json !== serializedInput) {
        throw ApiError.conflict('idempotency key already used for a different retry request');
      }
      return { run: mapRun(existing), created: false };
    }
    const installation = await this.installationRow(tenantId, parent.installation_id);
    if (installation.status !== 'active') throw ApiError.conflict('installation must be active before retrying a run');
    const attempts = await this.db.selectFrom('client_ops_runs').select('attempt')
      .where('tenant_id', '=', tenantId).where('root_run_id', '=', parent.root_run_id)
      .orderBy('attempt', 'desc').orderBy('id', 'asc').execute();
    const nextAttempt = (attempts[0]?.attempt ?? parent.attempt) + 1;
    const retryId = id();
    const timestamp = nowIso();
    const row: ClientOpsRunRow = {
      id: retryId, tenant_id: tenantId, installation_id: parent.installation_id,
      workflow_id: parent.workflow_id, idempotency_key: input.idempotencyKey,
      root_run_id: parent.root_run_id, retry_of_run_id: parent.id, attempt: nextAttempt,
      status: 'requested', input_json: serializedInput, output_json: null, error: null,
      requested_at: timestamp, started_at: null, finished_at: null,
      created_at: timestamp, updated_at: timestamp,
    };
    await this.db.insertInto('client_ops_runs').values(row).execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'client_ops.run.retried', 'client_ops.run', retryId, { retryOfRunId: parent.id, rootRunId: parent.root_run_id, attempt: nextAttempt, idempotencyKey: input.idempotencyKey });
    await this.events.emit(tenantId, 'client_ops.run.retried', { runId: retryId, retryOfRunId: parent.id, rootRunId: parent.root_run_id, attempt: nextAttempt });
    return { run: mapRun(row), created: true };
  }

  async getRun(tenantId: string, runId: string): Promise<Run> {
    return mapRun(await this.runRow(tenantId, runId));
  }

  async listRuns(tenantId: string, page: Pagination, installationId?: string): Promise<Run[]> {
    let query = this.db.selectFrom('client_ops_runs').selectAll().where('tenant_id', '=', tenantId);
    if (installationId !== undefined) query = query.where('installation_id', '=', installationId);
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'asc').limit(page.limit).offset(page.offset).execute();
    return rows.map(mapRun);
  }

  async updateRun(
    tenantId: string,
    runId: string,
    input: { status: Exclude<RunStatus, 'requested'>; output?: unknown; error?: string | null },
    actor = 'system',
  ): Promise<Run> {
    const before = await this.runRow(tenantId, runId);
    const allowed: Record<RunStatus, RunStatus[]> = {
      requested: ['running', 'succeeded', 'failed', 'canceled'],
      running: ['succeeded', 'failed', 'canceled'],
      succeeded: [], failed: [], canceled: [],
    };
    if (!allowed[before.status].includes(input.status)) throw ApiError.conflict(`cannot transition run from ${before.status} to ${input.status}`);
    const timestamp = nowIso();
    const terminal = ['succeeded', 'failed', 'canceled'].includes(input.status);
    await this.db.updateTable('client_ops_runs').set({
      status: input.status,
      output_json: input.output === undefined ? before.output_json : canonicalManifestJson(input.output),
      error: input.error === undefined ? before.error : input.error,
      started_at: before.started_at ?? timestamp,
      finished_at: terminal ? timestamp : null,
      updated_at: timestamp,
    }).where('tenant_id', '=', tenantId).where('id', '=', runId).execute();
    const after = await this.runRow(tenantId, runId);
    const event = `client_ops.run.${input.status === 'running' ? 'started' : input.status}`;
    await audit(asCoreDb(this.db), tenantId, actor, event, 'client_ops.run', runId, { beforeStatus: before.status, afterStatus: after.status, error: after.error });
    await this.events.emit(tenantId, event, { runId, status: after.status, attempt: after.attempt });
    return mapRun(after);
  }

  async createReview(
    tenantId: string,
    input: { installationId: string; runId?: string | null; workflowId?: string | null; title: string; context?: unknown },
    actor = 'system',
  ): Promise<ReviewItem> {
    await this.installationRow(tenantId, input.installationId);
    if (input.runId) {
      const run = await this.runRow(tenantId, input.runId);
      if (run.installation_id !== input.installationId) throw ApiError.notFound('run not found');
    }
    if (input.workflowId) {
      const workflowRow = await this.workflowRow(tenantId, input.workflowId);
      if (workflowRow.installation_id !== input.installationId) throw ApiError.notFound('installed workflow not found');
    }
    const timestamp = nowIso();
    const row: ClientOpsReviewItemRow = {
      id: id(), tenant_id: tenantId, installation_id: input.installationId,
      run_id: input.runId ?? null, workflow_id: input.workflowId ?? null,
      title: input.title, context_json: canonicalManifestJson(input.context ?? {}),
      status: 'pending', decision_note: null, decided_by: null, decided_at: null,
      created_at: timestamp, updated_at: timestamp,
    };
    await this.db.insertInto('client_ops_review_items').values(row).execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'client_ops.review.created', 'client_ops.review', row.id, { installationId: row.installation_id, runId: row.run_id, workflowId: row.workflow_id });
    await this.events.emit(tenantId, 'client_ops.review.created', { reviewId: row.id, installationId: row.installation_id, runId: row.run_id });
    return mapReview(row);
  }

  async getReview(tenantId: string, reviewId: string): Promise<ReviewItem> {
    const row = await this.db.selectFrom('client_ops_review_items').selectAll()
      .where('tenant_id', '=', tenantId).where('id', '=', reviewId).executeTakeFirst();
    if (!row) throw ApiError.notFound('review item not found');
    return mapReview(row);
  }

  async listReviews(tenantId: string, page: Pagination, status?: ReviewStatus): Promise<ReviewItem[]> {
    let query = this.db.selectFrom('client_ops_review_items').selectAll().where('tenant_id', '=', tenantId);
    if (status !== undefined) query = query.where('status', '=', status);
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'asc').limit(page.limit).offset(page.offset).execute();
    return rows.map(mapReview);
  }

  /** All review items tied to one run, oldest first — the runner's approval trail. */
  async listReviewsForRun(tenantId: string, runId: string): Promise<ReviewItem[]> {
    await this.runRow(tenantId, runId);
    const rows = await this.db.selectFrom('client_ops_review_items').selectAll()
      .where('tenant_id', '=', tenantId).where('run_id', '=', runId)
      .orderBy('created_at', 'asc').orderBy('id', 'asc').execute();
    return rows.map(mapReview);
  }

  async decideReview(
    tenantId: string,
    reviewId: string,
    status: Exclude<ReviewStatus, 'pending'>,
    note: string | null,
    actor = 'system',
  ): Promise<ReviewItem> {
    const before = await this.db.selectFrom('client_ops_review_items').selectAll()
      .where('tenant_id', '=', tenantId).where('id', '=', reviewId).executeTakeFirst();
    if (!before) throw ApiError.notFound('review item not found');
    if (before.status === 'approved' || before.status === 'denied') throw ApiError.conflict('review item already has a terminal decision');
    const timestamp = nowIso();
    await this.db.updateTable('client_ops_review_items').set({
      status, decision_note: note, decided_by: actor, decided_at: timestamp, updated_at: timestamp,
    }).where('tenant_id', '=', tenantId).where('id', '=', reviewId).execute();
    const after = await this.db.selectFrom('client_ops_review_items').selectAll()
      .where('tenant_id', '=', tenantId).where('id', '=', reviewId).executeTakeFirstOrThrow();
    const event = `client_ops.review.${status}`;
    await audit(asCoreDb(this.db), tenantId, actor, event, 'client_ops.review', reviewId, { beforeStatus: before.status, afterStatus: status, note });
    await this.events.emit(tenantId, event, { reviewId, installationId: after.installation_id, runId: after.run_id, status });
    return mapReview(after);
  }

  async createArtifact(
    tenantId: string,
    input: { installationId: string; runId?: string | null; reviewItemId?: string | null; kind: string; name: string; uri: string; mediaType: string; sha256?: string | null; metadata?: unknown },
    actor = 'system',
  ): Promise<Artifact> {
    await this.installationRow(tenantId, input.installationId);
    if (input.runId) {
      const run = await this.runRow(tenantId, input.runId);
      if (run.installation_id !== input.installationId) throw ApiError.notFound('run not found');
    }
    if (input.reviewItemId) {
      const review = await this.db.selectFrom('client_ops_review_items').select(['id', 'installation_id'])
        .where('tenant_id', '=', tenantId).where('id', '=', input.reviewItemId).executeTakeFirst();
      if (!review || review.installation_id !== input.installationId) throw ApiError.notFound('review item not found');
    }
    const row: ClientOpsArtifactRow = {
      id: id(), tenant_id: tenantId, installation_id: input.installationId,
      run_id: input.runId ?? null, review_item_id: input.reviewItemId ?? null,
      kind: input.kind, name: input.name, uri: input.uri, media_type: input.mediaType,
      sha256: input.sha256 ?? null, metadata_json: canonicalManifestJson(input.metadata ?? {}), created_at: nowIso(),
    };
    await this.db.insertInto('client_ops_artifacts').values(row).execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'client_ops.artifact.created', 'client_ops.artifact', row.id, { installationId: row.installation_id, runId: row.run_id, kind: row.kind, sha256: row.sha256 });
    await this.events.emit(tenantId, 'client_ops.artifact.created', { artifactId: row.id, installationId: row.installation_id, runId: row.run_id, kind: row.kind });
    return mapArtifact(row);
  }

  async getArtifact(tenantId: string, artifactId: string): Promise<Artifact> {
    const row = await this.db.selectFrom('client_ops_artifacts').selectAll()
      .where('tenant_id', '=', tenantId).where('id', '=', artifactId).executeTakeFirst();
    if (!row) throw ApiError.notFound('artifact not found');
    return mapArtifact(row);
  }

  async listArtifacts(tenantId: string, page: Pagination, installationId?: string): Promise<Artifact[]> {
    let query = this.db.selectFrom('client_ops_artifacts').selectAll().where('tenant_id', '=', tenantId);
    if (installationId !== undefined) query = query.where('installation_id', '=', installationId);
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'asc').limit(page.limit).offset(page.offset).execute();
    return rows.map(mapArtifact);
  }

  async createCompletionReceipt(
    tenantId: string,
    input: { installationId: string; runId: string; summary: string; verification?: unknown; artifactIds?: string[] },
    actor = 'system',
  ): Promise<CompletionReceipt> {
    await this.installationRow(tenantId, input.installationId);
    const run = await this.runRow(tenantId, input.runId);
    if (run.installation_id !== input.installationId) throw ApiError.notFound('run not found');
    if (run.status === 'requested' || run.status === 'running') throw ApiError.conflict('completion receipt requires a terminal run');
    const existing = await this.db.selectFrom('client_ops_completion_receipts').select('id')
      .where('tenant_id', '=', tenantId).where('run_id', '=', input.runId).executeTakeFirst();
    if (existing) throw ApiError.conflict('completion receipt already exists for run');
    const artifactIds = [...new Set(input.artifactIds ?? [])].sort();
    for (const artifactId of artifactIds) {
      const artifactRow = await this.db.selectFrom('client_ops_artifacts').select(['id', 'installation_id', 'run_id'])
        .where('tenant_id', '=', tenantId).where('id', '=', artifactId).executeTakeFirst();
      if (!artifactRow || artifactRow.installation_id !== input.installationId || artifactRow.run_id !== input.runId) {
        throw ApiError.badRequest(`artifact ${artifactId} does not belong to the run`);
      }
    }
    const row: ClientOpsCompletionReceiptRow = {
      id: id(), tenant_id: tenantId, installation_id: input.installationId,
      run_id: input.runId, summary: input.summary,
      verification_json: canonicalManifestJson(input.verification ?? {}),
      artifact_ids_json: canonicalManifestJson(artifactIds), created_at: nowIso(),
    };
    await this.db.insertInto('client_ops_completion_receipts').values(row).execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'client_ops.receipt.created', 'client_ops.completion_receipt', row.id, { installationId: row.installation_id, runId: row.run_id, artifactIds });
    await this.events.emit(tenantId, 'client_ops.receipt.created', { receiptId: row.id, installationId: row.installation_id, runId: row.run_id });
    return mapReceipt(row);
  }

  async getCompletionReceipt(tenantId: string, receiptId: string): Promise<CompletionReceipt> {
    const row = await this.db.selectFrom('client_ops_completion_receipts').selectAll()
      .where('tenant_id', '=', tenantId).where('id', '=', receiptId).executeTakeFirst();
    if (!row) throw ApiError.notFound('completion receipt not found');
    return mapReceipt(row);
  }

  async listCompletionReceipts(tenantId: string, page: Pagination, installationId?: string): Promise<CompletionReceipt[]> {
    let query = this.db.selectFrom('client_ops_completion_receipts').selectAll().where('tenant_id', '=', tenantId);
    if (installationId !== undefined) query = query.where('installation_id', '=', installationId);
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'asc').limit(page.limit).offset(page.offset).execute();
    return rows.map(mapReceipt);
  }

  async recordUsage(
    tenantId: string,
    input: { installationId: string; runId?: string | null; provider: string; model?: string | null; metric: string; quantity: number; unit: string; costCents: number; occurredAt?: string; metadata?: unknown },
    actor = 'system',
  ): Promise<UsageEvent> {
    await this.installationRow(tenantId, input.installationId);
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 0) throw ApiError.badRequest('quantity must be a non-negative safe integer');
    if (!Number.isSafeInteger(input.costCents) || input.costCents < 0) throw ApiError.badRequest('costCents must be a non-negative safe integer');
    if (input.runId) {
      const run = await this.runRow(tenantId, input.runId);
      if (run.installation_id !== input.installationId) throw ApiError.notFound('run not found');
    }
    const timestamp = nowIso();
    const row: ClientOpsUsageEventRow = {
      id: id(), tenant_id: tenantId, installation_id: input.installationId,
      run_id: input.runId ?? null, provider: input.provider, model: input.model ?? null,
      metric: input.metric, quantity: input.quantity, unit: input.unit, cost_cents: input.costCents,
      occurred_at: input.occurredAt ?? timestamp, metadata_json: canonicalManifestJson(input.metadata ?? {}), created_at: timestamp,
    };
    await this.db.insertInto('client_ops_usage_events').values(row).execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'client_ops.usage.recorded', 'client_ops.usage_event', row.id, { installationId: row.installation_id, runId: row.run_id, provider: row.provider, metric: row.metric, quantity: row.quantity, unit: row.unit, costCents: row.cost_cents });
    await this.events.emit(tenantId, 'client_ops.usage.recorded', { usageEventId: row.id, installationId: row.installation_id, runId: row.run_id, costCents: row.cost_cents });
    return mapUsage(row);
  }

  async listUsage(tenantId: string, page: Pagination, installationId?: string): Promise<UsageEvent[]> {
    let query = this.db.selectFrom('client_ops_usage_events').selectAll().where('tenant_id', '=', tenantId);
    if (installationId !== undefined) query = query.where('installation_id', '=', installationId);
    const rows = await query.orderBy('occurred_at', 'desc').orderBy('id', 'asc').limit(page.limit).offset(page.offset).execute();
    return rows.map(mapUsage);
  }

  async usageSummary(tenantId: string, installationId?: string): Promise<{
    eventCount: number;
    totalCostCents: number;
    byProvider: Array<{ provider: string; model: string | null; eventCount: number; quantity: number; costCents: number }>;
    byMetric: Array<{ metric: string; unit: string; eventCount: number; quantity: number; costCents: number }>;
  }> {
    let query = this.db.selectFrom('client_ops_usage_events').selectAll().where('tenant_id', '=', tenantId);
    if (installationId !== undefined) query = query.where('installation_id', '=', installationId);
    const rows = await query.orderBy('occurred_at', 'asc').orderBy('id', 'asc').execute();
    const providers = new Map<string, { provider: string; model: string | null; eventCount: number; quantity: number; costCents: number }>();
    const metrics = new Map<string, { metric: string; unit: string; eventCount: number; quantity: number; costCents: number }>();
    for (const row of rows) {
      const providerKey = `${row.provider}\u0000${row.model ?? ''}`;
      const provider = providers.get(providerKey) ?? { provider: row.provider, model: row.model, eventCount: 0, quantity: 0, costCents: 0 };
      provider.eventCount += 1; provider.quantity += row.quantity; provider.costCents += row.cost_cents; providers.set(providerKey, provider);
      const metricKey = `${row.metric}\u0000${row.unit}`;
      const metricGroup = metrics.get(metricKey) ?? { metric: row.metric, unit: row.unit, eventCount: 0, quantity: 0, costCents: 0 };
      metricGroup.eventCount += 1; metricGroup.quantity += row.quantity; metricGroup.costCents += row.cost_cents; metrics.set(metricKey, metricGroup);
    }
    return {
      eventCount: rows.length,
      totalCostCents: rows.reduce((sum, row) => sum + row.cost_cents, 0),
      byProvider: [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider) || (a.model ?? '').localeCompare(b.model ?? '')),
      byMetric: [...metrics.values()].sort((a, b) => a.metric.localeCompare(b.metric) || a.unit.localeCompare(b.unit)),
    };
  }

  /** Aggregates this module's tables only; no cross-module reads or joins. */
  async overview(tenantId: string): Promise<{
    installations: { total: number; byStatus: Record<string, number> };
    runs: { total: number; byStatus: Record<string, number> };
    reviews: { total: number; byStatus: Record<string, number> };
    artifacts: number;
    completionReceipts: number;
    usage: Awaited<ReturnType<ClientOpsService['usageSummary']>>;
  }> {
    const [installations, runs, reviews, artifacts, receipts, usage] = await Promise.all([
      this.db.selectFrom('client_ops_installations').select('status').where('tenant_id', '=', tenantId).orderBy('status').orderBy('id').execute(),
      this.db.selectFrom('client_ops_runs').select('status').where('tenant_id', '=', tenantId).orderBy('status').orderBy('id').execute(),
      this.db.selectFrom('client_ops_review_items').select('status').where('tenant_id', '=', tenantId).orderBy('status').orderBy('id').execute(),
      this.db.selectFrom('client_ops_artifacts').select('id').where('tenant_id', '=', tenantId).orderBy('id').execute(),
      this.db.selectFrom('client_ops_completion_receipts').select('id').where('tenant_id', '=', tenantId).orderBy('id').execute(),
      this.usageSummary(tenantId),
    ]);
    return {
      installations: { total: installations.length, byStatus: countBy(installations.map((row) => row.status)) },
      runs: { total: runs.length, byStatus: countBy(runs.map((row) => row.status)) },
      reviews: { total: reviews.length, byStatus: countBy(reviews.map((row) => row.status)) },
      artifacts: artifacts.length,
      completionReceipts: receipts.length,
      usage,
    };
  }
}

/** Resolve the exact catalog snapshot represented by an installation. */
export function installationOffering(kind: CatalogKind, catalogId: string): CatalogOffering {
  const offering = getCatalogOffering(kind, catalogId);
  if (!offering) throw ApiError.notFound('catalog offering not found');
  return offering;
}
