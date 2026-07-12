import { describe, expect, it } from 'vitest';
import { api, json, setup } from './helpers';

describe('cash sessions (journey 13)', () => {
  it('open → post expected → close with variance math + variance event', async () => {
    const ctx = await setup();
    const variances: any[] = [];
    ctx.events.on('finance.cash.variance', (e) => { variances.push(e); });

    const opened = await json(
      await api(ctx.app, ctx.tenantA, 'POST', '/cash-sessions', {
        openedBy: 'clerk1',
        openingFloatCents: 10000,
        showRef: 'show_1',
      }),
    );
    expect(opened.data.status).toBe('open');

    await api(ctx.app, ctx.tenantA, 'PUT', `/cash-sessions/${opened.data.id}/expected`, {
      expectedCents: 45000,
    });

    const closed = await json(
      await api(ctx.app, ctx.tenantA, 'POST', `/cash-sessions/${opened.data.id}/close`, {
        closedBy: 'clerk1',
        countedCents: 44750,
      }),
    );
    expect(closed.data.status).toBe('closed');
    expect(closed.data.expected_cents).toBe(45000);
    expect(closed.data.counted_cents).toBe(44750);
    expect(closed.data.variance_cents).toBe(-250);
    expect(variances).toHaveLength(1);
    expect(variances[0].payload).toEqual({ v: 1, cashSessionId: opened.data.id, varianceCents: -250 });
  });

  it('zero variance emits NO variance event', async () => {
    const ctx = await setup();
    const variances: any[] = [];
    ctx.events.on('finance.cash.variance', (e) => { variances.push(e); });
    const opened = await json(
      await api(ctx.app, ctx.tenantA, 'POST', '/cash-sessions', { openedBy: 'c', openingFloatCents: 5000 }),
    );
    const closed = await json(
      await api(ctx.app, ctx.tenantA, 'POST', `/cash-sessions/${opened.data.id}/close`, {
        closedBy: 'c',
        countedCents: 5000,
        expectedCents: 5000,
      }),
    );
    expect(closed.data.variance_cents).toBe(0);
    expect(variances).toHaveLength(0);
  });

  it('close without a posted expected → 400 (no zero assumption)', async () => {
    const ctx = await setup();
    const opened = await json(
      await api(ctx.app, ctx.tenantA, 'POST', '/cash-sessions', { openedBy: 'c', openingFloatCents: 5000 }),
    );
    const res = await api(ctx.app, ctx.tenantA, 'POST', `/cash-sessions/${opened.data.id}/close`, {
      closedBy: 'c',
      countedCents: 5000,
    });
    expect(res.status).toBe(400);
  });

  it('session is immutable after close; corrections are adjustments only', async () => {
    const ctx = await setup();
    const opened = await json(
      await api(ctx.app, ctx.tenantA, 'POST', '/cash-sessions', { openedBy: 'c', openingFloatCents: 5000 }),
    );
    await api(ctx.app, ctx.tenantA, 'POST', `/cash-sessions/${opened.data.id}/close`, {
      closedBy: 'c',
      countedCents: 4800,
      expectedCents: 5000,
    });

    // re-close → conflict
    const reclose = await api(ctx.app, ctx.tenantA, 'POST', `/cash-sessions/${opened.data.id}/close`, {
      closedBy: 'c',
      countedCents: 4900,
      expectedCents: 5000,
    });
    expect(reclose.status).toBe(409);

    // post expected after close → conflict
    const postExpected = await api(ctx.app, ctx.tenantA, 'PUT', `/cash-sessions/${opened.data.id}/expected`, {
      expectedCents: 6000,
    });
    expect(postExpected.status).toBe(409);

    // adjustment is allowed and does not mutate the session
    const adj = await json(
      await api(ctx.app, ctx.tenantA, 'POST', `/cash-sessions/${opened.data.id}/adjustments`, {
        amountCents: 200,
        reason: 'miscount found next day',
        createdBy: 'owner',
      }),
    );
    expect(adj.data.amount_cents).toBe(200);
    const after = await json(await api(ctx.app, ctx.tenantA, 'GET', `/cash-sessions/${opened.data.id}`));
    expect(after.data.variance_cents).toBe(-200);
    const adjList = await json(await api(ctx.app, ctx.tenantA, 'GET', `/cash-sessions/${opened.data.id}/adjustments`));
    expect(adjList.data).toHaveLength(1);
  });

  it('adjustment on an OPEN session → 400', async () => {
    const ctx = await setup();
    const opened = await json(
      await api(ctx.app, ctx.tenantA, 'POST', '/cash-sessions', { openedBy: 'c', openingFloatCents: 5000 }),
    );
    const res = await api(ctx.app, ctx.tenantA, 'POST', `/cash-sessions/${opened.data.id}/adjustments`, {
      amountCents: 100,
      reason: 'x',
      createdBy: 'owner',
    });
    expect(res.status).toBe(400);
  });
});
