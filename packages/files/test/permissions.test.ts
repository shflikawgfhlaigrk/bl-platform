import { describe, expect, it } from 'vitest';
import { headers, setup, uploadViaApi } from './helpers';

/**
 * Permission model under test (spec): owner/admin full access; the uploader
 * owns their file; everyone else needs a grant (role or user principal).
 * `visibility: tenant|public` opens READ only.
 */
describe('file permissions', () => {
  async function privateFileSetup() {
    const ctx = await setup();
    const { file } = await uploadViaApi(ctx.app, ctx.tenantA.id, {
      name: 'payroll.xlsx',
      mime: 'application/vnd.ms-excel',
      content: 'sensitive numbers',
      userId: ctx.users.member1.id, // member1 is the uploader
      visibility: 'private',
    });
    return { ...ctx, file };
  }

  it('owner and admin have full access; uploader owns their file', async () => {
    const { app, tenantA, users, file } = await privateFileSetup();
    for (const userId of [users.owner.id, users.admin.id, users.member1.id]) {
      const read = await app.request(`/files/${file.id}`, { headers: headers(tenantA.id, userId) });
      expect(read.status).toBe(200);
    }
    // uploader can write too
    const patch = await app.request(`/files/${file.id}`, {
      method: 'PATCH',
      headers: headers(tenantA.id, users.member1.id),
      body: JSON.stringify({ tags: ['payroll'] }),
    });
    expect(patch.status).toBe(200);
  });

  it('denies a member without a grant (403) on read, content, and writes', async () => {
    const { app, tenantA, users, file } = await privateFileSetup();
    const h2 = headers(tenantA.id, users.member2.id);

    expect((await app.request(`/files/${file.id}`, { headers: h2 })).status).toBe(403);
    expect((await app.request(`/files/${file.id}/content`, { headers: h2 })).status).toBe(403);
    expect(
      (
        await app.request(`/files/${file.id}`, {
          method: 'PATCH',
          headers: h2,
          body: JSON.stringify({ name: 'renamed.xlsx' }),
        })
      ).status,
    ).toBe(403);
    expect((await app.request(`/files/${file.id}`, { method: 'DELETE', headers: h2 })).status).toBe(403);
    // permission management is write-level too
    expect((await app.request(`/files/${file.id}/permissions`, { headers: h2 })).status).toBe(403);
  });

  it('a user grant opens read; write still requires can_write', async () => {
    const { app, tenantA, users, file, emitted } = await privateFileSetup();
    const hAdmin = headers(tenantA.id, users.admin.id);
    const h2 = headers(tenantA.id, users.member2.id);

    const grantRes = await app.request(`/files/${file.id}/permissions`, {
      method: 'POST',
      headers: hAdmin,
      body: JSON.stringify({ grantee_type: 'user', grantee: users.member2.id }),
    });
    expect(grantRes.status).toBe(201);
    const grant = ((await grantRes.json()) as any).data;

    expect((await app.request(`/files/${file.id}`, { headers: h2 })).status).toBe(200);
    expect((await app.request(`/files/${file.id}/content`, { headers: h2 })).status).toBe(200);
    // read-only grant: writes still denied
    expect(
      (
        await app.request(`/files/${file.id}`, {
          method: 'PATCH',
          headers: h2,
          body: JSON.stringify({ name: 'x.xlsx' }),
        })
      ).status,
    ).toBe(403);

    // event asserted
    const granted = emitted.filter((e) => e.type === 'files.permission.granted');
    expect(granted).toHaveLength(1);
    expect(granted[0].payload).toMatchObject({
      fileId: file.id,
      permissionId: grant.id,
      granteeType: 'user',
      grantee: users.member2.id,
      canWrite: false,
    });

    // revoke -> denied again
    const revoke = await app.request(`/files/${file.id}/permissions/${grant.id}`, {
      method: 'DELETE',
      headers: hAdmin,
    });
    expect(revoke.status).toBe(200);
    expect((await app.request(`/files/${file.id}`, { headers: h2 })).status).toBe(403);
    expect(emitted.filter((e) => e.type === 'files.permission.revoked')).toHaveLength(1);
  });

  it('a role grant with can_write allows member mutations', async () => {
    const { app, tenantA, users, file } = await privateFileSetup();
    const hOwner = headers(tenantA.id, users.owner.id);
    const h2 = headers(tenantA.id, users.member2.id);

    const grantRes = await app.request(`/files/${file.id}/permissions`, {
      method: 'POST',
      headers: hOwner,
      body: JSON.stringify({ grantee_type: 'role', grantee: 'member', can_write: true }),
    });
    expect(grantRes.status).toBe(201);

    const patch = await app.request(`/files/${file.id}`, {
      method: 'PATCH',
      headers: h2,
      body: JSON.stringify({ tags: ['shared'] }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as any).data.tags).toEqual(['shared']);
  });

  it('tenant visibility opens read (not write) to all tenant members', async () => {
    const ctx = await setup();
    const { file } = await uploadViaApi(ctx.app, ctx.tenantA.id, {
      name: 'handbook.pdf',
      mime: 'application/pdf',
      content: 'welcome',
      userId: ctx.users.member1.id,
      visibility: 'tenant',
    });
    const h2 = headers(ctx.tenantA.id, ctx.users.member2.id);
    expect((await ctx.app.request(`/files/${file.id}`, { headers: h2 })).status).toBe(200);
    expect(
      (
        await ctx.app.request(`/files/${file.id}`, {
          method: 'PATCH',
          headers: h2,
          body: JSON.stringify({ name: 'nope.pdf' }),
        })
      ).status,
    ).toBe(403);
  });

  it('scopes GET /files for members: private files hidden until granted', async () => {
    const { app, tenantA, users, file } = await privateFileSetup();
    const h2 = headers(tenantA.id, users.member2.id);

    const before = ((await (await app.request('/files', { headers: h2 })).json()) as any).data;
    expect(before.map((f: any) => f.id)).not.toContain(file.id);

    await app.request(`/files/${file.id}/permissions`, {
      method: 'POST',
      headers: headers(tenantA.id, users.admin.id),
      body: JSON.stringify({ grantee_type: 'user', grantee: users.member2.id }),
    });

    const after = ((await (await app.request('/files', { headers: h2 })).json()) as any).data;
    expect(after.map((f: any) => f.id)).toContain(file.id);

    // admins see everything
    const adminList = ((await (
      await app.request('/files', { headers: headers(tenantA.id, users.admin.id) })
    ).json()) as any).data;
    expect(adminList.map((f: any) => f.id)).toContain(file.id);
  });

  it('validates grants: unknown role, unknown user, duplicates', async () => {
    const { app, tenantA, users, file } = await privateFileSetup();
    const hAdmin = headers(tenantA.id, users.admin.id);
    const grant = (body: unknown) =>
      app.request(`/files/${file.id}/permissions`, {
        method: 'POST',
        headers: hAdmin,
        body: JSON.stringify(body),
      });

    expect((await grant({ grantee_type: 'role', grantee: 'superuser' })).status).toBe(400);
    expect((await grant({ grantee_type: 'user', grantee: 'no-such-user' })).status).toBe(400);
    expect((await grant({ grantee_type: 'role', grantee: 'member' })).status).toBe(201);
    expect((await grant({ grantee_type: 'role', grantee: 'member' })).status).toBe(409);
  });

  it('only the initiator (or admins) can complete an upload session', async () => {
    const { app, tenantA, users } = await setup();
    const initRes = await app.request('/uploads', {
      method: 'POST',
      headers: headers(tenantA.id, users.member1.id),
      body: JSON.stringify({ name: 'mine.txt', mime: 'text/plain' }),
    });
    const session = ((await initRes.json()) as any).data;

    const hijack = await app.request(`/uploads/${session.id}/complete`, {
      method: 'POST',
      headers: headers(tenantA.id, users.member2.id),
      body: JSON.stringify({ content_base64: Buffer.from('gotcha').toString('base64') }),
    });
    expect(hijack.status).toBe(403);

    const legit = await app.request(`/uploads/${session.id}/complete`, {
      method: 'POST',
      headers: headers(tenantA.id, users.member1.id),
      body: JSON.stringify({ content_base64: Buffer.from('mine').toString('base64') }),
    });
    expect(legit.status).toBe(201);
    expect(((await legit.json()) as any).data.uploaded_by).toBe(users.member1.id);
  });
});
