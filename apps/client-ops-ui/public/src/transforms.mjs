const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function first(source, keys, fallback = null) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return fallback;
}

function string(source, keys, fallback = '') {
  const value = first(source, keys, fallback);
  return value === null || value === undefined ? fallback : String(value);
}

function number(source, keys, fallback = null) {
  const value = Number(first(source, keys));
  return Number.isFinite(value) ? value : fallback;
}

function bool(source, keys, fallback = false) {
  const value = first(source, keys, fallback);
  if (typeof value === 'string') return ['1', 'true', 'yes', 'required', 'enabled'].includes(value.toLowerCase());
  return Boolean(value);
}

export function unwrap(payload) {
  return object(payload).data ?? payload ?? null;
}

export function listFrom(payload, keys = []) {
  const value = unwrap(payload);
  if (Array.isArray(value)) return value;
  const root = object(value);
  for (const key of keys) {
    if (Array.isArray(root[key])) return root[key];
  }
  return [];
}

export function normalizeStatus(value = 'unknown') {
  return String(value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

export function statusTone(value) {
  const status = normalizeStatus(value);
  if (/(failed|error|blocked|unhealthy|denied|disconnected|canceled)/.test(status)) return 'danger';
  if (/(risk|warning|degraded|setup|required|pending)/.test(status)) return 'warning';
  if (/(waiting|paused|held|not started|disabled|archived)/.test(status)) return 'neutral';
  if (/(running|progress|requested)/.test(status)) return 'info';
  if (/(success|succeeded|healthy|connected|ready|verified|installed|complete|completed|active|approved)/.test(status)) return 'gold';
  return 'neutral';
}

export function titleCase(value) {
  const text = normalizeStatus(value);
  return text === 'unknown' ? 'Not reported' : text.replace(/(^|\s)\S/g, (match) => match.toUpperCase());
}

export function formatDateTime(value, locale = 'en-US') {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

export function formatRelativeTime(value, now = Date.now()) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 60) return formatter.format(seconds, 'second');
  if (abs < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
  return formatter.format(Math.round(seconds / 86400), 'day');
}

export function formatMoney(cents, currency = 'USD') {
  if (cents === null || cents === undefined || cents === '' || !Number.isFinite(Number(cents))) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(cents) / 100);
}

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

export function clampProgress(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = parsed <= 1 && parsed >= 0 ? parsed * 100 : parsed;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

export function transformService(value) {
  const source = object(value);
  const readiness = object(first(source, ['readiness'], {}));
  return {
    id: string(source, ['id', 'catalogId', 'catalog_id', 'serviceId', 'service_id']),
    catalogId: string(source, ['catalogId', 'catalog_id', 'serviceId', 'service_id']),
    name: string(source, ['name', 'label', 'title'], 'Unnamed service'),
    summary: string(source, ['summary', 'description', 'outcome']),
    status: string(source, ['status', 'installationStatus', 'installation_status'], 'not installed'),
    readiness: string(source, ['readinessStatus', 'readiness_status'], string(readiness, ['status'], 'not reported')),
    readinessSummary: string(readiness, ['summary']),
    workflowCount: number(source, ['workflowCount', 'workflow_count'], Array.isArray(source.workflows) ? source.workflows.length : null),
    connectorCount: number(source, ['connectorCount', 'connector_count'], Array.isArray(source.connectors) ? source.connectors.length : null),
    workflows: Array.isArray(source.workflows) ? source.workflows : [],
    connectors: Array.isArray(source.connectors) ? source.connectors : [],
    artifacts: Array.isArray(source.artifacts) ? source.artifacts : [],
    metrics: Array.isArray(source.metrics) ? source.metrics : [],
    onboarding: Array.isArray(source.onboarding) ? source.onboarding : [],
    outcomes: Array.isArray(source.outcomes) ? source.outcomes : [],
    installed: bool(source, ['installed'], /^(active|onboarding|paused)$/i.test(string(source, ['status']))),
  };
}

export function transformWorkflow(value) {
  const source = object(value);
  const latestRun = object(first(source, ['latestRun', 'latest_run', 'run'], {}));
  const progress = clampProgress(first(source, ['progress', 'progressPercent', 'progress_percent'], first(latestRun, ['progress'])));
  return {
    id: string(source, ['id', 'workflowId', 'workflow_id']),
    installationId: string(source, ['installationId', 'installation_id']),
    installationStatus: string(source, ['installationStatus', 'installation_status'], 'not reported'),
    name: string(source, ['name', 'title'], 'Unnamed workflow'),
    service: string(source, ['service', 'serviceName', 'service_name', 'installationName', 'installation_name'], '—'),
    status: string(source, ['status', 'state'], string(latestRun, ['status'], 'not reported')),
    lastRun: first(source, ['lastRunAt', 'last_run_at', 'lastRun', 'last_run'], first(latestRun, ['finishedAt', 'finished_at', 'startedAt', 'started_at', 'requestedAt', 'requested_at'])),
    runId: string(source, ['runId', 'run_id'], string(latestRun, ['id'])),
    outcome: string(source, ['outcome', 'summary'], string(latestRun, ['summary', 'outcome'], '—')),
    nextAction: string(source, ['nextAction', 'next_action'], '—'),
    progress,
    enabled: bool(source, ['enabled'], true),
    approvalPolicy: object(first(source, ['approvalPolicy', 'approval_policy', 'approval'], {})),
    requiredConnectors: Array.isArray(source.requiredConnectors) ? source.requiredConnectors : Array.isArray(source.required_connectors) ? source.required_connectors : [],
    error: string(latestRun, ['error']),
  };
}

export function transformReview(value) {
  const source = object(value);
  const context = object(first(source, ['context'], {}));
  return {
    id: string(source, ['id', 'reviewId', 'review_id']),
    title: string(source, ['title', 'item', 'name'], 'Untitled review'),
    workflow: string(source, ['workflow', 'workflowName', 'workflow_name'], string(context, ['workflowName', 'workflow_name'], '—')),
    status: string(source, ['status'], 'pending'),
    priority: string(source, ['priority'], string(context, ['priority'], 'normal')),
    requestedAt: first(source, ['requestedAt', 'requested_at', 'createdAt', 'created_at']),
    decisionNote: string(source, ['decisionNote', 'decision_note']),
    context,
  };
}

export function transformConnector(value) {
  const source = object(value);
  const health = object(first(source, ['health'], {}));
  return {
    id: string(source, ['id', 'connectorId', 'connector_id']),
    installationId: string(source, ['installationId', 'installation_id']),
    name: string(source, ['name', 'label', 'connectorLabel', 'connector_label'], 'Unnamed connector'),
    category: string(source, ['category', 'provider', 'type'], 'Other'),
    status: string(source, ['status'], string(health, ['status'], 'not reported')),
    required: bool(source, ['required']),
    lastChecked: first(source, ['lastChecked', 'last_checked', 'updatedAt', 'updated_at'], first(health, ['checkedAt', 'checked_at'])),
    externalRef: string(source, ['credentialRef', 'credential_ref', 'externalRef', 'external_ref', 'account']),
    message: string(source, ['message'], string(health, ['message', 'detail'])),
    capabilities: Array.isArray(source.capabilities) ? source.capabilities : [],
  };
}

export function transformArtifact(value) {
  const source = object(value);
  const metadata = object(first(source, ['metadata'], {}));
  return {
    id: string(source, ['id', 'artifactId', 'artifact_id', 'receiptId', 'receipt_id']),
    installationId: string(source, ['installationId', 'installation_id']),
    runId: string(source, ['runId', 'run_id']),
    name: string(source, ['name', 'title', 'summary'], 'Unnamed artifact'),
    kind: string(source, ['kind', 'type'], 'artifact'),
    workflow: string(source, ['workflow', 'workflowName', 'workflow_name'], string(metadata, ['workflowName'], '—')),
    status: string(source, ['status', 'verificationStatus', 'verification_status'], first(source, ['verification']) ? 'verified' : 'not reported'),
    createdAt: first(source, ['createdAt', 'created_at', 'generatedAt', 'generated_at']),
    sizeBytes: number(source, ['sizeBytes', 'size_bytes'], number(metadata, ['sizeBytes'])),
    mediaType: string(source, ['mediaType', 'media_type', 'format']),
    uri: string(source, ['uri', 'url', 'downloadUrl', 'download_url']),
    sha256: string(source, ['sha256']),
    summary: string(source, ['summary']),
    verification: first(source, ['verification'], {}),
    artifactIds: Array.isArray(source.artifactIds) ? source.artifactIds : Array.isArray(source.artifact_ids) ? source.artifact_ids : [],
  };
}

export function transformReport(value) {
  const source = object(value);
  return {
    id: string(source, ['id', 'reportId', 'report_id', 'artifactId', 'artifact_id']),
    title: string(source, ['title', 'name'], 'Untitled report'),
    period: string(source, ['period', 'reportingPeriod', 'reporting_period'], '—'),
    status: string(source, ['status'], 'not reported'),
    generatedAt: first(source, ['generatedAt', 'generated_at', 'createdAt', 'created_at']),
    owner: string(source, ['owner', 'requestedBy', 'requested_by'], '—'),
    uri: string(source, ['uri', 'url', 'downloadUrl', 'download_url']),
    summary: string(source, ['summary', 'description']),
    metrics: Array.isArray(source.metrics) ? source.metrics : [],
  };
}

export function transformSetupStep(value, index = 0) {
  const source = object(value);
  const rawPosition = number(source, ['position', 'order'], index);
  return {
    id: string(source, ['id', 'stepId', 'step_id', 'templateId', 'template_id']),
    position: rawPosition + 1,
    title: string(source, ['title', 'name'], `Setup step ${index + 1}`),
    description: string(source, ['description', 'summary']),
    status: string(source, ['status'], 'pending'),
    required: bool(source, ['required'], true),
    completedAt: first(source, ['completedAt', 'completed_at']),
    evidence: first(source, ['evidence'], null),
  };
}

export function transformOverview(payload) {
  const root = object(unwrap(payload));
  const summary = object(first(root, ['summary', 'metrics'], {}));
  const client = object(first(root, ['client', 'tenant'], {}));
  const services = listFrom(root.services ?? root.serviceHealth, ['services', 'serviceHealth']).map(transformService);
  const workflows = listFrom(root.workflows, ['workflows']).map(transformWorkflow);
  const reviews = listFrom(root.reviews ?? root.reviewItems, ['reviews', 'reviewItems']).map(transformReview);
  const connectors = listFrom(root.connectors ?? root.integrations, ['connectors', 'integrations']).map(transformConnector);
  const artifacts = listFrom(root.artifacts ?? root.receipts, ['artifacts', 'receipts']).map(transformArtifact);
  return {
    client: {
      id: string(client, ['id', 'clientId', 'client_id']),
      name: string(client, ['name', 'clientName', 'client_name']),
    },
    executionCostCents: number(root, ['executionCostCents', 'execution_cost_cents'], number(summary, ['executionCostCents', 'execution_cost_cents'])),
    updatedAt: first(root, ['updatedAt', 'updated_at', 'asOf', 'as_of']),
    services,
    workflows,
    reviews,
    connectors,
    artifacts,
    counts: {
      services: number(summary, ['serviceCount', 'service_count'], services.length),
      workflows: number(summary, ['workflowCount', 'workflow_count'], workflows.length),
      reviews: number(summary, ['pendingReviewCount', 'pending_review_count'], reviews.filter((item) => normalizeStatus(item.status) === 'pending').length),
      connectors: number(summary, ['connectorCount', 'connector_count'], connectors.length),
    },
  };
}

function outputSummary(output) {
  if (!output) return '';
  if (typeof output === 'string') return output;
  const value = object(output);
  return string(value, ['summary', 'outcome', 'message']);
}

export function transformCatalogPayload(payload) {
  const root = object(unwrap(payload));
  const catalog = object(root.catalog ?? root);
  const installations = Array.isArray(root.installations) ? root.installations : [];
  const mergeOffering = (offering, kind) => {
    const installation = installations.find((item) => item.catalogKind === kind && item.catalogId === offering.id);
    return {
      ...transformService({ ...offering, ...(installation || {}) }),
      id: offering.id,
      name: offering.name || installation?.name || 'Unnamed service',
      summary: offering.summary || '',
      status: installation?.status || 'not installed',
      readiness: offering.readiness?.status || 'not reported',
      readinessSummary: offering.readiness?.summary || '',
      workflowCount: Array.isArray(offering.workflows) ? offering.workflows.length : 0,
      connectorCount: Array.isArray(offering.connectors) ? offering.connectors.length : 0,
      workflows: Array.isArray(offering.workflows) ? offering.workflows : [],
      connectors: Array.isArray(offering.connectors) ? offering.connectors : [],
      artifacts: Array.isArray(offering.artifacts) ? offering.artifacts : [],
      metrics: Array.isArray(offering.metrics) ? offering.metrics : [],
      onboarding: Array.isArray(offering.onboarding) ? offering.onboarding : [],
      outcomes: Array.isArray(offering.outcomes) ? offering.outcomes : [],
      installationId: installation?.id || '',
      installed: Boolean(installation && installation.status !== 'archived'),
      catalogKind: kind,
    };
  };
  return {
    services: (Array.isArray(catalog.services) ? catalog.services : []).map((item) => mergeOffering(item, 'service')),
    verticalPacks: (Array.isArray(catalog.verticalPacks) ? catalog.verticalPacks : []).map((item) => mergeOffering(item, 'vertical_pack')),
    engagementModels: Array.isArray(catalog.engagementModels) ? catalog.engagementModels : [],
    catalogVersion: string(catalog, ['catalogVersion', 'catalog_version']),
  };
}

export function transformInstalledWorkflows(payload) {
  const root = object(unwrap(payload));
  const installations = Array.isArray(root.installations) ? root.installations : [];
  const runs = Array.isArray(root.runs) ? root.runs : [];
  const canonicalOrder = new Map([
    ['workflow-operating-system', 0],
    ['ai-front-desk', 1],
    ['sales-operator', 2],
    ['marketing-operator', 3],
    ['support-operator', 4],
    ['executive-operations-hq', 5],
    ['private-company-agent', 6],
    ['data-operations-service', 7],
  ]);
  const installationOrder = new Map(installations.map((installation) => [installation.id, canonicalOrder.get(installation.catalogId) ?? 99]));
  return installations.flatMap((installation) => {
    const workflows = Array.isArray(installation.workflows) ? installation.workflows : [];
    return workflows.map((workflow) => {
      const latestRun = runs.find((run) => run.workflowId === workflow.id && run.installationId === installation.id);
      return transformWorkflow({
        ...workflow,
        installationId: installation.id,
        installationStatus: installation.status,
        serviceName: installation.name,
        latestRun,
        status: latestRun?.status || workflow.status,
        lastRunAt: latestRun?.finishedAt || latestRun?.startedAt || latestRun?.requestedAt || null,
        runId: latestRun?.id || '',
        outcome: outputSummary(latestRun?.output) || workflow.outcome || '—',
        nextAction: workflow.enabled === false ? 'Disabled' : workflow.status === 'paused' ? 'Paused' : workflow.status === 'blocked' ? 'Resolve blocker' : 'Ready',
      });
    });
  }).sort((a, b) => {
    const runDelta = Number(Boolean(b.runId)) - Number(Boolean(a.runId));
    if (runDelta) return runDelta;
    const serviceDelta = (installationOrder.get(a.installationId) ?? 99) - (installationOrder.get(b.installationId) ?? 99);
    if (serviceDelta) return serviceDelta;
    return a.name.localeCompare(b.name);
  });
}

export function transformInstalledConnectors(payload) {
  const root = object(unwrap(payload));
  const installations = Array.isArray(root.installations) ? root.installations : [];
  return installations.flatMap((installation) => {
    const connectors = Array.isArray(installation.connectors) ? installation.connectors : [];
    return connectors.map((connector) => transformConnector({
      ...connector,
      installationId: installation.id,
      category: installation.name,
      message: connector.health?.message || connector.health?.detail || '',
      lastChecked: connector.health?.checkedAt || connector.updatedAt,
    }));
  });
}

export function transformSetupPayload(payload) {
  const root = object(unwrap(payload));
  const installations = Array.isArray(root.installations) ? root.installations : [];
  const canonicalOrder = new Map([
    ['workflow-operating-system', 0], ['ai-front-desk', 1], ['sales-operator', 2], ['marketing-operator', 3],
    ['support-operator', 4], ['executive-operations-hq', 5], ['private-company-agent', 6], ['data-operations-service', 7],
  ]);
  return installations.map((installation) => ({
    id: installation.id,
    name: installation.name || 'Unnamed installation',
    catalogId: installation.catalogId || '',
    status: installation.status || 'not reported',
    readiness: object(installation.readiness),
    steps: (Array.isArray(installation.onboarding) ? installation.onboarding : []).map(transformSetupStep),
  })).sort((a, b) => (canonicalOrder.get(a.catalogId) ?? 99) - (canonicalOrder.get(b.catalogId) ?? 99) || a.name.localeCompare(b.name));
}

export function transformArtifactsPayload(payload) {
  const unwrapped = unwrap(payload);
  const root = object(unwrapped);
  const artifacts = (Array.isArray(root.artifacts) ? root.artifacts : Array.isArray(unwrapped) ? unwrapped : []).map(transformArtifact);
  const receipts = (Array.isArray(root.receipts) ? root.receipts : []).map((receipt) => transformArtifact({
    ...receipt,
    name: receipt.summary,
    kind: 'completion receipt',
    status: receipt.verification ? 'verified' : 'not reported',
  }));
  return { artifacts, receipts, all: [...receipts, ...artifacts] };
}

export function transformOverviewPayload(payload) {
  const root = object(unwrap(payload));
  const summary = object(root.summary);
  const installationPayload = { data: { installations: root.installations, runs: root.runs } };
  const canonicalOrder = new Map([
    ['workflow-operating-system', 0],
    ['ai-front-desk', 1],
    ['sales-operator', 2],
    ['marketing-operator', 3],
    ['support-operator', 4],
    ['executive-operations-hq', 5],
    ['private-company-agent', 6],
    ['data-operations-service', 7],
  ]);
  const installationOrder = new Map((Array.isArray(root.installations) ? root.installations : []).map((installation) => [
    installation.id,
    canonicalOrder.get(installation.catalogId) ?? 99,
  ]));
  const workflows = transformInstalledWorkflows(installationPayload).sort((a, b) => {
    const runDelta = Number(Boolean(b.runId)) - Number(Boolean(a.runId));
    if (runDelta) return runDelta;
    const orderDelta = (installationOrder.get(a.installationId) ?? 99) - (installationOrder.get(b.installationId) ?? 99);
    if (orderDelta) return orderDelta;
    return a.name.localeCompare(b.name);
  });
  const connectors = transformInstalledConnectors({ data: { installations: root.installations } });
  const services = (Array.isArray(root.installations) ? root.installations : []).map((installation) => transformService({
    ...installation,
    workflowCount: installation.workflows?.length,
    connectorCount: installation.connectors?.length,
    readinessStatus: installation.readiness?.ready ? 'ready' : 'setup required',
  })).sort((a, b) => (canonicalOrder.get(a.catalogId) ?? 99) - (canonicalOrder.get(b.catalogId) ?? 99) || a.name.localeCompare(b.name));
  const reviews = (Array.isArray(root.reviews) ? root.reviews : []).map(transformReview);
  const artifactData = transformArtifactsPayload({ data: { artifacts: root.artifacts, receipts: root.receipts } });
  return {
    summary,
    services,
    workflows,
    connectors,
    reviews,
    artifacts: artifactData.all,
    updatedAt: null,
    executionCostCents: number(object(summary.usage), ['totalCostCents', 'total_cost_cents']),
    counts: {
      services: number(object(summary.installations), ['total'], services.length),
      workflows: workflows.length,
      reviews: number(object(summary.reviews), ['total'], reviews.length),
      connectors: connectors.length,
    },
  };
}

export function transformReportingPayload(payload) {
  const root = object(unwrap(payload));
  const summary = object(root.summary);
  const events = Array.isArray(root.events) ? root.events.map((event) => {
    const source = object(event);
    return {
      id: string(source, ['id']),
      provider: string(source, ['provider'], 'Unknown provider'),
      model: string(source, ['model']),
      metric: string(source, ['metric'], 'usage'),
      quantity: number(source, ['quantity'], 0),
      unit: string(source, ['unit']),
      costCents: number(source, ['costCents', 'cost_cents'], 0),
      occurredAt: first(source, ['occurredAt', 'occurred_at', 'createdAt', 'created_at']),
      installationId: string(source, ['installationId', 'installation_id']),
      runId: string(source, ['runId', 'run_id']),
    };
  }) : [];
  const runs = Array.isArray(root.runs) ? root.runs.map((run) => {
    const source = object(run);
    return {
      id: string(source, ['id']),
      installationId: string(source, ['installationId', 'installation_id']),
      workflowId: string(source, ['workflowId', 'workflow_id']),
      status: string(source, ['status'], 'not reported'),
      attempt: number(source, ['attempt'], 1),
      requestedAt: first(source, ['requestedAt', 'requested_at']),
      finishedAt: first(source, ['finishedAt', 'finished_at']),
      error: string(source, ['error']),
    };
  }) : [];
  const receipts = Array.isArray(root.receipts) ? root.receipts.map(transformArtifact) : [];
  return {
    summary: {
      eventCount: number(summary, ['eventCount', 'event_count'], events.length),
      totalCostCents: number(summary, ['totalCostCents', 'total_cost_cents'], events.reduce((total, event) => total + event.costCents, 0)),
      byProvider: Array.isArray(summary.byProvider) ? summary.byProvider : [],
      byMetric: Array.isArray(summary.byMetric) ? summary.byMetric : [],
    },
    events,
    runs,
    receipts,
  };
}

function portfolioNumber(source, keys, fallback = 0) {
  const value = first(source, keys);
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringList(value) {
  return Array.isArray(value)
    ? value.filter((item) => item !== null && item !== undefined && item !== '').map(String)
    : [];
}

function populatedObject(value) {
  const result = object(value);
  return Object.keys(result).length ? result : null;
}

export function portfolioOriginGroup(value) {
  const origin = normalizeStatus(value);
  if (origin === 'assistance' || origin === 'black label assistance') return 'assistance';
  if (origin === 'client ops' || origin === 'new') return 'new';
  if (origin === 'legacy fleet' || origin === 'existing') return 'existing';
  return origin || 'other';
}

export function portfolioOriginLabel(value) {
  const group = portfolioOriginGroup(value);
  if (group === 'new') return 'New';
  if (group === 'existing') return 'Existing';
  if (group === 'assistance') return 'Assistance';
  return titleCase(group);
}

export function portfolioReadinessTone(value) {
  const readiness = normalizeStatus(value);
  if (readiness === 'verified working') return 'gold';
  if (readiness === 'failed') return 'danger';
  if (readiness === 'not verified' || readiness === 'integration required') return 'warning';
  if (readiness === 'design ready' || readiness === 'foundation ready') return 'info';
  return 'neutral';
}

export function transformPortfolioEvidence(value) {
  const source = object(value);
  return {
    latestTestStatus: string(source, ['latestTestStatus', 'latest_test_status'], 'not run'),
    latestPackageStatus: string(source, ['latestPackageStatus', 'latest_package_status'], 'not run'),
    passedSuiteKeys: stringList(first(source, ['passedSuiteKeys', 'passed_suite_keys'], [])),
    missingSuiteKeys: stringList(first(source, ['missingSuiteKeys', 'missing_suite_keys'], [])),
    latestTestAt: first(source, ['latestTestAt', 'latest_test_at']),
    latestPackageAt: first(source, ['latestPackageAt', 'latest_package_at']),
  };
}

export function transformPortfolioFeature(value) {
  const source = object(value);
  return {
    key: string(source, ['key', 'id']),
    name: string(source, ['name', 'label', 'title'], 'Unnamed feature'),
    summary: string(source, ['summary', 'description']),
    packageable: bool(source, ['packageable']),
    catalogReadiness: string(source, ['catalogReadiness', 'catalog_readiness'], 'not reported'),
    readiness: string(source, ['readiness'], string(source, ['catalogReadiness', 'catalog_readiness'], 'not reported')),
    evidence: transformPortfolioEvidence(first(source, ['evidence'], {})),
    archiveSlug: string(source, ['archiveSlug', 'archive_slug']),
    sourcePaths: stringList(first(source, ['sourcePaths', 'source_paths'], [])),
    requiredSuiteKeys: stringList(first(source, ['requiredSuiteKeys', 'required_suite_keys'], [])),
    allowedSuiteKeys: stringList(first(source, ['allowedSuiteKeys', 'allowed_suite_keys', 'suiteKeys', 'suite_keys'], [])),
  };
}

export function transformPortfolioTestRun(value) {
  const source = object(value);
  return {
    id: string(source, ['id']),
    productKey: string(source, ['productKey', 'product_key']),
    targetKind: string(source, ['targetKind', 'target_kind'], 'product'),
    targetKey: string(source, ['targetKey', 'target_key']),
    suiteKey: string(source, ['suiteKey', 'suite_key']),
    status: string(source, ['status'], 'not run'),
    requestedBy: string(source, ['requestedBy', 'requested_by']),
    sourceRevision: string(source, ['sourceRevision', 'source_revision']),
    startedAt: first(source, ['startedAt', 'started_at']),
    finishedAt: first(source, ['finishedAt', 'finished_at']),
    exitCode: portfolioNumber(source, ['exitCode', 'exit_code'], null),
    durationMs: portfolioNumber(source, ['durationMs', 'duration_ms'], null),
    summary: string(source, ['summary']),
    evidence: first(source, ['evidence', 'evidenceJson', 'evidence_json'], null),
    createdAt: first(source, ['createdAt', 'created_at']),
    updatedAt: first(source, ['updatedAt', 'updated_at']),
  };
}

export function transformPortfolioPackage(value) {
  const source = object(value);
  return {
    id: string(source, ['id']),
    productKey: string(source, ['productKey', 'product_key']),
    targetKind: string(source, ['targetKind', 'target_kind'], 'product'),
    targetKey: string(source, ['targetKey', 'target_key']),
    version: string(source, ['version']),
    status: string(source, ['status'], 'not packaged'),
    artifactUri: string(source, ['artifactUri', 'artifact_uri', 'uri']),
    sha256: string(source, ['sha256']),
    bytes: portfolioNumber(source, ['bytes'], null),
    manifest: first(source, ['manifest', 'manifestJson', 'manifest_json'], null),
    builtAt: first(source, ['builtAt', 'built_at']),
    verifiedAt: first(source, ['verifiedAt', 'verified_at']),
    createdAt: first(source, ['createdAt', 'created_at']),
    updatedAt: first(source, ['updatedAt', 'updated_at']),
  };
}

export function transformPortfolioProduct(value) {
  const source = object(value);
  const latestTestSource = populatedObject(first(source, ['latestTest', 'latest_test']));
  const latestPackageSource = populatedObject(first(source, ['latestPackage', 'latest_package']));
  const evidence = transformPortfolioEvidence(first(source, ['evidence'], {}));
  const blockers = stringList(first(source, ['blockers'], []));
  const testSuites = Array.isArray(source.testSuites)
    ? source.testSuites
    : Array.isArray(source.test_suites)
      ? source.test_suites
      : [];
  return {
    key: string(source, ['key', 'id']),
    sourceId: string(source, ['sourceId', 'source_id']),
    name: string(source, ['name', 'label', 'title'], 'Unnamed product'),
    aliases: stringList(first(source, ['aliases'], [])),
    origin: string(source, ['origin'], 'not reported'),
    kind: string(source, ['kind', 'type'], 'not reported'),
    familyKey: string(source, ['familyKey', 'family_key']),
    parentKey: string(source, ['parentKey', 'parent_key']),
    sellable: bool(source, ['sellable']),
    packageMode: string(source, ['packageMode', 'package_mode'], 'not reported'),
    catalogReadiness: string(source, ['catalogReadiness', 'catalog_readiness'], 'not reported'),
    derivedReadiness: string(source, ['readiness', 'derivedReadiness', 'derived_readiness'], string(source, ['catalogReadiness', 'catalog_readiness'], 'not reported')),
    readinessSummary: string(source, ['readinessSummary', 'readiness_summary']),
    sourceRepo: string(source, ['sourceRepo', 'source_repo']),
    sourceRefs: stringList(first(source, ['sourceRefs', 'source_refs'], [])),
    features: (Array.isArray(source.features) ? source.features : []).map(transformPortfolioFeature),
    evidence,
    latestTest: latestTestSource ? transformPortfolioTestRun(latestTestSource) : {
      status: evidence.latestTestStatus,
      finishedAt: evidence.latestTestAt,
      updatedAt: evidence.latestTestAt,
      createdAt: evidence.latestTestAt,
    },
    latestPackage: latestPackageSource ? transformPortfolioPackage(latestPackageSource) : {
      status: evidence.latestPackageStatus,
      verifiedAt: evidence.latestPackageAt,
      updatedAt: evidence.latestPackageAt,
      createdAt: evidence.latestPackageAt,
    },
    blockers: blockers.length ? blockers : evidence.missingSuiteKeys.map((suiteKey) => `Required evidence missing: ${suiteKey}`),
    requiredSuiteKeys: stringList(first(source, ['requiredSuiteKeys', 'required_suite_keys'], [])),
    allowedSuiteKeys: stringList(first(source, ['allowedSuiteKeys', 'allowed_suite_keys', 'suiteKeys', 'suite_keys'], [])),
    testSuites: testSuites.map((suite) => typeof suite === 'string' ? { key: suite, name: suite } : {
      key: string(object(suite), ['key', 'suiteKey', 'suite_key', 'id']),
      name: string(object(suite), ['name', 'label'], string(object(suite), ['key', 'suiteKey', 'suite_key', 'id'])),
    }).filter((suite) => suite.key),
  };
}

export function transformPortfolioPayload(payload) {
  const root = object(unwrap(payload));
  const summary = object(root.summary);
  const products = (Array.isArray(root.products) ? root.products : []).map(transformPortfolioProduct);
  const verifiedCount = products.filter((product) => normalizeStatus(product.derivedReadiness) === 'verified working').length;
  return {
    summary: {
      total: portfolioNumber(summary, ['total'], products.length),
      newCount: portfolioNumber(summary, ['newCount', 'new_count'], products.filter((product) => portfolioOriginGroup(product.origin) === 'new').length),
      existingCount: portfolioNumber(summary, ['existingCount', 'existing_count'], products.filter((product) => portfolioOriginGroup(product.origin) === 'existing').length),
      verifiedCount: portfolioNumber(summary, ['verifiedCount', 'verified_count'], verifiedCount),
      attentionCount: portfolioNumber(summary, ['attentionCount', 'attention_count'], Math.max(0, products.length - verifiedCount)),
      packageableFeatureCount: portfolioNumber(summary, ['packageableFeatureCount', 'packageable_feature_count'], products.flatMap((product) => product.features).filter((feature) => feature.packageable).length),
    },
    products,
  };
}

export function transformPortfolioDetailPayload(detailPayload, testRunsPayload, packagesPayload) {
  const detail = object(unwrap(detailPayload));
  const productSource = populatedObject(detail.product) || detail;
  const product = transformPortfolioProduct(productSource);
  const testRuns = listFrom(testRunsPayload ?? detail.testRuns, ['testRuns', 'test_runs', 'runs']).map(transformPortfolioTestRun);
  const packages = listFrom(packagesPayload ?? detail.packages, ['packages']).map(transformPortfolioPackage);
  if (!product.latestTest && testRuns.length) product.latestTest = testRuns[0];
  if (!product.latestPackage && packages.length) product.latestPackage = packages[0];
  return { product, testRuns, packages };
}

export function filterPortfolioProducts(products, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const origin = String(filters.origin || 'all');
  const kind = normalizeStatus(filters.kind || 'all');
  const readiness = normalizeStatus(filters.readiness || 'all');
  const packageState = normalizeStatus(filters.packageState || 'all');
  return products.filter((product) => {
    const productPackageState = normalizeStatus(product.evidence?.latestPackageStatus || product.latestPackage?.status || 'not packaged');
    const text = `${product.name} ${product.key} ${product.sourceId} ${product.familyKey} ${product.aliases.join(' ')} ${product.readinessSummary}`.toLowerCase();
    return (!query || text.includes(query))
      && (origin === 'all' || portfolioOriginGroup(product.origin) === origin)
      && (kind === 'all' || normalizeStatus(product.kind) === kind)
      && (readiness === 'all' || normalizeStatus(product.derivedReadiness) === readiness)
      && (packageState === 'all' || productPackageState === packageState);
  });
}

export function filterConnectors(connectors, query = '', status = 'all') {
  const needle = String(query).trim().toLowerCase();
  return connectors.filter((connector) => {
    const statusMatches = status === 'all' || normalizeStatus(connector.status) === normalizeStatus(status);
    const textMatches = !needle || `${connector.name} ${connector.category} ${connector.externalRef}`.toLowerCase().includes(needle);
    return statusMatches && textMatches;
  });
}
