import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@blacklabel/db';
import { asCoreDb, createTenant } from '@blacklabel/core';
import type { ChannelProvider } from '@blacklabel/messaging';
import { createApp, type PlatformDatabase } from '../src/app';
import { businessReviewProvider } from '../src/business-reviews';

async function fixture(provider?: ChannelProvider) {
  const db=createTestDb<PlatformDatabase>(), messaging=provider?{providers:{email:provider}}:{};
  const platform=await createApp({db,messaging,disableRateLimit:true,includeCheckoutSimulator:false});
  const tenant=(await createTenant(asCoreDb(db),{name:'Review delivery fixture'})).id;
  const other=(await createTenant(asCoreDb(db),{name:'Other review company'})).id;
  const {ownerUserId}=await platform.seedTenant(tenant);
  const data=async(route:string,method='GET',body?:unknown)=>{const response=await platform.app.request('/api/'+route,{method,headers:{'x-tenant-id':tenant,'x-user-id':ownerUserId,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});expect(response.status,await response.clone().text()).toBeLessThan(300);return(await response.json() as any).data;};
  await data('messaging/channels','POST',{type:'email',name:'Fixture sender',address:'sender@example.test'});
  const customer=await data('crm/customers','POST',{name:'Fixture customer',email:'customer@example.test'});
  const request=await data('reviews/requests','POST',{customerId:customer.id});
  const context={tenantId:tenant,customerId:customer.id,requestId:request.id,link:`/api/reviews/public/requests/${request.token}`};
  const reviews=businessReviewProvider(db,platform.events,messaging,()=> 'https://company.example.test');
  return{db,platform,tenant,other,data,customer,request,context,reviews,close:async()=>{platform.detachEngine();await db.destroy();}};
}

describe('installed business review delivery boundary',()=>{
 it('uses one stable email submission and distinguishes accepted from delivered',async()=>{
  const send=vi.fn(async()=>({status:'sent' as const,providerMessageId:'provider-review-fixture'}));const f=await fixture({type:'email',send});
  try{
   const first=await f.reviews.sendReviewRequest(f.context),second=await f.reviews.sendReviewRequest(f.context);
   expect(first).toEqual(second);expect(first.submitted).toBe(true);expect(first.delivered).toBe(false);expect(send).toHaveBeenCalledTimes(1);
   const messages=await f.db.selectFrom('messaging_messages').selectAll().where('tenant_id','=',f.tenant).execute();expect(messages).toHaveLength(1);expect(messages[0].body).toContain('https://company.example.test/review#'+f.request.token);expect(messages[0].to_address).toBe('customer@example.test');
   await expect(f.reviews.sendReviewRequest({...f.context,tenantId:f.other})).rejects.toThrow('Customer not found');expect(send).toHaveBeenCalledTimes(1);
  }finally{await f.close();}
 });
 it('retains an ambiguous submission and never resends it',async()=>{
  const send=vi.fn(async()=>{throw Error('lost provider response');});const f=await fixture({type:'email',send});
  try{await expect(f.reviews.sendReviewRequest(f.context)).rejects.toThrow();await expect(f.reviews.sendReviewRequest(f.context)).rejects.toThrow();expect(send).toHaveBeenCalledTimes(1);}finally{await f.close();}
 });
 it('requires a customer-reachable HTTPS link before submitting',async()=>{
  const send=vi.fn(async()=>({status:'sent' as const,providerMessageId:'fixture'}));const f=await fixture({type:'email',send});
  try{const unconfigured=businessReviewProvider(f.db,f.platform.events,{providers:{email:{type:'email',send}}},()=>undefined);await expect(unconfigured.sendReviewRequest(f.context)).rejects.toThrow('public HTTPS');expect(send).not.toHaveBeenCalled();}finally{await f.close();}
 });
 it('completing a CRM job triggers its configured workflow once',async()=>{
  const f=await fixture();try{
   await f.data('workflows','POST',{name:'Completed-job follow-up',triggerEvent:'crm.job.completed',actions:[{type:'create_task',config:{title:'Verify completed customer job',relatedEntityType:'crm.job',relatedEntityId:'{{payload.jobId}}'}}]});
   const job=await f.data('crm/jobs','POST',{title:'Fixture completed visit',customer_id:f.customer.id,status:'in_progress'});
   await f.data(`crm/jobs/${job.id}`,'PATCH',{status:'completed'});await f.platform.engine.runPending({tenantId:f.tenant});
   let tasks=await f.data('workflows/tasks');expect(tasks).toHaveLength(1);expect(tasks[0].relatedEntityId).toBe(job.id);
   await f.data(`crm/jobs/${job.id}`,'PATCH',{status:'completed'});await f.platform.engine.runPending({tenantId:f.tenant});tasks=await f.data('workflows/tasks');expect(tasks).toHaveLength(1);
  }finally{await f.close();}
 });
});
