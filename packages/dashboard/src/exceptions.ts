import { sql, type Kysely } from '@blacklabel/db';
import type { SelectQueryBuilder } from 'kysely';
import { ApiError, nowIso, type Pagination } from '@blacklabel/core';
import type { DashboardDatabase } from './schema';

/** Minimum read contracts; dashboard never writes to these source tables. */
export interface ExceptionDatabase extends DashboardDatabase {
  billing_invoices: DashboardDatabase['billing_invoices'] & {
    number: string; paid_cents: number; due_at: string | null; updated_at: string;
    source_entity_type: string | null; source_entity_id: string | null;
  };
  quoting_quotes: DashboardDatabase['quoting_quotes'] & { title: string; updated_at: string };
  crm_jobs: DashboardDatabase['crm_jobs'] & { title: string; updated_at: string };
  quoting_conversions: { id: string; tenant_id: string; job_id: string; invoice_id: string; created_at: string };
  workflows_executions: {
    id: string; tenant_id: string; workflow_id: string; status: string;
    started_at: string; finished_at: string | null; next_retry_at: string | null;
  };
  messaging_conversations: {
    id: string; tenant_id: string; subject: string; status: string;
    assigned_user_id: string | null; updated_at: string; created_at: string;
  };
  messaging_messages: {
    id: string; tenant_id: string; conversation_id: string; direction: string;
    status: string; seq: number | null; created_at: string;
  };
  portal_employee_assignments: {
    id: string; tenant_id: string; title: string; status: string;
    scheduled_at: string | null; updated_at: string;
  };
  portal_employee_checklists: { id: string; tenant_id: string; assignment_id: string };
  portal_employee_checklist_items: {
    id: string; tenant_id: string; checklist_id: string; checked: number;
    checked_at: string | null; created_at: string;
  };
  portal_employee_exceptions: { id: string; tenant_id: string; assignment_id: string; checklist_item_id: string | null; status: string; resolution_kind: string | null };
  portal_employee_time_entries: DashboardDatabase['portal_employee_time_entries'] & { assignment_id: string | null; review_status: string };
}

export const EXCEPTION_KINDS = [
  'overdue_balance', 'stalled_quote', 'completed_job_unlinked',
  'workflow_failure', 'inbox_attention', 'crew_attention',
] as const;
export type ExceptionKind = typeof EXCEPTION_KINDS[number];

const definitions: Record<ExceptionKind, { label: string; reason: string; nextAction: string; moduleHref: string; apiPrefix: string }> = {
  overdue_balance: { label: 'Overdue balances', reason: 'A shared invoice is past its due date and has a positive recorded balance.', nextAction: 'Review the invoice and payment receipts before collecting or reminding.', moduleHref: '#/billing', apiPrefix: 'billing/invoices' },
  stalled_quote: { label: 'Quotes awaiting a decision', reason: 'A sent or viewed quote has no recorded decision and has been unchanged for at least seven days.', nextAction: 'Review the quote and customer history before following up.', moduleHref: '#/quoting/quotes', apiPrefix: 'quoting/quotes' },
  completed_job_unlinked: { label: 'Completed jobs without a linked invoice', reason: 'A completed job has no non-void invoice linked by job provenance or its saved quote conversion.', nextAction: 'Check the job and existing invoices, then create or link the appropriate invoice.', moduleHref: '#/crm/jobs', apiPrefix: 'crm/jobs' },
  workflow_failure: { label: 'Workflow failures and retries', reason: 'A saved workflow execution is failed or still retrying.', nextAction: 'Inspect the execution receipts and connection state before processing a retry.', moduleHref: '#/workflows', apiPrefix: 'workflows/executions' },
  inbox_attention: { label: 'Inbox needing attention', reason: 'An open or pending conversation has no owner, or has an inbound message without a later recorded sent reply.', nextAction: 'Assign an owner and inspect the conversation before responding.', moduleHref: '#/messaging', apiPrefix: 'messaging/conversations' },
  crew_attention: { label: 'Crew work needing review', reason: 'Work is past schedule, has a reported exception or time awaiting approval, or was completed with unwaived checklist gaps.', nextAction: 'Review the assignment closeout, exception decisions, and recorded time with the responsible team member.', moduleHref: '#/portal-employee', apiPrefix: 'portal-employee/assignments' },
};

interface ExceptionReadRow {
  kind: ExceptionKind; entity_id: string; title: string; status: string;
  source_updated_at: string | null; attention_since: string | null; balance_cents: number | null;
}
type SourceQuery = SelectQueryBuilder<ExceptionDatabase, keyof ExceptionDatabase, ExceptionReadRow>;
const sourceQuery = (query: unknown): SourceQuery => query as SourceQuery;

function queries(db: Kysely<ExceptionDatabase>, tenantId: string, sampledAt: string): Record<ExceptionKind, SourceQuery> {
  const quoteCutoff = new Date(Date.parse(sampledAt) - 7 * 86400_000).toISOString();
  const crewCutoff = new Date(Date.parse(sampledAt) - 86400_000).toISOString();
  const common = (kind: ExceptionKind) => [sql<ExceptionKind>`${kind}`.as('kind'), sql<number | null>`null`.as('balance_cents')];
  return {
    overdue_balance: sourceQuery(db.selectFrom('billing_invoices as i')
      .select(['i.id as entity_id', 'i.number as title', 'i.status', 'i.updated_at as source_updated_at', 'i.due_at as attention_since'])
      .select([sql<ExceptionKind>`${'overdue_balance'}`.as('kind'), sql<number>`i.total_cents - i.paid_cents`.as('balance_cents')])
      .where('i.tenant_id', '=', tenantId).where('i.status', 'in', ['sent', 'partial', 'overdue'])
      .where('i.due_at', '<', sampledAt).whereRef('i.total_cents', '>', 'i.paid_cents')),
    stalled_quote: sourceQuery(db.selectFrom('quoting_quotes as q')
      .select(['q.id as entity_id', 'q.title', 'q.status', 'q.updated_at as source_updated_at', 'q.updated_at as attention_since'])
      .select(common('stalled_quote')).where('q.tenant_id', '=', tenantId)
      .where('q.status', 'in', ['sent', 'viewed']).where('q.updated_at', '<=', quoteCutoff)),
    completed_job_unlinked: sourceQuery(db.selectFrom('crm_jobs as j')
      .select(['j.id as entity_id', 'j.title', 'j.status', 'j.updated_at as source_updated_at', 'j.updated_at as attention_since'])
      .select(common('completed_job_unlinked')).where('j.tenant_id', '=', tenantId).where('j.status', '=', 'completed')
      .where(eb => eb.not(eb.exists(eb.selectFrom('billing_invoices as i').select('i.id')
        .where('i.tenant_id', '=', tenantId).where('i.status', '!=', 'void')
        .where('i.source_entity_type', '=', 'crm.job').whereRef('i.source_entity_id', '=', 'j.id'))))
      .where(eb => eb.not(eb.exists(eb.selectFrom('quoting_conversions as c')
        .innerJoin('billing_invoices as i', 'i.id', 'c.invoice_id').select('c.id')
        .where('c.tenant_id', '=', tenantId).where('i.tenant_id', '=', tenantId)
        .where('i.status', '!=', 'void').whereRef('c.job_id', '=', 'j.id'))))),
    workflow_failure: sourceQuery(db.selectFrom('workflows_executions as e')
      .select(['e.id as entity_id', 'e.workflow_id as title', 'e.status', 'e.started_at as attention_since'])
      .select([...common('workflow_failure'), sql<string>`coalesce(e.finished_at, e.started_at)`.as('source_updated_at')])
      .where('e.tenant_id', '=', tenantId).where('e.status', 'in', ['failed', 'retrying'])),
    inbox_attention: sourceQuery(db.selectFrom('messaging_conversations as c')
      .select(['c.id as entity_id', 'c.subject as title', 'c.status', 'c.updated_at as source_updated_at', 'c.created_at as attention_since'])
      .select(common('inbox_attention')).where('c.tenant_id', '=', tenantId).where('c.status', 'in', ['open', 'pending'])
      .where(eb => eb.or([
        eb('c.assigned_user_id', 'is', null),
        eb.exists(eb.selectFrom('messaging_messages as incoming').select('incoming.id')
          .where('incoming.tenant_id', '=', tenantId).whereRef('incoming.conversation_id', '=', 'c.id').where('incoming.direction', '=', 'in')
          .where(inner => inner.not(inner.exists(inner.selectFrom('messaging_messages as reply').select('reply.id')
            .where('reply.tenant_id', '=', tenantId).whereRef('reply.conversation_id', '=', 'c.id')
            .where('reply.direction', '=', 'out').where('reply.status', '=', 'sent')
            .where(order => order.or([
              order.and([order('reply.seq', 'is not', null), order('incoming.seq', 'is not', null), order('reply.seq', '>', order.ref('incoming.seq'))]),
              // Legacy rows without sequence counters: same-time replies make the order uncertain,
              // so do not falsely assert that the incoming message is unanswered.
              order.and([order.or([order('reply.seq', 'is', null), order('incoming.seq', 'is', null)]), order('reply.created_at', '>=', order.ref('incoming.created_at'))]),
            ])))))),
      ]))),
    crew_attention: sourceQuery(db.selectFrom('portal_employee_assignments as a')
      .select(['a.id as entity_id', 'a.title', 'a.status', 'a.updated_at as source_updated_at'])
      .select([...common('crew_attention'), sql<string | null>`coalesce(a.scheduled_at, a.updated_at)`.as('attention_since')])
      .where('a.tenant_id', '=', tenantId).where('a.status', '!=', 'canceled')
      .where(eb => eb.or([
        eb.and([eb('a.status', 'in', ['assigned', 'in_progress']), eb('a.scheduled_at', '<=', crewCutoff)]),
        eb.exists(eb.selectFrom('portal_employee_exceptions as issue').select('issue.id')
          .where('issue.tenant_id', '=', tenantId).whereRef('issue.assignment_id', '=', 'a.id').where('issue.status', '=', 'open')),
        eb.exists(eb.selectFrom('portal_employee_time_entries as time').select('time.id')
          .where('time.tenant_id', '=', tenantId).whereRef('time.assignment_id', '=', 'a.id')
          .where('time.clock_out_at', 'is not', null).where('time.review_status', '!=', 'approved')),
        eb.and([eb('a.status', '=', 'completed'), eb.exists(eb.selectFrom('portal_employee_checklists as checklist')
          .innerJoin('portal_employee_checklist_items as item', 'item.checklist_id', 'checklist.id').select('item.id')
          .where('checklist.tenant_id', '=', tenantId).where('item.tenant_id', '=', tenantId)
          .whereRef('checklist.assignment_id', '=', 'a.id').where('item.checked', '=', 0)
          .where(inner=>inner.not(inner.exists(inner.selectFrom('portal_employee_exceptions as waiver').select('waiver.id')
            .where('waiver.tenant_id','=',tenantId).whereRef('waiver.assignment_id','=','a.id').whereRef('waiver.checklist_item_id','=','item.id')
            .where('waiver.status','=','resolved').where('waiver.resolution_kind','=','waived')))))]),
      ]))),
  };
}

export interface OwnerException {
  id: string; kind: ExceptionKind; title: string; status: string; reason: string;
  nextAction: string; source: { entityId: string; api: string; href: string; updatedAt: string | null };
  attentionSince: string | null; balanceCents: number | null;
}
export interface ExceptionSourceStatus { kind: ExceptionKind; label: string; available: boolean; count: number | null; issue: string | null }
export interface OwnerExceptionQueue {
  items: OwnerException[]; sources: ExceptionSourceStatus[]; total: number; limit: number; offset: number; hasMore: boolean;
  completeness: 'complete' | 'partial'; sampledAt: string; staleAt: string;
  freshnessScope: 'local_database'; externalFreshness: 'not_verified';
}
const MISSING_SOURCE = /no such table|no such column|does not exist/i;
const isoOrNull = (value: string | null): string | null => value && Number.isFinite(Date.parse(value)) ? value : null;

/** Read-only, exact SQL pagination across all available sources; no capped source scan. */
export async function ownerExceptionQueue<DB extends DashboardDatabase>(
  db: Kysely<DB>, tenantId: string, page: Pagination = { limit: 25, offset: 0 }, kind?: string,
): Promise<OwnerExceptionQueue> {
  if (kind && kind !== 'all' && !EXCEPTION_KINDS.includes(kind as ExceptionKind)) throw ApiError.badRequest('unknown exception kind');
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100 || !Number.isSafeInteger(page.offset) || page.offset < 0) {
    throw ApiError.badRequest('exception pagination must use limit 1–100 and a nonnegative integer offset');
  }
  const sampledAt = nowIso();
  const readDb = db as unknown as Kysely<ExceptionDatabase>;
  const candidates = queries(readDb, tenantId, sampledAt);
  const sources: ExceptionSourceStatus[] = [];
  const available: ExceptionKind[] = [];
  // Probe and count each full condition, including every linkage table. Missing provenance
  // must suppress that category instead of classifying all completed jobs as unbilled.
  for (const key of EXCEPTION_KINDS) {
    try {
      await readDb.selectFrom(candidates[key].as('candidate')).selectAll().limit(0).execute();
      sources.push({ kind: key, label: definitions[key].label, available: true, count: null, issue: null });
      if (!kind || kind === 'all' || kind === key) available.push(key);
    } catch (error) {
      if (!(error instanceof Error) || !MISSING_SOURCE.test(error.message)) throw error;
      sources.push({ kind: key, label: definitions[key].label, available: false, count: null, issue: 'Required local source tables or columns are unavailable; this category was not checked.' });
    }
  }
  const result = await readDb.transaction().execute(async trx => {
    const snapshotQueries = queries(trx, tenantId, sampledAt);
    for (const source of sources.filter(source => source.available)) {
      const count = await trx.selectFrom(snapshotQueries[source.kind].as('candidate'))
        .select(eb => eb.fn.count<number>('candidate.entity_id').as('count')).executeTakeFirstOrThrow();
      source.count = Number(count.count);
    }
    let combined: SourceQuery | undefined;
    for (const key of available) {
      // UNION columns are positional even when source aliases match.
      const normalized = sourceQuery(trx.selectFrom(snapshotQueries[key].as('source'))
        .select(['source.kind', 'source.entity_id', 'source.title', 'source.status', 'source.source_updated_at', 'source.attention_since', 'source.balance_cents']));
      combined = combined ? combined.unionAll(normalized) : normalized;
    }
    if (!combined) return { total: 0, rows: [] as ExceptionReadRow[] };
    const rowsQuery = trx.selectFrom(combined.as('exception'));
    const count = await rowsQuery.select(eb => eb.fn.count<number>('exception.entity_id').as('count')).executeTakeFirstOrThrow();
    const rows = await rowsQuery.selectAll().orderBy('attention_since', 'asc').orderBy('kind').orderBy('entity_id').limit(page.limit).offset(page.offset).execute();
    return { total: Number(count.count), rows };
  });
  return {
    items: result.rows.map(row => ({
      id: `${row.kind}:${row.entity_id}`, kind: row.kind, title: row.title, status: row.status,
      reason: definitions[row.kind].reason, nextAction: definitions[row.kind].nextAction,
      source: { entityId: row.entity_id, api: `${definitions[row.kind].apiPrefix}/${encodeURIComponent(row.entity_id)}`, href: definitions[row.kind].moduleHref, updatedAt: isoOrNull(row.source_updated_at) },
      attentionSince: isoOrNull(row.attention_since), balanceCents: row.balance_cents === null ? null : Number(row.balance_cents),
    })),
    sources, total: result.total, ...page, hasMore: page.offset + result.rows.length < result.total,
    completeness: sources.every(source => source.available) ? 'complete' : 'partial',
    sampledAt, staleAt: new Date(Date.parse(sampledAt) + 5 * 60_000).toISOString(), freshnessScope: 'local_database', externalFreshness: 'not_verified',
  };
}
