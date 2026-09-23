import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@blacklabel/db';
import { asCoreDb, createTenant, createUser, id, nowIso } from '@blacklabel/core';
import { createApp, type PlatformApp, type PlatformDatabase } from '../src/app';
import { identityCredentials } from '../src/identity';
const key=Buffer.alloc(32,37);
const instances: PlatformApp[]=[];
afterEach(async()=>{for(const p of instances.splice(0)){p.detachEngine();await p.db.destroy();}});
async function setup(){
 const db=createTestDb<PlatformDatabase>();
 const p=await createApp({db,identityKey:key,disableRateLimit:true});instances.push(p);
 const a=await createTenant(asCoreDb(db),{name:'A'}),b=await createTenant(asCoreDb(db),{name:'B'});
 const owner=(await p.seedTenant(a.id)).ownerUserId;
 const other=(await p.seedTenant(b.id)).ownerUserId;
 const staff=await createUser(asCoreDb(db),a.id,{name:'Cashier',email:'cashier@synthetic.invalid',role:'member'});
 const role=await db.selectFrom('workforce_roles').select('id').where('tenant_id','=',a.id).where('key','=','cashier').executeTakeFirstOrThrow();
 await db.insertInto('workforce_user_roles').values({id:id(),tenant_id:a.id,user_id:staff.id,role_id:role.id,created_at:nowIso()}).execute();
 const headers=async(userId=owner,tenantId=a.id)=>({authorization:'Bearer '+await p.issueCredential(tenantId,userId),'content-type':'application/json'});
 return {p,a,b,owner,other,staff,headers};
}
describe('F064 signed identity on assembled API',()=>{
 it('missing/blank/spoofed user headers grant no identity or system file access',async()=>{
  const {p,a,owner}=await setup();
  for(const h of [{},{'x-user-id':''},{'x-user-id':owner}]){
   for(const path of ['/api/admin/credentials','/api/files/files','/api/inventory/locations']){
    expect((await p.app.request(path,{headers:{'x-tenant-id':a.id,...h}})).status).toBe(401);
   }
  }
 });
 it('dropping the user header preserves cashier restrictions and cannot become owner',async()=>{
  const {p,a,owner,staff,headers}=await setup();
  const h=await headers(staff.id);
  expect((await p.app.request('/api/admin/credentials',{headers:h})).status).toBe(403);
  expect((await p.app.request('/api/admin/credentials',{headers:{...h,'x-user-id':owner}})).status).toBe(403);
  expect((await p.app.request('/api/admin/credentials',{headers:await headers()})).status).toBe(200);
  expect((await p.app.request('/api/identity',{headers:h})).status).toBe(200);
  expect((await p.app.request('/api/identity',{headers:{...h,'x-tenant-id':'other'}})).status).toBe(403);
 });
 it('private uploads stay private while legitimate owner upload/download works',async()=>{
  const {p,staff,headers}=await setup();const ownerHeaders=await headers();
  const create=await p.app.request('/api/files/uploads',{method:'POST',headers:ownerHeaders,body:JSON.stringify({name:'private.txt',mime:'text/plain',visibility:'private'})});
  expect(create.status).toBe(201);const session=(await create.json() as any).data;
  const complete=await p.app.request(`/api/files/uploads/${session.id}/complete`,{method:'POST',headers:ownerHeaders,body:JSON.stringify({content_base64:Buffer.from('synthetic private bytes').toString('base64')})});
  expect(complete.status).toBe(201);const file=(await complete.json() as any).data;
  const path=`/api/files/files/${file.id}/content`;
  expect((await p.app.request(path,{headers:await headers(staff.id)})).status).toBe(403);
  expect((await p.app.request(path)).status).toBe(401);
  const ok=await p.app.request(path,{headers:ownerHeaders});expect(ok.status).toBe(200);expect(await ok.text()).toBe('synthetic private bytes');
 });
 it('rejects expiry, tampering, different issuer, removed user, and forced session invalidation',async()=>{
  const {p,a,staff,headers}=await setup();
  const old=identityCredentials(key).issue(a.id,staff.id,Date.now()-3600_001);
  const foreign=identityCredentials(Buffer.alloc(32,99)).issue(a.id,staff.id);
  const h=await headers(staff.id);
  for(const token of [old,foreign,h.authorization.slice(7)+'x']) expect((await p.app.request('/api/identity',{headers:{authorization:'Bearer '+token}})).status).toBe(401);
  const now=new Date(Date.now()+10).toISOString();
  await p.db.insertInto('workforce_session_policies').values({id:id(),tenant_id:a.id,max_age_hours:1,sessions_invalidated_after:now,created_at:now,updated_at:now}).execute();
  expect((await p.app.request('/api/identity',{headers:h})).status).toBe(401);
  await p.db.deleteFrom('workforce_session_policies').where('tenant_id','=',a.id).execute();
  await asCoreDb(p.db).deleteFrom('users').where('id','=',staff.id).execute();
  expect((await p.app.request('/api/identity',{headers:h})).status).toBe(401);
 });
 it('keeps independently authenticated public flows available without staff credentials',async()=>{
  const {p}=await setup();
  expect((await p.app.request('/api/health')).status).toBe(200);
  expect((await p.app.request('/api/reviews/public/requests/missing')).status).toBe(404);
  expect((await p.app.request('/api/portal-customer/accounts')).status).toBe(401);
 });
});
