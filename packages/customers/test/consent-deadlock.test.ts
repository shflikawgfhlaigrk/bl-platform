import { describe, expect, it } from 'vitest';
import { confirmDoubleOptIn, createProfile, startDoubleOptIn } from '@blacklabel/customers';
import { setup } from './helpers';

/**
 * Regression guard for 6f9a254 — the confirmDoubleOptIn transaction deadlock.
 *
 * In the full app an automation '*' subscriber enqueues EVERY emitted event to
 * the outbox inside its OWN db.transaction(). Kysely's better-sqlite3 dialect
 * serializes connection acquisition with a single mutex, so a transaction opened
 * WHILE another is still open waits forever. Before the fix, confirmDoubleOptIn
 * emitted customers.consent.changed INSIDE its transaction → the subscriber's
 * nested transaction deadlocked → the public double-opt-in confirm hung forever.
 *
 * The package's other consent tests DON'T wire a transaction-opening '*'
 * subscriber, so they pass even against the buggy code (this is exactly why
 * acceptance journey 14 was the "only guard" and it failed open). This test
 * reproduces the deadlock condition IN-PROCESS so the guard lives inside
 * `npm test`: it registers a '*' handler that opens its own transaction, then
 * asserts confirmDoubleOptIn COMPLETES (post-commit emit) rather than hanging.
 *
 * Against the pre-6f9a254 code this test hangs and fails on the timeout race;
 * against the fixed code it resolves well under the deadline.
 */
describe('confirmDoubleOptIn: no transaction deadlock with a transactional event subscriber', () => {
  it('completes (does not deadlock) when a "*" subscriber opens its own db.transaction', async () => {
    const ctx = await setup();
    const db = ctx.db;

    // Faithfully mimic the automation outbox: every event enqueued inside its
    // own transaction. If confirmDoubleOptIn emits inside its transaction, this
    // nested open deadlocks on the single-connection mutex.
    let subscriberRuns = 0;
    ctx.events.on('*', async (evt) => {
      await db.transaction().execute(async (trx) => {
        // Any query inside the transaction acquires the connection mutex — that
        // is what deadlocks against a still-open outer transaction.
        await trx.selectFrom('customers_profiles').select('id').limit(1).execute();
        subscriberRuns += 1;
        return evt.id;
      });
    });

    const profile = await createProfile(db as any, ctx.A, 'test', {
      crmCustomerId: null,
      email: 'deadlock@buyer.test',
      phone: null,
      firstName: 'Dead',
      lastName: 'Lock',
      source: 'storefront',
    });

    const started = await startDoubleOptIn(db as any, ctx.A, 'test', ctx.events, profile.id, {
      channel: 'email',
      textShown: 'I agree to receive email',
      source: 'storefront',
      ttlMinutes: 60,
    });
    const token = (started as { token: string }).token;
    expect(token).toBeTruthy();

    // Bound the potential hang so a deadlock fails FAST and deterministically
    // rather than only tripping vitest's default per-test timeout.
    const DEADLINE_MS = 4000;
    const confirm = confirmDoubleOptIn(db as any, ctx.A, 'test', ctx.events, token);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`confirmDoubleOptIn did not complete within ${DEADLINE_MS}ms — DEADLOCK`)), DEADLINE_MS).unref(),
    );

    const consent = (await Promise.race([confirm, timeout])) as { state?: string; profile_id?: string };
    expect(consent.state).toBe('granted');
    expect(consent.profile_id).toBe(profile.id);
    // The post-commit emit must have actually reached the transactional subscriber
    // (start emitted one consent.changed too → at least the confirm one ran here).
    expect(subscriberRuns).toBeGreaterThanOrEqual(1);
  });
});
