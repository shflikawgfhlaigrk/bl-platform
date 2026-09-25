import { asCoreDb, audit, type ModuleDeps } from '@blacklabel/core';
import type { MerchantRecord } from './lifecycle';
import type { PosServiceDatabase } from './schema';
import type { MerchantObserver } from './service';

export const POS_SERVICE_EVENTS = Object.freeze({
  merchantCreated: 'pos_service.merchant.created',
  merchantStageChanged: 'pos_service.merchant.stage_changed',
  merchantBlocked: 'pos_service.merchant.blocked',
  messagePrepared: 'pos_service.message.prepared',
} as const);

const IGNORED_KEYS = new Set(['version', 'updatedAt']);

function changedKeys(before: MerchantRecord, after: MerchantRecord): string[] {
  return Object.keys(after)
    .filter((key) => !IGNORED_KEYS.has(key))
    .filter((key) => JSON.stringify(before[key as keyof MerchantRecord]) !== JSON.stringify(after[key as keyof MerchantRecord]))
    .sort();
}

/**
 * Audit every stored merchant change and emit the module's events. Payloads carry ids, stages
 * and codes only: no names, emails, addresses, links, or message bodies.
 */
export function posServiceObserver(
  deps: Pick<ModuleDeps<PosServiceDatabase>, 'db' | 'events'>,
  tenantId: string,
  actor: string,
): MerchantObserver {
  return {
    async changed(before, after) {
      const merchantId = after.id;
      await audit(
        asCoreDb(deps.db),
        tenantId,
        actor,
        before ? 'pos_service.merchant.updated' : POS_SERVICE_EVENTS.merchantCreated,
        'pos_service.merchant',
        merchantId,
        {
          from: before?.stage ?? null,
          to: after.stage,
          blocked: after.blocked?.code ?? null,
          changed: before ? changedKeys(before, after) : [],
        },
      );
      if (!before) {
        await deps.events.emit(tenantId, POS_SERVICE_EVENTS.merchantCreated, { v: 1, merchantId, livemode: after.livemode });
      }
      // One event per lifecycle step, even when a single write crossed several (verified, then location ready).
      for (const step of after.history.slice(before?.history.length ?? 0)) {
        await deps.events.emit(tenantId, POS_SERVICE_EVENTS.merchantStageChanged, { v: 1, merchantId, from: step.from, to: step.to });
      }
      if (after.blocked && after.blocked.code !== before?.blocked?.code) {
        await deps.events.emit(tenantId, POS_SERVICE_EVENTS.merchantBlocked, { v: 1, merchantId, code: after.blocked.code });
      }
      const known = new Set(before?.messages.map((m) => m.id) ?? []);
      for (const message of after.messages.filter((m) => !known.has(m.id))) {
        await deps.events.emit(tenantId, POS_SERVICE_EVENTS.messagePrepared, { v: 1, merchantId, messageId: message.id, kind: message.kind });
      }
    },
  };
}
