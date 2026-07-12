import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { reviewsMigrations, type ReviewsDatabase } from '@blacklabel/reviews';

describe('reviews migrations', () => {
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
