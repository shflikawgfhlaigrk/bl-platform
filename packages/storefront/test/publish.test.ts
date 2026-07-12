import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@blacklabel/core';
import {
  publishStorefront,
  getLiveRun,
  rollbackToRun,
  listPublishRuns,
} from '../src/publish';
import { setup, fixtureSource, fixtureItems } from './helpers';

const AS_OF = '2026-07-11';

describe('publish pipeline', () => {
  it('publishes the projection: counts, checksum, all gates pass, event emitted', async () => {
    const { db, tenantA, events } = await setup();
    const seen: PlatformEvent[] = [];
    events.on('storefront.publish.completed', (e) => {
      seen.push(e);
    });

    const res = await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(), events, dataAsOf: AS_OF });

    expect(res.status).toBe('live');
    expect(res.itemCount).toBe(4);
    expect(res.variationCount).toBe(5);
    expect(res.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(res.failures).toEqual([]);
    expect(res.gateResults.every((g) => g.pass)).toBe(true);
    expect(seen).toHaveLength(1);
    expect((seen[0].payload as any).runId).toBe(res.runId);

    const live = await getLiveRun(db, tenantA.id);
    expect(live?.id).toBe(res.runId);
    expect(live?.item_count).toBe(4);
  });

  it('re-publishing identical inputs yields the identical checksum (idempotent)', async () => {
    const { db, tenantA } = await setup();
    const a = await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(), dataAsOf: AS_OF });
    const b = await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(), dataAsOf: AS_OF });
    expect(b.checksum).toBe(a.checksum);
    expect(b.runId).not.toBe(a.runId); // a new run row each time
    const runs = await listPublishRuns(db, tenantA.id);
    expect(runs.filter((r) => r.status === 'live')).toHaveLength(1); // only the newest is live
  });

  it('keeps the projection tenant-isolated', async () => {
    const { db, tenantA, tenantB } = await setup();
    await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(), dataAsOf: AS_OF });
    expect(await getLiveRun(db, tenantB.id)).toBeUndefined();
  });

  it('FAILS the publish and leaves the prior projection live when the exclusion output gate trips', async () => {
    const { db, tenantA } = await setup();
    const good = await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(), dataAsOf: AS_OF });

    // A "published" item whose name leaks an excluded token slips past the fill
    // gate but the OUTPUT re-grep must catch it.
    const bad = fixtureItems();
    bad[0].name = 'Consignment Special Bridle';
    const res = await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(bad), dataAsOf: AS_OF });

    expect(res.status).toBe('failed');
    expect(res.failures.join(' ')).toMatch(/consignment/i);
    // rollback-by-default: the previous good run is still live
    const live = await getLiveRun(db, tenantA.id);
    expect(live?.id).toBe(good.runId);
    expect(res.liveRunId).toBe(good.runId);
  });

  it('FAILS at the fill gate when a non-published item reaches the projection', async () => {
    const { db, tenantA } = await setup();
    const bad = fixtureItems();
    (bad[1] as any).publicationState = 'excluded';
    const res = await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(bad), dataAsOf: AS_OF });
    expect(res.status).toBe('failed');
    expect(res.gateResults[0].name).toBe('exclusion-fill');
    expect(res.failures.join(' ')).toMatch(/must not enter projection/);
    expect(await getLiveRun(db, tenantA.id)).toBeUndefined();
  });

  it('FAILS the publish when a description leaks an email address', async () => {
    const { db, tenantA } = await setup();
    const bad = fixtureItems();
    bad[0].description = 'Questions? mail sales@magstack.example.com for details.';
    const res = await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(bad), dataAsOf: AS_OF });
    expect(res.status).toBe('failed');
    expect(res.failures.join(' ')).toMatch(/email-like/);
  });

  it('supports rollback to a prior successful run', async () => {
    const { db, tenantA } = await setup();
    const run1 = await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(), dataAsOf: AS_OF });
    const items2 = fixtureItems().slice(0, 2);
    const run2 = await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(items2), dataAsOf: AS_OF });
    expect((await getLiveRun(db, tenantA.id))?.id).toBe(run2.runId);

    await rollbackToRun(db, tenantA.id, run1.runId);
    const live = await getLiveRun(db, tenantA.id);
    expect(live?.id).toBe(run1.runId);
    expect(live?.item_count).toBe(4);

    const runs = await listPublishRuns(db, tenantA.id);
    expect(runs.find((r) => r.id === run2.runId)?.status).toBe('rolled_back');
  });

  it('refuses to roll back to a failed run', async () => {
    const { db, tenantA } = await setup();
    await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(), dataAsOf: AS_OF });
    const bad = fixtureItems();
    bad[0].name = 'JPC Consignment Blanket';
    const failed = await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(bad), dataAsOf: AS_OF });
    await expect(rollbackToRun(db, tenantA.id, failed.runId)).rejects.toThrow(/never passed gates/);
  });
});
