import { renderArtifacts } from './artifacts.js';
import { renderClientSetup } from './client-setup.js';
import { renderIntegrations } from './integrations.js';
import { renderOverview } from './overview.js';
import { renderProducts } from './products.js';
import { renderReports } from './reports.js';
import { renderReviewInbox } from './review-inbox.js';
import { renderServices } from './services.js';
import { renderWorkflows } from './workflows.js';

export const views = Object.freeze({
  overview: renderOverview,
  products: renderProducts,
  services: renderServices,
  workflows: renderWorkflows,
  'review-inbox': renderReviewInbox,
  integrations: renderIntegrations,
  artifacts: renderArtifacts,
  reports: renderReports,
  'client-setup': renderClientSetup,
});

export const REGISTERED_VIEW_IDS = Object.freeze(Object.keys(views));
