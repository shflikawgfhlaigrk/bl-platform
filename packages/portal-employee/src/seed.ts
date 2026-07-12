/**
 * Demo data for the portal-employee module. Industry-neutral on purpose:
 * one field-service style worker and one media/marketing style worker —
 * assignment `kind` is free-form per tenant, never an enum.
 */
import { DateTime } from 'luxon';
import { EventBus, type ModuleDeps } from '@blacklabel/core';
import type { PortalEmployeeDatabase } from './schema';
import {
  createAssignment,
  createChecklistTemplate,
  createEmployee,
  createShift,
  instantiateChecklist,
  issueEmployeeToken,
} from './service';

export interface PortalEmployeeSeedResult {
  managerId: string;
  managerToken: string;
  fieldWorkerId: string;
  fieldWorkerToken: string;
  mediaWorkerId: string;
  mediaWorkerToken: string;
  assignmentIds: string[];
  shiftIds: string[];
  checklistTemplateId: string;
}

export async function seedPortalEmployee(
  db: ModuleDeps<PortalEmployeeDatabase>['db'],
  tenantId: string,
  events: EventBus = new EventBus(),
): Promise<PortalEmployeeSeedResult> {
  const actor = 'system';

  const manager = await createEmployee(db, events, tenantId, actor, {
    name: 'Morgan Lee',
    email: 'morgan@example.com',
    role: 'manager',
    title: 'operations manager',
  });
  const fieldWorker = await createEmployee(db, events, tenantId, actor, {
    name: 'Riley Ortiz',
    email: 'riley@example.com',
    role: 'worker',
    title: 'technician',
  });
  const mediaWorker = await createEmployee(db, events, tenantId, actor, {
    name: 'Casey Nguyen',
    email: 'casey@example.com',
    role: 'worker',
    title: 'content producer',
  });

  const managerToken = await issueEmployeeToken(db, tenantId, actor, manager.id);
  const fieldWorkerToken = await issueEmployeeToken(db, tenantId, actor, fieldWorker.id);
  const mediaWorkerToken = await issueEmployeeToken(db, tenantId, actor, mediaWorker.id);

  const today = DateTime.utc().startOf('day');
  const shiftA = await createShift(db, tenantId, actor, {
    employeeId: fieldWorker.id,
    startsAt: today.plus({ hours: 8 }).toISO() as string,
    endsAt: today.plus({ hours: 16 }).toISO() as string,
    notes: 'morning route',
  });
  const shiftB = await createShift(db, tenantId, actor, {
    employeeId: mediaWorker.id,
    startsAt: today.plus({ hours: 10 }).toISO() as string,
    endsAt: today.plus({ hours: 18 }).toISO() as string,
  });

  const jobAssignment = await createAssignment(db, events, tenantId, actor, {
    employeeId: fieldWorker.id,
    kind: 'service_visit',
    title: 'On-site service visit',
    description: 'Complete the checklist and photograph the finished work.',
    scheduledAt: today.plus({ hours: 9 }).toISO() as string,
  });
  const shootAssignment = await createAssignment(db, events, tenantId, actor, {
    employeeId: mediaWorker.id,
    kind: 'content_shoot',
    title: 'Customer story video shoot',
    description: 'Capture b-roll and a testimonial interview.',
    scheduledAt: today.plus({ hours: 11 }).toISO() as string,
  });

  const template = await createChecklistTemplate(db, tenantId, actor, {
    name: 'Job completion',
    items: ['Confirm scope with customer', 'Do the work', 'Take after photos', 'Get sign-off'],
  });
  await instantiateChecklist(db, tenantId, actor, jobAssignment.id, { templateId: template.id });

  return {
    managerId: manager.id,
    managerToken: managerToken.token,
    fieldWorkerId: fieldWorker.id,
    fieldWorkerToken: fieldWorkerToken.token,
    mediaWorkerId: mediaWorker.id,
    mediaWorkerToken: mediaWorkerToken.token,
    assignmentIds: [jobAssignment.id, shootAssignment.id],
    shiftIds: [shiftA.id, shiftB.id],
    checklistTemplateId: template.id,
  };
}
