import type { Kysely } from '@blacklabel/db';
import type { EventBus } from '@blacklabel/core';
import type { ClientOpsDatabase } from './schema';
import { ClientOpsService, type InstallationDetail } from './service';

/**
 * Demo-safe, idempotent seed: installs one onboarding-only Workflow Operating
 * System. It never activates workflows or invents connector credentials.
 */
export async function seedClientOps(
  db: Kysely<ClientOpsDatabase>,
  events: EventBus,
  tenantId: string,
): Promise<InstallationDetail> {
  const existing = await db.selectFrom('client_ops_installations').select('id')
    .where('tenant_id', '=', tenantId)
    .where('catalog_kind', '=', 'service')
    .where('catalog_id', '=', 'workflow-operating-system')
    .orderBy('created_at', 'asc').orderBy('id', 'asc')
    .executeTakeFirst();
  const service = new ClientOpsService(db, events);
  if (existing) return service.getInstallation(tenantId, existing.id);
  return service.createInstallation(tenantId, {
    name: 'Demo Workflow Operating System',
    catalogKind: 'service',
    catalogId: 'workflow-operating-system',
    engagementModelId: 'workflow-automation-sprint',
  }, 'system');
}
