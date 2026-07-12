import { describe, expect, it } from 'vitest';
import { collect, makeShow, req, setup } from './helpers';

function suggestBody() {
  return {
    templateId: null,
    suggestInputs: {
      templateLines: [
        { variationId: 'v1', targetQty: 10 },
        { variationId: 'v2', targetQty: 5 },
      ],
      variationStats: [
        {
          variationId: 'v1', name: 'Belt', unitsPerWeekVelocity: 3, categoryShowShare: 1,
          onHand: 100, reserved: 0, displayMin: 0, safetyStock: 0,
        },
        {
          variationId: 'v2', name: 'Pad', unitsPerWeekVelocity: 1, categoryShowShare: 1,
          onHand: 100, reserved: 0, displayMin: 0, safetyStock: 0,
        },
      ],
      vehicleCapacityUnits: null,
    },
  };
}

describe('manifests: suggestion, load-out, scan-back, discrepancies', () => {
  it('creates a draft manifest with a suggested line + stored formula trace per line', async () => {
    const { app, tenantA } = await setup();
    const { showId } = await makeShow(app, tenantA);
    const res = await req(app, 'POST', `/shows/${showId}/manifests`, tenantA, suggestBody());
    expect(res.status).toBe(201);
    expect(res.json.data.manifest.status).toBe('draft');
    const lines = res.json.data.lines;
    expect(lines).toHaveLength(2);
    const v1 = lines.find((l: any) => l.variation_id === 'v1');
    expect(v1.suggested_qty).toBe(10);
    expect(Array.isArray(v1.formula_trace)).toBe(true);
    expect(v1.formula_trace[0].step).toBe('demand');
  });

  it('markPacked with no variance succeeds and sets manifest -> loaded; emits shows.manifest.loaded', async () => {
    const { app, tenantA, events } = await setup();
    const loaded = collect(events, 'shows.manifest.loaded');
    const { showId } = await makeShow(app, tenantA);
    const created = await req(app, 'POST', `/shows/${showId}/manifests`, tenantA, suggestBody());
    const manifestId = created.json.data.manifest.id;

    const packed = await req(app, 'POST', `/manifests/${manifestId}/pack`, tenantA, {
      lines: [{ variationId: 'v1', qty: 10 }, { variationId: 'v2', qty: 5 }],
    });
    expect(packed.status).toBe(200);
    expect(packed.json.data.manifest.status).toBe('loaded');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].payload).toMatchObject({
      v: 1, manifestId, showId,
      lines: [{ variationId: 'v1', packedQty: 10 }, { variationId: 'v2', packedQty: 5 }],
    });
  });

  it('a variance without a reason is rejected; with a reason it is stored', async () => {
    const { app, tenantA } = await setup();
    const { showId } = await makeShow(app, tenantA);
    const created = await req(app, 'POST', `/shows/${showId}/manifests`, tenantA, suggestBody());
    const manifestId = created.json.data.manifest.id;

    const noReason = await req(app, 'POST', `/manifests/${manifestId}/pack`, tenantA, {
      lines: [{ variationId: 'v1', qty: 7 }], // suggested 10 -> variance, no reason
    });
    expect(noReason.status).toBe(400);

    const withReason = await req(app, 'POST', `/manifests/${manifestId}/pack`, tenantA, {
      lines: [
        { variationId: 'v1', qty: 7, reason: 'missing' },
        { variationId: 'v2', qty: 5 },
      ],
    });
    expect(withReason.status).toBe(200);
    const v1 = withReason.json.data.lines.find((l: any) => l.variation_id === 'v1');
    expect(v1.packed_qty).toBe(7);
    expect(v1.missing_reason).toBe('missing');
  });

  it('records a substitute item added at pack time', async () => {
    const { app, tenantA } = await setup();
    const { showId } = await makeShow(app, tenantA);
    const created = await req(app, 'POST', `/shows/${showId}/manifests`, tenantA, suggestBody());
    const manifestId = created.json.data.manifest.id;
    const packed = await req(app, 'POST', `/manifests/${manifestId}/pack`, tenantA, {
      lines: [
        { variationId: 'v1', qty: 10 },
        { variationId: 'v2', qty: 5 },
        { variationId: 'v9', qty: 4, reason: 'substituted', substitutionOf: 'v2' },
      ],
    });
    expect(packed.status).toBe(200);
    const sub = packed.json.data.lines.find((l: any) => l.variation_id === 'v9');
    expect(sub.substitution_of).toBe('v2');
    expect(sub.missing_reason).toBe('substituted');
    expect(sub.suggested_qty).toBe(0);
  });

  it('records returns (loaded -> returned) and emits shows.manifest.returned with packed+returned', async () => {
    const { app, tenantA, events } = await setup();
    const returned = collect(events, 'shows.manifest.returned');
    const { showId } = await makeShow(app, tenantA);
    const created = await req(app, 'POST', `/shows/${showId}/manifests`, tenantA, suggestBody());
    const manifestId = created.json.data.manifest.id;
    await req(app, 'POST', `/manifests/${manifestId}/pack`, tenantA, {
      lines: [{ variationId: 'v1', qty: 10 }, { variationId: 'v2', qty: 5 }],
    });

    const rec = await req(app, 'POST', `/manifests/${manifestId}/returns`, tenantA, {
      lines: [{ variationId: 'v1', qty: 4 }, { variationId: 'v2', qty: 5 }],
    });
    expect(rec.status).toBe(200);
    expect(rec.json.data.manifest.status).toBe('returned');
    expect(returned).toHaveLength(1);
    const payloadV1 = (returned[0].payload as any).lines.find((l: any) => l.variationId === 'v1');
    expect(payloadV1).toEqual({ variationId: 'v1', packedQty: 10, returnedQty: 4 });
  });

  it('cannot pack an already-loaded manifest, nor return before loading', async () => {
    const { app, tenantA } = await setup();
    const { showId } = await makeShow(app, tenantA);
    const created = await req(app, 'POST', `/shows/${showId}/manifests`, tenantA, suggestBody());
    const manifestId = created.json.data.manifest.id;

    const earlyReturn = await req(app, 'POST', `/manifests/${manifestId}/returns`, tenantA, {
      lines: [{ variationId: 'v1', qty: 1 }],
    });
    expect(earlyReturn.status).toBe(409);

    await req(app, 'POST', `/manifests/${manifestId}/pack`, tenantA, {
      lines: [{ variationId: 'v1', qty: 10 }, { variationId: 'v2', qty: 5 }],
    });
    const rePack = await req(app, 'POST', `/manifests/${manifestId}/pack`, tenantA, {
      lines: [{ variationId: 'v1', qty: 10 }],
    });
    expect(rePack.status).toBe(409);
  });

  it('stores integrator-posted discrepancies (delta = returned - expected) and resolves them', async () => {
    const { app, tenantA } = await setup();
    const { showId } = await makeShow(app, tenantA);
    const posted = await req(app, 'POST', `/shows/${showId}/discrepancies`, tenantA, {
      manifestId: null,
      entries: [
        { variationId: 'v1', expectedQty: 6, returnedQty: 4 }, // short by 2
        { variationId: 'v2', expectedQty: 0, returnedQty: 1 }, // one extra
      ],
    });
    expect(posted.status).toBe(201);
    const d1 = posted.json.data.find((d: any) => d.variation_id === 'v1');
    expect(d1.delta).toBe(-2);
    expect(d1.resolved).toBe(false);

    const open = await req(app, 'GET', `/shows/${showId}/discrepancies?unresolved=true`, tenantA);
    expect(open.json.data).toHaveLength(2);

    const resolved = await req(app, 'POST', `/discrepancies/${d1.id}/resolve`, tenantA, {
      resolution: 'shrink',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.json.data.resolved).toBe(true);
    expect(resolved.json.data.resolution).toBe('shrink');

    const stillOpen = await req(app, 'GET', `/shows/${showId}/discrepancies?unresolved=true`, tenantA);
    expect(stillOpen.json.data).toHaveLength(1);
  });

  it('reconcile is blocked while discrepancies are unresolved and allowed once resolved', async () => {
    const { app, tenantA } = await setup();
    const { showId } = await makeShow(app, tenantA);
    const created = await req(app, 'POST', `/shows/${showId}/manifests`, tenantA, suggestBody());
    const manifestId = created.json.data.manifest.id;
    await req(app, 'POST', `/manifests/${manifestId}/pack`, tenantA, {
      lines: [{ variationId: 'v1', qty: 10 }, { variationId: 'v2', qty: 5 }],
    });
    await req(app, 'POST', `/manifests/${manifestId}/returns`, tenantA, {
      lines: [{ variationId: 'v1', qty: 8 }, { variationId: 'v2', qty: 5 }],
    });
    const posted = await req(app, 'POST', `/shows/${showId}/discrepancies`, tenantA, {
      manifestId,
      entries: [{ variationId: 'v1', expectedQty: 10, returnedQty: 8 }],
    });
    const blocked = await req(app, 'POST', `/manifests/${manifestId}/reconcile`, tenantA);
    expect(blocked.status).toBe(409);

    await req(app, 'POST', `/discrepancies/${posted.json.data[0].id}/resolve`, tenantA, {
      resolution: 'sold_unrecorded',
    });
    const ok = await req(app, 'POST', `/manifests/${manifestId}/reconcile`, tenantA);
    expect(ok.status).toBe(200);
    expect(ok.json.data.status).toBe('reconciled');
  });

  it('denies cross-tenant manifest and discrepancy access', async () => {
    const { app, tenantA, tenantB } = await setup();
    const { showId } = await makeShow(app, tenantA);
    const created = await req(app, 'POST', `/shows/${showId}/manifests`, tenantA, suggestBody());
    const manifestId = created.json.data.manifest.id;

    expect((await req(app, 'GET', `/manifests/${manifestId}`, tenantB)).status).toBe(404);
    expect(
      (await req(app, 'POST', `/manifests/${manifestId}/pack`, tenantB, { lines: [] })).status,
    ).toBe(404);
    // Tenant B cannot post discrepancies against A's show.
    expect(
      (await req(app, 'POST', `/shows/${showId}/discrepancies`, tenantB, { entries: [] })).status,
    ).toBe(404);
  });
});
