import { describe, expect, it } from 'vitest';
import { parseCsv } from '@blacklabel/core';
import { exportApprovedTime, genericCsvAdapter } from '@blacklabel/workforce';
import { body, get, post, setup } from './helpers';

const rows = [
  {
    id: 'te_1',
    userId: 'user_1',
    start: '2026-08-01T09:00:00.000Z',
    end: '2026-08-01T17:00:00.000Z',
    breaks: [{ start: '2026-08-01T12:00:00.000Z', end: '2026-08-01T12:30:00.000Z' }],
  },
  {
    id: 'te_2',
    userId: 'user_2',
    start: '2026-08-01T10:00:00.000Z',
    end: '2026-08-01T14:00:00.000Z',
  },
];

describe('workforce time export lane', () => {
  it('renders APPROVED rows to CSV verbatim — no pay/overtime/duration math', async () => {
    const ctx = await setup();
    const res = await post(ctx, ctx.tenantA, '/time-exports', { rows });
    expect(res.status).toBe(201);
    const exported = (await body(res)).data;
    expect(exported.adapter).toBe('generic_csv');
    expect(exported.row_count).toBe(2);

    const parsed = parseCsv(exported.payload);
    expect(parsed).toHaveLength(2);
    expect(Object.keys(parsed[0])).toEqual([
      'time_entry_id',
      'user_id',
      'clock_in',
      'clock_out',
      'break_count',
      'breaks',
    ]);
    expect(parsed[0].time_entry_id).toBe('te_1');
    expect(parsed[0].clock_in).toBe('2026-08-01T09:00:00.000Z');
    expect(parsed[0].clock_out).toBe('2026-08-01T17:00:00.000Z');
    expect(parsed[0].break_count).toBe('1'); // array length only — structural, not minutes
    expect(parsed[1].break_count).toBe('0');

    // No pay/wage/overtime/duration columns anywhere in the payload.
    for (const banned of ['pay', 'wage', 'overtime', 'gross', 'net', 'hours', 'duration', 'minutes', 'rate']) {
      expect(exported.payload.toLowerCase()).not.toContain(banned);
    }
  });

  it('adapter render output contains zero derived numeric time math', () => {
    const out = genericCsvAdapter.render(rows);
    // Every value is a raw passthrough string/id or the array length — no summed number.
    expect(out[0]).toEqual({
      time_entry_id: 'te_1',
      user_id: 'user_1',
      clock_in: '2026-08-01T09:00:00.000Z',
      clock_out: '2026-08-01T17:00:00.000Z',
      break_count: 1,
      breaks: JSON.stringify(rows[0].breaks),
    });
  });

  it('lists + downloads the CSV; tenant-scoped', async () => {
    const ctx = await setup();
    const exported = (await body(await post(ctx, ctx.tenantA, '/time-exports', { rows }))).data;

    const list = (await body(await get(ctx, ctx.tenantA, '/time-exports'))).data;
    expect(list.map((e: any) => e.id)).toContain(exported.id);

    const dl = await get(ctx, ctx.tenantA, `/time-exports/${exported.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('text/csv');
    expect(await dl.text()).toBe(exported.payload);

    // Tenant B cannot see or download it.
    expect((await body(await get(ctx, ctx.tenantB, '/time-exports'))).data).toEqual([]);
    expect((await get(ctx, ctx.tenantB, `/time-exports/${exported.id}/download`)).status).toBe(404);
  });

  it('rejects an unknown adapter (400) and a backwards time row (400)', async () => {
    const ctx = await setup();
    const badAdapter = await post(ctx, ctx.tenantA, '/time-exports', { adapter: 'adp_x', rows });
    expect(badAdapter.status).toBe(400);

    const badRow = await post(ctx, ctx.tenantA, '/time-exports', {
      rows: [{ id: 'x', userId: 'u', start: '2026-08-01T17:00:00.000Z', end: '2026-08-01T09:00:00.000Z' }],
    });
    expect(badRow.status).toBe(400);
  });

  it('exportApprovedTime service persists a record without computing pay', async () => {
    const ctx = await setup();
    const rec = await exportApprovedTime(ctx.db, ctx.tenantA, 'system', { rows });
    expect(rec.tenant_id).toBe(ctx.tenantA);
    expect(rec.row_count).toBe(2);
    const stored = await ctx.db
      .selectFrom('workforce_time_exports')
      .selectAll()
      .where('id', '=', rec.id)
      .executeTakeFirstOrThrow();
    expect(stored.payload).toBe(rec.payload);
  });
});
