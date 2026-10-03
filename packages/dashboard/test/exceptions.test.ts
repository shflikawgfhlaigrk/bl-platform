import { afterEach, describe, expect, it } from 'vitest';
import { asCoreDb, coreMigrations, createTenant, EventBus } from '@blacklabel/core';
import { createTestDb, runMigrations, type Kysely } from '@blacklabel/db';
import { billingMigrations, billingRouter, type BillingDatabase } from '@blacklabel/billing';
import { ownerExceptionQueue, type ExceptionDatabase, type OwnerExceptionQueue } from '../src/exceptions';
import { dashboardMigrations } from '../src/migrations';
import { dashboardRouter } from '../src/router';
import type { DashboardDatabase } from '../src/schema';

const OLD='2026-01-01T00:00:00.000Z', FUTURE='2100-01-01T00:00:00.000Z';
const databases: Kysely<unknown>[]=[];
afterEach(async()=>{for(const db of databases.splice(0))await db.destroy();});

async function setup(allSources=true) {
  const db=createTestDb<ExceptionDatabase>();databases.push(db as Kysely<unknown>);
  await runMigrations(db,[...coreMigrations,...dashboardMigrations]);
  const a=await createTenant(asCoreDb(db),{name:'Synthetic A'}),b=await createTenant(asCoreDb(db),{name:'Synthetic B'});
  if(allSources){
    const tables: Record<string,string[]>={
      billing_invoices:['number','status','total_cents','paid_cents','due_at','source_entity_type','source_entity_id','created_at','updated_at'],
      quoting_quotes:['title','status','created_at','updated_at'],crm_jobs:['title','status','created_at','updated_at'],
      quoting_conversions:['job_id','invoice_id','created_at'],
      workflows_executions:['workflow_id','status','started_at','finished_at','next_retry_at'],
      messaging_conversations:['subject','status','assigned_user_id','updated_at','created_at'],
      messaging_messages:['conversation_id','direction','status','seq','created_at'],
      portal_employee_assignments:['title','status','scheduled_at','updated_at'],
      portal_employee_checklists:['assignment_id'],portal_employee_checklist_items:['checklist_id','checked','checked_at','created_at'],
      portal_employee_exceptions:['assignment_id','checklist_item_id','status','resolution_kind'],
      portal_employee_time_entries:['employee_id','clock_in_at','clock_out_at','assignment_id','review_status','created_at'],
    };
    for(const [name,columns] of Object.entries(tables)){
      let query=db.schema.createTable(name).addColumn('id','text',c=>c.primaryKey()).addColumn('tenant_id','text',c=>c.notNull());
      for(const column of columns)query=query.addColumn(column,column.endsWith('_cents')||['seq','checked'].includes(column)?'integer':'text');
      await query.execute();
    }
  }
  const app=dashboardRouter({db:db as unknown as Kysely<DashboardDatabase>,events:new EventBus(),contracts:{}});
  return {db,a,b,app};
}
const invoice=(id:string,tenantId:string,status='sent')=>({id,tenant_id:tenantId,number:id,status,total_cents:10501,paid_cents:501,due_at:OLD,source_entity_type:null,source_entity_id:null,created_at:OLD,updated_at:OLD});

describe('owner exception queue',()=>{
  it('reads all categories, scopes every source and linkage to the tenant, and excludes paid/draft/void balances',async()=>{
    const {db,a,b,app}=await setup();
    for(const tenant of [a,b]){
      await db.insertInto('billing_invoices').values([invoice(`${tenant.id}-due`,tenant.id),invoice(`${tenant.id}-paid`,tenant.id,'paid'),invoice(`${tenant.id}-draft`,tenant.id,'draft'),invoice(`${tenant.id}-void`,tenant.id,'void')]).execute();
      await db.insertInto('quoting_quotes').values({id:`${tenant.id}-quote`,tenant_id:tenant.id,title:'Sent estimate',status:'sent',created_at:OLD,updated_at:OLD}).execute();
      await db.insertInto('crm_jobs').values({id:`${tenant.id}-job`,tenant_id:tenant.id,title:'Completed work',status:'completed',created_at:OLD,updated_at:OLD}).execute();
      await db.insertInto('workflows_executions').values({id:`${tenant.id}-execution`,tenant_id:tenant.id,workflow_id:'Synthetic workflow',status:'failed',started_at:OLD,finished_at:OLD,next_retry_at:null}).execute();
      await db.insertInto('messaging_conversations').values({id:`${tenant.id}-thread`,tenant_id:tenant.id,subject:'Needs an owner',status:'open',assigned_user_id:null,created_at:OLD,updated_at:OLD}).execute();
      await db.insertInto('portal_employee_assignments').values({id:`${tenant.id}-crew`,tenant_id:tenant.id,title:'Incomplete work',status:'assigned',scheduled_at:OLD,updated_at:OLD}).execute();
    }
    // A foreign tenant's invoice must never appear to resolve A's completed job.
    await db.insertInto('billing_invoices').values({...invoice('foreign-link',b.id),source_entity_type:'crm.job',source_entity_id:`${a.id}-job`}).execute();
    const response=await app.request('/exceptions?tenant_id='+b.id,{headers:{'x-tenant-id':a.id}});
    expect(response.status).toBe(200);
    const {data}=await response.json() as {data:OwnerExceptionQueue};
    expect(data.completeness).toBe('complete');expect(data.total).toBe(6);
    expect(data.items.every((item:{source:{entityId:string}})=>item.source.entityId.startsWith(a.id))).toBe(true);
    expect(data.items.find((item:{kind:string})=>item.kind==='overdue_balance')!.balanceCents).toBe(10000);
    expect(data.items.some((item:{source:{entityId:string}})=>item.source.entityId.endsWith('-paid'))).toBe(false);
    expect(data.freshnessScope).toBe('local_database');expect(data.externalFreshness).toBe('not_verified');
    expect(Date.parse(data.staleAt)-Date.parse(data.sampledAt)).toBe(300000);
  });

  it('does exact stable pagination without truncating the source scan',async()=>{
    const {db,a,app}=await setup();
    await db.insertInto('billing_invoices').values(Array.from({length:237},(_,index)=>invoice(`invoice-${String(index).padStart(3,'0')}`,a.id))).execute();
    const pages=[];
    for(let offset=0;offset<237;offset+=100){
      const {data}=await (await app.request(`/exceptions?limit=100&offset=${offset}`,{headers:{'x-tenant-id':a.id}})).json() as {data:OwnerExceptionQueue};
      expect(data.total).toBe(237);expect(data.hasMore).toBe(offset<200);pages.push(...data.items.map((row:{id:string})=>row.id));
    }
    expect(pages).toHaveLength(237);expect(new Set(pages).size).toBe(237);
    expect((await ownerExceptionQueue(db,a.id,{limit:25,offset:1000})).items).toEqual([]);
    expect((await app.request('/exceptions?kind=nonsense',{headers:{'x-tenant-id':a.id}})).status).toBe(400);
    expect((await app.request('/exceptions')).status).toBe(400);
    expect((await app.request('/exceptions',{headers:{'x-tenant-id':'unknown'}})).status).toBe(404);
  });

  it('only clears an inbox item after ownership and an actual recorded sent reply, not queued/failed/foreign replies',async()=>{
    const {db,a,b}=await setup();
    await db.insertInto('messaging_conversations').values({id:'thread',tenant_id:a.id,subject:'Question',status:'open',assigned_user_id:'worker',created_at:OLD,updated_at:OLD}).execute();
    const message=(id:string,tenantId:string,direction:string,status:string,seq:number)=>({id,tenant_id:tenantId,conversation_id:'thread',direction,status,seq,created_at:OLD});
    await db.insertInto('messaging_messages').values([message('in',a.id,'in','received',1),message('queued',a.id,'out','queued',2),message('failed',a.id,'out','failed',3),message('foreign',b.id,'out','sent',99)]).execute();
    expect((await ownerExceptionQueue(db,a.id)).total).toBe(1);
    await db.insertInto('messaging_messages').values(message('sent',a.id,'out','sent',4)).execute();
    expect((await ownerExceptionQueue(db,a.id)).total).toBe(0);
    await db.updateTable('messaging_conversations').set({assigned_user_id:null}).where('tenant_id','=',a.id).where('id','=','thread').execute();
    expect((await ownerExceptionQueue(db,a.id)).total).toBe(1);
    await db.updateTable('messaging_conversations').set({status:'closed'}).where('tenant_id','=',a.id).where('id','=','thread').execute();
    expect((await ownerExceptionQueue(db,a.id)).total).toBe(0);
  });

  it('uses explicit job provenance and conversion linkage, excluding void and foreign invoices',async()=>{
    const {db,a,b}=await setup();
    await db.insertInto('crm_jobs').values(['direct','converted','void','foreign'].map(id=>({id,tenant_id:a.id,title:id,status:'completed',created_at:OLD,updated_at:OLD}))).execute();
    await db.insertInto('billing_invoices').values([
      {...invoice('direct-invoice',a.id),due_at:FUTURE,source_entity_type:'crm.job',source_entity_id:'direct'},
      {...invoice('converted-invoice',a.id),due_at:FUTURE},
      {...invoice('void-invoice',a.id,'void'),source_entity_type:'crm.job',source_entity_id:'void'},
      {...invoice('foreign-invoice',b.id),source_entity_type:'crm.job',source_entity_id:'foreign'},
    ]).execute();
    await db.insertInto('quoting_conversions').values({id:'conversion',tenant_id:a.id,job_id:'converted',invoice_id:'converted-invoice',created_at:OLD}).execute();
    const queue=await ownerExceptionQueue(db,a.id,{limit:25,offset:0},'completed_job_unlinked');
    expect(queue.items.map(item=>item.source.entityId)).toEqual(['foreign','void']);
    await db.schema.dropTable('quoting_conversions').execute();
    const unavailable=await ownerExceptionQueue(db,a.id);
    expect(unavailable.sources.find(source=>source.kind==='completed_job_unlinked')).toMatchObject({available:false,count:null});
    expect(unavailable.items.some(item=>item.kind==='completed_job_unlinked')).toBe(false);
  });

  it('resolves crew checklist gaps and workflow failures from source state, with no automatic mutations',async()=>{
    const {db,a,b}=await setup();
    await db.insertInto('portal_employee_assignments').values({id:'crew',tenant_id:a.id,title:'Completed work',status:'completed',scheduled_at:OLD,updated_at:OLD}).execute();
    await db.insertInto('portal_employee_checklists').values({id:'checklist',tenant_id:a.id,assignment_id:'crew'}).execute();
    await db.insertInto('portal_employee_checklist_items').values({id:'item',tenant_id:a.id,checklist_id:'checklist',checked:0,checked_at:null,created_at:OLD}).execute();
    await db.insertInto('workflows_executions').values({id:'run',tenant_id:a.id,workflow_id:'Recipe',status:'retrying',started_at:OLD,finished_at:null,next_retry_at:FUTURE}).execute();
    expect((await ownerExceptionQueue(db,a.id)).total).toBe(2);
    await db.updateTable('portal_employee_checklist_items').set({checked:1,checked_at:FUTURE}).where('tenant_id','=',a.id).where('id','=','item').execute();
    await db.updateTable('workflows_executions').set({status:'succeeded',finished_at:FUTURE}).where('tenant_id','=',a.id).where('id','=','run').execute();
    expect((await ownerExceptionQueue(db,a.id)).total).toBe(0);
    // A foreign unchecked item cannot turn A's completed assignment into an exception.
    await db.insertInto('portal_employee_checklist_items').values({id:'foreign',tenant_id:b.id,checklist_id:'checklist',checked:0,checked_at:null,created_at:OLD}).execute();
    expect((await ownerExceptionQueue(db,a.id)).total).toBe(0);
  });

  it('reports absent sources as unknown rather than a successful empty queue',async()=>{
    const {db,a}=await setup(false);
    const queue=await ownerExceptionQueue(db,a.id);
    expect(queue.completeness).toBe('partial');expect(queue.items).toEqual([]);
    expect(queue.sources).toHaveLength(6);expect(queue.sources.every(source=>!source.available&&source.count===null&&source.issue)).toBe(true);
  });

  it('surfaces actual crew exception/time records and respects resolved checklist waivers',async()=>{
    const {db,a,b}=await setup();
    await db.insertInto('portal_employee_assignments').values({id:'crew',tenant_id:a.id,title:'Completed work',status:'completed',scheduled_at:FUTURE,updated_at:OLD}).execute();
    await db.insertInto('portal_employee_checklists').values({id:'checklist',tenant_id:a.id,assignment_id:'crew'}).execute();
    await db.insertInto('portal_employee_checklist_items').values({id:'item',tenant_id:a.id,checklist_id:'checklist',checked:0,checked_at:null,created_at:OLD}).execute();
    await db.insertInto('portal_employee_exceptions').values({id:'waiver',tenant_id:a.id,assignment_id:'crew',checklist_item_id:'item',status:'resolved',resolution_kind:'waived'}).execute();
    expect((await ownerExceptionQueue(db,a.id)).total).toBe(0);
    await db.insertInto('portal_employee_exceptions').values({id:'open',tenant_id:a.id,assignment_id:'crew',checklist_item_id:null,status:'open',resolution_kind:null}).execute();
    expect((await ownerExceptionQueue(db,a.id)).total).toBe(1);
    await db.updateTable('portal_employee_exceptions').set({status:'resolved',resolution_kind:'resolved'}).where('tenant_id','=',a.id).where('id','=','open').execute();
    expect((await ownerExceptionQueue(db,a.id)).total).toBe(0);
    const time={id:'time',tenant_id:a.id,employee_id:'employee',assignment_id:'crew',clock_in_at:OLD,clock_out_at:OLD,review_status:'pending',created_at:OLD};
    await db.insertInto('portal_employee_time_entries').values(time).execute();
    expect((await ownerExceptionQueue(db,a.id)).total).toBe(1);
    await db.updateTable('portal_employee_time_entries').set({review_status:'approved'}).where('tenant_id','=',a.id).where('id','=','time').execute();
    await db.insertInto('portal_employee_exceptions').values({id:'foreign',tenant_id:b.id,assignment_id:'crew',checklist_item_id:null,status:'open',resolution_kind:null}).execute();
    expect((await ownerExceptionQueue(db,a.id)).total).toBe(0);
  });

  it('drops an overdue balance after a payment through the real billing router',async()=>{
    const db=createTestDb<BillingDatabase & DashboardDatabase>();databases.push(db as Kysely<unknown>);
    await runMigrations(db,[...coreMigrations,...dashboardMigrations,...billingMigrations]);
    const tenant=await createTenant(asCoreDb(db),{name:'Synthetic receipts'}),events=new EventBus();
    const billing=billingRouter({db:db as unknown as Kysely<BillingDatabase>,events,contracts:{}});
    const request=(path:string,body:unknown)=>billing.request(path,{method:'POST',headers:{'x-tenant-id':tenant.id,'content-type':'application/json'},body:JSON.stringify(body)});
    const created=await request('/invoices',{customerId:'synthetic-customer',dueAt:OLD,lines:[{description:'Synthetic approved work',quantity:1,unitPriceCents:10501}]});
    expect(created.status).toBe(201);const invoice=(await created.json() as {data:{id:string}}).data;
    expect((await request(`/invoices/${invoice.id}/send`,{})).status).toBe(200);
    expect((await ownerExceptionQueue(db,tenant.id)).items[0].balanceCents).toBe(10501);
    const paid=await request(`/invoices/${invoice.id}/payments`,{amountCents:10501,method:'manual',note:'Synthetic receipt only'});
    expect(paid.status).toBe(201);
    expect((await ownerExceptionQueue(db,tenant.id)).items).toEqual([]);
  });
});
