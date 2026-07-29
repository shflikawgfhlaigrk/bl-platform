/**
 * @blacklabel/client-ops
 *
 * Owned events (all module.entity.verb):
 * - client_ops.installation.created|updated|archived
 * - client_ops.workflow.updated
 * - client_ops.connector.updated
 * - client_ops.onboarding.updated
 * - client_ops.run.requested|retried|started|succeeded|failed|canceled
 * - client_ops.review.created|approved|denied|held
 * - client_ops.artifact.created
 * - client_ops.receipt.created
 * - client_ops.usage.recorded
 * - client_ops.portfolio_test.requested
 * - client_ops.portfolio_package.requested
 */
export { CLIENT_OPS_CATALOG, getCatalogOffering, getEngagementModel, validateClientOpsCatalog } from './catalog';
export type {
  CatalogAction,
  CatalogApproval,
  CatalogArtifact,
  CatalogConnector,
  CatalogMetric,
  CatalogOffering,
  CatalogOnboardingStep,
  CatalogReadiness,
  CatalogTrigger,
  CatalogWorkflow,
  ClientOpsCatalog,
  EngagementModel,
  ReadinessStatus,
  TriggerType,
} from './catalog';
export {
  canonicalManifestJson,
  CLIENT_OPS_MANIFEST_SHA256,
  manifestSha256,
  signManifest,
  verifyManifest,
} from './manifest';
export type { ManifestSignature } from './manifest';
export { clientOpsMigrations } from './migrations';
export { clientOpsRouter } from './router';
export type { ClientOpsRouterOptions } from './router';
export { CLIENT_OPS_PORTFOLIO, getPortfolioFeature, getPortfolioProduct } from './portfolio';
export type {
  PortfolioEvidenceStatus,
  PortfolioFeatureDefinition,
  PortfolioKind,
  PortfolioOrigin,
  PortfolioPackageMode,
  PortfolioPackageStatus,
  PortfolioProductDefinition,
  PortfolioReadiness,
} from './portfolio';
export { PortfolioService } from './portfolio-service';
export type {
  PortfolioEvidenceSummary,
  PortfolioFeatureView,
  PortfolioPackage,
  PortfolioProductView,
  PortfolioSummary,
  PortfolioTestRun,
} from './portfolio-service';
export { assertSafeConnectorMetadata } from './connector-security';
export { seedClientOps } from './seed';
export { SERVICE_EXECUTION_FOUNDATIONS, ServiceFoundationRegistry } from './adapters';
export type {
  FoundationAdapterReadiness,
  FoundationInvocationRequest,
  FoundationInvocationResult,
  FoundationVerificationRequest,
  FoundationVerificationResult,
  RegisteredFoundationState,
  ServiceExecutionFoundation,
  ServiceFoundationAdapter,
} from './adapters';
export { ClientOpsService, installationOffering } from './service';
export { executeRun } from './runner';
export type { ActionResult, RunnerArgs, RunnerDeps, RunnerOutcome } from './runner';
export { registerProductionFoundations, registerReadyFoundations, WorkflowExecutionAdapter } from './foundations';
export type { ReadyFoundationDeps } from './foundations';
export { ExecutiveOperationsHqAdapter } from './foundations/executive-operations-hq';
export type { ExecutiveOperationsHqConfig } from './foundations/executive-operations-hq';
export {
  createDataOperationsAdapter,
  createNationalPropertyRecordsReader,
  DataOperationsAdapter,
} from './foundations/data-operations-service';
export type { DataSliceRow, DataSourceReader, DataSourceSlice } from './foundations/data-operations-service';
export { createSqlLeadReader, SalesOperatorAdapter } from './foundations/sales-operator';
export type { LeadReader, SalesLead, SqlRunner } from './foundations/sales-operator';
export type {
  Artifact,
  CompletionReceipt,
  ConnectorBinding,
  CreateInstallationInput,
  Installation,
  InstallationDetail,
  InstallationReadiness,
  InstallationWorkflow,
  OnboardingStep,
  ReviewItem,
  Run,
  UpdateInstallationInput,
  UsageEvent,
} from './service';
export type {
  CatalogKind,
  ClientOpsDatabase,
  PortfolioBuildStatus,
  PortfolioTargetKind,
  PortfolioTestStatus,
  ConnectorStatus,
  InstallationStatus,
  InstalledWorkflowStatus,
  OnboardingStatus,
  ReviewStatus,
  RunStatus,
} from './schema';
