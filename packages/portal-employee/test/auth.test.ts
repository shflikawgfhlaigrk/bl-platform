import { describe, expect, it } from 'vitest';
import { body, del, get, makeEmployee, patch, post, setup } from './helpers';

describe('token-based employee auth (middleware)', () => {
  it('401 when no token is provided', async () => {
    const ctx = await setup();
    const res = await get(ctx.app, ctx.tenantA, '/portal/me');
    expect(res.status).toBe(401);
    expect((await body(res)).error.code).toBe('unauthorized');
  });

  it('401 for an unknown token', async () => {
    const ctx = await setup();
    const res = await get(ctx.app, ctx.tenantA, '/portal/me', 'not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('resolves a valid token to the employee (header and ?token= query)', async () => {
    const ctx = await setup();
    const { employeeId, token } = await makeEmployee(ctx, ctx.tenantA, {
      name: 'Riley',
      email: 'riley@example.com',
    });

    const viaHeader = await get(ctx.app, ctx.tenantA, '/portal/me', token);
    expect(viaHeader.status).toBe(200);
    expect((await body(viaHeader)).data.id).toBe(employeeId);

    const viaQuery = await get(ctx.app, ctx.tenantA, `/portal/me?token=${token}`);
    expect(viaQuery.status).toBe(200);
    expect((await body(viaQuery)).data.id).toBe(employeeId);
  });

  it('401 after the token is revoked', async () => {
    const ctx = await setup();
    const created = await post(ctx.app, ctx.tenantA, '/employees', {
      name: 'Riley',
      email: 'riley@example.com',
    });
    const employee = (await body(created)).data;
    const issued = await post(ctx.app, ctx.tenantA, `/employees/${employee.id}/tokens`, {});
    const token = (await body(issued)).data;

    expect((await get(ctx.app, ctx.tenantA, '/portal/me', token.token)).status).toBe(200);
    expect((await del(ctx.app, ctx.tenantA, `/tokens/${token.id}`)).status).toBe(200);
    expect((await get(ctx.app, ctx.tenantA, '/portal/me', token.token)).status).toBe(401);
  });

  it('401 for an expired token', async () => {
    const ctx = await setup();
    const created = await post(ctx.app, ctx.tenantA, '/employees', {
      name: 'Riley',
      email: 'riley@example.com',
    });
    const employee = (await body(created)).data;
    const issued = await post(ctx.app, ctx.tenantA, `/employees/${employee.id}/tokens`, {
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    const token = (await body(issued)).data;
    expect((await get(ctx.app, ctx.tenantA, '/portal/me', token.token)).status).toBe(401);
  });

  it('401 for a deactivated employee', async () => {
    const ctx = await setup();
    const { employeeId, token } = await makeEmployee(ctx, ctx.tenantA, {
      name: 'Riley',
      email: 'riley@example.com',
    });
    await patch(ctx.app, ctx.tenantA, `/employees/${employeeId}`, { active: false });
    expect((await get(ctx.app, ctx.tenantA, '/portal/me', token)).status).toBe(401);
  });

  it("tenant isolation: tenant A's token is useless under tenant B", async () => {
    const ctx = await setup();
    const { token } = await makeEmployee(ctx, ctx.tenantA, {
      name: 'Riley',
      email: 'riley@example.com',
    });
    const res = await get(ctx.app, ctx.tenantB, '/portal/me', token);
    expect(res.status).toBe(401);
  });
});
