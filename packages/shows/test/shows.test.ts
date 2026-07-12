import { describe, expect, it } from 'vitest';
import { listAuditEntries } from '@blacklabel/core';
import { asCoreDb } from '@blacklabel/core';
import { collect, makeShow, req, setup } from './helpers';

describe('venues + shows CRUD, tenancy, transitions, events', () => {
  it('creates a venue (2-letter state enforced) and a planned show', async () => {
    const { app, tenantA } = await setup();
    const bad = await req(app, 'POST', '/venues', tenantA, { name: 'X', state: 'Florida' });
    expect(bad.status).toBe(400);

    const venue = await req(app, 'POST', '/venues', tenantA, {
      name: 'WEC',
      state: 'fl',
      address: { city: 'Ocala' },
    });
    expect(venue.status).toBe(201);
    expect(venue.json.data.state).toBe('FL'); // uppercased
    expect(venue.json.data.address).toEqual({ city: 'Ocala' }); // parsed JSON

    const show = await req(app, 'POST', '/shows', tenantA, {
      venueId: venue.json.data.id,
      name: 'Winter Show',
      startsOn: '2026-01-15',
      endsOn: '2026-01-20',
    });
    expect(show.status).toBe(201);
    expect(show.json.data.status).toBe('planned');
  });

  it('rejects a show whose venue does not exist, and endsOn < startsOn', async () => {
    const { app, tenantA } = await setup();
    const noVenue = await req(app, 'POST', '/shows', tenantA, {
      venueId: 'nope',
      name: 'X',
      startsOn: '2026-01-15',
      endsOn: '2026-01-20',
    });
    expect(noVenue.status).toBe(404);

    const { venueId } = await makeShow(app, tenantA);
    const badDates = await req(app, 'POST', '/shows', tenantA, {
      venueId,
      name: 'Backwards',
      startsOn: '2026-01-20',
      endsOn: '2026-01-15',
    });
    expect(badDates.status).toBe(400);
  });

  it('emits shows.show.scheduled on create with { v, showId, startsAt }', async () => {
    const { app, tenantA, events } = await setup();
    const scheduled = collect(events, 'shows.show.scheduled');
    const { showId } = await makeShow(app, tenantA, { startsOn: '2026-03-01', endsOn: '2026-03-03' });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].payload).toEqual({ v: 1, showId, startsAt: '2026-03-01' });
  });

  it('enforces the transition matrix and emits packing.required / show.closed', async () => {
    const { app, tenantA, events } = await setup();
    const packing = collect(events, 'shows.packing.required');
    const closed = collect(events, 'shows.show.closed');
    const { showId } = await makeShow(app, tenantA);

    // planned -> active is NOT allowed (must go through packing).
    const illegal = await req(app, 'POST', `/shows/${showId}/transition`, tenantA, { to: 'active' });
    expect(illegal.status).toBe(409);

    const toPacking = await req(app, 'POST', `/shows/${showId}/transition`, tenantA, { to: 'packing' });
    expect(toPacking.status).toBe(200);
    expect(packing).toHaveLength(1);
    expect(packing[0].payload).toEqual({ v: 1, showId });

    await req(app, 'POST', `/shows/${showId}/transition`, tenantA, { to: 'active' });
    await req(app, 'POST', `/shows/${showId}/transition`, tenantA, { to: 'returned' });
    await req(app, 'POST', `/shows/${showId}/transition`, tenantA, { to: 'closing' });

    // closing -> closed is BLOCKED until the closeout is complete.
    const blocked = await req(app, 'POST', `/shows/${showId}/transition`, tenantA, { to: 'closed' });
    expect(blocked.status).toBe(409);
    expect(closed).toHaveLength(0);

    // Complete the (empty-but-fully-reviewed, no-exceptions) closeout, then close.
    await req(app, 'PATCH', `/shows/${showId}/closeout`, tenantA, {
      review: {
        sales: 1, cash: 1, inventory: 1, damages: 1, refunds: 1,
        labor: 1, travel: 1, booth_fees: 1, exceptions: 1,
      },
    });
    const complete = await req(app, 'POST', `/shows/${showId}/closeout/complete`, tenantA);
    expect(complete.status).toBe(200);
    const nowClosed = await req(app, 'POST', `/shows/${showId}/transition`, tenantA, { to: 'closed' });
    expect(nowClosed.status).toBe(200);
    expect(nowClosed.json.data.status).toBe('closed');
    expect(closed).toHaveLength(1);
    expect(closed[0].payload).toEqual({ v: 1, showId });
  });

  it('can cancel from a non-terminal state but not from closed', async () => {
    const { app, tenantA } = await setup();
    const { showId } = await makeShow(app, tenantA);
    const cancel = await req(app, 'POST', `/shows/${showId}/transition`, tenantA, { to: 'canceled' });
    expect(cancel.status).toBe(200);
    const again = await req(app, 'POST', `/shows/${showId}/transition`, tenantA, { to: 'packing' });
    expect(again.status).toBe(409); // canceled is terminal
  });

  it('schedule list filters by from-date and by venue state', async () => {
    const { app, tenantA } = await setup();
    const flVenue = await req(app, 'POST', '/venues', tenantA, { name: 'FL', state: 'FL' });
    const gaVenue = await req(app, 'POST', '/venues', tenantA, { name: 'GA', state: 'GA' });
    await req(app, 'POST', '/shows', tenantA, {
      venueId: flVenue.json.data.id, name: 'Early FL', startsOn: '2026-01-01', endsOn: '2026-01-02',
    });
    await req(app, 'POST', '/shows', tenantA, {
      venueId: gaVenue.json.data.id, name: 'Late GA', startsOn: '2026-06-01', endsOn: '2026-06-02',
    });

    const fromJune = await req(app, 'GET', '/shows?from=2026-05-01', tenantA);
    expect(fromJune.json.data.map((s: any) => s.name)).toEqual(['Late GA']);

    const flOnly = await req(app, 'GET', '/shows?state=FL', tenantA);
    expect(flOnly.json.data.map((s: any) => s.name)).toEqual(['Early FL']);

    const noneInTx = await req(app, 'GET', '/shows?state=TX', tenantA);
    expect(noneInTx.json.data).toEqual([]);
  });

  it('audits every show mutation', async () => {
    const { app, db, tenantA } = await setup();
    const { showId } = await makeShow(app, tenantA);
    await req(app, 'PATCH', `/shows/${showId}`, tenantA, { notes: 'bring extra pads' });
    await req(app, 'POST', `/shows/${showId}/transition`, tenantA, { to: 'packing' });
    const entries = await listAuditEntries(asCoreDb(db), tenantA.id, 'shows.show', showId);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('shows.show.scheduled');
    expect(actions).toContain('shows.show.updated');
    expect(actions).toContain('shows.show.transitioned');
  });

  describe('tenant isolation', () => {
    it('denies cross-tenant reads, updates, and transitions', async () => {
      const { app, tenantA, tenantB } = await setup();
      const { venueId, showId } = await makeShow(app, tenantA);

      expect((await req(app, 'GET', `/venues/${venueId}`, tenantB)).status).toBe(404);
      expect((await req(app, 'GET', `/shows/${showId}`, tenantB)).status).toBe(404);
      expect((await req(app, 'PATCH', `/shows/${showId}`, tenantB, { notes: 'hijack' })).status).toBe(404);
      expect(
        (await req(app, 'POST', `/shows/${showId}/transition`, tenantB, { to: 'packing' })).status,
      ).toBe(404);

      // Tenant B sees an empty schedule; tenant A's data is untouched.
      const bList = await req(app, 'GET', '/shows', tenantB);
      expect(bList.json.data).toEqual([]);
      const aShow = await req(app, 'GET', `/shows/${showId}`, tenantA);
      expect(aShow.json.data.status).toBe('planned');
      expect(aShow.json.data.notes).toBeNull();
    });
  });
});
