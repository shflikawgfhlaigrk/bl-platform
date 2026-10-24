import { afterEach, expect, it } from 'vitest';
import { setup, type TestContext } from './helpers';
const contexts:TestContext[]=[];afterEach(async()=>{for(const c of contexts.splice(0))await c.db.destroy();});
async function fixture(){const c=await setup();contexts.push(c);return c;}
async function upload(c:TestContext,name:string,visibility='private'){
 const headers={'x-tenant-id':c.tenantA.id,'x-user-id':c.users.owner.id,'content-type':'application/json'};
 const started=await c.app.request('/uploads',{method:'POST',headers,body:JSON.stringify({name,mime:'text/plain',visibility})});
 const session=(await started.json() as any).data;
 const saved=await c.app.request(`/uploads/${session.id}/complete`,{method:'POST',headers,body:JSON.stringify({content_base64:Buffer.from('Original evidence bytes.').toString('base64')})});
 const file=(await saved.json() as any).data;
 expect(saved.status).toBe(201);
 expect((await c.app.request(`/files/${file.id}/links`,{method:'POST',headers,body:JSON.stringify({entity_type:'crm.job',entity_id:'fixture-job'})})).status).toBe(201);
 return {file,headers};
}
it('exports exact accessible originals and no private storage identifiers or other tenant records',async()=>{
 const c=await fixture(),{file,headers}=await upload(c,'Before.txt');
 const response=await c.app.request('/evidence?entity_type=crm.job&entity_id=fixture-job',{headers});
 expect(response.status).toBe(200);const text=await response.text();expect(text).not.toContain('storage_key');
 const packet=JSON.parse(text).data;expect(packet.originalBytesVerified).toBe(true);expect(packet.files).toHaveLength(1);
 expect(Buffer.from(packet.files[0].contentBase64,'base64').toString()).toBe('Original evidence bytes.');
 expect(packet.files[0].sha256).toBe(file.sha256);
 const member=await c.app.request('/evidence?entity_type=crm.job&entity_id=fixture-job',{headers:{...headers,'x-user-id':c.users.member1.id}});
 expect((await member.json() as any).data.files).toEqual([]);
 const other=await c.app.request('/evidence?entity_type=crm.job&entity_id=fixture-job',{headers:{'x-tenant-id':c.tenantB.id}});
 expect((await other.json() as any).data.files).toEqual([]);
});
it('rejects corruption on download and on evidence export rather than returning altered originals',async()=>{
 const c=await fixture(),{file,headers}=await upload(c,'Original.txt');
 const row=await c.db.selectFrom('files_assets').selectAll().where('tenant_id','=',c.tenantA.id).where('id','=',file.id).executeTakeFirstOrThrow();
 await c.storage.put(row.storage_key,Buffer.from('Corrupt evidence bytes.'));
 expect((await c.app.request(`/files/${file.id}/content`,{headers})).status).toBe(409);
 expect((await c.app.request('/evidence?entity_type=crm.job&entity_id=fixture-job',{headers})).status).toBe(409);
});
