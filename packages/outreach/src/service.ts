import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { ApiError, asCoreDb, audit, id, nowIso, type EventBus, type Pagination } from '@blacklabel/core';
import type {
  BlockedReason,
  CampaignStatus,
  OutreachCampaignRow,
  OutreachDatabase,
  OutreachInboxRow,
  OutreachSendRow,
  OutreachSettingsRow,
  OutreachTemplateRow,
  TemplateKind,
} from './schema';
import {
  DEFAULT_QUIET_HOURS,
  ageDaysBetween,
  businessDate,
  isQuietHours,
  warmupCapForAge,
  type QuietHours,
} from './capacity';
import {
  POSTAL_PLACEHOLDER,
  UNSUBSCRIBE_PLACEHOLDER,
  render,
  unsubscribeToken,
  unsubscribeUrl,
  validateVars,
  verifyUnsubscribeToken,
  type Vars,
} from './render';
import { classify, normalizeEmail, normalizeSubject } from './classify';
import type { MailboxReader, MailTransport, OutreachAdapters } from './adapters';

type Db = Kysely<OutreachDatabase>;

const BOUNCE_MIN_SENDS = 10;
const BOUNCE_RATE_THRESHOLD = 0.1;
const DEFAULT_UNSUB_BASE = '/api/outreach/unsubscribe';

/* ================================================================== *
 * Settings + gates
 * ================================================================== */

export async function getOrCreateSettings(
  db: Db,
  tenantId: string,
  actor = 'system',
): Promise<OutreachSettingsRow> {
  const existing = await db
    .selectFrom('outreach_settings')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  if (existing) return existing;
  const now = nowIso();
  const row: OutreachSettingsRow = {
    id: id(),
    tenant_id: tenantId,
    armed: 0,
    postal_address: null,
    from_name: null,
    from_email: null,
    reply_to: null,
    provider_credential_ref: null,
    quiet_hours: JSON.stringify(DEFAULT_QUIET_HOURS),
    daily_cap_override: null,
    unsubscribe_secret: randomBytes(24).toString('base64url'),
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('outreach_settings').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'outreach.settings.created', 'outreach.settings', row.id);
  return row;
}

export interface SettingsPatch {
  armed?: boolean;
  postalAddress?: string | null;
  fromName?: string | null;
  fromEmail?: string | null;
  replyTo?: string | null;
  providerCredentialRef?: string | null;
  quietHours?: QuietHours;
  dailyCapOverride?: number | null;
}

export async function updateSettings(
  db: Db,
  tenantId: string,
  actor: string,
  patch: SettingsPatch,
): Promise<OutreachSettingsRow> {
  const current = await getOrCreateSettings(db, tenantId, actor);
  const next: Partial<OutreachSettingsRow> = { updated_at: nowIso() };
  if (patch.armed !== undefined) next.armed = patch.armed ? 1 : 0;
  if (patch.postalAddress !== undefined) next.postal_address = emptyToNull(patch.postalAddress);
  if (patch.fromName !== undefined) next.from_name = emptyToNull(patch.fromName);
  if (patch.fromEmail !== undefined) next.from_email = emptyToNull(patch.fromEmail);
  if (patch.replyTo !== undefined) next.reply_to = emptyToNull(patch.replyTo);
  if (patch.providerCredentialRef !== undefined) {
    next.provider_credential_ref = emptyToNull(patch.providerCredentialRef);
  }
  if (patch.quietHours !== undefined) next.quiet_hours = JSON.stringify(patch.quietHours);
  if (patch.dailyCapOverride !== undefined) next.daily_cap_override = patch.dailyCapOverride;
  await db.updateTable('outreach_settings').set(next).where('id', '=', current.id).execute();
  await audit(asCoreDb(db), tenantId, actor, 'outreach.settings.updated', 'outreach.settings', current.id, patch);
  return getOrCreateSettings(db, tenantId, actor);
}

export interface GateReport {
  armed: boolean;
  postalAddress: boolean;
  provider: boolean;
  fromEmail: boolean;
  /** All send-required gates open — sending is possible. */
  canSend: boolean;
  gates: Array<{ gate: string; open: boolean; detail: string }>;
}

/** Honest UI truth: EXACTLY which send gates are open/closed. */
export async function gateReport(db: Db, tenantId: string): Promise<GateReport> {
  const s = await getOrCreateSettings(db, tenantId);
  const armed = s.armed === 1;
  const postalAddress = !!s.postal_address;
  const provider = !!s.provider_credential_ref;
  const fromEmail = !!s.from_email;
  const canSend = armed && postalAddress && provider && fromEmail;
  return {
    armed,
    postalAddress,
    provider,
    fromEmail,
    canSend,
    gates: [
      { gate: 'armed', open: armed, detail: armed ? 'armed by owner' : 'not armed (founder must set armed=true)' },
      { gate: 'postal_address', open: postalAddress, detail: postalAddress ? 'CAN-SPAM postal address present' : 'CAN-SPAM postal address missing' },
      { gate: 'provider', open: provider, detail: provider ? 'provider credential connected' : 'no provider connected' },
      { gate: 'from_email', open: fromEmail, detail: fromEmail ? 'from address set' : 'from address missing' },
    ],
  };
}

/* ================================================================== *
 * Templates
 * ================================================================== */

export interface TemplateInput {
  name: string;
  kind: TemplateKind;
  subjectTemplate: string;
  bodyTemplate: string;
  requiredPlaceholders?: string[];
  unsubscribeFooterRequired?: boolean;
}

function validateTemplateInput(input: TemplateInput): { required: string[]; footer: boolean } {
  if (input.kind !== 'transactional' && input.kind !== 'promotional') {
    throw ApiError.badRequest('kind must be transactional or promotional');
  }
  const footer = input.unsubscribeFooterRequired ?? input.kind === 'promotional';
  const required = [...new Set(input.requiredPlaceholders ?? [])];
  if (input.kind === 'promotional' || footer) {
    // Promotional MUST carry the unsubscribe link in its body (CAN-SPAM).
    if (!input.bodyTemplate.includes(`{{${UNSUBSCRIBE_PLACEHOLDER}}}`)) {
      throw ApiError.badRequest(
        `promotional templates must include {{${UNSUBSCRIBE_PLACEHOLDER}}} in the body`,
      );
    }
    if (!required.includes(UNSUBSCRIBE_PLACEHOLDER)) required.push(UNSUBSCRIBE_PLACEHOLDER);
  }
  return { required, footer };
}

export async function createTemplate(
  db: Db,
  tenantId: string,
  actor: string,
  input: TemplateInput,
): Promise<OutreachTemplateRow> {
  const { required, footer } = validateTemplateInput(input);
  const now = nowIso();
  const row: OutreachTemplateRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    kind: input.kind,
    subject_template: input.subjectTemplate,
    body_template: input.bodyTemplate,
    required_placeholders: JSON.stringify(required),
    unsubscribe_footer_required: footer ? 1 : 0,
    created_at: now,
    updated_at: now,
  };
  if (!row.name) throw ApiError.badRequest('template name is required');
  await db.insertInto('outreach_templates').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'outreach.template.created', 'outreach.template', row.id);
  return row;
}

export async function updateTemplate(
  db: Db,
  tenantId: string,
  actor: string,
  templateId: string,
  input: TemplateInput,
): Promise<OutreachTemplateRow> {
  await requireTemplate(db, tenantId, templateId);
  const { required, footer } = validateTemplateInput(input);
  await db
    .updateTable('outreach_templates')
    .set({
      name: input.name.trim(),
      kind: input.kind,
      subject_template: input.subjectTemplate,
      body_template: input.bodyTemplate,
      required_placeholders: JSON.stringify(required),
      unsubscribe_footer_required: footer ? 1 : 0,
      updated_at: nowIso(),
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', templateId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'outreach.template.updated', 'outreach.template', templateId);
  return requireTemplate(db, tenantId, templateId);
}

export async function deleteTemplate(
  db: Db,
  tenantId: string,
  actor: string,
  templateId: string,
): Promise<void> {
  await requireTemplate(db, tenantId, templateId);
  await db
    .deleteFrom('outreach_templates')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', templateId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'outreach.template.deleted', 'outreach.template', templateId);
}

export async function listTemplates(db: Db, tenantId: string, page: Pagination): Promise<OutreachTemplateRow[]> {
  return db
    .selectFrom('outreach_templates')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function getTemplate(db: Db, tenantId: string, templateId: string): Promise<OutreachTemplateRow | undefined> {
  return db
    .selectFrom('outreach_templates')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', templateId)
    .executeTakeFirst();
}

async function requireTemplate(db: Db, tenantId: string, templateId: string): Promise<OutreachTemplateRow> {
  const t = await getTemplate(db, tenantId, templateId);
  if (!t) throw ApiError.notFound('template not found');
  return t;
}

/* ================================================================== *
 * Campaigns
 * ================================================================== */

export interface AudienceEntry {
  email: string;
  vars?: Vars;
  profileId?: string;
  /** Consent / established-relationship flag; false → blocked no_consent. */
  consent?: boolean;
}

export interface CampaignInput {
  name: string;
  templateId: string;
  audience?: AudienceEntry[];
  scheduledAt?: string | null;
}

export async function createCampaign(
  db: Db,
  tenantId: string,
  actor: string,
  input: CampaignInput,
): Promise<OutreachCampaignRow> {
  if (!input.name || input.name.trim() === '') throw ApiError.badRequest('campaign name is required');
  await requireTemplate(db, tenantId, input.templateId);
  const now = nowIso();
  const row: OutreachCampaignRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    template_id: input.templateId,
    audience: JSON.stringify(input.audience ?? []),
    status: 'draft',
    approved_by: null,
    scheduled_at: input.scheduledAt ?? null,
    queued_count: 0,
    sent_count: 0,
    bounced_count: 0,
    replied_count: 0,
    suppressed_skipped_count: 0,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('outreach_campaigns').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'outreach.campaign.created', 'outreach.campaign', row.id);
  return row;
}

export async function getCampaign(db: Db, tenantId: string, campaignId: string): Promise<OutreachCampaignRow | undefined> {
  return db
    .selectFrom('outreach_campaigns')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', campaignId)
    .executeTakeFirst();
}

async function requireCampaign(db: Db, tenantId: string, campaignId: string): Promise<OutreachCampaignRow> {
  const c = await getCampaign(db, tenantId, campaignId);
  if (!c) throw ApiError.notFound('campaign not found');
  return c;
}

export async function listCampaigns(db: Db, tenantId: string, page: Pagination): Promise<OutreachCampaignRow[]> {
  return db
    .selectFrom('outreach_campaigns')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function setAudience(
  db: Db,
  tenantId: string,
  actor: string,
  campaignId: string,
  audience: AudienceEntry[],
): Promise<OutreachCampaignRow> {
  const c = await requireCampaign(db, tenantId, campaignId);
  if (c.status !== 'draft') throw ApiError.conflict('audience can only be set on a draft campaign');
  await db
    .updateTable('outreach_campaigns')
    .set({ audience: JSON.stringify(audience), updated_at: nowIso() })
    .where('id', '=', campaignId)
    .where('tenant_id', '=', tenantId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'outreach.campaign.audience_set', 'outreach.campaign', campaignId, {
    count: audience.length,
  });
  return requireCampaign(db, tenantId, campaignId);
}

async function setCampaignStatus(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  campaignId: string,
  status: CampaignStatus,
  extra: Partial<OutreachCampaignRow> = {},
): Promise<OutreachCampaignRow> {
  await db
    .updateTable('outreach_campaigns')
    .set({ status, updated_at: nowIso(), ...extra })
    .where('id', '=', campaignId)
    .where('tenant_id', '=', tenantId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, `outreach.campaign.${status}`, 'outreach.campaign', campaignId);
  return requireCampaign(db, tenantId, campaignId);
}

export async function approveCampaign(db: Db, events: EventBus, tenantId: string, actor: string, campaignId: string): Promise<OutreachCampaignRow> {
  const c = await requireCampaign(db, tenantId, campaignId);
  if (c.status !== 'draft') throw ApiError.conflict(`cannot approve a campaign in status "${c.status}"`);
  return setCampaignStatus(db, events, tenantId, actor, campaignId, 'approved', { approved_by: actor });
}

export async function cancelCampaign(db: Db, events: EventBus, tenantId: string, actor: string, campaignId: string): Promise<OutreachCampaignRow> {
  const c = await requireCampaign(db, tenantId, campaignId);
  if (c.status === 'done' || c.status === 'canceled') {
    throw ApiError.conflict(`cannot cancel a campaign in status "${c.status}"`);
  }
  return setCampaignStatus(db, events, tenantId, actor, campaignId, 'canceled');
}

export async function pauseCampaign(db: Db, events: EventBus, tenantId: string, actor: string, campaignId: string): Promise<OutreachCampaignRow> {
  const c = await requireCampaign(db, tenantId, campaignId);
  if (c.status !== 'approved' && c.status !== 'sending') {
    throw ApiError.conflict(`cannot pause a campaign in status "${c.status}"`);
  }
  return setCampaignStatus(db, events, tenantId, actor, campaignId, 'paused');
}

export async function resumeCampaign(db: Db, events: EventBus, tenantId: string, actor: string, campaignId: string): Promise<OutreachCampaignRow> {
  const c = await requireCampaign(db, tenantId, campaignId);
  if (c.status !== 'paused' && c.status !== 'paused_bounce') {
    throw ApiError.conflict(`cannot resume a campaign in status "${c.status}"`);
  }
  return setCampaignStatus(db, events, tenantId, actor, campaignId, 'sending');
}

/* ================================================================== *
 * Queueing sends (send-of-record, check-then-insert dedup)
 * ================================================================== */

async function emitDelivery(events: EventBus, tenantId: string, sendId: string, state: string): Promise<void> {
  // NO PII in the payload — ids + state only.
  await events.emit(tenantId, 'outreach.delivery.changed', { v: 1, sendId, state });
}

/** Existing ACTIVE send-of-record for (recipient, subject) — queued|sent|bounced. */
async function activeSendOfRecord(db: Db, tenantId: string, recipient: string, subject: string): Promise<OutreachSendRow | undefined> {
  return db
    .selectFrom('outreach_sends')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('recipient_email_normalized', '=', recipient)
    .where('subject', '=', subject)
    .where('status', 'in', ['queued', 'sent', 'bounced'])
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .executeTakeFirst();
}

export interface QueueSendInput {
  templateId: string;
  to: string;
  vars?: Vars;
  consent?: boolean;
  campaignId?: string | null;
}

/**
 * Prepare + record ONE send. Renders subject/body from the fixed template,
 * enforces required placeholders, then check-then-inserts against the
 * (recipient, subject) send-of-record: a duplicate becomes a recorded
 * blocked/duplicate row (never a second live send). Returns the send row.
 */
export async function queueSend(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: QueueSendInput,
  opts: { settings?: OutreachSettingsRow; unsubscribeBaseUrl?: string } = {},
): Promise<OutreachSendRow> {
  const template = await requireTemplate(db, tenantId, input.templateId);
  const settings = opts.settings ?? (await getOrCreateSettings(db, tenantId, actor));
  const recipient = normalizeEmail(input.to);
  if (!recipient || !recipient.includes('@')) throw ApiError.badRequest('a valid recipient email is required');

  const required: string[] = JSON.parse(template.required_placeholders);
  // Unsubscribe/postal are system-injected — not caller-required.
  const callerRequired = required.filter((k) => k !== UNSUBSCRIBE_PLACEHOLDER && k !== POSTAL_PLACEHOLDER);
  const vars: Vars = { ...(input.vars ?? {}) };
  validateVars(callerRequired, vars);

  const subject = render(template.subject_template, vars);
  if (!subject.trim()) throw ApiError.badRequest('rendered subject is empty');

  const sendId = id();
  const baseUrl = opts.unsubscribeBaseUrl ?? DEFAULT_UNSUB_BASE;
  vars[UNSUBSCRIBE_PLACEHOLDER] = unsubscribeUrl(baseUrl, sendId, settings.unsubscribe_secret);
  vars[POSTAL_PLACEHOLDER] = settings.postal_address ?? '';
  const bodyText = render(template.body_template, vars);

  const now = nowIso();
  const dup = await activeSendOfRecord(db, tenantId, recipient, subject);
  const status = dup ? 'blocked' : 'queued';
  const blockedReason: BlockedReason | null = dup ? 'duplicate' : null;

  const row: OutreachSendRow = {
    id: sendId,
    tenant_id: tenantId,
    recipient_email_normalized: recipient,
    subject,
    campaign_id: input.campaignId ?? null,
    template_id: template.id,
    status,
    blocked_reason: blockedReason,
    provider_message_id: null,
    body_text: bodyText,
    body_html: null,
    recipient_consent: input.consent ? 1 : 0,
    sent_at: null,
    created_at: now,
  };
  await db.insertInto('outreach_sends').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, `outreach.send.${status}`, 'outreach.send', sendId, {
    reason: blockedReason ?? undefined,
    campaignId: row.campaign_id ?? undefined,
  });
  await emitDelivery(events, tenantId, sendId, status);
  return row;
}

export interface QueueCampaignResult {
  campaignId: string;
  queued: number;
  duplicates: number;
}

/** Queue every audience row of a campaign. Promotional campaigns MUST be approved. */
export async function queueCampaign(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  campaignId: string,
  opts: { unsubscribeBaseUrl?: string } = {},
): Promise<QueueCampaignResult> {
  const campaign = await requireCampaign(db, tenantId, campaignId);
  const template = await requireTemplate(db, tenantId, campaign.template_id);
  if (template.kind === 'promotional' && campaign.status !== 'approved') {
    throw ApiError.conflict('promotional campaigns must be approved before queueing');
  }
  if (campaign.status === 'canceled' || campaign.status === 'done') {
    throw ApiError.conflict(`cannot queue a campaign in status "${campaign.status}"`);
  }
  const settings = await getOrCreateSettings(db, tenantId, actor);
  const audience: AudienceEntry[] = JSON.parse(campaign.audience);
  let queued = 0;
  let duplicates = 0;
  for (const entry of audience) {
    const row = await queueSend(
      db,
      events,
      tenantId,
      actor,
      {
        templateId: template.id,
        to: entry.email,
        vars: entry.vars,
        consent: entry.consent,
        campaignId,
      },
      { settings, unsubscribeBaseUrl: opts.unsubscribeBaseUrl },
    );
    if (row.status === 'blocked') duplicates += 1;
    else queued += 1;
  }
  await setCampaignStatus(db, events, tenantId, actor, campaignId, 'sending');
  await recomputeCampaignCounts(db, tenantId, campaignId);
  return { campaignId, queued, duplicates };
}

/* ================================================================== *
 * The drain — gates in order, transport send, capacity consume
 * ================================================================== */

export interface DrainResult {
  processed: number;
  sent: string[];
  failed: string[];
  blocked: Array<{ sendId: string; reason: BlockedReason }>;
  deferred: Array<{ sendId: string; reason: BlockedReason }>;
}

/**
 * Drain queued sends through ALL gates, IN ORDER:
 *   1 not_armed  2 no_postal  3 no_provider  4 no_consent  5 suppressed
 *   6 quiet_hours (defer)  7 cap_reached (defer)
 * Hard gates (1–5) record the row status=blocked with its exact reason and emit
 * outreach.delivery.changed. Transient gates (6–7) leave the row QUEUED and are
 * reported in `deferred` (a later drain retries them) — never silently skipped.
 * Replay-safe: a row already past 'queued' is never re-sent.
 */
export async function sendPending(
  db: Db,
  events: EventBus,
  tenantId: string,
  now: string,
  adapters: OutreachAdapters = {},
): Promise<DrainResult> {
  const settings = await getOrCreateSettings(db, tenantId);
  const quiet: QuietHours = parseQuiet(settings.quiet_hours);
  const result: DrainResult = { processed: 0, sent: [], failed: [], blocked: [], deferred: [] };

  const queuedRows = await db
    .selectFrom('outreach_sends')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'queued')
    .orderBy('created_at')
    .orderBy('id')
    .execute();

  // Warmup age from the tenant's FIRST successful send (business date).
  const firstSent = await db
    .selectFrom('outreach_sends')
    .select('sent_at')
    .where('tenant_id', '=', tenantId)
    .where('status', 'in', ['sent', 'bounced'])
    .where('sent_at', 'is not', null)
    .orderBy('sent_at')
    .limit(1)
    .executeTakeFirst();
  const todayDate = businessDate(now, quiet.timezone);
  const firstDate = firstSent?.sent_at ? businessDate(firstSent.sent_at, quiet.timezone) : todayDate;
  const ageDays = ageDaysBetween(firstDate, todayDate);
  const cap = warmupCapForAge(ageDays, settings.daily_cap_override);

  const capacity = await getOrCreateCapacity(db, tenantId, todayDate, cap);
  let sentToday = capacity.sent_count;
  const touchedCampaigns = new Set<string>();

  for (const send of queuedRows) {
    result.processed += 1;
    if (send.campaign_id) touchedCampaigns.add(send.campaign_id);

    const hardReason = await firstFailedHardGate(db, tenantId, settings, send, adapters);
    if (hardReason) {
      await blockSend(db, events, tenantId, send.id, hardReason);
      result.blocked.push({ sendId: send.id, reason: hardReason });
      continue;
    }
    if (isQuietHours(now, quiet)) {
      result.deferred.push({ sendId: send.id, reason: 'quiet_hours' });
      continue;
    }
    if (sentToday >= cap) {
      result.deferred.push({ sendId: send.id, reason: 'cap_reached' });
      continue;
    }
    // Gates open — send via the injected transport.
    const transport = adapters.transport!;
    try {
      const receipt = await transport.send({
        from: fromHeader(settings),
        to: send.recipient_email_normalized,
        subject: send.subject,
        text: send.body_text,
        html: send.body_html ?? undefined,
        headers: { 'List-Unsubscribe': `<${unsubscribeUrlFor(send, settings, adapters)}>` },
      });
      await db
        .updateTable('outreach_sends')
        .set({ status: 'sent', provider_message_id: receipt.providerMessageId, sent_at: now, blocked_reason: null })
        .where('id', '=', send.id)
        .where('tenant_id', '=', tenantId)
        .execute();
      sentToday += 1;
      await bumpCapacity(db, tenantId, capacity.id, sentToday);
      await audit(asCoreDb(db), tenantId, 'system', 'outreach.send.sent', 'outreach.send', send.id);
      await emitDelivery(events, tenantId, send.id, 'sent');
      result.sent.push(send.id);
    } catch (err) {
      await db
        .updateTable('outreach_sends')
        .set({ status: 'failed', blocked_reason: null })
        .where('id', '=', send.id)
        .where('tenant_id', '=', tenantId)
        .execute();
      await audit(asCoreDb(db), tenantId, 'system', 'outreach.send.failed', 'outreach.send', send.id, {
        error: err instanceof Error ? err.message : String(err),
      });
      await emitDelivery(events, tenantId, send.id, 'failed');
      result.failed.push(send.id);
    }
  }

  for (const campaignId of touchedCampaigns) {
    await recomputeCampaignCounts(db, tenantId, campaignId);
    await maybeCompleteCampaign(db, events, tenantId, campaignId);
  }
  return result;
}

/** The first hard gate (1–5) that fails, or null if all hard gates pass. */
async function firstFailedHardGate(
  db: Db,
  tenantId: string,
  settings: OutreachSettingsRow,
  send: OutreachSendRow,
  adapters: OutreachAdapters,
): Promise<BlockedReason | null> {
  if (settings.armed !== 1) return 'not_armed';
  if (!settings.postal_address) return 'no_postal';
  if (!adapters.transport || !settings.provider_credential_ref) return 'no_provider';
  if (send.recipient_consent !== 1) return 'no_consent';
  if (adapters.isSuppressed) {
    const suppressed = await adapters.isSuppressed(tenantId, send.recipient_email_normalized);
    if (suppressed) return 'suppressed';
  }
  return null;
}

async function blockSend(db: Db, events: EventBus, tenantId: string, sendId: string, reason: BlockedReason): Promise<void> {
  await db
    .updateTable('outreach_sends')
    .set({ status: 'blocked', blocked_reason: reason })
    .where('id', '=', sendId)
    .where('tenant_id', '=', tenantId)
    .execute();
  await audit(asCoreDb(db), tenantId, 'system', 'outreach.send.blocked', 'outreach.send', sendId, { reason });
  await emitDelivery(events, tenantId, sendId, 'blocked');
}

function fromHeader(settings: OutreachSettingsRow): string {
  const email = settings.from_email ?? '';
  return settings.from_name ? `${settings.from_name} <${email}>` : email;
}

function unsubscribeUrlFor(send: OutreachSendRow, settings: OutreachSettingsRow, adapters: OutreachAdapters): string {
  return unsubscribeUrl(adapters.unsubscribeBaseUrl ?? DEFAULT_UNSUB_BASE, send.id, settings.unsubscribe_secret);
}

/* ================================================================== *
 * Capacity ledger (check-then-insert; single-threaded → atomic)
 * ================================================================== */

async function getOrCreateCapacity(db: Db, tenantId: string, date: string, cap: number) {
  const existing = await db
    .selectFrom('outreach_capacity')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('date', '=', date)
    .executeTakeFirst();
  if (existing) {
    if (existing.cap !== cap) {
      await db
        .updateTable('outreach_capacity')
        .set({ cap, updated_at: nowIso() })
        .where('id', '=', existing.id)
        .execute();
      return { ...existing, cap };
    }
    return existing;
  }
  const now = nowIso();
  const row = { id: id(), tenant_id: tenantId, date, sent_count: 0, cap, created_at: now, updated_at: now };
  await db.insertInto('outreach_capacity').values(row).execute();
  return row;
}

async function bumpCapacity(db: Db, tenantId: string, capacityId: string, sentCount: number): Promise<void> {
  await db
    .updateTable('outreach_capacity')
    .set({ sent_count: sentCount, updated_at: nowIso() })
    .where('id', '=', capacityId)
    .where('tenant_id', '=', tenantId)
    .execute();
}

/* ================================================================== *
 * Campaign counts + bounce auto-pause
 * ================================================================== */

/** Recompute a campaign's counts from the send-of-record + inbox (source of truth). */
export async function recomputeCampaignCounts(db: Db, tenantId: string, campaignId: string): Promise<void> {
  const sends = await db
    .selectFrom('outreach_sends')
    .select(['status', 'blocked_reason'])
    .where('tenant_id', '=', tenantId)
    .where('campaign_id', '=', campaignId)
    .execute();
  let queued = 0;
  let sent = 0;
  let bounced = 0;
  let suppressedSkipped = 0;
  for (const s of sends) {
    if (s.status === 'queued') queued += 1;
    else if (s.status === 'sent') sent += 1;
    else if (s.status === 'bounced') bounced += 1;
    else if (s.status === 'blocked' && (s.blocked_reason === 'suppressed' || s.blocked_reason === 'duplicate' || s.blocked_reason === 'no_consent')) {
      suppressedSkipped += 1;
    }
  }
  const replied = await db
    .selectFrom('outreach_inbox')
    .innerJoin('outreach_sends', 'outreach_sends.id', 'outreach_inbox.matched_send_id')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('outreach_inbox.tenant_id', '=', tenantId)
    .where('outreach_inbox.classification', '=', 'reply')
    .where('outreach_sends.campaign_id', '=', campaignId)
    .executeTakeFirst();
  await db
    .updateTable('outreach_campaigns')
    .set({
      queued_count: queued,
      sent_count: sent,
      bounced_count: bounced,
      replied_count: Number(replied?.n ?? 0),
      suppressed_skipped_count: suppressedSkipped,
      updated_at: nowIso(),
    })
    .where('id', '=', campaignId)
    .where('tenant_id', '=', tenantId)
    .execute();
}

/** After recompute: pause a campaign whose bounce rate exceeds the threshold. */
export async function evaluateBouncePause(db: Db, events: EventBus, tenantId: string, campaignId: string): Promise<boolean> {
  const c = await getCampaign(db, tenantId, campaignId);
  // Bounces legitimately arrive AFTER a campaign finishes sending, so 'done'
  // is eligible too — the pause + event is the signal that drives an action.
  if (!c || (c.status !== 'sending' && c.status !== 'approved' && c.status !== 'done')) return false;
  const total = c.sent_count + c.bounced_count;
  if (total < BOUNCE_MIN_SENDS) return false;
  const rate = c.bounced_count / total;
  if (rate <= BOUNCE_RATE_THRESHOLD) return false;
  await db
    .updateTable('outreach_campaigns')
    .set({ status: 'paused_bounce', updated_at: nowIso() })
    .where('id', '=', campaignId)
    .where('tenant_id', '=', tenantId)
    .execute();
  await audit(asCoreDb(db), tenantId, 'system', 'outreach.campaign.paused_bounce', 'outreach.campaign', campaignId, {
    bounceRate: rate,
    sent: c.sent_count,
    bounced: c.bounced_count,
  });
  // NO PII — ids + numbers only.
  await events.emit(tenantId, 'outreach.campaign.paused', {
    v: 1,
    campaignId,
    reason: 'bounce',
    bounceRate: rate,
    sent: c.sent_count,
    bounced: c.bounced_count,
  });
  return true;
}

async function maybeCompleteCampaign(db: Db, events: EventBus, tenantId: string, campaignId: string): Promise<void> {
  const c = await getCampaign(db, tenantId, campaignId);
  if (!c || c.status !== 'sending') return;
  if (c.queued_count === 0) {
    await setCampaignStatus(db, events, tenantId, 'system', campaignId, 'done');
  }
}

/* ================================================================== *
 * Reply lane
 * ================================================================== */

async function getOrCreateCursor(db: Db, tenantId: string): Promise<string | null> {
  const existing = await db
    .selectFrom('outreach_reader_state')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  if (existing) return existing.cursor;
  await db
    .insertInto('outreach_reader_state')
    .values({ id: id(), tenant_id: tenantId, cursor: null, updated_at: nowIso() })
    .execute();
  return null;
}

async function saveCursor(db: Db, tenantId: string, cursor: string): Promise<void> {
  await db
    .updateTable('outreach_reader_state')
    .set({ cursor, updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .execute();
}

/** A human reply matches a send by (recipient == from) AND normalized subject. */
async function findReplyMatch(db: Db, tenantId: string, fromEmail: string, subject: string): Promise<OutreachSendRow | undefined> {
  const normFrom = normalizeEmail(fromEmail);
  const normSubj = normalizeSubject(subject);
  const candidates = await db
    .selectFrom('outreach_sends')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('recipient_email_normalized', '=', normFrom)
    .where('status', 'in', ['sent', 'bounced', 'queued'])
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .execute();
  return candidates.find((s) => normalizeSubject(s.subject) === normSubj);
}

/**
 * A bounce matches by the DSN's structured failed-recipient (never the
 * mailer-daemon `from`) — the most recent SENT message to that address.
 */
async function findBounceMatch(db: Db, tenantId: string, bouncedRecipient: string): Promise<OutreachSendRow | undefined> {
  const email = normalizeEmail(bouncedRecipient);
  if (!email) return undefined;
  return db
    .selectFrom('outreach_sends')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('recipient_email_normalized', '=', email)
    .where('status', '=', 'sent')
    .orderBy('sent_at', 'desc')
    .orderBy('id')
    .executeTakeFirst();
}

export interface CheckRepliesResult {
  ingested: number;
  duplicates: number;
  replies: number;
  bounces: number;
  autoReplies: number;
  unknown: number;
}

/**
 * Ingest new inbound messages since the persisted cursor. Idempotent per
 * (tenant, provider_ref): the same message twice → one inbox row. Classifies
 * each, matches replies/bounces to the send-of-record, flips a matched send to
 * bounced (feeding the bounce-pause rule), and advances the cursor.
 */
export async function checkReplies(
  db: Db,
  events: EventBus,
  tenantId: string,
  reader: MailboxReader,
): Promise<CheckRepliesResult> {
  const cursor = await getOrCreateCursor(db, tenantId);
  const { messages, nextCursor } = await reader.fetchNew(cursor);
  const res: CheckRepliesResult = { ingested: 0, duplicates: 0, replies: 0, bounces: 0, autoReplies: 0, unknown: 0 };
  const touchedCampaigns = new Set<string>();

  for (const msg of messages) {
    const already = await db
      .selectFrom('outreach_inbox')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('provider_ref', '=', msg.providerRef)
      .executeTakeFirst();
    if (already) {
      res.duplicates += 1;
      continue;
    }
    const replyMatch = await findReplyMatch(db, tenantId, msg.from, msg.subject);
    const classification = classify(msg, !!replyMatch);
    const bounceRecipient = (msg as { bouncedRecipient?: string }).bouncedRecipient;
    const matched =
      classification === 'bounce'
        ? bounceRecipient
          ? await findBounceMatch(db, tenantId, bounceRecipient)
          : replyMatch
        : replyMatch;
    const now = nowIso();
    const inboxRow: OutreachInboxRow = {
      id: id(),
      tenant_id: tenantId,
      provider_ref: msg.providerRef,
      from_email: normalizeEmail(msg.from),
      subject: msg.subject,
      body_text: msg.text ?? '',
      classification,
      matched_send_id: matched?.id ?? null,
      received_at: msg.receivedAt,
      created_at: now,
    };
    await db.insertInto('outreach_inbox').values(inboxRow).execute();
    await audit(asCoreDb(db), tenantId, 'system', 'outreach.inbox.ingested', 'outreach.inbox', inboxRow.id, { classification });
    res.ingested += 1;

    if (classification === 'reply') res.replies += 1;
    else if (classification === 'auto_reply') res.autoReplies += 1;
    else if (classification === 'unknown') res.unknown += 1;
    else if (classification === 'bounce') {
      res.bounces += 1;
      if (matched && matched.status === 'sent') {
        await db
          .updateTable('outreach_sends')
          .set({ status: 'bounced' })
          .where('id', '=', matched.id)
          .where('tenant_id', '=', tenantId)
          .execute();
        await audit(asCoreDb(db), tenantId, 'system', 'outreach.send.bounced', 'outreach.send', matched.id);
        await emitDelivery(events, tenantId, matched.id, 'bounced');
      }
    }
    if (matched?.campaign_id) touchedCampaigns.add(matched.campaign_id);
  }

  await saveCursor(db, tenantId, nextCursor);
  for (const campaignId of touchedCampaigns) {
    await recomputeCampaignCounts(db, tenantId, campaignId);
    await evaluateBouncePause(db, events, tenantId, campaignId);
  }
  return res;
}

/* ================================================================== *
 * Unsubscribe
 * ================================================================== */

export interface UnsubscribeResult {
  ok: boolean;
  email: string;
  blockedQueued: number;
}

/**
 * Public unsubscribe: validate the HMAC token for the send, suppress the
 * address via the injected callback, and block every still-queued send to it.
 */
export async function processUnsubscribe(
  db: Db,
  events: EventBus,
  tenantId: string,
  sendId: string,
  token: string,
  adapters: OutreachAdapters = {},
): Promise<UnsubscribeResult> {
  const send = await db
    .selectFrom('outreach_sends')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', sendId)
    .executeTakeFirst();
  const settings = await getOrCreateSettings(db, tenantId);
  if (!send || !verifyUnsubscribeToken(sendId, settings.unsubscribe_secret, token)) {
    throw ApiError.badRequest('invalid unsubscribe token');
  }
  const email = send.recipient_email_normalized;
  if (adapters.suppress) await adapters.suppress(tenantId, email, 'unsubscribe');

  const queued = await db
    .selectFrom('outreach_sends')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('recipient_email_normalized', '=', email)
    .where('status', '=', 'queued')
    .execute();
  for (const q of queued) {
    await blockSend(db, events, tenantId, q.id, 'suppressed');
    if (q.campaign_id) await recomputeCampaignCounts(db, tenantId, q.campaign_id);
  }
  await audit(asCoreDb(db), tenantId, 'system', 'outreach.unsubscribe.processed', 'outreach.send', sendId, {
    blockedQueued: queued.length,
  });
  return { ok: true, email, blockedQueued: queued.length };
}

/** Token for a send (used by the router to build a public URL, and by tests). */
export function tokenForSend(sendId: string, secret: string): string {
  return unsubscribeToken(sendId, secret);
}

/* ================================================================== *
 * Reads: sends list, inbox list, thread view
 * ================================================================== */

export async function listSends(
  db: Db,
  tenantId: string,
  page: Pagination,
  filters: { status?: string; campaign_id?: string } = {},
): Promise<OutreachSendRow[]> {
  let q = db.selectFrom('outreach_sends').selectAll().where('tenant_id', '=', tenantId);
  if (filters.status) q = q.where('status', '=', filters.status as OutreachSendRow['status']);
  if (filters.campaign_id) q = q.where('campaign_id', '=', filters.campaign_id);
  return q.orderBy('created_at', 'desc').orderBy('id').limit(page.limit).offset(page.offset).execute();
}

export async function listInbox(db: Db, tenantId: string, page: Pagination): Promise<OutreachInboxRow[]> {
  return db
    .selectFrom('outreach_inbox')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('received_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export interface ThreadView {
  recipient: string;
  sends: OutreachSendRow[];
  inbox: OutreachInboxRow[];
}

/** Sends + inbound messages for one recipient, oldest first. */
export async function getThread(db: Db, tenantId: string, recipient: string): Promise<ThreadView> {
  const email = normalizeEmail(recipient);
  const sends = await db
    .selectFrom('outreach_sends')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('recipient_email_normalized', '=', email)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const inbox = await db
    .selectFrom('outreach_inbox')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('from_email', '=', email)
    .orderBy('received_at')
    .orderBy('id')
    .execute();
  return { recipient: email, sends, inbox };
}

/* ================================================================== *
 * helpers
 * ================================================================== */

function emptyToNull(v: string | null): string | null {
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function parseQuiet(json: string): QuietHours {
  try {
    const q = JSON.parse(json);
    if (typeof q?.startHour === 'number' && typeof q?.endHour === 'number' && typeof q?.timezone === 'string') {
      return q;
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_QUIET_HOURS;
}
