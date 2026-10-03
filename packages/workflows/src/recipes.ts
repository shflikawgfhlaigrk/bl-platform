import type { Kysely } from 'kysely';
import { ApiError, type EventBus } from '@blacklabel/core';
import { createWorkflow, type TriggerEvent, type WorkflowActionInput } from './service';
import type { WorkflowsDatabase } from './schema';

const recipes = [
  { key: 'lead-first-touch', name: 'Respond to a new lead', description: 'Give one team member a dated first-response task and an in-app notification for every new lead.',
    triggerEvent: 'crm.lead.created', entityType: 'crm.lead', entityId: '{{payload.leadId}}', dueInHours: 24,
    title: 'Respond to lead {{payload.leadId}}', body: 'Review the request, contact the lead through an approved channel and record the next action.', tag: 'first-response-tracked' },
  { key: 'approved-quote-handoff', name: 'Prepare approved work', description: 'Assign a scheduling-readiness task for an approved quote, with one visible handoff receipt.',
    triggerEvent: 'quoting.quote.approved', entityType: 'quoting.quote', entityId: '{{payload.quoteId}}', dueInHours: 4,
    title: 'Prepare approved quote {{payload.quoteId}}', body: 'Check the linked job, confirm resources and the customer arrival window, then complete this handoff task.', tag: 'handoff-tracked' },
  { key: 'completed-job-closeout', name: 'Check completed job closeout', description: 'Assign a closeout check for every completed job: evidence, customer update and outstanding collection.',
    triggerEvent: 'crm.job.completed', entityType: 'crm.job', entityId: '{{payload.jobId}}', dueInHours: 24,
    title: 'Check closeout for job {{payload.jobId}}', body: 'Review job evidence, confirm the customer update and check the invoice balance. Review invitations remain neutral and are handled by the job completion flow.', tag: 'closeout-check-tracked' },
] as const;

export function listWorkflowRecipes() {
  return recipes.map(({ key, name, description, triggerEvent, dueInHours }) => ({ key, name, description, triggerEvent, dueInHours,
    maxAttempts: 3, actionTypes: ['create_task', 'notify_user', 'add_tag'], externalEffects: false }));
}

/** Presets use only transactional local actions and never send, charge or book. */
export async function installWorkflowRecipe(db: Kysely<WorkflowsDatabase>, events: EventBus, tenantId: string,
  key: string, input: { assigneeUserId: string; dueInHours?: number }, actor = 'system') {
  const recipe = recipes.find(item => item.key === key);
  if (!recipe) throw ApiError.notFound('Unknown workflow recipe.');
  const dueInHours = input.dueInHours ?? recipe.dueInHours;
  if (!Number.isInteger(dueInHours) || dueInHours < 1 || dueInHours > 168) throw ApiError.badRequest('Choose a due window from 1 to 168 hours.');
  const user = await db.selectFrom('users').select('id').where('tenant_id', '=', tenantId)
    .where('id', '=', input.assigneeUserId).executeTakeFirst();
  if (!user) throw ApiError.badRequest('Choose a team member from this company.');
  const actions: WorkflowActionInput[] = [
    { type: 'create_task', config: { title: recipe.title, description: recipe.body, assigneeUserId: user.id,
      dueInHours, relatedEntityType: recipe.entityType, relatedEntityId: recipe.entityId } },
    { type: 'notify_user', config: { userId: user.id, title: recipe.title, body: recipe.body } },
    { type: 'add_tag', config: { entityType: recipe.entityType, entityId: recipe.entityId, tag: recipe.tag } },
  ];
  return createWorkflow(db, events, tenantId, { recipeKey: `preset:${recipe.key}`, name: recipe.name,
    triggerEvent: recipe.triggerEvent as TriggerEvent, actions, maxAttempts: 3 }, actor);
}
