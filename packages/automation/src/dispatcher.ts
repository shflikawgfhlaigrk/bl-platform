import type { Kysely } from 'kysely';
import { id, nowIso } from '@blacklabel/core';
import type { AutomationDatabase, AutomationOutboxRow } from './schema';
import {
  DEFAULT_OUTBOX_LEASE_SECONDS,
  OutboxLeaseLostError,
  OutboxService,
  type OutboxLease,
} from './outbox';

type Db = Kysely<AutomationDatabase>;

/** The job a handler receives: the row plus its parsed payload. */
export interface OutboxJob {
  id: string;
  tenantId: string;
  kind: string;
  payload: unknown;
  attempts: number;
  /** Stable provider idempotency key for duplicate-safe external calls. */
  idempotencyKey: string;
  leaseOwner: string;
  leaseToken: number;
  /** Long handlers may renew explicitly in addition to automatic heartbeats. */
  heartbeat: () => Promise<void>;
}

/** A registered effect handler. Throwing marks the row failed (isolated). */
export type OutboxHandler = (job: OutboxJob) => void | Promise<void>;

/**
 * Handlers per effect `kind`, registered by the integrator at wiring time.
 * The automation module ships NO handlers itself (no network in module code);
 * apps/api registers real transports (email, provider calls, webhooks).
 */
export class DispatcherRegistry {
  private readonly handlers = new Map<string, OutboxHandler>();

  register(kind: string, handler: OutboxHandler): this {
    this.handlers.set(kind, handler);
    return this;
  }

  get(kind: string): OutboxHandler | undefined {
    return this.handlers.get(kind);
  }

  has(kind: string): boolean {
    return this.handlers.has(kind);
  }

  kinds(): string[] {
    return [...this.handlers.keys()];
  }
}

export interface RunOnceResult {
  claimed: number;
  delivered: number;
  failed: number;
  /** Handler failures plus crash-recovered rows dead-lettered during claim. */
  dead: number;
  /** Rows whose kind had no registered handler (counted under failed too). */
  noHandler: number;
  /** Rows this worker skipped because a newer fencing token owns them. */
  leaseLost: number;
}

export interface RunOnceOptions {
  /** Stable process/instance identity used as the durable lease owner. */
  workerId?: string;
  /** Defaults to 60 seconds. */
  leaseSeconds?: number;
  /** Defaults to one third of leaseSeconds. */
  heartbeatSeconds?: number;
}

/**
 * Drain due rows once (no timers/cron — the integrator/UI calls this). Each row
 * is routed to its registered handler; a throwing handler marks THAT row failed
 * and never breaks the drain. Rows with no handler are marked failed with an
 * explanatory error (so they back off and eventually dead-letter, never stick
 * in 'delivering'). Tenant-scoped.
 */
export async function runOnce(
  db: Db,
  registry: DispatcherRegistry,
  tenantId: string,
  now: string,
  limit = 50,
  events?: import('@blacklabel/core').EventBus,
  options: RunOnceOptions = {},
): Promise<RunOnceResult> {
  const outbox = new OutboxService(db, events);
  const workerId = options.workerId?.trim() || `dispatcher:${id()}`;
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_OUTBOX_LEASE_SECONDS;
  const heartbeatSeconds = options.heartbeatSeconds ?? Math.max(1, Math.floor(leaseSeconds / 3));
  if (!Number.isFinite(heartbeatSeconds) || heartbeatSeconds <= 0) {
    throw new Error('heartbeatSeconds must be greater than 0');
  }
  const claimResult = await outbox.claimDueWithResult(tenantId, now, limit, {
    leaseOwner: workerId,
    leaseSeconds,
  });
  const claimed = claimResult.claimed;
  const result: RunOnceResult = {
    claimed: claimed.length,
    delivered: 0,
    failed: 0,
    dead: claimResult.recoveredDead,
    noHandler: 0,
    leaseLost: 0,
  };

  const active = new Map<string, OutboxLease>(
    claimed.map((row) => [row.id, leaseOf(row)]),
  );
  const lost = new Set<string>();
  let heartbeatInFlight = Promise.resolve();
  let heartbeatError: unknown;
  const heartbeatAll = async () => {
    for (const [outboxId, lease] of [...active]) {
      try {
        const renewed = await outbox.renewLease(
          tenantId,
          outboxId,
          lease,
          nowIso(),
          leaseSeconds,
        );
        if (active.has(outboxId)) active.set(outboxId, leaseOf(renewed));
      } catch (err) {
        if (err instanceof OutboxLeaseLostError && active.has(outboxId)) {
          lost.add(outboxId);
          active.delete(outboxId);
          continue;
        }
        throw err;
      }
    }
  };
  const timer = claimed.length > 0
    ? setInterval(() => {
        heartbeatInFlight = heartbeatInFlight.then(heartbeatAll).catch((err) => {
          heartbeatError ??= err;
        });
      }, heartbeatSeconds * 1000)
    : undefined;
  timer?.unref();

  try {
    for (const row of claimed) {
      let lease = active.get(row.id);
      if (!lease || lost.has(row.id)) {
        result.leaseLost += 1;
        continue;
      }

      // Refresh before the handler starts so rows waiting behind earlier work
      // cannot begin under an expired batch lease.
      try {
        const renewed = await outbox.renewLease(
          tenantId,
          row.id,
          lease,
          nowIso(),
          leaseSeconds,
        );
        lease = leaseOf(renewed);
        active.set(row.id, lease);
      } catch (err) {
        if (err instanceof OutboxLeaseLostError) {
          active.delete(row.id);
          result.leaseLost += 1;
          continue;
        }
        throw err;
      }

      const handler = registry.get(row.kind);
      if (!handler) {
        result.noHandler += 1;
        try {
          const updated = await outbox.markFailed(
            tenantId,
            row.id,
            `no handler registered for kind "${row.kind}"`,
            lease,
            workerId,
          );
          tallyFailure(result, updated);
        } catch (err) {
          if (!(err instanceof OutboxLeaseLostError)) throw err;
          result.leaseLost += 1;
        } finally {
          active.delete(row.id);
        }
        continue;
      }
      try {
        await handler({
          id: row.id,
          tenantId: row.tenant_id,
          kind: row.kind,
          payload: parsePayload(row.payload),
          attempts: row.attempts,
          idempotencyKey: row.idempotency_key,
          leaseOwner: lease.owner,
          leaseToken: lease.token,
          heartbeat: async () => {
            const current = active.get(row.id);
            if (!current) throw new OutboxLeaseLostError(row.id);
            const renewed = await outbox.renewLease(
              tenantId,
              row.id,
              current,
              nowIso(),
              leaseSeconds,
            );
            active.set(row.id, leaseOf(renewed));
          },
        });
        const current = active.get(row.id);
        if (!current) throw new OutboxLeaseLostError(row.id);
        await outbox.markDelivered(tenantId, row.id, current);
        result.delivered += 1;
      } catch (err) {
        if (err instanceof OutboxLeaseLostError) {
          result.leaseLost += 1;
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        const current = active.get(row.id) ?? lease;
        try {
          const updated = await outbox.markFailed(
            tenantId,
            row.id,
            message,
            current,
            workerId,
          );
          tallyFailure(result, updated);
        } catch (markErr) {
          if (!(markErr instanceof OutboxLeaseLostError)) throw markErr;
          result.leaseLost += 1;
        }
      } finally {
        active.delete(row.id);
      }
    }
  } finally {
    if (timer) clearInterval(timer);
    await heartbeatInFlight;
    if (heartbeatError) throw heartbeatError;
  }
  return result;
}

function tallyFailure(result: RunOnceResult, updated: AutomationOutboxRow): void {
  result.failed += 1;
  if (updated.status === 'dead') result.dead += 1;
}

function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function leaseOf(row: AutomationOutboxRow): OutboxLease {
  if (!row.lease_owner || !row.lease_expires_at) throw new OutboxLeaseLostError(row.id);
  return {
    owner: row.lease_owner,
    token: row.lease_token,
    expiresAt: row.lease_expires_at,
  };
}
