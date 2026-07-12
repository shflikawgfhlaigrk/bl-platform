/**
 * @blacklabel/shows — horse-show operations: venues, show events, reusable
 * packing templates, manifests (transparent suggestion + load-out/scan-back),
 * discrepancies, and per-show closeout + P&L.
 *
 * DATA TRUTH: historical Square data has ONE location id, so venue/state/date/
 * revenue attribution is NOT derivable for history. Shows are entered manually
 * or imported from a founder schedule; show-scoped analytics exist only for
 * shows operated THROUGH this module going forward. Nothing here fabricates a
 * venue, date, cost, or revenue number — missing financials stay null.
 *
 * Cross-module events emitted (contract catalog, `v:1`):
 *   - shows.show.scheduled     { v, showId, startsAt }   on create
 *   - shows.packing.required   { v, showId }             on status -> packing
 *   - shows.show.closed        { v, showId }             on status -> closed
 * Module-internal events emitted (integrator wires inventory off these):
 *   - shows.manifest.loaded    { v, manifestId, showId, lines:[{variationId, packedQty}] }
 *   - shows.manifest.returned  { v, manifestId, showId, lines:[{variationId, packedQty, returnedQty}] }
 *
 * The module NEVER moves inventory or invents financials: it emits the packed/
 * returned lines and the integrator posts inventory transfers + discrepancies
 * and the real closeout numbers back in.
 */

export { showsMigrations } from './migrations';
export { showsRouter } from './router';

export {
  suggestManifest,
} from './suggest';
export type {
  SuggestInputs,
  SuggestTemplateLine,
  SuggestVariationStat,
  SuggestedLine,
  SuggestResult,
  FormulaTraceStep,
} from './suggest';

export {
  SHOW_TRANSITIONS,
  MANIFEST_TRANSITIONS,
  CLOSEOUT_SECTIONS,
  // venues
  createVenue,
  getVenue,
  listVenues,
  updateVenue,
  // shows
  createShow,
  getShow,
  listShows,
  updateShow,
  setShowLocation,
  transitionShow,
  // templates
  createTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
  // manifests
  createManifest,
  getManifest,
  listManifests,
  listManifestLines,
  finalizeManifest,
  markPacked,
  recordReturns,
  reconcileManifest,
  // discrepancies
  postDiscrepancies,
  listDiscrepancies,
  resolveDiscrepancy,
  // closeout + p&l
  getOrCreateCloseout,
  updateCloseout,
  completeCloseout,
  showPnl,
  // mappers
  mapVenue,
  mapShow,
  mapTemplate,
  mapManifestLine,
  mapCloseout,
  mapDiscrepancy,
} from './service';

export type {
  VenueInput,
  ShowInput,
  TemplateInput,
  TemplateLineInput,
  CreateManifestInput,
  PackLineInput,
  ReturnLineInput,
  DiscrepancyInput,
  CloseoutPatch,
  ShowPnl,
  CloseoutSection,
  VenueDto,
  ShowDto,
  TemplateDto,
  ManifestLineDto,
  CloseoutDto,
  DiscrepancyDto,
} from './service';

export type {
  ShowsDatabase,
  ShowVenueRow,
  ShowRow,
  ShowPackingTemplateRow,
  ShowManifestRow,
  ShowManifestLineRow,
  ShowDiscrepancyRow,
  ShowCloseoutRow,
  ShowStatus,
  ManifestStatus,
  CloseoutStatus,
  VarianceReason,
  DiscrepancyResolution,
} from './schema';
