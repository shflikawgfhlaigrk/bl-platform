/**
 * @blacklabel/storefront — the PUBLIC surface for a Mags Commerce OS tenant.
 *
 * PUBLIC ISOLATION IS LAW. This package owns projection tables (prefix
 * `storefront_`) that are the ONLY data a public request may ever see. A publish
 * pipeline copies FROM private catalog/inventory — through an injected
 * PublishSource; this package imports neither module — INTO the projection, and
 * a publish swaps live ONLY if every build gate passes (leakage / exclusions /
 * WCAG 2.2 AA a11y / zero-external-URL / broken-link / SEO). A failed gate
 * leaves the previous projection live: rollback-by-default.
 *
 * Two consumption modes over the SAME projection + SAME templates:
 *   1. STATIC EXPORT   — `exportStaticSite(...)` → self-contained HTML/CSS/JS
 *      that works over file:// (zero external URLs, localStorage cart, honest
 *      "requires the Mags OS server" checkout state).
 *   2. LIVE ROUTES     — `storefrontPublicRouter(deps)` (Hono, NO tenant header;
 *      tenant fixed at construction) serving /store/* pages + /store/api/*.
 *
 * Internal events emitted (3-segment, v:1):
 *   - storefront.publish.completed  { v:1, runId, itemCount }
 *   - storefront.publish.failed     { v:1, runId, failureCount }
 *
 * Integrator wiring:
 *   - run migrations: `storefrontMigrations`
 *   - publish: `publishStorefront({ db, tenantId, source, config?, events? })`
 *     where `source` implements `PublishSource` (fed from catalog+inventory).
 *   - static export: `exportStaticSite({ db, tenantId, outDir, imageSourceDir })`
 *   - live server: mount `storefrontPublicRouter({ db, tenantId, placeOrder })`
 *     at /store. `placeOrder` forwards to the inventory order endpoint.
 *   - rollback: `rollbackToRun(db, tenantId, runId)`.
 */

export { storefrontMigrations } from './migrations';

export {
  publishStorefront,
  readProjection,
  getLiveRun,
  listPublishRuns,
  rollbackToRun,
  slugify,
} from './publish';
export type {
  PublishSource,
  PublishItemInput,
  PublishVariationInput,
  PublishOptions,
  PublishResult,
} from './publish';

export { exportStaticSite } from './export';
export type { ExportOptions, ExportStats } from './export';

export { storefrontPublicRouter } from './router';
export type { StorefrontRouterDeps, PlaceOrderInput } from './router';

export {
  renderSite,
  buildSearchIndex,
  priceLabel,
  money,
  availabilityBadge,
  itemState,
  escapeHtml,
  DEFAULT_CONFIG,
} from './render';
export type {
  ProjectionSite,
  RenderItem,
  RenderVariation,
  RenderFacet,
  RenderedSite,
  RenderedPage,
  SiteConfig,
} from './render';

export {
  runContentGates,
  leakageGate,
  exclusionOutputGate,
  a11yGate,
  externalUrlGate,
  brokenLinkGate,
  seoGate,
  availabilityNoCountGate,
  assertProjectionSchemaClean,
} from './gates';
export type { GateResult, RunGatesOptions, OwnIdentity } from './gates';

export { buildCss, checkPalette, PALETTE_PAIRS, LIGHT, DARK, AA_MIN } from './theme';
export type { PalettePair, ContrastCheck } from './theme';
export { contrastRatio, relativeLuminance, parseHex } from './contrast';

export type {
  StorefrontDatabase,
  StorefrontPublishRunRow,
  StorefrontPublishedItemRow,
  StorefrontPublishedVariationRow,
  StorefrontAvailabilityRow,
  StorefrontPageRow,
  AvailabilityState,
  PublishRunStatus,
} from './schema';
