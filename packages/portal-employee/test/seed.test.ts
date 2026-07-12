import { describe, expect, it } from 'vitest';
import { seedPortalEmployee } from '@blacklabel/portal-employee';
import { body, get, setup } from './helpers';

describe('seedPortalEmployee', () => {
  it('seeds a working demo tenant (employees, tokens, shifts, assignments, checklist)', async () => {
    const ctx = await setup();
    const seeded = await seedPortalEmployee(ctx.db, ctx.tenantA, ctx.events);

    // Tokens actually authenticate against the portal
    const me = await get(ctx.app, ctx.tenantA, '/portal/me', seeded.fieldWorkerToken);
    expect(me.status).toBe(200);
    expect((await body(me)).data.id).toBe(seeded.fieldWorkerId);

    const managerMe = await get(ctx.app, ctx.tenantA, '/portal/me', seeded.managerToken);
    expect((await body(managerMe)).data.role).toBe('manager');

    // Assignments exist and cover both field-service and media kinds
    const all = (await body(await get(ctx.app, ctx.tenantA, '/assignments'))).data;
    expect(all.length).toBe(2);
    const kinds = all.map((a: any) => a.kind).sort();
    expect(kinds).toEqual(['content_shoot', 'service_visit']);

    // Checklist instantiated on the field job
    const checklists = (await body(
      await get(ctx.app, ctx.tenantA, `/assignments/${seeded.assignmentIds[0]}/checklists`),
    )).data;
    expect(checklists).toHaveLength(1);
    expect(checklists[0].items.length).toBeGreaterThan(0);

    // Shifts exist
    const shifts = (await body(await get(ctx.app, ctx.tenantA, '/shifts'))).data;
    expect(shifts).toHaveLength(2);

    // Seeded data is invisible to tenant B
    expect((await body(await get(ctx.app, ctx.tenantB, '/employees'))).data).toEqual([]);
    expect((await body(await get(ctx.app, ctx.tenantB, '/assignments'))).data).toEqual([]);
  });
});
