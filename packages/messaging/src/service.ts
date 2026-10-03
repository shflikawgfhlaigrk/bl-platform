import type { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import {
  ApiError,
  audit,
  asCoreDb,
  id,
  nowIso,
  getUser,
  type EventBus,
  type Pagination,
  type SendMessageContract,
  type SendMessageInput,
  type Sort,
} from '@blacklabel/core';
import { sql } from '@blacklabel/db';
import type {
  ChannelType,
  ConversationStatus,
  MessagingAssignmentRow,
  MessagingChannelRow,
  MessagingConversationRow,
  MessagingDatabase,
  MessagingMessageRow,
  MessagingParticipantRow,
  MessagingTemplateRow,
  ParticipantKind,
} from './schema';
import { CHANNEL_TYPES, CONVERSATION_STATUSES } from './schema';

/* ------------------------------------------------------------------ *
 * Channel providers (explicitly injected for each deployment)
 * ------------------------------------------------------------------ */

export interface OutboundPayload {
  /** Stable operation id for provider-side idempotency. */
  operationId?: string;
  tenantId: string;
  to: string;
  from: string | null;
  subject: string | null;
  body: string;
}

export interface ChannelSendResult {
  /** Provider-side message id (stubs return "stub-<nanoid>"). */
  providerMessageId: string;
  status: 'sent' | 'failed' | 'queued';
  /** Human-readable failure reason when status = 'failed'. */
  detail?: string;
}

/**
 * The exact interface a real channel adapter implements (SendGrid, Twilio,
 * ...). The platform ships LOG-ONLY stubs; apps/api swaps in real adapters
 * by passing them in MessagingRouterOptions.providers.
 */
export interface ChannelProvider {
  readonly type: ChannelType;
  send(payload: OutboundPayload): Promise<ChannelSendResult>;
  /** Read the provider's existing record; must never submit another message. */
  reconcile?(payload: OutboundPayload & { providerMessageId: string }): Promise<ChannelDeliveryResult>;
}

export interface ChannelDeliveryResult {
  providerMessageId: string;
  status: 'accepted' | 'delivered' | 'failed' | 'unknown';
  detail?: string;
  evidenceSha256: string;
}

export interface LoggedSend extends OutboundPayload {
  at: string;
  providerMessageId: string;
}

/** Log-only email adapter: records every send in-memory, delivers nothing. */
export class LogOnlyEmailProvider implements ChannelProvider {
  readonly type: ChannelType = 'email';
  readonly log: LoggedSend[] = [];

  async send(payload: OutboundPayload): Promise<ChannelSendResult> {
    const providerMessageId = `stub-email-${id()}`;
    this.log.push({ ...payload, at: nowIso(), providerMessageId });
    return { providerMessageId, status: 'sent' };
  }
}

/** Log-only SMS adapter: records every send in-memory, delivers nothing. */
export class LogOnlySmsProvider implements ChannelProvider {
  readonly type: ChannelType = 'sms';
  readonly log: LoggedSend[] = [];

  async send(payload: OutboundPayload): Promise<ChannelSendResult> {
    const providerMessageId = `stub-sms-${id()}`;
    this.log.push({ ...payload, at: nowIso(), providerMessageId });
    return { providerMessageId, status: 'sent' };
  }
}

export type ChannelProviders = Partial<Record<ChannelType, ChannelProvider>>;

/** External channels require an explicitly configured provider. */
export function defaultProviders(): ChannelProviders {
  return {};
}

/* ------------------------------------------------------------------ *
 * Timeline contract (messaging -> CRM, injected by apps/api)
 * ------------------------------------------------------------------ */

export interface TimelineEventInput {
  tenantId: string;
  /** Entity the timeline belongs to: "crm.customer" or "crm.contact". */
  entityType: string;
  entityId: string;
  /** e.g. "messaging.message.received", "messaging.conversation.closed". */
  kind: string;
  summary: string;
  /** ISO-8601 UTC. */
  occurredAt: string;
  /** Messaging entity id (message or conversation id). */
  refId?: string;
}

/**
 * Documented cross-module contract: messaging WRITES CRM timeline entries
 * through this interface. apps/api wires the CRM implementation in via
 * MessagingRouterOptions.timeline. Optional — when absent, timeline writes
 * are skipped (events still fire). Timeline failures never break the
 * messaging mutation.
 */
export interface TimelineWriter {
  recordTimelineEvent(input: TimelineEventInput): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Template rendering ({{variable}} substitution)
 * ------------------------------------------------------------------ */

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Substitute {{variable}} placeholders (whitespace-tolerant). Throws 400 if
 * the text references a variable not present in `variables`.
 */
export function renderTemplate(text: string, variables: Record<string, string>): string {
  const missing = new Set<string>();
  const rendered = text.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      return variables[key];
    }
    missing.add(key);
    return '';
  });
  if (missing.size > 0) {
    throw ApiError.badRequest('missing template variables', { missing: [...missing].sort() });
  }
  return rendered;
}

/* ------------------------------------------------------------------ *
 * Status transitions
 * ------------------------------------------------------------------ */

const STATUS_TRANSITIONS: Record<ConversationStatus, readonly ConversationStatus[]> = {
  open: ['pending', 'closed'],
  pending: ['open', 'closed'],
  closed: ['open'],
};

/* ------------------------------------------------------------------ *
 * DTOs / inputs
 * ------------------------------------------------------------------ */

export interface ChannelDto extends Omit<MessagingChannelRow, 'is_active'> {
  is_active: boolean;
}

export interface ConversationDetail extends MessagingConversationRow {
  messages: MessagingMessageRow[];
  participants: MessagingParticipantRow[];
  assignments: MessagingAssignmentRow[];
}

export interface CreateConversationInput {
  subject: string;
  channel: ChannelType;
  customerId?: string;
  contactId?: string;
  participants?: {
    kind: ParticipantKind;
    refId?: string;
    address?: string;
    displayName?: string;
  }[];
}

export interface InboundMessageInput {
  /** Stable verified adapter identity and event id. Both are required together. */
  provider?: string;
  providerEventId?: string;
  channel: ChannelType;
  from: string;
  to?: string;
  subject?: string;
  body: string;
  /** Append to a known conversation; otherwise threaded by (channel, from). */
  conversationId?: string;
  /** Optionally link the (new) conversation to CRM entities. */
  customerId?: string;
  contactId?: string;
  /** 'call' channel only: stored recording URL, transcript, and call length. */
  recordingUrl?: string;
  transcript?: string;
  durationSeconds?: number;
}

export interface SendOutboundInput {
  idempotencyKey?: string;
  conversationId: string;
  to?: string;
  subject?: string;
  body?: string;
  templateId?: string;
  variables?: Record<string, string>;
  expectedRevision?: number;
}

export interface ConversationFilters {
  status?: string;
  channel?: string;
  assigned_user_id?: string;
  customer_id?: string;
}

export interface SearchResult {
  conversations: MessagingConversationRow[];
  messages: MessagingMessageRow[];
}

export interface MessagingServiceOptions {
  providers?: ChannelProviders;
  timeline?: TimelineWriter;
}

const DEFAULT_PAGE: Pagination = { limit: 50, offset: 0 };

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

export class MessagingService {
  private readonly providers: ChannelProviders;
  private readonly timeline?: TimelineWriter;

  constructor(
    private readonly db: Kysely<MessagingDatabase>,
    private readonly events: EventBus,
    options: MessagingServiceOptions = {},
  ) {
    this.providers = options.providers ?? defaultProviders();
    this.timeline = options.timeline;
  }

  /* ------------------------------ channels ------------------------------ */

  async createChannel(
    tenantId: string,
    actor: string,
    input: { type: ChannelType; name: string; address: string; isActive?: boolean },
  ): Promise<ChannelDto> {
    if (!CHANNEL_TYPES.includes(input.type)) {
      throw ApiError.badRequest(`invalid channel type "${input.type}"`, { allowed: CHANNEL_TYPES });
    }
    const now = nowIso();
    const row: MessagingChannelRow = {
      id: id(),
      tenant_id: tenantId,
      type: input.type,
      name: input.name.trim(),
      address: input.address.trim(),
      is_active: input.isActive === false ? 0 : 1,
      created_at: now,
      updated_at: now,
    };
    await this.db.insertInto('messaging_channels').values(row).execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'messaging.channel.created', 'messaging.channel', row.id, {
      type: row.type,
      name: row.name,
    });
    return toChannelDto(row);
  }

  async listChannels(tenantId: string, page: Pagination = DEFAULT_PAGE): Promise<ChannelDto[]> {
    const rows = await this.db
      .selectFrom('messaging_channels')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at')
      .orderBy('id')
      .limit(page.limit)
      .offset(page.offset)
      .execute();
    return rows.map(toChannelDto);
  }

  async getChannel(tenantId: string, channelId: string): Promise<ChannelDto> {
    const row = await this.db
      .selectFrom('messaging_channels')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', channelId)
      .executeTakeFirst();
    if (!row) throw ApiError.notFound(`channel not found: ${channelId}`);
    return toChannelDto(row);
  }

  async updateChannel(
    tenantId: string,
    actor: string,
    channelId: string,
    patch: { name?: string; address?: string; isActive?: boolean },
  ): Promise<ChannelDto> {
    const set: Partial<Pick<MessagingChannelRow, 'name' | 'address' | 'is_active' | 'updated_at'>> = {};
    if (patch.name !== undefined) {
      if (patch.name.trim() === '') throw ApiError.badRequest('channel name cannot be blank');
      set.name = patch.name.trim();
    }
    if (patch.address !== undefined) {
      if (patch.address.trim() === '') throw ApiError.badRequest('channel address cannot be blank');
      set.address = patch.address.trim();
    }
    if (patch.isActive !== undefined) set.is_active = patch.isActive ? 1 : 0;
    if (Object.keys(set).length > 0) {
      set.updated_at = nowIso();
      const result = await this.db
        .updateTable('messaging_channels')
        .set(set)
        .where('tenant_id', '=', tenantId)
        .where('id', '=', channelId)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) throw ApiError.notFound(`channel not found: ${channelId}`);
      await audit(asCoreDb(this.db), tenantId, actor, 'messaging.channel.updated', 'messaging.channel', channelId, patch);
    }
    return this.getChannel(tenantId, channelId);
  }

  async deleteChannel(tenantId: string, actor: string, channelId: string): Promise<void> {
    const result = await this.db
      .deleteFrom('messaging_channels')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', channelId)
      .executeTakeFirst();
    if (result.numDeletedRows === 0n) throw ApiError.notFound(`channel not found: ${channelId}`);
    await audit(asCoreDb(this.db), tenantId, actor, 'messaging.channel.deleted', 'messaging.channel', channelId);
  }

  /* --------------------------- conversations ---------------------------- */

  async createConversation(
    tenantId: string,
    actor: string,
    input: CreateConversationInput,
  ): Promise<MessagingConversationRow> {
    const now = nowIso();
    const row: MessagingConversationRow = {
      id: id(),
      tenant_id: tenantId,
      subject: input.subject.trim(),
      channel: input.channel,
      status: 'open',
      customer_id: input.customerId ?? null,
      contact_id: input.contactId ?? null,
      assigned_user_id: null,
      last_message_at: null,
      created_at: now,
      updated_at: now,
    };
    await this.db.insertInto('messaging_conversations').values(row).execute();
    for (const p of input.participants ?? []) {
      await this.addParticipant(tenantId, row.id, p);
    }
    await audit(asCoreDb(this.db), tenantId, actor, 'messaging.conversation.created', 'messaging.conversation', row.id, {
      subject: row.subject,
      channel: row.channel,
    });
    return row;
  }

  /** Add a participant to an existing conversation (tenant-checked). */
  async addConversationParticipant(
    tenantId: string,
    actor: string,
    conversationId: string,
    p: { kind: ParticipantKind; refId?: string; address?: string; displayName?: string },
  ): Promise<MessagingParticipantRow> {
    await this.getConversationRow(tenantId, conversationId);
    const row = await this.addParticipant(tenantId, conversationId, p);
    await audit(
      asCoreDb(this.db), tenantId, actor,
      'messaging.participant.added', 'messaging.conversation', conversationId,
      { participantId: row.id, kind: p.kind },
    );
    return row;
  }

  private async addParticipant(
    tenantId: string,
    conversationId: string,
    p: { kind: ParticipantKind; refId?: string; address?: string; displayName?: string },
  ): Promise<MessagingParticipantRow> {
    const row: MessagingParticipantRow = {
      id: id(),
      tenant_id: tenantId,
      conversation_id: conversationId,
      kind: p.kind,
      ref_id: p.refId ?? null,
      address: p.address ?? null,
      display_name: p.displayName ?? null,
      created_at: nowIso(),
    };
    await this.db.insertInto('messaging_participants').values(row).execute();
    return row;
  }

  async listConversations(
    tenantId: string,
    filters: ConversationFilters = {},
    page: Pagination = DEFAULT_PAGE,
    sort: Sort = { column: 'last_message_at', direction: 'desc' },
  ): Promise<MessagingConversationRow[]> {
    let qb = this.db
      .selectFrom('messaging_conversations')
      .selectAll()
      .where('tenant_id', '=', tenantId);
    if (filters.status !== undefined) qb = qb.where('status', '=', filters.status as ConversationStatus);
    if (filters.channel !== undefined) qb = qb.where('channel', '=', filters.channel as ChannelType);
    if (filters.assigned_user_id !== undefined) qb = qb.where('assigned_user_id', '=', filters.assigned_user_id);
    if (filters.customer_id !== undefined) qb = qb.where('customer_id', '=', filters.customer_id);
    return qb
      .orderBy(sort.column as 'last_message_at', sort.direction)
      .orderBy('id')
      .limit(page.limit)
      .offset(page.offset)
      .execute();
  }

  async getConversationRow(tenantId: string, conversationId: string): Promise<MessagingConversationRow> {
    const row = await this.db
      .selectFrom('messaging_conversations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', conversationId)
      .executeTakeFirst();
    if (!row) throw ApiError.notFound(`conversation not found: ${conversationId}`);
    return row;
  }

  async getConversation(tenantId: string, conversationId: string): Promise<ConversationDetail> {
    const row = await this.getConversationRow(tenantId, conversationId);
    const [messages, participants, assignments] = await Promise.all([
      this.listMessages(tenantId, conversationId, { limit: 200, offset: 0 }),
      this.db
        .selectFrom('messaging_participants')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('conversation_id', '=', conversationId)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
      this.listAssignments(tenantId, conversationId),
    ]);
    return { ...row, messages, participants, assignments };
  }

  /** Link/update a conversation (subject + CRM references by id string). */
  async updateConversation(
    tenantId: string,
    actor: string,
    conversationId: string,
    patch: { subject?: string; customerId?: string | null; contactId?: string | null },
  ): Promise<MessagingConversationRow> {
    const set: Partial<
      Pick<MessagingConversationRow, 'subject' | 'customer_id' | 'contact_id' | 'updated_at'>
    > = {};
    if (patch.subject !== undefined) {
      if (patch.subject.trim() === '') throw ApiError.badRequest('subject cannot be blank');
      set.subject = patch.subject.trim();
    }
    if (patch.customerId !== undefined) set.customer_id = patch.customerId;
    if (patch.contactId !== undefined) set.contact_id = patch.contactId;
    if (Object.keys(set).length > 0) {
      set.updated_at = nowIso();
      const result = await this.db
        .updateTable('messaging_conversations')
        .set({ ...set, revision: sql<number>`revision + 1` })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', conversationId)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) {
        throw ApiError.notFound(`conversation not found: ${conversationId}`);
      }
      await audit(
        asCoreDb(this.db), tenantId, actor,
        'messaging.conversation.updated', 'messaging.conversation', conversationId, patch,
      );
    }
    return this.getConversationRow(tenantId, conversationId);
  }

  /** open <-> pending, open/pending -> closed, closed -> open. Emits on close. */
  async setStatus(
    tenantId: string,
    actor: string,
    conversationId: string,
    status: ConversationStatus,
  ): Promise<MessagingConversationRow> {
    if (!CONVERSATION_STATUSES.includes(status)) {
      throw ApiError.badRequest(`invalid status "${status}"`, { allowed: CONVERSATION_STATUSES });
    }
    const row = await this.getConversationRow(tenantId, conversationId);
    if (!STATUS_TRANSITIONS[row.status].includes(status)) {
      throw ApiError.conflict(`cannot transition conversation from "${row.status}" to "${status}"`, {
        from: row.status,
        allowed: STATUS_TRANSITIONS[row.status],
      });
    }
    await this.db
      .updateTable('messaging_conversations')
      .set({ status, updated_at: nowIso(), revision: sql<number>`revision + 1` })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', conversationId)
      .execute();
    await audit(
      asCoreDb(this.db), tenantId, actor,
      'messaging.conversation.status_changed', 'messaging.conversation', conversationId,
      { before: row.status, after: status },
    );
    if (status === 'closed') {
      await this.events.emit(tenantId, 'messaging.conversation.closed', { conversationId });
      await this.writeTimeline(row, {
        kind: 'messaging.conversation.closed',
        summary: `Conversation closed: ${row.subject}`,
        refId: conversationId,
      });
    }
    return this.getConversationRow(tenantId, conversationId);
  }

  /* ----------------------------- assignment ----------------------------- */

  async assignConversation(
    tenantId: string,
    actor: string,
    conversationId: string,
    input: { userId: string; note?: string; expectedRevision?: number },
  ): Promise<MessagingAssignmentRow> {
    const conversation = await this.getConversationRow(tenantId, conversationId);
    if (!await getUser(asCoreDb(this.db), tenantId, input.userId)) throw ApiError.notFound('Assignee is not a user in this company.');
    if (input.expectedRevision !== undefined && input.expectedRevision !== (conversation.revision ?? 0)) {
      throw ApiError.conflict('Conversation changed. Refresh before assigning it.');
    }
    const assignment: MessagingAssignmentRow = {
      id: id(),
      tenant_id: tenantId,
      conversation_id: conversationId,
      user_id: input.userId,
      assigned_by: actor,
      note: input.note ?? null,
      created_at: nowIso(),
    };
    const changed = await this.db
      .updateTable('messaging_conversations')
      .set({ assigned_user_id: input.userId, updated_at: nowIso(), revision: sql<number>`revision + 1` })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', conversationId)
      .where('revision', '=', conversation.revision ?? 0)
      .executeTakeFirst();
    if (!changed.numUpdatedRows) throw ApiError.conflict('Conversation ownership changed. Refresh before assigning it.');
    await this.db.insertInto('messaging_assignments').values(assignment).execute();
    await audit(
      asCoreDb(this.db), tenantId, actor,
      'messaging.conversation.assigned', 'messaging.conversation', conversationId,
      { userId: input.userId },
    );
    await this.events.emit(tenantId, 'messaging.conversation.assigned', {
      conversationId,
      userId: input.userId,
    });
    return assignment;
  }

  async listAssignments(tenantId: string, conversationId: string): Promise<MessagingAssignmentRow[]> {
    return this.db
      .selectFrom('messaging_assignments')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('conversation_id', '=', conversationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
  }

  /* ------------------------------ messages ------------------------------ */

  private async nextMessageSeq(tenantId: string, conversationId: string): Promise<number> {
    const prev = await this.db
      .selectFrom('messaging_messages')
      .select('seq')
      .where('tenant_id', '=', tenantId)
      .where('conversation_id', '=', conversationId)
      .orderBy('seq', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    return (prev?.seq ?? 0) + 1;
  }

  async listMessages(
    tenantId: string,
    conversationId: string,
    page: Pagination = DEFAULT_PAGE,
  ): Promise<MessagingMessageRow[]> {
    return this.db
      .selectFrom('messaging_messages')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('conversation_id', '=', conversationId)
      .orderBy('seq')
      .orderBy('created_at')
      .orderBy('id')
      .limit(page.limit)
      .offset(page.offset)
      .execute();
  }

  /**
   * Record an inbound message. Threading: with an explicit conversationId it
   * appends there (reopening a closed conversation); otherwise it finds the
   * most recent non-closed conversation on the same channel that has a
   * participant with the sender's address, or starts a new conversation.
   * Emits `messaging.message.received` and writes a CRM timeline entry when
   * the conversation is linked to a customer/contact.
   */
  async recordInbound(
    tenantId: string,
    actor: string,
    input: InboundMessageInput,
  ): Promise<{ message: MessagingMessageRow; conversation: MessagingConversationRow }> {
    if (input.conversationId) {
      const target = await this.getConversationRow(tenantId, input.conversationId);
      if (target.channel !== input.channel) throw ApiError.badRequest('Inbound channel does not match the conversation.');
    }
    if (!!input.provider !== !!input.providerEventId) throw ApiError.badRequest('Inbound provider and event id must be supplied together.');
    let receiptId: string | undefined;
    if (input.provider && input.providerEventId) {
      const requestHash = createHash('sha256').update(JSON.stringify({ channel: input.channel, from: input.from, to: input.to ?? null,
        subject: input.subject ?? null, body: input.body, conversationId: input.conversationId ?? null, customerId: input.customerId ?? null,
        contactId: input.contactId ?? null, recordingUrl: input.recordingUrl ?? null, transcript: input.transcript ?? null,
        durationSeconds: input.durationSeconds ?? null })).digest('hex');
      const previous = await this.db.selectFrom('messaging_inbound_receipts').selectAll().where('tenant_id', '=', tenantId)
        .where('provider', '=', input.provider).where('channel', '=', input.channel).where('provider_event_id', '=', input.providerEventId).executeTakeFirst();
      if (previous) {
        if (previous.request_hash !== requestHash) throw ApiError.conflict('Inbound event id belongs to different content.');
        if (!previous.message_id || !previous.conversation_id) throw ApiError.conflict('Inbound event is still being processed. Inspect its saved receipt.');
        return { message: await this.getMessage(tenantId, previous.message_id), conversation: await this.getConversationRow(tenantId, previous.conversation_id) };
      }
      receiptId = id();
      try {
        await this.db.insertInto('messaging_inbound_receipts').values({ id: receiptId, tenant_id: tenantId, provider: input.provider,
          channel: input.channel, provider_event_id: input.providerEventId, request_hash: requestHash,
          message_id: null, conversation_id: null, created_at: nowIso() }).execute();
      } catch (error) {
        const raced = await this.db.selectFrom('messaging_inbound_receipts').select('id').where('tenant_id', '=', tenantId)
          .where('provider', '=', input.provider).where('channel', '=', input.channel).where('provider_event_id', '=', input.providerEventId).executeTakeFirst();
        if (raced) throw ApiError.conflict('Inbound event is already being processed.');
        throw error;
      }
    }
    let conversation: MessagingConversationRow | undefined;

    if (input.conversationId) {
      conversation = await this.getConversationRow(tenantId, input.conversationId);
      if (conversation.channel !== input.channel) throw ApiError.badRequest('Inbound channel does not match the conversation.');
    } else {
      const match = await this.db
        .selectFrom('messaging_conversations as c')
        .innerJoin('messaging_participants as p', 'p.conversation_id', 'c.id')
        .select('c.id as id')
        .where('c.tenant_id', '=', tenantId)
        .where('p.tenant_id', '=', tenantId)
        .where('c.channel', '=', input.channel)
        .where('c.status', '!=', 'closed')
        .where('p.address', '=', input.from)
        .orderBy('c.last_message_at', 'desc')
        .orderBy('c.id')
        .executeTakeFirst();
      if (match) conversation = await this.getConversationRow(tenantId, match.id);
    }

    if (!conversation) {
      conversation = await this.createConversation(tenantId, actor, {
        subject: input.subject?.trim() || `Conversation with ${input.from}`,
        channel: input.channel,
        customerId: input.customerId,
        contactId: input.contactId,
        participants: [{ kind: 'external', address: input.from }],
      });
    }

    const now = nowIso();
    const message: MessagingMessageRow = {
      id: id(),
      tenant_id: tenantId,
      conversation_id: conversation.id,
      direction: 'in',
      channel: input.channel,
      from_address: input.from,
      to_address: input.to ?? null,
      subject: input.subject ?? null,
      body: input.body,
      status: 'received',
      provider_message_id: null,
      failed_reason: null,
      recording_url: input.channel === 'call' ? input.recordingUrl ?? null : null,
      transcript: input.channel === 'call' ? input.transcript ?? null : null,
      duration_seconds: input.channel === 'call' ? input.durationSeconds ?? null : null,
      seq: await this.nextMessageSeq(tenantId, conversation.id),
      created_at: now,
    };
    await this.db.insertInto('messaging_messages').values(message).execute();
    if (receiptId) await this.db.updateTable('messaging_inbound_receipts').set({ message_id: message.id, conversation_id: conversation.id })
      .where('tenant_id', '=', tenantId).where('id', '=', receiptId).execute();
    await this.db
      .updateTable('messaging_conversations')
      .set({
        last_message_at: now,
        updated_at: now,
        revision: sql<number>`revision + 1`,
        // an inbound message reopens a closed conversation
        ...(conversation.status === 'closed' ? { status: 'open' as ConversationStatus } : {}),
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', conversation.id)
      .execute();
    await audit(
      asCoreDb(this.db), tenantId, actor,
      'messaging.message.received', 'messaging.message', message.id,
      { conversationId: conversation.id, channel: input.channel, from: input.from },
    );
    await this.events.emit(tenantId, 'messaging.message.received', {
      messageId: message.id,
      channel: input.channel,
      from: input.from,
    });
    await this.writeTimeline(conversation, {
      kind: 'messaging.message.received',
      summary: `Message received from ${input.from} (${input.channel})`,
      refId: message.id,
    });
    const fresh = await this.getConversationRow(tenantId, conversation.id);
    return { message, conversation: fresh };
  }

  /**
   * Send an outbound message on a conversation, via the channel provider
   * Body may come from a template ({{variable}} substitution). Only the
   * internal channel can complete without an explicitly connected provider.
   */
  async sendOutbound(
    tenantId: string,
    actor: string,
    input: SendOutboundInput,
  ): Promise<MessagingMessageRow> {
    const conversation = await this.getConversationRow(tenantId, input.conversationId);
    if (conversation.status === 'closed') {
      throw ApiError.conflict('cannot send a message on a closed conversation (reopen it first)');
    }

    let body = input.body;
    let subject = input.subject ?? null;
    if (input.templateId) {
      const template = await this.getTemplate(tenantId, input.templateId);
      if (template.channel !== null && template.channel !== conversation.channel) {
        throw ApiError.badRequest(
          `template "${template.name}" is restricted to channel "${template.channel}"`,
        );
      }
      const variables = input.variables ?? {};
      body = renderTemplate(template.body, variables);
      if (subject === null && template.subject !== null) {
        subject = renderTemplate(template.subject, variables);
      }
    }
    if (!body || body.trim() === '') {
      throw ApiError.badRequest('message body is required (directly or via templateId)');
    }

    let to = input.to ?? null;
    if (!to) {
      const external = await this.db
        .selectFrom('messaging_participants')
        .select('address')
        .where('tenant_id', '=', tenantId)
        .where('conversation_id', '=', conversation.id)
        .where('kind', '=', 'external')
        .where('address', 'is not', null)
        .orderBy('created_at')
        .orderBy('id')
        .executeTakeFirst();
      to = external?.address ?? null;
    }
    if (!to) {
      throw ApiError.badRequest('no recipient: pass "to" or add an external participant with an address');
    }

    const fromChannel = await this.db
      .selectFrom('messaging_channels')
      .select('address')
      .where('tenant_id', '=', tenantId)
      .where('type', '=', conversation.channel)
      .where('is_active', '=', 1)
      .orderBy('created_at')
      .orderBy('id')
      .executeTakeFirst();
    const from = fromChannel?.address ?? null;

    const provider = this.providers[conversation.channel];
    let status: 'queued' | 'sent' | 'failed' = provider ? 'queued' : conversation.channel === 'internal' ? 'sent' : 'failed';
    let providerMessageId: string | null = null;
    let failedReason: string | null = status === 'failed' ? `No ${conversation.channel} provider is configured.` : null;
    const idempotencyKey = input.idempotencyKey || id();
    const requestHash = createHash('sha256').update(JSON.stringify({ conversationId: conversation.id, channel: conversation.channel, to, from, subject, body })).digest('hex');
    const previous = await this.db.selectFrom('messaging_messages').selectAll()
      .where('tenant_id', '=', tenantId).where('idempotency_key', '=', idempotencyKey).executeTakeFirst();
    if (previous) {
      if (previous.request_hash !== requestHash) throw ApiError.conflict('idempotency key belongs to different message content');
      if (previous.status === 'queued') throw ApiError.conflict('message submission is unresolved; reconcile the provider outcome before another attempt');
      return previous;
    }
    if (!provider && conversation.channel !== 'internal') throw new ApiError(501,
      `The ${conversation.channel} transport is unavailable. Connect a supported provider before sending.`, 'not_connected');
    const unresolved = await this.db.selectFrom('messaging_messages').select('id').where('tenant_id', '=', tenantId)
      .where('conversation_id', '=', conversation.id).where('direction', '=', 'out').where('status', '=', 'queued').executeTakeFirst();
    if (unresolved) throw ApiError.conflict('This conversation has an unresolved submission. Reconcile its existing message before sending another reply.');
    if (conversation.assigned_user_id && actor !== 'system' && actor !== conversation.assigned_user_id) {
      throw ApiError.forbidden('This conversation belongs to another team member. Reassign it before replying.');
    }
    const claimed = await this.db.updateTable('messaging_conversations')
      .set({ revision: sql<number>`revision + 1`, updated_at: nowIso() }).where('tenant_id', '=', tenantId)
      .where('id', '=', conversation.id).where('revision', '=', input.expectedRevision ?? conversation.revision ?? 0)
      .where('status', '!=', 'closed').executeTakeFirst();
    if (!claimed.numUpdatedRows) throw ApiError.conflict('Conversation changed or another reply was submitted. Refresh before replying.');

    const now = nowIso();
    const message: MessagingMessageRow = {
      id: id(),
      tenant_id: tenantId,
      conversation_id: conversation.id,
      direction: 'out',
      channel: conversation.channel,
      from_address: from,
      to_address: to,
      subject,
      body,
      status,
      provider_message_id: providerMessageId,
      failed_reason: failedReason,
      recording_url: null,
      transcript: null,
      duration_seconds: null,
      seq: await this.nextMessageSeq(tenantId, conversation.id),
      created_at: now,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
    };
    try {
      await this.db.insertInto('messaging_messages').values(message).execute();
    } catch (error) {
      const duplicate = await this.db.selectFrom('messaging_messages').select('id')
        .where('tenant_id', '=', tenantId).where('idempotency_key', '=', idempotencyKey).executeTakeFirst();
      if (duplicate) throw ApiError.conflict('this message operation is already being processed');
      throw error;
    }
    if (provider) {
      try {
        const result = await provider.send({ tenantId, to, from, subject, body, operationId: message.id });
        status = result.status === 'failed' ? 'failed' : result.status === 'sent' && result.providerMessageId ? 'sent' : 'queued';
        providerMessageId = result.providerMessageId || null;
        failedReason = status !== 'sent' ? result.detail ?? 'provider did not return a confirmed message id' : null;
      } catch {
        // A timeout may have happened after acceptance. Keep the submitted operation unresolved.
        status = 'queued';
        failedReason = 'Provider submission outcome is unresolved. Read the saved provider record before retrying.';
      }
      await this.db.updateTable('messaging_messages').set({ status, provider_message_id: providerMessageId, failed_reason: failedReason })
        .where('tenant_id', '=', tenantId).where('id', '=', message.id).execute();
      Object.assign(message, { status, provider_message_id: providerMessageId, failed_reason: failedReason });
    }
    await this.db
      .updateTable('messaging_conversations')
      .set({ last_message_at: sql<string>`CASE WHEN last_message_at IS NULL OR last_message_at < ${now} THEN ${now} ELSE last_message_at END`,
        updated_at: sql<string>`CASE WHEN updated_at < ${now} THEN ${now} ELSE updated_at END` })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', conversation.id)
      .execute();
    await audit(
      asCoreDb(this.db), tenantId, actor,
      'messaging.message.submitted', 'messaging.message', message.id,
      { conversationId: conversation.id, channel: conversation.channel, to, status },
    );
    if (status === 'sent') {
      await this.events.emit(tenantId, 'messaging.message.sent', {
        messageId: message.id,
        channel: conversation.channel,
        to,
      });
    }
    return message;
  }

  async getOperationMessage(tenantId: string, operationId: string): Promise<MessagingMessageRow | undefined> {
    return this.db.selectFrom('messaging_messages').selectAll()
      .where('tenant_id', '=', tenantId).where('idempotency_key', '=', operationId).executeTakeFirst();
  }

  async listInboundReceipts(tenantId: string, page: Pagination = DEFAULT_PAGE) {
    return this.db.selectFrom('messaging_inbound_receipts').selectAll().where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'desc').orderBy('id').limit(page.limit).offset(page.offset).execute();
  }

  async getMessage(tenantId: string, messageId: string): Promise<MessagingMessageRow> {
    const row = await this.db.selectFrom('messaging_messages').selectAll()
      .where('tenant_id', '=', tenantId).where('id', '=', messageId).executeTakeFirst();
    if (!row) throw ApiError.notFound('message not found');
    return row;
  }

  async reconcileMessage(tenantId: string, actor: string, messageId: string, suppliedProviderId?: string): Promise<MessagingMessageRow> {
    const message = await this.getMessage(tenantId, messageId);
    if (message.direction !== 'out' || !message.to_address) throw ApiError.badRequest('only outbound messages can be reconciled');
    const providerMessageId = message.provider_message_id ?? suppliedProviderId;
    if (!providerMessageId) throw ApiError.conflict('locate the existing provider message before reconciliation; do not resubmit');
    if (message.provider_message_id && suppliedProviderId && suppliedProviderId !== message.provider_message_id) {
      throw ApiError.conflict('provider message id differs from the recorded submission');
    }
    const provider = this.providers[message.channel];
    if (!provider?.reconcile) throw new ApiError(501, 'provider readback is not connected', 'not_connected');
    const result = await provider.reconcile({ tenantId, operationId: message.id, providerMessageId,
      to: message.to_address, from: message.from_address, subject: message.subject, body: message.body });
    if (result.providerMessageId !== providerMessageId || !/^[a-f0-9]{64}$/.test(result.evidenceSha256)) {
      throw ApiError.conflict('provider readback did not match the existing message');
    }
    const status = result.status === 'failed' ? 'failed' : ['accepted', 'delivered'].includes(result.status) ? 'sent' : message.status;
    const reconciledAt = nowIso();
    // The conditional write ensures concurrent readbacks cannot replace a newer decision.
    let update = this.db.updateTable('messaging_messages').set({ status, provider_message_id: providerMessageId,
      delivery_status: result.status, failed_reason: result.detail ?? null, reconciled_at: reconciledAt,
      reconciliation_json: JSON.stringify({ ...result, checkedAt: reconciledAt }) })
      .where('tenant_id', '=', tenantId).where('id', '=', message.id);
    update = message.reconciled_at ? update.where('reconciled_at', '=', message.reconciled_at) : update.where('reconciled_at', 'is', null);
    const changed = await update.executeTakeFirst();
    if (!changed.numUpdatedRows) throw ApiError.conflict('message was reconciled concurrently; read its current state');
    await audit(asCoreDb(this.db), tenantId, actor, 'messaging.message.reconciled', 'messaging.message', message.id,
      { status, deliveryStatus: result.status, providerMessageId, evidenceSha256: result.evidenceSha256 });
    await this.events.emit(tenantId, 'messaging.message.reconciled', { messageId: message.id, status, deliveryStatus: result.status });
    if (status === 'sent' && message.status !== 'sent') await this.events.emit(tenantId, 'messaging.message.sent', {
      messageId: message.id, channel: message.channel, to: message.to_address });
    return this.getMessage(tenantId, message.id);
  }

  /* ------------------------------ templates ------------------------------ */

  async createTemplate(
    tenantId: string,
    actor: string,
    input: { name: string; body: string; channel?: ChannelType; subject?: string },
  ): Promise<MessagingTemplateRow> {
    const name = input.name.trim();
    if (name === '') throw ApiError.badRequest('template name is required');
    const existing = await this.db
      .selectFrom('messaging_templates')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('name', '=', name)
      .executeTakeFirst();
    if (existing) throw ApiError.conflict(`template "${name}" already exists`);
    const now = nowIso();
    const row: MessagingTemplateRow = {
      id: id(),
      tenant_id: tenantId,
      name,
      channel: input.channel ?? null,
      subject: input.subject ?? null,
      body: input.body,
      created_at: now,
      updated_at: now,
    };
    await this.db.insertInto('messaging_templates').values(row).execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'messaging.template.created', 'messaging.template', row.id, {
      name,
    });
    return row;
  }

  async listTemplates(tenantId: string, page: Pagination = DEFAULT_PAGE): Promise<MessagingTemplateRow[]> {
    return this.db
      .selectFrom('messaging_templates')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('name')
      .orderBy('id')
      .limit(page.limit)
      .offset(page.offset)
      .execute();
  }

  async getTemplate(tenantId: string, templateId: string): Promise<MessagingTemplateRow> {
    const row = await this.db
      .selectFrom('messaging_templates')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', templateId)
      .executeTakeFirst();
    if (!row) throw ApiError.notFound(`template not found: ${templateId}`);
    return row;
  }

  async updateTemplate(
    tenantId: string,
    actor: string,
    templateId: string,
    patch: { name?: string; body?: string; channel?: ChannelType | null; subject?: string | null },
  ): Promise<MessagingTemplateRow> {
    const set: Partial<
      Pick<MessagingTemplateRow, 'name' | 'body' | 'channel' | 'subject' | 'updated_at'>
    > = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name === '') throw ApiError.badRequest('template name cannot be blank');
      const clash = await this.db
        .selectFrom('messaging_templates')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('name', '=', name)
        .where('id', '!=', templateId)
        .executeTakeFirst();
      if (clash) throw ApiError.conflict(`template "${name}" already exists`);
      set.name = name;
    }
    if (patch.body !== undefined) set.body = patch.body;
    if (patch.channel !== undefined) set.channel = patch.channel;
    if (patch.subject !== undefined) set.subject = patch.subject;
    if (Object.keys(set).length > 0) {
      set.updated_at = nowIso();
      const result = await this.db
        .updateTable('messaging_templates')
        .set(set)
        .where('tenant_id', '=', tenantId)
        .where('id', '=', templateId)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) throw ApiError.notFound(`template not found: ${templateId}`);
      await audit(asCoreDb(this.db), tenantId, actor, 'messaging.template.updated', 'messaging.template', templateId, patch);
    }
    return this.getTemplate(tenantId, templateId);
  }

  async deleteTemplate(tenantId: string, actor: string, templateId: string): Promise<void> {
    const result = await this.db
      .deleteFrom('messaging_templates')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', templateId)
      .executeTakeFirst();
    if (result.numDeletedRows === 0n) throw ApiError.notFound(`template not found: ${templateId}`);
    await audit(asCoreDb(this.db), tenantId, actor, 'messaging.template.deleted', 'messaging.template', templateId);
  }

  /* ------------------------------- search -------------------------------- */

  /**
   * LIKE-based, case-insensitive search across conversation subjects and
   * message bodies/subjects/addresses. Tenant-scoped, wildcard-escaped.
   */
  async search(tenantId: string, term: string, page: Pagination = DEFAULT_PAGE): Promise<SearchResult> {
    const q = term.trim();
    if (q === '') throw ApiError.badRequest('search term "q" is required');
    const pattern = `%${escapeLike(q.toLowerCase())}%`;

    const conversations = await this.db
      .selectFrom('messaging_conversations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where(sql<boolean>`lower(subject) like ${pattern} escape '\\'`)
      .orderBy('last_message_at', 'desc')
      .orderBy('id')
      .limit(page.limit)
      .offset(page.offset)
      .execute();

    const messages = await this.db
      .selectFrom('messaging_messages')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where((eb) =>
        eb.or([
          sql<boolean>`lower(body) like ${pattern} escape '\\'`,
          sql<boolean>`lower(coalesce(subject, '')) like ${pattern} escape '\\'`,
          sql<boolean>`lower(coalesce(from_address, '')) like ${pattern} escape '\\'`,
          sql<boolean>`lower(coalesce(to_address, '')) like ${pattern} escape '\\'`,
        ]),
      )
      .orderBy('seq', 'desc')
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(page.limit)
      .offset(page.offset)
      .execute();

    return { conversations, messages };
  }

  /* ------------------------------ timeline ------------------------------- */

  /**
   * Write a CRM timeline entry for a linked conversation via the injected
   * TimelineWriter contract. No-op when unlinked or no writer is wired;
   * writer failures are swallowed (timeline is best-effort).
   */
  private async writeTimeline(
    conversation: MessagingConversationRow,
    entry: { kind: string; summary: string; refId: string },
  ): Promise<void> {
    if (!this.timeline) return;
    const target = conversation.customer_id
      ? { entityType: 'crm.customer', entityId: conversation.customer_id }
      : conversation.contact_id
        ? { entityType: 'crm.contact', entityId: conversation.contact_id }
        : null;
    if (!target) return;
    try {
      await this.timeline.recordTimelineEvent({
        tenantId: conversation.tenant_id,
        entityType: target.entityType,
        entityId: target.entityId,
        kind: entry.kind,
        summary: entry.summary,
        occurredAt: nowIso(),
        refId: entry.refId,
      });
    } catch {
      // best-effort: a timeline failure must never break the messaging write
    }
  }
}

/* ------------------------------------------------------------------ *
 * SendMessageContract implementation (core contract, wired by apps/api)
 * ------------------------------------------------------------------ */

/**
 * Messaging's implementation of core's SendMessageContract. Each call starts
 * a new conversation on the mapped channel ('portal' maps to 'internal') and
 * sends one outbound message through the channel provider. If
 * relatedEntityType is "crm.customer"/"crm.contact" the conversation is
 * linked to that entity by id.
 */
export function createMessagingSendContract(
  db: Kysely<MessagingDatabase>,
  events: EventBus,
  options: MessagingServiceOptions = {},
): DurableSendMessageContract {
  const service = new MessagingService(db, events, options);
  return {
    async sendMessage(input: DurableSendMessageInput): Promise<{ id: string }> {
      const channel: ChannelType = input.channel === 'portal' ? 'internal' : input.channel;
      const operationId = input.idempotencyKey ?? id();
      const requestHash = createHash('sha256').update(JSON.stringify({ channel, to: input.to, subject: input.subject ?? null,
        body: input.body, relatedEntityType: input.relatedEntityType ?? null, relatedEntityId: input.relatedEntityId ?? null })).digest('hex');
      const previous = await db.selectFrom('messaging_operations').selectAll()
        .where('tenant_id', '=', input.tenantId).where('id', '=', operationId).executeTakeFirst();
      let conversationId = previous?.conversation_id;
      if (previous) {
        if (previous.request_hash !== requestHash) throw ApiError.conflict('message operation belongs to different content');
        if (!conversationId) throw ApiError.conflict('message operation is unresolved; inspect the recorded operation');
      } else {
        try {
          await db.insertInto('messaging_operations').values({ id: operationId, tenant_id: input.tenantId,
            request_hash: requestHash, conversation_id: null, created_at: nowIso() }).execute();
        } catch (error) {
          const raced = await db.selectFrom('messaging_operations').select('id')
            .where('tenant_id', '=', input.tenantId).where('id', '=', operationId).executeTakeFirst();
          if (raced) throw ApiError.conflict('message operation is already being processed');
          throw error;
        }
        const conversation = await service.createConversation(input.tenantId, 'system', {
        subject: input.subject?.trim() || `Message to ${input.to}`,
        channel,
        customerId: input.relatedEntityType === 'crm.customer' ? input.relatedEntityId : undefined,
        contactId: input.relatedEntityType === 'crm.contact' ? input.relatedEntityId : undefined,
        participants: [{ kind: 'external', address: input.to }],
        });
        conversationId = conversation.id;
        await db.updateTable('messaging_operations').set({ conversation_id: conversationId })
          .where('tenant_id', '=', input.tenantId).where('id', '=', operationId).execute();
      }
      const message = await service.sendOutbound(input.tenantId, 'system', {
        conversationId: conversationId!,
        idempotencyKey: operationId,
        to: input.to,
        subject: input.subject,
        body: input.body,
      });
      if (message.status !== 'sent') throw ApiError.conflict(message.failed_reason ?? 'message delivery is unresolved');
      return { id: message.id };
    },
  };
}

/** Backward-compatible extension; the shared core contract stays unchanged. */
export interface DurableSendMessageInput extends SendMessageInput { idempotencyKey?: string }
export interface DurableSendMessageContract extends SendMessageContract {
  sendMessage(input: DurableSendMessageInput): Promise<{ id: string }>;
}

function toChannelDto(row: MessagingChannelRow): ChannelDto {
  return { ...row, is_active: row.is_active === 1 };
}
