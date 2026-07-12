import type { Migration } from '@blacklabel/db';

/**
 * Reviews module migrations. Append-only — never edit or reorder an existing
 * entry; new schema change = new migration appended to this array.
 */
export const reviewsMigrations: Migration[] = [
  {
    name: 'reviews.0001_review_engine',
    up: async (db) => {
      await db.schema
        .createTable('reviews_platforms')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('target_url', 'text', (c) => c.notNull())
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('enabled', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('reviews_platforms_tenant_id_idx')
        .on('reviews_platforms')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('reviews_campaigns')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('rating_threshold', 'integer', (c) => c.notNull())
        .addColumn('throttle_per_day', 'integer', (c) => c.notNull())
        .addColumn('schedule_start_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('reviews_campaigns_tenant_id_idx')
        .on('reviews_campaigns')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('reviews_requests')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('campaign_id', 'text')
        .addColumn('customer_id', 'text', (c) => c.notNull())
        .addColumn('token', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('rating_threshold', 'integer', (c) => c.notNull())
        .addColumn('sent_at', 'text')
        .addColumn('clicked_at', 'text')
        .addColumn('completed_at', 'text')
        .addColumn('opted_out_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('reviews_requests_tenant_id_idx')
        .on('reviews_requests')
        .column('tenant_id')
        .execute();
      // The token is the credential for the public endpoint — must be unique.
      await db.schema
        .createIndex('reviews_requests_token_uq')
        .on('reviews_requests')
        .column('token')
        .unique()
        .execute();

      await db.schema
        .createTable('reviews_responses')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('request_id', 'text', (c) => c.notNull())
        .addColumn('customer_id', 'text', (c) => c.notNull())
        .addColumn('rating', 'integer', (c) => c.notNull())
        .addColumn('comment', 'text')
        .addColumn('sentiment', 'text', (c) => c.notNull())
        .addColumn('flagged_for_followup', 'integer', (c) => c.notNull())
        .addColumn('resolved_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('reviews_responses_tenant_id_idx')
        .on('reviews_responses')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('reviews_testimonials')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('customer_id', 'text', (c) => c.notNull())
        .addColumn('response_id', 'text')
        .addColumn('quote', 'text', (c) => c.notNull())
        .addColumn('author_name', 'text')
        .addColumn('consent', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('reviews_testimonials_tenant_id_idx')
        .on('reviews_testimonials')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('reviews_reminders')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('request_id', 'text', (c) => c.notNull())
        .addColumn('send_at', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('sent_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('reviews_reminders_tenant_id_idx')
        .on('reviews_reminders')
        .column('tenant_id')
        .execute();
    },
  },
];
