import type { CoreDatabase } from '@blacklabel/core';

export type CatalogKind = 'service' | 'vertical_pack';
export type InstallationStatus = 'onboarding' | 'active' | 'paused' | 'archived';
export type InstalledWorkflowStatus = 'ready' | 'blocked' | 'paused';
export type ConnectorStatus = 'pending' | 'connected' | 'unhealthy' | 'disabled';
export type OnboardingStatus = 'pending' | 'completed' | 'blocked';
export type RunStatus = 'requested' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type ReviewStatus = 'pending' | 'approved' | 'denied' | 'held';
export type PortfolioTargetKind = 'product' | 'feature';
export type PortfolioTestStatus = 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'stale';
export type PortfolioBuildStatus = 'requested' | 'building' | 'verified' | 'failed' | 'blocked' | 'stale';

export interface ClientOpsInstallationRow {
  id: string;
  tenant_id: string;
  name: string;
  catalog_kind: CatalogKind;
  catalog_id: string;
  engagement_model_id: string | null;
  manifest_sha256: string;
  status: InstallationStatus;
  created_at: string;
  updated_at: string;
}

export interface ClientOpsInstalledWorkflowRow {
  id: string;
  tenant_id: string;
  installation_id: string;
  template_id: string;
  name: string;
  outcome: string;
  trigger_json: string;
  actions_json: string;
  approval_json: string;
  enabled: number;
  status: InstalledWorkflowStatus;
  created_at: string;
  updated_at: string;
}

export interface ClientOpsConnectorBindingRow {
  id: string;
  tenant_id: string;
  installation_id: string;
  connector_id: string;
  label: string;
  required: number;
  status: ConnectorStatus;
  credential_ref: string | null;
  metadata_json: string;
  health_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientOpsOnboardingStepRow {
  id: string;
  tenant_id: string;
  installation_id: string;
  template_id: string;
  position: number;
  title: string;
  description: string;
  required: number;
  status: OnboardingStatus;
  evidence_json: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientOpsRunRow {
  id: string;
  tenant_id: string;
  installation_id: string;
  workflow_id: string;
  idempotency_key: string;
  root_run_id: string;
  retry_of_run_id: string | null;
  attempt: number;
  status: RunStatus;
  input_json: string;
  output_json: string | null;
  error: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientOpsReviewItemRow {
  id: string;
  tenant_id: string;
  installation_id: string;
  run_id: string | null;
  workflow_id: string | null;
  title: string;
  context_json: string;
  status: ReviewStatus;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientOpsArtifactRow {
  id: string;
  tenant_id: string;
  installation_id: string;
  run_id: string | null;
  review_item_id: string | null;
  kind: string;
  name: string;
  uri: string;
  media_type: string;
  sha256: string | null;
  metadata_json: string;
  created_at: string;
}

export interface ClientOpsCompletionReceiptRow {
  id: string;
  tenant_id: string;
  installation_id: string;
  run_id: string;
  summary: string;
  verification_json: string;
  artifact_ids_json: string;
  created_at: string;
}

/** Append-only. The service intentionally exposes no update or delete method. */
export interface ClientOpsUsageEventRow {
  id: string;
  tenant_id: string;
  installation_id: string;
  run_id: string | null;
  provider: string;
  model: string | null;
  metric: string;
  quantity: number;
  unit: string;
  cost_cents: number;
  occurred_at: string;
  metadata_json: string;
  created_at: string;
}

/** Evidence from an allowlisted product acceptance suite. Source claims never populate this table. */
export interface ClientOpsPortfolioTestRunRow {
  id: string;
  tenant_id: string;
  product_key: string;
  target_kind: PortfolioTargetKind;
  target_key: string;
  suite_key: string;
  status: PortfolioTestStatus;
  requested_by: string;
  source_revision: string | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  summary: string | null;
  evidence_json: string;
  created_at: string;
  updated_at: string;
}

/** Evidence that one product or feature was individually built and verified. */
export interface ClientOpsPortfolioPackageRow {
  id: string;
  tenant_id: string;
  product_key: string;
  target_kind: PortfolioTargetKind;
  target_key: string;
  version: string;
  status: PortfolioBuildStatus;
  requested_by: string;
  artifact_uri: string | null;
  sha256: string | null;
  bytes: number | null;
  manifest_json: string;
  built_at: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientOpsDatabase extends CoreDatabase {
  client_ops_installations: ClientOpsInstallationRow;
  client_ops_installed_workflows: ClientOpsInstalledWorkflowRow;
  client_ops_connector_bindings: ClientOpsConnectorBindingRow;
  client_ops_onboarding_steps: ClientOpsOnboardingStepRow;
  client_ops_runs: ClientOpsRunRow;
  client_ops_review_items: ClientOpsReviewItemRow;
  client_ops_artifacts: ClientOpsArtifactRow;
  client_ops_completion_receipts: ClientOpsCompletionReceiptRow;
  client_ops_usage_events: ClientOpsUsageEventRow;
  client_ops_portfolio_test_runs: ClientOpsPortfolioTestRunRow;
  client_ops_portfolio_packages: ClientOpsPortfolioPackageRow;
}
