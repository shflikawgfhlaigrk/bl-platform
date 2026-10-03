import { id as rowId, nowIso } from '@blacklabel/core';
import type { Kysely } from 'kysely';
import type { MerchantRecord } from './lifecycle';
import type { PosServiceDatabase, PosServiceMerchantRow } from './schema';
import { MerchantConflictError, MerchantExistsError, type MerchantPage, type MerchantStore } from './store';

function fromRow(row: PosServiceMerchantRow): MerchantRecord {
  const record = JSON.parse(row.record) as MerchantRecord;
  return { ...record, id: row.id, version: row.version };
}

function columns(record: MerchantRecord) {
  return {
    version: record.version,
    livemode: record.livemode ? 1 : 0,
    purchase_ref: record.purchaseRef,
    stripe_account_id: record.stripeAccountId,
    stage: record.stage,
    blocked_code: record.blocked?.code ?? null,
    record: JSON.stringify(record),
    updated_at: record.updatedAt,
  };
}

/**
 * Merchant store on the platform database. Every query is filtered by the tenant the store was
 * opened for, including the uniqueness checks, so one tenant can never read or touch another's
 * merchants or webhook ledger.
 */
export function createDbMerchantStore(db: Kysely<PosServiceDatabase>, tenantId: string): MerchantStore {
  if (!tenantId) throw new Error('createDbMerchantStore: tenantId is required');
  const merchants = () => db.selectFrom('pos_service_merchants').selectAll().where('tenant_id', '=', tenantId);

  const hasEvent = async (eventId: string) =>
    Boolean(
      await db
        .selectFrom('pos_service_webhook_events')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('event_id', '=', eventId)
        .executeTakeFirst(),
    );

  const store: MerchantStore = {
    async get(merchantId) {
      const row = await merchants().where('id', '=', merchantId).executeTakeFirst();
      return row ? fromRow(row) : null;
    },

    async findByStripeAccount(accountId) {
      const row = await merchants().where('stripe_account_id', '=', accountId).executeTakeFirst();
      return row ? fromRow(row) : null;
    },

    async findByPurchaseRef(purchaseRef) {
      const row = await merchants().where('purchase_ref', '=', purchaseRef).executeTakeFirst();
      return row ? fromRow(row) : null;
    },

    async create(record) {
      if (await store.findByPurchaseRef(record.purchaseRef)) throw new MerchantExistsError(record.purchaseRef);
      try {
        await db
          .insertInto('pos_service_merchants')
          .values({ id: record.id, tenant_id: tenantId, created_at: record.createdAt, ...columns(record) })
          .execute();
      } catch (error) {
        // A concurrent purchase won the unique index; report it the same way as the check above.
        if (await store.findByPurchaseRef(record.purchaseRef)) throw new MerchantExistsError(record.purchaseRef);
        throw error;
      }
    },

    async update(record, expectedVersion) {
      const next = { ...record, version: expectedVersion + 1 };
      const result = await db
        .updateTable('pos_service_merchants')
        .set(columns(next))
        .where('tenant_id', '=', tenantId)
        .where('id', '=', record.id)
        .where('version', '=', expectedVersion)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) throw new MerchantConflictError(record.id);
    },

    async list(page?: MerchantPage) {
      let query = merchants().orderBy('created_at', 'asc').orderBy('id', 'asc');
      if (page) query = query.limit(page.limit).offset(page.offset);
      return (await query.execute()).map(fromRow);
    },

    hasEvent,

    async recordEvent(eventId) {
      if (await hasEvent(eventId)) return false;
      try {
        await db
          .insertInto('pos_service_webhook_events')
          .values({ id: rowId(), tenant_id: tenantId, event_id: eventId, created_at: nowIso() })
          .execute();
      } catch (error) {
        if (await hasEvent(eventId)) return false;
        throw error;
      }
      return true;
    },
  };
  return store;
}
