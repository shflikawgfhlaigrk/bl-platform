import { describe, expect, it } from 'vitest';
import {
  recordCashRefund,
  recordCashTender,
} from '../src/service';
import { api, json, setup } from './helpers';

async function openDrawer(
  ctx: Awaited<ReturnType<typeof setup>>,
  overrides: Record<string, unknown> = {},
) {
  return json(
    await api(ctx.app, ctx.tenantA, 'POST', '/cash-sessions', {
      openedBy: 'cashier-1',
      openingFloatCents: 10_000,
      locationRef: 'store-1',
      drawerRef: 'drawer-1',
      registerRef: 'register-1',
      ...overrides,
    }),
  );
}

describe('POS cash drawer ledger', () => {
  it('prevents two open sessions for one drawer, then releases the drawer on close', async () => {
    const ctx = await setup();
    const opened = await openDrawer(ctx);
    expect(opened.data.expected_mode).toBe('ledger');
    expect(opened.data.expected_cents).toBe(10_000);

    const duplicate = await api(ctx.app, ctx.tenantA, 'POST', '/cash-sessions', {
      openedBy: 'cashier-2',
      openingFloatCents: 5_000,
      locationRef: 'store-2',
      drawerRef: 'drawer-1',
    });
    expect(duplicate.status).toBe(409);

    const closed = await api(ctx.app, ctx.tenantA, 'POST', `/cash-sessions/${opened.data.id}/close`, {
      closedBy: 'cashier-1',
      countedCents: 10_000,
    });
    expect(closed.status).toBe(200);

    const reopened = await api(ctx.app, ctx.tenantA, 'POST', '/cash-sessions', {
      openedBy: 'cashier-2',
      openingFloatCents: 5_000,
      locationRef: 'store-1',
      drawerRef: 'drawer-1',
    });
    expect(reopened.status).toBe(201);
  });

  it('enforces the open-session scope under concurrent requests', async () => {
    const ctx = await setup();
    const body = {
      openedBy: 'cashier',
      openingFloatCents: 2_000,
      locationRef: 'store-1',
      drawerRef: 'race-drawer',
    };
    const responses = await Promise.all([
      api(ctx.app, ctx.tenantA, 'POST', '/cash-sessions', body),
      api(ctx.app, ctx.tenantA, 'POST', '/cash-sessions', body),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('derives expected cash from tenders, refunds, paid-ins, paid-outs, and drops', async () => {
    const ctx = await setup();
    const opened = await openDrawer(ctx);
    const sessionId = opened.data.id as string;

    const sale = await recordCashTender(ctx.db, ctx.tenantA.id, 'cashier-1', sessionId, {
      tenderRef: 'tender-cash-1',
      orderRef: 'order-1',
      amountCents: 5_000,
      occurredAt: '2026-09-03T10:00:00.000Z',
    });
    expect(sale.created).toBe(true);
    expect(sale.movement.kind).toBe('cash_sale');
    expect(sale.movement.tender_ref).toBe('tender-cash-1');

    const refund = await recordCashRefund(ctx.db, ctx.tenantA.id, 'cashier-1', sessionId, {
      refundRef: 'refund-cash-1',
      tenderRef: 'tender-cash-1',
      orderRef: 'order-1',
      amountCents: 1_200,
      occurredAt: '2026-09-03T11:00:00.000Z',
    });
    expect(refund.created).toBe(true);
    expect(refund.movement.kind).toBe('cash_refund');

    for (const movement of [
      { kind: 'paid_in', idempotencyKey: 'manual-in-1', amountCents: 1_000, note: 'change added' },
      { kind: 'paid_out', idempotencyKey: 'manual-out-1', amountCents: 300, note: 'petty cash' },
      { kind: 'drop', idempotencyKey: 'drop-1', amountCents: 2_000, note: 'safe drop' },
    ]) {
      const response = await api(
        ctx.app,
        ctx.tenantA,
        'POST',
        `/cash-sessions/${sessionId}/movements`,
        movement,
      );
      expect(response.status).toBe(201);
    }

    const reconciliation = await json(
      await api(ctx.app, ctx.tenantA, 'GET', `/cash-sessions/${sessionId}/reconciliation`),
    );
    expect(reconciliation.data).toMatchObject({
      openingFloatCents: 10_000,
      cashSalesCents: 5_000,
      cashRefundsCents: 1_200,
      paidInCents: 1_000,
      paidOutCents: 300,
      dropsCents: 2_000,
      movementCount: 5,
      calculatedExpectedCents: 12_500,
      effectiveExpectedCents: 12_500,
    });

    const session = await json(await api(ctx.app, ctx.tenantA, 'GET', `/cash-sessions/${sessionId}`));
    expect(session.data.expected_cents).toBe(12_500);

    const exportResponse = await api(ctx.app, ctx.tenantA, 'GET', '/exports/cash-movements.csv');
    expect(exportResponse.status).toBe(200);
    const csv = await exportResponse.text();
    expect(csv).toContain('cash_session_id,kind,source_ref');
    expect(csv).toContain('tender-cash-1');
    expect(csv).toContain('refund-cash-1');
  });

  it('makes mutation references replay-safe and rejects conflicting reuse', async () => {
    const ctx = await setup();
    const opened = await openDrawer(ctx);
    const path = `/cash-sessions/${opened.data.id}/movements`;
    const movement = { kind: 'paid_in', idempotencyKey: 'same-ref', amountCents: 500, note: 'float top-up' };

    const first = await json(await api(ctx.app, ctx.tenantA, 'POST', path, movement));
    const replayResponse = await api(ctx.app, ctx.tenantA, 'POST', path, movement);
    const replay = await json(replayResponse);
    expect(first.created).toBe(true);
    expect(replayResponse.status).toBe(200);
    expect(replay.created).toBe(false);
    expect(replay.data.movement.id).toBe(first.data.movement.id);

    const conflict = await api(ctx.app, ctx.tenantA, 'POST', path, {
      ...movement,
      amountCents: 501,
    });
    expect(conflict.status).toBe(409);

    const crossKindConflict = await api(ctx.app, ctx.tenantA, 'POST', path, {
      ...movement,
      kind: 'paid_out',
    });
    expect(crossKindConflict.status).toBe(409);

    const list = await json(await api(ctx.app, ctx.tenantA, 'GET', path));
    expect(list.data).toHaveLength(1);
    expect(list.data[0].amount_cents).toBe(500);
  });

  it('closes against the server ledger, records variance, and rejects concurrent re-close', async () => {
    const ctx = await setup();
    const variances: unknown[] = [];
    ctx.events.on('finance.cash.variance', (event) => { variances.push(event.payload); });
    const opened = await openDrawer(ctx);
    await recordCashTender(ctx.db, ctx.tenantA.id, 'cashier-1', opened.data.id, {
      tenderRef: 'tender-close-1',
      amountCents: 2_500,
    });

    const forged = await api(ctx.app, ctx.tenantA, 'POST', `/cash-sessions/${opened.data.id}/close`, {
      closedBy: 'cashier-1',
      countedCents: 12_400,
      expectedCents: 10_000,
    });
    expect(forged.status).toBe(409);

    const results = await Promise.all([
      api(ctx.app, ctx.tenantA, 'POST', `/cash-sessions/${opened.data.id}/close`, {
        closedBy: 'cashier-1',
        countedCents: 12_400,
      }),
      api(ctx.app, ctx.tenantA, 'POST', `/cash-sessions/${opened.data.id}/close`, {
        closedBy: 'cashier-2',
        countedCents: 12_500,
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const successful = results.find((r) => r.status === 200);
    expect(successful).toBeDefined();
    const closed = await json(successful!);
    expect(closed.data.expected_cents).toBe(12_500);
    expect([-100, 0]).toContain(closed.data.variance_cents);
    expect(variances).toHaveLength(closed.data.variance_cents === 0 ? 0 : 1);

    const late = await api(ctx.app, ctx.tenantA, 'POST', `/cash-sessions/${opened.data.id}/movements`, {
      kind: 'paid_out',
      idempotencyKey: 'late-new-movement',
      amountCents: 100,
      note: 'petty cash',
    });
    expect(late.status).toBe(409);
  });

  it('returns a prior movement replay after close without changing expected cash', async () => {
    const ctx = await setup();
    const opened = await openDrawer(ctx);
    const path = `/cash-sessions/${opened.data.id}/movements`;
    const movement = { kind: 'drop', idempotencyKey: 'close-replay', amountCents: 1_000, note: 'safe drop' };
    const first = await json(await api(ctx.app, ctx.tenantA, 'POST', path, movement));
    await api(ctx.app, ctx.tenantA, 'POST', `/cash-sessions/${opened.data.id}/close`, {
      closedBy: 'cashier-1',
      countedCents: 9_000,
    });

    const replayResponse = await api(ctx.app, ctx.tenantA, 'POST', path, movement);
    const replay = await json(replayResponse);
    expect(replayResponse.status).toBe(200);
    expect(replay.created).toBe(false);
    expect(replay.data.movement.id).toBe(first.data.movement.id);
    expect(replay.data.reconciliation.effectiveExpectedCents).toBe(9_000);
  });

  it('tenant-isolates drawer movements and reconciliation', async () => {
    const ctx = await setup();
    const opened = await openDrawer(ctx);
    await api(ctx.app, ctx.tenantA, 'POST', `/cash-sessions/${opened.data.id}/movements`, {
      kind: 'paid_in',
      idempotencyKey: 'tenant-a-only',
      amountCents: 100,
      note: 'float top-up',
    });

    expect(
      (await api(ctx.app, ctx.tenantB, 'GET', `/cash-sessions/${opened.data.id}/movements`)).status,
    ).toBe(404);
    expect(
      (await api(ctx.app, ctx.tenantB, 'GET', `/cash-sessions/${opened.data.id}/reconciliation`)).status,
    ).toBe(404);
    expect(
      (
        await api(ctx.app, ctx.tenantB, 'POST', `/cash-sessions/${opened.data.id}/movements`, {
          kind: 'paid_out',
          idempotencyKey: 'tenant-b-attempt',
          amountCents: 100,
          note: 'petty cash',
        })
      ).status,
    ).toBe(404);

    const list = await json(
      await api(ctx.app, ctx.tenantA, 'GET', `/cash-sessions/${opened.data.id}/movements`),
    );
    expect(list.data).toHaveLength(1);
  });
});
