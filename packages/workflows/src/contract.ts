import type { Kysely } from 'kysely';
import type { CreateTaskContract, EventBus } from '@blacklabel/core';
import type { WorkflowsDatabase } from './schema';
import { createTask } from './service';

/**
 * The workflows module's implementation of core's CreateTaskContract.
 * apps/api wires this into other modules' deps.contracts so they can create
 * tasks without importing this package.
 */
export function workflowsCreateTaskContract(
  db: Kysely<WorkflowsDatabase>,
  events: EventBus,
): CreateTaskContract {
  return {
    async createTask(input) {
      const task = await createTask(db, events, input.tenantId, {
        title: input.title,
        description: input.description,
        assigneeUserId: input.assigneeUserId,
        dueAt: input.dueAt,
        relatedEntityType: input.relatedEntityType,
        relatedEntityId: input.relatedEntityId,
      });
      return { id: task.id };
    },
  };
}
