import type { MerchantRecord } from './lifecycle';

export class MerchantConflictError extends Error {
  constructor(id: string) {
    super(`Merchant ${id} changed while it was being updated.`);
    this.name = 'MerchantConflictError';
  }
}

/** A merchant with the same id or purchase reference is already stored. */
export class MerchantExistsError extends Error {
  constructor(purchaseRef: string) {
    super(`A merchant for purchase ${purchaseRef} already exists.`);
    this.name = 'MerchantExistsError';
  }
}

export interface MerchantPage {
  limit: number;
  offset: number;
}

/** Persistence boundary. Updates are optimistic: a stale version is refused, never overwritten. */
export interface MerchantStore {
  get(id: string): Promise<MerchantRecord | null>;
  findByStripeAccount(accountId: string): Promise<MerchantRecord | null>;
  findByPurchaseRef(purchaseRef: string): Promise<MerchantRecord | null>;
  /** Throws MerchantExistsError when the id or purchase reference is taken. */
  create(record: MerchantRecord): Promise<void>;
  update(record: MerchantRecord, expectedVersion: number): Promise<void>;
  /** Oldest first, id as the tiebreaker. */
  list(page?: MerchantPage): Promise<MerchantRecord[]>;
  hasEvent(eventId: string): Promise<boolean>;
  /** Returns false when the event id was already recorded (duplicate delivery). */
  recordEvent(eventId: string): Promise<boolean>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryMerchantStore implements MerchantStore {
  private readonly records = new Map<string, MerchantRecord>();
  private readonly events = new Set<string>();

  async get(id: string) {
    const record = this.records.get(id);
    return record ? clone(record) : null;
  }

  async findByStripeAccount(accountId: string) {
    for (const record of this.records.values()) if (record.stripeAccountId === accountId) return clone(record);
    return null;
  }

  async findByPurchaseRef(purchaseRef: string) {
    for (const record of this.records.values()) if (record.purchaseRef === purchaseRef) return clone(record);
    return null;
  }

  async create(record: MerchantRecord) {
    if (this.records.has(record.id) || (await this.findByPurchaseRef(record.purchaseRef))) {
      throw new MerchantExistsError(record.purchaseRef);
    }
    this.records.set(record.id, clone(record));
  }

  async update(record: MerchantRecord, expectedVersion: number) {
    const current = this.records.get(record.id);
    if (!current || current.version !== expectedVersion) throw new MerchantConflictError(record.id);
    this.records.set(record.id, clone({ ...record, version: expectedVersion + 1 }));
  }

  async list(page?: MerchantPage) {
    const all = [...this.records.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(clone);
    return page ? all.slice(page.offset, page.offset + page.limit) : all;
  }

  async hasEvent(eventId: string) {
    return this.events.has(eventId);
  }

  async recordEvent(eventId: string) {
    if (this.events.has(eventId)) return false;
    this.events.add(eventId);
    return true;
  }
}
