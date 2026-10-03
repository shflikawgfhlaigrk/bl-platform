import { afterEach, describe, expect, it } from 'vitest';
import { asCoreDb, coreMigrations, createTenant, EventBus } from '@blacklabel/core';
import { createTestDb, runMigrations, type Kysely } from '@blacklabel/db';
import { crmMigrations, crmRouter, setLeadStages, type CrmDatabase } from '@blacklabel/crm';
import { quotingMigrations, quotingRouter, type QuotingDatabase } from '@blacklabel/quoting';
import { workflowsMigrations, workflowsRouter, attachWorkflowEngine, updateWorkflow, type WorkflowsDatabase } from '@blacklabel/workflows';
import { schedulingMigrations, createSchedulingAppointmentTypeContract, type SchedulingDatabase } from '@blacklabel/scheduling';
import { industriesMigrations, industriesRouter, type IndustriesDatabase, type AppliedIndustry } from '@blacklabel/industries';
import { businessIndustryRuntime, type IndustryRuntimeDatabase } from '../src/business-industry-wiring';
import { createApp, type PlatformDatabase } from '../src/app';

type DB=IndustryRuntimeDatabase&SchedulingDatabase;
const databases:Kysely<unknown>[]=[];
afterEach(async()=>{for(const db of databases.splice(0))await db.destroy();});
async function setup(){
  const db=createTestDb<DB>();databases.push(db as Kysely<unknown>);
  await runMigrations(db,[...coreMigrations,...industriesMigrations,...crmMigrations,...quotingMigrations,...workflowsMigrations,...schedulingMigrations]);
  const a=await createTenant(asCoreDb(db),{name:'Synthetic service company'}),b=await createTenant(asCoreDb(db),{name:'Synthetic isolated company'}),events=new EventBus();
  const contracts={createAppointmentType:createSchedulingAppointmentTypeContract({db:db as unknown as Kysely<SchedulingDatabase>,events})};
  const industry=industriesRouter({db:db as unknown as Kysely<IndustriesDatabase>,events,contracts},{installRuntime:businessIndustryRuntime(db,events)});
  const crm=crmRouter({db:db as unknown as Kysely<CrmDatabase>,events,contracts:{}});
  const quoting=quotingRouter({db:db as unknown as Kysely<QuotingDatabase>,events,contracts:{}});
  const workflows=workflowsRouter({db:db as unknown as Kysely<WorkflowsDatabase>,events,contracts:{}});
  attachWorkflowEngine({db:db as unknown as Kysely<WorkflowsDatabase>,events,contracts:{}});
  const request=(app:typeof industry,path:string,tenantId=a.id,method='GET',body?:unknown)=>app.request(path,{method,headers:{'x-tenant-id':tenantId,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const apply=async(key='service-delivery',tenantId=a.id)=>{
    const response=await request(industry,`/${key}/apply`,tenantId,'POST',{});
    expect(response.status).toBe(200);return (await response.json() as {data:AppliedIndustry}).data;
  };
  return {db,a,b,events,industry,crm,quoting,workflows,request,apply};
}

describe('IndustryModules runtime provisioning',()=>{
  it('installs real neutral stages/templates/local recipes, read backs each receipt, and preserves the scheduling bridge',async()=>{
    const {db,a,b,industry,crm,quoting,workflows,request,apply}=await setup();
    const applied=await apply();
    expect(applied.runtime.available).toBe(true);expect(applied.runtime.items).toHaveLength(5);
    expect(applied.runtime.items.filter(item=>item.targetType==='workflows.workflow').every(item=>item.status==='installed')).toBe(true);
    const stages=(await (await request(crm,'/lead-stages')).json() as {data:{key:string;label:string}[]}).data;
    expect(stages.find(stage=>stage.key==='qualified')!.label).toBe('Scope confirmed');
    const templates=(await (await request(quoting,'/templates')).json() as {data:{id:string;active:number;line_items:{unitPriceCents:number}[]}[]}).data;
    expect(templates).toHaveLength(1);expect(templates[0].active).toBe(0);
    expect(applied.runtime.items.find(item=>item.targetType==='quoting.service_template')!.status).toBe('needs_configuration');
    const recipes=(await (await request(workflows,'/')).json() as {data:{recipeKey:string;actions:{type:string}[]}[]}).data;
    expect(recipes).toHaveLength(3);expect(recipes.every(recipe=>recipe.actions.every(action=>action.type==='create_task'))).toBe(true);
    expect(await db.selectFrom('scheduling_appointment_types').select('id').where('tenant_id','=',a.id).execute()).toHaveLength(2);
    expect((await request(industry,'/applied',b.id)).status).toBe(404);
    expect((await (await request(quoting,'/templates',b.id)).json() as {data:unknown[]}).data).toEqual([]);
    expect((await (await request(workflows,'/',b.id)).json() as {data:unknown[]}).data).toEqual([]);
    const read=(await (await request(industry,'/applied')).json() as {data:AppliedIndustry}).data;
    expect(read.runtime.items.map(item=>item.targetId)).toEqual(applied.runtime.items.map(item=>item.targetId));
  });

  it('runs source-linked next-action tasks from real module events without external messaging or payments',async()=>{
    const {db,a,crm,events,request,apply}=await setup();
    await apply();
    const leadResponse=await request(crm,'/leads',a.id,'POST',{name:'Synthetic inquiry'});
    expect(leadResponse.status).toBe(201);const lead=(await leadResponse.json() as {data:{id:string}}).data;
    await events.emit(a.id,'quoting.quote.approved',{quoteId:'synthetic-approved-scope'});
    await events.emit(a.id,'crm.job.completed',{jobId:'synthetic-completed-work'});
    const tasks=await db.selectFrom('workflows_tasks').select(['title','related_entity_type','related_entity_id','due_at']).where('tenant_id','=',a.id).orderBy('id').execute();
    expect(tasks).toHaveLength(3);expect(tasks.find(task=>task.related_entity_type==='crm.lead')!.related_entity_id).toBe(lead.id);
    expect(tasks.every(task=>!task.title.includes('{{')&&task.due_at!==null)).toBe(true);
    const executions=await db.selectFrom('workflows_executions').select('status').where('tenant_id','=',a.id).execute();
    expect(executions.every(run=>run.status==='succeeded')).toBe(true);
  });

  it('reapplying preserves owner stage/quote/workflow edits and stable target IDs',async()=>{
    const {db,a,crm,quoting,workflows,request,apply}=await setup();
    const first=await apply();
    const templateId=first.runtime.items.find(item=>item.targetType==='quoting.service_template')!.targetId!;
    const workflowId=first.runtime.items.find(item=>item.targetType==='workflows.workflow')!.targetId!;
    await setLeadStages(db as unknown as Kysely<CrmDatabase>,a.id,'owner',[{key:'new',label:'Owner intake'},{key:'won',label:'Booked'},{key:'lost',label:'Closed'}]);
    expect((await request(quoting,`/templates/${templateId}`,a.id,'PATCH',{name:'Owner service',lineItems:[{description:'Owner agreed scope',quantity:1,unitPriceCents:12345}],active:true})).status).toBe(200);
    expect((await request(workflows,`/${workflowId}/disable`,a.id,'POST',{})).status).toBe(200);
    const second=await apply();
    expect(second.runtime.items.map(item=>item.targetId)).toEqual(first.runtime.items.map(item=>item.targetId));
    expect(second.runtime.items.find(item=>item.key==='lead_stages')!.status).toBe('preserved');
    expect(second.runtime.items.find(item=>item.targetId===templateId)!.status).toBe('preserved');
    expect(second.runtime.items.find(item=>item.targetId===workflowId)!.status).toBe('preserved');
    expect((await (await request(crm,'/lead-stages')).json() as {data:{label:string}[]}).data[0].label).toBe('Owner intake');
    expect((await (await request(quoting,`/templates/${templateId}`)).json() as {data:{name:string}}).data.name).toBe('Owner service');
    expect((await (await request(workflows,`/${workflowId}`)).json() as {data:{enabled:boolean}}).data.enabled).toBe(false);
    await apply();
    expect(await db.selectFrom('quoting_service_templates').select('id').where('tenant_id','=',a.id).execute()).toHaveLength(1);
    expect(await db.selectFrom('workflows_workflows').select('id').where('tenant_id','=',a.id).execute()).toHaveLength(3);
  });

  it('keeps preexisting custom stages and unsupported external definitions intact but disabled',async()=>{
    const {db,a,apply}=await setup();
    await setLeadStages(db as unknown as Kysely<CrmDatabase>,a.id,'owner',[{key:'new',label:'Custom intake'},{key:'done',label:'Owner closed',is_closed:true}]);
    const applied=await apply('window-cleaning');
    expect(applied.runtime.items.find(item=>item.key==='lead_stages')!.status).toBe('preserved');
    expect(applied.runtime.items.find(item=>item.key==='workflow:review_request')!.status).toBe('unsupported');
    expect(await db.selectFrom('workflows_workflows').select('id').where('tenant_id','=',a.id).execute()).toHaveLength(1);
    expect((await db.selectFrom('industries_workflow_definitions').select('enabled').where('tenant_id','=',a.id).where('key','=','review_request').executeTakeFirstOrThrow()).enabled).toBe(0);
  });

  it('does not recreate owner-deleted targets on reapply and denies foreign target readback',async()=>{
    const {a,b,quoting,workflows,request,apply}=await setup();
    const first=await apply();const template=first.runtime.items.find(item=>item.targetType==='quoting.service_template')!,workflow=first.runtime.items.find(item=>item.targetType==='workflows.workflow')!;
    expect((await request(quoting,`/templates/${template.targetId}`,b.id)).status).toBe(404);
    expect((await request(workflows,`/${workflow.targetId}`,b.id)).status).toBe(404);
    expect((await request(quoting,`/templates/${template.targetId}`,a.id,'DELETE')).status).toBe(200);
    expect((await request(workflows,`/${workflow.targetId}`,a.id,'DELETE')).status).toBe(200);
    const reapplied=await apply();
    expect(reapplied.runtime.items.find(item=>item.key===template.key)!.status).toBe('missing');
    expect(reapplied.runtime.items.find(item=>item.key===workflow.key)!.status).toBe('missing');
    const again=await apply();expect(again.runtime.items.find(item=>item.key===template.key)!.status).toBe('missing');
    expect((await (await request(quoting,'/templates')).json() as {data:unknown[]}).data).toEqual([]);
    expect((await (await request(workflows,'/')).json() as {data:unknown[]}).data).toHaveLength(2);
  });

  it('switching setups pauses untouched earlier recipes without deleting them or duplicating active event handlers',async()=>{
    const {db,a,apply}=await setup();
    const first=await apply();const earlier=first.runtime.items.filter(item=>item.targetType==='workflows.workflow').map(item=>item.targetId!);
    const switched=await apply('window-cleaning');
    expect(switched.runtime.items.some(item=>item.key.startsWith('retired:'))).toBe(true);
    const prior=await db.selectFrom('workflows_workflows').select(['id','enabled']).where('tenant_id','=',a.id).where('id','in',earlier).execute();
    expect(prior).toHaveLength(3);expect(prior.every(row=>row.enabled===0)).toBe(true);
    expect(await db.selectFrom('workflows_workflows').select('id').where('tenant_id','=',a.id).where('enabled','=',1).execute()).toHaveLength(1);
  });

  it('preserves an edited owner recipe through repeated switches rather than treating retained observations as default ownership',async()=>{
    const {db,a,events,apply}=await setup();
    const first=await apply(),ownerRecipe=first.runtime.items.find(item=>item.key==='workflow:inquiry_next_action')!.targetId!;
    await updateWorkflow(db as unknown as Kysely<WorkflowsDatabase>,events,a.id,ownerRecipe,{name:'Owner custom intake'},'owner');
    await apply('window-cleaning');await apply('window-cleaning');await apply('hvac');
    const recipe=await db.selectFrom('workflows_workflows').select(['id','name','enabled']).where('tenant_id','=',a.id).where('id','=',ownerRecipe).executeTakeFirstOrThrow();
    expect(recipe).toMatchObject({id:ownerRecipe,name:'Owner custom intake',enabled:1});
    const active=await db.selectFrom('workflows_workflows').select('id').where('tenant_id','=',a.id).where('trigger_event','=','crm.lead.created').where('enabled','=',1).execute();
    expect(active.map(row=>row.id)).toEqual([ownerRecipe]);
  });

  it('boots the installed business composition and exposes real runtime targets through protected routes',async()=>{
    const db=createTestDb<PlatformDatabase>();databases.push(db as Kysely<unknown>);
    const platform=await createApp({db,businessPortals:true,disableRateLimit:true,includeCheckoutSimulator:false});
    try{
      const tenant=(await createTenant(asCoreDb(db),{name:'Synthetic composition buyer'})).id;
      const {ownerUserId}=await platform.seedTenant(tenant);
      const request=(route:string,method='GET',body?:unknown)=>platform.app.request('/api/'+route,{method,headers:{'x-tenant-id':tenant,'x-user-id':ownerUserId,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
      const applied=await request('industries/service-delivery/apply','POST',{});
      expect(applied.status,await applied.clone().text()).toBe(200);
      const data=(await applied.json() as {data:AppliedIndustry}).data;
      expect(data.runtime.items.filter(item=>item.targetType==='workflows.workflow')).toHaveLength(3);
      expect((await (await request('quoting/templates')).json() as {data:unknown[]}).data).toHaveLength(1);
      expect((await (await request('workflows')).json() as {data:unknown[]}).data).toHaveLength(3);
      const lead=await request('crm/leads','POST',{name:'Synthetic first inquiry'});expect(lead.status).toBe(201);
      const tasks=(await (await request('workflows/tasks')).json() as {data:{title:string;relatedEntityId:string}[]}).data;
      expect(tasks).toHaveLength(1);expect(tasks[0].title).toContain('Assign owner and next action');
      expect((await request('dashboard/exceptions')).status).toBe(200);
    }finally{platform.detachEngine();}
  });
});
