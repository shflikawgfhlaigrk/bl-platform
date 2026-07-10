import { id, nowIso } from './helpers';

/**
 * Event names are `module.entity.verb`, lowercase, dot-separated, exactly
 * three segments; segments may contain underscores (past-tense verbs like
 * "clocked_in"). Enforced at emit() so typos fail fast.
 */
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** The planned cross-module events catalog (modules may add more — same naming rules). */
export const KNOWN_EVENTS = [
  'crm.lead.created',
  'quoting.quote.approved',
  'quoting.quote.converted',
  'scheduling.appointment.scheduled',
  'scheduling.appointment.completed',
  'scheduling.appointment.canceled',
  'billing.invoice.paid',
  'reviews.review.submitted',
  'workflows.task.completed',
  'workflows.task.overdue',
  'messaging.message.received',
  'portal_employee.shift.clocked_in',
  'portal_employee.shift.clocked_out',
] as const;

export type KnownEventType = (typeof KNOWN_EVENTS)[number];

export interface PlatformEvent<T = unknown> {
  /** Unique event id (nanoid). */
  id: string;
  tenantId: string;
  type: string;
  payload: T;
  /** ISO-8601 UTC. */
  occurredAt: string;
}

export type EventHandler<T = unknown> = (event: PlatformEvent<T>) => void | Promise<void>;

export interface EmitResult {
  /** Handlers that completed without throwing. */
  delivered: number;
  /** Errors thrown/rejected by handlers — collected, never propagated. */
  errors: Error[];
}

/**
 * Typed in-process event bus. Handlers are isolated: a throwing (or
 * rejecting) handler is recorded in EmitResult.errors and CANNOT break
 * emit() or starve other handlers. This is how the workflows module (and
 * any other listener) subscribes to the rest of the platform.
 */
export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler<any>>>();

  /**
   * Subscribe to an event type ('*' receives every event).
   * Returns an unsubscribe function.
   */
  on<T = unknown>(type: string, handler: EventHandler<T>): () => void {
    if (type !== '*' && !EVENT_NAME_PATTERN.test(type)) {
      throw new Error(
        `EventBus.on: invalid event type "${type}" (expected module.entity.verb, lowercase)`,
      );
    }
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as EventHandler<any>);
    return () => {
      set.delete(handler as EventHandler<any>);
    };
  }

  /** Number of handlers currently subscribed to a type (excluding '*'). */
  handlerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }

  /**
   * Emit an event to all handlers of `type` plus all '*' handlers, awaiting
   * each. Never throws because of a handler; inspect the returned EmitResult
   * if you care about handler failures.
   */
  async emit<T = unknown>(tenantId: string, type: string, payload: T): Promise<EmitResult> {
    if (!tenantId) {
      throw new Error('EventBus.emit: tenantId is required');
    }
    if (!EVENT_NAME_PATTERN.test(type)) {
      throw new Error(
        `EventBus.emit: invalid event type "${type}" (expected module.entity.verb, lowercase)`,
      );
    }
    const event: PlatformEvent<T> = {
      id: id(),
      tenantId,
      type,
      payload,
      occurredAt: nowIso(),
    };
    const targets = [
      ...(this.handlers.get(type) ?? []),
      ...(this.handlers.get('*') ?? []),
    ];
    const result: EmitResult = { delivered: 0, errors: [] };
    for (const handler of targets) {
      try {
        await handler(event);
        result.delivered += 1;
      } catch (err) {
        result.errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    return result;
  }
}
