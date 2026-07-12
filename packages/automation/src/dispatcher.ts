import type { Kysely } from 'kysely';
import type { AutomationDatabase, AutomationOutboxRow } from './schema';
import { OutboxService } from './outbox';

type Db = Kysely<AutomationDatabase>;

/** The job a handler receives: the row plus its parsed payload. */
export interface OutboxJob {
  id: string;
  tenantId: string;
  kind: string;
  payload: unknown;
  attempts: number;
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
  dead: number;
  /** Rows whose kind had no registered handler (counted under failed too). */
  noHandler: number;
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
): Promise<RunOnceResult> {
  const outbox = new OutboxService(db, events);
  const claimed = await outbox.claimDue(tenantId, now, limit);
  const result: RunOnceResult = {
    claimed: claimed.length,
    delivered: 0,
    failed: 0,
    dead: 0,
    noHandler: 0,
  };

  for (const row of claimed) {
    const handler = registry.get(row.kind);
    if (!handler) {
      result.noHandler += 1;
      const updated = await outbox.markFailed(tenantId, row.id, `no handler registered for kind "${row.kind}"`);
      tallyFailure(result, updated);
      continue;
    }
    try {
      await handler({
        id: row.id,
        tenantId: row.tenant_id,
        kind: row.kind,
        payload: parsePayload(row.payload),
        attempts: row.attempts,
      });
      await outbox.markDelivered(tenantId, row.id);
      result.delivered += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const updated = await outbox.markFailed(tenantId, row.id, message);
      tallyFailure(result, updated);
    }
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
