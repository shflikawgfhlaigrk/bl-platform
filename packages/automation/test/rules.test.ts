import { describe, expect, it } from 'vitest';
import { asCoreDb, listAuditEntries } from '@blacklabel/core';
import { RulesService } from '../src/rules';
import { setup, reorderRule, reorderEvent } from './helpers';

describe('rule versioning (CRUD appends versions)', () => {
  it('create → v1; update → v2 with prior version retained', async () => {
    const { db, events, tenantA } = await setup();
    const rules = new RulesService(db, events);
    const created = await rules.create(tenantA.id, reorderRule());
    expect(created.version).toBe(1);

    const updated = await rules.update(tenantA.id, created.rule_key, { name: 'Renamed' });
    expect(updated.version).toBe(2);
    expect(updated.name).toBe('Renamed');
    expect(updated.rule_key).toBe(created.rule_key);

    const versions = await rules.listVersions(tenantA.id, created.rule_key);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);

    const current = await rules.getCurrent(tenantA.id, created.rule_key);
    expect(current!.version).toBe(2);

    // listCurrent returns exactly one row per rule_key (the latest).
    const list = await rules.listCurrent(tenantA.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.version).toBe(2);
  });

  it('writes audit rows on create and update', async () => {
    const { db, events, tenantA } = await setup();
    const rules = new RulesService(db, events);
    const created = await rules.create(tenantA.id, reorderRule());
    await rules.update(tenantA.id, created.rule_key, { name: 'X' });
    const audits = await listAuditEntries(asCoreDb(db), tenantA.id, 'automation.rule', created.rule_key);
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('automation.rule.created');
    expect(actions).toContain('automation.rule.updated');
  });
});

describe('evaluate — policy matrix', () => {
  it('automatic policy enqueues to the outbox and records "enqueued"', async () => {
    const { db, events, tenantA } = await setup();
    const rules = new RulesService(db, events);
    await rules.create(tenantA.id, reorderRule());

    const previews = await rules.evaluate(tenantA.id, 'inventory.stock.below_reorder_point', reorderEvent());
    expect(previews).toHaveLength(1);
    expect(previews[0]!.outcome).toBe('enqueued');
    expect(previews[0]!.outboxId).toBeTruthy();
    expect(previews[0]!.renderedPayload).toMatchObject({ variationId: 'var_1', locationId: 'loc_1' });

    const outboxRows = await db.selectFrom('automation_outbox').selectAll().where('tenant_id', '=', tenantA.id).execute();
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.kind).toBe('purchasing.reorder');
  });

  it('approval_required creates a pending approval and NO outbox row', async () => {
    const { db, events, tenantA } = await setup();
    const rules = new RulesService(db, events);
    await rules.create(tenantA.id, { ...reorderRule(), policy: 'approval_required', idempotencyWindowSeconds: 0 });

    const previews = await rules.evaluate(tenantA.id, 'inventory.stock.below_reorder_point', reorderEvent());
    expect(previews[0]!.outcome).toBe('pending_approval');

    const approvals = await rules.listApprovals(tenantA.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.status).toBe('pending');
    const outbox = await db.selectFrom('automation_outbox').selectAll().execute();
    expect(outbox).toHaveLength(0);
  });

  it('disabled (enabled=0 or policy=disabled) records skipped_disabled, no effect', async () => {
    const { db, events, tenantA } = await setup();
    const rules = new RulesService(db, events);
    await rules.create(tenantA.id, { ...reorderRule(), enabled: false });

    const previews = await rules.evaluate(tenantA.id, 'inventory.stock.below_reorder_point', reorderEvent());
    expect(previews[0]!.outcome).toBe('skipped_disabled');
    expect(previews[0]!.matched).toBe(false);
    expect(await db.selectFrom('automation_outbox').selectAll().execute()).toHaveLength(0);
  });
});

describe('evaluate — gating', () => {
  it('records skipped_condition when conditions do not match', async () => {
    const { db, events, tenantA } = await setup();
    const rules = new RulesService(db, events);
    // condition onHand<=5; give onHand 20.
    await rules.create(tenantA.id, reorderRule());
    const previews = await rules.evaluate(
      tenantA.id,
      'inventory.stock.below_reorder_point',
      reorderEvent({ onHand: 20 }),
    );
    expect(previews[0]!.outcome).toBe('skipped_condition');
    expect(previews[0]!.matched).toBe(false);
  });

  it('records invalid_event when the payload fails schema validation', async () => {
    const { db, events, tenantA } = await setup();
    const rules = new RulesService(db, events);
    await rules.create(tenantA.id, reorderRule());
    // Missing required fields (no v, no onHand, etc.)
    const previews = await rules.evaluate(tenantA.id, 'inventory.stock.below_reorder_point', {
      variationId: 'var_1',
    });
    expect(previews[0]!.outcome).toBe('invalid_event');
    expect(await db.selectFrom('automation_outbox').selectAll().execute()).toHaveLength(0);
  });

  it('honors the schedule window (America/New_York): outside → skipped_window', async () => {
    const { db, events, tenantA } = await setup();
    const rules = new RulesService(db, events);
    await rules.create(tenantA.id, {
      ...reorderRule(),
      idempotencyWindowSeconds: 0,
      schedule: {
        timezone: 'America/New_York',
        windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }],
      },
    });

    // 2026-03-09 Monday 06:00Z ≈ 01:00 local → OUTSIDE.
    const outside = await rules.evaluate(
      tenantA.id,
      'inventory.stock.below_reorder_point',
      reorderEvent(),
      { now: '2026-03-09T06:00:00.000Z' },
    );
    expect(outside[0]!.outcome).toBe('skipped_window');
    expect(outside[0]!.matched).toBe(true);

    // 2026-03-09 Monday 18:00Z ≈ 13:00/14:00 local → INSIDE → enqueued.
    const inside = await rules.evaluate(
      tenantA.id,
      'inventory.stock.below_reorder_point',
      reorderEvent(),
      { now: '2026-03-09T18:00:00.000Z' },
    );
    expect(inside[0]!.outcome).toBe('enqueued');
  });

  it('dedups within the idempotency window (2nd identical event → skipped_idempotent)', async () => {
    const { db, events, tenantA } = await setup();
    const rules = new RulesService(db, events);
    await rules.create(tenantA.id, reorderRule()); // idempotencyWindowSeconds 3600

    const now = '2026-03-09T12:00:00.000Z';
    const first = await rules.evaluate(tenantA.id, 'inventory.stock.below_reorder_point', reorderEvent(), { now });
    expect(first[0]!.outcome).toBe('enqueued');

    // Same rule + same rendered payload, 10 minutes later → within window → skip.
    const second = await rules.evaluate(tenantA.id, 'inventory.stock.below_reorder_point', reorderEvent(), {
      now: '2026-03-09T12:10:00.000Z',
    });
    expect(second[0]!.outcome).toBe('skipped_idempotent');

    // Only one outbox row exists.
    expect(await db.selectFrom('automation_outbox').selectAll().execute()).toHaveLength(1);

    // Outside the window (2 hours later) → fires again (outbox key still dedups identical payload,
    // so use a different variation to prove the window boundary).
    const later = await rules.evaluate(
      tenantA.id,
      'inventory.stock.below_reorder_point',
      reorderEvent({ variationId: 'var_2' }),
      { now: '2026-03-09T14:30:00.000Z' },
    );
    expect(later[0]!.outcome).toBe('enqueued');
  });
});

describe('evaluate — dry-run', () => {
  it('records dry_run with a preview and performs NO side effects', async () => {
    const { db, events, tenantA } = await setup();
    const rules = new RulesService(db, events);
    await rules.create(tenantA.id, reorderRule());

    const previews = await rules.evaluate(
      tenantA.id,
      'inventory.stock.below_reorder_point',
      reorderEvent(),
      { dryRun: true },
    );
    expect(previews[0]!.outcome).toBe('dry_run');
    expect(previews[0]!.matched).toBe(true);
    expect(previews[0]!.renderedPayload).toMatchObject({ variationId: 'var_1' });

    // No outbox, no approval rows.
    expect(await db.selectFrom('automation_outbox').selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom('automation_approvals').selectAll().execute()).toHaveLength(0);

    // Execution history DID record the dry-run outcome.
    const execs = await rules.listExecutions(tenantA.id, { outcome: 'dry_run' });
    expect(execs).toHaveLength(1);
  });
});

describe('execution history is recorded for every outcome', () => {
  it('one execution row per evaluate per rule, queryable by outcome/event/rule', async () => {
    const { db, events, tenantA } = await setup();
    const rules = new RulesService(db, events);
    const rule = await rules.create(tenantA.id, reorderRule());

    await rules.evaluate(tenantA.id, 'inventory.stock.below_reorder_point', reorderEvent()); // enqueued
    await rules.evaluate(tenantA.id, 'inventory.stock.below_reorder_point', reorderEvent({ onHand: 99 })); // skipped_condition

    const all = await rules.listExecutions(tenantA.id, { ruleId: rule.id });
    expect(all).toHaveLength(2);
    const outcomes = all.map((e) => e.outcome).sort();
    expect(outcomes).toEqual(['enqueued', 'skipped_condition']);

    const byEvent = await rules.listExecutions(tenantA.id, { eventType: 'inventory.stock.below_reorder_point' });
    expect(byEvent).toHaveLength(2);
  });
});

describe('approvals lifecycle', () => {
  it('hold persists and re-hold updates the reason, audit, and event', async () => {
    const { db, events, tenantA } = await setup();
    const rules = new RulesService(db, events);
    await rules.create(tenantA.id, { ...reorderRule(), policy: 'approval_required', idempotencyWindowSeconds: 0 });
    await rules.evaluate(tenantA.id, 'inventory.stock.below_reorder_point', reorderEvent());
    const [approval] = await rules.listApprovals(tenantA.id, { status: 'pending' });
    const heldEvents: Array<{ v: number; approvalId: string; reason: string }> = [];
    events.on<{ v: number; approvalId: string; reason: string }>('automation.approval.held', (event) => {
      heldEvents.push(event.payload);
    });

    const held = await rules.hold(tenantA.id, approval!.id, '  waiting on owner  ', 'operator_1');
    expect(held.status).toBe('held');
    expect(held.reason).toBe('waiting on owner');
    expect(held.decided_by).toBeNull();
    expect(held.decided_at).toBeNull();

    const reheld = await rules.hold(tenantA.id, approval!.id, 'waiting on updated quote', 'operator_2');
    expect(reheld.status).toBe('held');
    expect(reheld.reason).toBe('waiting on updated quote');
    expect(await rules.listApprovals(tenantA.id, { status: 'held' })).toHaveLength(1);

    const audits = await listAuditEntries(asCoreDb(db), tenantA.id, 'automation.approval', approval!.id);
    expect(audits.filter((entry) => entry.action === 'automation.approval.held')).toHaveLength(2);
    expect(heldEvents).toEqual([
      { v: 1, approvalId: approval!.id, reason: 'waiting on owner' },
      { v: 1, approvalId: approval!.id, reason: 'waiting on updated quote' },
    ]);
    await expect(rules.hold(tenantA.id, approval!.id, '   ')).rejects.toMatchObject({ status: 400 });
  });

  it('approve from held enqueues to the outbox; audit recorded', async () => {
    const { db, events, tenantA } = await setup();
    const rules = new RulesService(db, events);
    await rules.create(tenantA.id, { ...reorderRule(), policy: 'approval_required', idempotencyWindowSeconds: 0 });
    await rules.evaluate(tenantA.id, 'inventory.stock.below_reorder_point', reorderEvent());

    const [approval] = await rules.listApprovals(tenantA.id, { status: 'pending' });
    await rules.hold(tenantA.id, approval!.id, 'waiting on owner', 'operator_1');
    const approved = await rules.approve(tenantA.id, approval!.id, 'owner_1');
    expect(approved.status).toBe('approved');
    expect(approved.outbox_id).toBeTruthy();

    const outbox = await db.selectFrom('automation_outbox').selectAll().execute();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.id).toBe(approved.outbox_id);

    const audits = await listAuditEntries(asCoreDb(db), tenantA.id, 'automation.approval', approval!.id);
    expect(audits.map((a) => a.action)).toContain('automation.approval.approved');
    await expect(rules.hold(tenantA.id, approval!.id, 'too late')).rejects.toMatchObject({ status: 409 });
  });

  it('reject from held records the reason and enqueues nothing', async () => {
    const { db, events, tenantA } = await setup();
    const rules = new RulesService(db, events);
    await rules.create(tenantA.id, { ...reorderRule(), policy: 'approval_required', idempotencyWindowSeconds: 0 });
    await rules.evaluate(tenantA.id, 'inventory.stock.below_reorder_point', reorderEvent());
    const [approval] = await rules.listApprovals(tenantA.id, { status: 'pending' });

    await rules.hold(tenantA.id, approval!.id, 'waiting on owner', 'operator_1');
    const rejected = await rules.reject(tenantA.id, approval!.id, 'not this quarter', 'owner_1');
    expect(rejected.status).toBe('rejected');
    expect(rejected.reason).toBe('not this quarter');
    expect(await db.selectFrom('automation_outbox').selectAll().execute()).toHaveLength(0);

    // A second decision conflicts (409).
    await expect(rules.approve(tenantA.id, approval!.id)).rejects.toMatchObject({ status: 409 });
    await expect(rules.hold(tenantA.id, approval!.id, 'too late')).rejects.toMatchObject({ status: 409 });
  });
});

describe('registerAutomationSubscriptions', () => {
  it('drives evaluate off real events and ignores automation.* events', async () => {
    const { db, events, tenantA } = await setup();
    const rules = new RulesService(db, events);
    await rules.create(tenantA.id, reorderRule());
    const { registerAutomationSubscriptions } = await import('../src/index');
    registerAutomationSubscriptions({ db, events, contracts: {} });

    await events.emit(tenantA.id, 'inventory.stock.below_reorder_point', reorderEvent());
    const execs = await rules.listExecutions(tenantA.id, {});
    expect(execs.some((e) => e.outcome === 'enqueued')).toBe(true);

    // An automation.* event must NOT loop back into evaluate.
    const before = (await rules.listExecutions(tenantA.id, {})).length;
    await events.emit(tenantA.id, 'automation.outbox.enqueued', { v: 1, outboxId: 'x', kind: 'k' });
    const after = (await rules.listExecutions(tenantA.id, {})).length;
    expect(after).toBe(before);
  });
});
