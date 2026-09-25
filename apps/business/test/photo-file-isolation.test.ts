import { afterEach, expect, it, vi } from 'vitest';
import { asCoreDb, createTenant, id, nowIso } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { MemoryStorageProvider } from '@blacklabel/files';
import { createApp, type PlatformDatabase } from '../../api/src/app';
import { businessEmployeeFiles } from '../../api/src/business-wiring';
import { createBusinessApp } from '../src/app';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(f => f())); });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

async function fixture() {
  const db = createTestDb<PlatformDatabase>(), storage = new MemoryStorageProvider();
  let app: ReturnType<typeof createBusinessApp>;
  const platform = await createApp({ db, storage, businessPortals: true, disableRateLimit: true, includeCheckoutSimulator: false,
    browserSessionUser: async request => app?.resolveOwnerRequest(request) });
  cleanups.push(async () => { platform.detachEngine(); await db.destroy(); });
  const tenantId = (await createTenant(asCoreDb(db), { name: 'Photo ACL fixture' })).id;
  const { ownerUserId } = await platform.seedTenant(tenantId);
  const employeeFiles = businessEmployeeFiles(db, platform.events, storage);
  app = createBusinessApp({ platform, tenantId, ownerUserId, accessToken: 'fixture-owner', version: 'fixture', employeeFiles,
    settings: async () => ({ companyName: 'fixture' }), saveSettings: async () => {}, asset: async () => new Uint8Array() });
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string) => app.request(`https://photos.test/api/${path}`, {
    method, headers: { host: 'photos.test', origin: 'https://photos.test', 'sec-fetch-site': 'same-origin',
      ...(cookie ? { cookie } : { authorization: 'Bearer fixture-owner' }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = async (path: string, method = 'GET', body?: unknown, cookie?: string) => {
    const res = await request(path, method, body, cookie); const json = await res.json() as any;
    expect(res.status, JSON.stringify(json)).toBeLessThan(300); return json.data;
  };
  const employee = async (name: string) => {
    const user = await data('portal-employee/employees', 'POST', { name, email: `${name}@local.invalid`, role: 'worker' });
    const issued = await data(`portal-employee/employees/${user.id}/tokens`, 'POST', {});
    const login = await request('business/team/login', 'POST', { token: issued.token }); expect(login.status).toBe(200);
    const assignment = await data('portal-employee/assignments', 'POST', { employeeId: user.id, kind: 'job', title: `${name} job` });
    return { ...user, issued, assignment, cookie: login.headers.get('set-cookie')!.split(';')[0] };
  };
  const a = await employee('alice'), b = await employee('bob');
  const session = await data('files/uploads', 'POST', { name: 'owner-private.txt', mime: 'text/plain', visibility: 'private' });
  const privateFile = await data(`files/uploads/${session.id}/complete`, 'POST', { content_base64: Buffer.from('OWNER PRIVATE CONTENT').toString('base64') });
  const injectPhoto = async (fileId: string, employeeId = a.id, assignmentId = a.assignment.id) => {
    await db.insertInto('portal_employee_job_photos').values({ id: id(), tenant_id: tenantId, assignment_id: assignmentId, employee_id: employeeId, file_id: fileId, caption: 'legacy forged reference', created_at: nowIso() }).execute();
  };
  return { db, storage, tenantId, request, data, a, b, privateFile, injectPhoto, employeeFiles };
}

it('rejects reference-only photo attachment without granting a new sharing relation', async () => {
  const { db, request, a, privateFile } = await fixture();
  const before = await db.selectFrom('portal_employee_job_photos').selectAll().execute();
  const res = await request(`portal-employee/portal/assignments/${a.assignment.id}/photos`, 'POST', { fileId: privateFile.id }, a.cookie);
  expect(res.status).toBe(400);
  expect(await db.selectFrom('portal_employee_job_photos').selectAll().execute()).toEqual(before);
});

it('a legacy employee-written photo row cannot expose an owner-private file', async () => {
  const { request, storage, a, privateFile, injectPhoto } = await fixture();
  await injectPhoto(privateFile.id); const get = vi.spyOn(storage, 'get');
  const res = await request(`business/team/assignments/${a.assignment.id}/photos/${privateFile.id}`, 'GET', undefined, a.cookie);
  expect(res.status).toBe(404); expect(get).not.toHaveBeenCalled(); expect(await res.text()).not.toContain('OWNER PRIVATE CONTENT');
});

it('a generic file link does not convert a private owner file into an employee upload', async () => {
  const { request, data, storage, a, privateFile, injectPhoto } = await fixture();
  await injectPhoto(privateFile.id);
  await data(`files/files/${privateFile.id}/links`, 'POST', { entity_type: 'portal_employee.assignment', entity_id: a.assignment.id });
  const get = vi.spyOn(storage, 'get');
  expect((await request(`business/team/assignments/${a.assignment.id}/photos/${privateFile.id}`, 'GET', undefined, a.cookie)).status).toBe(404);
  expect(get).not.toHaveBeenCalled();
});

it('a photo uploaded for another assignment cannot be reattached through a forged row', async () => {
  const { request, data, a, b, injectPhoto } = await fixture();
  const uploaded = await data(`business/team/assignments/${b.assignment.id}/photos`, 'POST', { name: 'bob.png', mime: 'image/png', contentBase64: PNG.toString('base64') }, b.cookie);
  await injectPhoto(uploaded.photo.file_id, b.id);
  expect((await request(`business/team/assignments/${a.assignment.id}/photos/${uploaded.photo.file_id}`, 'GET', undefined, a.cookie)).status).toBe(404);
});

it('authenticated new uploads remain downloadable and enforce worker, tenant and revocation boundaries', async () => {
  const { db, request, data, a, b, tenantId, employeeFiles } = await fixture();
  const uploaded = await data(`business/team/assignments/${a.assignment.id}/photos`, 'POST', { name: 'alice.png', mime: 'image/png', contentBase64: PNG.toString('base64'), caption: 'after' }, a.cookie);
  const path = `business/team/assignments/${a.assignment.id}/photos/${uploaded.photo.file_id}`;
  const own = await request(path, 'GET', undefined, a.cookie); expect(own.status).toBe(200); expect(Buffer.from(await own.arrayBuffer())).toEqual(PNG);
  expect((await request(path, 'GET', undefined, b.cookie)).status).toBe(403);
  expect((await request(path, 'GET', undefined, 'unrelated=fixture')).status).toBe(401);
  const foreign = await createTenant(asCoreDb(db), { name: 'foreign photo fixture' });
  await expect(employeeFiles.read({ tenantId: foreign.id, token: a.issued.token, assignmentId: a.assignment.id, fileId: uploaded.photo.file_id })).rejects.toMatchObject({ status: 401 });
  const links = await db.selectFrom('files_links').selectAll().where('tenant_id', '=', tenantId).where('file_id', '=', uploaded.photo.file_id).execute();
  expect(links).toHaveLength(1);
  await data(`portal-employee/tokens/${a.issued.id}`, 'DELETE');
  expect((await request(path, 'GET', undefined, a.cookie)).status).toBe(401);
});
