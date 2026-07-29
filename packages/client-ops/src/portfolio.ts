import { CLIENT_OPS_CATALOG, type ReadinessStatus } from './catalog';

export type PortfolioOrigin = 'client_ops' | 'legacy_fleet' | 'assistance';
export type PortfolioKind =
  | 'application'
  | 'operator_service'
  | 'vertical_pack'
  | 'engagement_model'
  | 'service'
  | 'private_reference';
export type PortfolioReadiness =
  | 'verified_working'
  | ReadinessStatus
  | 'not_verified'
  | 'failed'
  | 'retired_merged'
  | 'private_reference';
export type PortfolioPackageMode =
  | 'standalone_app'
  | 'shared_runtime_profile'
  | 'service_contract'
  | 'private_reference';
export type PortfolioEvidenceStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'stale';
export type PortfolioPackageStatus =
  | 'requested'
  | 'building'
  | 'verified'
  | 'failed'
  | 'blocked'
  | 'stale';

export interface PortfolioFeatureDefinition {
  key: string;
  name: string;
  summary: string;
  packageable: boolean;
  catalogReadiness: PortfolioReadiness;
  requiredSuiteKeys: string[];
  allowedSuiteKeys: string[];
}

export interface PortfolioProductDefinition {
  key: string;
  sourceId: string;
  name: string;
  aliases: string[];
  origin: PortfolioOrigin;
  kind: PortfolioKind;
  familyKey: string;
  sellable: boolean;
  packageMode: PortfolioPackageMode;
  catalogReadiness: PortfolioReadiness;
  readinessSummary: string;
  sourceRepo: string;
  sourceRefs: string[];
  requiredSuiteKeys: string[];
  allowedSuiteKeys: string[];
  features: PortfolioFeatureDefinition[];
}

function freezeProduct<T extends PortfolioProductDefinition>(product: T): T {
  Object.freeze(product.aliases);
  Object.freeze(product.sourceRefs);
  Object.freeze(product.requiredSuiteKeys);
  Object.freeze(product.allowedSuiteKeys);
  for (const feature of product.features) {
    Object.freeze(feature.requiredSuiteKeys);
    Object.freeze(feature.allowedSuiteKeys);
    Object.freeze(feature);
  }
  Object.freeze(product.features);
  return Object.freeze(product);
}

const clientOpsProducts: PortfolioProductDefinition[] = [
  ...CLIENT_OPS_CATALOG.services.map((offering) => ({
    key: `offer.${offering.id}`,
    sourceId: offering.id,
    name: offering.name,
    aliases: [] as string[],
    origin: 'client_ops' as const,
    kind: 'operator_service' as const,
    familyKey: 'client-operations',
    sellable: true,
    packageMode: 'shared_runtime_profile' as const,
    catalogReadiness: offering.readiness.status,
    readinessSummary: offering.readiness.summary,
    sourceRepo: 'BlackLabelPlatform',
    sourceRefs: offering.foundationIdentifiers,
    requiredSuiteKeys: [`client-ops.${offering.id}.acceptance`, `client-ops.${offering.id}.security`],
    allowedSuiteKeys: [
      `client-ops.${offering.id}.acceptance`,
      `client-ops.${offering.id}.security`,
      `client-ops.${offering.id}.package`,
    ],
    features: [] as PortfolioFeatureDefinition[],
  })),
  ...CLIENT_OPS_CATALOG.verticalPacks.map((offering) => ({
    key: `pack.${offering.id}`,
    sourceId: offering.id,
    name: offering.name,
    aliases: [] as string[],
    origin: 'client_ops' as const,
    kind: 'vertical_pack' as const,
    familyKey: 'client-operations',
    sellable: true,
    packageMode: 'shared_runtime_profile' as const,
    catalogReadiness: offering.readiness.status,
    readinessSummary: offering.readiness.summary,
    sourceRepo: 'BlackLabelPlatform',
    sourceRefs: offering.foundationIdentifiers,
    requiredSuiteKeys: [`client-ops.${offering.id}.acceptance`, `client-ops.${offering.id}.security`],
    allowedSuiteKeys: [
      `client-ops.${offering.id}.acceptance`,
      `client-ops.${offering.id}.security`,
      `client-ops.${offering.id}.package`,
    ],
    features: [] as PortfolioFeatureDefinition[],
  })),
  ...CLIENT_OPS_CATALOG.engagementModels.map((model) => ({
    key: `engagement.${model.id}`,
    sourceId: model.id,
    name: model.name,
    aliases: [] as string[],
    origin: 'client_ops' as const,
    kind: 'engagement_model' as const,
    familyKey: 'client-operations',
    sellable: true,
    packageMode: 'service_contract' as const,
    catalogReadiness: 'design_ready' as const,
    readinessSummary: model.description,
    sourceRepo: 'BlackLabelPlatform',
    sourceRefs: model.deliverables,
    requiredSuiteKeys: [`client-ops.${model.id}.acceptance`, `client-ops.${model.id}.security`],
    allowedSuiteKeys: [
      `client-ops.${model.id}.acceptance`,
      `client-ops.${model.id}.security`,
      `client-ops.${model.id}.package`,
    ],
    features: [] as PortfolioFeatureDefinition[],
  })),
];

const legacyProducts: PortfolioProductDefinition[] = [
  {
    key: 'app.sovereign', sourceId: 'sovereign', name: 'Sovereign', aliases: ['sovereign'],
    origin: 'legacy_fleet', kind: 'application', familyKey: 'existing-products', sellable: true,
    packageMode: 'standalone_app', catalogReadiness: 'not_verified',
    readinessSummary: 'A prior fleet packet reported partial completion; a current acceptance run and verified package are still required.',
    sourceRepo: 'BlackLabelSovereign', sourceRefs: ['fleet status packet', 'installed macOS application'],
    requiredSuiteKeys: ['fleet.sovereign.acceptance', 'fleet.sovereign.security'], allowedSuiteKeys: ['fleet.sovereign.acceptance', 'fleet.sovereign.security', 'fleet.sovereign.package'], features: [],
  },
  {
    key: 'app.trading', sourceId: 'trading', name: 'Trading', aliases: ['trading'],
    origin: 'legacy_fleet', kind: 'application', familyKey: 'existing-products', sellable: true,
    packageMode: 'standalone_app', catalogReadiness: 'not_verified',
    readinessSummary: 'The trading runtime has reusable foundations, but current live-data acceptance and package evidence are not recorded here.',
    sourceRepo: 'BlackLabelTrading', sourceRefs: ['fleet status packet', 'installed macOS application'],
    requiredSuiteKeys: ['fleet.trading.acceptance', 'fleet.trading.security'], allowedSuiteKeys: ['fleet.trading.acceptance', 'fleet.trading.security', 'fleet.trading.package'], features: [],
  },
  {
    key: 'app.signals', sourceId: 'signals', name: 'Signals', aliases: ['signals'],
    origin: 'legacy_fleet', kind: 'application', familyKey: 'existing-products', sellable: true,
    packageMode: 'standalone_app', catalogReadiness: 'not_verified',
    readinessSummary: 'Signals is known to the product fleet but is missing a current fleet packet and acceptance evidence.',
    sourceRepo: 'BlackLabelSignals', sourceRefs: ['advertised product registry'],
    requiredSuiteKeys: ['fleet.signals.acceptance', 'fleet.signals.security'], allowedSuiteKeys: ['fleet.signals.acceptance', 'fleet.signals.security', 'fleet.signals.package'], features: [],
  },
  {
    key: 'app.marketing', sourceId: 'marketing', name: 'Marketing', aliases: ['marketing'],
    origin: 'legacy_fleet', kind: 'application', familyKey: 'existing-products', sellable: true,
    packageMode: 'standalone_app', catalogReadiness: 'not_verified',
    readinessSummary: 'Marketing has reusable outreach and publishing code; current acceptance and standalone package evidence are required.',
    sourceRepo: 'BlackLabelMarketing', sourceRefs: ['fleet status packet', 'outreach and publishing foundations'],
    requiredSuiteKeys: ['fleet.marketing.acceptance', 'fleet.marketing.security'], allowedSuiteKeys: ['fleet.marketing.acceptance', 'fleet.marketing.security', 'fleet.marketing.package'],
    features: [{
      key: 'app.marketing.feature.email-automation', name: 'Marketing Email Automation',
      summary: 'Individually packageable email campaign, approval, delivery, reply, and evidence workflow.',
      packageable: true, catalogReadiness: 'not_verified', requiredSuiteKeys: ['fleet.marketing.email', 'fleet.marketing.email.security'],
      allowedSuiteKeys: ['fleet.marketing.email', 'fleet.marketing.email.security', 'fleet.marketing.email.package'],
    }],
  },
  {
    key: 'app.lead-database', sourceId: 'lead-database', name: 'Lead Database', aliases: ['leads', 'leadsdb'],
    origin: 'legacy_fleet', kind: 'application', familyKey: 'existing-products', sellable: false,
    packageMode: 'standalone_app', catalogReadiness: 'retired_merged',
    readinessSummary: 'Retired as a separate product and merged into Marketing; retained as a visible historical product record.',
    sourceRepo: 'BlackLabelLeadsAPI', sourceRefs: ['fleet status packet', 'merged into Marketing'],
    requiredSuiteKeys: [], allowedSuiteKeys: [], features: [],
  },
  {
    key: 'app.real-estate', sourceId: 'real-estate', name: 'Real Estate', aliases: ['realestate'],
    origin: 'legacy_fleet', kind: 'application', familyKey: 'existing-products', sellable: true,
    packageMode: 'standalone_app', catalogReadiness: 'not_verified',
    readinessSummary: 'A prior fleet packet exists; a current end-to-end acceptance run and package verification are required.',
    sourceRepo: 'BlackLabelRealEstate', sourceRefs: ['fleet status packet'],
    requiredSuiteKeys: ['fleet.real-estate.acceptance', 'fleet.real-estate.security'], allowedSuiteKeys: ['fleet.real-estate.acceptance', 'fleet.real-estate.security', 'fleet.real-estate.package'], features: [],
  },
  {
    key: 'app.academy', sourceId: 'academy', name: 'Academy', aliases: ['academy'],
    origin: 'legacy_fleet', kind: 'application', familyKey: 'existing-products', sellable: true,
    packageMode: 'standalone_app', catalogReadiness: 'not_verified',
    readinessSummary: 'A prior fleet packet exists; current access, checkout, download, and package acceptance are required.',
    sourceRepo: 'BlackLabelAcademy', sourceRefs: ['fleet status packet'],
    requiredSuiteKeys: ['fleet.academy.acceptance', 'fleet.academy.security'], allowedSuiteKeys: ['fleet.academy.acceptance', 'fleet.academy.security', 'fleet.academy.package'], features: [],
  },
  {
    key: 'app.vigil', sourceId: 'vigil', name: 'Vigil', aliases: ['homefront', 'vigil'],
    origin: 'legacy_fleet', kind: 'application', familyKey: 'existing-products', sellable: true,
    packageMode: 'standalone_app', catalogReadiness: 'not_verified',
    readinessSummary: 'Homefront and Vigil are one product identity; current installed-app and package acceptance are required.',
    sourceRepo: 'BlackLabelHomefront', sourceRefs: ['fleet status packet', 'Homefront alias'],
    requiredSuiteKeys: ['fleet.vigil.acceptance', 'fleet.vigil.security'], allowedSuiteKeys: ['fleet.vigil.acceptance', 'fleet.vigil.security', 'fleet.vigil.package'], features: [],
  },
  {
    key: 'app.circuit', sourceId: 'circuit', name: 'Circuit', aliases: ['circuit'],
    origin: 'legacy_fleet', kind: 'application', familyKey: 'existing-products', sellable: true,
    packageMode: 'standalone_app', catalogReadiness: 'not_verified',
    readinessSummary: 'A prior fleet packet exists; current runtime and standalone package evidence are required.',
    sourceRepo: 'BlackLabelCircuit', sourceRefs: ['fleet status packet'],
    requiredSuiteKeys: ['fleet.circuit.acceptance', 'fleet.circuit.security'], allowedSuiteKeys: ['fleet.circuit.acceptance', 'fleet.circuit.security', 'fleet.circuit.package'], features: [],
  },
  {
    key: 'app.sunset', sourceId: 'sunset', name: 'Sunset', aliases: ['sunset'],
    origin: 'legacy_fleet', kind: 'application', familyKey: 'existing-products', sellable: true,
    packageMode: 'standalone_app', catalogReadiness: 'not_verified',
    readinessSummary: 'A prior fleet packet exists; current runtime and standalone package evidence are required.',
    sourceRepo: 'BlackLabelSunset', sourceRefs: ['fleet status packet'],
    requiredSuiteKeys: ['fleet.sunset.acceptance', 'fleet.sunset.security'], allowedSuiteKeys: ['fleet.sunset.acceptance', 'fleet.sunset.security', 'fleet.sunset.package'], features: [],
  },
  {
    key: 'service.custom-website', sourceId: 'custom-website', name: 'Custom Website', aliases: ['customweb', 'websites'],
    origin: 'legacy_fleet', kind: 'service', familyKey: 'existing-products', sellable: true,
    packageMode: 'service_contract', catalogReadiness: 'not_verified',
    readinessSummary: 'The website service is part of the existing portfolio but has no current fleet acceptance packet.',
    sourceRepo: 'BlackLabelWebsites', sourceRefs: ['advertised product registry'],
    requiredSuiteKeys: ['fleet.custom-website.acceptance', 'fleet.custom-website.security'], allowedSuiteKeys: ['fleet.custom-website.acceptance', 'fleet.custom-website.security', 'fleet.custom-website.package'], features: [],
  },
  {
    key: 'reference.ace', sourceId: 'ace', name: 'Ace', aliases: ['ace'],
    origin: 'legacy_fleet', kind: 'private_reference', familyKey: 'existing-products', sellable: false,
    packageMode: 'private_reference', catalogReadiness: 'private_reference',
    readinessSummary: 'Private internal reference system; visible for reuse tracking and intentionally not offered for sale.',
    sourceRepo: 'ProjectUtah', sourceRefs: ['private internal reference'],
    requiredSuiteKeys: [], allowedSuiteKeys: [], features: [],
  },
];

const assistanceProduct: PortfolioProductDefinition = {
  key: 'product.black-label-assistance',
  sourceId: 'black-label-assistance',
  name: 'Black Label Assistance',
  aliases: ['assistance', 'assistant'],
  origin: 'assistance',
  kind: 'application',
  familyKey: 'black-label-assistance',
  sellable: true,
  packageMode: 'standalone_app',
  catalogReadiness: 'design_ready',
  readinessSummary: 'Native Mac product planned for meeting joining and transcription, two controlled mouse lanes, and conversational voice. Existing component code is not yet an integrated product.',
  sourceRepo: 'BlackLabelSovereign',
  sourceRefs: ['ComputerUseSidecar.swift', 'Voice.swift', 'Calendar.swift'],
  requiredSuiteKeys: [
    'assistance.meeting',
    'assistance.computer-use',
    'assistance.voice',
    'assistance.security',
    'assistance.package',
  ],
  allowedSuiteKeys: [
    'assistance.full',
    'assistance.meeting',
    'assistance.computer-use',
    'assistance.voice',
    'assistance.security',
    'assistance.package',
  ],
  features: [
    {
      key: 'product.black-label-assistance.feature.meeting-intelligence',
      name: 'Meeting Intelligence',
      summary: 'Calendar-aware meeting join, consent-aware audio capture, transcription, diarization, summaries, and action items.',
      packageable: true, catalogReadiness: 'design_ready', requiredSuiteKeys: ['assistance.meeting'], allowedSuiteKeys: ['assistance.meeting'],
    },
    {
      key: 'product.black-label-assistance.feature.dual-mouse',
      name: 'Dual Mouse Control',
      summary: 'Accessibility-element control plus a separately governed pixel-coordinate cursor lane with visible control and stop behavior.',
      packageable: true, catalogReadiness: 'integration_required', requiredSuiteKeys: ['assistance.computer-use'], allowedSuiteKeys: ['assistance.computer-use'],
    },
    {
      key: 'product.black-label-assistance.feature.voice',
      name: 'Conversational Voice',
      summary: 'Wake, dictation, spoken responses, interruption, and an explicit privacy/control state surface.',
      packageable: true, catalogReadiness: 'integration_required', requiredSuiteKeys: ['assistance.voice'], allowedSuiteKeys: ['assistance.voice'],
    },
  ],
};

const products = [...clientOpsProducts, assistanceProduct, ...legacyProducts].map(freezeProduct);
const productKeys = new Set(products.map((product) => product.key));
if (products.length !== 30 || productKeys.size !== 30) {
  throw new Error(`client-ops portfolio must contain exactly 30 unique top-level products; received ${products.length}/${productKeys.size}`);
}

/** Canonical top-level portfolio: 18 new offerings and 12 existing products. */
export const CLIENT_OPS_PORTFOLIO: readonly PortfolioProductDefinition[] = Object.freeze(products);

export function getPortfolioProduct(productKey: string): PortfolioProductDefinition | undefined {
  return CLIENT_OPS_PORTFOLIO.find((product) => product.key === productKey);
}

export function getPortfolioFeature(product: PortfolioProductDefinition, featureKey: string): PortfolioFeatureDefinition | undefined {
  return product.features.find((feature) => feature.key === featureKey);
}
