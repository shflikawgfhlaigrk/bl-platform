import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type Contracts,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { reviewsMigrations, reviewsRouter, type ReviewsDatabase } from '@blacklabel/reviews';
import type { ReviewProvider } from '../src/service';

export async function setup(contracts: Contracts = {}, provider?: ReviewProvider) {
  const db = createTestDb<ReviewsDatabase>();
  await runMigrations(db, [...coreMigrations, ...reviewsMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Tenant A' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Tenant B' });
  const events = new EventBus();
  const app = provider
    ? reviewsRouter({ db, events, contracts }, provider)
    : reviewsRouter({ db, events, contracts });
  return { db, events, app, tenantA, tenantB };
}

/** RequestInit for a JSON call; tenantId null = deliberately no tenant header. */
export function jsonInit(tenantId: string | null, body?: unknown, method = 'POST'): RequestInit {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (tenantId) headers['x-tenant-id'] = tenantId;
  return { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
}

export function getInit(tenantId: string | null): RequestInit {
  const headers: Record<string, string> = {};
  if (tenantId) headers['x-tenant-id'] = tenantId;
  return { method: 'GET', headers };
}

/** A provider spy that records every stub call. */
export class SpyProvider implements ReviewProvider {
  readonly key = 'spy';
  requests: unknown[] = [];
  reminders: unknown[] = [];

  async sendReviewRequest(ctx: unknown): Promise<{ delivered: boolean }> {
    this.requests.push(ctx);
    return { delivered: true };
  }

  async sendReminder(ctx: unknown): Promise<{ delivered: boolean }> {
    this.reminders.push(ctx);
    return { delivered: true };
  }

  async syncExternalReviews(): Promise<{ imported: number }> {
    return { imported: 0 };
  }
}
