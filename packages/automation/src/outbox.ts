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
import { DateTime } from 'luxon';
import { backoffSeconds } from './backoff';
import type { AutomationDatabase, AutomationOutboxRow, OutboxStatus } from './schema';

type Db = Kysely<AutomationDatabase>;

/** Statuses a dispatcher may claim for delivery. */
const CLAIMABLE: OutboxStatus[] = ['pending', 'failed'];

export interface EnqueueInput {
  kind: string;
  /** Any JSON-serializable effect payload. */
  payload: unknown;
  /** UNIQUE per tenant. A duplicate returns the existing row (never a 2nd row). */
  idempotencyKey: string;
  /** Default 8. */
  maxAttempts?: number;
}

export interface EnqueueResult {
  row: AutomationOutboxRow;
  /** False when an existing row was returned for a duplicate idempotency key. */
  created: boolean;
}

/**
 * Transactional outbox. External side effects are NEVER fired inline: they are
 * staged here with an idempotency key, then a dispatcher drains due rows with
 * retry/backoff and dead-lettering. Every method is tenant-scoped.
 *
 * `events` is optional so the outbox can be used in isolation; when present,
 * internal `automation.outbox.*` events are emitted after the write.
 */
export class OutboxService {
  constructor(
    private readonly db: Db,
    private readonly events?: EventBus,
  ) {}

  /** Enqueue an effect. Idempotent on (tenant, idempotencyKey) via check-then-insert. */
  async enqueue(
    tenantId: string,
    input: EnqueueInput,
    actor = 'system',
  ): Promise<EnqueueResult> {
    if (!input.kind.trim()) throw ApiError.badRequest('outbox kind is required');
    if (!input.idempotencyKey.trim()) throw ApiError.badRequest('idempotencyKey is required');
    const maxAttempts = input.maxAttempts ?? 8;
    if (maxAttempts < 1) throw ApiError.badRequest('maxAttempts must be >= 1');

    const created = await this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('automation_outbox')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (existing) return { row: existing, created: false };

      const now = nowIso();
      const row: AutomationOutboxRow = {
        id: id(),
        tenant_id: tenantId,
        idempotency_key: input.idempotencyKey,
        kind: input.kind,
        payload: JSON.stringify(input.payload ?? null),
        status: 'pending',
        attempts: 0,
        max_attempts: maxAttempts,
        next_attempt_at: now,
        last_error: null,
        created_at: now,
        updated_at: now,
        delivered_at: null,
      };
      await trx.insertInto('automation_outbox').values(row).execute();
      await audit(asCoreDb(trx), tenantId, actor, 'automation.outbox.enqueued', 'automation.outbox', row.id, {
        kind: row.kind,
        idempotency_key: row.idempotency_key,
      });
      return { row, created: true };
    });

    if (created.created && this.events) {
      await this.events.emit(tenantId, 'automation.outbox.enqueued', {
        v: 1,
        outboxId: created.row.id,
        kind: created.row.kind,
      });
    }
    return created;
  }

  /** Fetch a single row (tenant-scoped). */
  async get(tenantId: string, outboxId: string): Promise<AutomationOutboxRow | undefined> {
    return this.db
      .selectFrom('automation_outbox')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', outboxId)
      .executeTakeFirst();
  }

  /**
   * Claim up to `limit` rows that are due (status pending|failed and
   * next_attempt_at <= now), marking them 'delivering' so a concurrent drain
   * can't double-claim. Returns the claimed rows (as delivering).
   */
  async claimDue(tenantId: string, now: string, limit: number): Promise<AutomationOutboxRow[]> {
    const due = await this.db
      .selectFrom('automation_outbox')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('status', 'in', CLAIMABLE)
      .where('next_attempt_at', '<=', now)
      .orderBy('next_attempt_at')
      .orderBy('id')
      .limit(limit)
      .execute();

    const claimed: AutomationOutboxRow[] = [];
    for (const row of due) {
      const res = await this.db
        .updateTable('automation_outbox')
        .set({ status: 'delivering', updated_at: nowIso() })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', row.id)
        .where('status', '=', row.status) // guard against a racing claim
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) > 0) {
        claimed.push({ ...row, status: 'delivering' });
      }
    }
    return claimed;
  }

  /** Mark a claimed row delivered. */
  async markDelivered(tenantId: string, outboxId: string): Promise<AutomationOutboxRow> {
    const now = nowIso();
    await this.db
      .updateTable('automation_outbox')
      .set({ status: 'delivered', delivered_at: now, updated_at: now, last_error: null })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', outboxId)
      .execute();
    return this.require(tenantId, outboxId);
  }

  /**
   * Record a failed attempt: increment attempts, store the error, and either
   * reschedule with backoff (status 'failed') or, at max_attempts, dead-letter
   * (status 'dead'). Deterministic backoff (see ./backoff).
   */
  async markFailed(
    tenantId: string,
    outboxId: string,
    error: string,
    actor = 'system',
  ): Promise<AutomationOutboxRow> {
    const row = await this.require(tenantId, outboxId);
    const attempts = row.attempts + 1;
    const now = nowIso();
    const dead = attempts >= row.max_attempts;
    const nextAttemptAt = dead
      ? row.next_attempt_at
      : DateTime.fromISO(now, { zone: 'utc' })
          .plus({ seconds: backoffSeconds(attempts) })
          .toUTC()
          .toISO()!;

    await this.db
      .updateTable('automation_outbox')
      .set({
        attempts,
        status: dead ? 'dead' : 'failed',
        last_error: error.slice(0, 2000),
        next_attempt_at: nextAttemptAt,
        updated_at: now,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', outboxId)
      .execute();

    if (dead) {
      await audit(asCoreDb(this.db), tenantId, actor, 'automation.outbox.dead', 'automation.outbox', outboxId, {
        attempts,
        last_error: error.slice(0, 2000),
      });
      if (this.events) {
        await this.events.emit(tenantId, 'automation.outbox.dead', {
          v: 1,
          outboxId,
          attempts,
        });
      }
    }
    return this.require(tenantId, outboxId);
  }

  /** List rows, optionally filtered by status, newest first. */
  async list(
    tenantId: string,
    opts: { status?: OutboxStatus } = {},
    page: Pagination = { limit: 50, offset: 0 },
  ): Promise<AutomationOutboxRow[]> {
    let q = this.db
      .selectFrom('automation_outbox')
      .selectAll()
      .where('tenant_id', '=', tenantId);
    if (opts.status) q = q.where('status', '=', opts.status);
    return q
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(page.limit)
      .offset(page.offset)
      .execute();
  }

  /** Dead-letter list. */
  async listDead(
    tenantId: string,
    page: Pagination = { limit: 50, offset: 0 },
  ): Promise<AutomationOutboxRow[]> {
    return this.list(tenantId, { status: 'dead' }, page);
  }

  /**
   * Replay a dead (or failed) row: reset to pending, attempts back to 0, due
   * now. The prior attempt count and error are preserved in an audit entry.
   */
  async replay(tenantId: string, outboxId: string, actor = 'system'): Promise<AutomationOutboxRow> {
    const row = await this.require(tenantId, outboxId);
    if (row.status !== 'dead' && row.status !== 'failed' && row.status !== 'canceled') {
      throw ApiError.badRequest(`cannot replay outbox row in status "${row.status}"`);
    }
    const now = nowIso();
    await this.db
      .updateTable('automation_outbox')
      .set({ status: 'pending', attempts: 0, next_attempt_at: now, last_error: null, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', outboxId)
      .execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'automation.outbox.replayed', 'automation.outbox', outboxId, {
      prior_attempts: row.attempts,
      prior_status: row.status,
      prior_error: row.last_error,
    });
    return this.require(tenantId, outboxId);
  }

  /** Cancel a row so it will never be delivered. */
  async cancel(tenantId: string, outboxId: string, actor = 'system'): Promise<AutomationOutboxRow> {
    const row = await this.require(tenantId, outboxId);
    if (row.status === 'delivered') {
      throw ApiError.badRequest('cannot cancel an already-delivered row');
    }
    const now = nowIso();
    await this.db
      .updateTable('automation_outbox')
      .set({ status: 'canceled', updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', outboxId)
      .execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'automation.outbox.canceled', 'automation.outbox', outboxId, {
      prior_status: row.status,
    });
    return this.require(tenantId, outboxId);
  }

  private async require(tenantId: string, outboxId: string): Promise<AutomationOutboxRow> {
    const row = await this.get(tenantId, outboxId);
    if (!row) throw ApiError.notFound(`outbox row "${outboxId}" not found`);
    return row;
  }
}
