import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { listAuditEntries, asCoreDb } from '@blacklabel/core';
import { b64, headers, setup, uploadViaApi } from './helpers';

describe('folders', () => {
  it('creates nested folders and returns them as a tree', async () => {
    const { app, tenantA } = await setup();
    const h = headers(tenantA.id);

    const rootRes = await app.request('/folders', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ name: 'Documents' }),
    });
    expect(rootRes.status).toBe(201);
    const root = ((await rootRes.json()) as any).data;

    const childRes = await app.request('/folders', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ name: 'Contracts', parent_id: root.id }),
    });
    expect(childRes.status).toBe(201);
    const child = ((await childRes.json()) as any).data;
    expect(child.parent_id).toBe(root.id);

    const treeRes = await app.request('/folders/tree', { headers: h });
    expect(treeRes.status).toBe(200);
    const tree = ((await treeRes.json()) as any).data;
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe(root.id);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].id).toBe(child.id);

    const listRes = await app.request('/folders', { headers: h });
    const list = (await listRes.json()) as any;
    expect(list.data).toHaveLength(2);
    expect(list.limit).toBe(50);
    expect(list.offset).toBe(0);
  });

  it('rejects moving a folder into its own subtree (cycle)', async () => {
    const { app, tenantA } = await setup();
    const h = headers(tenantA.id);
    const a = ((await (
      await app.request('/folders', { method: 'POST', headers: h, body: JSON.stringify({ name: 'A' }) })
    ).json()) as any).data;
    const b = ((await (
      await app.request('/folders', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ name: 'B', parent_id: a.id }),
      })
    ).json()) as any).data;

    // A -> child of B (B is inside A) = cycle
    const moveRes = await app.request(`/folders/${a.id}`, {
      method: 'PATCH',
      headers: h,
      body: JSON.stringify({ parent_id: b.id }),
    });
    expect(moveRes.status).toBe(400);

    // self-parent also rejected
    const selfRes = await app.request(`/folders/${a.id}`, {
      method: 'PATCH',
      headers: h,
      body: JSON.stringify({ parent_id: a.id }),
    });
    expect(selfRes.status).toBe(400);
  });

  it('refuses to delete a non-empty folder, allows deleting a leaf', async () => {
    const { app, tenantA } = await setup();
    const h = headers(tenantA.id);
    const parent = ((await (
      await app.request('/folders', { method: 'POST', headers: h, body: JSON.stringify({ name: 'P' }) })
    ).json()) as any).data;
    const leaf = ((await (
      await app.request('/folders', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ name: 'L', parent_id: parent.id }),
      })
    ).json()) as any).data;

    const delParent = await app.request(`/folders/${parent.id}`, { method: 'DELETE', headers: h });
    expect(delParent.status).toBe(409);

    const delLeaf = await app.request(`/folders/${leaf.id}`, { method: 'DELETE', headers: h });
    expect(delLeaf.status).toBe(200);

    const delParentNow = await app.request(`/folders/${parent.id}`, { method: 'DELETE', headers: h });
    expect(delParentNow.status).toBe(200);
  });

  it('refuses to delete a folder targeted by a pending upload (no dangling folder_id)', async () => {
    const { app, tenantA } = await setup();
    const h = headers(tenantA.id);
    const folder = ((await (
      await app.request('/folders', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Inbox' }) })
    ).json()) as any).data;

    const session = ((await (
      await app.request('/uploads', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ name: 'pending.txt', mime: 'text/plain', folder_id: folder.id }),
      })
    ).json()) as any).data;

    // pending session blocks the delete
    const blocked = await app.request(`/folders/${folder.id}`, { method: 'DELETE', headers: h });
    expect(blocked.status).toBe(409);

    // completing the session lands the file in a folder that still exists
    const completed = await app.request(`/uploads/${session.id}/complete`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ content_base64: b64('made it') }),
    });
    expect(completed.status).toBe(201);
    expect(((await completed.json()) as any).data.folder_id).toBe(folder.id);

    // aborting a fresh session unblocks the delete (once the folder is empty)
    const session2 = ((await (
      await app.request('/uploads', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ name: 'pending2.txt', mime: 'text/plain', folder_id: folder.id }),
      })
    ).json()) as any).data;
    await app.request(`/uploads/${session2.id}/abort`, { method: 'POST', headers: h });
    const file = ((await (
      await app.request('/files?folder_id=' + folder.id, { headers: h })
    ).json()) as any).data[0];
    await app.request(`/files/${file.id}`, { method: 'DELETE', headers: h });
    const delNow = await app.request(`/folders/${folder.id}`, { method: 'DELETE', headers: h });
    expect(delNow.status).toBe(200);
  });
});

describe('upload sessions (init -> complete)', () => {
  it('runs the two-step flow: metadata, sha256, size, download, session state, event', async () => {
    const { app, tenantA, emitted, users } = await setup();
    const h = headers(tenantA.id);
    const content = 'hello vault world';

    const initRes = await app.request('/uploads', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ name: 'notes.txt', mime: 'text/plain', tags: ['Important'] }),
    });
    expect(initRes.status).toBe(201);
    const session = ((await initRes.json()) as any).data;
    expect(session.status).toBe('pending');

    const completeRes = await app.request(`/uploads/${session.id}/complete`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ content_base64: b64(content) }),
    });
    expect(completeRes.status).toBe(201);
    const file = ((await completeRes.json()) as any).data;

    expect(file.name).toBe('notes.txt');
    expect(file.mime).toBe('text/plain');
    expect(file.size_bytes).toBe(Buffer.byteLength(content));
    expect(file.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(file.tags).toEqual(['important']); // normalized lowercase
    expect(file.uploaded_by).toBe(users.owner.id); // signed fixture user, never implicit system

    // session flipped to completed and points at the file
    const sessRes = await app.request(`/uploads/${session.id}`, { headers: h });
    const sess = ((await sessRes.json()) as any).data;
    expect(sess.status).toBe('completed');
    expect(sess.file_id).toBe(file.id);
    expect(sess.completed_at).toBeTruthy();

    // content downloads byte-for-byte with the right mime
    const dl = await app.request(`/files/${file.id}/content`, { headers: h });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('text/plain');
    expect(await dl.text()).toBe(content);

    // event emitted with full payload
    const uploaded = emitted.filter((e) => e.type === 'files.file.uploaded');
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].tenantId).toBe(tenantA.id);
    expect(uploaded[0].payload).toMatchObject({
      fileId: file.id,
      name: 'notes.txt',
      mime: 'text/plain',
      sizeBytes: file.size_bytes,
      sha256: file.sha256,
    });
  });

  it('rejects double-complete and complete-after-abort', async () => {
    const { app, tenantA } = await setup();
    const h = headers(tenantA.id);
    const { session } = await uploadViaApi(app, tenantA.id, {
      name: 'once.txt',
      mime: 'text/plain',
      content: 'x',
    });
    const again = await app.request(`/uploads/${session.id}/complete`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ content_base64: b64('y') }),
    });
    expect(again.status).toBe(409);

    // fresh session: abort then complete
    const init2 = ((await (
      await app.request('/uploads', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ name: 'aborted.txt', mime: 'text/plain' }),
      })
    ).json()) as any).data;
    const abortRes = await app.request(`/uploads/${init2.id}/abort`, { method: 'POST', headers: h });
    expect(abortRes.status).toBe(200);
    expect(((await abortRes.json()) as any).data.status).toBe('aborted');
    const lateComplete = await app.request(`/uploads/${init2.id}/complete`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ content_base64: b64('z') }),
    });
    expect(lateComplete.status).toBe(409);
  });

  it('rejects unsafe filenames and bad mime types', async () => {
    const { app, tenantA } = await setup();
    const h = headers(tenantA.id);
    const bad = async (name: string, mime = 'text/plain') =>
      (
        await app.request('/uploads', {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ name, mime }),
        })
      ).status;

    expect(await bad('a/b.txt')).toBe(400);
    expect(await bad('..\\evil.txt')).toBe(400);
    expect(await bad('..')).toBe(400);
    expect(await bad('../../../etc/passwd')).toBe(400);
    expect(await bad('nul\u0000byte.txt')).toBe(400);
    expect(await bad('ok.txt', 'not a mime')).toBe(400);
    expect(await bad('ok.txt', 'text/')).toBe(400);
  });
});

describe('secrets stay out of responses and URLs', () => {
  it('never exposes storage_key; storage key is never derived from the filename', async () => {
    const { app, db, tenantA } = await setup();
    const h = headers(tenantA.id);

    const initRes = await app.request('/uploads', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ name: 'secretreport.pdf', mime: 'application/pdf' }),
    });
    const initText = await initRes.text();
    expect(initText).not.toContain('storage_key');
    const session = (JSON.parse(initText) as any).data;

    const completeRes = await app.request(`/uploads/${session.id}/complete`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ content_base64: b64('classified') }),
    });
    const completeText = await completeRes.text();
    expect(completeText).not.toContain('storage_key');
    const file = (JSON.parse(completeText) as any).data;

    // Fetch the real key straight from the DB and prove it appears nowhere.
    const row = await db
      .selectFrom('files_assets')
      .select(['storage_key'])
      .where('tenant_id', '=', tenantA.id)
      .where('id', '=', file.id)
      .executeTakeFirstOrThrow();
    expect(row.storage_key.length).toBeGreaterThanOrEqual(32);
    expect(row.storage_key).not.toContain('secretreport'); // not filename-derived
    expect(initText).not.toContain(row.storage_key);
    expect(completeText).not.toContain(row.storage_key);

    const getText = await (await app.request(`/files/${file.id}`, { headers: h })).text();
    const listText = await (await app.request('/files', { headers: h })).text();
    const sessText = await (await app.request(`/uploads/${session.id}`, { headers: h })).text();
    for (const text of [getText, listText, sessText]) {
      expect(text).not.toContain('storage_key');
      expect(text).not.toContain(row.storage_key);
    }

    // The download URL is id-based — no key, no filename.
    const parsed = JSON.parse(getText) as any;
    expect(parsed.data.download_path).toBe(`/files/${file.id}/content`);
  });
});

describe('files: metadata, search, tags', () => {
  it('updates metadata and searches by name/mime/tag/linked entity', async () => {
    const { app, tenantA } = await setup();
    const h = headers(tenantA.id);
    const { file: report } = await uploadViaApi(app, tenantA.id, {
      name: 'annual-report.pdf',
      mime: 'application/pdf',
      content: 'report body',
      tags: ['finance'],
    });
    const { file: photo } = await uploadViaApi(app, tenantA.id, {
      name: 'site-photo.png',
      mime: 'image/png',
      content: 'png bytes',
    });

    // PATCH: rename + retag
    const patchRes = await app.request(`/files/${report.id}`, {
      method: 'PATCH',
      headers: h,
      body: JSON.stringify({ name: 'annual-report-final.pdf', tags: ['finance', 'archived'] }),
    });
    expect(patchRes.status).toBe(200);
    const updated = ((await patchRes.json()) as any).data;
    expect(updated.name).toBe('annual-report-final.pdf');
    expect(updated.tags).toEqual(['finance', 'archived']);

    // by name substring
    const byName = ((await (
      await app.request('/files?name=final', { headers: h })
    ).json()) as any).data;
    expect(byName.map((f: any) => f.id)).toEqual([report.id]);

    // by mime
    const byMime = ((await (
      await app.request('/files?mime=image/png', { headers: h })
    ).json()) as any).data;
    expect(byMime.map((f: any) => f.id)).toEqual([photo.id]);

    // by tag
    const byTag = ((await (
      await app.request('/files?tag=archived', { headers: h })
    ).json()) as any).data;
    expect(byTag.map((f: any) => f.id)).toEqual([report.id]);
    const byMissingTag = ((await (
      await app.request('/files?tag=nope', { headers: h })
    ).json()) as any).data;
    expect(byMissingTag).toEqual([]);

    // by linked entity
    await app.request(`/files/${report.id}/links`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ entity_type: 'billing.invoice', entity_id: 'inv-123' }),
    });
    const byEntity = ((await (
      await app.request('/files?entity_type=billing.invoice&entity_id=inv-123', { headers: h })
    ).json()) as any).data;
    expect(byEntity.map((f: any) => f.id)).toEqual([report.id]);

    // entity_type without entity_id -> 400
    const halfRef = await app.request('/files?entity_type=billing.invoice', { headers: h });
    expect(halfRef.status).toBe(400);

    // sort whitelist enforced
    const badSort = await app.request('/files?sort=storage_key', { headers: h });
    expect(badSort.status).toBe(400);
  });
});

describe('links: attach/detach + queries', () => {
  it('attaches, lists, queries by entity, rejects duplicates, detaches — with events', async () => {
    const { app, tenantA, emitted, users } = await setup();
    const h = headers(tenantA.id);
    const { file } = await uploadViaApi(app, tenantA.id, {
      name: 'signed-quote.pdf',
      mime: 'application/pdf',
      content: 'quote',
    });

    const attachRes = await app.request(`/files/${file.id}/links`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ entity_type: 'quoting.quote', entity_id: 'q-42' }),
    });
    expect(attachRes.status).toBe(201);
    const link = ((await attachRes.json()) as any).data;
    expect(link.entity_type).toBe('quoting.quote');

    const dup = await app.request(`/files/${file.id}/links`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ entity_type: 'quoting.quote', entity_id: 'q-42' }),
    });
    expect(dup.status).toBe(409);

    const links = ((await (
      await app.request(`/files/${file.id}/links`, { headers: h })
    ).json()) as any).data;
    expect(links).toHaveLength(1);

    const forEntity = ((await (
      await app.request('/links?entity_type=quoting.quote&entity_id=q-42', { headers: h })
    ).json()) as any).data;
    expect(forEntity.map((f: any) => f.id)).toEqual([file.id]);

    const linkedEvents = emitted.filter((e) => e.type === 'files.file.linked');
    expect(linkedEvents).toHaveLength(1);
    expect(linkedEvents[0].payload).toMatchObject({
      fileId: file.id,
      entityType: 'quoting.quote',
      entityId: 'q-42',
    });

    const detach = await app.request(`/files/${file.id}/links/${link.id}`, {
      method: 'DELETE',
      headers: h,
    });
    expect(detach.status).toBe(200);
    const afterDetach = ((await (
      await app.request('/links?entity_type=quoting.quote&entity_id=q-42', { headers: h })
    ).json()) as any).data;
    expect(afterDetach).toEqual([]);
    expect(emitted.filter((e) => e.type === 'files.file.unlinked')).toHaveLength(1);

    // invalid entity_type rejected
    const badType = await app.request(`/files/${file.id}/links`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ entity_type: 'DROP TABLE;', entity_id: 'x' }),
    });
    expect(badType.status).toBe(400);
  });
});

describe('delete', () => {
  it('removes metadata, links, permissions and the stored object; emits event', async () => {
    const { app, db, tenantA, storage, emitted, users } = await setup();
    const h = headers(tenantA.id);
    const { file } = await uploadViaApi(app, tenantA.id, {
      name: 'temp.txt',
      mime: 'text/plain',
      content: 'bye',
    });
    await app.request(`/files/${file.id}/links`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ entity_type: 'crm.customer', entity_id: 'c-1' }),
    });
    await app.request(`/files/${file.id}/permissions`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ grantee_type: 'user', grantee: users.member1.id }),
    });

    const row = await db
      .selectFrom('files_assets')
      .select('storage_key')
      .where('tenant_id', '=', tenantA.id)
      .where('id', '=', file.id)
      .executeTakeFirstOrThrow();
    expect(await storage.exists(row.storage_key)).toBe(true);

    const del = await app.request(`/files/${file.id}`, { method: 'DELETE', headers: h });
    expect(del.status).toBe(200);

    expect((await app.request(`/files/${file.id}`, { headers: h })).status).toBe(404);
    expect((await app.request(`/files/${file.id}/content`, { headers: h })).status).toBe(404);
    expect(await storage.exists(row.storage_key)).toBe(false);
    expect(
      await db.selectFrom('files_links').selectAll().where('tenant_id', '=', tenantA.id).execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom('files_permissions')
        .selectAll()
        .where('tenant_id', '=', tenantA.id)
        .execute(),
    ).toEqual([]);
    expect(emitted.filter((e) => e.type === 'files.file.deleted')).toHaveLength(1);
  });
});

describe('audit log', () => {
  it('records every mutation and serves the file trail over HTTP', async () => {
    const { app, db, tenantA } = await setup();
    const h = headers(tenantA.id);
    const { file } = await uploadViaApi(app, tenantA.id, {
      name: 'audited.txt',
      mime: 'text/plain',
      content: 'a',
    });
    await app.request(`/files/${file.id}`, {
      method: 'PATCH',
      headers: h,
      body: JSON.stringify({ name: 'audited-2.txt' }),
    });

    const entries = await listAuditEntries(asCoreDb(db), tenantA.id, 'files.file', file.id);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('files.file.uploaded');
    expect(actions).toContain('files.file.updated');

    const viaHttp = ((await (
      await app.request(`/files/${file.id}/audit`, { headers: h })
    ).json()) as any).data;
    expect(viaHttp.length).toBe(entries.length);
  });
});

describe('tenant isolation (denial tests)', () => {
  it('tenant B gets 404/empty on every read and 404 on every mutation of A data — and A is untouched', async () => {
    const { app, tenantA, tenantB } = await setup();
    const hA = headers(tenantA.id);
    const hB = headers(tenantB.id);

    const folder = ((await (
      await app.request('/folders', {
        method: 'POST',
        headers: hA,
        body: JSON.stringify({ name: 'A-only' }),
      })
    ).json()) as any).data;
    const { session, file } = await uploadViaApi(app, tenantA.id, {
      name: 'a-secret.txt',
      mime: 'text/plain',
      content: 'tenant A data',
      folder_id: folder.id,
    });
    const link = ((await (
      await app.request(`/files/${file.id}/links`, {
        method: 'POST',
        headers: hA,
        body: JSON.stringify({ entity_type: 'crm.customer', entity_id: 'c-9' }),
      })
    ).json()) as any).data;

    // B reads: empty / 404
    expect(((await (await app.request('/files', { headers: hB })).json()) as any).data).toEqual([]);
    expect(((await (await app.request('/folders', { headers: hB })).json()) as any).data).toEqual([]);
    expect(
      ((await (
        await app.request('/links?entity_type=crm.customer&entity_id=c-9', { headers: hB })
      ).json()) as any).data,
    ).toEqual([]);
    expect((await app.request(`/files/${file.id}`, { headers: hB })).status).toBe(404);
    expect((await app.request(`/files/${file.id}/content`, { headers: hB })).status).toBe(404);
    expect((await app.request(`/uploads/${session.id}`, { headers: hB })).status).toBe(404);

    // B mutations: 404
    expect(
      (
        await app.request(`/files/${file.id}`, {
          method: 'PATCH',
          headers: hB,
          body: JSON.stringify({ name: 'stolen.txt' }),
        })
      ).status,
    ).toBe(404);
    expect((await app.request(`/files/${file.id}`, { method: 'DELETE', headers: hB })).status).toBe(404);
    expect(
      (await app.request(`/folders/${folder.id}`, { method: 'DELETE', headers: hB })).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/files/${file.id}/links/${link.id}`, { method: 'DELETE', headers: hB })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/files/${file.id}/links`, {
          method: 'POST',
          headers: hB,
          body: JSON.stringify({ entity_type: 'crm.customer', entity_id: 'c-10' }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/uploads/${session.id}/complete`, {
          method: 'POST',
          headers: hB,
          body: JSON.stringify({ content_base64: b64('overwrite!') }),
        })
      ).status,
    ).toBe(404);

    // B mutations on folders, sessions, permissions, audit: 404 (regression —
    // every lookup filters tenant_id)
    expect(
      (
        await app.request(`/folders/${folder.id}`, {
          method: 'PATCH',
          headers: hB,
          body: JSON.stringify({ name: 'hijacked' }),
        })
      ).status,
    ).toBe(404);
    expect((await app.request(`/uploads/${session.id}/abort`, { method: 'POST', headers: hB })).status).toBe(
      404,
    );
    expect((await app.request(`/files/${file.id}/audit`, { headers: hB })).status).toBe(404);
    expect((await app.request(`/files/${file.id}/links`, { headers: hB })).status).toBe(404);
    expect((await app.request(`/files/${file.id}/permissions`, { headers: hB })).status).toBe(404);
    expect(
      (
        await app.request(`/files/${file.id}/permissions`, {
          method: 'POST',
          headers: hB,
          body: JSON.stringify({ grantee_type: 'role', grantee: 'member' }),
        })
      ).status,
    ).toBe(404);
    // a real grant created by A cannot be revoked by B
    const permA = ((await (
      await app.request(`/files/${file.id}/permissions`, {
        method: 'POST',
        headers: hA,
        body: JSON.stringify({ grantee_type: 'role', grantee: 'member' }),
      })
    ).json()) as any).data;
    expect(
      (
        await app.request(`/files/${file.id}/permissions/${permA.id}`, {
          method: 'DELETE',
          headers: hB,
        })
      ).status,
    ).toBe(404);
    // B's folder tree is empty
    expect(
      ((await (await app.request('/folders/tree', { headers: hB })).json()) as any).data,
    ).toEqual([]);

    // A's data is fully intact
    const fileA = ((await (await app.request(`/files/${file.id}`, { headers: hA })).json()) as any)
      .data;
    expect(fileA.name).toBe('a-secret.txt');
    expect(await (await app.request(`/files/${file.id}/content`, { headers: hA })).text()).toBe(
      'tenant A data',
    );
    const linksA = ((await (
      await app.request(`/files/${file.id}/links`, { headers: hA })
    ).json()) as any).data;
    expect(linksA).toHaveLength(1);
    const permsA = ((await (
      await app.request(`/files/${file.id}/permissions`, { headers: hA })
    ).json()) as any).data;
    expect(permsA).toHaveLength(1); // B's revoke attempt did nothing
  });

  it('requires the x-tenant-id header and rejects unknown tenants', async () => {
    const { app, tenantA } = await setup();
    expect((await app.request('/files')).status).toBe(400);
    expect((await app.request('/files', { headers: { 'x-tenant-id': 'ghost' } })).status).toBe(404);
    expect((await app.request('/files', { headers: { 'x-tenant-id': tenantA.id } })).status).toBe(200);
  });

  it('rejects an x-user-id that does not belong to the tenant (401)', async () => {
    const { app, tenantA, tenantB, db } = await setup();
    // a user of tenant B may not act inside tenant A
    const { createUser } = await import('@blacklabel/core');
    const bUser = await createUser(asCoreDb(db), tenantB.id, {
      name: 'B User',
      email: 'b@b.test',
      role: 'owner',
    });
    const res = await app.request('/files', { headers: headers(tenantA.id, bUser.id) });
    expect(res.status).toBe(401);
  });
});
