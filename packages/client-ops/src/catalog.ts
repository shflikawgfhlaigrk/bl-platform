export type ReadinessStatus = 'foundation_ready' | 'integration_required' | 'design_ready';
export type TriggerType = 'event' | 'schedule' | 'inbound' | 'manual';

export interface CatalogTrigger {
  id: string;
  name: string;
  type: TriggerType;
  description: string;
  eventType: string;
}

export interface CatalogAction {
  id: string;
  name: string;
  type: string;
  description: string;
  connectorId: string | null;
  mutatesExternalState: boolean;
}

export interface CatalogConnector {
  id: string;
  label: string;
  required: boolean;
  capabilities: string[];
}

export interface CatalogApproval {
  id: string;
  name: string;
  when: string;
  decisions: Array<'approve' | 'deny' | 'hold'>;
}

export interface CatalogArtifact {
  id: string;
  label: string;
  format: string;
  verification: string;
}

export interface CatalogMetric {
  id: string;
  label: string;
  unit: string;
  direction: 'increase' | 'decrease' | 'observe';
}

export interface CatalogOnboardingStep {
  id: string;
  title: string;
  description: string;
  required: boolean;
}

export interface CatalogWorkflow {
  id: string;
  name: string;
  outcome: string;
  triggerId: string;
  actionIds: string[];
  approvalId: string;
  artifactIds: string[];
  metricIds: string[];
}

export interface CatalogReadiness {
  status: ReadinessStatus;
  summary: string;
  dependencies: string[];
}

export interface CatalogOffering {
  id: string;
  name: string;
  summary: string;
  outcomes: string[];
  workflows: CatalogWorkflow[];
  triggers: CatalogTrigger[];
  actions: CatalogAction[];
  connectors: CatalogConnector[];
  approvals: CatalogApproval[];
  artifacts: CatalogArtifact[];
  metrics: CatalogMetric[];
  onboarding: CatalogOnboardingStep[];
  foundationIdentifiers: string[];
  readiness: CatalogReadiness;
}

export interface EngagementModel {
  id: string;
  name: string;
  description: string;
  scope: string[];
  deliverables: string[];
  operatingCadence: string[];
  idealFor: string[];
}

export interface ClientOpsCatalog {
  schemaVersion: '1.0.0';
  catalogVersion: string;
  services: CatalogOffering[];
  verticalPacks: CatalogOffering[];
  engagementModels: EngagementModel[];
}

interface WorkflowInput {
  id: string;
  name: string;
  outcome: string;
  trigger: Omit<CatalogTrigger, 'id'>;
  actions: Array<Omit<CatalogAction, 'id'>>;
  approvalWhen: string;
}

interface OfferingInput {
  id: string;
  name: string;
  summary: string;
  outcomes: string[];
  workflows: WorkflowInput[];
  connectors: CatalogConnector[];
  artifacts: Array<Omit<CatalogArtifact, 'id'>>;
  metrics: Array<Omit<CatalogMetric, 'id'>>;
  onboarding: Array<Omit<CatalogOnboardingStep, 'id'>>;
  foundationIdentifiers: string[];
  readiness: CatalogReadiness;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildOffering(input: OfferingInput): CatalogOffering {
  const artifacts = input.artifacts.map((item) => ({
    ...item,
    id: `${input.id}.artifact.${slug(item.label)}`,
  }));
  const metrics = input.metrics.map((item) => ({
    ...item,
    id: `${input.id}.metric.${slug(item.label)}`,
  }));
  const onboarding = input.onboarding.map((item) => ({
    ...item,
    id: `${input.id}.onboarding.${slug(item.title)}`,
  }));
  const triggers: CatalogTrigger[] = [];
  const actions: CatalogAction[] = [];
  const approvals: CatalogApproval[] = [];
  const workflows = input.workflows.map((workflow) => {
    const trigger: CatalogTrigger = {
      ...workflow.trigger,
      id: `${input.id}.trigger.${workflow.id}`,
    };
    const workflowActions = workflow.actions.map((action, position) => ({
      ...action,
      id: `${input.id}.action.${workflow.id}_${position + 1}_${slug(action.name)}`,
    }));
    const approval: CatalogApproval = {
      id: `${input.id}.approval.${workflow.id}`,
      name: `${workflow.name} review policy`,
      when: workflow.approvalWhen,
      decisions: ['approve', 'deny', 'hold'],
    };
    triggers.push(trigger);
    actions.push(...workflowActions);
    approvals.push(approval);
    return {
      id: `${input.id}.workflow.${workflow.id}`,
      name: workflow.name,
      outcome: workflow.outcome,
      triggerId: trigger.id,
      actionIds: workflowActions.map((item) => item.id),
      approvalId: approval.id,
      artifactIds: artifacts.map((item) => item.id),
      metricIds: metrics.map((item) => item.id),
    };
  });

  return {
    id: input.id,
    name: input.name,
    summary: input.summary,
    outcomes: input.outcomes,
    workflows,
    triggers,
    actions,
    connectors: input.connectors,
    approvals,
    artifacts,
    metrics,
    onboarding,
    foundationIdentifiers: input.foundationIdentifiers,
    readiness: input.readiness,
  };
}

const connector = (
  id: string,
  label: string,
  required: boolean,
  capabilities: string[],
): CatalogConnector => ({ id, label, required, capabilities });

const action = (
  name: string,
  type: string,
  description: string,
  connectorId: string | null,
  mutatesExternalState = true,
): Omit<CatalogAction, 'id'> => ({
  name,
  type,
  description,
  connectorId,
  mutatesExternalState,
});

const workflow = (
  id: string,
  name: string,
  outcome: string,
  triggerType: TriggerType,
  eventType: string,
  triggerDescription: string,
  actions: Array<Omit<CatalogAction, 'id'>>,
  approvalWhen: string,
): WorkflowInput => ({
  id,
  name,
  outcome,
  trigger: { name: `${name} trigger`, type: triggerType, eventType, description: triggerDescription },
  actions,
  approvalWhen,
});

const artifact = (
  label: string,
  format: string,
  verification: string,
): Omit<CatalogArtifact, 'id'> => ({ label, format, verification });

const metric = (
  label: string,
  unit: string,
  direction: CatalogMetric['direction'],
): Omit<CatalogMetric, 'id'> => ({ label, unit, direction });

const onboard = (
  title: string,
  description: string,
  required = true,
): Omit<CatalogOnboardingStep, 'id'> => ({ title, description, required });

const services: CatalogOffering[] = [
  buildOffering({
    id: 'workflow-operating-system',
    name: 'Workflow Operating System',
    summary: 'Automated workflows, schedules, approvals, retries, receipts, and a management dashboard.',
    outcomes: ['Repeatable operations run on schedule or event', 'Exceptions reach a human with evidence', 'Every completed run has a receipt'],
    workflows: [
      workflow('scheduled_operation', 'Scheduled operation', 'A recurring process completes with retry history and evidence.', 'schedule', 'client_ops.schedule.due', 'A configured operating schedule becomes due.', [action('Load operating checklist', 'load_checklist', 'Load the versioned workflow inputs and policy.', null, false), action('Execute connected actions', 'execute_actions', 'Run the approved sequence against connected systems.', 'operations-system'), action('Publish completion receipt', 'publish_receipt', 'Record outputs, verification, and follow-up actions.', null, false)], 'Hold for approval when policy, confidence, or connector health requires review.'),
      workflow('exception_recovery', 'Exception recovery', 'A failed step is diagnosed, retried, and escalated with context.', 'event', 'client_ops.run.failed', 'An installed workflow reports a failed run.', [action('Classify failure', 'classify_failure', 'Separate transient, credential, data, and policy failures.', null, false), action('Retry eligible work', 'retry_run', 'Create a retry with explicit lineage and idempotency.', 'operations-system'), action('Escalate unresolved failure', 'create_review', 'Create a review item with evidence and resolution options.', 'review-inbox')], 'Require approval before a retry that could duplicate or change external state.'),
    ],
    connectors: [connector('operations-system', 'Client operations system', true, ['read records', 'apply approved changes', 'read back changes']), connector('review-inbox', 'Black Label Review Inbox', true, ['approve', 'deny', 'hold'])],
    artifacts: [artifact('Completion receipt', 'application/json', 'Includes action results and external readback.'), artifact('Operations exception packet', 'application/json', 'Includes failure classification, retry lineage, and next action.')],
    metrics: [metric('Workflow completion', 'runs', 'increase'), metric('Unresolved failures', 'runs', 'decrease')],
    onboarding: [onboard('Map operating processes', 'Document owners, triggers, actions, exceptions, and evidence.'), onboard('Connect operating systems', 'Authorize and health-check each required connector.'), onboard('Set approval policy', 'Choose automatic boundaries and human review conditions.')],
    foundationIdentifiers: ['BlackLabelPlatform.workflows', 'BlackLabelPlatform.actions', 'BlackLabelPlatform.automation', 'BlackLabelPlatform.reviews'],
    readiness: { status: 'foundation_ready', summary: 'Core workflow, action, automation, and review primitives are reusable now.', dependencies: ['client connector adapters', 'client approval policy'] },
  }),
  buildOffering({
    id: 'ai-front-desk',
    name: 'AI Front Desk',
    summary: 'Phone receptionist, qualification, scheduling, transfers, callbacks, and summaries.',
    outcomes: ['Calls receive a consistent response', 'Qualified callers reach the correct next step', 'Owners receive verified call outcomes'],
    workflows: [
      workflow('inbound_call', 'Inbound call handling', 'A caller is answered, qualified, routed, and summarized.', 'inbound', 'frontdesk.call.received', 'A call arrives on the client line.', [action('Answer and qualify', 'voice_qualify', 'Use the approved script, knowledge, and barge-in voice loop.', 'telephony'), action('Create or update contact', 'upsert_contact', 'Write the verified caller details to the system of record.', 'crm'), action('Schedule or transfer', 'schedule_or_transfer', 'Book an allowed slot or transfer by policy.', 'calendar'), action('Send call summary', 'send_summary', 'Deliver disposition and follow-up details.', 'messaging')], 'Require approval for exceptions, sensitive commitments, and disallowed transfer or scheduling conditions.'),
      workflow('callback_followup', 'Callback follow-up', 'Missed or deferred calls receive a tracked callback and outcome.', 'event', 'frontdesk.callback.requested', 'A call requires a later callback.', [action('Prepare callback brief', 'prepare_callback', 'Assemble caller context and the approved next step.', 'crm', false), action('Place or assign callback', 'place_callback', 'Place the call or assign it to the correct person.', 'telephony'), action('Record callback outcome', 'record_outcome', 'Persist the disposition and evidence.', 'crm')], 'Require approval when the callback content is outside the approved script.'),
    ],
    connectors: [connector('telephony', 'Telephony provider', true, ['receive calls', 'transfer calls', 'place callbacks']), connector('calendar', 'Scheduling calendar', true, ['read availability', 'create appointments']), connector('crm', 'Contact system', true, ['find contacts', 'create or update contacts']), connector('messaging', 'Email or SMS provider', false, ['send summaries', 'send confirmations'])],
    artifacts: [artifact('Call summary', 'application/json', 'Links call disposition to contact and scheduling changes.'), artifact('Call transcript', 'text/plain', 'Stored according to client consent and retention policy.')],
    metrics: [metric('Calls resolved', 'calls', 'increase'), metric('Missed calls', 'calls', 'decrease')],
    onboarding: [onboard('Configure phone routing', 'Provision numbers, hours, transfers, and fallback behavior.'), onboard('Approve qualification script', 'Set terminology, questions, exclusions, and escalation rules.'), onboard('Connect scheduling and contacts', 'Authorize calendars and contact records, then verify read/write access.')],
    foundationIdentifiers: ['BlackLabelFrontDesk.realtime_voice', 'BlackLabelFrontDesk.call_operations', 'BlackLabelPlatform.scheduling', 'BlackLabelPlatform.customers'],
    readiness: { status: 'integration_required', summary: 'Voice and scheduling foundations are reusable; each client still needs telephony and system adapters.', dependencies: ['telephony credentials', 'calendar connection', 'approved call policy'] },
  }),
  buildOffering({
    id: 'sales-operator',
    name: 'Sales Operator',
    summary: 'Lead intake, enrichment, follow-up preparation, pipeline alerts, and CRM updates.',
    outcomes: ['New leads become actionable records', 'Follow-up is timely and reviewable', 'Pipeline risks surface before opportunities stall'],
    workflows: [
      workflow('lead_intake', 'Lead intake and enrichment', 'A new lead becomes a deduplicated, enriched CRM record.', 'event', 'sales.lead.received', 'A lead arrives from a configured source.', [action('Validate and deduplicate', 'validate_lead', 'Check required fields, quality, and existing records.', 'lead-source', false), action('Enrich lead', 'enrich_lead', 'Add approved business and contact context.', 'enrichment'), action('Update CRM', 'upsert_lead', 'Create or update the pipeline record with provenance.', 'crm')], 'Hold low-confidence matches and any proposed overwrite of protected CRM fields.'),
      workflow('sales_followup', 'Sales follow-up preparation', 'The owner receives an approved follow-up and a tracked next step.', 'schedule', 'sales.followup.due', 'A lead reaches its configured follow-up time.', [action('Prepare grounded follow-up', 'draft_followup', 'Draft from CRM facts, source context, and approved messaging.', 'crm', false), action('Request message approval', 'create_review', 'Present the exact send with supporting context.', 'review-inbox'), action('Send and record outcome', 'send_followup', 'Send after approval and update the pipeline.', 'messaging')], 'Require explicit approval before outbound messages unless the client enables a bounded template policy.'),
    ],
    connectors: [connector('lead-source', 'Lead source', true, ['receive leads', 'preserve provenance']), connector('enrichment', 'Enrichment provider', false, ['enrich company', 'verify contact']), connector('crm', 'CRM', true, ['read pipeline', 'create or update leads']), connector('messaging', 'Outbound messaging', true, ['send approved messages']), connector('review-inbox', 'Black Label Review Inbox', true, ['approve', 'deny', 'hold'])],
    artifacts: [artifact('Lead provenance record', 'application/json', 'Lists source, validation, enrichment, and changes.'), artifact('Follow-up receipt', 'application/json', 'Links approved content, delivery result, and CRM update.')],
    metrics: [metric('Qualified leads', 'leads', 'increase'), metric('Overdue follow-ups', 'leads', 'decrease')],
    onboarding: [onboard('Map lead sources', 'Register each source, consent basis, and required fields.'), onboard('Connect CRM and messaging', 'Authorize least-privilege read/write access and verify it.'), onboard('Approve follow-up policy', 'Set templates, personalization boundaries, cadence, and review rules.')],
    foundationIdentifiers: ['BlackLabelLeadsAPI', 'BlackLabelMarketing.outreach', 'BlackLabelPlatform.crm', 'BlackLabelPlatform.reviews'],
    readiness: { status: 'foundation_ready', summary: 'Lead, outreach, CRM, and review foundations can be configured per client.', dependencies: ['source mapping', 'CRM adapter', 'outbound consent policy'] },
  }),
  buildOffering({
    id: 'marketing-operator',
    name: 'Marketing Operator',
    summary: 'Content creation, publishing schedules, campaign workflows, approvals, and performance briefs.',
    outcomes: ['Campaign work moves through one approval flow', 'Publishing is scheduled and evidenced', 'Performance becomes an operational feedback loop'],
    workflows: [
      workflow('campaign_production', 'Campaign production', 'A campaign brief becomes approved channel-ready artifacts.', 'event', 'marketing.brief.approved', 'A client approves a campaign brief.', [action('Create channel assets', 'create_assets', 'Generate content from the approved brief and brand rules.', 'media-library'), action('Request campaign approval', 'create_review', 'Present exact assets, copy, and destinations.', 'review-inbox'), action('Register approved artifacts', 'register_artifacts', 'Version the approved outputs for publishing.', 'media-library')], 'Require explicit approval for every net-new public asset or claim.'),
      workflow('scheduled_publishing', 'Scheduled publishing', 'Approved content publishes on schedule with delivery evidence.', 'schedule', 'marketing.publish.due', 'An approved campaign item reaches its publish time.', [action('Validate approval and destination', 'validate_publish', 'Confirm asset version, approval, account, and schedule.', 'media-publisher', false), action('Publish content', 'publish_content', 'Send the approved asset to the selected channel.', 'media-publisher'), action('Collect performance brief', 'collect_performance', 'Record delivery and available outcome metrics.', 'analytics', false)], 'Hold when approval, account health, or the exact artifact version cannot be proven.'),
    ],
    connectors: [connector('media-library', 'Media library', true, ['store versions', 'preview artifacts']), connector('review-inbox', 'Black Label Review Inbox', true, ['approve', 'deny', 'hold']), connector('media-publisher', 'Publishing channels', true, ['schedule content', 'publish approved content']), connector('analytics', 'Campaign analytics', false, ['read delivery', 'read performance'])],
    artifacts: [artifact('Campaign asset package', 'application/zip', 'Contains approved versions and manifest hashes.'), artifact('Performance brief', 'application/json', 'Links channel results to the published artifact versions.')],
    metrics: [metric('Approved campaign items', 'items', 'increase'), metric('Publishing failures', 'items', 'decrease')],
    onboarding: [onboard('Load brand policy', 'Capture voice, claims, visual rules, exclusions, and approvers.'), onboard('Connect publishing accounts', 'Authorize destinations and test account health without publishing.'), onboard('Configure campaign approval', 'Set approvers, version rules, schedule windows, and stop conditions.')],
    foundationIdentifiers: ['BlackLabelMarketing.media_engine', 'BlackLabelMarketing.publisher', 'BlackLabelPlatform.files', 'BlackLabelPlatform.reviews'],
    readiness: { status: 'integration_required', summary: 'Media and artifact foundations are reusable; destination publishers need client connections.', dependencies: ['brand policy', 'publisher credentials', 'measurement access'] },
  }),
  buildOffering({
    id: 'support-operator',
    name: 'Support Operator',
    summary: 'Grounded response drafts, ticket intake, attachments, escalation, and human approval.',
    outcomes: ['Requests become complete tickets', 'Responses remain grounded in approved knowledge', 'Escalations carry the evidence needed to act'],
    workflows: [
      workflow('ticket_intake', 'Ticket intake', 'An inbound request becomes a classified ticket with attachments and priority.', 'inbound', 'support.message.received', 'A support message or form submission arrives.', [action('Capture request and attachments', 'create_ticket', 'Store the source message, attachments, and customer references.', 'helpdesk'), action('Classify and prioritize', 'classify_ticket', 'Apply the approved issue and urgency taxonomy.', 'helpdesk'), action('Escalate priority cases', 'route_escalation', 'Route urgent or sensitive issues to the named owner.', 'review-inbox')], 'Require review for safety, legal, account access, refunds, or other client-defined sensitive categories.'),
      workflow('grounded_response', 'Grounded response', 'A verified answer is approved, delivered, and attached to the ticket.', 'event', 'support.ticket.ready', 'A ticket has sufficient context for a response.', [action('Retrieve approved knowledge', 'retrieve_knowledge', 'Load only client-approved sources with citations.', 'knowledge-base', false), action('Draft grounded response', 'draft_response', 'Prepare an answer tied to retrieved evidence.', 'helpdesk', false), action('Approve and send', 'approve_and_send', 'Send after the configured review gate and record delivery.', 'messaging')], 'Require approval when evidence is incomplete, confidence is low, or policy marks the category sensitive.'),
    ],
    connectors: [connector('helpdesk', 'Helpdesk', true, ['create tickets', 'update status', 'attach replies']), connector('knowledge-base', 'Approved knowledge base', true, ['retrieve sources', 'return citations']), connector('review-inbox', 'Black Label Review Inbox', true, ['approve', 'deny', 'hold']), connector('messaging', 'Support messaging', true, ['receive messages', 'send approved responses'])],
    artifacts: [artifact('Grounding packet', 'application/json', 'Lists the sources and claims used by the response.'), artifact('Ticket completion receipt', 'application/json', 'Links intake, approval, delivery, and final ticket state.')],
    metrics: [metric('Grounded responses', 'responses', 'increase'), metric('Unresolved escalations', 'tickets', 'decrease')],
    onboarding: [onboard('Connect support channels', 'Authorize helpdesk and messaging intake.'), onboard('Approve knowledge sources', 'Register authoritative sources, owners, and refresh rules.'), onboard('Set escalation policy', 'Define categories, urgency, approvers, and response boundaries.')],
    foundationIdentifiers: ['BlackLabelSupport.safety_engine', 'BlackLabelSupport.ticket_workflow', 'BlackLabelPlatform.messaging', 'BlackLabelPlatform.files'],
    readiness: { status: 'foundation_ready', summary: 'Ticket, files, messaging, and grounded-response patterns are reusable.', dependencies: ['approved knowledge corpus', 'support channels', 'escalation owners'] },
  }),
  buildOffering({
    id: 'executive-operations-hq',
    name: 'Executive Operations HQ',
    summary: 'A company-wide action center showing work, failures, approvals, costs, and outcomes.',
    outcomes: ['Leaders see one operational truth surface', 'Failures and approvals have clear owners', 'Usage and outcomes can be reviewed together'],
    workflows: [
      workflow('daily_operations_brief', 'Daily operations brief', 'Leadership receives a verified summary of completed, pending, failed, and costly work.', 'schedule', 'hq.brief.due', 'The configured executive reporting window closes.', [action('Collect module summaries', 'collect_summaries', 'Aggregate only registered client-ops operational records.', 'operations-data', false), action('Highlight decisions and failures', 'prioritize_attention', 'Rank pending reviews, failures, and stale onboarding.', 'operator-dashboard', false), action('Publish executive brief', 'publish_brief', 'Create a deep-linked evidence artifact.', 'operator-dashboard', false)], 'Require approval only for distribution outside the configured leadership audience.'),
      workflow('operational_escalation', 'Operational escalation', 'A critical failure becomes an owned action card with evidence.', 'event', 'client_ops.run.failed', 'A run meets the client criticality policy.', [action('Assemble failure evidence', 'assemble_failure', 'Link run, lineage, artifacts, connector health, and usage.', 'operations-data', false), action('Assign resolution owner', 'assign_owner', 'Route the action to the configured accountable role.', 'operator-dashboard'), action('Track resolution receipt', 'track_resolution', 'Close only when remediation and verification are recorded.', 'operator-dashboard')], 'Require approval before any remediation that changes an external system.'),
    ],
    connectors: [connector('operations-data', 'Client operations data', true, ['read run state', 'read approvals', 'read usage']), connector('operator-dashboard', 'Executive dashboard', true, ['show action cards', 'deep-link evidence', 'assign owners'])],
    artifacts: [artifact('Executive operations brief', 'application/json', 'Every statement links to module-owned evidence.'), artifact('Resolution receipt', 'application/json', 'Records failure, owner, remediation, and verification.')],
    metrics: [metric('Resolved operating exceptions', 'exceptions', 'increase'), metric('Pending executive decisions', 'items', 'decrease')],
    onboarding: [onboard('Define leadership scope', 'Choose visible installations, roles, and audiences.'), onboard('Set escalation thresholds', 'Define criticality, staleness, cost, and failure rules.'), onboard('Configure reporting cadence', 'Set delivery windows and recipients.')],
    foundationIdentifiers: ['BlackLabelHQ', 'BlackLabelAtlas', 'BlackLabelPlatform.dashboard', 'BlackLabelPlatform.actions'],
    readiness: { status: 'foundation_ready', summary: 'HQ, action, and evidence patterns are reusable through this module-owned read model.', dependencies: ['leadership roles', 'escalation policy', 'reporting schedule'] },
  }),
  buildOffering({
    id: 'private-company-agent',
    name: 'Private Company Agent',
    summary: 'A local/private knowledge assistant with company tools, memory, and controlled computer use.',
    outcomes: ['Company knowledge stays inside approved boundaries', 'Tool actions are controlled and reviewable', 'Every consequential action has verification evidence'],
    workflows: [
      workflow('grounded_company_answer', 'Grounded company answer', 'A company question is answered from approved sources with citations.', 'inbound', 'private_agent.question.received', 'An authorized user asks a company question.', [action('Authorize request', 'authorize_request', 'Check identity, role, and requested capability.', 'identity', false), action('Retrieve private context', 'retrieve_context', 'Load scoped company sources and memory.', 'private-knowledge', false), action('Return cited answer', 'answer_with_citations', 'Answer with source references or state that evidence is absent.', null, false)], 'Hold when requested data or tool scope exceeds the user role.'),
      workflow('controlled_computer_action', 'Controlled computer action', 'An approved local computer action runs and is verified.', 'manual', 'private_agent.action.requested', 'An authorized user requests a controlled computer action.', [action('Prepare action plan', 'prepare_action', 'Describe target, steps, side effects, and verification.', 'computer-use', false), action('Request consequential approval', 'create_review', 'Present the exact proposed external mutation.', 'review-inbox'), action('Execute and verify', 'execute_verified_action', 'Run through the signed helper and capture post-action proof.', 'computer-use')], 'Require approval for external writes, permission changes, credential use, or client-defined consequential actions.'),
    ],
    connectors: [connector('identity', 'Company identity provider', true, ['authenticate users', 'resolve roles']), connector('private-knowledge', 'Private knowledge store', true, ['retrieve scoped sources', 'store approved memory']), connector('computer-use', 'Signed OperatorKit helper', false, ['capture screen', 'perform approved input', 'verify result']), connector('review-inbox', 'Black Label Review Inbox', true, ['approve', 'deny', 'hold'])],
    artifacts: [artifact('Grounding record', 'application/json', 'Lists sources, access scope, and answer claims.'), artifact('Computer action receipt', 'application/json', 'Includes approval, action trace, and post-action verification.')],
    metrics: [metric('Cited answers', 'answers', 'increase'), metric('Unverified external actions', 'actions', 'decrease')],
    onboarding: [onboard('Connect identity', 'Map users and roles to allowed data and tools.'), onboard('Register private sources', 'Select authoritative company knowledge and retention policy.'), onboard('Configure tool permissions', 'Grant least privilege and define approval boundaries.')],
    foundationIdentifiers: ['BlackLabelSovereign', 'ProjectUtah.RAG', 'BlackLabelOperatorKit', 'BlackLabelPlatform.reviews'],
    readiness: { status: 'integration_required', summary: 'Private RAG and controlled-action foundations exist; identity and local permissions are client-specific.', dependencies: ['identity mapping', 'approved source registry', 'signed helper permissions'] },
  }),
  buildOffering({
    id: 'data-operations-service',
    name: 'Data Operations Service',
    summary: 'Imports, enrichment, scheduled data jobs, quality monitoring, and failure recovery.',
    outcomes: ['Data movement is repeatable and traceable', 'Quality gates stop bad records before delivery', 'Failures resume from explicit lineage and checkpoints'],
    workflows: [
      workflow('scheduled_data_job', 'Scheduled data job', 'A source slice is imported, validated, transformed, and delivered with a receipt.', 'schedule', 'data.job.due', 'A registered data job reaches its schedule.', [action('Read source checkpoint', 'read_checkpoint', 'Resume from the exact recorded source boundary.', 'data-source', false), action('Validate and transform', 'validate_transform', 'Apply versioned mapping and quality rules.', 'data-quality', false), action('Deliver accepted records', 'deliver_records', 'Write only accepted records to the configured destination.', 'data-destination'), action('Write export receipt', 'write_receipt', 'Record counts, rejects, versions, and checkpoints.', null, false)], 'Hold when schema drift, reject thresholds, or destination changes exceed policy.'),
      workflow('data_failure_recovery', 'Data failure recovery', 'A failed job resumes safely from its last verified checkpoint.', 'event', 'data.job.failed', 'A scheduled data job fails.', [action('Classify data failure', 'classify_data_failure', 'Identify source, mapping, quality, destination, or transient failure.', 'data-quality', false), action('Prepare recovery plan', 'prepare_recovery', 'Select checkpoint and idempotency boundary.', null, false), action('Retry or escalate', 'retry_or_escalate', 'Create a lineage-linked retry or review item.', 'review-inbox')], 'Require approval before replaying a range that may duplicate destination records.'),
    ],
    connectors: [connector('data-source', 'Source data system', true, ['read records', 'read checkpoints']), connector('data-quality', 'Data quality rules', true, ['validate schema', 'quarantine rejects']), connector('data-destination', 'Destination system', true, ['write accepted records', 'read back delivery']), connector('review-inbox', 'Black Label Review Inbox', true, ['approve', 'deny', 'hold'])],
    artifacts: [artifact('Data job receipt', 'application/json', 'Records source range, versions, counts, rejects, and destination proof.'), artifact('Reject file', 'text/csv', 'Contains rejected rows with machine-readable reasons.')],
    metrics: [metric('Accepted records', 'records', 'increase'), metric('Rejected records', 'records', 'decrease')],
    onboarding: [onboard('Register source and destination', 'Document owners, schemas, access, and checkpoints.'), onboard('Approve mappings and quality gates', 'Version field mappings, required values, and reject thresholds.'), onboard('Test recovery path', 'Run a bounded failure and prove idempotent resume behavior.')],
    foundationIdentifiers: ['BlackLabelPropertyHarvest.jobs', 'BlackLabelLeadsAPI.source_ledger', 'BlackLabelPlatform.files', 'BlackLabelPlatform.automation'],
    readiness: { status: 'foundation_ready', summary: 'Leased jobs, source ledgers, files, and automation patterns are reusable.', dependencies: ['source adapter', 'destination adapter', 'mapping and quality policy'] },
  }),
];

const verticalPacks: CatalogOffering[] = [
  buildOffering({
    id: 'medical-dental-receptionist',
    name: 'Medical/Dental Receptionist',
    summary: 'A privacy-aware receptionist pack for calls, patient qualification, scheduling, routing, and follow-up.',
    outcomes: ['Patients reach the correct appointment or staff queue', 'Sensitive requests follow approved routing', 'Every interaction has a minimal verified receipt'],
    workflows: [
      workflow('patient_call', 'Patient call routing', 'A patient call is answered and routed without exceeding approved scope.', 'inbound', 'medical.call.received', 'A patient or prospective patient calls the practice.', [action('Verify routing context', 'verify_patient_context', 'Collect only the minimum approved routing information.', 'telephony'), action('Schedule allowed visit', 'schedule_visit', 'Offer approved appointment types and slots.', 'practice-management'), action('Escalate clinical or sensitive request', 'escalate_request', 'Route outside-scope requests to staff without diagnosis.', 'review-inbox')], 'Require staff review for clinical, urgent, billing-dispute, privacy, or policy exceptions.'),
      workflow('appointment_followup', 'Appointment follow-up', 'A patient receives the approved confirmation or follow-up and the practice record is updated.', 'event', 'medical.appointment.changed', 'An appointment is created, changed, or canceled.', [action('Prepare approved message', 'prepare_patient_message', 'Use the practice-approved template and appointment facts.', 'practice-management', false), action('Send notification', 'send_patient_message', 'Send through the approved communication channel.', 'messaging'), action('Record delivery', 'record_delivery', 'Attach delivery evidence to the operating receipt.', 'practice-management')], 'Hold communications that contain unapproved sensitive detail or lack consent.'),
    ],
    connectors: [connector('telephony', 'Practice telephony', true, ['receive calls', 'transfer calls']), connector('practice-management', 'Practice management system', true, ['read appointment types', 'create or update appointments']), connector('messaging', 'Patient messaging', true, ['send approved notifications']), connector('review-inbox', 'Staff Review Inbox', true, ['approve', 'deny', 'hold'])],
    artifacts: [artifact('Patient interaction receipt', 'application/json', 'Stores minimum necessary routing and scheduling evidence.'), artifact('Staff escalation packet', 'application/json', 'Contains reason, urgency, and contact path without unsupported conclusions.')],
    metrics: [metric('Calls routed', 'calls', 'increase'), metric('Unresolved staff escalations', 'items', 'decrease')],
    onboarding: [onboard('Approve privacy and call scope', 'Define minimum data, prohibited topics, consent, and retention.'), onboard('Map appointment types', 'Register allowed scheduling rules, providers, and exceptions.'), onboard('Configure staff escalation', 'Set urgent, clinical, privacy, and billing routes.')],
    foundationIdentifiers: ['BlackLabelFrontDesk.realtime_voice', 'BlackLabelPlatform.scheduling', 'BlackLabelPlatform.messaging', 'BlackLabelPlatform.reviews'],
    readiness: { status: 'integration_required', summary: 'Front desk primitives are reusable; practice-system integration and policy review are required.', dependencies: ['practice management adapter', 'privacy policy', 'staff escalation map'] },
  }),
  buildOffering({
    id: 'real-estate-acquisition-desk',
    name: 'Real-Estate Acquisition Desk',
    summary: 'A pack for lead intake, property enrichment, qualification, follow-up, and acquisition review.',
    outcomes: ['Property leads enter one traceable pipeline', 'Acquisition context is assembled consistently', 'Offers or consequential messages stay under review'],
    workflows: [
      workflow('property_lead_intake', 'Property lead intake', 'A property lead becomes a deduplicated, enriched acquisition record.', 'event', 'real_estate.lead.received', 'A seller or property lead enters a registered source.', [action('Validate property lead', 'validate_property_lead', 'Check identity, address, source, and duplicate state.', 'lead-source', false), action('Enrich property context', 'enrich_property', 'Collect approved public and licensed property facts.', 'property-data', false), action('Update acquisition pipeline', 'update_pipeline', 'Write the sourced record and next step.', 'crm')], 'Hold conflicting ownership, contact, or property matches for review.'),
      workflow('acquisition_followup', 'Acquisition follow-up', 'A reviewed seller follow-up is delivered and recorded.', 'schedule', 'real_estate.followup.due', 'An acquisition record reaches its next contact time.', [action('Prepare seller brief', 'prepare_seller_brief', 'Summarize sourced facts and unanswered qualification fields.', 'crm', false), action('Request outreach approval', 'create_review', 'Present exact message and recipient.', 'review-inbox'), action('Send and update pipeline', 'send_and_update', 'Deliver after approval and record outcome.', 'messaging')], 'Require approval for every offer, valuation claim, or non-template outbound message.'),
    ],
    connectors: [connector('lead-source', 'Property lead source', true, ['receive leads', 'preserve provenance']), connector('property-data', 'Property data provider', true, ['retrieve property facts', 'return source metadata']), connector('crm', 'Acquisition CRM', true, ['create or update leads', 'track next step']), connector('messaging', 'Seller messaging', true, ['send approved outreach']), connector('review-inbox', 'Acquisition Review Inbox', true, ['approve', 'deny', 'hold'])],
    artifacts: [artifact('Property lead packet', 'application/json', 'Separates source facts, enrichment, and operator notes.'), artifact('Seller contact receipt', 'application/json', 'Links approval, exact message, delivery, and pipeline state.')],
    metrics: [metric('Qualified property leads', 'leads', 'increase'), metric('Stale acquisition follow-ups', 'leads', 'decrease')],
    onboarding: [onboard('Register lead and property sources', 'Document provenance, license terms, and data fields.'), onboard('Configure acquisition pipeline', 'Map stages, owners, qualification, and next steps.'), onboard('Approve seller outreach', 'Set contact policy, templates, exclusions, and approval rules.')],
    foundationIdentifiers: ['BlackLabelPropertyHarvest', 'BlackLabelLeadsAPI', 'ProjectUtah.sales', 'BlackLabelPlatform.crm'],
    readiness: { status: 'foundation_ready', summary: 'Property, lead, and CRM patterns are reusable with source-specific connectors.', dependencies: ['licensed property source', 'acquisition CRM', 'seller contact policy'] },
  }),
  buildOffering({
    id: 'home-services-lead-scheduling-operator',
    name: 'Home-Services Lead and Scheduling Operator',
    summary: 'A pack for service lead intake, qualification, estimate or appointment scheduling, and follow-up.',
    outcomes: ['Service leads receive a fast qualified next step', 'Scheduling respects territory and capacity', 'Owners can measure booked and unresolved demand'],
    workflows: [
      workflow('service_lead', 'Service lead qualification', 'A service request becomes a qualified contact with territory and urgency.', 'inbound', 'home_services.lead.received', 'A call, form, or message requests service.', [action('Capture service need', 'capture_service_need', 'Collect property, service, timing, and contact details.', 'lead-source'), action('Check territory and policy', 'check_serviceability', 'Validate location, service type, and escalation rules.', 'service-catalog', false), action('Create customer and job lead', 'create_job_lead', 'Write the qualified request to the operating system.', 'field-service')], 'Hold hazardous, emergency, out-of-territory, or unsupported service requests.'),
      workflow('schedule_service', 'Schedule service', 'A qualified lead receives a valid appointment or estimate slot and confirmation.', 'event', 'home_services.lead.qualified', 'A service lead passes qualification.', [action('Read capacity', 'read_capacity', 'Load territory, technician, duration, and buffer rules.', 'field-service', false), action('Create appointment', 'create_service_appointment', 'Book an approved slot in the operating calendar.', 'calendar'), action('Send confirmation', 'send_service_confirmation', 'Deliver appointment details and preparation instructions.', 'messaging')], 'Require approval for overrides, after-hours commitments, or capacity exceptions.'),
    ],
    connectors: [connector('lead-source', 'Call, form, or message intake', true, ['receive requests', 'capture consent']), connector('service-catalog', 'Service and territory catalog', true, ['check service type', 'check territory']), connector('field-service', 'Field service system', true, ['create leads', 'read capacity']), connector('calendar', 'Service calendar', true, ['create appointments']), connector('messaging', 'Customer messaging', true, ['send confirmations'])],
    artifacts: [artifact('Service qualification receipt', 'application/json', 'Records request, serviceability checks, and next step.'), artifact('Booking receipt', 'application/json', 'Links slot selection, calendar readback, and confirmation delivery.')],
    metrics: [metric('Booked service leads', 'leads', 'increase'), metric('Unscheduled qualified leads', 'leads', 'decrease')],
    onboarding: [onboard('Load service catalog and territory', 'Register services, exclusions, coverage, and urgency.'), onboard('Connect field service and calendar', 'Authorize records and validate slot creation/readback.'), onboard('Approve scheduling rules', 'Set durations, buffers, capacity, after-hours, and override policy.')],
    foundationIdentifiers: ['BlackLabelFrontDesk', 'BlackLabelPlatform.scheduling', 'BlackLabelPlatform.customers', 'BlackLabelPlatform.industries'],
    readiness: { status: 'foundation_ready', summary: 'Front desk, scheduling, customer, and industry primitives support a reusable pack.', dependencies: ['field service adapter', 'service territory', 'capacity policy'] },
  }),
  buildOffering({
    id: 'law-firm-intake-document-routing',
    name: 'Law-Firm Intake and Document Routing',
    summary: 'A pack for prospective-client intake, conflict-screen preparation, document capture, routing, and attorney review.',
    outcomes: ['Prospective matters arrive complete and traceable', 'Sensitive submissions route by policy', 'No engagement or legal conclusion occurs without firm review'],
    workflows: [
      workflow('matter_intake', 'Prospective matter intake', 'An inquiry becomes a structured intake record and review packet.', 'inbound', 'law_firm.intake.received', 'A prospective client submits a call, form, or message.', [action('Capture intake facts', 'capture_matter_intake', 'Collect approved contact, party, issue, jurisdiction, and deadline fields.', 'intake-channel'), action('Prepare conflict data', 'prepare_conflict_check', 'Normalize names and entities for firm review.', 'case-management', false), action('Route attorney review', 'create_review', 'Send the packet to the configured attorney or intake team.', 'review-inbox')], 'Always require firm review before acceptance, rejection, substantive guidance, or conflict clearance.'),
      workflow('document_routing', 'Document routing', 'A submitted document is classified, preserved, and routed to the correct matter or review queue.', 'event', 'law_firm.document.received', 'A document arrives through an approved channel.', [action('Preserve source file', 'store_source_document', 'Store the original with source and integrity metadata.', 'document-management'), action('Classify routing metadata', 'classify_document', 'Extract only approved routing fields without legal conclusions.', 'document-management', false), action('Route or hold', 'route_document', 'Attach to a confirmed matter or hold for staff review.', 'case-management')], 'Hold when matter identity, confidentiality, privilege, or routing confidence is uncertain.'),
    ],
    connectors: [connector('intake-channel', 'Firm intake channels', true, ['receive inquiries', 'capture consent']), connector('case-management', 'Case management system', true, ['create intake records', 'attach reviewed documents']), connector('document-management', 'Document store', true, ['preserve originals', 'record integrity']), connector('review-inbox', 'Firm Review Inbox', true, ['approve', 'deny', 'hold'])],
    artifacts: [artifact('Matter intake packet', 'application/json', 'Separates submitted facts, routing metadata, and firm decisions.'), artifact('Document custody receipt', 'application/json', 'Records source, hash, classification, and destination.')],
    metrics: [metric('Complete intake packets', 'packets', 'increase'), metric('Unrouted documents', 'documents', 'decrease')],
    onboarding: [onboard('Approve intake boundaries', 'Define fields, non-engagement language, jurisdictions, and urgent routing.'), onboard('Map case and document systems', 'Authorize destinations and verify file integrity/readback.'), onboard('Configure attorney review', 'Set conflict, acceptance, sensitive-document, and deadline paths.')],
    foundationIdentifiers: ['BlackLabelSupport.ticket_workflow', 'BlackLabelPlatform.files', 'BlackLabelPlatform.reviews', 'BlackLabelPlatform.crm'],
    readiness: { status: 'integration_required', summary: 'Intake, files, review, and CRM foundations are reusable; firm systems and policies are specific.', dependencies: ['case management adapter', 'firm intake policy', 'attorney routing map'] },
  }),
  buildOffering({
    id: 'property-management-maintenance-desk',
    name: 'Property-Management Maintenance Desk',
    summary: 'A pack for maintenance intake, urgency triage, vendor dispatch preparation, resident updates, and completion evidence.',
    outcomes: ['Maintenance requests enter one prioritized queue', 'Dispatch decisions follow property policy', 'Residents and managers see verified progress'],
    workflows: [
      workflow('maintenance_intake', 'Maintenance intake', 'A resident request becomes a prioritized work order with property context.', 'inbound', 'property_management.request.received', 'A resident submits a maintenance request.', [action('Capture request and media', 'capture_maintenance_request', 'Store issue details, unit, access, contact, and attachments.', 'resident-channel'), action('Triage urgency', 'triage_maintenance', 'Apply the manager-approved emergency and severity policy.', 'property-management'), action('Create work order', 'create_work_order', 'Write the prioritized request to the property system.', 'property-management')], 'Require immediate manager review for emergency, safety, habitability, access, or uncertain severity.'),
      workflow('vendor_dispatch', 'Vendor dispatch', 'An approved vendor receives a scoped work order and completion is verified.', 'event', 'property_management.work_order.ready', 'A work order is ready for assignment.', [action('Select eligible vendor', 'select_vendor', 'Match trade, property, availability, and authorization.', 'vendor-network', false), action('Request dispatch approval', 'create_review', 'Present vendor, scope, access, and authorization context.', 'review-inbox'), action('Dispatch and notify', 'dispatch_vendor', 'Send after approval and update resident and manager.', 'messaging')], 'Require approval for vendor assignment, access instructions, or work outside standing authorization.'),
    ],
    connectors: [connector('resident-channel', 'Resident portal or messaging', true, ['receive requests', 'receive attachments', 'send updates']), connector('property-management', 'Property management system', true, ['read properties', 'create work orders']), connector('vendor-network', 'Vendor registry', true, ['read eligibility', 'record dispatch']), connector('messaging', 'Resident and vendor messaging', true, ['send approved updates']), connector('review-inbox', 'Manager Review Inbox', true, ['approve', 'deny', 'hold'])],
    artifacts: [artifact('Maintenance intake receipt', 'application/json', 'Records submitted issue, triage policy, and work order readback.'), artifact('Maintenance completion packet', 'application/json', 'Links dispatch, resident updates, vendor evidence, and closure.')],
    metrics: [metric('Closed maintenance requests', 'requests', 'increase'), metric('Unassigned urgent requests', 'requests', 'decrease')],
    onboarding: [onboard('Load properties and emergency policy', 'Map units, contacts, access, urgency, and after-hours paths.'), onboard('Register vendors and authorization', 'Capture trades, coverage, eligibility, and standing limits.'), onboard('Connect resident and property systems', 'Authorize intake, work-order, and notification operations.')],
    foundationIdentifiers: ['BlackLabelPlatform.files', 'BlackLabelPlatform.vendors', 'BlackLabelPlatform.workflows', 'BlackLabelPlatform.messaging'],
    readiness: { status: 'integration_required', summary: 'File, vendor, workflow, and messaging primitives are reusable with property-system adapters.', dependencies: ['property system adapter', 'vendor registry', 'emergency and access policy'] },
  }),
  buildOffering({
    id: 'ecommerce-support-marketing-operator',
    name: 'E-Commerce Support and Marketing Operator',
    summary: 'A pack for order-aware support, approved resolutions, campaign production, publishing, and outcome reporting.',
    outcomes: ['Support answers use current order facts', 'Sensitive resolutions stay under approval', 'Marketing assets publish from versioned approved packages'],
    workflows: [
      workflow('order_support', 'Order-aware support', 'A customer receives a grounded answer or reviewed resolution tied to the order.', 'inbound', 'ecommerce.support.received', 'A customer asks about an order or product.', [action('Load customer and order facts', 'load_order_context', 'Retrieve current order, fulfillment, and policy facts.', 'commerce-platform', false), action('Prepare grounded resolution', 'prepare_resolution', 'Draft the allowed answer or proposed action.', 'helpdesk', false), action('Approve consequential resolution', 'create_review', 'Review refunds, replacements, credits, or exceptions.', 'review-inbox'), action('Reply and record', 'reply_and_record', 'Send and attach the result to the support case.', 'helpdesk')], 'Require approval for refunds, replacements, credits, account changes, and policy exceptions.'),
      workflow('commerce_campaign', 'Commerce campaign', 'Approved product content publishes and produces a performance receipt.', 'schedule', 'ecommerce.campaign.due', 'An approved commerce campaign reaches its schedule.', [action('Validate catalog and assets', 'validate_catalog_assets', 'Confirm products, claims, inventory context, and artifact versions.', 'commerce-platform', false), action('Publish approved campaign', 'publish_campaign', 'Publish exact approved content to configured channels.', 'media-publisher'), action('Collect commerce outcomes', 'collect_commerce_outcomes', 'Record delivery and available attributed outcomes.', 'analytics', false)], 'Hold when product, inventory, approval, claim, or account state cannot be verified.'),
    ],
    connectors: [connector('commerce-platform', 'Commerce platform', true, ['read customers', 'read orders', 'read catalog']), connector('helpdesk', 'Support helpdesk', true, ['receive tickets', 'send replies']), connector('review-inbox', 'Operations Review Inbox', true, ['approve', 'deny', 'hold']), connector('media-publisher', 'Marketing publishers', true, ['publish approved content']), connector('analytics', 'Commerce analytics', false, ['read campaign outcomes'])],
    artifacts: [artifact('Order support receipt', 'application/json', 'Links order facts, policy, approval, action, and reply.'), artifact('Commerce campaign receipt', 'application/json', 'Links approved artifacts, publication proof, and outcomes.')],
    metrics: [metric('Resolved order inquiries', 'tickets', 'increase'), metric('Failed campaign publications', 'items', 'decrease')],
    onboarding: [onboard('Connect commerce and support systems', 'Authorize order reads and support case writes.'), onboard('Approve resolution policy', 'Set allowed responses, refund and replacement review, and escalation.'), onboard('Configure campaign channels', 'Load brand rules, accounts, approvers, and measurement access.')],
    foundationIdentifiers: ['BlackLabelPlatform.orders', 'BlackLabelSupport', 'BlackLabelMarketing', 'BlackLabelPlatform.reviews'],
    readiness: { status: 'foundation_ready', summary: 'Order, support, marketing, and review patterns are reusable with commerce adapters.', dependencies: ['commerce platform adapter', 'resolution policy', 'publisher connections'] },
  }),
  buildOffering({
    id: 'local-business-review-reactivation-system',
    name: 'Local-Business Review and Reactivation System',
    summary: 'A pack for feedback requests, review routing, dormant-customer reactivation, approval, and result tracking.',
    outcomes: ['Eligible customers receive timely feedback requests', 'Negative feedback reaches the owner before public escalation', 'Reactivation messages are approved and attributable'],
    workflows: [
      workflow('review_request', 'Review request and routing', 'An eligible completed service receives a feedback request and routed response.', 'event', 'local_business.service.completed', 'A configured customer service is completed.', [action('Check request eligibility', 'check_review_eligibility', 'Apply consent, timing, frequency, and exclusion rules.', 'customer-system', false), action('Send feedback request', 'send_feedback_request', 'Send the approved request through the configured channel.', 'messaging'), action('Route response', 'route_feedback', 'Send low ratings to owner review and eligible positive feedback to the approved next step.', 'review-platform')], 'Require owner review for negative feedback, disputes, or any public response.'),
      workflow('customer_reactivation', 'Customer reactivation', 'An eligible dormant customer receives an approved offer or reminder and the outcome is tracked.', 'schedule', 'local_business.reactivation.due', 'A customer cohort reaches the configured inactivity window.', [action('Build eligible cohort', 'build_reactivation_cohort', 'Apply consent, history, exclusion, and frequency rules.', 'customer-system', false), action('Prepare exact campaign', 'prepare_reactivation', 'Render the approved offer or reminder with customer facts.', 'messaging', false), action('Request campaign approval', 'create_review', 'Present audience, exact content, timing, and exclusions.', 'review-inbox'), action('Send and record outcomes', 'send_reactivation', 'Deliver after approval and write results.', 'messaging')], 'Require explicit approval for each new audience, offer, or message version.'),
    ],
    connectors: [connector('customer-system', 'Customer system', true, ['read service history', 'read consent', 'write campaign outcomes']), connector('messaging', 'Customer messaging', true, ['send approved requests', 'send approved reactivation']), connector('review-platform', 'Review platform', true, ['send review links', 'read submitted feedback']), connector('review-inbox', 'Owner Review Inbox', true, ['approve', 'deny', 'hold'])],
    artifacts: [artifact('Feedback request receipt', 'application/json', 'Records eligibility, message, delivery, response, and routing.'), artifact('Reactivation campaign receipt', 'application/json', 'Records cohort rules, approval, sends, exclusions, and outcomes.')],
    metrics: [metric('Eligible feedback responses', 'responses', 'increase'), metric('Unresolved negative feedback', 'items', 'decrease')],
    onboarding: [onboard('Connect customer and review systems', 'Authorize service history, consent, messaging, and feedback reads.'), onboard('Approve feedback policy', 'Set timing, frequency, rating routes, response rules, and owner review.'), onboard('Approve reactivation policy', 'Set inactivity windows, exclusions, content, offers, and measurement.')],
    foundationIdentifiers: ['BlackLabelPlatform.reviews', 'BlackLabelPlatform.customers', 'BlackLabelMarketing.outreach', 'BlackLabelPlatform.loyalty'],
    readiness: { status: 'foundation_ready', summary: 'Customer, review, outreach, and loyalty primitives support a reusable local-business pack.', dependencies: ['customer system adapter', 'review platform connection', 'consent and campaign policy'] },
  }),
];

const engagementModels: EngagementModel[] = [
  {
    id: 'workflow-automation-sprint',
    name: 'Workflow Automation Sprint',
    description: 'A bounded implementation that maps company processes and installs a verified initial workflow system.',
    scope: ['Map company processes', 'Connect required systems', 'Install 3-10 configured workflows', 'Configure approvals', 'Create the management dashboard', 'Train the client'],
    deliverables: ['Process and connector map', 'Installed workflow package', 'Approval policy', 'Management dashboard configuration', 'Training handoff', 'Verification receipts'],
    operatingCadence: ['Bounded discovery', 'Configuration and connection', 'Acceptance verification', 'Client handoff'],
    idealFor: ['A company starting its first workflow package', 'A defined process with measurable acceptance checks'],
  },
  {
    id: 'managed-ai-operations',
    name: 'Managed AI Operations',
    description: 'An ongoing operating service that monitors, repairs, improves, and reports on installed client workflows.',
    scope: ['Monitor workflow health', 'Repair connector failures', 'Add workflow improvements', 'Review usage, costs, and outcomes', 'Maintain integrations', 'Provide operational reporting'],
    deliverables: ['Health and failure review', 'Connector maintenance record', 'Versioned workflow improvements', 'Usage and cost summary', 'Outcome report', 'Updated verification receipts'],
    operatingCadence: ['Continuous health monitoring', 'Exception response', 'Planned workflow improvement', 'Monthly operational review'],
    idealFor: ['A company with live installed workflows', 'An owner who wants an accountable managed operating layer'],
  },
];

function assertNonEmpty(value: string, path: string): void {
  if (value.trim() === '') throw new Error(`client-ops catalog: ${path} must not be empty`);
}

function assertUniqueIds(items: Array<{ id: string }>, path: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    assertNonEmpty(item.id, `${path}.id`);
    if (seen.has(item.id)) throw new Error(`client-ops catalog: duplicate ${path} id ${item.id}`);
    seen.add(item.id);
  }
}

/** Validates completeness and all internal template references. Throws on failure. */
export function validateClientOpsCatalog(catalog: ClientOpsCatalog): void {
  if (catalog.services.length !== 8) throw new Error('client-ops catalog: exactly 8 services required');
  if (catalog.verticalPacks.length !== 7) throw new Error('client-ops catalog: exactly 7 vertical packs required');
  if (catalog.engagementModels.length !== 2) throw new Error('client-ops catalog: exactly 2 engagement models required');
  assertUniqueIds(catalog.services, 'service');
  assertUniqueIds(catalog.verticalPacks, 'verticalPack');
  assertUniqueIds(catalog.engagementModels, 'engagementModel');

  for (const [groupName, offerings] of [
    ['services', catalog.services],
    ['verticalPacks', catalog.verticalPacks],
  ] as const) {
    for (const offering of offerings) {
      assertNonEmpty(offering.name, `${groupName}.${offering.id}.name`);
      assertNonEmpty(offering.summary, `${groupName}.${offering.id}.summary`);
      const requiredArrays: Array<[string, unknown[]]> = [
        ['outcomes', offering.outcomes], ['workflows', offering.workflows], ['triggers', offering.triggers],
        ['actions', offering.actions], ['connectors', offering.connectors], ['approvals', offering.approvals],
        ['artifacts', offering.artifacts], ['metrics', offering.metrics], ['onboarding', offering.onboarding],
        ['foundationIdentifiers', offering.foundationIdentifiers], ['readiness.dependencies', offering.readiness.dependencies],
      ];
      for (const [key, values] of requiredArrays) {
        if (values.length === 0) throw new Error(`client-ops catalog: ${groupName}.${offering.id}.${key} must not be empty`);
      }
      assertUniqueIds(offering.workflows, `${offering.id}.workflow`);
      assertUniqueIds(offering.triggers, `${offering.id}.trigger`);
      assertUniqueIds(offering.actions, `${offering.id}.action`);
      assertUniqueIds(offering.connectors, `${offering.id}.connector`);
      assertUniqueIds(offering.approvals, `${offering.id}.approval`);
      assertUniqueIds(offering.artifacts, `${offering.id}.artifact`);
      assertUniqueIds(offering.metrics, `${offering.id}.metric`);
      assertUniqueIds(offering.onboarding, `${offering.id}.onboarding`);
      const triggerIds = new Set(offering.triggers.map((item) => item.id));
      const actionIds = new Set(offering.actions.map((item) => item.id));
      const approvalIds = new Set(offering.approvals.map((item) => item.id));
      const artifactIds = new Set(offering.artifacts.map((item) => item.id));
      const metricIds = new Set(offering.metrics.map((item) => item.id));
      const connectorIds = new Set(offering.connectors.map((item) => item.id));
      for (const trigger of offering.triggers) {
        if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(trigger.eventType)) {
          throw new Error(`client-ops catalog: invalid event type ${trigger.eventType}`);
        }
      }
      for (const item of offering.actions) {
        if (item.connectorId !== null && !connectorIds.has(item.connectorId)) {
          throw new Error(`client-ops catalog: unknown connector ${item.connectorId}`);
        }
      }
      for (const item of offering.workflows) {
        if (!triggerIds.has(item.triggerId)) throw new Error(`client-ops catalog: unknown trigger ${item.triggerId}`);
        if (!approvalIds.has(item.approvalId)) throw new Error(`client-ops catalog: unknown approval ${item.approvalId}`);
        if (item.actionIds.some((id) => !actionIds.has(id))) throw new Error(`client-ops catalog: unknown action in ${item.id}`);
        if (item.artifactIds.some((id) => !artifactIds.has(id))) throw new Error(`client-ops catalog: unknown artifact in ${item.id}`);
        if (item.metricIds.some((id) => !metricIds.has(id))) throw new Error(`client-ops catalog: unknown metric in ${item.id}`);
      }
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const catalog: ClientOpsCatalog = {
  schemaVersion: '1.0.0',
  catalogVersion: '2026-07-15',
  services,
  verticalPacks,
  engagementModels,
};

validateClientOpsCatalog(catalog);

/** Exact sellable catalog: 8 services, 7 vertical packs, 2 engagement models. */
export const CLIENT_OPS_CATALOG: ClientOpsCatalog = deepFreeze(catalog);

export function getCatalogOffering(kind: 'service' | 'vertical_pack', offeringId: string): CatalogOffering | undefined {
  const collection = kind === 'service' ? CLIENT_OPS_CATALOG.services : CLIENT_OPS_CATALOG.verticalPacks;
  return collection.find((item) => item.id === offeringId);
}

export function getEngagementModel(modelId: string): EngagementModel | undefined {
  return CLIENT_OPS_CATALOG.engagementModels.find((item) => item.id === modelId);
}
