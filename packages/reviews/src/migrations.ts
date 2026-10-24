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
  {
    name: 'reviews.0002_eligibility_delivery_opt_out',
    up: async db => {
      for (const table of ['reviews_requests', 'reviews_reminders']) {
        await db.schema.alterTable(table).addColumn('delivery_status', 'text', c => c.notNull().defaultTo('not_sent')).execute();
        for (const column of ['delivery_message_id', 'delivery_error', 'delivery_attempted_at']) {
          await db.schema.alterTable(table).addColumn(column, 'text').execute();
        }
      }
      for (const column of ['source_job_id', 'source_job_type', 'source_job_completed_at']) {
        await db.schema.alterTable('reviews_requests').addColumn(column, 'text').execute();
      }
      await db.schema.createIndex('reviews_requests_completed_job_uq').on('reviews_requests')
        .columns(['tenant_id', 'source_job_type', 'source_job_id']).unique().execute();
      // Existing submissions remain submissions; migration never resends them.
      await db.updateTable('reviews_requests').set({ delivery_status: 'submitted' }).where('sent_at', 'is not', null).execute();
      await db.updateTable('reviews_reminders').set({ delivery_status: 'submitted' }).where('sent_at', 'is not', null).execute();
      await db.schema.createTable('reviews_opt_outs')
        .addColumn('id', 'text', c => c.primaryKey())
        .addColumn('tenant_id', 'text', c => c.notNull())
        .addColumn('customer_id', 'text', c => c.notNull())
        .addColumn('created_at', 'text', c => c.notNull()).execute();
      await db.schema.createIndex('reviews_opt_outs_tenant_customer_uq')
        .on('reviews_opt_outs').columns(['tenant_id', 'customer_id']).unique().execute();
      // Preserve opt-outs that existed before customer-wide preferences.
      const previous = await db.selectFrom('reviews_requests').select(['tenant_id', 'customer_id', 'opted_out_at'])
        .where('status', '=', 'opted_out').orderBy('created_at').orderBy('id').execute();
      const { id, nowIso } = await import('@blacklabel/core');
      const seen = new Set<string>();
      for (const row of previous) {
        const key = JSON.stringify([row.tenant_id, row.customer_id]);
        if (seen.has(key)) continue;
        seen.add(key);
        await db.insertInto('reviews_opt_outs').values({ id: id(), tenant_id: row.tenant_id,
          customer_id: row.customer_id, created_at: row.opted_out_at ?? nowIso() }).execute();
      }
    },
  },
];
