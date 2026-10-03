import { ApiError, type EventBus } from '@blacklabel/core';
import type { Kysely } from '@blacklabel/db';
import { DEFAULT_LEAD_STAGES, listLeadStages, setLeadStages, type CrmDatabase } from '@blacklabel/crm';
import { createServiceTemplate, getServiceTemplate, type QuotingDatabase } from '@blacklabel/quoting';
import { createWorkflow, getWorkflow, setWorkflowEnabled, TRIGGER_EVENTS, type WorkflowsDatabase, type TriggerEvent } from '@blacklabel/workflows';
import {
  getIndustryRuntimeReceipt, saveIndustryRuntimeReceipt, industryRuntimeReport,
  type IndustryRuntimeInstaller, type IndustryRuntimeReceipt, type IndustriesDatabase,
} from '@blacklabel/industries';

export type IndustryRuntimeDatabase = IndustriesDatabase & CrmDatabase & QuotingDatabase & WorkflowsDatabase;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const notFound=(error:unknown)=>error instanceof ApiError&&error.status===404;
const receipt=(key:string,targetType:string,href:string):Omit<IndustryRuntimeReceipt,'checkedAt'>=>({key,targetType,href,targetId:null,status:'installing',detail:'Provisioning requested.',snapshot:null});

/** Explicit apply configures real modules. Nothing is sent, charged, or handed off here. */
export function businessIndustryRuntime<DB extends IndustryRuntimeDatabase>(db:Kysely<DB>,events:EventBus):IndustryRuntimeInstaller {
  const industry=db as unknown as Kysely<IndustriesDatabase>,crm=db as unknown as Kysely<CrmDatabase>,workflows=db as unknown as Kysely<WorkflowsDatabase>;
  const active=new Set<string>();
  return async({tenantId,actor,config,previousIndustryKey})=>{
    if(active.has(tenantId))throw ApiError.conflict('Industry configuration is already being applied for this company.');
    active.add(tenantId);
    const save=(entry:Omit<IndustryRuntimeReceipt,'checkedAt'>)=>saveIndustryRuntimeReceipt(industry,tenantId,config.key,actor,entry);
    const workflowSnapshot=(workflow:Awaited<ReturnType<typeof getWorkflow>>)=>({name:workflow.name,triggerEvent:workflow.triggerEvent,enabled:workflow.enabled,maxAttempts:workflow.maxAttempts,actions:workflow.actions.map(action=>({type:action.type,config:action.config}))});
    const retainedRecipes=new Map<string,Awaited<ReturnType<typeof getWorkflow>>>();
    try{
      if(previousIndustryKey&&previousIndustryKey!==config.key){
        const previous=await industryRuntimeReport(industry,tenantId,previousIndustryKey);
        for(const prior of previous.items.filter(item=>item.targetType==='workflows.workflow'&&item.targetId)){
          try{
            const current=await getWorkflow(workflows,tenantId,prior.targetId!);
            if(!current.enabled)continue;
            // A retained owner's target remains owner-owned on subsequent switches,
            // even when its last observed snapshot happens to match current state.
            if(prior.status==='installed'&&same(prior.snapshot,workflowSnapshot(current))){
              await setWorkflowEnabled(workflows,events,tenantId,current.id,false,actor);
              await save({...receipt(`retired:${previousIndustryKey}:${prior.key}`,'workflows.retired_recipe','#/workflows'),targetId:current.id,status:'preserved',detail:'Untouched recipe from the previous setup was paused to prevent duplicate follow-up work.',snapshot:workflowSnapshot(current)});
            }else{
              retainedRecipes.set(current.triggerEvent,current);
              await save({...receipt(`retained:${previousIndustryKey}:${prior.key}`,'workflows.retained_recipe','#/workflows'),targetId:current.id,status:'preserved',detail:'An edited owner recipe from the previous setup was preserved. A second recipe for the same event will not be installed.',snapshot:workflowSnapshot(current)});
            }
          }catch(error){if(!notFound(error))throw error;}
        }
      }
      const stageEntry=receipt('lead_stages','crm.lead_stages','#/crm/leads');
      try{
        const current=await listLeadStages(crm,tenantId),existing=await getIndustryRuntimeReceipt(industry,tenantId,config.key,stageEntry.key);
        const baseline=DEFAULT_LEAD_STAGES.map((key,index)=>({key,label:key,sort_order:index,is_closed:key==='won'||key==='lost'}));
        if(existing&&existing.status!=='failed'){
          const untouched=same(existing.snapshot,current);
          const preserved=existing.status==='preserved'||!untouched;
          await save({...stageEntry,status:preserved?'preserved':'installed',detail:preserved?'Current owner CRM configuration was preserved. Review its stages in CRM.':'Configured CRM stages verified.',snapshot:existing.snapshot});
        }else if(!same(current,baseline)){
          await save({...stageEntry,status:'preserved',detail:'An existing CRM stage configuration was found. It was preserved; review stages in CRM.',snapshot:current});
        }else{
          const desired=config.leadStages.map((stage,index)=>({...stage,sort_order:index,is_closed:stage.key==='won'||stage.key==='lost'}));
          // Save intent first. After interruption, matching readback recovers without overwriting edits.
          await save({...stageEntry,snapshot:desired});
          await setLeadStages(crm,tenantId,actor,config.leadStages);
          const actual=await listLeadStages(crm,tenantId);
          if(!same(actual,desired))throw ApiError.conflict('CRM stage readback differs from the requested setup.');
          await save({...stageEntry,status:'installed',detail:'Lead stages installed and verified in CRM.',snapshot:actual});
        }
      }catch(error){await save({...stageEntry,status:'failed',detail:error instanceof ApiError&&error.status===409?'CRM stages could not be replaced because an existing lead uses a removed stage. Current records were preserved.':'CRM stage setup could not be verified. Review the local module before retrying.',snapshot:null});}

      for(const template of config.quoteTemplates){
        const entry=receipt(`quote:${template.key}`,'quoting.service_template','#/quoting/templates');
        const saved=await getIndustryRuntimeReceipt(industry,tenantId,config.key,entry.key);
        const quoteSnapshot=(row:Awaited<ReturnType<typeof getServiceTemplate>>)=>({name:row.name,description:row.description,lineItems:JSON.parse(row.line_items),active:row.active===1});
        try{
          if(saved?.targetId){
            const row=await getServiceTemplate({db:db as unknown as Kysely<QuotingDatabase>,events,contracts:{},tenantId,actor},saved.targetId);
            const current=quoteSnapshot(row),unpriced=current.lineItems.some((line:{unitPriceCents:number})=>line.unitPriceCents===0);
            const incomplete=unpriced||((saved.snapshot as {active?:boolean}|null)?.active===false&&!current.active);
            await save({...entry,targetId:row.id,status:incomplete?'needs_configuration':same(saved.snapshot,current)?'installed':'preserved',
              detail:incomplete?'Set agreed quantities/rates and enable the quote template before use.':'Existing quote template verified. Owner edits and activation state were preserved.',snapshot:saved.snapshot});
          }else if(saved?.status==='missing'){
            await save({...entry,status:'missing',detail:'The earlier template was removed. Setup will not recreate an owner-deleted template.',snapshot:saved.snapshot});
          }else{
            await db.transaction().execute(async tx=>{
              const unpriced=template.lines.some(line=>line.unitPriceCents===0);
              const ctx={db:tx as unknown as Kysely<QuotingDatabase>,events,contracts:{},tenantId,actor};
              const created=await createServiceTemplate(ctx,{name:template.name,description:template.description,lineItems:template.lines,active:!unpriced});
              const verified=await getServiceTemplate(ctx,created.id);
              await saveIndustryRuntimeReceipt(tx as unknown as Kysely<IndustriesDatabase>,tenantId,config.key,actor,{...entry,targetId:created.id,
                status:unpriced?'needs_configuration':'installed',detail:unpriced?'Template saved inactive. Set your own agreed rate and enable it before quoting.':'Quote template installed and read back from Quoting.',snapshot:quoteSnapshot(verified)});
            });
          }
        }catch(error){await save({...entry,targetId:saved?.targetId??null,status:notFound(error)?'missing':'failed',detail:notFound(error)?'The recorded quote template no longer exists. Owner deletion was preserved.':'Quote template setup could not be verified. No replacement template was created.',snapshot:saved?.snapshot??null});}
      }

      for(const definition of config.workflows){
        const entry=receipt(`workflow:${definition.key}`,'workflows.workflow','#/workflows');
        const saved=await getIndustryRuntimeReceipt(industry,tenantId,config.key,entry.key);
        const safe=TRIGGER_EVENTS.includes(definition.trigger as TriggerEvent)&&definition.actions.every(action=>action.type==='create_task'&&typeof action.params?.title==='string'&&action.params.title.trim().length>0&&
          (action.params.dueInHours===undefined||typeof action.params.dueInHours==='number'&&Number.isFinite(action.params.dueInHours)&&action.params.dueInHours>0));
        if(!safe){await save({...entry,status:'unsupported',detail:'This definition needs unsupported or external actions. It remains disabled; no messages or webhooks are installed.',snapshot:null});continue;}
        const snapshot=workflowSnapshot;
        try{
          if(saved?.targetId){
            const workflow=await getWorkflow(workflows,tenantId,saved.targetId),current=snapshot(workflow);
            await save({...entry,targetId:workflow.id,status:saved.status==='preserved'||!same(saved.snapshot,current)?'preserved':'installed',detail:'Installed workflow read back. Owner edits and pauses were preserved.',snapshot:saved.snapshot});
          }else if(saved?.status==='missing'){
            await save({...entry,status:'missing',detail:'An owner-deleted workflow was preserved. Install a new recipe from Workflows if needed.',snapshot:saved.snapshot});
          }else if(retainedRecipes.has(definition.trigger)){
            const retained=retainedRecipes.get(definition.trigger)!;
            await save({...entry,targetId:retained.id,status:'preserved',detail:'Existing owner recipe for this event was retained instead of installing duplicate follow-up work.',snapshot:snapshot(retained)});
          }else{
            const workflow=await createWorkflow(workflows,events,tenantId,{name:definition.name,triggerEvent:definition.trigger as TriggerEvent,maxAttempts:3,recipeKey:`industry:${config.key}:${definition.key}`,
              actions:definition.actions.map(action=>({type:'create_task',config:action.params??{}}))},actor);
            const verified=await getWorkflow(workflows,tenantId,workflow.id);
            await save({...entry,targetId:verified.id,status:'installed',detail:'Bounded local task recipe installed and verified in Workflows.',snapshot:snapshot(verified)});
          }
        }catch(error){await save({...entry,targetId:saved?.targetId??null,status:notFound(error)?'missing':'failed',detail:notFound(error)?'The recorded workflow no longer exists. Owner deletion was preserved.':'Local task recipe setup could not be verified. Inspect the Workflows module and retry explicitly.',snapshot:saved?.snapshot??null});}
      }
    }finally{active.delete(tenantId);}
  };
}
