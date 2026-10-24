import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { reviewsMigrations, type ReviewsDatabase } from '@blacklabel/reviews';

describe('reviews migrations', () => {
  it('upgrades prior submissions and opt-outs without changing tokens or resending', async () => {
    const db = createTestDb<ReviewsDatabase>();
    await runMigrations(db, [...coreMigrations, reviewsMigrations[0]]);
    const original = { id: 'legacy-request', tenant_id: 'legacy-tenant', customer_id: 'legacy-customer', campaign_id: null,
      token: 'legacy-token-is-preserved', status: 'opted_out', rating_threshold: 4, sent_at: '2026-07-02T00:00:00.000Z',
      clicked_at: null, completed_at: null, opted_out_at: '2026-07-03T00:00:00.000Z',
      created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-03T00:00:00.000Z' };
    await db.insertInto('reviews_requests').values(original).execute();
    await runMigrations(db, [...coreMigrations, ...reviewsMigrations]);
    const upgraded = await db.selectFrom('reviews_requests').selectAll().where('tenant_id', '=', original.tenant_id).where('id', '=', original.id).executeTakeFirstOrThrow();
    expect(upgraded.token).toBe(original.token); expect(upgraded.sent_at).toBe(original.sent_at); expect(upgraded.delivery_status).toBe('submitted');
    const preference = await db.selectFrom('reviews_opt_outs').selectAll().where('tenant_id', '=', original.tenant_id).where('customer_id', '=', original.customer_id).executeTakeFirstOrThrow();
    expect(preference.created_at).toBe(original.opted_out_at);
  });
  it('apply cleanly on a fresh db (after core) and create every table', async () => {
    const db = createTestDb<ReviewsDatabase>();
    const result = await runMigrations(db, [...coreMigrations, ...reviewsMigrations]);
    expect(result.applied).toContain('reviews.0001_review_engine');

    // Every module table is queryable.
    for (const table of [
      'reviews_platforms',
      'reviews_campaigns',
      'reviews_requests',
      'reviews_responses',
      'reviews_testimonials',
      'reviews_reminders',
      'reviews_opt_outs',
    ] as const) {
      const rows = await db.selectFrom(table).selectAll().execute();
      expect(rows).toEqual([]);
    }
  });

  it('are idempotent on re-run', async () => {
    const db = createTestDb<ReviewsDatabase>();
    await runMigrations(db, [...coreMigrations, ...reviewsMigrations]);
    const second = await runMigrations(db, [...coreMigrations, ...reviewsMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('reviews.0001_review_engine');
  });
});
