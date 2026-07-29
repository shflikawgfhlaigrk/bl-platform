import type {
  FoundationAdapterReadiness,
  FoundationInvocationRequest,
  FoundationInvocationResult,
  FoundationVerificationRequest,
  FoundationVerificationResult,
  ServiceFoundationAdapter,
} from '../adapters';

/**
 * Sales Operator (service `sales-operator`, capability `client_ops.sales.process_lead`,
 * owned source `BlackLabelLeadsAPI`).
 *
 *   invokeBoundary : "Validate, enrich, route, or follow up one provenance-linked lead within approved policy."
 *   verifyBoundary : "Read back the CRM record, message delivery, and pipeline next step."
 *
 * This adapter does ONE real, READ-ONLY unit of sales operations work over an owned
 * lead source. In production the injected reader is `createSqlLeadReader(run)`, which
 * SELECTs a single provenance-linked row from the owned `leads` table on psql :5433
 * (db `blacklabel`, ~580k rows) — the store behind `BlackLabelLeadsAPI`. Here a test
 * injects a deterministic in-memory reader so the validate/enrich/route assertions are
 * exact and hermetic.
 *
 * SAFETY — structurally incapable of sending. The adapter's ONLY dependency is a
 * read-only `LeadReader`; no email/SMS/CRM/write channel exists in scope. So:
 *   • Read-only actions (validate_lead, enrich_lead, route_lead, process_lead,
 *     draft_followup, score_lead, qualify_lead) run validate→enrich→route over the
 *     provenance-linked lead and return `completed` with PII MASKED in the output.
 *   • Any send/write or unrecognized action (upsert_lead, send_followup, create_review,
 *     …) returns `accepted` — a computed proposal with `dispatched: false`, NEVER
 *     `completed`. That makes the runner halt the run `not_ready` with no completion
 *     receipt, so a gated send can never masquerade as done.
 *
 * Anti-vapor guarantee: it NEVER fabricates a lead. If no reader is wired the adapter
 * reports readiness `'declared'` and `invoke()` returns `status: 'failed'`; if the
 * lead is absent or the read throws it also fails honestly instead of inventing rows.
 *
 * §5.1 honest label: the stored `email_status = 'verified'` is a REGISTRY convention
 * (person-level address present, role/generic-filtered) — it is NOT an SMTP/MX probe.
 * This adapter runs no deliverability probe, so it surfaces the honest `'listed'`
 * label (registry-listed + role-filtered) and never re-emits the `'verified'` overclaim.
 */

/** A single owned lead, shaped after the psql `leads` table (snake_case columns kept). */
export interface SalesLead {
  id: string | number;
  name?: string | null;
  category_norm?: string | null;
  subtype?: string | null;
  contact_name?: string | null;
  email?: string | null;
  /** Stored registry convention: 'verified' | 'none' | … (NOT an SMTP result). */
  email_status?: string | null;
  phone?: string | null;
  website?: string | null;
  city?: string | null;
  state?: string | null;
  region?: string | null;
  /** Owned deliverability bucket: 'personal' | 'role' | … */
  deliverability_tier?: string | null;
  source?: string | null;
}

/** Injected, READ-ONLY access to one owned lead by id. Production wires psql; tests supply a deterministic fn. */
export interface LeadReader {
  getLeadById(id: string): Promise<SalesLead | null>;
}

export interface SalesOperatorAdapterOptions {
  /** Read-only lead accessor. When null/omitted the adapter is `'declared'` and cannot execute. */
  reader?: LeadReader | null;
}

/** Read-only lead operations this adapter will actually execute (and complete). */
export const READ_ONLY_SALES_ACTIONS: ReadonlySet<string> = new Set([
  'validate_lead',
  'enrich_lead',
  'route_lead',
  'process_lead',
  'draft_followup',
  'score_lead',
  'qualify_lead',
]);

/** The honest surfaced status (§5.1): registry-listed + role-filtered, never claimed 'verified'. */
export const SURFACED_LISTED_STATUS = 'listed';

const OWNED_SOURCE = 'BlackLabelLeadsAPI';

// --- Contactability rules, ported from BlackLabelLeadsAPI/src/index.js -----------------
// Role / generic local-parts that never count as a person-level, contactable address.
const ROLE_LOCAL_NORMS: ReadonlySet<string> = new Set([
  'accounting', 'accounts', 'admin', 'administrator', 'advertising', 'agentlicensing', 'apply',
  'appointments', 'billing', 'booking', 'bookings', 'callcenterlicensing', 'careers', 'catering',
  'compliance', 'contact', 'contactus', 'corporate', 'customerservice', 'design', 'dispatch',
  'donotreply', 'enquiries', 'events', 'feedback', 'frontdesk', 'general', 'hello', 'help', 'hi',
  'hiring', 'hours', 'hr', 'info', 'infodesk', 'inquiries', 'invoice', 'invoices', 'jobs', 'legal',
  'license', 'licensedagent', 'licensing', 'listing', 'listings', 'mail', 'manager', 'marketing',
  'media', 'noreply', 'office', 'order', 'orders', 'payroll', 'postmaster', 'press', 'privacy',
  'reception', 'recruit', 'recruiting', 'reservations', 'returns', 'sales', 'schedule',
  'scheduling', 'security', 'service', 'shipping', 'social', 'staff', 'store', 'support', 'team',
  'talent', 'webmaster', 'work',
]);
const ROLE_LOCAL_PREFIXES: readonly string[] = [
  'info', 'contact', 'hello', 'help', 'sales', 'office', 'manager', 'reception', 'appointment',
  'inquir', 'enquir', 'schedul', 'service', 'quote', 'estimat', 'noreply', 'donotreply',
  'newsletter', 'licens', 'compliance', 'support', 'admin', 'billing', 'accounts', 'marketing',
  'media', 'press', 'legal', 'hr', 'recruit', 'agentlicens', 'callcenterlicens',
];
const TOLLFREE_NPAS: ReadonlySet<string> = new Set(['800', '888', '877', '866', '855', '844', '833', '822', '900']);

function normalizeLocal(email: string): string {
  return String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True iff the lead carries a person-level, role-filtered address in the owned 'personal' tier. */
export function isLegitEmail(lead: SalesLead): boolean {
  const email = String(lead?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return false;
  if (lead.email_status !== 'verified' || lead.deliverability_tier !== 'personal') return false;
  const local = email.split('@')[0].toLowerCase();
  const norm = normalizeLocal(email);
  if (local === 'info' || ROLE_LOCAL_NORMS.has(norm)) return false;
  return !ROLE_LOCAL_PREFIXES.some((prefix) => norm.startsWith(prefix));
}

function phoneDigits(phone: string | null | undefined): string {
  return String(phone || '').replace(/\D/g, '');
}

/** True iff the phone is a current, dialable NANP line (not toll-free / not malformed). */
export function isCurrentPhone(phone: string | null | undefined): boolean {
  let digits = phoneDigits(phone);
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return /^[2-9]\d{9}$/.test(digits) && !TOLLFREE_NPAS.has(digits.slice(0, 3));
}

/** Mask an email to first-char + domain, e.g. `j•••@acme.com`. Never surfaces the full local part. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [user, domain] = email.split('@');
  return domain ? (user ? user[0] : '') + '•••@' + domain : '•••';
}

/** Mask a phone, keeping only the final two digits, e.g. `••••••••37`. */
export function maskPhone(phone: string | null | undefined): string | null {
  return phone ? String(phone).replace(/\d(?=\d{2})/g, '•') : null;
}

function coerceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Defensive: run input is `unknown`; pull only a non-empty lead id string. */
function resolveLeadId(input: unknown): string | null {
  const record = coerceRecord(input);
  const raw = record.leadId ?? record.lead_id ?? record.id;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

function normalizeAction(actionType: string): string {
  return String(actionType || '').trim().toLowerCase();
}

function isLeadReader(value: unknown): value is LeadReader {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getLeadById?: unknown }).getLeadById === 'function'
  );
}

/** A masked, PII-free projection of a lead — the only lead shape this adapter ever emits. */
interface MaskedLead {
  id: string;
  name: string | null;
  category_norm: string | null;
  subtype: string | null;
  city: string | null;
  state: string | null;
  region: string | null;
  website: string | null;
  source: string | null;
  contact_name: null;
  email: string | null;
  /** Honest surfaced status: 'listed' when contactable, else 'none'. Never 'verified'. */
  email_status: 'listed' | 'none';
  deliverability_tier: string | null;
  phone: string | null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === '' ? null : s;
}

function maskLead(lead: SalesLead, emailOk: boolean, phoneOk: boolean): MaskedLead {
  return {
    id: String(lead.id),
    name: str(lead.name),
    category_norm: str(lead.category_norm),
    subtype: str(lead.subtype),
    city: str(lead.city),
    state: str(lead.state),
    region: str(lead.region),
    website: str(lead.website),
    source: str(lead.source),
    contact_name: null, // PII: never surfaced
    email: emailOk ? maskEmail(lead.email) : null,
    email_status: emailOk ? SURFACED_LISTED_STATUS : 'none',
    deliverability_tier: emailOk ? str(lead.deliverability_tier) : null,
    phone: phoneOk ? maskPhone(lead.phone) : null,
  };
}

/** Deterministic validate→enrich→route report over one provenance-linked lead. No fabrication. */
function buildLeadReport(lead: SalesLead, action: string) {
  const emailOk = isLegitEmail(lead);
  const phoneOk = isCurrentPhone(lead.phone);
  const contactable = emailOk || phoneOk;

  const issues: string[] = [];
  if (!emailOk) issues.push('no_contactable_personal_email');
  if (!phoneOk) issues.push('no_current_phone');
  if (!contactable) issues.push('no_contact_channel');

  // Enrichment is derived strictly from fields the lead already carries — never invented.
  const enrichment = {
    industry: str(lead.category_norm),
    specialty: str(lead.subtype),
    hasWebsite: Boolean(str(lead.website)),
    locality: { city: str(lead.city), state: str(lead.state), region: str(lead.region) },
    source: str(lead.source),
  };

  // Routing is a pure function of contactability — the next pipeline step, not an action taken.
  const channel = emailOk ? 'personal_email' : phoneOk ? 'phone' : 'none';
  const nextStep = emailOk
    ? 'prepare_personal_email_followup'
    : phoneOk
      ? 'prepare_phone_followup'
      : 'hold_for_enrichment';
  const queue = contactable ? 'sales_followup_ready' : 'sales_needs_enrichment';

  return {
    readOnly: true as const,
    action,
    ownedSourceIdentifier: OWNED_SOURCE,
    lead: maskLead(lead, emailOk, phoneOk),
    validation: {
      hasContactableEmail: emailOk,
      hasCurrentPhone: phoneOk,
      contactable,
      issues,
    },
    enrichment,
    routing: { channel, nextStep, queue, priority: contactable ? 'standard' : 'low' },
    provenance: { ownedSourceIdentifier: OWNED_SOURCE, leadId: String(lead.id), source: str(lead.source) },
  };
}

export class SalesOperatorAdapter implements ServiceFoundationAdapter {
  readonly serviceId = 'sales-operator';
  readonly capabilityId = 'client_ops.sales.process_lead';
  readonly ownedSourceIdentifier = OWNED_SOURCE;

  private readonly reader: LeadReader | null;

  /** Accepts a `LeadReader` directly, or an options object carrying the reader dep. */
  constructor(options: SalesOperatorAdapterOptions | LeadReader = {}) {
    const opts: SalesOperatorAdapterOptions = isLeadReader(options) ? { reader: options } : options;
    this.reader = opts.reader ?? null;
  }

  /** Ready only when a real lead reader is wired; otherwise 'declared' (never fabricate). */
  readiness(): FoundationAdapterReadiness {
    return this.reader ? 'ready' : 'declared';
  }

  /** Best-effort READ-ONLY load for a gated proposal; never throws, never fabricates. */
  private async tryLoadLead(leadId: string | null): Promise<SalesLead | null> {
    if (!leadId || !this.reader) return null;
    try {
      return await this.reader.getLeadById(leadId);
    } catch {
      return null;
    }
  }

  async invoke(request: FoundationInvocationRequest): Promise<FoundationInvocationResult> {
    const action = normalizeAction(request.actionType);
    const leadId = resolveLeadId(request.input);
    const invocationId = `sales-lead-${request.runId}-${request.actionType}`;

    // Declared-only: no reader wired ⇒ fail honestly, never invent a lead.
    if (!this.reader) {
      return {
        invocationId,
        status: 'failed',
        output: {
          readOnly: true,
          action,
          error:
            'sales-operator adapter has no lead reader wired (readiness=declared); refusing to fabricate lead data',
        },
        externalReferences: [],
      };
    }

    // Send / write / unrecognized ⇒ ACCEPTED gated proposal (dispatched:false), NEVER completed.
    // The adapter holds no send/write channel, so it can only ever propose — the runner then
    // halts the run `not_ready` with no receipt until an approved dispatch path runs it.
    if (!READ_ONLY_SALES_ACTIONS.has(action)) {
      const lead = await this.tryLoadLead(leadId);
      const emailOk = lead ? isLegitEmail(lead) : false;
      const phoneOk = lead ? isCurrentPhone(lead.phone) : false;
      return {
        invocationId,
        status: 'accepted',
        output: {
          readOnly: true,
          dispatched: false,
          gated: true,
          action,
          leadId: leadId ?? null,
          reason:
            'send/write actions require an approved dispatch channel that is not present in this read-only adapter scope',
          proposal: lead
            ? { lead: maskLead(lead, emailOk, phoneOk), ownedSourceIdentifier: OWNED_SOURCE }
            : null,
        },
        externalReferences: leadId ? [`client-ops://sales/proposals/${request.runId}/${action}`] : [],
      };
    }

    // Read-only action ⇒ require a real, provenance-linked lead. Never fabricate one.
    if (!leadId) {
      return {
        invocationId,
        status: 'failed',
        output: { readOnly: true, action, error: 'no leadId in run input; refusing to fabricate a lead' },
        externalReferences: [],
      };
    }

    let lead: SalesLead | null;
    try {
      lead = await this.reader.getLeadById(leadId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        invocationId,
        status: 'failed',
        output: { readOnly: true, action, leadId, error: `lead read failed: ${message}` },
        externalReferences: [],
      };
    }
    if (!lead) {
      return {
        invocationId,
        status: 'failed',
        output: { readOnly: true, action, leadId, error: `lead not found in owned source: ${leadId}` },
        externalReferences: [],
      };
    }

    const report = buildLeadReport(lead, action);
    return {
      invocationId,
      status: 'completed',
      output: report,
      externalReferences: [
        `blacklabel://${OWNED_SOURCE}/leads/${report.lead.id}`,
        `client-ops://sales/leads/${report.lead.id}/${action}`,
      ],
    };
  }

  /** Re-read the lead read-only; verified iff it still resolves and contactability holds. */
  async verify(request: FoundationVerificationRequest): Promise<FoundationVerificationResult> {
    const checkedAt = new Date().toISOString();
    if (!this.reader) {
      return {
        verified: false,
        evidence: { reason: 'no lead reader wired', invocationId: request.invocationId },
        checkedAt,
      };
    }
    const expected = coerceRecord(request.expected);
    const leadId = resolveLeadId(expected);
    if (!leadId) {
      return { verified: false, evidence: { reason: 'no leadId to verify', invocationId: request.invocationId }, checkedAt };
    }
    try {
      const lead = await this.reader.getLeadById(leadId);
      if (!lead) {
        return { verified: false, evidence: { leadId, reason: 'lead absent on re-read', readOnly: true }, checkedAt };
      }
      const emailOk = isLegitEmail(lead);
      const contactable = emailOk || isCurrentPhone(lead.phone);
      const expectedContactable = expected.contactable;
      const matches = typeof expectedContactable === 'boolean' ? expectedContactable === contactable : true;
      return {
        verified: matches,
        evidence: {
          leadId,
          contactable,
          surfacedEmailStatus: emailOk ? SURFACED_LISTED_STATUS : 'none',
          expectedContactable: typeof expectedContactable === 'boolean' ? expectedContactable : null,
          readOnly: true,
        },
        checkedAt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { verified: false, evidence: { leadId, error: message, readOnly: true }, checkedAt };
    }
  }
}

// --- Production wiring (driver-free) ---------------------------------------------------

/** Injected single-statement SQL executor. Keeps this package free of any psql/pg driver dep. */
export type SqlRunner = (
  sql: string,
  params: readonly unknown[],
) => Promise<ReadonlyArray<Record<string, unknown>>>;

/**
 * The ONE read-only statement the production reader issues. Parameterized ($1) so no
 * untrusted value is ever interpolated into SQL. Columns mirror the owned `leads` table
 * on psql :5433 (db `blacklabel`).
 */
export const LEAD_BY_ID_SQL =
  'SELECT id, name, category_norm, subtype, contact_name, email, email_status, phone, ' +
  'website, city, state, region, deliverability_tier, source FROM leads WHERE id = $1 LIMIT 1';

function mapRowToSalesLead(row: Record<string, unknown>): SalesLead {
  return {
    // Owned key is a bigint. Normalize to string so the surfaced id is deterministic across
    // drivers (node-postgres returns bigint as string; others may return a number).
    id: String(row.id ?? ''),
    name: str(row.name),
    category_norm: str(row.category_norm),
    subtype: str(row.subtype),
    contact_name: str(row.contact_name),
    email: str(row.email),
    email_status: str(row.email_status),
    phone: str(row.phone),
    website: str(row.website),
    city: str(row.city),
    state: str(row.state),
    region: str(row.region),
    deliverability_tier: str(row.deliverability_tier),
    source: str(row.source),
  };
}

/**
 * Production reader: a real, READ-ONLY, provenance-linked lookup of one lead by id from
 * the owned `leads` table on psql :5433. The caller injects a `SqlRunner` (their pg/psql
 * executor); this reader only ever runs the single parameterized SELECT above — no writes,
 * deletes, or DDL — so the package stays driver-free and structurally incapable of mutation.
 */
export function createSqlLeadReader(run: SqlRunner): LeadReader {
  return {
    async getLeadById(id: string): Promise<SalesLead | null> {
      const rows = await run(LEAD_BY_ID_SQL, [id]);
      const row = rows && rows.length > 0 ? rows[0] : undefined;
      return row ? mapRowToSalesLead(row) : null;
    },
  };
}

/**
 * Production convenience: a ready `SalesOperatorAdapter` wired to a real owned-source
 * lead reader. Register the result in a `ServiceFoundationRegistry` where the
 * sales-operator should actually execute.
 */
export function createSalesOperatorAdapter(run: SqlRunner): SalesOperatorAdapter {
  return new SalesOperatorAdapter({ reader: createSqlLeadReader(run) });
}
