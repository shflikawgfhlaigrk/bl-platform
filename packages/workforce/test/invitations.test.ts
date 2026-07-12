import { describe, expect, it } from 'vitest';
import { asCoreDb, listAuditEntries } from '@blacklabel/core';
import { body, get, post, seed, setup } from './helpers';

describe('workforce invitations — hash-only token round-trip', () => {
  it('returns the raw token once, stores only the sha256 hash', async () => {
    const ctx = await setup();
    const { roleIds } = await seed(ctx, ctx.tenantA);
    const res = await post(ctx, ctx.tenantA, '/invitations', {
      email: 'New@Person.com',
      roleId: roleIds.cashier,
    });
    expect(res.status).toBe(201);
    const inv = (await body(res)).data;
    expect(inv.token).toBeTruthy();
    expect(inv.email).toBe('new@person.com'); // normalized
    expect(inv.token_hash).toBeUndefined(); // never surfaced at the boundary

    const stored = await ctx.db
      .selectFrom('workforce_invitations')
      .selectAll()
      .where('id', '=', inv.id)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).not.toBe(inv.token); // hashed at rest
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);

    // list never surfaces the hash either
    const list = (await body(await get(ctx, ctx.tenantA, '/invitations'))).data;
    expect(list[0].token_hash).toBeUndefined();
  });

  it('accepts with the correct token exactly once (single-use)', async () => {
    const ctx = await setup();
    const { roleIds } = await seed(ctx, ctx.tenantA);
    const inv = (await body(
      await post(ctx, ctx.tenantA, '/invitations', { email: 'a@b.com', roleId: roleIds.manager }),
    )).data;

    const ok = await post(ctx, ctx.tenantA, `/invitations/${inv.id}/accept`, { token: inv.token });
    expect(ok.status).toBe(200);
    const accepted = (await body(ok)).data;
    expect(accepted.roleId).toBe(roleIds.manager);
    expect(accepted.invitation.accepted_at).toBeTruthy();

    // Second accept with the same token → 409 (already accepted).
    const again = await post(ctx, ctx.tenantA, `/invitations/${inv.id}/accept`, {
      token: inv.token,
    });
    expect(again.status).toBe(409);
  });

  it('rejects a wrong token (401)', async () => {
    const ctx = await setup();
    const { roleIds } = await seed(ctx, ctx.tenantA);
    const inv = (await body(
      await post(ctx, ctx.tenantA, '/invitations', { email: 'a@b.com', roleId: roleIds.cashier }),
    )).data;
    const res = await post(ctx, ctx.tenantA, `/invitations/${inv.id}/accept`, {
      token: 'deadbeef',
    });
    expect(res.status).toBe(401);
  });

  it('revoked invitation cannot be accepted (409); revoke is audited', async () => {
    const ctx = await setup();
    const { roleIds } = await seed(ctx, ctx.tenantA);
    const inv = (await body(
      await post(ctx, ctx.tenantA, '/invitations', { email: 'a@b.com', roleId: roleIds.cashier }),
    )).data;
    const rev = await post(ctx, ctx.tenantA, `/invitations/${inv.id}/revoke`);
    expect(rev.status).toBe(200);
    expect((await body(rev)).data.revoked).toBe(true);

    const res = await post(ctx, ctx.tenantA, `/invitations/${inv.id}/accept`, { token: inv.token });
    expect(res.status).toBe(409);

    const audits = await listAuditEntries(
      asCoreDb(ctx.db),
      ctx.tenantA,
      'workforce.invitation',
      inv.id,
    );
    expect(audits.map((a) => a.action)).toContain('workforce.invitation.revoked');
  });

  it('expired invitation cannot be accepted (409)', async () => {
    const ctx = await setup();
    const { roleIds } = await seed(ctx, ctx.tenantA);
    const inv = (await body(
      await post(ctx, ctx.tenantA, '/invitations', {
        email: 'a@b.com',
        roleId: roleIds.cashier,
        expiresInHours: 1,
      }),
    )).data;
    // Force expiry in the past.
    await ctx.db
      .updateTable('workforce_invitations')
      .set({ expires_at: '2000-01-01T00:00:00.000Z' })
      .where('id', '=', inv.id)
      .execute();
    const res = await post(ctx, ctx.tenantA, `/invitations/${inv.id}/accept`, { token: inv.token });
    expect(res.status).toBe(409);
  });

  it('is tenant-scoped: tenant B cannot accept tenant A invitation', async () => {
    const ctx = await setup();
    const { roleIds } = await seed(ctx, ctx.tenantA);
    await seed(ctx, ctx.tenantB);
    const inv = (await body(
      await post(ctx, ctx.tenantA, '/invitations', { email: 'a@b.com', roleId: roleIds.cashier }),
    )).data;
    const res = await post(ctx, ctx.tenantB, `/invitations/${inv.id}/accept`, { token: inv.token });
    expect(res.status).toBe(404);
  });
});
