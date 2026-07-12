import type { Kysely } from 'kysely';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  type EventBus,
  type Pagination,
} from '@blacklabel/core';
import type {
  CloseoutStatus,
  DiscrepancyResolution,
  ManifestStatus,
  ShowCloseoutRow,
  ShowDiscrepancyRow,
  ShowManifestLineRow,
  ShowManifestRow,
  ShowPackingTemplateRow,
  ShowRow,
  ShowStatus,
  ShowVenueRow,
  ShowsDatabase,
  VarianceReason,
} from './schema';
import { suggestManifest, type SuggestInputs } from './suggest';

type Db = Kysely<ShowsDatabase>;

/* ================================================================== *
 * Constants: transitions + closeout review sections
 * ================================================================== */

/** Allowed show status transitions. Terminal states have no successors. */
export const SHOW_TRANSITIONS: Record<ShowStatus, ShowStatus[]> = {
  planned: ['packing', 'canceled'],
  packing: ['active', 'canceled'],
  active: ['returned', 'canceled'],
  returned: ['closing', 'canceled'],
  closing: ['closed', 'canceled'],
  closed: [],
  canceled: [],
};

/** Manifest lifecycle transitions. */
export const MANIFEST_TRANSITIONS: Record<ManifestStatus, ManifestStatus[]> = {
  draft: ['final', 'loaded'],
  final: ['loaded'],
  loaded: ['returned'],
  returned: ['reconciled'],
  reconciled: [],
};

/** Review sections that must ALL be acknowledged before a closeout can complete. */
export const CLOSEOUT_SECTIONS = [
  'sales',
  'cash',
  'inventory',
  'damages',
  'refunds',
  'labor',
  'travel',
  'booth_fees',
  'exceptions',
] as const;
export type CloseoutSection = (typeof CLOSEOUT_SECTIONS)[number];

/* ================================================================== *
 * JSON helpers + DTO mappers (parse JSON text columns at the boundary)
 * ================================================================== */

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export interface VenueDto extends Omit<ShowVenueRow, 'address'> {
  address: Record<string, unknown>;
}
export function mapVenue(row: ShowVenueRow): VenueDto {
  return { ...row, address: parseJson<Record<string, unknown>>(row.address, {}) };
}

export interface ShowDto
  extends Omit<ShowRow, 'setup_window' | 'teardown_window' | 'travel' | 'staffing'> {
  setup_window: Record<string, unknown> | null;
  teardown_window: Record<string, unknown> | null;
  travel: Record<string, unknown> | null;
  staffing: Array<Record<string, unknown>>;
}
export function mapShow(row: ShowRow): ShowDto {
  return {
    ...row,
    setup_window: row.setup_window ? parseJson(row.setup_window, {}) : null,
    teardown_window: row.teardown_window ? parseJson(row.teardown_window, {}) : null,
    travel: row.travel ? parseJson(row.travel, {}) : null,
    staffing: parseJson<Array<Record<string, unknown>>>(row.staffing, []),
  };
}

export interface TemplateDto extends Omit<ShowPackingTemplateRow, 'lines'> {
  lines: Array<Record<string, unknown>>;
}
export function mapTemplate(row: ShowPackingTemplateRow): TemplateDto {
  return { ...row, lines: parseJson<Array<Record<string, unknown>>>(row.lines, []) };
}

export interface ManifestLineDto extends Omit<ShowManifestLineRow, 'formula_trace'> {
  formula_trace: Array<Record<string, unknown>>;
}
export function mapManifestLine(row: ShowManifestLineRow): ManifestLineDto {
  return {
    ...row,
    formula_trace: parseJson<Array<Record<string, unknown>>>(row.formula_trace, []),
  };
}

export interface CloseoutDto extends Omit<ShowCloseoutRow, 'review'> {
  review: Record<string, number>;
}
export function mapCloseout(row: ShowCloseoutRow): CloseoutDto {
  return { ...row, review: parseJson<Record<string, number>>(row.review, {}) };
}

export interface DiscrepancyDto extends Omit<ShowDiscrepancyRow, 'resolved'> {
  resolved: boolean;
}
export function mapDiscrepancy(row: ShowDiscrepancyRow): DiscrepancyDto {
  return { ...row, resolved: row.resolved === 1 };
}

function actorOr(actor: string | undefined): string {
  return actor && actor.trim() !== '' ? actor.trim() : 'system';
}

/* ================================================================== *
 * Venues
 * ================================================================== */

export interface VenueInput {
  name: string;
  address?: Record<string, unknown>;
  state: string;
  notes?: string | null;
}

export async function createVenue(
  db: Db,
  tenantId: string,
  actor: string,
  input: VenueInput,
): Promise<ShowVenueRow> {
  const state = input.state.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    throw ApiError.badRequest('venue state must be a 2-letter code', { state: input.state });
  }
  const now = nowIso();
  const row: ShowVenueRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    address: JSON.stringify(input.address ?? {}),
    state,
    notes: input.notes ?? null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('shows_venues').values(row).execute();
  await audit(asCoreDb(db), tenantId, actorOr(actor), 'shows.venue.created', 'shows.venue', row.id, {
    name: row.name,
    state: row.state,
  });
  return row;
}

export async function getVenue(
  db: Db,
  tenantId: string,
  venueId: string,
): Promise<ShowVenueRow> {
  const row = await db
    .selectFrom('shows_venues')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', venueId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound('venue not found');
  return row;
}

export async function listVenues(
  db: Db,
  tenantId: string,
  opts: { state?: string; page?: Pagination } = {},
): Promise<ShowVenueRow[]> {
  const page = opts.page ?? { limit: 50, offset: 0 };
  let q = db.selectFrom('shows_venues').selectAll().where('tenant_id', '=', tenantId);
  if (opts.state) q = q.where('state', '=', opts.state.trim().toUpperCase());
  return q.orderBy('name').orderBy('id').limit(page.limit).offset(page.offset).execute();
}

export async function updateVenue(
  db: Db,
  tenantId: string,
  actor: string,
  venueId: string,
  patch: Partial<VenueInput>,
): Promise<ShowVenueRow> {
  const existing = await getVenue(db, tenantId, venueId);
  const update: Partial<ShowVenueRow> = { updated_at: nowIso() };
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.address !== undefined) update.address = JSON.stringify(patch.address ?? {});
  if (patch.notes !== undefined) update.notes = patch.notes ?? null;
  if (patch.state !== undefined) {
    const state = patch.state.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) {
      throw ApiError.badRequest('venue state must be a 2-letter code', { state: patch.state });
    }
    update.state = state;
  }
  await db
    .updateTable('shows_venues')
    .set(update)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', venueId)
    .execute();
  await audit(asCoreDb(db), tenantId, actorOr(actor), 'shows.venue.updated', 'shows.venue', venueId, {
    before: { name: existing.name, state: existing.state },
    after: { name: update.name ?? existing.name, state: update.state ?? existing.state },
  });
  return getVenue(db, tenantId, venueId);
}

/* ================================================================== *
 * Shows + transitions
 * ================================================================== */

export interface ShowInput {
  venueId: string;
  name: string;
  startsOn: string;
  endsOn: string;
  setupWindow?: Record<string, unknown> | null;
  teardownWindow?: Record<string, unknown> | null;
  boothAssignment?: string | null;
  travel?: Record<string, unknown> | null;
  boothFeeCents?: number | null;
  travelCostCents?: number | null;
  staffing?: Array<Record<string, unknown>>;
  locationId?: string | null;
  notes?: string | null;
}

export async function createShow(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: ShowInput,
): Promise<ShowRow> {
  // Venue must exist for this tenant (id reference, checked — never fabricate).
  await getVenue(db, tenantId, input.venueId);
  if (!input.startsOn.trim() || !input.endsOn.trim()) {
    throw ApiError.badRequest('startsOn and endsOn are required (caller-supplied dates)');
  }
  if (input.endsOn < input.startsOn) {
    throw ApiError.badRequest('endsOn must be >= startsOn', {
      startsOn: input.startsOn,
      endsOn: input.endsOn,
    });
  }
  const now = nowIso();
  const row: ShowRow = {
    id: id(),
    tenant_id: tenantId,
    venue_id: input.venueId,
    name: input.name.trim(),
    starts_on: input.startsOn,
    ends_on: input.endsOn,
    setup_window: input.setupWindow ? JSON.stringify(input.setupWindow) : null,
    teardown_window: input.teardownWindow ? JSON.stringify(input.teardownWindow) : null,
    booth_assignment: input.boothAssignment ?? null,
    travel: input.travel ? JSON.stringify(input.travel) : null,
    booth_fee_cents: input.boothFeeCents ?? null,
    travel_cost_cents: input.travelCostCents ?? null,
    staffing: JSON.stringify(input.staffing ?? []),
    status: 'planned',
    location_id: input.locationId ?? null,
    notes: input.notes ?? null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('shows_shows').values(row).execute();
  await audit(asCoreDb(db), tenantId, actorOr(actor), 'shows.show.scheduled', 'shows.show', row.id, {
    name: row.name,
    venue_id: row.venue_id,
    starts_on: row.starts_on,
  });
  await events.emit(tenantId, 'shows.show.scheduled', {
    v: 1,
    showId: row.id,
    startsAt: row.starts_on,
  });
  return row;
}

export async function getShow(db: Db, tenantId: string, showId: string): Promise<ShowRow> {
  const row = await db
    .selectFrom('shows_shows')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', showId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound('show not found');
  return row;
}

/** Schedule list: optional `from` (YYYY-MM-DD, caller supplies "today") and `state` filter. */
export async function listShows(
  db: Db,
  tenantId: string,
  opts: { from?: string; state?: string; status?: ShowStatus; page?: Pagination } = {},
): Promise<ShowRow[]> {
  const page = opts.page ?? { limit: 50, offset: 0 };
  let q = db.selectFrom('shows_shows').selectAll().where('tenant_id', '=', tenantId);
  if (opts.from) q = q.where('starts_on', '>=', opts.from);
  if (opts.status) q = q.where('status', '=', opts.status);
  if (opts.state) {
    // Filter by venue state via an id-list lookup (no cross-table SQL join).
    const venues = await db
      .selectFrom('shows_venues')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('state', '=', opts.state.trim().toUpperCase())
      .execute();
    const venueIds = venues.map((v) => v.id);
    if (venueIds.length === 0) return [];
    q = q.where('venue_id', 'in', venueIds);
  }
  return q.orderBy('starts_on').orderBy('id').limit(page.limit).offset(page.offset).execute();
}

export async function updateShow(
  db: Db,
  tenantId: string,
  actor: string,
  showId: string,
  patch: Partial<ShowInput>,
): Promise<ShowRow> {
  const existing = await getShow(db, tenantId, showId);
  const update: Partial<ShowRow> = { updated_at: nowIso() };
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.startsOn !== undefined) update.starts_on = patch.startsOn;
  if (patch.endsOn !== undefined) update.ends_on = patch.endsOn;
  if (patch.setupWindow !== undefined)
    update.setup_window = patch.setupWindow ? JSON.stringify(patch.setupWindow) : null;
  if (patch.teardownWindow !== undefined)
    update.teardown_window = patch.teardownWindow ? JSON.stringify(patch.teardownWindow) : null;
  if (patch.boothAssignment !== undefined) update.booth_assignment = patch.boothAssignment ?? null;
  if (patch.travel !== undefined) update.travel = patch.travel ? JSON.stringify(patch.travel) : null;
  if (patch.boothFeeCents !== undefined) update.booth_fee_cents = patch.boothFeeCents ?? null;
  if (patch.travelCostCents !== undefined) update.travel_cost_cents = patch.travelCostCents ?? null;
  if (patch.staffing !== undefined) update.staffing = JSON.stringify(patch.staffing ?? []);
  if (patch.locationId !== undefined) update.location_id = patch.locationId ?? null;
  if (patch.notes !== undefined) update.notes = patch.notes ?? null;
  const nextStart = update.starts_on ?? existing.starts_on;
  const nextEnd = update.ends_on ?? existing.ends_on;
  if (nextEnd < nextStart) {
    throw ApiError.badRequest('endsOn must be >= startsOn', { startsOn: nextStart, endsOn: nextEnd });
  }
  await db
    .updateTable('shows_shows')
    .set(update)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', showId)
    .execute();
  await audit(asCoreDb(db), tenantId, actorOr(actor), 'shows.show.updated', 'shows.show', showId, {
    fields: Object.keys(update).filter((k) => k !== 'updated_at'),
  });
  return getShow(db, tenantId, showId);
}

/** Set the inventory location id created for a show (integrator wiring). */
export async function setShowLocation(
  db: Db,
  tenantId: string,
  actor: string,
  showId: string,
  locationId: string,
): Promise<ShowRow> {
  await getShow(db, tenantId, showId);
  await db
    .updateTable('shows_shows')
    .set({ location_id: locationId, updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', showId)
    .execute();
  await audit(asCoreDb(db), tenantId, actorOr(actor), 'shows.show.located', 'shows.show', showId, {
    location_id: locationId,
  });
  return getShow(db, tenantId, showId);
}

export async function transitionShow(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  showId: string,
  to: ShowStatus,
): Promise<ShowRow> {
  const show = await getShow(db, tenantId, showId);
  const allowed = SHOW_TRANSITIONS[show.status];
  if (!allowed.includes(to)) {
    throw ApiError.conflict(`cannot transition show from "${show.status}" to "${to}"`, {
      from: show.status,
      to,
      allowed,
    });
  }
  // Iron rule: a show may only close when its closeout is complete.
  if (to === 'closed') {
    const closeout = await db
      .selectFrom('shows_closeouts')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('show_id', '=', showId)
      .executeTakeFirst();
    if (!closeout || closeout.status !== 'complete') {
      throw ApiError.conflict('cannot close show: closeout is not complete', {
        closeoutStatus: closeout?.status ?? null,
      });
    }
  }
  await db
    .updateTable('shows_shows')
    .set({ status: to, updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', showId)
    .execute();
  await audit(asCoreDb(db), tenantId, actorOr(actor), 'shows.show.transitioned', 'shows.show', showId, {
    from: show.status,
    to,
  });
  if (to === 'packing') {
    await events.emit(tenantId, 'shows.packing.required', { v: 1, showId });
  }
  if (to === 'closed') {
    await events.emit(tenantId, 'shows.show.closed', { v: 1, showId });
  }
  return getShow(db, tenantId, showId);
}

/* ================================================================== *
 * Packing templates
 * ================================================================== */

export interface TemplateLineInput {
  category?: string | null;
  variationId?: string | null;
  targetQty?: number | null;
  displayMin?: number | null;
}

export interface TemplateInput {
  name: string;
  showType?: string | null;
  season?: string | null;
  lines: TemplateLineInput[];
}

export async function createTemplate(
  db: Db,
  tenantId: string,
  actor: string,
  input: TemplateInput,
): Promise<ShowPackingTemplateRow> {
  const now = nowIso();
  const row: ShowPackingTemplateRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    show_type: input.showType ?? null,
    season: input.season ?? null,
    lines: JSON.stringify(input.lines ?? []),
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('shows_packing_templates').values(row).execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actorOr(actor),
    'shows.packing_template.created',
    'shows.packing_template',
    row.id,
    { name: row.name, lineCount: (input.lines ?? []).length },
  );
  return row;
}

export async function getTemplate(
  db: Db,
  tenantId: string,
  templateId: string,
): Promise<ShowPackingTemplateRow> {
  const row = await db
    .selectFrom('shows_packing_templates')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', templateId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound('packing template not found');
  return row;
}

export async function listTemplates(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<ShowPackingTemplateRow[]> {
  return db
    .selectFrom('shows_packing_templates')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function updateTemplate(
  db: Db,
  tenantId: string,
  actor: string,
  templateId: string,
  patch: Partial<TemplateInput>,
): Promise<ShowPackingTemplateRow> {
  await getTemplate(db, tenantId, templateId);
  const update: Partial<ShowPackingTemplateRow> = { updated_at: nowIso() };
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.showType !== undefined) update.show_type = patch.showType ?? null;
  if (patch.season !== undefined) update.season = patch.season ?? null;
  if (patch.lines !== undefined) update.lines = JSON.stringify(patch.lines ?? []);
  await db
    .updateTable('shows_packing_templates')
    .set(update)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', templateId)
    .execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actorOr(actor),
    'shows.packing_template.updated',
    'shows.packing_template',
    templateId,
    { fields: Object.keys(update).filter((k) => k !== 'updated_at') },
  );
  return getTemplate(db, tenantId, templateId);
}

/* ================================================================== *
 * Manifests: create-from-suggestion, load-out, scan-back
 * ================================================================== */

export interface CreateManifestInput {
  showId: string;
  templateId?: string | null;
  suggestInputs: SuggestInputs;
}

export async function createManifest(
  db: Db,
  tenantId: string,
  actor: string,
  input: CreateManifestInput,
): Promise<{ manifest: ShowManifestRow; lines: ShowManifestLineRow[] }> {
  await getShow(db, tenantId, input.showId);
  if (input.templateId) await getTemplate(db, tenantId, input.templateId);

  const suggestion = suggestManifest(input.suggestInputs);
  const now = nowIso();
  const manifest: ShowManifestRow = {
    id: id(),
    tenant_id: tenantId,
    show_id: input.showId,
    template_id: input.templateId ?? null,
    status: 'draft',
    created_at: now,
    updated_at: now,
  };
  const lineRows: ShowManifestLineRow[] = suggestion.lines.map((line) => ({
    id: id(),
    tenant_id: tenantId,
    manifest_id: manifest.id,
    variation_id: line.variationId,
    name: line.name,
    suggested_qty: line.suggestedQty,
    packed_qty: null,
    returned_qty: null,
    formula_trace: JSON.stringify(line.formulaTrace),
    substitution_of: null,
    missing_reason: null,
    created_at: now,
    updated_at: now,
  }));

  await db.transaction().execute(async (trx) => {
    await trx.insertInto('shows_manifests').values(manifest).execute();
    if (lineRows.length > 0) {
      await trx.insertInto('shows_manifest_lines').values(lineRows).execute();
    }
  });
  await audit(
    asCoreDb(db),
    tenantId,
    actorOr(actor),
    'shows.manifest.created',
    'shows.manifest',
    manifest.id,
    { showId: input.showId, templateId: manifest.template_id, lineCount: lineRows.length },
  );
  return { manifest, lines: lineRows };
}

export async function getManifest(
  db: Db,
  tenantId: string,
  manifestId: string,
): Promise<ShowManifestRow> {
  const row = await db
    .selectFrom('shows_manifests')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', manifestId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound('manifest not found');
  return row;
}

export async function listManifests(
  db: Db,
  tenantId: string,
  showId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<ShowManifestRow[]> {
  return db
    .selectFrom('shows_manifests')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('show_id', '=', showId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function listManifestLines(
  db: Db,
  tenantId: string,
  manifestId: string,
): Promise<ShowManifestLineRow[]> {
  return db
    .selectFrom('shows_manifest_lines')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('manifest_id', '=', manifestId)
    .orderBy('variation_id')
    .orderBy('id')
    .execute();
}

/** Lock a manifest's suggestion: draft -> final. */
export async function finalizeManifest(
  db: Db,
  tenantId: string,
  actor: string,
  manifestId: string,
): Promise<ShowManifestRow> {
  const manifest = await getManifest(db, tenantId, manifestId);
  if (!MANIFEST_TRANSITIONS[manifest.status].includes('final')) {
    throw ApiError.conflict(`cannot finalize manifest in status "${manifest.status}"`);
  }
  await db
    .updateTable('shows_manifests')
    .set({ status: 'final', updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', manifestId)
    .execute();
  await audit(asCoreDb(db), tenantId, actorOr(actor), 'shows.manifest.finalized', 'shows.manifest', manifestId, {});
  return getManifest(db, tenantId, manifestId);
}

export interface PackLineInput {
  variationId: string;
  qty: number;
  reason?: VarianceReason;
  substitutionOf?: string | null;
}

/**
 * Record packed quantities (load-out). A quantity that differs from the
 * suggested quantity is a VARIANCE and REQUIRES a reason
 * (missing|substituted|deliberate). Manifest -> loaded. Emits
 * `shows.manifest.loaded` with the packed lines; the integrator wires the
 * inventory custody transfer from that payload (this module moves no stock).
 */
export async function markPacked(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  manifestId: string,
  lines: PackLineInput[],
): Promise<{ manifest: ShowManifestRow; lines: ShowManifestLineRow[] }> {
  const manifest = await getManifest(db, tenantId, manifestId);
  if (manifest.status !== 'draft' && manifest.status !== 'final') {
    throw ApiError.conflict(`cannot pack a manifest in status "${manifest.status}"`, {
      status: manifest.status,
    });
  }
  const existing = await listManifestLines(db, tenantId, manifestId);
  const byVariation = new Map(existing.map((l) => [l.variation_id, l]));
  const now = nowIso();

  await db.transaction().execute(async (trx) => {
    for (const line of lines) {
      if (line.qty < 0) throw ApiError.badRequest('packed qty cannot be negative');
      const current = byVariation.get(line.variationId);
      const suggested = current?.suggested_qty ?? 0;
      const variance = line.qty - suggested;
      if (variance !== 0 && !line.reason) {
        throw ApiError.badRequest(
          `packed qty ${line.qty} differs from suggested ${suggested} for variation "${line.variationId}" — a variance reason is required`,
          { variationId: line.variationId, suggested, packed: line.qty },
        );
      }
      const missingReason: VarianceReason | null = variance !== 0 ? (line.reason as VarianceReason) : null;
      if (current) {
        await trx
          .updateTable('shows_manifest_lines')
          .set({
            packed_qty: line.qty,
            missing_reason: missingReason,
            substitution_of: line.substitutionOf ?? current.substitution_of,
            updated_at: now,
          })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', current.id)
          .execute();
      } else {
        // A substitute item added at pack time (not on the suggested manifest).
        const row: ShowManifestLineRow = {
          id: id(),
          tenant_id: tenantId,
          manifest_id: manifestId,
          variation_id: line.variationId,
          name: null,
          suggested_qty: 0,
          packed_qty: line.qty,
          returned_qty: null,
          formula_trace: JSON.stringify([
            { step: 'added_at_packing', value: line.qty, note: 'not on suggested manifest' },
          ]),
          substitution_of: line.substitutionOf ?? null,
          missing_reason: missingReason ?? 'substituted',
          created_at: now,
          updated_at: now,
        };
        await trx.insertInto('shows_manifest_lines').values(row).execute();
      }
    }
    await trx
      .updateTable('shows_manifests')
      .set({ status: 'loaded', updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', manifestId)
      .execute();
  });

  await audit(asCoreDb(db), tenantId, actorOr(actor), 'shows.manifest.loaded', 'shows.manifest', manifestId, {
    lineCount: lines.length,
  });
  await events.emit(tenantId, 'shows.manifest.loaded', {
    v: 1,
    manifestId,
    showId: manifest.show_id,
    lines: lines.map((l) => ({ variationId: l.variationId, packedQty: l.qty })),
  });
  return {
    manifest: await getManifest(db, tenantId, manifestId),
    lines: await listManifestLines(db, tenantId, manifestId),
  };
}

export interface ReturnLineInput {
  variationId: string;
  qty: number;
}

/**
 * Record returned quantities (scan-back). Manifest -> returned. Emits
 * `shows.manifest.returned` with packed AND returned per line; the integrator
 * computes discrepancies against inventory movements and posts them back via
 * `postDiscrepancies` (expected-vs-returned is NOT knowable inside this module).
 */
export async function recordReturns(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  manifestId: string,
  lines: ReturnLineInput[],
): Promise<{ manifest: ShowManifestRow; lines: ShowManifestLineRow[] }> {
  const manifest = await getManifest(db, tenantId, manifestId);
  if (manifest.status !== 'loaded') {
    throw ApiError.conflict(`cannot record returns for a manifest in status "${manifest.status}"`, {
      status: manifest.status,
    });
  }
  const existing = await listManifestLines(db, tenantId, manifestId);
  const byVariation = new Map(existing.map((l) => [l.variation_id, l]));
  const now = nowIso();

  await db.transaction().execute(async (trx) => {
    for (const line of lines) {
      if (line.qty < 0) throw ApiError.badRequest('returned qty cannot be negative');
      const current = byVariation.get(line.variationId);
      if (current) {
        await trx
          .updateTable('shows_manifest_lines')
          .set({ returned_qty: line.qty, updated_at: now })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', current.id)
          .execute();
      } else {
        // An unexpected return (variation not packed on this manifest) — record it honestly.
        const row: ShowManifestLineRow = {
          id: id(),
          tenant_id: tenantId,
          manifest_id: manifestId,
          variation_id: line.variationId,
          name: null,
          suggested_qty: 0,
          packed_qty: null,
          returned_qty: line.qty,
          formula_trace: JSON.stringify([
            { step: 'unexpected_return', value: line.qty, note: 'not on packed manifest' },
          ]),
          substitution_of: null,
          missing_reason: null,
          created_at: now,
          updated_at: now,
        };
        await trx.insertInto('shows_manifest_lines').values(row).execute();
      }
    }
    await trx
      .updateTable('shows_manifests')
      .set({ status: 'returned', updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', manifestId)
      .execute();
  });

  const finalLines = await listManifestLines(db, tenantId, manifestId);
  await audit(asCoreDb(db), tenantId, actorOr(actor), 'shows.manifest.returned', 'shows.manifest', manifestId, {
    lineCount: lines.length,
  });
  await events.emit(tenantId, 'shows.manifest.returned', {
    v: 1,
    manifestId,
    showId: manifest.show_id,
    lines: finalLines.map((l) => ({
      variationId: l.variation_id,
      packedQty: l.packed_qty,
      returnedQty: l.returned_qty,
    })),
  });
  return { manifest: await getManifest(db, tenantId, manifestId), lines: finalLines };
}

/** returned -> reconciled, only once every discrepancy for the show is resolved. */
export async function reconcileManifest(
  db: Db,
  tenantId: string,
  actor: string,
  manifestId: string,
): Promise<ShowManifestRow> {
  const manifest = await getManifest(db, tenantId, manifestId);
  if (!MANIFEST_TRANSITIONS[manifest.status].includes('reconciled')) {
    throw ApiError.conflict(`cannot reconcile a manifest in status "${manifest.status}"`);
  }
  const unresolved = await countUnresolvedDiscrepancies(db, tenantId, manifest.show_id);
  if (unresolved > 0) {
    throw ApiError.conflict('cannot reconcile: unresolved discrepancies remain', { unresolved });
  }
  await db
    .updateTable('shows_manifests')
    .set({ status: 'reconciled', updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', manifestId)
    .execute();
  await audit(asCoreDb(db), tenantId, actorOr(actor), 'shows.manifest.reconciled', 'shows.manifest', manifestId, {});
  return getManifest(db, tenantId, manifestId);
}

/* ================================================================== *
 * Discrepancies (integrator-posted, module-stored/resolved)
 * ================================================================== */

export interface DiscrepancyInput {
  variationId: string;
  expectedQty: number;
  returnedQty: number;
}

async function countUnresolvedDiscrepancies(
  db: Db,
  tenantId: string,
  showId: string,
): Promise<number> {
  const row = await db
    .selectFrom('shows_discrepancies')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('tenant_id', '=', tenantId)
    .where('show_id', '=', showId)
    .where('resolved', '=', 0)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

export async function postDiscrepancies(
  db: Db,
  tenantId: string,
  actor: string,
  showId: string,
  manifestId: string | null,
  entries: DiscrepancyInput[],
): Promise<ShowDiscrepancyRow[]> {
  await getShow(db, tenantId, showId);
  const now = nowIso();
  const rows: ShowDiscrepancyRow[] = entries.map((e) => ({
    id: id(),
    tenant_id: tenantId,
    show_id: showId,
    manifest_id: manifestId,
    variation_id: e.variationId,
    expected_qty: e.expectedQty,
    returned_qty: e.returnedQty,
    delta: e.returnedQty - e.expectedQty,
    resolution: null,
    resolved: 0,
    created_at: now,
    updated_at: now,
  }));
  if (rows.length > 0) {
    await db.insertInto('shows_discrepancies').values(rows).execute();
  }
  await audit(asCoreDb(db), tenantId, actorOr(actor), 'shows.discrepancy.posted', 'shows.show', showId, {
    count: rows.length,
  });
  await refreshCloseoutExceptions(db, tenantId, showId);
  return rows;
}

export async function listDiscrepancies(
  db: Db,
  tenantId: string,
  showId: string,
  opts: { unresolvedOnly?: boolean } = {},
): Promise<ShowDiscrepancyRow[]> {
  let q = db
    .selectFrom('shows_discrepancies')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('show_id', '=', showId);
  if (opts.unresolvedOnly) q = q.where('resolved', '=', 0);
  return q.orderBy('created_at').orderBy('id').execute();
}

export async function resolveDiscrepancy(
  db: Db,
  tenantId: string,
  actor: string,
  discrepancyId: string,
  resolution: DiscrepancyResolution,
): Promise<ShowDiscrepancyRow> {
  const row = await db
    .selectFrom('shows_discrepancies')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', discrepancyId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound('discrepancy not found');
  await db
    .updateTable('shows_discrepancies')
    .set({ resolution, resolved: 1, updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', discrepancyId)
    .execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actorOr(actor),
    'shows.discrepancy.resolved',
    'shows.discrepancy',
    discrepancyId,
    { resolution },
  );
  await refreshCloseoutExceptions(db, tenantId, row.show_id);
  const updated = await db
    .selectFrom('shows_discrepancies')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', discrepancyId)
    .executeTakeFirst();
  return updated!;
}

/* ================================================================== *
 * Closeout + P&L
 * ================================================================== */

function emptyReview(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of CLOSEOUT_SECTIONS) out[s] = 0;
  return out;
}

/** Keep the closeout's unresolved_exceptions_count in sync with discrepancies. */
async function refreshCloseoutExceptions(db: Db, tenantId: string, showId: string): Promise<void> {
  const closeout = await db
    .selectFrom('shows_closeouts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('show_id', '=', showId)
    .executeTakeFirst();
  if (!closeout) return;
  const unresolved = await countUnresolvedDiscrepancies(db, tenantId, showId);
  if (unresolved !== closeout.unresolved_exceptions_count) {
    await db
      .updateTable('shows_closeouts')
      .set({ unresolved_exceptions_count: unresolved, updated_at: nowIso() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', closeout.id)
      .execute();
  }
}

/** Get the show's closeout, creating an empty `open` one on first access. */
export async function getOrCreateCloseout(
  db: Db,
  tenantId: string,
  actor: string,
  showId: string,
): Promise<ShowCloseoutRow> {
  await getShow(db, tenantId, showId);
  const existing = await db
    .selectFrom('shows_closeouts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('show_id', '=', showId)
    .executeTakeFirst();
  if (existing) return existing;
  const now = nowIso();
  const row: ShowCloseoutRow = {
    id: id(),
    tenant_id: tenantId,
    show_id: showId,
    sales_total_cents: null,
    cash_variance_cents: null,
    refunds_cents: null,
    labor_cents: null,
    travel_cents: null,
    booth_fee_cents: null,
    damages_count: null,
    unresolved_exceptions_count: await countUnresolvedDiscrepancies(db, tenantId, showId),
    review: JSON.stringify(emptyReview()),
    status: 'open',
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('shows_closeouts').values(row).execute();
  await audit(asCoreDb(db), tenantId, actorOr(actor), 'shows.closeout.opened', 'shows.closeout', row.id, {
    showId,
  });
  return row;
}

export interface CloseoutPatch {
  salesTotalCents?: number | null;
  cashVarianceCents?: number | null;
  refundsCents?: number | null;
  laborCents?: number | null;
  travelCents?: number | null;
  boothFeeCents?: number | null;
  damagesCount?: number | null;
  /** Section acknowledgements to merge, e.g. { sales: 1, cash: 1 }. */
  review?: Record<string, number>;
}

export async function updateCloseout(
  db: Db,
  tenantId: string,
  actor: string,
  showId: string,
  patch: CloseoutPatch,
): Promise<ShowCloseoutRow> {
  const closeout = await getOrCreateCloseout(db, tenantId, actor, showId);
  if (closeout.status === 'complete') {
    throw ApiError.conflict('closeout is already complete');
  }
  const update: Partial<ShowCloseoutRow> = { updated_at: nowIso() };
  if (patch.salesTotalCents !== undefined) update.sales_total_cents = patch.salesTotalCents;
  if (patch.cashVarianceCents !== undefined) update.cash_variance_cents = patch.cashVarianceCents;
  if (patch.refundsCents !== undefined) update.refunds_cents = patch.refundsCents;
  if (patch.laborCents !== undefined) update.labor_cents = patch.laborCents;
  if (patch.travelCents !== undefined) update.travel_cents = patch.travelCents;
  if (patch.boothFeeCents !== undefined) update.booth_fee_cents = patch.boothFeeCents;
  if (patch.damagesCount !== undefined) update.damages_count = patch.damagesCount;
  if (patch.review !== undefined) {
    const current = parseJson<Record<string, number>>(closeout.review, emptyReview());
    for (const [k, v] of Object.entries(patch.review)) {
      if (!(CLOSEOUT_SECTIONS as readonly string[]).includes(k)) {
        throw ApiError.badRequest(`unknown review section "${k}"`, { sections: CLOSEOUT_SECTIONS });
      }
      current[k] = v ? 1 : 0;
    }
    update.review = JSON.stringify(current);
  }
  await db
    .updateTable('shows_closeouts')
    .set(update)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', closeout.id)
    .execute();
  await audit(asCoreDb(db), tenantId, actorOr(actor), 'shows.closeout.updated', 'shows.closeout', closeout.id, {
    fields: Object.keys(update).filter((k) => k !== 'updated_at'),
  });
  await refreshCloseoutExceptions(db, tenantId, showId);
  return getOrCreateCloseout(db, tenantId, actor, showId);
}

/**
 * Complete a closeout. Enforced: EVERY review section marked AND
 * unresolved_exceptions_count == 0 (recomputed from discrepancies). Otherwise
 * ApiError.conflict. Completing the closeout is the precondition for closing
 * the show.
 */
export async function completeCloseout(
  db: Db,
  tenantId: string,
  actor: string,
  showId: string,
): Promise<ShowCloseoutRow> {
  const closeout = await getOrCreateCloseout(db, tenantId, actor, showId);
  if (closeout.status === 'complete') return closeout;
  const review = parseJson<Record<string, number>>(closeout.review, emptyReview());
  const unreviewed = CLOSEOUT_SECTIONS.filter((s) => review[s] !== 1);
  if (unreviewed.length > 0) {
    throw ApiError.conflict('cannot complete closeout: review sections incomplete', { unreviewed });
  }
  const unresolved = await countUnresolvedDiscrepancies(db, tenantId, showId);
  if (unresolved > 0) {
    throw ApiError.conflict('cannot complete closeout: unresolved exceptions remain', { unresolved });
  }
  await db
    .updateTable('shows_closeouts')
    .set({ status: 'complete', unresolved_exceptions_count: 0, updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', closeout.id)
    .execute();
  await audit(asCoreDb(db), tenantId, actorOr(actor), 'shows.closeout.completed', 'shows.closeout', closeout.id, {
    showId,
  });
  return getOrCreateCloseout(db, tenantId, actor, showId);
}

export interface ShowPnl {
  showId: string;
  closeoutStatus: CloseoutStatus;
  revenueCents: number | null;
  costs: {
    refundsCents: number | null;
    laborCents: number | null;
    travelCents: number | null;
    boothFeeCents: number | null;
  };
  cashVarianceCents: number | null;
  damagesCount: number | null;
  /** null when ANY component is missing — never zero-filled. */
  netProfitCents: number | null;
  /** netProfit / revenue in basis points; null when not computable. */
  marginBps: number | null;
  unresolvedExceptionsCount: number;
  /** Names of null posted fields that block a full P&L. */
  missingInputs: string[];
}

/**
 * Derive P&L strictly from non-null posted numbers. A null input is reported in
 * `missingInputs` and blocks netProfit/margin — this module never invents a
 * zero to make the math close.
 */
export async function showPnl(
  db: Db,
  tenantId: string,
  actor: string,
  showId: string,
): Promise<ShowPnl> {
  const c = await getOrCreateCloseout(db, tenantId, actor, showId);
  const costFields: Array<[keyof ShowCloseoutRow, string]> = [
    ['refunds_cents', 'refundsCents'],
    ['labor_cents', 'laborCents'],
    ['travel_cents', 'travelCents'],
    ['booth_fee_cents', 'boothFeeCents'],
  ];
  const missingInputs: string[] = [];
  if (c.sales_total_cents === null) missingInputs.push('salesTotalCents');
  for (const [col, label] of costFields) {
    if (c[col] === null) missingInputs.push(label);
  }
  if (c.cash_variance_cents === null) missingInputs.push('cashVarianceCents');
  if (c.damages_count === null) missingInputs.push('damagesCount');

  const revenueMissing = c.sales_total_cents === null;
  const anyCostMissing = costFields.some(([col]) => c[col] === null);
  let netProfitCents: number | null = null;
  let marginBps: number | null = null;
  if (!revenueMissing && !anyCostMissing) {
    const costTotal =
      (c.refunds_cents ?? 0) + (c.labor_cents ?? 0) + (c.travel_cents ?? 0) + (c.booth_fee_cents ?? 0);
    netProfitCents = (c.sales_total_cents ?? 0) - costTotal;
    if ((c.sales_total_cents ?? 0) > 0) {
      marginBps = Math.round((netProfitCents / (c.sales_total_cents ?? 1)) * 10000);
    }
  }
  return {
    showId,
    closeoutStatus: c.status,
    revenueCents: c.sales_total_cents,
    costs: {
      refundsCents: c.refunds_cents,
      laborCents: c.labor_cents,
      travelCents: c.travel_cents,
      boothFeeCents: c.booth_fee_cents,
    },
    cashVarianceCents: c.cash_variance_cents,
    damagesCount: c.damages_count,
    netProfitCents,
    marginBps,
    unresolvedExceptionsCount: c.unresolved_exceptions_count,
    missingInputs,
  };
}
