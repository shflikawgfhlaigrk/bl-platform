import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { sql } from 'kysely';
import { automationMigrations } from '../src/migrations';
import { OutboxService } from '../src/outbox';
import type { AutomationDatabase } from '../src/schema';

describe('automation migrations', () => {
  it('apply on a fresh db and are idempotent on re-run', async () => {
    const db = createTestDb<AutomationDatabase>();
    const first = await runMigrations(db, [...coreMigrations, ...automationMigrations]);
    expect(first.applied).toContain('automation.0001_outbox');
    expect(first.applied).toContain('automation.0002_rules');
    expect(first.applied).toContain('automation.0003_executions');
    expect(first.applied).toContain('automation.0004_approvals');
    expect(first.applied).toContain('automation.0005_outbox_delivery_leases');

    const second = await runMigrations(db, [...coreMigrations, ...automationMigrations]);
    expect(second.applied).toEqual([]);

    for (const table of [
      'automation_outbox',
      'automation_rules',
      'automation_executions',
      'automation_approvals',
    ] as const) {
      const rows = await db.selectFrom(table).selectAll().execute();
      expect(rows).toEqual([]);
    }
  });

  it('upgrades existing outbox rows without changing their delivery state', async () => {
    const db = createTestDb<AutomationDatabase>();
    await runMigrations(db, [...coreMigrations, ...automationMigrations.slice(0, 4)]);
    await sql`
      insert into automation_outbox (
        id, tenant_id, idempotency_key, kind, payload, status, attempts,
        max_attempts, next_attempt_at, last_error, created_at, updated_at,
        delivered_at
      ) values (
        'legacy-row', 'tenant-legacy', 'legacy-key', 'email.send', '{}',
        'delivering', 0, 8, '2030-01-01T00:00:00.000Z', null,
        '2029-12-31T23:59:00.000Z', '2029-12-31T23:59:00.000Z', null
      )
    `.execute(db);

    const upgraded = await runMigrations(db, [...coreMigrations, ...automationMigrations]);
    expect(upgraded.applied).toEqual(['automation.0005_outbox_delivery_leases']);
    const row = await db
      .selectFrom('automation_outbox')
      .selectAll()
      .where('id', '=', 'legacy-row')
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('delivering');
    expect(row.lease_owner).toBeNull();
    expect(row.lease_expires_at).toBeNull();
    expect(row.lease_heartbeat_at).toBeNull();
    expect(row.lease_token).toBe(0);

    const [reclaimed] = await new OutboxService(db).claimDue(
      'tenant-legacy',
      '2030-01-01T00:01:00.000Z',
      1,
      { leaseOwner: 'worker-after-upgrade', leaseSeconds: 30 },
    );
    expect(reclaimed).toMatchObject({
      id: 'legacy-row',
      status: 'delivering',
      attempts: 1,
      lease_owner: 'worker-after-upgrade',
      lease_token: 1,
    });
  });
});
