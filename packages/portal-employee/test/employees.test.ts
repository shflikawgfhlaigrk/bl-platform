import { describe, expect, it } from 'vitest';
import { body, del, get, patch, post, setup } from './helpers';

describe('employee profile CRUD (router)', () => {
  it('creates, reads, updates, and deletes an employee', async () => {
    const ctx = await setup();
    const { app, tenantA } = ctx;

    const created = await post(app, tenantA, '/employees', {
      name: 'Riley Ortiz',
      email: 'Riley@Example.com',
      role: 'worker',
      title: 'technician',
    });
    expect(created.status).toBe(201);
    const employee = (await body(created)).data;
    expect(employee.name).toBe('Riley Ortiz');
    expect(employee.email).toBe('riley@example.com'); // normalized
    expect(employee.role).toBe('worker');
    expect(employee.active).toBe(true); // boolean at the service boundary

    const fetched = await get(app, tenantA, `/employees/${employee.id}`);
    expect(fetched.status).toBe(200);
    expect((await body(fetched)).data.id).toBe(employee.id);

    const listed = await get(app, tenantA, '/employees');
    expect(listed.status).toBe(200);
    const list = await body(listed);
    expect(list.data).toHaveLength(1);
    expect(list.limit).toBe(50);
    expect(list.offset).toBe(0);

    const updated = await patch(app, tenantA, `/employees/${employee.id}`, {
      title: 'senior technician',
      active: false,
    });
    expect(updated.status).toBe(200);
    const patched = (await body(updated)).data;
    expect(patched.title).toBe('senior technician');
    expect(patched.active).toBe(false);

    const deleted = await del(app, tenantA, `/employees/${employee.id}`);
    expect(deleted.status).toBe(200);
    const gone = await get(app, tenantA, `/employees/${employee.id}`);
    expect(gone.status).toBe(404);
  });

  it('rejects invalid input with 400', async () => {
    const ctx = await setup();
    const res = await post(ctx.app, ctx.tenantA, '/employees', { name: '', email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe('validation_error');
  });

  it('emits portal_employee.employee.created', async () => {
    const ctx = await setup();
    const seen: any[] = [];
    ctx.events.on('portal_employee.employee.created', (e) => {
      seen.push(e);
    });
    const res = await post(ctx.app, ctx.tenantA, '/employees', {
      name: 'Casey',
      email: 'casey@example.com',
    });
    const employee = (await body(res)).data;
    expect(seen).toHaveLength(1);
    expect(seen[0].tenantId).toBe(ctx.tenantA);
    expect(seen[0].payload).toEqual({ employeeId: employee.id, role: 'worker' });
  });

  it('denies cross-tenant reads/updates/deletes and leaves data intact', async () => {
    const ctx = await setup();
    const { app, tenantA, tenantB } = ctx;
    const created = await post(app, tenantA, '/employees', {
      name: 'Only In A',
      email: 'a@example.com',
    });
    const employee = (await body(created)).data;

    // tenant B: read -> 404, list -> empty
    expect((await get(app, tenantB, `/employees/${employee.id}`)).status).toBe(404);
    expect((await body(await get(app, tenantB, '/employees'))).data).toEqual([]);

    // tenant B: update -> 404, delete -> 404
    expect((await patch(app, tenantB, `/employees/${employee.id}`, { name: 'Hacked' })).status).toBe(404);
    expect((await del(app, tenantB, `/employees/${employee.id}`)).status).toBe(404);

    // tenant A untouched
    const still = (await body(await get(app, tenantA, `/employees/${employee.id}`))).data;
    expect(still.name).toBe('Only In A');
  });

  it('requires the x-tenant-id header', async () => {
    const ctx = await setup();
    const res = await ctx.app.request('/employees');
    expect(res.status).toBe(400);
  });
});
