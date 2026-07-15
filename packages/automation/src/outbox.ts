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

/** Long enough for ordinary handlers; runOnce renews while work is active. */
export const DEFAULT_OUTBOX_LEASE_SECONDS = 60;

export interface OutboxLease {
  owner: string;
  token: number;
  expiresAt: string;
}

export interface ClaimDueOptions {
  /** Stable identity for one dispatcher process/instance. */
  leaseOwner?: string;
  /** Lease duration. A live dispatcher renews before this deadline. */
  leaseSeconds?: number;
}

export interface ClaimDueResult {
  claimed: AutomationOutboxRow[];
  /** Expired deliveries that exhausted max_attempts during this claim pass. */
  recoveredDead: number;
}

/** Raised when an expired/reclaimed worker tries to mutate a delivery. */
export class OutboxLeaseLostError extends Error {
  constructor(outboxId: string) {
    super(`delivery lease lost for outbox row "${outboxId}"`);
    this.name = 'OutboxLeaseLostError';
  }
}

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
        lease_owner: null,
        lease_expires_at: null,
        lease_heartbeat_at: null,
        lease_token: 0,
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
  async claimDue(
    tenantId: string,
    now: string,
    limit: number,
    options: ClaimDueOptions = {},
  ): Promise<AutomationOutboxRow[]> {
    return (await this.claimDueWithResult(tenantId, now, limit, options)).claimed;
  }

  /** Claim due work and expose crash-recovery dead letters to dispatch metrics. */
  async claimDueWithResult(
    tenantId: string,
    now: string,
    limit: number,
    options: ClaimDueOptions = {},
  ): Promise<ClaimDueResult> {
    if (!Number.isInteger(limit) || limit < 1) throw ApiError.badRequest('claim limit must be >= 1');
    const at = validUtc(now, 'claim time');
    const owner = options.leaseOwner?.trim() || `dispatcher:${id()}`;
    const leaseSeconds = validLeaseSeconds(options.leaseSeconds);
    const expiresAt = at.plus({ seconds: leaseSeconds }).toISO()!;

    const outcome = await this.db.transaction().execute(async (trx) => {
      const due = await trx
        .selectFrom('automation_outbox')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where((eb) =>
          eb.or([
            eb.and([
              eb('status', 'in', CLAIMABLE),
              eb('next_attempt_at', '<=', at.toISO()!),
            ]),
            eb.and([
              eb('status', '=', 'delivering'),
              eb.or([
                // Rows left in delivering before migration 0005 had no lease.
                eb('lease_expires_at', 'is', null),
                eb('lease_expires_at', '<=', at.toISO()!),
              ]),
            ]),
          ]),
        )
        .orderBy('next_attempt_at')
        .orderBy('id')
        .limit(limit)
        .execute();

      const claimed: AutomationOutboxRow[] = [];
      const dead: AutomationOutboxRow[] = [];
      for (const row of due) {
        const reclaiming = row.status === 'delivering';
        const attempts = row.attempts + (reclaiming ? 1 : 0);
        const leaseError = reclaiming
          ? `delivery lease expired for owner "${row.lease_owner ?? 'unknown'}"`
          : row.last_error;

        // A crashed worker consumes an attempt. Repeated worker death follows
        // the same max-attempt/dead-letter boundary as handler failures.
        if (reclaiming && attempts >= row.max_attempts) {
          let deadUpdate = trx
            .updateTable('automation_outbox')
            .set({
              status: 'dead',
              attempts,
              last_error: leaseError,
              lease_owner: null,
              lease_expires_at: null,
              lease_heartbeat_at: null,
              updated_at: at.toISO()!,
            })
            .where('tenant_id', '=', tenantId)
            .where('id', '=', row.id)
            .where('status', '=', 'delivering')
            .where('lease_token', '=', row.lease_token);
          deadUpdate = row.lease_expires_at === null
            ? deadUpdate.where('lease_expires_at', 'is', null)
            : deadUpdate.where('lease_expires_at', '<=', at.toISO()!);
          const res = await deadUpdate.executeTakeFirst();
          if (Number(res.numUpdatedRows) > 0) {
            dead.push({
              ...row,
              status: 'dead',
              attempts,
              last_error: leaseError,
              lease_owner: null,
              lease_expires_at: null,
              lease_heartbeat_at: null,
              updated_at: at.toISO()!,
            });
          }
          continue;
        }

        const token = row.lease_token + 1;
        let update = trx
          .updateTable('automation_outbox')
          .set({
            status: 'delivering',
            attempts,
            last_error: leaseError,
            lease_owner: owner,
            lease_expires_at: expiresAt,
            lease_heartbeat_at: at.toISO()!,
            lease_token: token,
            updated_at: at.toISO()!,
          })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', row.id);
        if (reclaiming) {
          update = update
            .where('status', '=', 'delivering')
            .where('lease_token', '=', row.lease_token);
          update = row.lease_expires_at === null
            ? update.where('lease_expires_at', 'is', null)
            : update.where('lease_expires_at', '<=', at.toISO()!);
        } else {
          update = update
            .where('status', '=', row.status)
            .where('next_attempt_at', '<=', at.toISO()!);
        }
        const res = await update.executeTakeFirst();
        if (Number(res.numUpdatedRows) > 0) {
          claimed.push({
            ...row,
            status: 'delivering',
            attempts,
            last_error: leaseError,
            lease_owner: owner,
            lease_expires_at: expiresAt,
            lease_heartbeat_at: at.toISO()!,
            lease_token: token,
            updated_at: at.toISO()!,
          });
        }
      }
      return { claimed, dead };
    });

    for (const row of outcome.dead) {
      await audit(asCoreDb(this.db), tenantId, owner, 'automation.outbox.dead', 'automation.outbox', row.id, {
        attempts: row.attempts,
        last_error: row.last_error,
        reason: 'lease_expired',
      });
      if (this.events) {
        await this.events.emit(tenantId, 'automation.outbox.dead', {
          v: 1,
          outboxId: row.id,
          attempts: row.attempts,
        });
      }
    }
    return { claimed: outcome.claimed, recoveredDead: outcome.dead.length };
  }

  /** Mark a claimed row delivered. A lease guard fences stale workers. */
  async markDelivered(
    tenantId: string,
    outboxId: string,
    lease: OutboxLease,
  ): Promise<AutomationOutboxRow> {
    if (!lease) throw ApiError.conflict('delivery lease is required');
    const now = nowIso();
    const res = await this.db
      .updateTable('automation_outbox')
      .set({
        status: 'delivered',
        delivered_at: now,
        updated_at: now,
        last_error: null,
        lease_owner: null,
        lease_expires_at: null,
        lease_heartbeat_at: null,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', outboxId)
      .where('status', '=', 'delivering')
      .where('lease_owner', '=', lease.owner)
      .where('lease_token', '=', lease.token)
      .where('lease_expires_at', '>', now)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) throw new OutboxLeaseLostError(outboxId);
    return this.require(tenantId, outboxId);
  }

  /** Extend a live delivery lease. The owner/token pair cannot revive a stale lease. */
  async renewLease(
    tenantId: string,
    outboxId: string,
    lease: OutboxLease,
    now = nowIso(),
    leaseSeconds = DEFAULT_OUTBOX_LEASE_SECONDS,
  ): Promise<AutomationOutboxRow> {
    const at = validUtc(now, 'heartbeat time');
    const seconds = validLeaseSeconds(leaseSeconds);
    const row = await this.require(tenantId, outboxId);
    const proposedExpiry = at.plus({ seconds }).toISO()!;
    const expiresAt =
      row.lease_expires_at && row.lease_expires_at > proposedExpiry
        ? row.lease_expires_at
        : proposedExpiry;
    const res = await this.db
      .updateTable('automation_outbox')
      .set({
        lease_expires_at: expiresAt,
        lease_heartbeat_at: at.toISO()!,
        updated_at: at.toISO()!,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', outboxId)
      .where('status', '=', 'delivering')
      .where('lease_owner', '=', lease.owner)
      .where('lease_token', '=', lease.token)
      .where('lease_expires_at', '>', at.toISO()!)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) throw new OutboxLeaseLostError(outboxId);
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
    lease: OutboxLease,
    actor = 'system',
  ): Promise<AutomationOutboxRow> {
    if (!lease) throw ApiError.conflict('delivery lease is required');
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

    const res = await this.db
      .updateTable('automation_outbox')
      .set({
        attempts,
        status: dead ? 'dead' : 'failed',
        last_error: error.slice(0, 2000),
        next_attempt_at: nextAttemptAt,
        updated_at: now,
        lease_owner: null,
        lease_expires_at: null,
        lease_heartbeat_at: null,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', outboxId)
      .where('status', '=', 'delivering')
      .where('lease_owner', '=', lease.owner)
      .where('lease_token', '=', lease.token)
      .where('lease_expires_at', '>', now)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) throw new OutboxLeaseLostError(outboxId);

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
    const result = await this.db
      .updateTable('automation_outbox')
      .set({
        status: 'pending',
        attempts: 0,
        next_attempt_at: now,
        last_error: null,
        lease_owner: null,
        lease_expires_at: null,
        lease_heartbeat_at: null,
        updated_at: now,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', outboxId)
      .where('status', '=', row.status)
      .where('updated_at', '=', row.updated_at)
      .where('lease_token', '=', row.lease_token)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      throw ApiError.conflict('outbox row changed while replaying; retry');
    }
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
    if (row.status === 'canceled') return row;
    if (row.status === 'delivering') {
      throw ApiError.conflict('cannot cancel a delivery in progress');
    }
    if (row.status === 'delivered') {
      throw ApiError.conflict('cannot cancel an already-delivered row');
    }
    if (row.status !== 'pending' && row.status !== 'failed' && row.status !== 'dead') {
      throw ApiError.conflict(`cannot cancel outbox row in status "${row.status}"`);
    }
    const now = nowIso();
    const result = await this.db
      .updateTable('automation_outbox')
      .set({
        status: 'canceled',
        lease_owner: null,
        lease_expires_at: null,
        lease_heartbeat_at: null,
        updated_at: now,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', outboxId)
      .where('status', '=', row.status)
      .where('updated_at', '=', row.updated_at)
      .where('lease_token', '=', row.lease_token)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      throw ApiError.conflict('outbox row changed while canceling; retry');
    }
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

function validUtc(value: string, label: string): DateTime {
  const parsed = DateTime.fromISO(value, { setZone: true }).toUTC();
  if (!parsed.isValid) throw ApiError.badRequest(`${label} must be an ISO-8601 timestamp`);
  return parsed;
}

function validLeaseSeconds(value = DEFAULT_OUTBOX_LEASE_SECONDS): number {
  if (!Number.isInteger(value) || value < 1 || value > 86_400) {
    throw ApiError.badRequest('leaseSeconds must be an integer from 1 to 86400');
  }
  return value;
}
