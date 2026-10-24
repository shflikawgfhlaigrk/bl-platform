import type { IndustryConfig } from '../config';

/** Domain-neutral setup. Amounts require owner configuration before quoting. */
export const serviceDeliveryConfig = {
  key:'service-delivery',label:'Service Delivery',
  description:'A configurable inquiry → approved scope → scheduled work → closeout workflow. Set your own services, rates, and resource rules.',
  terminology:{lead:'Inquiry',customer:'Customer',quote:'Quote',job:'Job',appointment:'Visit',invoice:'Invoice',team_member:'Team member'},
  leadStages:[{key:'new',label:'New inquiry'},{key:'contacted',label:'Contacted'},{key:'qualified',label:'Scope confirmed'},{key:'quoted',label:'Quote shared'},{key:'won',label:'Approved'},{key:'lost',label:'Closed without work'}],
  quoteTemplates:[{key:'service_scope',name:'Service scope — set your agreed rate',description:'Describe the agreed work, exclusions, and acceptance criteria. Set quantities and prices before enabling this template.',lines:[{description:'Agreed service — replace with your scope and rate',quantity:1,unitPriceCents:0}]}],
  appointmentTypes:[{key:'scope_review',label:'Scope review',durationMinutes:30},{key:'service_visit',label:'Service visit — adjust duration',durationMinutes:60}],
  dashboardWidgets:[{key:'work_attention',title:'Work needing attention',type:'list',config:{source:'exceptions'}}],
  workflows:[
    {key:'inquiry_next_action',name:'Own the next inquiry action',trigger:'crm.lead.created',actions:[{type:'create_task',params:{title:'Assign owner and next action for inquiry {{payload.leadId}}',dueInHours:24,relatedEntityType:'crm.lead',relatedEntityId:'{{payload.leadId}}'}}]},
    {key:'approved_scope_handoff',name:'Review approved scope handoff',trigger:'quoting.quote.approved',actions:[{type:'create_task',params:{title:'Review approved quote {{payload.quoteId}} and its job/invoice handoff',dueInHours:24,relatedEntityType:'quoting.quote',relatedEntityId:'{{payload.quoteId}}'}}]},
    {key:'completed_work_closeout',name:'Check completed work and billing',trigger:'crm.job.completed',actions:[{type:'create_task',params:{title:'Review job {{payload.jobId}} evidence, approved time, and linked invoice',dueInHours:24,relatedEntityType:'crm.job',relatedEntityId:'{{payload.jobId}}'}}]},
  ],
} satisfies IndustryConfig;
