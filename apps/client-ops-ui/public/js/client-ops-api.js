import { newIdempotencyKey, request } from './api.js';

const BASE = globalThis.__CLIENT_OPS_API_BASE__ || '/api/client-ops';
const endpoint = (path = '') => `${BASE}${path.startsWith('/') || !path ? path : `/${path}`}`;
const encoded = (value) => encodeURIComponent(String(value));

const dataOf = (body) => body?.data ?? body ?? null;
const listOf = (body) => Array.isArray(dataOf(body)) ? dataOf(body) : [];

async function installationDetails({ signal } = {}) {
  const response = await request(endpoint('/installations?limit=100'), { signal });
  const installations = listOf(response);
  return Promise.all(installations.map(async (installation) => {
    const detail = await request(endpoint(`/installations/${encoded(installation.id)}`), { signal });
    return dataOf(detail);
  }));
}

async function catalogAndInstallations({ signal } = {}) {
  const [catalog, installations] = await Promise.all([
    request(endpoint('/catalog'), { signal }),
    request(endpoint('/installations?limit=100'), { signal }),
  ]);
  return { data: { catalog: dataOf(catalog), installations: listOf(installations) } };
}

async function overview({ signal } = {}) {
  const [summary, installations, runs, reviews, artifacts, receipts] = await Promise.all([
    request(endpoint('/overview'), { signal }),
    installationDetails({ signal }),
    request(endpoint('/runs?limit=100'), { signal }),
    request(endpoint('/reviews?limit=100'), { signal }),
    request(endpoint('/artifacts?limit=100'), { signal }),
    request(endpoint('/receipts?limit=100'), { signal }),
  ]);
  return {
    data: {
      summary: dataOf(summary),
      installations,
      runs: listOf(runs),
      reviews: listOf(reviews),
      artifacts: listOf(artifacts),
      receipts: listOf(receipts),
    },
  };
}

async function artifactsAndReceipts({ signal } = {}) {
  const [artifacts, receipts] = await Promise.all([
    request(endpoint('/artifacts?limit=100'), { signal }),
    request(endpoint('/receipts?limit=100'), { signal }),
  ]);
  return { data: { artifacts: listOf(artifacts), receipts: listOf(receipts) } };
}

export const clientOpsApi = Object.freeze({
  bootstrap: ({ signal } = {}) => request('/api/bootstrap', { signal }),
  usageSummary: ({ signal } = {}) => request(endpoint('/usage-summary'), { signal }),
  overview,
  services: catalogAndInstallations,
  workflows: async ({ signal } = {}) => {
    const [installations, runs] = await Promise.all([
      installationDetails({ signal }),
      request(endpoint('/runs?limit=100'), { signal }),
    ]);
    return { data: { installations, runs: listOf(runs) } };
  },
  reviews: ({ signal } = {}) => request(endpoint('/reviews?limit=100'), { signal }),
  integrations: ({ signal } = {}) => installationDetails({ signal }).then((installations) => ({ data: { installations } })),
  artifacts: artifactsAndReceipts,
  reports: async ({ signal } = {}) => {
    const [summary, events, runs, receipts] = await Promise.all([
      request(endpoint('/usage-summary'), { signal }),
      request(endpoint('/usage-events?limit=100'), { signal }),
      request(endpoint('/runs?limit=100'), { signal }),
      request(endpoint('/receipts?limit=100'), { signal }),
    ]);
    return { data: { summary: dataOf(summary), events: listOf(events), runs: listOf(runs), receipts: listOf(receipts) } };
  },
  setup: ({ signal } = {}) => installationDetails({ signal }).then((installations) => ({ data: { installations } })),
  portfolio: ({ signal } = {}) => request(endpoint('/portfolio'), { signal }),
  portfolioProduct: (productKey, { signal } = {}) => request(endpoint(`/portfolio/${encoded(productKey)}`), { signal }),
  portfolioTestRuns: (productKey, { signal } = {}) => request(endpoint(`/portfolio/${encoded(productKey)}/test-runs`), { signal }),
  portfolioPackages: (productKey, { signal } = {}) => request(endpoint(`/portfolio/${encoded(productKey)}/packages`), { signal }),

  createInstallation: (catalogKind, catalogId, name, engagementModelId = null) => request(endpoint('/installations'), {
    method: 'POST',
    body: {
      catalogKind,
      catalogId,
      ...(name ? { name } : {}),
      ...(engagementModelId ? { engagementModelId } : {}),
    },
  }),

  runWorkflow: (installationId, workflowId) => {
    const key = newIdempotencyKey();
    return request(endpoint('/runs'), {
      method: 'POST',
      idempotencyKey: key,
      body: { installationId, workflowId, idempotencyKey: key, input: { source: 'operator_console' } },
    });
  },
  pauseWorkflow: (installationId, workflowId) => request(endpoint(`/installations/${encoded(installationId)}/workflows/${encoded(workflowId)}`), {
    method: 'PATCH',
    body: { status: 'paused' },
  }),
  retryWorkflow: (runId) => {
    const key = newIdempotencyKey();
    return request(endpoint(`/runs/${encoded(runId)}/retry`), {
      method: 'POST',
      idempotencyKey: key,
      body: { idempotencyKey: key },
    });
  },
  decideReview: (reviewId, decision, note = null) => request(endpoint(`/reviews/${encoded(reviewId)}/${encoded(decision)}`), {
    method: 'POST',
    body: { note: note || null },
  }),
  completeSetupStep: (installationId, stepId, evidence = null) => request(endpoint(`/installations/${encoded(installationId)}/onboarding/${encoded(stepId)}`), {
    method: 'PATCH',
    body: { status: 'completed', ...(evidence ? { evidence } : {}) },
  }),
  runPortfolioTest: (productKey, suiteKey, options = {}) => request(endpoint(`/portfolio/${encoded(productKey)}/test-runs`), {
    method: 'POST',
    body: {
      suiteKey,
      ...(options.targetKind ? { targetKind: options.targetKind } : {}),
      ...(options.targetKey ? { targetKey: options.targetKey } : {}),
      ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    },
  }),
  buildPortfolioPackage: (productKey, version, options = {}) => request(endpoint(`/portfolio/${encoded(productKey)}/packages`), {
    method: 'POST',
    body: {
      version,
      ...(options.targetKind ? { targetKind: options.targetKind } : {}),
      ...(options.targetKey ? { targetKey: options.targetKey } : {}),
    },
  }),
});
