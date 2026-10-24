import { afterEach, expect, it } from 'vitest';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createApp, type PlatformDatabase } from '../../api/src/app';
import { createBusinessApp } from '../src/app';
import { businessIntegrationMigrations, customerRecordIntegration } from '../src/integrations';

const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function fixture(){
  const db=createTestDb<PlatformDatabase>(),platform=await createApp({db,disableRateLimit:true,includeCheckoutSimulator:false});
  cleanup.push(async()=>{platform.detachEngine();await db.destroy();});
  await runMigrations(db,businessIntegrationMigrations);await runMigrations(db,businessIntegrationMigrations);
  const tenant=(await createTenant(asCoreDb(db),{name:'Existing systems fixture'})).id;
  const owner=await platform.seedTenant(tenant);
  const integration=customerRecordIntegration(db,platform.events,tenant,owner.ownerUserId);
  return {db,platform,tenant,owner,integration};
}
const records={source:'existing-crm',records:[{externalId:'c-23',name:'Fixture customer',email:'fixture@example.test',phone:'555-fixture'}]};
it('previews without writes, imports with receipt, and replays after connection loss without duplicate records',async()=>{
  const f=await fixture();let events=0;f.platform.events.on('crm.customer.created',()=>{events++;});
  const p=await f.integration.preview(records);expect(p.canApply).toBe(true);expect(p.sourceWrites).toBe(false);
  expect(await f.db.selectFrom('crm_customers').selectAll().where('tenant_id','=',f.tenant).execute()).toHaveLength(0);
  const body={...records,previewHash:p.previewHash,idempotencyKey:'fixture-import-1'};
  const a=await f.integration.apply(body),b=await f.integration.apply(body);
  expect(a.replayed).toBe(false);expect(b.replayed).toBe(true);expect(a.id).toBe(b.id);expect(events).toBe(1);
  expect(await f.db.selectFrom('crm_customers').selectAll().where('tenant_id','=',f.tenant).execute()).toHaveLength(1);
  expect(await f.integration.receipts()).toHaveLength(1);
  await expect(f.integration.apply({...body,records:[{...records.records[0],name:'Different'}]})).rejects.toThrow('different records');
});
it('updates source-owned fields but preserves omitted fields and refuses changed local data or stale preview',async()=>{
  const f=await fixture(),first=await f.integration.preview(records);
  const receipt=await f.integration.apply({...records,previewHash:first.previewHash,idempotencyKey:'fixture-initial'});
  const changed={source:records.source,records:[{externalId:'c-23',name:'Updated name'}]};
  const p=await f.integration.preview(changed);expect(p.rows[0].action).toBe('update');expect(p.rows[0].after.phone).toBe('555-fixture');
  await f.integration.apply({...changed,previewHash:p.previewHash,idempotencyKey:'fixture-update'});
  const customerId=receipt.imported[0].customerId;
  await f.db.updateTable('crm_customers').set({name:'Local owner edit'}).where('tenant_id','=',f.tenant).where('id','=',customerId).execute();
  expect((await f.integration.preview(changed)).rows[0].action).toBe('unchanged');
  const sourceChanged={...changed,records:[{externalId:'c-23',name:'New source edit'}]};
  const conflict=await f.integration.preview(sourceChanged);expect(conflict.canApply).toBe(false);
  const keep={...sourceChanged,records:[{...sourceChanged.records[0],resolution:'keep-local'}]};
  const reviewed=await f.integration.preview(keep);expect(reviewed.canApply).toBe(true);
  await f.integration.apply({...keep,previewHash:reviewed.previewHash,idempotencyKey:'fixture-resolve-local'});
  expect((await f.integration.preview(sourceChanged)).rows[0].action).toBe('unchanged');
  await expect(f.integration.apply({...changed,previewHash:p.previewHash,idempotencyKey:'fixture-stale'})).rejects.toThrow('changed after preview');
  expect((await f.db.selectFrom('crm_customers').selectAll().where('tenant_id','=',f.tenant).where('id','=',customerId).executeTakeFirst())!.name).toBe('Local owner edit');
});
it('requires explicit same-company identity mapping and atomically rejects duplicates and conflicts',async()=>{
  const f=await fixture();const foreign=(await createTenant(asCoreDb(f.db),{name:'Foreign fixture'})).id;
  const other=customerRecordIntegration(f.db,f.platform.events,foreign,'system');
  const p=await other.preview(records),r=await other.apply({...records,previewHash:p.previewHash,idempotencyKey:'foreign-initial'});
  await expect(f.integration.preview({source:'foreign-export',records:[{...records.records[0],localId:r.imported[0].customerId}]})).rejects.toThrow('missing from this company');
  const good=await f.integration.preview(records);await f.integration.apply({...records,previewHash:good.previewHash,idempotencyKey:'company-initial'});
  const duplicate=await f.integration.preview({source:'second-export',records:records.records});expect(duplicate.rows[0].action).toBe('conflict');
  await expect(f.integration.preview({source:'duplicates',records:[records.records[0],records.records[0]]})).rejects.toThrow('unique externalId');
  expect(await f.integration.receipts()).toHaveLength(1);
  expect(await other.receipts()).toHaveLength(1);
});
it('owner-authenticates preview/apply and binds tenant against forged headers; no new external credentials are needed',async()=>{
  const f=await fixture();const app=createBusinessApp({platform:f.platform,tenantId:f.tenant,ownerUserId:f.owner.ownerUserId,
    accessToken:'fixture-owner-key',settings:async()=>({companyName:'Fixture'}),saveSettings:async()=>{},asset:async()=>new Uint8Array(),
    version:'fixture',customerRecords:f.integration,purchasedModules:['quoting']});
  const request=(route:string,body?:unknown,headers:Record<string,string>={})=>app.request(`/api/business/${route}`,{
    method:body===undefined?'GET':'POST',headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  expect((await request('integrations/customers/preview',records)).status).toBe(401);
  const login=await request('login',{token:'fixture-owner-key'});const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const preview=await request('integrations/customers/preview',records,{cookie,'x-tenant-id':'forged'});expect(preview.status).toBe(200);
  const value=(await preview.json() as any).data;
  expect((await request('integrations/customers/apply',{...records,previewHash:value.previewHash,idempotencyKey:'bound-import'},{cookie})).status).toBe(200);
  expect((await f.db.selectFrom('crm_customers').selectAll().where('tenant_id','=',f.tenant).execute()).length).toBe(1);
});
