import { ApiError } from '@blacklabel/core';

export type FoundationAdapterReadiness = 'declared' | 'ready' | 'degraded';

export interface ServiceExecutionFoundation {
  serviceId: string;
  capabilityId: string;
  ownedSourceIdentifier: string;
  readiness: FoundationAdapterReadiness;
  requiredFoundationIdentifiers: string[];
  invokeBoundary: string;
  verifyBoundary: string;
}

/**
 * One tenant's OWN connector row for an adapter's owned source. It is the only
 * thing that makes a foundation ready for that tenant: without it the engine
 * would silently resolve every client to Black Label's own sources. The secret
 * itself never lives here — connector-security forces it behind `credentialRef`.
 */
export interface OwnedSourceConnection {
  ownedSourceIdentifier: string;
  bindingId: string;
  installationId: string;
  connectorId: string;
  credentialRef: string;
}

export interface FoundationInvocationRequest {
  tenantId: string;
  installationId: string;
  runId: string;
  workflowTemplateId: string;
  actionType: string;
  input: unknown;
  /**
   * The invoking tenant's own connector row for this adapter's owned source.
   * The runner refuses to invoke without one, so an adapter that touches a real
   * source MUST resolve it through this ref rather than a process-wide default.
   * Optional on the contract so already-registered adapters keep compiling.
   */
  ownedSourceRef?: OwnedSourceConnection;
}

export interface FoundationInvocationResult {
  invocationId: string;
  status: 'accepted' | 'completed' | 'failed';
  output: unknown;
  externalReferences: string[];
}

export interface FoundationVerificationRequest {
  tenantId: string;
  installationId: string;
  runId: string;
  invocationId: string;
  expected: unknown;
  /** Revalidate the same tenant-owned connection used by invocation. */
  ownedSourceRef?: OwnedSourceConnection;
}

export interface FoundationVerificationResult {
  verified: boolean;
  evidence: unknown;
  checkedAt: string;
}

/**
 * Provider-neutral execution boundary. Concrete adapters own credentials and
 * provider calls; client-ops owns invocation identity, tenancy, and evidence.
 */
export interface ServiceFoundationAdapter {
  readonly serviceId: string;
  readonly capabilityId: string;
  readonly ownedSourceIdentifier: string;
  readiness(): FoundationAdapterReadiness;
  invoke(request: FoundationInvocationRequest): Promise<FoundationInvocationResult>;
  verify(request: FoundationVerificationRequest): Promise<FoundationVerificationResult>;
}

/** One explicit execution foundation for every sellable offering: 8 services + 7 vertical packs. */
export const SERVICE_EXECUTION_FOUNDATIONS: readonly ServiceExecutionFoundation[] = Object.freeze([
  {
    serviceId: 'workflow-operating-system', capabilityId: 'client_ops.workflow.execute',
    ownedSourceIdentifier: 'BlackLabelPlatform.workflows', readiness: 'ready',
    requiredFoundationIdentifiers: ['BlackLabelPlatform.workflows', 'BlackLabelPlatform.actions', 'BlackLabelPlatform.automation', 'BlackLabelPlatform.reviews'],
    invokeBoundary: 'Execute a versioned installed workflow action sequence with idempotency and retry lineage.',
    verifyBoundary: 'Read back action results and return a completion or exception evidence packet.',
  },
  {
    serviceId: 'ai-front-desk', capabilityId: 'client_ops.front_desk.handle_call',
    ownedSourceIdentifier: 'BlackLabelFrontDesk.call_operations', readiness: 'declared',
    requiredFoundationIdentifiers: ['BlackLabelFrontDesk.realtime_voice', 'BlackLabelFrontDesk.call_operations', 'BlackLabelPlatform.scheduling', 'BlackLabelPlatform.customers'],
    invokeBoundary: 'Handle one policy-scoped call turn, contact mutation, scheduling action, transfer, or callback.',
    verifyBoundary: 'Read back call disposition, contact state, and appointment or transfer result.',
  },
  {
    serviceId: 'sales-operator', capabilityId: 'client_ops.sales.process_lead',
    ownedSourceIdentifier: 'BlackLabelLeadsAPI', readiness: 'declared',
    requiredFoundationIdentifiers: ['BlackLabelLeadsAPI', 'BlackLabelMarketing.outreach', 'BlackLabelPlatform.crm', 'BlackLabelPlatform.reviews'],
    invokeBoundary: 'Validate, enrich, route, or follow up one provenance-linked lead within approved policy.',
    verifyBoundary: 'Read back the CRM record, message delivery, and pipeline next step.',
  },
  {
    serviceId: 'marketing-operator', capabilityId: 'client_ops.marketing.publish_campaign',
    ownedSourceIdentifier: 'BlackLabelMarketing.media_engine', readiness: 'declared',
    requiredFoundationIdentifiers: ['BlackLabelMarketing.media_engine', 'BlackLabelMarketing.publisher', 'BlackLabelPlatform.files', 'BlackLabelPlatform.reviews'],
    invokeBoundary: 'Produce, register, or publish an exact approved campaign artifact version.',
    verifyBoundary: 'Confirm artifact hash, destination publication identity, delivery, and available outcomes.',
  },
  {
    serviceId: 'support-operator', capabilityId: 'client_ops.support.resolve_ticket',
    ownedSourceIdentifier: 'BlackLabelSupport.ticket_workflow', readiness: 'declared',
    requiredFoundationIdentifiers: ['BlackLabelSupport.safety_engine', 'BlackLabelSupport.ticket_workflow', 'BlackLabelPlatform.messaging', 'BlackLabelPlatform.files'],
    invokeBoundary: 'Create, classify, draft, escalate, or respond to one grounded support ticket.',
    verifyBoundary: 'Confirm grounding citations, approval, message delivery, and final ticket state.',
  },
  {
    serviceId: 'executive-operations-hq', capabilityId: 'client_ops.hq.publish_brief',
    ownedSourceIdentifier: 'BlackLabelHQ', readiness: 'declared',
    requiredFoundationIdentifiers: ['BlackLabelHQ', 'BlackLabelAtlas', 'BlackLabelPlatform.dashboard', 'BlackLabelPlatform.actions'],
    invokeBoundary: 'Assemble and publish one module-scoped operations brief or resolution card.',
    verifyBoundary: 'Resolve each statement and deep link to client-ops owned run, review, artifact, receipt, or usage evidence.',
  },
  {
    serviceId: 'private-company-agent', capabilityId: 'client_ops.private_agent.execute',
    ownedSourceIdentifier: 'BlackLabelSovereign', readiness: 'declared',
    requiredFoundationIdentifiers: ['BlackLabelSovereign', 'ProjectUtah.RAG', 'BlackLabelOperatorKit', 'BlackLabelPlatform.reviews'],
    invokeBoundary: 'Answer from authorized private context or execute one explicitly approved local computer action.',
    verifyBoundary: 'Return citations or signed post-action computer evidence inside the requesting tenant and role scope.',
  },
  {
    serviceId: 'data-operations-service', capabilityId: 'client_ops.data.execute_job',
    ownedSourceIdentifier: 'BlackLabelPropertyHarvest.jobs', readiness: 'declared',
    requiredFoundationIdentifiers: ['BlackLabelPropertyHarvest.jobs', 'BlackLabelLeadsAPI.source_ledger', 'BlackLabelPlatform.files', 'BlackLabelPlatform.automation'],
    invokeBoundary: 'Run one checkpointed, versioned import, transform, enrichment, or delivery slice.',
    verifyBoundary: 'Return source range, accepted and rejected counts, destination readback, and the next checkpoint.',
  },
  // Vertical packs: same declaration contract as services, so the runner can
  // resolve a capability for every installable catalog offering. All start
  // 'declared' — each needs its client-system adapter before it can execute.
  {
    serviceId: 'medical-dental-receptionist', capabilityId: 'client_ops.medical_dental.route_patient_call',
    ownedSourceIdentifier: 'BlackLabelFrontDesk.realtime_voice', readiness: 'declared',
    requiredFoundationIdentifiers: ['BlackLabelFrontDesk.realtime_voice', 'BlackLabelPlatform.scheduling', 'BlackLabelPlatform.messaging', 'BlackLabelPlatform.reviews'],
    invokeBoundary: 'Route, schedule, or follow up one patient interaction within the approved privacy scope.',
    verifyBoundary: 'Read back routing, appointment, and notification delivery evidence with minimum necessary data.',
  },
  {
    serviceId: 'real-estate-acquisition-desk', capabilityId: 'client_ops.real_estate.process_property_lead',
    ownedSourceIdentifier: 'BlackLabelPropertyHarvest', readiness: 'declared',
    requiredFoundationIdentifiers: ['BlackLabelPropertyHarvest', 'BlackLabelLeadsAPI', 'ProjectUtah.sales', 'BlackLabelPlatform.crm'],
    invokeBoundary: 'Validate, enrich, or follow up one provenance-linked property lead under review policy.',
    verifyBoundary: 'Read back the acquisition pipeline record, approval, and delivered message evidence.',
  },
  {
    serviceId: 'home-services-lead-scheduling-operator', capabilityId: 'client_ops.home_services.schedule_lead',
    ownedSourceIdentifier: 'BlackLabelFrontDesk', readiness: 'declared',
    requiredFoundationIdentifiers: ['BlackLabelFrontDesk', 'BlackLabelPlatform.scheduling', 'BlackLabelPlatform.customers', 'BlackLabelPlatform.industries'],
    invokeBoundary: 'Qualify one service request or book one approved appointment within territory and capacity policy.',
    verifyBoundary: 'Read back serviceability checks, the created calendar slot, and confirmation delivery.',
  },
  {
    serviceId: 'law-firm-intake-document-routing', capabilityId: 'client_ops.law_firm.route_intake',
    ownedSourceIdentifier: 'BlackLabelSupport.ticket_workflow', readiness: 'declared',
    requiredFoundationIdentifiers: ['BlackLabelSupport.ticket_workflow', 'BlackLabelPlatform.files', 'BlackLabelPlatform.reviews', 'BlackLabelPlatform.crm'],
    invokeBoundary: 'Capture one intake packet or classify and route one preserved document without legal conclusions.',
    verifyBoundary: 'Read back the intake record, document custody hash, and firm review routing.',
  },
  {
    serviceId: 'property-management-maintenance-desk', capabilityId: 'client_ops.property_management.dispatch_work_order',
    ownedSourceIdentifier: 'BlackLabelPlatform.vendors', readiness: 'declared',
    requiredFoundationIdentifiers: ['BlackLabelPlatform.files', 'BlackLabelPlatform.vendors', 'BlackLabelPlatform.workflows', 'BlackLabelPlatform.messaging'],
    invokeBoundary: 'Triage one maintenance request or dispatch one approved vendor work order.',
    verifyBoundary: 'Read back work-order state, dispatch approval, and resident and manager notification evidence.',
  },
  {
    serviceId: 'ecommerce-support-marketing-operator', capabilityId: 'client_ops.ecommerce.operate_support_campaign',
    ownedSourceIdentifier: 'BlackLabelPlatform.orders', readiness: 'declared',
    requiredFoundationIdentifiers: ['BlackLabelPlatform.orders', 'BlackLabelSupport', 'BlackLabelMarketing', 'BlackLabelPlatform.reviews'],
    invokeBoundary: 'Resolve one order-grounded support case or publish one exact approved commerce campaign item.',
    verifyBoundary: 'Read back order facts, approval, reply or publication proof, and recorded outcomes.',
  },
  {
    serviceId: 'local-business-review-reactivation-system', capabilityId: 'client_ops.local_business.run_reactivation',
    ownedSourceIdentifier: 'BlackLabelPlatform.customers', readiness: 'declared',
    requiredFoundationIdentifiers: ['BlackLabelPlatform.reviews', 'BlackLabelPlatform.customers', 'BlackLabelMarketing.outreach', 'BlackLabelPlatform.loyalty'],
    invokeBoundary: 'Send one eligible feedback request or run one approved reactivation step under consent policy.',
    verifyBoundary: 'Read back eligibility rules, approval, delivery, and response or opt-out routing.',
  },
]);

export interface RegisteredFoundationState extends ServiceExecutionFoundation {
  connected: boolean;
  adapterReadiness: FoundationAdapterReadiness;
}

/** Deterministic adapter registry; starts with all fifteen declarations disconnected. */
export class ServiceFoundationRegistry {
  private readonly adapters = new Map<string, ServiceFoundationAdapter>();

  register(adapter: ServiceFoundationAdapter): void {
    const declaration = SERVICE_EXECUTION_FOUNDATIONS.find((item) => item.capabilityId === adapter.capabilityId);
    if (!declaration) throw ApiError.badRequest(`unknown client-ops capability: ${adapter.capabilityId}`);
    if (declaration.serviceId !== adapter.serviceId || declaration.ownedSourceIdentifier !== adapter.ownedSourceIdentifier) {
      throw ApiError.badRequest(`adapter identity does not match declaration: ${adapter.capabilityId}`);
    }
    if (this.adapters.has(adapter.capabilityId)) throw ApiError.conflict(`adapter already registered: ${adapter.capabilityId}`);
    this.adapters.set(adapter.capabilityId, adapter);
  }

  unregister(capabilityId: string): boolean {
    return this.adapters.delete(capabilityId);
  }

  get(capabilityId: string): ServiceFoundationAdapter | undefined {
    return this.adapters.get(capabilityId);
  }

  list(): RegisteredFoundationState[] {
    return SERVICE_EXECUTION_FOUNDATIONS.map((declaration) => {
      const adapter = this.adapters.get(declaration.capabilityId);
      return {
        ...declaration,
        connected: adapter !== undefined,
        adapterReadiness: adapter?.readiness() ?? 'declared',
      };
    }).sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  }

  async invoke(capabilityId: string, request: FoundationInvocationRequest): Promise<FoundationInvocationResult> {
    const adapter = this.adapters.get(capabilityId);
    if (!adapter) throw new ApiError(501, `service foundation adapter not connected: ${capabilityId}`, 'not_implemented');
    if (adapter.readiness() !== 'ready') throw ApiError.conflict(`service foundation adapter is not ready: ${capabilityId}`);
    return adapter.invoke(request);
  }

  async verify(capabilityId: string, request: FoundationVerificationRequest): Promise<FoundationVerificationResult> {
    const adapter = this.adapters.get(capabilityId);
    if (!adapter) throw new ApiError(501, `service foundation adapter not connected: ${capabilityId}`, 'not_implemented');
    return adapter.verify(request);
  }
}
